import type { AppConfig } from "../config";
import type { ArbCandidate, ArbLeg, BinaryContract, BookLevel, LegDirection, QuoteSnapshot, QuoteSnapshotLeg, ShadowLadderCapture, ShadowLadderLeg, ShadowLadderProbe, Venue } from "../types";

export interface LiveQuoteBooks {
  kalshi: BinaryContract[];
  polymarket: BinaryContract[];
}

// Shared so the executor's shadow-capture predicate (T2.4) stays coupled to the exact gate wording.
export const CUSHIONED_EDGE_REASON_PREFIX = "cushioned executable edge";

export interface DepthVwapResult {
  vwap: number;
  worstAsk: number;
  depth: number;
  levelsConsumed: BookLevel[];
}

export interface LiveQuoteEvaluation {
  ok: boolean;
  reason: string | null;
  snapshot: QuoteSnapshot;
  kalshiLeg: ArbLeg | null;
  polymarketLeg: ArbLeg | null;
  kalshiMaxBuyPrice: number | null;
  polymarketMaxBuyPrice: number | null;
}

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function legForVenue(candidate: ArbCandidate, venue: Venue): ArbLeg | null {
  if (candidate.lower.venue === venue) return candidate.lower;
  if (candidate.higher.venue === venue) return candidate.higher;
  return null;
}

function askFor(contract: BinaryContract, direction: LegDirection): number | null {
  return direction === "yes" ? contract.yesAsk : contract.noAsk;
}

function bidFor(contract: BinaryContract, direction: LegDirection): number | null {
  return direction === "yes" ? contract.yesBid : contract.noBid;
}

function levelsFor(contract: BinaryContract, direction: LegDirection): BookLevel[] {
  const levels = direction === "yes" ? contract.yesAskLevels : contract.noAskLevels;
  return levels ?? [];
}

function spreadFor(contract: BinaryContract, direction: LegDirection): number | null {
  const ask = askFor(contract, direction);
  const bid = bidFor(contract, direction);
  if (ask == null || bid == null) return null;
  return roundPrice(Math.max(0, ask - bid));
}

export function depthWeightedAsk(levels: BookLevel[], size: number): DepthVwapResult | null {
  if (!Number.isFinite(size) || size <= 0) return null;
  let remaining = size;
  let notional = 0;
  let depth = 0;
  let worstAsk = 0;
  const levelsConsumed: BookLevel[] = [];
  const sorted = [...levels]
    .filter((level) => finite(level.price) && finite(level.size) && level.price >= 0 && level.price <= 1 && level.size > 0)
    .sort((a, b) => a.price - b.price);

  for (const level of sorted) {
    if (remaining <= 1e-9) break;
    const take = Math.min(level.size, remaining);
    notional += take * level.price;
    depth += take;
    remaining -= take;
    worstAsk = level.price;
    levelsConsumed.push({ price: roundPrice(level.price), size: roundPrice(take) });
  }

  if (depth + 1e-9 < size) return null;
  return {
    vwap: roundPrice(notional / size),
    worstAsk: roundPrice(worstAsk),
    depth: roundPrice(depth),
    levelsConsumed,
  };
}

// Expected Kalshi taker fee PER SHARE at an executed price. Kalshi charges ceil(0.07 * C * P * (1-P)) per
// fill (C contracts, P price); per share that is ~0.07 * P * (1-P), peaking ~$0.0175 at P=0.5 and ~0 at the
// tails. This is the pre-trade ESTIMATE the fee-aware gate subtracts; the POST-fill realized accounting uses
// the venue-reported actual fee (executor.ts realizedFeePerSpread). Polymarket CLOB taker fee is ~0.
export function expectedKalshiFeePerShare(price: number | null | undefined): number {
  if (price == null || !finite(price) || price <= 0 || price >= 1) return 0;
  return 0.07 * price * (1 - price);
}

// Sum of genuine ask contracts priced within `bandCents` of the best ask. Used by the default-inert
// anti-dust guard so a single-lot phantom/stale top-of-book quote (real depth only far above the band)
// cannot qualify even when LIVE_ORDER_SIZE is small. Reuses the same validity filter as depthWeightedAsk.
export function executableLiquidityWithinBand(levels: BookLevel[], topAsk: number, bandCents: number): number {
  if (!finite(topAsk)) return 0;
  const limit = topAsk + Math.max(0, bandCents) / 100 + 1e-9;
  let total = 0;
  for (const level of levels) {
    if (
      finite(level.price)
      && finite(level.size)
      && level.price >= 0
      && level.price <= 1
      && level.size > 0
      && level.price <= limit
    ) {
      total += level.size;
    }
  }
  return roundPrice(total);
}

