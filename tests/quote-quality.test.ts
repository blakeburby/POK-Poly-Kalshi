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
      LIVE_TAKER_PRICE_CUSHION_CENTS: "0",
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

test("config defaults the live minimum edge to one cent", () => {
  assert.equal(loadConfig({}).minProfitDollars, 0.01);
  assert.equal(loadConfig({}).liveMaxTradesPerWindow, 3);
});

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

test("live quote quality rejects stale, skewed, shallow, tick-changing, and raw negative-edge quotes", () => {
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
  assert.equal(ok.snapshot.projectedEdgeAfterFees, 0.1);

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
    kalshi: [{ ...kalshi, noAsk: 0.56, noAskLevels: [{ price: 0.56, size: 5 }] }],
    polymarket: [{ ...poly, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 5 }] }],
  }, config, now);
  assert.equal(noEdge.ok, false);
  assert.match(noEdge.reason ?? "", /cushioned executable edge 0.0400 below threshold 0.0500/);
});

test("live quote quality uses raw VWAP edge without extra live edge buffers", () => {
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
    noAsk: 0.55,
    noAskLevels: [{ price: 0.55, size: 5 }],
    updatedAt: now,
  });
  const candidate = candidateFrom(poly, kalshi);

  const fiveCentEdge = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(fiveCentEdge.ok, true);
  assert.equal(fiveCentEdge.snapshot.projectedEdge, 0.05);
  assert.equal(fiveCentEdge.snapshot.projectedEdgeAfterFees, 0.05);

  const fourCentEdge = evaluateLiveQuoteQuality(candidate, {
    kalshi: [{ ...kalshi, noAsk: 0.56, noAskLevels: [{ price: 0.56, size: 5 }] }],
    polymarket: [poly],
  }, config, now);
  assert.equal(fourCentEdge.ok, false);
  assert.equal(fourCentEdge.snapshot.projectedEdge, 0.04);
  assert.match(fourCentEdge.reason ?? "", /cushioned executable edge 0.0400 below threshold 0.0500/);
});

test("live quote quality gates on cushioned executable edge and applies cushion to both venues", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig({ liveTakerPriceCushionCents: 2 });
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
    noAsk: 0.55,
    noAskLevels: [{ price: 0.55, size: 5 }],
    updatedAt: now,
  });
  const candidate = candidateFrom(poly, kalshi);

  const rawFiveCentEdge = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(rawFiveCentEdge.ok, false);
  assert.equal(rawFiveCentEdge.snapshot.projectedEdge, 0.05);
  assert.equal(rawFiveCentEdge.snapshot.projectedPremiumAtLimit, 0.99);
  assert.equal(rawFiveCentEdge.snapshot.projectedEdgeAtLimit, 0.01);
  assert.equal(rawFiveCentEdge.snapshot.projectedEdgeAfterFees, 0.01);
  assert.equal(rawFiveCentEdge.kalshiMaxBuyPrice, 0.57);
  assert.equal(rawFiveCentEdge.polymarketMaxBuyPrice, 0.42);
  assert.match(rawFiveCentEdge.reason ?? "", /cushioned executable edge 0.0100 below threshold 0.0500/);

  const rawNineCentEdge = evaluateLiveQuoteQuality(candidate, {
    kalshi: [{ ...kalshi, noAsk: 0.51, noAskLevels: [{ price: 0.51, size: 5 }] }],
    polymarket: [poly],
  }, config, now);
  assert.equal(rawNineCentEdge.ok, true);
  assert.equal(rawNineCentEdge.snapshot.projectedEdge, 0.09);
  assert.equal(rawNineCentEdge.snapshot.projectedEdgeAfterFees, 0.05);
  assert.equal(rawNineCentEdge.kalshiMaxBuyPrice, 0.53);
  assert.equal(rawNineCentEdge.polymarketMaxBuyPrice, 0.42);
});

test("live quote quality accepts one-cent cushioned edge and rejects just below it", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig({ minProfitDollars: 0.01, liveTakerPriceCushionCents: 2 });
  const poly = contract({
    venue: "polymarket",
    contractId: "poly",
    strike: 1500,
    yesAsk: 0.43,
    yesAskLevels: [{ price: 0.43, size: 5 }],
    yesTokenId: "yes-token",
    updatedAt: now,
  });
  const kalshi = contract({
    venue: "kalshi",
    contractId: "kalshi",
    strike: 1502,
    noAsk: 0.52,
    noAskLevels: [{ price: 0.52, size: 5 }],
    updatedAt: now,
  });
  const candidate = buildGuaranteedCandidate(poly, kalshi, 0.01);
  assert.ok(candidate);

  const oneCentEdge = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(oneCentEdge.ok, true);
  assert.equal(oneCentEdge.polymarketMaxBuyPrice, 0.45);
  assert.equal(oneCentEdge.kalshiMaxBuyPrice, 0.54);
  assert.equal(oneCentEdge.snapshot.projectedPremiumAtLimit, 0.99);
  assert.equal(oneCentEdge.snapshot.projectedEdgeAfterFees, 0.01);

  const belowOneCent = evaluateLiveQuoteQuality(candidate, {
    kalshi: [kalshi],
    polymarket: [{ ...poly, yesAsk: 0.4301, yesAskLevels: [{ price: 0.4301, size: 5 }] }],
  }, config, now);
  assert.equal(belowOneCent.ok, false);
  assert.equal(belowOneCent.snapshot.projectedEdgeAfterFees, 0.0099);
  assert.match(belowOneCent.reason ?? "", /cushioned executable edge 0.0099 below threshold 0.0100/);
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
  assert.match(result.reason ?? "", /cushioned executable edge -0.1000 below threshold 0.0500/);
});
