import type { LiveExecutionLock, Venue, VenueConfirmations, DashboardSignal, ArbCandidate } from "../types";
import type { LiveExecutionLockInput, LiveExecutionLockWriter } from "../db/live-execution-locks";
import {
  buildLiveExecutionQualityStatus,
  liveExecutionQualityBlockReason,
  type LiveExecutionQualityOptions,
} from "./execution-quality";

export interface LiveExposureSignalReader {
  listLiveExposureSignals(now: number, limit?: number): Promise<DashboardSignal[]>;
  listLiveSubmittedAttemptSignals?(now: number, limit?: number): Promise<DashboardSignal[]>;
  listLiveExactExposureSignals?(limit?: number): Promise<DashboardSignal[]>;
  listLiveExecutionQualitySignals?(now: number, lookbackMs: number, limit?: number): Promise<DashboardSignal[]>;
  unresolvedRiskQuarantineExposureDollars?(): Promise<number>;
  liveRiskQuarantineStatus?(): Promise<{ total: number; count: number }>;
}

function confirmedByUserStream(confirmations: VenueConfirmations | null | undefined, venue: Venue): boolean {
  const value = confirmations?.[venue];
  if (!value || typeof value !== "object") return false;
  const status = String((value as Record<string, unknown>).status ?? "").toLowerCase();
  return ["confirmed", "matched", "filled"].includes(status);
}

function hasLiveExposure(signal: DashboardSignal): boolean {
  return (
    Boolean(signal.executionGroupId) &&
    signal.reconciliationResolvedAt == null &&
    (signal.action === "filled" ||
      signal.partialFill === true ||
      (signal.kalshiFillCount ?? 0) > 0 ||
      (signal.polymarketFillCount ?? 0) > 0 ||
      ["unknown", "unexpected_fill_count"].includes(signal.kalshiStatus ?? "") ||
      ["unknown", "unexpected_fill_count"].includes(signal.polymarketStatus ?? ""))
  );
}

function isSubmittedLiveAttempt(signal: DashboardSignal): boolean {
  return Boolean(signal.executionGroupId) && (signal.action === "filled" || signal.action === "failed");
}

function riskQuarantined(signal: DashboardSignal): boolean {
  return signal.riskQuarantinedAt != null;
}

function riskQuarantineExposure(signal: DashboardSignal): number {
  const exposure = signal.riskQuarantineExposureDollars ?? 0;
  return Number.isFinite(exposure) && exposure > 0 ? exposure : 0;
}

function hasExactExposureProblem(signal: DashboardSignal): boolean {
  if (!signal.executionGroupId || signal.reconciliationResolvedAt != null) return false;
  const kalshiCount = signal.kalshiFillCount ?? 0;
  const polymarketCount = signal.polymarketFillCount ?? 0;
  const hasMismatch = Math.abs(kalshiCount - polymarketCount) > 0.000001;
  return (
    signal.riskQuarantinedAt != null ||
    signal.partialFill === true ||
    hasMismatch ||
    ["unknown", "unexpected_fill_count"].includes(signal.kalshiStatus ?? "") ||
    ["unknown", "unexpected_fill_count"].includes(signal.polymarketStatus ?? "")
  );
}

function exactExposureReason(signals: DashboardSignal[]): string | null {
  const signal = signals.find(hasExactExposureProblem);
  if (!signal) return null;
  const kalshiCount = signal.kalshiFillCount ?? 0;
  const polymarketCount = signal.polymarketFillCount ?? 0;
  if (signal.riskQuarantinedAt != null) {
    return `live exact-exposure guard blocked: signal #${signal.id} has unresolved quarantined exposure`;
  }
  if (signal.partialFill) return `live exact-exposure guard blocked: signal #${signal.id} is marked partial_fill`;
  if (Math.abs(kalshiCount - polymarketCount) > 0.000001) {
    return `live exact-exposure guard blocked: signal #${signal.id} fill mismatch kalshi=${kalshiCount} polymarket=${polymarketCount}`;
  }
  return `live exact-exposure guard blocked: signal #${signal.id} has unresolved venue status`;
}

