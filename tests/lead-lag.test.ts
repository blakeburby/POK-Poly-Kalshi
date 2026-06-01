import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type AppConfig } from "../src/config";
import { RollingBookHistory, scoreLeadLag, type BookHistorySample } from "../src/signals/lead-lag";
import { buildGuaranteedCandidate } from "../src/scanner/payoff";
import type { ArbCandidate, QuoteSnapshot, Venue } from "../src/types";
import { contract } from "./helpers";

const now = 1_800_000_000_000;

function config(input: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      LIVE_ORDER_SIZE: "5",
      LIVE_LEAD_LAG_GATE_ENABLED: "false",
      LIVE_EXECUTION_QUALITY_GATE_ENABLED: "false",
    }),
    ...input,
  };
}

function candidate(): ArbCandidate {
  const poly = contract({
    venue: "polymarket",
    contractId: "poly",
    expiryMs: now + 900_000,
    strike: 1500,
    yesAsk: 0.43,
    yesBid: 0.42,
    updatedAt: now,
  });
  const kalshi = contract({
    venue: "kalshi",
    contractId: "kalshi",
    expiryMs: now + 900_000,
    strike: 1502,
    noAsk: 0.52,
    noBid: 0.51,
    updatedAt: now,
  });
  const built = buildGuaranteedCandidate(poly, kalshi, 0.01);
  assert.ok(built);
  return built;
}

function quote(input: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    capturedAt: now,
    quoteSkewMs: 10,
    kalshi: {
      venue: "kalshi",
      contractId: "kalshi",
      direction: "no",
      topAsk: 0.52,
      worstAsk: 0.52,
      vwap: 0.52,
      maxBuyPrice: 0.52,
      depth: 20,
      depthRequired: 5,
      levelsConsumed: [{ price: 0.52, size: 5 }],
      spread: 0.01,
      quoteAgeMs: 50,
      updatedAt: now - 50,
    },
    polymarket: {
      venue: "polymarket",
      contractId: "poly",
      direction: "yes",
      topAsk: 0.43,
      worstAsk: 0.43,
      vwap: 0.43,
      maxBuyPrice: 0.43,
      depth: 20,
      depthRequired: 5,
      levelsConsumed: [{ price: 0.43, size: 5 }],
      spread: 0.01,
      quoteAgeMs: 50,
      updatedAt: now - 50,
    },
    projectedPremium: 0.95,
    projectedEdge: 0.05,
    projectedPremiumAtLimit: 0.95,
    projectedEdgeAtLimit: 0.05,
    projectedEdgeAfterFees: 0.05,
    kalshiMaxBuyPrice: 0.52,
    polymarketMaxBuyPrice: 0.43,
    minProfitDollars: 0.01,
    failureReason: null,
    ...input,
  };
}

function sample(venue: Venue, contractId: string, timestamp: number, microprice: number): BookHistorySample {
  return {
    venue,
    contractId,
    direction: venue === "kalshi" ? "no" : "yes",
    timestamp,
    bid: microprice - 0.005,
    ask: microprice + 0.005,
    spread: 0.01,
    bidSize: 20,
    askSize: 20,
    depth: 20,
    microprice,
    liquidity: 400,
    ofi: 2,
  };
}

test("lead/lag scoring identifies Polymarket leading stronger book movement", () => {
  const snapshot = scoreLeadLag({
    candidate: candidate(),
    quoteSnapshot: quote(),
    history: {
      polymarket: [
        sample("polymarket", "poly", now - 5_000, 0.43),
        sample("polymarket", "poly", now - 4_000, 0.455),
        sample("polymarket", "poly", now - 2_000, 0.455),
        sample("polymarket", "poly", now, 0.455),
      ],
      kalshi: [
        sample("kalshi", "kalshi", now - 5_000, 0.52),
        sample("kalshi", "kalshi", now - 4_000, 0.52),
        sample("kalshi", "kalshi", now - 2_000, 0.542),
        sample("kalshi", "kalshi", now, 0.542),
      ],
    },
    config: config(),
    nowMs: now,
  });

  assert.equal(snapshot.leaderVenue, "polymarket");
  assert.equal(snapshot.laggingVenue, "kalshi");
  assert.ok(snapshot.confidence >= 0.6);
  assert.ok(snapshot.adverseSelectionScore > 0.5);
  assert.match(snapshot.reasons.join(" "), /Polymarket appears to lead/);
});

