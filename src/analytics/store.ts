import { buildDashboardAnalytics, oldestAnalyticsSinceMs } from "./performance";
import type { DashboardAnalytics, DashboardSignal } from "../types";

export interface AnalyticsStoreSnapshotOptions {
  mode?: "hot_cache" | "fallback_db";
  staleAfterMs?: number;
}

function timestampMs(value: string): number | null {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export class AnalyticsStore {
  private readonly signals = new Map<number, DashboardSignal>();
  private lastUpdatedAt: number | null = null;
  private lastDbReconciledAt: number | null = null;

  constructor(private readonly maxSignals = 10_000) {}

  reconcileFilledSignals(signals: DashboardSignal[], reconciledAt = Date.now()): void {
    for (const signal of signals) this.recordSignal(signal, reconciledAt);
    this.lastDbReconciledAt = reconciledAt;
    this.prune(reconciledAt);
  }

  recordSignal(signal: DashboardSignal, observedAt = Date.now()): void {
    this.signals.set(signal.id, signal);
    const updatedAt = timestampMs(signal.updatedAt);
    this.lastUpdatedAt = Math.max(this.lastUpdatedAt ?? 0, updatedAt ?? observedAt);
    this.prune(observedAt);
  }

  snapshot(now = Date.now(), options: AnalyticsStoreSnapshotOptions = {}): DashboardAnalytics {
    const startedAt = Date.now();
    this.prune(now);
    const staleAfterMs = options.staleAfterMs ?? 60_000;
    const realtime = {
      mode: options.mode ?? "hot_cache" as const,
      lastUpdatedAt: this.lastUpdatedAt,
      lastDbReconciledAt: this.lastDbReconciledAt,
      computeMs: 0,
      sourceSignalCount: this.signals.size,
      stale: this.lastDbReconciledAt == null || now - this.lastDbReconciledAt > staleAfterMs,
    };
    const analytics = buildDashboardAnalytics([...this.signals.values()], now, realtime);
    analytics.realtime!.computeMs = Math.max(0, Date.now() - startedAt);
    return analytics;
  }

  private prune(now: number): void {
    const oldest = oldestAnalyticsSinceMs(now);
    for (const [id, signal] of this.signals) {
      const updatedAt = timestampMs(signal.updatedAt);
      if (updatedAt != null && updatedAt < oldest) this.signals.delete(id);
    }
    if (this.signals.size <= this.maxSignals) return;
    const sorted = [...this.signals.values()]
      .sort((left, right) => (timestampMs(right.updatedAt) ?? 0) - (timestampMs(left.updatedAt) ?? 0))
      .slice(0, this.maxSignals);
    this.signals.clear();
    for (const signal of sorted) this.signals.set(signal.id, signal);
  }
}
