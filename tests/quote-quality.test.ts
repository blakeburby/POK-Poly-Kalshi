import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";
import { depthWeightedAsk, evaluateLiveQuoteQuality } from "../src/execution/quote-quality";
import { buildGuaranteedCandidate } from "../src/scanner/payoff";
import type { AppConfig } from "../src/config";
import type { BinaryContract } from "../src/types";
import { contract } from "./helpers";

function safetyConfig(input: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      LIVE_ORDER_SIZE: "5",
      LIVE_MIN_BOOK_DEPTH_SHARES: "5",
      ARB_MIN_PROFIT_DOLLARS: "0.05",
      LIVE_EDGE_BUFFER_DOLLARS: "0.03",
      LIVE_ENTRY_LATENCY_EDGE_BUFFER_DOLLARS: "0.02",
      LIVE_QUOTE_MAX_AGE_MS: "750",
      LIVE_QUOTE_SYNC_MAX_SKEW_MS: "250",
    }),
    ...input,
  };
}

function candidateFrom(poly: BinaryContract, kalshi: BinaryContract) {
  const candidate = buildGuaranteedCandidate(poly, kalshi, 0.05);
  assert.ok(candidate);
  return candidate;
}

test("depthWeightedAsk computes order-size VWAP and fails when depth is insufficient", () => {
  const vwap = depthWeightedAsk([
    { price: 0.4, size: 2 },
    { price: 0.42, size: 3 },
    { price: 0.6, size: 10 },
  ], 5);

  assert.equal(vwap?.vwap, 0.412);
  assert.equal(vwap?.worstAsk, 0.42);
  assert.deepEqual(vwap?.levelsConsumed, [
    { price: 0.4, size: 2 },
    { price: 0.42, size: 3 },
  ]);
  assert.equal(depthWeightedAsk([{ price: 0.4, size: 2 }], 5), null);
});

test("live quote quality rejects stale, skewed, shallow, tick-changing, and buffered negative-edge quotes", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig();
  const poly = contract({
    venue: "polymarket",
    contractId: "poly",
    strike: 1500,
    yesAsk: 0.4,
    yesAskLevels: [{ price: 0.4, size: 5 }],
    yesTokenId: "yes-token",
    updatedAt: now,
  });
  const kalshi = contract({
    venue: "kalshi",
    contractId: "kalshi",
    strike: 1502,
    noAsk: 0.5,
    noAskLevels: [{ price: 0.5, size: 5 }],
    updatedAt: now,
  });
  const candidate = candidateFrom(poly, kalshi);

  const ok = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(ok.ok, true);
  assert.equal(ok.snapshot.projectedEdgeAfterFees, 0.05);

  const stale = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [{ ...poly, updatedAt: now - 751 }] }, config, now);
  assert.equal(stale.ok, false);
  assert.match(stale.reason ?? "", /stale/);

  const skewed = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [{ ...poly, updatedAt: now - 300 }] }, safetyConfig({ liveQuoteMaxAgeMs: 1_000 }), now);
  assert.equal(skewed.ok, false);
  assert.match(skewed.reason ?? "", /quote skew/);

  const shallow = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [{ ...poly, yesAskLevels: [{ price: 0.4, size: 4 }] }] }, config, now);
  assert.equal(shallow.ok, false);
  assert.match(shallow.reason ?? "", /depth/);

  const tickChanged = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [{ ...poly, tickSize: 0.01, tickSizeChangedAt: now - 100 }] }, config, now);
  assert.equal(tickChanged.ok, false);
  assert.match(tickChanged.reason ?? "", /tick size/);

  const noEdge = evaluateLiveQuoteQuality(candidate, {
    kalshi: [{ ...kalshi, noAsk: 0.55, noAskLevels: [{ price: 0.55, size: 5 }] }],
    polymarket: [{ ...poly, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 5 }] }],
  }, config, now);
  assert.equal(noEdge.ok, false);
  assert.match(noEdge.reason ?? "", /after buffer below threshold/);
});

test("incident-shaped Kalshi 30 NO versus Polymarket 5 YES cannot pass live quote gates", () => {
  const now = 1_800_000_000_000;
  const poly = contract({
    venue: "polymarket",
    contractId: "poly-incident",
    strike: 80886,
    yesAsk: 0.91,
    yesAskLevels: [{ price: 0.91, size: 5 }],
    yesTokenId: "yes-token",
    updatedAt: now,
  });
  const kalshi = contract({
    venue: "kalshi",
    contractId: "kalshi-incident",
    strike: 80886,
    noAsk: 0.19,
    noAskLevels: [{ price: 0.19, size: 30 }],
    updatedAt: now,
  });
  const candidate = candidateFrom(poly, kalshi);
  const result = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, safetyConfig(), now);

  assert.equal(result.ok, false);
  assert.equal(result.snapshot.kalshi?.depth, 5);
  assert.equal(result.snapshot.polymarket?.depth, 5);
  assert.equal(result.snapshot.projectedPremium, 1.1);
  assert.match(result.reason ?? "", /after buffer below threshold/);
});
