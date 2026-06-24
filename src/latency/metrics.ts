import type { AppConfig } from "../config";
import type { BinaryContract, DashboardLatencySnapshot, DashboardLatencyStats, Venue } from "../types";

type VenueSamples = Record<Venue, RollingSamples>;

function percentile(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? null;
}

function roundMs(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;
}

export function summarizeLatencySamples(samples: number[], latestOverride?: number | null): DashboardLatencyStats {
  const numeric = samples.filter((sample) => Number.isFinite(sample) && sample >= 0);
  const sorted = [...numeric].sort((left, right) => left - right);
  const latest = latestOverride === undefined ? (numeric.at(-1) ?? null) : latestOverride;
  return {
    latestMs: roundMs(latest ?? null),
    p50Ms: roundMs(percentile(sorted, 50)),
    p95Ms: roundMs(percentile(sorted, 95)),
    sampleCount: numeric.length,
  };
}

export function summarizeBookAges(contracts: BinaryContract[], now: number): DashboardLatencyStats {
  const ages = contracts.map((contract) => Math.max(0, now - contract.updatedAt));
  const freshest = ages.length > 0 ? Math.min(...ages) : null;
  return summarizeLatencySamples(ages, freshest);
}

class RollingSamples {
  private readonly samples: number[] = [];

  constructor(private readonly maxSamples = 240) {}

  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.samples.push(value);
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
  }

  snapshot(latestOverride?: number | null): DashboardLatencyStats {
    return summarizeLatencySamples(this.samples, latestOverride);
  }
}

export class LatencyMonitor {
  private readonly wsToBookApply: VenueSamples = {
    kalshi: new RollingSamples(),
    polymarket: new RollingSamples(),
  };
  private readonly scanDuration = new RollingSamples();
  private readonly bookUpdateToDecision = new RollingSamples();
  private readonly dbInsert = new RollingSamples();
  private readonly dbUpdate = new RollingSamples();
  private readonly preSubmitDb = new RollingSamples();
  private readonly execution = new RollingSamples();
  private readonly hotGate = new RollingSamples();
  private readonly snapshotBuild = new RollingSamples();
  private queueDepth = 0;
  private activeExecutions = 0;
  private coalescedScanCount = 0;
  private duplicateCandidateSkips = 0;
  private lastScanStartedAt: number | null = null;
  private lastScanCompletedAt: number | null = null;

  recordWsToBookApply(venue: Venue, receivedAt: number, appliedAt = Date.now()): void {
    this.wsToBookApply[venue].add(Math.max(0, appliedAt - receivedAt));
  }

  recordScanStarted(at = Date.now()): void {
    this.lastScanStartedAt = at;
  }

  recordScanDuration(durationMs: number, completedAt = Date.now()): void {
    this.scanDuration.add(durationMs);
    this.lastScanCompletedAt = completedAt;
  }

  recordBookUpdateToDecision(durationMs: number): void {
    this.bookUpdateToDecision.add(durationMs);
  }

  recordDbInsert(durationMs: number): void {
    this.dbInsert.add(durationMs);
  }

  recordDbUpdate(durationMs: number): void {
    this.dbUpdate.add(durationMs);
  }

  recordPreSubmitDb(durationMs: number): void {
    this.preSubmitDb.add(durationMs);
  }

  recordExecution(durationMs: number): void {
    this.execution.add(durationMs);
  }

  recordHotGate(durationMs: number): void {
    this.hotGate.add(durationMs);
  }

  recordSnapshotBuild(durationMs: number): void {
    this.snapshotBuild.add(durationMs);
  }

  recordQueueState(queueDepth: number, activeExecutions: number): void {
    this.queueDepth = Math.max(0, queueDepth);
    this.activeExecutions = Math.max(0, activeExecutions);
  }

  recordCoalescedScan(): void {
    this.coalescedScanCount += 1;
  }

  recordDuplicateCandidateSkip(): void {
    this.duplicateCandidateSkips += 1;
  }

  snapshot(
    books: { kalshi: BinaryContract[]; polymarket: BinaryContract[] },
    now: number,
    config: Pick<AppConfig, "dashboardStreamIntervalMs" | "dashboardSignalRefreshMs" | "dashboardAnalyticsRefreshMs">,
    snapshotBuildMs?: number,
  ): DashboardLatencySnapshot {
    if (snapshotBuildMs != null) this.recordSnapshotBuild(snapshotBuildMs);
    return {
      generatedAt: now,
      books: {
        kalshi: summarizeBookAges(books.kalshi, now),
        polymarket: summarizeBookAges(books.polymarket, now),
      },
      wsToBookApplyMs: {
        kalshi: this.wsToBookApply.kalshi.snapshot(),
        polymarket: this.wsToBookApply.polymarket.snapshot(),
      },
      scanner: {
        scanDurationMs: this.scanDuration.snapshot(),
        bookUpdateToDecisionMs: this.bookUpdateToDecision.snapshot(),
        queueDepth: this.queueDepth,
        activeExecutions: this.activeExecutions,
        lastScanStartedAt: this.lastScanStartedAt,
        lastScanCompletedAt: this.lastScanCompletedAt,
        coalescedScanCount: this.coalescedScanCount,
        duplicateCandidateSkips: this.duplicateCandidateSkips,
      },
      persistence: {
        insertMs: this.dbInsert.snapshot(),
        updateMs: this.dbUpdate.snapshot(),
        preSubmitDbMs: this.preSubmitDb.snapshot(),
      },
      execution: {
        durationMs: this.execution.snapshot(),
        hotGateMs: this.hotGate.snapshot(),
      },
      dashboard: {
        snapshotBuildMs: this.snapshotBuild.snapshot(snapshotBuildMs ?? null),
        streamIntervalMs: config.dashboardStreamIntervalMs,
        signalRefreshMs: config.dashboardSignalRefreshMs,
        analyticsRefreshMs: config.dashboardAnalyticsRefreshMs,
        snapshotAgeMs: 0,
      },
    };
  }
}