function findContract(books: LiveQuoteBooks, leg: ArbLeg): BinaryContract | null {
  return books[leg.venue].find((contract) => contract.contractId === leg.contractId) ?? null;
}

function quoteLeg(
  leg: ArbLeg | null,
  contract: BinaryContract | null,
  config: AppConfig,
  now: number,
  extraCrossCents = 0,
  maxAgeMs = config.liveQuoteMaxAgeMs,
): { snapshot: QuoteSnapshotLeg | null; reason: string | null; maxBuyPrice: number | null; adjustedLeg: ArbLeg | null } {
  const depthRequired = Math.max(config.liveOrderSize, config.liveMinBookDepthShares);
  if (!leg) return { snapshot: null, reason: "candidate must contain one Kalshi leg and one Polymarket leg", maxBuyPrice: null, adjustedLeg: null };
  if (!contract) return { snapshot: null, reason: `${leg.venue} contract ${leg.contractId} is missing from live book preflight`, maxBuyPrice: null, adjustedLeg: null };

  const topAsk = askFor(contract, leg.direction);
  const bookLevels = levelsFor(contract, leg.direction);
  const executionVwap = depthWeightedAsk(bookLevels, config.liveOrderSize);
  const requiredDepthVwap = depthWeightedAsk(bookLevels, depthRequired);
  // T2.5 anti-dust guard (default-inert: both knobs default 0 -> these are no-ops and the snapshot
  // fields below serialize as undefined, so behavior is byte-identical to today). When enabled, they
  // require genuine depth near the best ask so a single-lot phantom/stale quote cannot qualify even at
  // a small LIVE_ORDER_SIZE (where worstAsk(1) == best ask).
  const liquidityGuardOn = config.liveMinExecutableLiquidityShares > 0;
  const slippageGuardOn = config.liveMaxExecutableAskSlippageCents > 0;
  const liquidityBandCents = config.liveMaxExecutableAskSlippageCents > 0
    ? config.liveMaxExecutableAskSlippageCents
    : config.liveTakerPriceCushionCents;
  const executableLiquidityShares = liquidityGuardOn && topAsk != null && finite(topAsk)
    ? executableLiquidityWithinBand(bookLevels, topAsk, liquidityBandCents)
    : null;
  const executableAskSlippageCents = slippageGuardOn && executionVwap != null && topAsk != null && finite(topAsk)
    ? roundPrice(100 * (executionVwap.worstAsk - topAsk))
    : null;
  const quoteAgeMs = now - contract.updatedAt;
  const snapshot: QuoteSnapshotLeg = {
    venue: leg.venue,
    contractId: leg.contractId,
    direction: leg.direction,
    topAsk,
    worstAsk: executionVwap?.worstAsk ?? null,
    vwap: executionVwap?.vwap ?? null,
    maxBuyPrice: null,
    depth: requiredDepthVwap?.depth
      ?? executionVwap?.depth
      ?? bookLevels.reduce((sum, level) => sum + (finite(level.size) ? level.size : 0), 0),
    depthRequired,
    levelsConsumed: executionVwap?.levelsConsumed ?? [],
    spread: spreadFor(contract, leg.direction),
    quoteAgeMs: Number.isFinite(quoteAgeMs) ? quoteAgeMs : null,
    updatedAt: contract.updatedAt,
    sequence: contract.sequence ?? null,
    bookHash: contract.bookHash ?? null,
    tickSize: contract.tickSize ?? null,
    tickSizeChangedAt: contract.tickSizeChangedAt ?? null,
    executableLiquidityShares: liquidityGuardOn ? executableLiquidityShares : undefined,
    executableAskSlippageCents: slippageGuardOn ? executableAskSlippageCents : undefined,
  };

  if (quoteAgeMs > maxAgeMs) {
    return { snapshot, reason: `${leg.venue} ${leg.direction} quote is stale: age ${quoteAgeMs}ms exceeds ${maxAgeMs}ms`, maxBuyPrice: null, adjustedLeg: null };
  }
  if (topAsk == null || !finite(topAsk)) {
    return { snapshot, reason: `${leg.venue} ${leg.direction} ask is unavailable`, maxBuyPrice: null, adjustedLeg: null };
  }
  if (!executionVwap || !requiredDepthVwap) {
    return {
      snapshot,
      reason: `${leg.venue} ${leg.direction} depth ${roundPrice(snapshot.depth)} below required ${depthRequired}`,
      maxBuyPrice: null,
      adjustedLeg: null,
    };
  }
  // T2.5 anti-dust guards: additive only (run after the depth gate, before maxBuyPrice/edge), so they
  // can reject a leg the edge gate would have accepted but never the reverse. Both no-op when their
  // knob is 0 (default). executionVwap and topAsk are non-null here (gated above).
  if (liquidityGuardOn && (executableLiquidityShares ?? 0) + 1e-9 < config.liveMinExecutableLiquidityShares) {
    return {
      snapshot,
      reason: `${leg.venue} ${leg.direction} executable liquidity ${roundPrice(executableLiquidityShares ?? 0)} within ${liquidityBandCents}c of top ask ${topAsk} below required ${config.liveMinExecutableLiquidityShares}`,
      maxBuyPrice: null,
      adjustedLeg: null,
    };
  }
  if (slippageGuardOn) {
    const slipCents = roundPrice(100 * (executionVwap.worstAsk - topAsk));
    if (slipCents > config.liveMaxExecutableAskSlippageCents + 1e-9) {
      return {
        snapshot,
        reason: `${leg.venue} ${leg.direction} executable ask slippage ${slipCents.toFixed(2)}c exceeds ${config.liveMaxExecutableAskSlippageCents}c`,
        maxBuyPrice: null,
        adjustedLeg: null,
      };
    }
  }
  if (contract.tickSizeChangedAt != null && now - contract.tickSizeChangedAt <= config.liveQuoteMaxAgeMs) {
    return { snapshot, reason: `${leg.venue} ${leg.direction} tick size changed within quote freshness window`, maxBuyPrice: null, adjustedLeg: null };
  }

  // The marketable offset is at least the taker cushion; for the first/cancelable leg an extra cross
  // offset (P1-5) can be layered on to absorb post-quote book movement. The projectedEdgeAfterFees gate
  // below still binds, so a deeper cross can never erase guaranteed profit.
  const takerCushion = Math.max(0, config.liveTakerPriceCushionCents);
  const marketableOffsetCents = Math.max(takerCushion, Math.max(0, extraCrossCents));
  const maxBuyPrice = roundPrice(Math.min(1, executionVwap.worstAsk + marketableOffsetCents / 100));
  return {
    snapshot: { ...snapshot, maxBuyPrice },
    reason: null,
    maxBuyPrice,
    adjustedLeg: { ...leg, ask: topAsk },
  };
}

