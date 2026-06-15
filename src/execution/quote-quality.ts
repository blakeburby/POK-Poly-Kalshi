import type { AppConfig } from "../config";
import type { ArbCandidate, ArbLeg, BinaryContract, BookLevel, LegDirection, QuoteSnapshot, QuoteSnapshotLeg, Venue } from "../types";

export interface LiveQuoteBooks {
  kalshi: BinaryContract[];
  polymarket: BinaryContract[];
}

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

function findContract(books: LiveQuoteBooks, leg: ArbLeg): BinaryContract | null {
  return books[leg.venue].find((contract) => contract.contractId === leg.contractId) ?? null;
}

function quoteLeg(
  leg: ArbLeg | null,
  contract: BinaryContract | null,
  config: AppConfig,
  now: number,
): { snapshot: QuoteSnapshotLeg | null; reason: string | null; maxBuyPrice: number | null; adjustedLeg: ArbLeg | null } {
  const depthRequired = Math.max(config.liveOrderSize, config.liveMinBookDepthShares);
  if (!leg) return { snapshot: null, reason: "candidate must contain one Kalshi leg and one Polymarket leg", maxBuyPrice: null, adjustedLeg: null };
  if (!contract) return { snapshot: null, reason: `${leg.venue} contract ${leg.contractId} is missing from live book preflight`, maxBuyPrice: null, adjustedLeg: null };

  const topAsk = askFor(contract, leg.direction);
  const bookLevels = levelsFor(contract, leg.direction);
  const executionVwap = depthWeightedAsk(bookLevels, config.liveOrderSize);
  const requiredDepthVwap = depthWeightedAsk(bookLevels, depthRequired);
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
  };

  if (quoteAgeMs > config.liveQuoteMaxAgeMs) {
    return { snapshot, reason: `${leg.venue} ${leg.direction} quote is stale: age ${quoteAgeMs}ms exceeds ${config.liveQuoteMaxAgeMs}ms`, maxBuyPrice: null, adjustedLeg: null };
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
  if (contract.tickSizeChangedAt != null && now - contract.tickSizeChangedAt <= config.liveQuoteMaxAgeMs) {
    return { snapshot, reason: `${leg.venue} ${leg.direction} tick size changed within quote freshness window`, maxBuyPrice: null, adjustedLeg: null };
  }

  const takerCushion = Math.max(0, config.liveTakerPriceCushionCents);
  const maxBuyPrice = roundPrice(Math.min(1, executionVwap.worstAsk + takerCushion / 100));
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
): LiveQuoteEvaluation {
  const kalshiLeg = legForVenue(candidate, "kalshi");
  const polymarketLeg = legForVenue(candidate, "polymarket");
  const kalshiContract = kalshiLeg ? findContract(books, kalshiLeg) : null;
  const polymarketContract = polymarketLeg ? findContract(books, polymarketLeg) : null;
  const kalshi = quoteLeg(kalshiLeg, kalshiContract, config, now);
  const polymarket = quoteLeg(polymarketLeg, polymarketContract, config, now);
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
  const projectedEdgeAfterFees = projectedEdgeAtLimit;
  if (!failureReason && projectedEdgeAfterFees != null && projectedEdgeAfterFees + 1e-9 < config.minProfitDollars) {
    failureReason = `cushioned executable edge ${projectedEdgeAfterFees.toFixed(4)} below threshold ${config.minProfitDollars.toFixed(4)}`;
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
