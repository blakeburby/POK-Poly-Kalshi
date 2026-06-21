import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";
import { depthWeightedAsk, evaluateLiveQuoteQuality, executableLiquidityWithinBand, captureShadowLadder, expectedKalshiFeePerShare, selectExecutableSize } from "../src/execution/quote-quality";
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

test("W2: dynamic sizing config defaults to a single-point band (byte-identical) and guards concurrency", () => {
  const d = loadConfig({ LIVE_ORDER_SIZE: "5" });
  assert.equal(d.liveDynamicSizingEnabled, false);
  assert.equal(d.liveMinOrderSize, 5); // defaults to liveOrderSize
  assert.equal(d.liveMaxOrderSize, 5); // single point -> selector is a no-op
  assert.equal(loadConfig({ LIVE_ORDER_SIZE: "5", LIVE_MAX_ORDER_SIZE: "20" }).liveMaxOrderSize, 20);
  assert.equal(loadConfig({ LIVE_ORDER_SIZE: "5", LIVE_MAX_ORDER_SIZE: "3" }).liveMaxOrderSize, 5); // clamped >= min
  // Guard: dynamic sizing requires serialized execution (the selector uses a per-execution field).
  assert.throws(() => loadConfig({ LIVE_DYNAMIC_SIZING_ENABLED: "true", ARB_EXECUTION_CONCURRENCY: "2" }), /ARB_EXECUTION_CONCURRENCY=1/);
  assert.doesNotThrow(() => loadConfig({ LIVE_DYNAMIC_SIZING_ENABLED: "true", ARB_EXECUTION_CONCURRENCY: "1" }));
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

test("W1: expectedKalshiFeePerShare models the venue fee (~0.07*p*(1-p), 0 at the tails)", () => {
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ~= ${b}`);
  near(expectedKalshiFeePerShare(0.5), 0.0175); // peak
  near(expectedKalshiFeePerShare(0.51), 0.07 * 0.51 * 0.49);
  near(expectedKalshiFeePerShare(0.9), 0.0063); // small at the tails
  assert.equal(expectedKalshiFeePerShare(0), 0);
  assert.equal(expectedKalshiFeePerShare(1), 0);
  assert.equal(expectedKalshiFeePerShare(null), 0);
});

test("W1: fee-aware gate subtracts the expected Kalshi fee from the edge; byte-identical when off", () => {
  const now = 1_800_000_000_000;
  const poly = contract({
    venue: "polymarket", contractId: "poly", strike: 1500,
    yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 5 }], yesTokenId: "yes-token", updatedAt: now,
  });
  const kalshi = contract({
    venue: "kalshi", contractId: "kalshi", strike: 1502,
    noAsk: 0.51, noAskLevels: [{ price: 0.51, size: 5 }], updatedAt: now,
  });
  const candidate = candidateFrom(poly, kalshi);
  const books = { kalshi: [kalshi], polymarket: [poly] };

  // Flag OFF (default): cushioned edge = 1 - (0.42 + 0.53) = 0.05, no fee term -> passes the 0.05 gate.
  const off = evaluateLiveQuoteQuality(candidate, books, safetyConfig({ liveTakerPriceCushionCents: 2 }), now);
  assert.equal(off.snapshot.projectedEdgeAtLimit, 0.05);
  assert.equal(off.snapshot.projectedEdgeAfterFees, 0.05); // == edge-at-limit (byte-identical)
  assert.equal(off.snapshot.expectedKalshiFeePerShare ?? null, null);
  assert.equal(off.ok, true);

  // Flag ON: subtract expectedKalshiFee(kalshiVwap 0.51)=0.0175 -> after-fee edge 0.0325 < 0.05 -> correctly
  // rejected (the trade was only "profitable" because the old gate ignored fees).
  const on = evaluateLiveQuoteQuality(candidate, books, safetyConfig({ liveTakerPriceCushionCents: 2, liveFeeAwareGateEnabled: true }), now);
  assert.equal(on.snapshot.projectedEdgeAtLimit, 0.05);
  assert.equal(on.snapshot.expectedKalshiFeePerShare, 0.0175);
  assert.equal(on.snapshot.projectedEdgeAfterFees, 0.0325);
  assert.equal(on.ok, false);
  assert.match(on.reason ?? "", /cushioned executable edge 0.0325 below threshold 0.0500/);
});

test("W2: selectExecutableSize returns liveOrderSize when dynamic sizing is off or the band is a single point", () => {
  const now = 1_800_000_000_000;
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 50 }], yesTokenId: "yes-token", updatedAt: now });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 50 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);
  const books = { kalshi: [kalshi], polymarket: [poly] };
  // off -> static
  assert.equal(selectExecutableSize(candidate, books, safetyConfig({ liveOrderSize: 5, liveMinOrderSize: 5, liveMaxOrderSize: 20 }), null, now), 5);
  // on but single-point band -> static
  assert.equal(selectExecutableSize(candidate, books, safetyConfig({ liveDynamicSizingEnabled: true, liveOrderSize: 5, liveMinOrderSize: 5, liveMaxOrderSize: 5 }), null, now), 5);
});

test("W2: selectExecutableSize scales UP to the largest size that still clears the gate on deep books", () => {
  const now = 1_800_000_000_000;
  // Polymarket deep & tight; Kalshi deep enough at a price that keeps the edge >= 0.05 up to size 20.
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 50 }], yesTokenId: "yes-token", updatedAt: now });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 50 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);
  const books = { kalshi: [kalshi], polymarket: [poly] };
  // cushion 0, edge = 1-(0.5+0.4)=0.10 >= 0.05 at every size up to 50; slippage 0 -> picks the MAX (20).
  const config = safetyConfig({ liveDynamicSizingEnabled: true, liveOrderSize: 5, liveMinOrderSize: 5, liveMaxOrderSize: 20, liveDynamicSizingMaxKalshiSlippageCents: 10 });
  assert.equal(selectExecutableSize(candidate, books, config, null, now), 20);
});

test("W2: selectExecutableSize CAPS at the size where thin Kalshi depth pushes the edge below threshold", () => {
  const now = 1_800_000_000_000;
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 50 }], yesTokenId: "yes-token", updatedAt: now });
  // Kalshi: 10 shares at 0.51 (edge 0.09), then a cliff to 0.60 (edge 0.00 < 0.05). Sizes >10 fail the gate.
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.51, noAskLevels: [{ price: 0.51, size: 10 }, { price: 0.6, size: 50 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);
  const books = { kalshi: [kalshi], polymarket: [poly] };
  const config = safetyConfig({ liveDynamicSizingEnabled: true, liveOrderSize: 5, liveMinOrderSize: 5, liveMaxOrderSize: 20, liveDynamicSizingMaxKalshiSlippageCents: 20 });
  assert.equal(selectExecutableSize(candidate, books, config, null, now), 10);
});

test("W2: selectExecutableSize CAPS on the Kalshi slippage band even when the edge would still clear", () => {
  const now = 1_800_000_000_000;
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.3, yesAskLevels: [{ price: 0.3, size: 50 }], yesTokenId: "yes-token", updatedAt: now });
  // Kalshi: 10 @ 0.5, then 0.52 (edge still 1-(0.52+0.3)=0.18 >= 0.05, but worstAsk-topAsk = 2c slippage).
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 10 }, { price: 0.52, size: 50 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);
  const books = { kalshi: [kalshi], polymarket: [poly] };
  // 1c slippage band -> sizes >10 (which need the 0.52 level, 2c slippage) are rejected -> cap at 10.
  const config = safetyConfig({ liveDynamicSizingEnabled: true, liveOrderSize: 5, liveMinOrderSize: 5, liveMaxOrderSize: 20, liveDynamicSizingMaxKalshiSlippageCents: 1 });
  assert.equal(selectExecutableSize(candidate, books, config, null, now), 10);
});

test("M2: selectExecutableSize sizes DOWN to fit available Kalshi cash instead of skipping the window", () => {
  const now = 1_800_000_000_000;
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 50 }], yesTokenId: "yes-token", updatedAt: now });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 50 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);
  const books = { kalshi: [kalshi], polymarket: [poly] };
  const config = safetyConfig({ liveDynamicSizingEnabled: true, liveOrderSize: 5, liveMinOrderSize: 5, liveMaxOrderSize: 20, liveDynamicSizingMaxKalshiSlippageCents: 10 });
  // Cash-unaware (null): deep book -> picks the MAX.
  assert.equal(selectExecutableSize(candidate, books, config, null, now), 20);
  // Cash-aware with ~$6: the size-20 Kalshi reserve (~$10) doesn't fit, so it sizes DOWN to the largest
  // affordable size instead of skipping the trade. (M2 = "capture every trade".)
  const sized = selectExecutableSize(candidate, books, config, 6, now);
  assert.ok(sized < 20 && sized >= 5, `expected a sized-down 5..19, got ${sized}`);
});

test("W2: selectExecutableSize respects the bankroll bound (caps when Kalshi collateral exceeds cash)", () => {
  const now = 1_800_000_000_000;
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 50 }], yesTokenId: "yes-token", updatedAt: now });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 50 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);
  const books = { kalshi: [kalshi], polymarket: [poly] };
  const config = safetyConfig({ liveDynamicSizingEnabled: true, liveOrderSize: 5, liveMinOrderSize: 5, liveMaxOrderSize: 20, liveDynamicSizingMaxKalshiSlippageCents: 10, liveCollateralBufferDollars: 0.25 });
  // Kalshi collateral at size S ~= S*0.5 + 0.25. Cash $5.5 -> max S ~= 10 (10*0.5+0.25=5.25 <= 5.5; 11 -> 5.75 > 5.5).
  assert.equal(selectExecutableSize(candidate, books, config, 5.5, now), 10);
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

// ---- T2.5 real-liquidity (anti-dust) guard ----

test("executableLiquidityWithinBand sums only contracts within the price band of the best ask", () => {
  const levels = [
    { price: 0.4, size: 1 },
    { price: 0.41, size: 3 },
    { price: 0.95, size: 50 },
  ];
  assert.equal(executableLiquidityWithinBand(levels, 0.4, 2), 4); // 0.40 + 0.41 within 2c; 0.95 excluded
  assert.equal(executableLiquidityWithinBand(levels, 0.4, 0), 1); // only the best-ask lot
});

test("T2.5 anti-dust guard is default-inert: serialized snapshot omits the guard fields and behavior is unchanged", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig(); // both knobs default 0
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 5 }], yesTokenId: "yes-token", updatedAt: now });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 5 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);

  const result = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(result.ok, true);
  // undefined-valued fields are dropped by JSON.stringify, so the persisted snapshot is byte-identical.
  assert.equal(JSON.stringify(result.snapshot.polymarket).includes("executableLiquidityShares"), false);
  assert.equal(JSON.stringify(result.snapshot.polymarket).includes("executableAskSlippageCents"), false);
  assert.equal(JSON.stringify(result.snapshot.kalshi).includes("executableLiquidityShares"), false);
});

test("T2.5 liquidity guard rejects a single-lot dust quote at size 1 that the edge gate alone would accept", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig({ liveOrderSize: 1, liveMinBookDepthShares: 5, liveMinExecutableLiquidityShares: 5, liveMaxExecutableAskSlippageCents: 2 });
  // One real contract at the marketable top (0.40), the rest of the book far above the band.
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 1 }, { price: 0.95, size: 50 }], yesTokenId: "yes-token", updatedAt: now });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 10 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);

  const result = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /executable liquidity 1 within 2c of top ask 0.4 below required 5/);
  assert.equal(result.snapshot.polymarket?.executableLiquidityShares, 1);
});

test("T2.5 guard passes a genuine shallow-real book at size 1", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig({ liveOrderSize: 1, liveMinBookDepthShares: 5, liveMinExecutableLiquidityShares: 5, liveMaxExecutableAskSlippageCents: 2 });
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 6 }], yesTokenId: "yes-token", updatedAt: now });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 6 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);

  const result = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.polymarket?.executableLiquidityShares, 6);
  assert.equal(result.snapshot.polymarket?.executableAskSlippageCents, 0);
});

test("T2.5 slippage guard independently rejects a thin top backed only by far-away depth", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig({ liveOrderSize: 5, liveMinBookDepthShares: 5, liveMaxExecutableAskSlippageCents: 1 });
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 1 }, { price: 0.6, size: 10 }], yesTokenId: "yes-token", updatedAt: now });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 10 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);

  const result = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /executable ask slippage 20.00c exceeds 1c/);
});

test("T2.5 guard composes: an existing staleness reason still wins over the guard", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig({ liveOrderSize: 1, liveMinBookDepthShares: 5, liveMinExecutableLiquidityShares: 5 });
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 1 }, { price: 0.95, size: 50 }], yesTokenId: "yes-token", updatedAt: now - 5_000 });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 10 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);

  const result = evaluateLiveQuoteQuality(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /stale/);
});

// ---- T2.4 shadow ladder capture ----

test("captureShadowLadder probes each configured size and flags insufficient depth", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig({ liveOrderSize: 5, liveShadowLadderProbeSizes: [1, 2, 3, 5, 8] });
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 2 }, { price: 0.42, size: 3 }], yesTokenId: "yes-token", updatedAt: now });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.4, noAskLevels: [{ price: 0.4, size: 2 }, { price: 0.42, size: 3 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);

  const ladder = captureShadowLadder(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.deepEqual(ladder.probeSizes, [1, 2, 3, 5, 8]);
  const polyProbe1 = ladder.polymarket?.probes.find((p) => p.size === 1);
  const polyProbe5 = ladder.polymarket?.probes.find((p) => p.size === 5);
  const polyProbe8 = ladder.polymarket?.probes.find((p) => p.size === 8);
  assert.equal(polyProbe1?.sufficientDepth, true);
  assert.equal(polyProbe1?.vwap, 0.4);
  assert.equal(polyProbe5?.sufficientDepth, true);
  assert.equal(polyProbe5?.vwap, 0.412);
  assert.equal(polyProbe8?.sufficientDepth, false);
  assert.equal(polyProbe8?.vwap, null);
  assert.equal(polyProbe8?.depth, 5);
});

test("captureShadowLadder surfaces phantom collapse: large top-of-book edge that vanishes at depth", () => {
  const now = 1_800_000_000_000;
  const config = safetyConfig({ liveOrderSize: 5, liveShadowLadderProbeSizes: [1, 5, 11] });
  // topAsk sum 0.88 (>=10c top-of-book edge) but the size-5 VWAP collapses the edge to ~3c.
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 1 }, { price: 0.5, size: 9 }], yesTokenId: "yes-token", updatedAt: now });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.48, noAskLevels: [{ price: 0.48, size: 1 }, { price: 0.49, size: 9 }], updatedAt: now });
  const candidate = candidateFrom(poly, kalshi);

  const ladder = captureShadowLadder(candidate, { kalshi: [kalshi], polymarket: [poly] }, config, now);
  assert.equal(ladder.topOfBookEdge, 0.12); // 1 - (0.40 + 0.48)
  const edge1 = ladder.executableEdgeBySize.find((e) => e.size === 1)?.executableEdge;
  const edge5 = ladder.executableEdgeBySize.find((e) => e.size === 5)?.executableEdge;
  const edge11 = ladder.executableEdgeBySize.find((e) => e.size === 11)?.executableEdge;
  assert.equal(edge1, 0.12); // size-1 VWAP == top of book
  assert.equal(edge5, 0.032); // 1 - (0.48 + 0.488)
  assert.equal(edge11, null); // insufficient depth on at least one leg
});