test("lead/lag scoring treats Polymarket as lagging stale liquidity when Kalshi moves first", () => {
  const snapshot = scoreLeadLag({
    candidate: candidate(),
    quoteSnapshot: quote(),
    history: {
      kalshi: [
        sample("kalshi", "kalshi", now - 5_000, 0.52),
        sample("kalshi", "kalshi", now - 4_000, 0.545),
        sample("kalshi", "kalshi", now - 2_000, 0.545),
        sample("kalshi", "kalshi", now, 0.545),
      ],
      polymarket: [
        sample("polymarket", "poly", now - 5_000, 0.43),
        sample("polymarket", "poly", now - 4_000, 0.43),
        sample("polymarket", "poly", now - 2_000, 0.452),
        sample("polymarket", "poly", now, 0.452),
      ],
    },
    config: config(),
    nowMs: now,
  });

  assert.equal(snapshot.leaderVenue, "kalshi");
  assert.equal(snapshot.laggingVenue, "polymarket");
  assert.equal(snapshot.cheapLegVenue, "polymarket");
  assert.equal(snapshot.cheapLegIsLagging, true);
  assert.ok(snapshot.stalenessScore > 0.5);
  assert.equal(snapshot.gatePassed, true);
});

test("lead/lag scoring does not block low-sample noisy books", () => {
  const snapshot = scoreLeadLag({
    candidate: candidate(),
    quoteSnapshot: quote(),
    history: {
      kalshi: [sample("kalshi", "kalshi", now, 0.52)],
      polymarket: [sample("polymarket", "poly", now, 0.43)],
    },
    config: config({ liveLeadLagGateEnabled: true }),
    nowMs: now,
  });

  assert.equal(snapshot.leaderVenue, "none");
  assert.ok(snapshot.confidence < 0.65);
  assert.equal(snapshot.gatePassed, true);
  assert.match(snapshot.reasons.join(" "), /Book history is thin/);
});

test("lead/lag gate blocks high-confidence adverse Polymarket-leading buckets", () => {
  const snapshot = scoreLeadLag({
    candidate: candidate(),
    quoteSnapshot: quote(),
    history: {
      polymarket: [
        sample("polymarket", "poly", now - 5_000, 0.43),
        sample("polymarket", "poly", now - 4_000, 0.46),
        sample("polymarket", "poly", now - 2_000, 0.46),
        sample("polymarket", "poly", now, 0.46),
      ],
      kalshi: [
        sample("kalshi", "kalshi", now - 5_000, 0.52),
        sample("kalshi", "kalshi", now - 4_000, 0.52),
        sample("kalshi", "kalshi", now - 2_000, 0.548),
        sample("kalshi", "kalshi", now, 0.548),
      ],
    },
    config: config({
      liveLeadLagGateEnabled: true,
      liveLeadLagMaxAdverseSelectionScore: 0.5,
    }),
    nowMs: now,
  });

  assert.equal(snapshot.leaderVenue, "polymarket");
  assert.equal(snapshot.gatePassed, false);
  assert.match(snapshot.blockReason ?? "", /lead-lag adverse selection score/);
});

test("rolling book history trims samples without persistence writes", () => {
  const history = new RollingBookHistory(5, 1_000);
  const old = contract({ venue: "kalshi", contractId: "kalshi", strike: 1500, noAsk: 0.52, noBid: 0.51, updatedAt: now - 2_000 });
  const recent = contract({ venue: "kalshi", contractId: "kalshi", strike: 1500, noAsk: 0.53, noBid: 0.52, updatedAt: now - 500 });
  const latest = contract({ venue: "kalshi", contractId: "kalshi", strike: 1500, noAsk: 0.54, noBid: 0.53, updatedAt: now });

  history.record(old, "no", old.updatedAt);
  history.record(recent, "no", recent.updatedAt);
  history.record(latest, "no", latest.updatedAt);

  const samples = history.get("kalshi", "kalshi", "no", now, 5_000);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].timestamp, now - 500);
  assert.equal(samples[1].timestamp, now);
});
