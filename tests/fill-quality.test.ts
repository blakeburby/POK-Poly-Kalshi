import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type AppConfig } from "../src/config";
import { scoreFillQuality } from "../src/execution/fill-quality";
import { buildGuaranteedCandidate } from "../src/scanner/payoff";
import type { ArbCandidate, DashboardSignal, QuoteSnapshot } from "../src/types";
import { contract } from "./helpers";

const now = 1_800_000_000_000;

function config(input: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      LIVE_ORDER_SIZE: "5",
      LIVE_MIN_BOOK_DEPTH_SHARES: "5",
      LIVE_FILL_QUALITY_GATE_ENABLED: "false",
      LIVE_FILL_QUALITY_MIN_SAMPLES: "30",
      LIVE_FILL_QUALITY_SAMPLE_LIMIT: "200",
      LIVE_FILL_QUALITY_MIN_EXPECTED_EDGE: "0.01",
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
    yesAskLevels: [{ price: 0.43, size: 20 }],
    updatedAt: now,
  });
  const kalshi = contract({
    venue: "kalshi",
    contractId: "kalshi",
    expiryMs: now + 900_000,
    strike: 1502,
    noAsk: 0.52,
    noAskLevels: [{ price: 0.52, size: 20 }],
    updatedAt: now,
  });
  const built = buildGuaranteedCandidate(poly, kalshi, 0.01);
  assert.ok(built);
  return built;
}

function quote(edge = 0.02, input: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    capturedAt: now,
    quoteSkewMs: 20,
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
      spread: 0.02,
      quoteAgeMs: 50,
      updatedAt: now - 50,
    },
    polymarket: {
      venue: "polymarket",
      contractId: "poly",
      direction: "yes",
      topAsk: 0.46,
      worstAsk: 0.46,
      vwap: 0.46,
      maxBuyPrice: 0.46,
      depth: 20,
      depthRequired: 5,
      levelsConsumed: [{ price: 0.46, size: 5 }],
      spread: 0.02,
      quoteAgeMs: 50,
      updatedAt: now - 50,
    },
    projectedPremium: 1 - edge,
    projectedEdge: edge,
    projectedPremiumAtLimit: 1 - edge,
    projectedEdgeAtLimit: edge,
    projectedEdgeAfterFees: edge,
    takerPriceCushionCents: 2,
    kalshiMaxBuyPrice: 0.52,
    polymarketMaxBuyPrice: 0.46,
    minProfitDollars: 0.01,
    failureReason: null,
    ...input,
  };
}

function signal(input: Partial<DashboardSignal> = {}): DashboardSignal {
  return {
    id: input.id ?? 1,
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 10_000).toISOString(),
    pairKey: "pair",
    expiryMs: now + 900_000,
    kalshiContractId: "kalshi",
    polymarketContractId: "poly",
    lower: { venue: "polymarket", contractId: "poly", direction: "yes", strike: 1500, ask: 0.46 },
    higher: { venue: "kalshi", contractId: "kalshi", direction: "no", strike: 1502, ask: 0.52 },
    premium: 0.98,
    guaranteedProfit: 0.02,
    overlapProfit: 1.02,
    threshold: 0.01,
    action: "filled",
    failureReason: null,
    kalshiFillId: "kalshi",
    polymarketFillId: "poly",
    kalshiFillPrice: 0.52,
    polymarketFillPrice: 0.46,
    executionGroupId: "group",
    kalshiStatus: "filled",
    polymarketStatus: "filled",
    kalshiFillCount: 5,
    polymarketFillCount: 5,
    partialFill: false,
    executionTimings: { kalshiOrderRttMs: 100, polymarketOrderRttMs: 150, polymarketConfirmationMs: 180 },
    ...input,
  };
}

function exactSamples(count = 40): DashboardSignal[] {
  return Array.from({ length: count }, (_, index) => signal({ id: index + 1, executionGroupId: `exact-${index}` }));
}

function poorPolymarketSamples(count = 40): DashboardSignal[] {
  return Array.from({ length: count }, (_, index) => signal({
    id: index + 1,
    action: "failed",
    failureReason: "risk quarantined: Polymarket mismatch",
    kalshiStatus: "filled",
    polymarketStatus: index % 2 === 0 ? "unknown" : "unexpected_fill_count",
    kalshiFillCount: 5,
    polymarketFillCount: index % 3 === 0 ? 0 : 5.3,
    partialFill: true,
    polymarketError: index % 2 === 0 ? "order response timeout after 2500ms" : null,
    executionTimings: { kalshiOrderRttMs: 100, polymarketOrderRttMs: index % 2 === 0 ? 2500 : 1800 },
    riskQuarantineExposureDollars: 2.6,
  }));
}

test("fill quality passes a strong candidate with deep fresh books and exact-fill history", () => {
  const snapshot = scoreFillQuality({
    candidate: candidate(),
    quoteSnapshot: quote(0.02),
    recentSignals: exactSamples(),
    config: config({ liveFillQualityGateEnabled: true, liveMaxTradesPerWindow: 100 }),
    nowMs: now,
    placementMode: "polymarket_first_exact",
  });

  assert.equal(snapshot.gatePassed, true);
  assert.equal(snapshot.blockReason, null);
  assert.ok((snapshot.expectedExecutableEdge ?? 0) >= 0.01);
  assert.ok(snapshot.pairedFillProbability > 0.9);
});

test("fill quality fails a raw one-cent edge when recent paired-fill quality is poor", () => {
  const snapshot = scoreFillQuality({
    candidate: candidate(),
    quoteSnapshot: quote(0.01),
    recentSignals: poorPolymarketSamples(),
    config: config({ liveFillQualityGateEnabled: true }),
    nowMs: now,
    placementMode: "polymarket_first_exact",
  });

  assert.equal(snapshot.gatePassed, false);
  assert.match(snapshot.blockReason ?? "", /fill-quality expected executable edge/);
  assert.ok((snapshot.expectedExecutableEdge ?? 0) < 0.01);
  assert.ok(snapshot.polymarketExactFillProbability < 0.4);
});