function quarantineStatus(signals: DashboardSignal[]): { total: number; count: number } {
  const quarantined = signals.filter((signal) => hasLiveExposure(signal) && riskQuarantined(signal));
  return {
    total: quarantined.reduce((sum, signal) => sum + riskQuarantineExposure(signal), 0),
    count: quarantined.length,
  };
}

function liveLegKeys(candidate: ArbCandidate): string[] {
  return [
    `${candidate.lower.venue}:${candidate.lower.contractId}:${candidate.lower.direction}`,
    `${candidate.higher.venue}:${candidate.higher.contractId}:${candidate.higher.direction}`,
    `kalshi:${candidate.kalshiContractId}`,
    `polymarket:${candidate.polymarketContractId}`,
  ];
}

function signalLegKeys(signal: DashboardSignal): string[] {
  return [
    `${signal.lower.venue}:${signal.lower.contractId}:${signal.lower.direction}`,
    `${signal.higher.venue}:${signal.higher.contractId}:${signal.higher.direction}`,
    `kalshi:${signal.kalshiContractId}`,
    `polymarket:${signal.polymarketContractId}`,
  ];
}

export class CachedLiveExecutionLockStore implements LiveExecutionLockWriter {
  private cached: LiveExecutionLock | null = null;
  private refreshedAt: number | null = null;
  private refreshInFlight: Promise<void> | null = null;

  constructor(
    private readonly delegate: LiveExecutionLockWriter,
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
    // H1: grace beyond maxAgeMs during which a stale cache serves last-good (+ background refresh) instead of
    // synthesizing a breaker that halts trading. Default 0 = strict synthesize-on-stale (byte-identical).
    private readonly graceMs: number = 0,
  ) {}

  async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      this.cached = await this.delegate.getActiveLock();
      this.refreshedAt = this.now();
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  get status(): { cached: boolean; refreshedAt: number | null; stale: boolean } {
    const age = this.refreshedAt == null ? Number.POSITIVE_INFINITY : this.now() - this.refreshedAt;
    return { cached: this.refreshedAt != null, refreshedAt: this.refreshedAt, stale: age > this.maxAgeMs };
  }

  private staleLock(reason: string): LiveExecutionLock {
    return {
      id: -2,
      createdAt: new Date(this.now()).toISOString(),
      reason,
      severity: "critical",
      sourceSignalId: null,
      executionGroupId: null,
      details: { hotPathCache: "live_execution_locks" },
      clearedAt: null,
      clearReason: null,
    };
  }

  async getActiveLock(): Promise<LiveExecutionLock | null> {
    // Never hydrated -> fail-safe block (no last-good to serve).
    if (this.refreshedAt == null) {
      return this.staleLock("live hot-path lock cache has not been hydrated");
    }
    const age = this.now() - this.refreshedAt;
    if (age <= this.maxAgeMs) return this.cached;
    // H1: within the grace ceiling, serve the LAST-GOOD lock state + kick a background refresh instead of
    // synthesizing a breaker that halts ALL scanning. Self-engaged locks update the cache synchronously
    // (single-worker-per-DB), so last-good is safe: a prior lock keeps blocking, "no lock" keeps trading.
    if (age <= this.maxAgeMs + this.graceMs) {
      void this.refresh().catch(() => undefined);
      return this.cached;
    }
    // Beyond max-age + grace the cache is presumed broken -> fail-safe block.
    return this.staleLock(`live hot-path lock cache is stale: age ${age}ms exceeds ${this.maxAgeMs + this.graceMs}ms`);
  }

  async engageLock(input: LiveExecutionLockInput): Promise<LiveExecutionLock> {
    if (this.cached) return this.cached;
    this.cached = {
      id: -1,
      createdAt: new Date(this.now()).toISOString(),
      reason: input.reason,
      severity: input.severity ?? "critical",
      sourceSignalId: input.sourceSignalId ?? null,
      executionGroupId: input.executionGroupId ?? null,
      details: input.details ?? {},
      clearedAt: null,
      clearReason: null,
    };
    this.refreshedAt = this.now();
    const persisted = await this.delegate.engageLock(input);
    this.cached = persisted;
    this.refreshedAt = this.now();
    return persisted;
  }
}

