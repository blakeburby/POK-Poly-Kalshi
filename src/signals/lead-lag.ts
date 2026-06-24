import type { AppConfig } from "../config";
import type {
  ArbCandidate,
  BinaryContract,
  BookLevel,
  LeadLagSnapshot,
  LeadLagVenue,
  LeadLagWindowSnapshot,
  LegDirection,
  QuoteSnapshot,
  QuoteSnapshotLeg,
  Venue,
} from "../types";

export interface BookHistorySample {
  venue: Venue;
  contractId: string;
  direction: LegDirection;
  timestamp: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  bidSize: number;
  askSize: number;
  depth: number;
  microprice: number | null;
  liquidity: number | null;
  ofi: number | null;
}

export interface LeadLagHistory {
  kalshi: BookHistorySample[];
  polymarket: BookHistorySample[];
}

export interface ScoreLeadLagInput {
  candidate: ArbCandidate;
  quoteSnapshot: QuoteSnapshot;
  history: LeadLagHistory;
  config: AppConfig;
  nowMs: number;
}

const MATERIAL_MOVE = 0.005;
const MAX_HISTORY_MS = 60_000;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function roundMetric(value: number | null | undefined, digits = 4): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function firstLevelSize(levels: BookLevel[] | undefined): number {
  return levels?.[0]?.size ?? 0;
}

function depthAtSize(levels: BookLevel[] | undefined, requiredSize: number): number {
  let total = 0;
  for (const level of levels ?? []) {
    total += Math.max(0, level.size);
    if (total >= requiredSize) return total;
  }
  return total;
}

function microprice(bid: number | null, ask: number | null, bidSize: number, askSize: number): number | null {
  if (bid == null && ask == null) return null;
  if (bid == null) return ask;
  if (ask == null) return bid;
  const totalSize = bidSize + askSize;
  if (totalSize <= 0) return (bid + ask) / 2;
  return (ask * bidSize + bid * askSize) / totalSize;
}

function liquidity(depth: number, spread: number | null, requiredSize: number): number | null {
  if (spread == null || spread <= 0) return depth / Math.max(1, requiredSize);
  return depth / Math.max(1, requiredSize) / Math.max(spread, 0.01);
}

function ofi(previous: BookHistorySample | undefined, next: Omit<BookHistorySample, "ofi">): number | null {
  if (!previous) return null;
  let bidContribution = 0;
  if (previous.bid != null && next.bid != null) {
    if (next.bid > previous.bid) bidContribution = next.bidSize;
    else if (next.bid < previous.bid) bidContribution = -previous.bidSize;
    else bidContribution = next.bidSize - previous.bidSize;
  }
  let askContribution = 0;
  if (previous.ask != null && next.ask != null) {
    if (next.ask < previous.ask) askContribution = next.askSize;
    else if (next.ask > previous.ask) askContribution = -previous.askSize;
    else askContribution = previous.askSize - next.askSize;
  }
  return roundMetric(bidContribution + askContribution, 4);
}

function contractLevels(
  contract: BinaryContract,
  direction: LegDirection,
): {
  bid: number | null;
  ask: number | null;
  bidLevels: BookLevel[] | undefined;
  askLevels: BookLevel[] | undefined;
} {
  return direction === "yes"
    ? {
        bid: contract.yesBid,
        ask: contract.yesAsk,
        bidLevels: contract.yesBidLevels,
        askLevels: contract.yesAskLevels,
      }
    : {
        bid: contract.noBid,
        ask: contract.noAsk,
        bidLevels: contract.noBidLevels,
        askLevels: contract.noAskLevels,
      };
}