test("fill quality deterministically penalizes thin stale skewed high-latency books", () => {
  const strong = scoreFillQuality({
    candidate: candidate(),
    quoteSnapshot: quote(0.05),
    recentSignals: exactSamples(),
    config: config(),
    nowMs: now,
    placementMode: "polymarket_first_exact",
  });
  const weak = scoreFillQuality({
    candidate: candidate(),
    quoteSnapshot: quote(0.05, {
      quoteSkewMs: 220,
      kalshi: { ...quote().kalshi!, depth: 5, quoteAgeMs: 650, spread: 0.09 },
      polymarket: { ...quote().polymarket!, depth: 5, quoteAgeMs: 650, spread: 0.1 },
    }),
    recentSignals: exactSamples().map((sample) => ({
      ...sample,
      // Well above 0.85 * the 2500ms order timeout default (2125ms) so the RTT penalty fires.
      executionTimings: { kalshiOrderRttMs: 3100, polymarketOrderRttMs: 3300 },
    })),
    config: config(),
    nowMs: now,
    placementMode: "polymarket_first_exact",
  });

  assert.ok(weak.pairedFillProbability < strong.pairedFillProbability);
  assert.ok((weak.pairedFillConfidence?.kalshiEffectiveDepth ?? 0) < (weak.pairedFillConfidence?.kalshiDisplayedDepth ?? 0));
  assert.ok((weak.pairedFillConfidence?.polymarketEffectiveDepth ?? 0) < (weak.pairedFillConfidence?.polymarketDisplayedDepth ?? 0));
  assert.ok(weak.penaltyReasons.some((reason) => reason.includes("thin")));
  assert.ok(weak.penaltyReasons.some((reason) => reason.includes("RTT")));
});

test("fill quality includes paired-fill confidence report with in-range Polymarket and Kalshi reject rates", () => {
  const samples = [
    signal({
      id: 1,
      kalshiFillCount: 8,
      polymarketFillCount: 8,
    }),
    signal({
      id: 2,
      action: "failed",
      partialFill: true,
      kalshiStatus: "failed",
      kalshiError: "Kalshi order failed 400: insufficient_balance",
      kalshiFillCount: 0,
      polymarketStatus: "filled",
      polymarketFillCount: 8.4,
    }),
    signal({
      id: 3,
      action: "failed",
      partialFill: true,
      kalshiStatus: "not_submitted",
      kalshiFillCount: 0,
      polymarketStatus: "filled",
      polymarketFillCount: 7.2,
    }),
  ];

  const snapshot = scoreFillQuality({
    candidate: candidate(),
    quoteSnapshot: quote(0.04),
    recentSignals: samples,
    config: config({ liveOrderSize: 8, livePolymarketFirstMinFillShares: 7, livePolymarketFirstMaxFillShares: 9 }),
    nowMs: now,
    placementMode: "polymarket_first_exact",
  });

  assert.equal(snapshot.pairedFillConfidence?.kalshiDisplayedDepth, 20);
  assert.equal(snapshot.pairedFillConfidence?.polymarketDisplayedDepth, 20);
  assert.equal(snapshot.pairedFillConfidence?.polymarketRecentInRangeFillRate, 1);
  assert.ok((snapshot.pairedFillConfidence?.kalshiRecentRejectRate ?? 0) > 0);
  assert.equal(snapshot.pairedFillConfidence?.pairedFillProbability, snapshot.pairedFillProbability);
});

test("fill quality incorporates high-confidence adverse lead/lag risk", () => {
  const base = scoreFillQuality({
    candidate: candidate(),
    quoteSnapshot: quote(0.05),
    recentSignals: exactSamples(),
    config: config(),
    nowMs: now,
    placementMode: "polymarket_first_exact",
  });
  const adverse = scoreFillQuality({
    candidate: candidate(),
    quoteSnapshot: quote(0.05, {
      leadLagSnapshot: {
        version: "heuristic-v1",
        scoredAt: now,
        shadowMode: true,
        gateEnabled: false,
        gatePassed: true,
        blockReason: null,
        leaderVenue: "polymarket",
        laggingVenue: "kalshi",
        lagMsEstimate: 120,
        confidence: 0.82,
        stalenessScore: 0,
        adverseSelectionScore: 0.86,
        cheapLegVenue: "polymarket",
        cheapLegIsLagging: false,
        windows: [],
        reasons: ["Polymarket appears to lead recent book movement"],
      },
    }),
    recentSignals: exactSamples(),
    config: config(),
    nowMs: now,
    placementMode: "polymarket_first_exact",
  });

  assert.ok(adverse.polymarketExactFillProbability < base.polymarketExactFillProbability);
  assert.ok((adverse.expectedExecutableEdge ?? 0) < (base.expectedExecutableEdge ?? 0));
  assert.ok(adverse.penaltyReasons.some((reason) => reason.includes("Lead/lag")));
});

test("fill quality cold start uses conservative defaults but does not block in shadow mode", () => {
  const snapshot = scoreFillQuality({
    candidate: candidate(),
    quoteSnapshot: quote(0.01),
    recentSignals: [],
    config: config({ liveFillQualityGateEnabled: false }),
    nowMs: now,
    placementMode: "polymarket_first_exact",
  });

  assert.equal(snapshot.shadowMode, true);
  assert.equal(snapshot.blockReason, null);
  assert.equal(snapshot.features.coldStart, true);
  assert.equal(snapshot.features.sampleCount, 0);
});