export function evaluateLiveQuoteQuality(
  candidate: ArbCandidate,
  books: LiveQuoteBooks,
  config: AppConfig,
  now = Date.now(),
  polymarketFirstCrossCents = 0,
): LiveQuoteEvaluation {
  const kalshiLeg = legForVenue(candidate, "kalshi");
  const polymarketLeg = legForVenue(candidate, "polymarket");
  const kalshiContract = kalshiLeg ? findContract(books, kalshiLeg) : null;
  const polymarketContract = polymarketLeg ? findContract(books, polymarketLeg) : null;
  const kalshi = quoteLeg(kalshiLeg, kalshiContract, config, now);
  // The extra cross offset (P1-5) and the optionally-tighter freshness bound (P2-10) apply ONLY to the
  // staleness-prone Polymarket leg. The Kalshi leg keeps the standard cushion and freshness bar.
  const polymarket = quoteLeg(polymarketLeg, polymarketContract, config, now, polymarketFirstCrossCents, config.livePolymarketQuoteMaxAgeMs ?? config.liveQuoteMaxAgeMs);
  const quoteSkewMs = kalshi.snapshot?.updatedAt != null && polymarket.snapshot?.updatedAt != null
    ? Math.abs(kalshi.snapshot.updatedAt - polymarket.snapshot.updatedAt)
    : null;

  let failureReason = kalshi.reason ?? polymarket.reason;
  if (!failureReason && quoteSkewMs != null && quoteSkewMs > config.liveQuoteSyncMaxSkewMs) {
    failureReason = `quote skew ${quoteSkewMs}ms exceeds ${config.liveQuoteSyncMaxSkewMs}ms`;
  }

  const projectedPremium = kalshi.snapshot?.vwap != null && polymarket.snapshot?.vwap != null
    ? roundPrice(kalshi.snapshot.vwap + polymarket.snapshot.vwap)
    : null;
  const projectedEdge = projectedPremium == null ? null : roundPrice(1 - projectedPremium);
  const projectedPremiumAtLimit = kalshi.maxBuyPrice != null && polymarket.maxBuyPrice != null
    ? roundPrice(kalshi.maxBuyPrice + polymarket.maxBuyPrice)
    : null;
  const projectedEdgeAtLimit = projectedPremiumAtLimit == null ? null : roundPrice(1 - projectedPremiumAtLimit);
  // Fee-aware gate (flag-gated): subtract the expected Kalshi taker fee, priced at the Kalshi leg VWAP (the
  // expected fill price, matching the realized per-share fee basis). Polymarket CLOB fee ~0. When the flag
  // is off the fee term is null and projectedEdgeAfterFees == projectedEdgeAtLimit (byte-identical).
  const expectedKalshiFee = config.liveFeeAwareGateEnabled
    ? roundPrice(expectedKalshiFeePerShare(kalshi.snapshot?.vwap ?? null))
    : null;
  const projectedEdgeAfterFees = projectedEdgeAtLimit == null
    ? null
    : roundPrice(projectedEdgeAtLimit - (expectedKalshiFee ?? 0));
  if (!failureReason && projectedEdgeAfterFees != null && projectedEdgeAfterFees + 1e-9 < config.minProfitDollars) {
    failureReason = `${CUSHIONED_EDGE_REASON_PREFIX} ${projectedEdgeAfterFees.toFixed(4)} below threshold ${config.minProfitDollars.toFixed(4)}`;
  }

  const snapshot: QuoteSnapshot = {
    capturedAt: now,
    quoteSkewMs,
    kalshi: kalshi.snapshot,
    polymarket: polymarket.snapshot,
    projectedPremium,
    projectedEdge,
    projectedPremiumAtLimit,
    projectedEdgeAtLimit,
    projectedEdgeAfterFees,
    takerPriceCushionCents: Math.max(0, config.liveTakerPriceCushionCents),
    expectedKalshiFeePerShare: expectedKalshiFee,
    kalshiMaxBuyPrice: kalshi.maxBuyPrice,
    polymarketMaxBuyPrice: polymarket.maxBuyPrice,
    minProfitDollars: config.minProfitDollars,
    failureReason,
  };

  return {
    ok: failureReason == null,
    reason: failureReason,
    snapshot,
    kalshiLeg: kalshi.adjustedLeg,
    polymarketLeg: polymarket.adjustedLeg,
    kalshiMaxBuyPrice: kalshi.maxBuyPrice,
    polymarketMaxBuyPrice: polymarket.maxBuyPrice,
  };
}