export class LiveExposureCache {
  private static readonly exposureRefreshLimit = 100;
  private static readonly submittedAttemptRefreshLimit = 100;
  private static readonly exactExposureRefreshLimit = 100;
  private static readonly executionQualityRefreshLimit = 100;

  private signals: DashboardSignal[] = [];
  private exactExposureSignals: DashboardSignal[] = [];
  private executionQualitySignals: DashboardSignal[] = [];
  private submittedAttemptExpiriesBySignalId = new Map<number, number>();
  private refreshedAt: number | null = null;
  private refreshInFlight: Promise<void> | null = null;

  constructor(
    private readonly reader: LiveExposureSignalReader,
    private readonly maxAgeMs: number,
    private readonly maxUnresolvedExposureDollars: number,
    private readonly now: () => number = Date.now,
  ) {}

  async refresh(now = this.now()): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const [signals, submittedAttempts, exactExposureSignals, executionQualitySignals] = await Promise.all([
        this.reader.listLiveExposureSignals(now, LiveExposureCache.exposureRefreshLimit),
        this.reader.listLiveSubmittedAttemptSignals?.(now, LiveExposureCache.submittedAttemptRefreshLimit) ??
          Promise.resolve([]),
        this.reader.listLiveExactExposureSignals?.(LiveExposureCache.exactExposureRefreshLimit) ?? Promise.resolve([]),
        this.reader.listLiveExecutionQualitySignals?.(
          now,
          24 * 60 * 60 * 1_000,
          LiveExposureCache.executionQualityRefreshLimit,
        ) ?? Promise.resolve([]),
      ]);
      this.signals = signals.filter(hasLiveExposure);
      this.exactExposureSignals = exactExposureSignals.filter(hasExactExposureProblem);
      this.executionQualitySignals = executionQualitySignals;
      this.submittedAttemptExpiriesBySignalId = new Map(
        submittedAttempts.filter(isSubmittedLiveAttempt).map((signal) => [signal.id, signal.expiryMs]),
      );
      this.refreshedAt = this.now();
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  observeSignal(signal: DashboardSignal): void {
    this.signals = this.signals.filter((existing) => existing.id !== signal.id);
    this.exactExposureSignals = this.exactExposureSignals.filter((existing) => existing.id !== signal.id);
    this.executionQualitySignals = this.executionQualitySignals.filter((existing) => existing.id !== signal.id);
    if (hasLiveExposure(signal)) this.signals.unshift(signal);
    if (hasExactExposureProblem(signal)) this.exactExposureSignals.unshift(signal);
    if (isSubmittedLiveAttempt(signal)) this.executionQualitySignals.unshift(signal);
    this.submittedAttemptExpiriesBySignalId.delete(signal.id);
    if (isSubmittedLiveAttempt(signal)) this.submittedAttemptExpiriesBySignalId.set(signal.id, signal.expiryMs);
    this.refreshedAt = this.now();
  }

  status(): {
    ready: boolean;
    refreshedAt: number | null;
    ageMs: number | null;
    cachedSignals: number;
    reason: string | null;
  } {
    const ageMs = this.refreshedAt == null ? null : Math.max(0, this.now() - this.refreshedAt);
    const stale = ageMs == null || ageMs > this.maxAgeMs;
    return {
      ready: !stale,
      refreshedAt: this.refreshedAt,
      ageMs,
      cachedSignals: this.signals.length,
      reason: stale
        ? `live hot-path exposure cache is stale: age ${ageMs ?? "unknown"}ms exceeds ${this.maxAgeMs}ms`
        : null,
    };
  }

