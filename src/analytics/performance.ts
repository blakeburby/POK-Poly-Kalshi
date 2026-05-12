import type {
  AnalyticsWindow,
  DashboardAnalytics,
  DashboardAnalyticsBucket,
  DashboardAnalyticsDistributionBucket,
  DashboardAnalyticsHeatmapCell,
  DashboardAnalyticsRealtime,
  DashboardAnalyticsWindow,
  DashboardSignal,
} from "../types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const EPSILON = 0.000_001;

interface WindowDefinition {
  window: AnalyticsWindow;
  label: string;
  bucketMs: number;
  bucketCount: number;
  align: (timestampMs: number) => number;
}

const WINDOWS: Record<AnalyticsWindow, WindowDefinition> = {
  hourly: {
    window: "hourly",
    label: "Hourly",
    bucketMs: HOUR_MS,
    bucketCount: 24,
    align: startOfUtcHour,
  },
  daily: {
    window: "daily",
    label: "Daily",
    bucketMs: DAY_MS,
    bucketCount: 7,
    align: startOfUtcDay,
  },
  weekly: {
    window: "weekly",
    label: "Weekly",
    bucketMs: WEEK_MS,
    bucketCount: 8,
    align: startOfUtcWeek,
  },
};

interface AnalyticsTrade {
  timestampMs: number;
  createdAtMs: number;
  action: DashboardSignal["action"];
  pnl: number | null;
  premium: number | null;
  slippage: number | null;
  fillLatencyMs: number | null;
}

function hasRealVenueFillId(value: string | null | undefined): boolean {
  return typeof value === "string" && value.length > 0 && !value.toLowerCase().startsWith("dry-run");
}

function matchingPositiveFillCounts(signal: DashboardSignal): boolean {
  const kalshiCount = signal.kalshiFillCount ?? 0;
  const polymarketCount = signal.polymarketFillCount ?? 0;
  return kalshiCount > 0 && polymarketCount > 0 && Math.abs(kalshiCount - polymarketCount) <= EPSILON;
}

export function isExactLiveFilledSignal(signal: DashboardSignal): boolean {
  return signal.action === "filled"
    && typeof signal.executionGroupId === "string"
    && signal.executionGroupId.length > 0
    && hasRealVenueFillId(signal.kalshiFillId)
    && hasRealVenueFillId(signal.polymarketFillId)
    && matchingPositiveFillCounts(signal)
    && signal.partialFill !== true;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function startOfUtcHour(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours());
}

function startOfUtcDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcWeek(timestampMs: number): number {
  const dayStart = startOfUtcDay(timestampMs);
  const day = new Date(dayStart).getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return dayStart - daysSinceMonday * DAY_MS;
}

function windowStart(definition: WindowDefinition, now: number): number {
  return definition.align(now) - (definition.bucketCount - 1) * definition.bucketMs;
}

export function oldestAnalyticsSinceMs(now = Date.now()): number {
  return Math.min(...Object.values(WINDOWS).map((definition) => windowStart(definition, now)));
}

export function estimatedGuaranteedPnl(signal: DashboardSignal): number | null {
  if (!isExactLiveFilledSignal(signal)) return null;
  const fillPremium = signal.kalshiFillPrice != null && signal.polymarketFillPrice != null
    ? signal.kalshiFillPrice + signal.polymarketFillPrice
    : signal.premium;
  if (!Number.isFinite(fillPremium)) return null;
  return roundMetric(1 - fillPremium);
}

function signalTrade(signal: DashboardSignal): AnalyticsTrade | null {
  if (!isExactLiveFilledSignal(signal)) return null;
  const timestampMs = new Date(signal.updatedAt).getTime();
  const createdAtMs = new Date(signal.createdAt).getTime();
  if (!Number.isFinite(timestampMs)) return null;
  const fillPremium = signal.kalshiFillPrice != null && signal.polymarketFillPrice != null
    ? roundMetric(signal.kalshiFillPrice + signal.polymarketFillPrice)
    : signal.action === "filled" ? signal.premium : null;
  const askPremium = Number.isFinite(signal.lower.ask + signal.higher.ask) ? roundMetric(signal.lower.ask + signal.higher.ask) : signal.premium;
  return {
    timestampMs,
    createdAtMs,
    action: signal.action,
    pnl: estimatedGuaranteedPnl(signal),
    premium: fillPremium,
    slippage: fillPremium == null ? null : roundMetric(fillPremium - askPremium),
    fillLatencyMs: signal.action === "filled" && Number.isFinite(createdAtMs) ? Math.max(0, timestampMs - createdAtMs) : null,
  };
}