function makeSample(
  contract: BinaryContract,
  direction: LegDirection,
  requiredSize: number,
  timestamp = contract.updatedAt,
): Omit<BookHistorySample, "ofi"> {
  const levels = contractLevels(contract, direction);
  const bidSize = firstLevelSize(levels.bidLevels);
  const askSize = firstLevelSize(levels.askLevels);
  const depth = depthAtSize(levels.askLevels, requiredSize);
  const spread = levels.bid == null || levels.ask == null ? null : Math.max(0, levels.ask - levels.bid);
  return {
    venue: contract.venue,
    contractId: contract.contractId,
    direction,
    timestamp,
    bid: levels.bid,
    ask: levels.ask,
    spread,
    bidSize,
    askSize,
    depth,
    microprice: microprice(levels.bid, levels.ask, bidSize, askSize),
    liquidity: liquidity(depth, spread, requiredSize),
  };
}

function historyKey(venue: Venue, contractId: string, direction: LegDirection): string {
  return `${venue}:${contractId}:${direction}`;
}

export class RollingBookHistory {
  private readonly samples = new Map<string, BookHistorySample[]>();

  constructor(
    private readonly requiredSize: number,
    private readonly maxAgeMs = MAX_HISTORY_MS,
  ) {}

  record(contract: BinaryContract, direction: LegDirection, timestamp = contract.updatedAt): void {
    const key = historyKey(contract.venue, contract.contractId, direction);
    const existing = this.samples.get(key) ?? [];
    const base = makeSample(contract, direction, this.requiredSize, timestamp);
    const sample: BookHistorySample = {
      ...base,
      ofi: ofi(existing[existing.length - 1], base),
    };
    existing.push(sample);
    const minTimestamp = timestamp - this.maxAgeMs;
    while (existing.length > 0 && existing[0].timestamp < minTimestamp) existing.shift();
    this.samples.set(key, existing);
  }

  get(
    venue: Venue,
    contractId: string,
    direction: LegDirection,
    nowMs: number,
    lookbackMs: number,
  ): BookHistorySample[] {
    const minTimestamp = nowMs - lookbackMs;
    return (this.samples.get(historyKey(venue, contractId, direction)) ?? []).filter(
      (sample) => sample.timestamp >= minTimestamp && sample.timestamp <= nowMs,
    );
  }
}

function materialMoveAt(samples: BookHistorySample[], base: BookHistorySample | undefined): number | null {
  if (!base?.microprice) return null;
  for (const sample of samples) {
    if (sample.microprice == null) continue;
    if (Math.abs(sample.microprice - base.microprice) >= MATERIAL_MOVE) return sample.timestamp;
  }
  return null;
}

