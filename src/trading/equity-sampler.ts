import type { TradingActivitySnapshot } from "../../types/trading";
import type { PortfolioEquitySampleInput, PortfolioEquityStore } from "../db/portfolio-equity";
import { logEvent } from "../logger";

const DEFAULT_MIN_INTERVAL_MS = 60_000;
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const PRUNE_EVERY_N = 60; // at ~60s cadence, prune about once per hour

/**
 * Combined portfolio equity sample from a trading-activity snapshot. Combined value sums each
 * venue's portfolioValue (cash + mark-to-market positions) — the same fields the dashboard's
 * accountEquity() selector uses. Null-tolerant; returns null only when neither venue reported.
 */
export function buildEquitySample(activity: TradingActivitySnapshot, now: number): PortfolioEquitySampleInput | null {
  const k = activity.kalshi?.portfolio;
  const p = activity.polymarket?.portfolio;
  const kv = k?.portfolioValue ?? null;
  const pv = p?.portfolioValue ?? null;
  if (kv == null && pv == null) return null;
  return {
    sampledAtMs: now,
    kalshiValue: kv,
    polymarketValue: pv,
    combinedValue: (kv ?? 0) + (pv ?? 0),
    kalshiCash: k?.cashValue ?? null,
    polymarketCash: p?.cashValue ?? null,
    source: "sampled",
  };
}

/**
 * Throttled, failure-isolated equity sampler. Dashboard-only: it writes to
 * portfolio_equity_snapshots (which the trading path never reads) and can NEVER throw upward —
 * a failure is logged as a WARN and swallowed. Fed from cached trading-activity, so it adds
 * zero venue calls.
 */
export class EquitySampler {
  private lastSampledAtMs = 0;
  private sampleCount = 0;

  constructor(
    private readonly store: PortfolioEquityStore,
    private readonly minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS,
    private readonly retentionMs: number = DEFAULT_RETENTION_MS,
  ) {}

  /** Record a point if at least `minIntervalMs` has elapsed since the last one. Never throws. */
  maybeSample(activity: TradingActivitySnapshot | null | undefined, now: number): void {
    void this.maybeSampleAsync(activity, now);
  }

  private async maybeSampleAsync(activity: TradingActivitySnapshot | null | undefined, now: number): Promise<void> {
    try {
      if (!activity) return;
      if (now - this.lastSampledAtMs < this.minIntervalMs) return;
      const sample = buildEquitySample(activity, now);
      if (!sample) return;
      this.lastSampledAtMs = now;
      await this.store.record(sample);
      this.sampleCount += 1;
      if (this.sampleCount % PRUNE_EVERY_N === 0) {
        await this.store.prune(now - this.retentionMs);
      }
    } catch (error) {
      logEvent({
        severity: "WARN",
        category: "DB",
        message: "equity sample failed",
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
