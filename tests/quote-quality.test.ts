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
  assert.equal(loadConfig({}).arbScanHeartbeatMs, 250);
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

test("live quote quality enforces minimum book depth above order size without raising execution cap", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig({ liveOrderSize: 5, liveMinBookDepthShares: 10 });
  const poly = contract({
    venue: "polymarket",
    contractId: "poly",
    strike: 1500,
    yesAsk: 0.4,
    yesAskLevels: [
      { price: 0.4, size: 5 },
      { price: 0.8, size: 5 },
    ],
    yesTokenId: "yes-token",
    updatedAt: now,
  });
  const kalshi = contract({
    venue: "kalshi",
    contractId: "kalshi",
    strike: 1502,
    noAsk: 0.1,
    noAskLevels: [{ price: 0.1, size: 10 }],
    updatedAt: now,
  });
  const candidate = candidateFrom(poly, kalshi);

  const enoughDepth = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(enoughDepth.ok, true);
  assert.equal(enoughDepth.snapshot.polymarket?.depthRequired, 10);
  assert.equal(enoughDepth.snapshot.polymarket?.depth, 10);
  assert.equal(enoughDepth.snapshot.polymarket?.worstAsk, 0.4);
  assert.equal(enoughDepth.snapshot.polymarket?.maxBuyPrice, 0.4);
  assert.deepEqual(enoughDepth.snapshot.polymarket?.levelsConsumed, [{ price: 0.4, size: 5 }]);

  const underDepth = evaluateLiveQuoteQuality(candidate, {
    kalshi: [kalshi],
    polymarket: [{ ...poly, yesAskLevels: [{ price: 0.4, size: 5 }] }],
  }, config, now);
  assert.equal(underDepth.ok, false);
  assert.match(underDepth.reason ?? "", /polymarket yes depth 5 below required 10/);
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

test("first-leg cross offset (P1-5) deepens only the Polymarket limit and the edge gate still binds", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig({ liveTakerPriceCushionCents: 2, minProfitDollars: 0.01 });
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
    noAsk: 0.52,
    noAskLevels: [{ price: 0.52, size: 5 }],
    updatedAt: now,
  });
  const candidate = candidateFrom(poly, kalshi);
  const books = { kalshi: [kalshi], polymarket: [poly] };

  // No cross offset: both legs use the 2c taker cushion (poly 0.42, kalshi 0.54).
  const base = evaluateLiveQuoteQuality(candidate, books, config, now);
  assert.equal(base.polymarketMaxBuyPrice, 0.42);
  assert.equal(base.kalshiMaxBuyPrice, 0.54);

  // 5c cross: ONLY the Polymarket first leg deepens to 0.45; Kalshi keeps the 2c cushion at 0.54.
  const crossed = evaluateLiveQuoteQuality(candidate, books, config, now, 5);
  assert.equal(crossed.polymarketMaxBuyPrice, 0.45);
  assert.equal(crossed.kalshiMaxBuyPrice, 0.54);
  assert.equal(crossed.snapshot.projectedEdgeAfterFees, 0.01); // 1 - (0.45 + 0.54)
  assert.equal(crossed.ok, true);

  // A cross deep enough to erase guaranteed profit is REJECTED, never executed (no added exposure).
  const tooDeep = evaluateLiveQuoteQuality(candidate, books, config, now, 6);
  assert.equal(tooDeep.polymarketMaxBuyPrice, 0.46);
  assert.equal(tooDeep.snapshot.projectedEdgeAfterFees, 0); // 1 - (0.46 + 0.54)
  assert.equal(tooDeep.ok, false);
  assert.match(tooDeep.reason ?? "", /cushioned executable edge/);

  // A cross offset below the taker cushion is a no-op (the larger cushion still applies).
  const belowCushion = evaluateLiveQuoteQuality(candidate, books, config, now, 1);
  assert.equal(belowCushion.polymarketMaxBuyPrice, 0.42);
});

test("Polymarket leg honors a tighter freshness bound than Kalshi (P2-10)", () => {
  const now = 1_800_000_000_000;
  // General bar 1000ms; Polymarket tightened to 300ms (the staleness-prone CLOB leg).
  const config = safetyConfig({ liveQuoteMaxAgeMs: 1_000, livePolymarketQuoteMaxAgeMs: 300, liveQuoteSyncMaxSkewMs: 500 });
  const poly = contract({
    venue: "polymarket",
    contractId: "poly",
    strike: 1500,
    yesAsk: 0.4,
    yesAskLevels: [{ price: 0.4, size: 5 }],
    yesTokenId: "yes-token",
    updatedAt: now - 400,
  });
  const kalshi = contract({
    venue: "kalshi",
    contractId: "kalshi",
    strike: 1502,
    noAsk: 0.52,
    noAskLevels: [{ price: 0.52, size: 5 }],
    updatedAt: now - 400,
  });
  const candidate = candidateFrom(poly, kalshi);

  // 400ms-old Polymarket quote is stale under the 300ms Polymarket bar (Kalshi at the same age is fresh).
  const stale = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(stale.ok, false);
  assert.match(stale.reason ?? "", /polymarket .* quote is stale: age 400ms exceeds 300ms/);

  // A fresher Polymarket quote (200ms) passes both bars.
  const fresh = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [{ ...poly, updatedAt: now - 200 }] }, config, now);
  assert.equal(fresh.ok, true);
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
