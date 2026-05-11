import type { LiveExecutionLock, Venue, VenueConfirmations, DashboardSignal, ArbCandidate } from "../types";
import type { LiveExecutionLockInput, LiveExecutionLockWriter } from "../db/live-execution-locks";

export interface LiveExposureSignalReader {
  listLiveExposureSignals(now: number, limit?: number): Promise<DashboardSignal[]>;
  unresolvedRiskQuarantineExposureDollars?(): Promise<number>;
}

function confirmedByUserStream(confirmations: VenueConfirmations | null | undefined, venue: Venue): boolean {
  const value = confirmations?.[venue];
  if (!value || typeof value !== "object") return false;
  const status = String((value as Record<string, unknown>).status ?? "").toLowerCase();
  return ["confirmed", "matched", "filled"].includes(status);
}

function hasLiveExposure(signal: DashboardSignal): boolean {
  return Boolean(signal.executionGroupId)
    && signal.reconciliationResolvedAt == null
    && (
      signal.action === "filled"
      || signal.partialFill === true
      || (signal.kalshiFillCount ?? 0) > 0
      || (signal.polymarketFillCount ?? 0) > 0
      || ["unknown", "unexpected_fill_count"].includes(signal.kalshiStatus ?? "")
      || ["unknown", "unexpected_fill_count"].includes(signal.polymarketStatus ?? "")
    );
}

function riskQuarantined(signal: DashboardSignal): boolean {
  return signal.riskQuarantinedAt != null;
}

function riskQuarantineExposure(signal: DashboardSignal): number {
  const exposure = signal.riskQuarantineExposureDollars ?? 0;
  return Number.isFinite(exposure) && exposure > 0 ? exposure : 0;
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

  async getActiveLock(): Promise<LiveExecutionLock | null> {
    if (this.refreshedAt == null || this.status.stale) {
      return {
        id: -2,
        createdAt: new Date(this.now()).toISOString(),
        reason: this.refreshedAt == null
          ? "live hot-path lock cache has not been hydrated"
          : `live hot-path lock cache is stale: age ${this.now() - this.refreshedAt}ms exceeds ${this.maxAgeMs}ms`,
        severity: "critical",
        sourceSignalId: null,
        executionGroupId: null,
        details: { hotPathCache: "live_execution_locks" },
        clearedAt: null,
        clearReason: null,
      };
    }
    return this.cached;
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
  private signals: DashboardSignal[] = [];
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
      this.signals = (await this.reader.listLiveExposureSignals(now)).filter(hasLiveExposure);
      this.refreshedAt = this.now();
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  observeSignal(signal: DashboardSignal): void {
    this.signals = this.signals.filter((existing) => existing.id !== signal.id);
    if (hasLiveExposure(signal)) this.signals.unshift(signal);
    this.refreshedAt = this.now();
  }

  status(): { ready: boolean; refreshedAt: number | null; ageMs: number | null; cachedSignals: number; reason: string | null } {
    const ageMs = this.refreshedAt == null ? null : Math.max(0, this.now() - this.refreshedAt);
    const stale = ageMs == null || ageMs > this.maxAgeMs;
    return {
      ready: !stale,
      refreshedAt: this.refreshedAt,
      ageMs,
      cachedSignals: this.signals.length,
      reason: stale ? `live hot-path exposure cache is stale: age ${ageMs ?? "unknown"}ms exceeds ${this.maxAgeMs}ms` : null,
    };
  }

  async unresolvedRiskQuarantineExposureDollars(): Promise<number> {
    return quarantineStatus(this.signals).total;
  }

  async liveRiskQuarantineStatus(): Promise<{ total: number; count: number }> {
    return quarantineStatus(this.signals);
  }

  private quarantineBlockReason(): string | null {
    const status = quarantineStatus(this.signals);
    if (Number.isFinite(this.maxUnresolvedExposureDollars) && status.total > this.maxUnresolvedExposureDollars + 1e-9) {
      return `live unresolved quarantined exposure ${status.total.toFixed(2)} exceeds cap ${this.maxUnresolvedExposureDollars.toFixed(2)} across ${status.count} signals`;
    }
    return null;
  }

  async liveExposureBlockReason(candidate: ArbCandidate, now: number, maxTradesPerWindow: number): Promise<string | null> {
    const staleReason = this.status().reason;
    if (staleReason) return staleReason;
    const quarantineReason = this.quarantineBlockReason();
    if (quarantineReason) return quarantineReason;
    const exposed = this.signals.filter((signal) => !riskQuarantined(signal) && signal.reconciliationResolvedAt == null && signal.expiryMs === candidate.expiryMs && signal.expiryMs > now);
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
    const staleReason = this.status().reason;
    if (staleReason) return `live reconciliation blocked: ${staleReason}`;
    const quarantineReason = this.quarantineBlockReason();
    if (quarantineReason) return quarantineReason;
    const exposed = this.signals.filter((signal) => !riskQuarantined(signal) && signal.reconciliationResolvedAt == null && signal.expiryMs === candidate.expiryMs && signal.expiryMs > now);
    for (const signal of exposed) {
      if (signal.reconciliationResolvedAt != null) continue;
      const kalshiFillCount = signal.kalshiFillCount ?? 0;
      const polymarketFillCount = signal.polymarketFillCount ?? 0;
      const hasAnyFill = kalshiFillCount > 0 || polymarketFillCount > 0;
      if (signal.partialFill) return `live reconciliation blocked: signal #${signal.id} is marked partial_fill`;
      if (hasAnyFill && Math.abs(kalshiFillCount - polymarketFillCount) > 0.000001) {
        return `live reconciliation blocked: signal #${signal.id} fill mismatch kalshi=${kalshiFillCount} polymarket=${polymarketFillCount}`;
      }
      if (hasAnyFill && (!confirmedByUserStream(signal.venueConfirmations, "kalshi") || !confirmedByUserStream(signal.venueConfirmations, "polymarket"))) {
        return `live reconciliation blocked: signal #${signal.id} has venue fills without private-stream confirmations`;
      }
      if (["unknown", "unexpected_fill_count"].includes(signal.kalshiStatus ?? "") || ["unknown", "unexpected_fill_count"].includes(signal.polymarketStatus ?? "")) {
        return `live reconciliation blocked: signal #${signal.id} has unresolved venue status`;
      }
    }
    return null;
  }
}