function shadowLadderLeg(leg: ArbLeg | null, contract: BinaryContract | null, probeSizes: number[]): ShadowLadderLeg | null {
  if (!leg || !contract) return null;
  const topAsk = askFor(contract, leg.direction);
  const bookLevels = levelsFor(contract, leg.direction);
  const totalDepth = bookLevels.reduce((sum, level) => sum + (finite(level.size) ? level.size : 0), 0);
  const probes: ShadowLadderProbe[] = probeSizes.map((size) => {
    const result = depthWeightedAsk(bookLevels, size);
    if (!result) {
      return { size, vwap: null, worstAsk: null, depth: roundPrice(totalDepth), sufficientDepth: false, levelsConsumed: [] };
    }
    return { size, vwap: result.vwap, worstAsk: result.worstAsk, depth: result.depth, sufficientDepth: true, levelsConsumed: result.levelsConsumed };
  });
  return {
    venue: leg.venue,
    contractId: leg.contractId,
    direction: leg.direction,
    topAsk: finite(topAsk) ? topAsk : null,
    probes,
  };
}

// T2.4: pure, read-only multi-size ladder capture used ONLY on the already-rejected below-threshold-edge
// path (gated by LIVE_SHADOW_LADDER_CAPTURE_ENABLED). It performs only arithmetic over already-fetched
// book arrays — no network, no order placement, no gate mutation — so it can never affect trading.
export function captureShadowLadder(candidate: ArbCandidate, books: LiveQuoteBooks, config: AppConfig, now: number): ShadowLadderCapture {
  const probeSizes = Array.from(new Set([...(config.liveShadowLadderProbeSizes ?? []), config.liveOrderSize]))
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((a, b) => a - b);
  const kalshiLeg = legForVenue(candidate, "kalshi");
  const polymarketLeg = legForVenue(candidate, "polymarket");
  const kalshiContract = kalshiLeg ? findContract(books, kalshiLeg) : null;
  const polymarketContract = polymarketLeg ? findContract(books, polymarketLeg) : null;
  const kalshi = shadowLadderLeg(kalshiLeg, kalshiContract, probeSizes);
  const polymarket = shadowLadderLeg(polymarketLeg, polymarketContract, probeSizes);
  const topOfBookEdge = kalshi?.topAsk != null && polymarket?.topAsk != null
    ? roundPrice(1 - (kalshi.topAsk + polymarket.topAsk))
    : null;
  const executableEdgeBySize = probeSizes.map((size) => {
    const k = kalshi?.probes.find((probe) => probe.size === size);
    const p = polymarket?.probes.find((probe) => probe.size === size);
    const executableEdge = k?.vwap != null && p?.vwap != null ? roundPrice(1 - (k.vwap + p.vwap)) : null;
    return { size, executableEdge };
  });
  return {
    capturedAt: now,
    probeSizes,
    minProfitDollars: config.minProfitDollars,
    topOfBookEdge,
    executableEdgeBySize,
    kalshi,
    polymarket,
  };
}