function average(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function signedAverageMove(windows: LeadLagWindowSnapshot[], venue: Venue): number | null {
  return average(windows.map((window) => (venue === "kalshi" ? window.kalshiMove : window.polymarketMove)));
}

function windowSnapshot(windowMs: number, history: LeadLagHistory, nowMs: number): LeadLagWindowSnapshot {
  const kalshiSamples = history.kalshi.filter(
    (sample) => sample.timestamp >= nowMs - windowMs && sample.timestamp <= nowMs,
  );
  const polymarketSamples = history.polymarket.filter(
    (sample) => sample.timestamp >= nowMs - windowMs && sample.timestamp <= nowMs,
  );
  const kalshiBase = kalshiSamples[0];
  const polymarketBase = polymarketSamples[0];
  const kalshiLast = kalshiSamples[kalshiSamples.length - 1];
  const polymarketLast = polymarketSamples[polymarketSamples.length - 1];
  const kalshiMove =
    kalshiBase?.microprice == null || kalshiLast?.microprice == null
      ? null
      : kalshiLast.microprice - kalshiBase.microprice;
  const polymarketMove =
    polymarketBase?.microprice == null || polymarketLast?.microprice == null
      ? null
      : polymarketLast.microprice - polymarketBase.microprice;
  const firstKalshiMoveAtMs = materialMoveAt(kalshiSamples, kalshiBase);
  const firstPolymarketMoveAtMs = materialMoveAt(polymarketSamples, polymarketBase);
  let leaderVenue: LeadLagVenue = "none";
  if (firstKalshiMoveAtMs != null && firstPolymarketMoveAtMs != null) {
    if (Math.abs(firstKalshiMoveAtMs - firstPolymarketMoveAtMs) >= 2)
      leaderVenue = firstKalshiMoveAtMs < firstPolymarketMoveAtMs ? "kalshi" : "polymarket";
  } else if (firstKalshiMoveAtMs != null) {
    leaderVenue = "kalshi";
  } else if (firstPolymarketMoveAtMs != null) {
    leaderVenue = "polymarket";
  } else if (
    kalshiMove != null &&
    polymarketMove != null &&
    Math.max(Math.abs(kalshiMove), Math.abs(polymarketMove)) >= MATERIAL_MOVE
  ) {
    leaderVenue = Math.abs(kalshiMove) > Math.abs(polymarketMove) ? "kalshi" : "polymarket";
  }

  return {
    windowMs,
    kalshiMove: roundMetric(kalshiMove),
    polymarketMove: roundMetric(polymarketMove),
    kalshiUpdateCount: kalshiSamples.length,
    polymarketUpdateCount: polymarketSamples.length,
    kalshiLiquidity: roundMetric(average(kalshiSamples.map((sample) => sample.liquidity))),
    polymarketLiquidity: roundMetric(average(polymarketSamples.map((sample) => sample.liquidity))),
    kalshiOfi: roundMetric(average(kalshiSamples.map((sample) => sample.ofi))),
    polymarketOfi: roundMetric(average(polymarketSamples.map((sample) => sample.ofi))),
    firstKalshiMoveAtMs,
    firstPolymarketMoveAtMs,
    leaderVenue,
  };
}

function dominantLeader(windows: LeadLagWindowSnapshot[]): LeadLagVenue {
  const kalshiVotes = windows.filter((window) => window.leaderVenue === "kalshi").length;
  const polymarketVotes = windows.filter((window) => window.leaderVenue === "polymarket").length;
  if (kalshiVotes === 0 && polymarketVotes === 0) return "none";
  return polymarketVotes > kalshiVotes ? "polymarket" : "kalshi";
}

function lagMsEstimate(windows: LeadLagWindowSnapshot[], leaderVenue: LeadLagVenue): number | null {
  if (leaderVenue === "none") return null;
  const diffs = windows
    .map((window) => {
      if (window.firstKalshiMoveAtMs == null || window.firstPolymarketMoveAtMs == null) return null;
      return Math.abs(window.firstKalshiMoveAtMs - window.firstPolymarketMoveAtMs);
    })
    .filter((value): value is number => value != null && Number.isFinite(value));
  if (diffs.length === 0) return null;
  diffs.sort((left, right) => left - right);
  return diffs[Math.floor(diffs.length / 2)];
}

function cheapVenue(quoteSnapshot: QuoteSnapshot, laggingVenue: Venue | null): Venue | null {
  if (laggingVenue) return laggingVenue;
  const kalshiPrice =
    quoteSnapshot.kalshi?.vwap ?? quoteSnapshot.kalshi?.maxBuyPrice ?? quoteSnapshot.kalshi?.worstAsk ?? null;
  const polymarketPrice =
    quoteSnapshot.polymarket?.vwap ??
    quoteSnapshot.polymarket?.maxBuyPrice ??
    quoteSnapshot.polymarket?.worstAsk ??
    null;
  if (kalshiPrice == null || polymarketPrice == null) return null;
  return polymarketPrice <= kalshiPrice ? "polymarket" : "kalshi";
}

export function leadLagBlockReason(snapshot: LeadLagSnapshot | null | undefined): string | null {
  return snapshot?.blockReason ?? null;
}

export function scoreLeadLag(input: ScoreLeadLagInput): LeadLagSnapshot {
  const { candidate, quoteSnapshot, config, history, nowMs } = input;
  const windowsMs =
    config.liveLeadLagWindowsMs.length > 0 ? config.liveLeadLagWindowsMs : [1_000, 5_000, 15_000, 60_000];
  const windows = windowsMs.map((windowMs) => windowSnapshot(windowMs, history, nowMs));
  const leaderVenue = dominantLeader(windows);
  const laggingVenue: Venue | null =
    leaderVenue === "kalshi" ? "polymarket" : leaderVenue === "polymarket" ? "kalshi" : null;
  const leaderVotes =
    leaderVenue === "none" ? 0 : windows.filter((window) => window.leaderVenue === leaderVenue).length;
  const usableWindows = windows.filter(
    (window) => window.kalshiUpdateCount > 0 && window.polymarketUpdateCount > 0,
  ).length;
  const kalshiMove = signedAverageMove(windows, "kalshi") ?? 0;
  const polymarketMove = signedAverageMove(windows, "polymarket") ?? 0;
  const moveMagnitude = Math.max(Math.abs(kalshiMove), Math.abs(polymarketMove));
  const updateBalance =
    usableWindows === 0
      ? 0
      : Math.min(
          1,
          Math.min(
            average(windows.map((window) => window.kalshiUpdateCount)) ?? 0,
            average(windows.map((window) => window.polymarketUpdateCount)) ?? 0,
          ) / 3,
        );
  const voteConfidence = windows.length === 0 ? 0 : leaderVotes / windows.length;
  const confidence = clamp(voteConfidence * clamp(moveMagnitude / 0.02, 0.25, 1) * clamp(updateBalance, 0.25, 1));
  const cheapLegVenue = cheapVenue(quoteSnapshot, laggingVenue);
  const cheapLegIsLagging = cheapLegVenue == null || laggingVenue == null ? null : cheapLegVenue === laggingVenue;
  const polymarketLeadingRisk = leaderVenue === "polymarket" ? confidence : 0;
  const bothMovingAgainstEntry = kalshiMove > MATERIAL_MOVE && polymarketMove > MATERIAL_MOVE ? 0.2 : 0;
  const staleOpportunity = laggingVenue === "polymarket" ? confidence : 0;
  const stalenessScore = clamp(staleOpportunity);
  const adverseSelectionScore = clamp(polymarketLeadingRisk + bothMovingAgainstEntry - stalenessScore * 0.35);
  const gateEnabled = config.liveLeadLagGateEnabled;
  const shadowMode = !gateEnabled;
  const gatePassed =
    !gateEnabled ||
    confidence < config.liveLeadLagMinConfidence ||
    adverseSelectionScore <= config.liveLeadLagMaxAdverseSelectionScore;
  const blockReason =
    gateEnabled && !gatePassed
      ? `lead-lag adverse selection score ${adverseSelectionScore.toFixed(2)} exceeds ${config.liveLeadLagMaxAdverseSelectionScore.toFixed(2)}`
      : null;
  const reasons: string[] = [];
  const averageUpdatesPerVenue = Math.min(
    average(windows.map((window) => window.kalshiUpdateCount)) ?? 0,
    average(windows.map((window) => window.polymarketUpdateCount)) ?? 0,
  );
  if (usableWindows < 2 || averageUpdatesPerVenue < 2) reasons.push("Book history is thin");
  if (leaderVenue !== "none")
    reasons.push(`${leaderVenue === "polymarket" ? "Polymarket" : "Kalshi"} appears to lead recent book movement`);
  if (laggingVenue === "polymarket") reasons.push("Polymarket leg looks stale/lagging");
  if (bothMovingAgainstEntry > 0) reasons.push("Both venue microprices moved against entry");
  if (blockReason) reasons.push(blockReason);
  if (reasons.length === 0) reasons.push("No high-confidence lead/lag signal");

  return {
    version: config.liveLeadLagModelVersion,
    scoredAt: nowMs,
    shadowMode,
    gateEnabled,
    gatePassed,
    blockReason,
    leaderVenue,
    laggingVenue,
    lagMsEstimate: lagMsEstimate(windows, leaderVenue),
    confidence: roundMetric(confidence) ?? 0,
    stalenessScore: roundMetric(stalenessScore) ?? 0,
    adverseSelectionScore: roundMetric(adverseSelectionScore) ?? 0,
    cheapLegVenue,
    cheapLegIsLagging,
    windows,
    reasons: reasons.slice(0, 4),
  };
}