  private async ensureFresh(now = this.now()): Promise<string | null> {
    const ageMs = this.refreshedAt == null ? Number.POSITIVE_INFINITY : Math.max(0, now - this.refreshedAt);
    if (ageMs <= this.maxAgeMs) return null;
    // LA2: within a SOFT-stale window, serve last-good data and kick a BACKGROUND refresh so the hot path
    // never blocks on a cold multi-query DB refresh (the source of the multi-second / 27s submit stalls when
    // the pg pool is contended by an in-flight scan). A HARD ceiling (3x maxAge) still forces a synchronous
    // refresh + block, so exposure / quarantine / exact-exposure / execution-quality decisions are never made
    // on dangerously old data. observeSignal() updates the cache synchronously after every fill, so the bot's
    // own freshly-created exposure is always reflected immediately regardless of this soft window.
    const hardMaxAgeMs = Math.max(this.maxAgeMs * 3, this.maxAgeMs + 5_000);
    if (this.refreshedAt != null && ageMs <= hardMaxAgeMs) {
      void this.refresh(now).catch(() => undefined);
      return null;
    }
    try {
      await this.refresh(now);
    } catch (error) {
      return `live hot-path exposure cache refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return this.status().reason;
  }

  async unresolvedRiskQuarantineExposureDollars(): Promise<number> {
    if (this.reader.unresolvedRiskQuarantineExposureDollars) {
      return this.reader.unresolvedRiskQuarantineExposureDollars();
    }
    return quarantineStatus(this.signals).total;
  }

  async liveRiskQuarantineStatus(): Promise<{ total: number; count: number }> {
    if (this.reader.liveRiskQuarantineStatus) {
      return this.reader.liveRiskQuarantineStatus();
    }
    return quarantineStatus(this.signals);
  }

  private quarantineBlockReason(): string | null {
    const status = quarantineStatus(this.signals);
    if (Number.isFinite(this.maxUnresolvedExposureDollars) && status.total > this.maxUnresolvedExposureDollars + 1e-9) {
      return `live unresolved quarantined exposure ${status.total.toFixed(2)} exceeds cap ${this.maxUnresolvedExposureDollars.toFixed(2)} across ${status.count} signals`;
    }
    return null;
  }

  async liveSubmittedAttemptBlockReason(
    candidate: ArbCandidate,
    now: number,
    maxTradesPerWindow: number,
  ): Promise<string | null> {
    const staleReason = await this.ensureFresh(now);
    if (staleReason) return staleReason;
    const maxTrades = Math.max(0, Math.floor(maxTradesPerWindow));
    const submittedAttempts = [...this.submittedAttemptExpiriesBySignalId.values()].filter(
      (expiryMs) => expiryMs === candidate.expiryMs && expiryMs > now,
    ).length;
    if (submittedAttempts >= maxTrades) {
      return `live submitted attempt limit reached for expiry ${candidate.expiryMs}: ${submittedAttempts}/${maxTrades}`;
    }
    return null;
  }

  async liveExactExposureBlockReason(_now?: number): Promise<string | null> {
    const staleReason = await this.ensureFresh(_now);
    if (staleReason) return staleReason;
    return exactExposureReason(this.exactExposureSignals);
  }

  async liveExecutionQualityStatus(now: number, options: LiveExecutionQualityOptions) {
    const staleReason = await this.ensureFresh(now);
    if (staleReason) {
      return {
        ...buildLiveExecutionQualityStatus([], null, options),
        ok: false,
        reason: `live execution quality blocked: ${staleReason}`,
      };
    }
    const since = now - Math.max(0, options.lookbackMs);
    const samples = this.executionQualitySignals
      .filter((signal) => {
        const createdAt = Date.parse(signal.createdAt);
        return Number.isFinite(createdAt) && createdAt >= since;
      })
      .slice(0, Math.max(1, Math.floor(options.sampleLimit)));
    return buildLiveExecutionQualityStatus(samples, null, options);
  }

  async listLiveExecutionQualitySignals(now: number, lookbackMs: number, limit = 50): Promise<DashboardSignal[]> {
    const staleReason = await this.ensureFresh(now);
    if (staleReason) return [];
    const since = now - Math.max(0, lookbackMs);
    return this.executionQualitySignals
      .filter((signal) => {
        const createdAt = Date.parse(signal.createdAt);
        return Number.isFinite(createdAt) && createdAt >= since;
      })
      .slice(0, Math.max(1, Math.floor(limit)));
  }

  async liveExecutionQualityBlockReason(
    candidate: ArbCandidate,
    now: number,
    options: LiveExecutionQualityOptions,
  ): Promise<string | null> {
    const staleReason = await this.ensureFresh(now);
    if (staleReason) return staleReason;
    const since = now - Math.max(0, options.lookbackMs);
    const samples = this.executionQualitySignals
      .filter((signal) => {
        const createdAt = Date.parse(signal.createdAt);
        return Number.isFinite(createdAt) && createdAt >= since;
      })
      .slice(0, Math.max(1, Math.floor(options.sampleLimit)));
    return liveExecutionQualityBlockReason(buildLiveExecutionQualityStatus(samples, candidate, options));
  }

  async liveExposureBlockReason(
    candidate: ArbCandidate,
    now: number,
    maxTradesPerWindow: number,
  ): Promise<string | null> {
    const staleReason = await this.ensureFresh(now);
    if (staleReason) return staleReason;
    const quarantineReason = this.quarantineBlockReason();
    if (quarantineReason) return quarantineReason;
    const exposed = this.signals.filter(
      (signal) =>
        !riskQuarantined(signal) &&
        signal.reconciliationResolvedAt == null &&
        signal.expiryMs === candidate.expiryMs &&
        signal.expiryMs > now,
    );
    const maxTrades = Math.max(0, Math.floor(maxTradesPerWindow));
    if (exposed.length >= maxTrades) {
      return `live max trades per window reached for expiry ${candidate.expiryMs}: ${exposed.length}/${maxTrades}`;
    }

    const candidateKeys = new Set(liveLegKeys(candidate));
    for (const signal of exposed) {
      if (signal.reconciliationResolvedAt != null) continue;
      for (const key of signalLegKeys(signal)) {
        if (candidateKeys.has(key)) return `live ${key} already has exposure in signal #${signal.id}`;
      }
    }
    return null;
  }

  async liveReconciliationBlockReason(candidate: ArbCandidate, now: number): Promise<string | null> {
    const staleReason = await this.ensureFresh(now);
    if (staleReason) return `live reconciliation blocked: ${staleReason}`;
    const quarantineReason = this.quarantineBlockReason();
    if (quarantineReason) return quarantineReason;
    const exposed = this.signals.filter(
      (signal) =>
        !riskQuarantined(signal) &&
        signal.reconciliationResolvedAt == null &&
        signal.expiryMs === candidate.expiryMs &&
        signal.expiryMs > now,
    );
    for (const signal of exposed) {
      if (signal.reconciliationResolvedAt != null) continue;
      const kalshiFillCount = signal.kalshiFillCount ?? 0;
      const polymarketFillCount = signal.polymarketFillCount ?? 0;
      const hasAnyFill = kalshiFillCount > 0 || polymarketFillCount > 0;
      if (signal.partialFill) return `live reconciliation blocked: signal #${signal.id} is marked partial_fill`;
      if (hasAnyFill && Math.abs(kalshiFillCount - polymarketFillCount) > 0.000001) {
        return `live reconciliation blocked: signal #${signal.id} fill mismatch kalshi=${kalshiFillCount} polymarket=${polymarketFillCount}`;
      }
      if (
        hasAnyFill &&
        (!confirmedByUserStream(signal.venueConfirmations, "kalshi") ||
          !confirmedByUserStream(signal.venueConfirmations, "polymarket"))
      ) {
        return `live reconciliation blocked: signal #${signal.id} has venue fills without private-stream confirmations`;
      }
      if (
        ["unknown", "unexpected_fill_count"].includes(signal.kalshiStatus ?? "") ||
        ["unknown", "unexpected_fill_count"].includes(signal.polymarketStatus ?? "")
      ) {
        return `live reconciliation blocked: signal #${signal.id} has unresolved venue status`;
      }
    }
    return null;
  }
}
