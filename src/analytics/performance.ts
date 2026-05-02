import type { AnalyticsWindow, DashboardAnalytics, DashboardAnalyticsBucket, DashboardAnalyticsWindow, DashboardSignal } from "../types";

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
  pnl: number;
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
  if (signal.action !== "filled") return null;
  const fillPremium = signal.kalshiFillPrice != null && signal.polymarketFillPrice != null
    ? signal.kalshiFillPrice + signal.polymarketFillPrice
    : signal.premium;
  if (!Number.isFinite(fillPremium)) return null;
  return roundMetric(1 - fillPremium);
}

function signalTrade(signal: DashboardSignal): AnalyticsTrade | null {
  const timestampMs = new Date(signal.updatedAt).getTime();
  const pnl = estimatedGuaranteedPnl(signal);
  if (!Number.isFinite(timestampMs) || pnl == null) return null;
  return { timestampMs, pnl };
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
      netPnl: 0,
      cumulativePnl: 0,
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

  for (const trade of trades) {
    const bucketIndex = Math.floor((trade.timestampMs - sinceMs) / definition.bucketMs);
    const bucket = buckets[bucketIndex];
    if (!bucket) continue;
    bucket.tradeCount += 1;
    bucket.netPnl = roundMetric(bucket.netPnl + trade.pnl);
  }

  let cumulativePnl = 0;
  for (const bucket of buckets) {
    cumulativePnl = roundMetric(cumulativePnl + bucket.netPnl);
    bucket.cumulativePnl = cumulativePnl;
  }

  const pnls = trades.map((trade) => trade.pnl);
  const grossProfit = roundMetric(pnls.filter((pnl) => pnl > EPSILON).reduce((sum, pnl) => sum + pnl, 0));
  const grossLoss = roundMetric(pnls.filter((pnl) => pnl < -EPSILON).reduce((sum, pnl) => sum + pnl, 0));
  const tradesWon = pnls.filter((pnl) => pnl > EPSILON).length;
  const tradesLost = pnls.filter((pnl) => pnl < -EPSILON).length;
  const filledTrades = pnls.length;
  const netPnl = roundMetric(pnls.reduce((sum, pnl) => sum + pnl, 0));

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
    buckets,
  };
}

export function buildDashboardAnalytics(signals: DashboardSignal[], now = Date.now()): DashboardAnalytics {
  return {
    hourly: buildAnalyticsWindow(signals, "hourly", now),
    daily: buildAnalyticsWindow(signals, "daily", now),
    weekly: buildAnalyticsWindow(signals, "weekly", now),
  };
}