function bucketLabel(window: AnalyticsWindow, startMs: number): string {
  const date = new Date(startMs);
  if (window === "hourly") {
    return date.toLocaleString("en-US", { hour: "2-digit", hour12: false });
  }
  if (window === "daily") {
    return date.toLocaleString("en-US", { month: "2-digit", day: "2-digit" });
  }
  return date.toLocaleString("en-US", { month: "2-digit", day: "2-digit" });
}

function emptyBuckets(definition: WindowDefinition, now: number): DashboardAnalyticsBucket[] {
  const startMs = windowStart(definition, now);
  return Array.from({ length: definition.bucketCount }, (_, index) => {
    const bucketStart = startMs + index * definition.bucketMs;
    return {
      startMs: bucketStart,
      endMs: bucketStart + definition.bucketMs,
      label: bucketLabel(definition.window, bucketStart),
      tradeCount: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      netPnl: 0,
      cumulativePnl: 0,
      grossProfit: 0,
      grossLoss: 0,
      avgPnl: null,
      avgSlippage: null,
      avgFillLatencyMs: null,
      drawdown: 0,
    };
  });
}

function sharpeRatio(pnls: number[]): number | null {
  if (pnls.length < 2) return null;
  const mean = pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length;
  const variance = pnls.reduce((sum, pnl) => sum + (pnl - mean) ** 2, 0) / (pnls.length - 1);
  const standardDeviation = Math.sqrt(variance);
  if (standardDeviation <= EPSILON) return null;
  return roundMetric((mean / standardDeviation) * Math.sqrt(pnls.length));
}

function average(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (numeric.length === 0) return null;
  return roundMetric(numeric.reduce((sum, value) => sum + value, 0) / numeric.length);
}

function distributionBucket(label: string, values: number[], predicate: (value: number) => boolean, min: number | null, max: number | null): DashboardAnalyticsDistributionBucket {
  return {
    label,
    min,
    max,
    count: values.filter(predicate).length,
  };
}

function pnlDistribution(pnls: number[]): DashboardAnalyticsDistributionBucket[] {
  return [
    distributionBucket("Loss", pnls, (value) => value < -EPSILON, null, 0),
    distributionBucket("Breakeven", pnls, (value) => Math.abs(value) <= EPSILON, 0, 0),
    distributionBucket("0-5c", pnls, (value) => value > EPSILON && value < 0.05 - EPSILON, 0, 0.05),
    distributionBucket("5-10c", pnls, (value) => value >= 0.05 - EPSILON && value < 0.1 - EPSILON, 0.05, 0.1),
    distributionBucket("10c+", pnls, (value) => value >= 0.1 - EPSILON, 0.1, null),
  ];
}

function slippageDistribution(slippages: number[]): DashboardAnalyticsDistributionBucket[] {
  return [
    distributionBucket("<=0c", slippages, (value) => value <= EPSILON, null, 0),
    distributionBucket("0-1c", slippages, (value) => value > EPSILON && value < 0.01 - EPSILON, 0, 0.01),
    distributionBucket("1-2c", slippages, (value) => value >= 0.01 - EPSILON && value < 0.02 - EPSILON, 0.01, 0.02),
    distributionBucket("2-3c", slippages, (value) => value >= 0.02 - EPSILON && value < 0.03 - EPSILON, 0.02, 0.03),
    distributionBucket("3c+", slippages, (value) => value >= 0.03 - EPSILON, 0.03, null),
  ];
}

export function buildAnalyticsWindow(
  signals: DashboardSignal[],
  window: AnalyticsWindow,
  now = Date.now(),
): DashboardAnalyticsWindow {
  const definition = WINDOWS[window];
  const buckets = emptyBuckets(definition, now);
  const sinceMs = buckets[0]?.startMs ?? now;
  const endMs = sinceMs + definition.bucketCount * definition.bucketMs;
  const trades = signals
    .map(signalTrade)
    .filter((trade): trade is AnalyticsTrade => trade != null && trade.timestampMs >= sinceMs && trade.timestampMs < endMs);
  const filledTradesForWindow = trades.filter((trade) => trade.action === "filled" && trade.pnl != null);

  for (const trade of trades) {
    const bucketIndex = Math.floor((trade.timestampMs - sinceMs) / definition.bucketMs);
    const bucket = buckets[bucketIndex];
    if (!bucket) continue;
    if (trade.action !== "filled" || trade.pnl == null) continue;
    bucket.tradeCount += 1;
    if (trade.pnl > EPSILON) {
      bucket.wins += 1;
      bucket.grossProfit = roundMetric(bucket.grossProfit + trade.pnl);
    } else if (trade.pnl < -EPSILON) {
      bucket.losses += 1;
      bucket.grossLoss = roundMetric(bucket.grossLoss + trade.pnl);
    } else {
      bucket.breakevens += 1;
    }
    bucket.netPnl = roundMetric(bucket.netPnl + trade.pnl);
  }

  let cumulativePnl = 0;
  let peakPnl = 0;
  let maxDrawdown = 0;
  for (const bucket of buckets) {
    cumulativePnl = roundMetric(cumulativePnl + bucket.netPnl);
    bucket.cumulativePnl = cumulativePnl;
    peakPnl = Math.max(peakPnl, cumulativePnl);
    bucket.drawdown = roundMetric(Math.max(0, peakPnl - cumulativePnl));
    maxDrawdown = Math.max(maxDrawdown, bucket.drawdown);
    bucket.avgPnl = bucket.tradeCount === 0 ? null : roundMetric(bucket.netPnl / bucket.tradeCount);
    const bucketTrades = filledTradesForWindow.filter((trade) => trade.timestampMs >= bucket.startMs && trade.timestampMs < bucket.endMs);
    bucket.avgSlippage = average(bucketTrades.map((trade) => trade.slippage));
    bucket.avgFillLatencyMs = average(bucketTrades.map((trade) => trade.fillLatencyMs));
  }

  const pnls = filledTradesForWindow.map((trade) => trade.pnl as number);
  const grossProfit = roundMetric(pnls.filter((pnl) => pnl > EPSILON).reduce((sum, pnl) => sum + pnl, 0));
  const grossLoss = roundMetric(pnls.filter((pnl) => pnl < -EPSILON).reduce((sum, pnl) => sum + pnl, 0));
  const tradesWon = pnls.filter((pnl) => pnl > EPSILON).length;
  const tradesLost = pnls.filter((pnl) => pnl < -EPSILON).length;
  const filledTrades = pnls.length;
  const netPnl = roundMetric(pnls.reduce((sum, pnl) => sum + pnl, 0));
  const opportunityCount = trades.length;
  const heatmap: DashboardAnalyticsHeatmapCell[] = buckets.map((bucket) => ({
    label: bucket.label,
    startMs: bucket.startMs,
    tradeCount: bucket.tradeCount,
    netPnl: bucket.netPnl,
    winRate: bucket.tradeCount === 0 ? 0 : roundMetric(bucket.wins / bucket.tradeCount),
  }));
  const fillLatencySeries: DashboardAnalyticsHeatmapCell[] = buckets.map((bucket) => ({
    label: bucket.label,
    startMs: bucket.startMs,
    tradeCount: bucket.tradeCount,
    netPnl: bucket.avgFillLatencyMs ?? 0,
    winRate: bucket.avgFillLatencyMs ?? 0,
  }));

  return {
    window,
    label: definition.label,
    generatedAt: now,
    sinceMs,
    bucketMs: definition.bucketMs,
    filledTrades,
    tradesWon,
    tradesLost,
    breakevenTrades: filledTrades - tradesWon - tradesLost,
    winRate: filledTrades === 0 ? 0 : roundMetric(tradesWon / filledTrades),
    lossRate: filledTrades === 0 ? 0 : roundMetric(tradesLost / filledTrades),
    grossProfit,
    grossLoss,
    netPnl,
    profitFactor: grossLoss < -EPSILON ? roundMetric(grossProfit / Math.abs(grossLoss)) : null,
    sharpeRatio: sharpeRatio(pnls),
    averagePnl: filledTrades === 0 ? null : roundMetric(netPnl / filledTrades),
    bestTradePnl: filledTrades === 0 ? null : roundMetric(Math.max(...pnls)),
    worstTradePnl: filledTrades === 0 ? null : roundMetric(Math.min(...pnls)),
    maxDrawdown: roundMetric(maxDrawdown),
    avgPremium: average(filledTradesForWindow.map((trade) => trade.premium)),
    avgSlippage: average(filledTradesForWindow.map((trade) => trade.slippage)),
    avgFillLatencyMs: average(filledTradesForWindow.map((trade) => trade.fillLatencyMs)),
    opportunityCount,
    fillRate: opportunityCount === 0 ? 0 : roundMetric(filledTrades / opportunityCount),
    pnlDistribution: pnlDistribution(pnls),
    slippageDistribution: slippageDistribution(filledTradesForWindow.map((trade) => trade.slippage).filter((value): value is number => value != null)),
    fillLatencySeries,
    heatmap,
    buckets,
  };
}

export function buildDashboardAnalytics(signals: DashboardSignal[], now = Date.now(), realtime?: DashboardAnalyticsRealtime): DashboardAnalytics {
  return {
    hourly: buildAnalyticsWindow(signals, "hourly", now),
    daily: buildAnalyticsWindow(signals, "daily", now),
    weekly: buildAnalyticsWindow(signals, "weekly", now),
    realtime,
  };
}
