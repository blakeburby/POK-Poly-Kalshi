import type { BookStore } from "../books/book-store";
import type { ArbExecutor } from "../execution/executor";
import { logEvent } from "../logger";
import type { LiveExecutionLockWriter } from "../db/live-execution-locks";
import type { ArbCandidate, DashboardSignal } from "../types";
import type { SignalStore } from "../db/signals";
import type { LiveExecutionQualityOptions } from "../execution/execution-quality";
import { pairExecutableCandidates } from "./pairing";
import { ReentryThrottle } from "./reentry";
import { protectedCandidateBlockReason } from "./safety";

export type SignalWriter = {
  insertSignal: SignalStore["insertSignal"];
  updateSignal(id: number, update: Parameters<SignalStore["updateSignal"]>[1]): Promise<DashboardSignal | null | void>;
};

export interface ScannerOptions {
  enabled: boolean;
  minProfitDollars: number;
  staleBookMs: number;
  executionConcurrency?: number;
  maxLiveTradesPerWindow?: number;
  maxUnresolvedExposureDollars?: number;
  liveAutoHardlocksEnabled?: boolean;
  liveExactExposureRequired?: boolean;
  liveExecutionQualityGateEnabled?: boolean;
  liveExecutionQualityOptions?: LiveExecutionQualityOptions;
  liveExposure?: {
    liveSubmittedAttemptBlockReason?(candidate: ArbCandidate, now: number, maxTradesPerWindow: number): Promise<string | null>;
    liveExactExposureBlockReason?(now: number): Promise<string | null>;
    liveExecutionQualityBlockReason?(candidate: ArbCandidate, now: number, options: LiveExecutionQualityOptions): Promise<string | null>;
    liveExposureBlockReason(candidate: ArbCandidate, now: number, maxTradesPerWindow: number, maxUnresolvedExposureDollars?: number): Promise<string | null>;
    observeSignal?(signal: DashboardSignal): void;
  };
  liveLocks?: LiveExecutionLockWriter;
  deferLivePersistence?: boolean;
  latency?: {
    recordScanStarted(at?: number): void;
    recordScanDuration(durationMs: number, completedAt?: number): void;
    recordBookUpdateToDecision?(durationMs: number): void;
    recordDbInsert(durationMs: number): void;
    recordDbUpdate(durationMs: number): void;
    recordPreSubmitDb?(durationMs: number): void;
    recordExecution(durationMs: number): void;
    recordHotGate?(durationMs: number): void;
    recordQueueState(queueDepth: number, activeExecutions: number): void;
    recordDuplicateCandidateSkip(): void;
  };
  analytics?: {
    recordSignal(signal: DashboardSignal): void;
  };
}

export interface ScannerStatus {
  scanning: boolean;
  lastScanAt: number;
  lastCandidateCount: number;
  queuedExecutions: number;
  activeExecutions: number;
}

interface QueuedCandidate {
  candidate: ArbCandidate;
  now: number;
}

export class CrossVenueArbScanner {
  private scanning = false;
  private lastScanAt = 0;
  private lastCandidateCount = 0;
  private readonly executionQueue: QueuedCandidate[] = [];
  private readonly activePairs = new Set<string>();
  private readonly activeLiveExpiries = new Map<number, number>();
  private readonly activeLiveLegs = new Set<string>();
  private activeExecutions = 0;

  constructor(
    private readonly books: BookStore,
    private readonly signals: SignalWriter,
    private readonly executor: ArbExecutor,
    private readonly reentry: ReentryThrottle,
    private readonly options: ScannerOptions,
  ) {}

  status(): ScannerStatus {
    return {
      scanning: this.scanning,
      lastScanAt: this.lastScanAt,
      lastCandidateCount: this.lastCandidateCount,
      queuedExecutions: this.executionQueue.length,
      activeExecutions: this.activeExecutions,
    };
  }

  async scan(now = Date.now()): Promise<ArbCandidate[]> {
    if (!this.options.enabled || this.scanning) return [];
    this.scanning = true;
    this.lastScanAt = now;
    this.options.latency?.recordScanStarted(now);
    const startedAt = Date.now();
    try {
      const polymarket = this.books.getPolymarketContracts(this.options.staleBookMs, now);
      const kalshi = this.books.getKalshiContracts(this.options.staleBookMs, now);
      if (this.options.liveAutoHardlocksEnabled !== false) {
        const activeLock = await this.options.liveLocks?.getActiveLock();
        if (activeLock) {
          this.lastCandidateCount = 0;
          logEvent({
            severity: "ERROR",
            category: "SCANNER",
            message: "live scan blocked by persistent circuit breaker",
            context: { reason: activeLock.reason, lockId: activeLock.id },
          });
          return [];
        }
      }
      const candidates = pairExecutableCandidates(polymarket, kalshi, this.options.minProfitDollars)
        .sort((left, right) => right.guaranteedProfit - left.guaranteedProfit || left.expiryMs - right.expiryMs);
      const protectedCandidates: ArbCandidate[] = [];
      for (const candidate of candidates) {
        const blockReason = protectedCandidateBlockReason(candidate, this.options.minProfitDollars);
        if (blockReason) {
          logEvent({
            severity: "WARN",
            category: "SCANNER",
            message: "candidate blocked by protected-spread guard",
            context: {
              pairKey: candidate.pairKey,
              reason: blockReason,
              structureType: candidate.risk?.structureType ?? null,
              lowerDirection: candidate.lower.direction,
              higherDirection: candidate.higher.direction,
              lowerStrike: candidate.lower.strike,
              higherStrike: candidate.higher.strike,
              guaranteedProfit: candidate.guaranteedProfit,
            },
          });
          continue;
        }
        const liveBlockReason = await this.liveCandidateBlockReason(candidate, now);
        if (liveBlockReason) {
          logEvent({
            severity: "WARN",
            category: "SCANNER",
            message: "candidate blocked by live exposure guard",
            context: {
              pairKey: candidate.pairKey,
              reason: liveBlockReason,
              expiryMs: candidate.expiryMs,
              kalshiContractId: candidate.kalshiContractId,
              polymarketContractId: candidate.polymarketContractId,
            },
          });
          continue;
        }
        protectedCandidates.push(candidate);
        this.enqueueCandidate(candidate, now);
      }
      this.lastCandidateCount = protectedCandidates.length;
      return protectedCandidates;
    } finally {
      this.scanning = false;
      this.options.latency?.recordScanDuration(Date.now() - startedAt, Date.now());
    }
  }

  private enqueueCandidate(candidate: ArbCandidate, now: number): void {
    if (!this.reentry.canEnter(candidate.pairKey, now)) return;
    if (this.activePairs.has(candidate.pairKey)) {
      this.options.latency?.recordDuplicateCandidateSkip();
      return;
    }
    this.activePairs.add(candidate.pairKey);
    this.reserveLiveCandidate(candidate);
    this.options.latency?.recordBookUpdateToDecision?.(Math.max(0, Date.now() - now));
    this.executionQueue.push({ candidate, now });
    this.recordQueueState();
    this.drainExecutionQueue();
  }

  private drainExecutionQueue(): void {
    const concurrency = Math.max(1, Math.floor(this.options.executionConcurrency ?? 1));
    while (this.activeExecutions < concurrency && this.executionQueue.length > 0) {
      const queued = this.executionQueue.shift();
      if (!queued) return;
      this.activeExecutions += 1;
      this.recordQueueState();
      void this.handleCandidate(queued.candidate, queued.now).finally(() => {
        this.activeExecutions -= 1;
        this.activePairs.delete(queued.candidate.pairKey);
        this.releaseLiveCandidate(queued.candidate);
        this.recordQueueState();
        this.drainExecutionQueue();
      });
    }
  }

  private recordQueueState(): void {
    this.options.latency?.recordQueueState(this.executionQueue.length, this.activeExecutions);
  }

  private async handleCandidate(candidate: ArbCandidate, now: number): Promise<void> {
    if (this.options.deferLivePersistence) {
      await this.handleDeferredLiveCandidate(candidate, now);
      return;
    }

    const insertStartedAt = Date.now();
    const signalId = await this.signals.insertSignal({
      candidate,
      action: "skipped",
      failureReason: "pending_execution",
    });
    const insertMs = Date.now() - insertStartedAt;
    this.options.latency?.recordDbInsert(insertMs);
    this.options.latency?.recordPreSubmitDb?.(insertMs);
    try {
      const executionStartedAt = Date.now();
      const result = await this.executor.execute(candidate);
      this.options.latency?.recordExecution(Date.now() - executionStartedAt);
      if (result.executionTimings?.hotGateMs != null) this.options.latency?.recordHotGate?.(result.executionTimings.hotGateMs);
      result.executionTimings = { ...result.executionTimings, preSubmitDbMs: insertMs };
      const updateStartedAt = Date.now();
      const updatedSignal = await this.signals.updateSignal(signalId, result);
      this.options.latency?.recordDbUpdate(Date.now() - updateStartedAt);
      if (updatedSignal) this.options.analytics?.recordSignal(updatedSignal);
      if (result.liveLockReason && this.options.liveAutoHardlocksEnabled !== false) {
        await this.options.liveLocks?.engageLock({
          reason: result.liveLockReason,
          sourceSignalId: signalId,
          executionGroupId: result.executionGroupId ?? null,
          details: {
            pairKey: candidate.pairKey,
            expiryMs: candidate.expiryMs,
            action: result.action,
            kalshiFillCount: result.kalshiFillCount ?? null,
            polymarketFillCount: result.polymarketFillCount ?? null,
            kalshiFillPrice: result.kalshiFillPrice ?? null,
            polymarketFillPrice: result.polymarketFillPrice ?? null,
          },
        });
      }
      if (result.action === "filled") this.reentry.recordFill(candidate.pairKey, now);
      else if (result.action === "failed" && result.executionGroupId) this.reentry.recordAttempt(candidate.pairKey, now);
      logEvent({
        category: "SCANNER",
        message: "candidate processed",
        context: { pairKey: candidate.pairKey, action: result.action, guaranteedProfit: candidate.guaranteedProfit },
      });
    } catch (error) {
      const updatedSignal = await this.signals.updateSignal(signalId, {
        action: "failed",
        failureReason: error instanceof Error ? error.message : String(error),
      });
      if (updatedSignal) this.options.analytics?.recordSignal(updatedSignal);
      logEvent({
        severity: "ERROR",
        category: "SCANNER",
        message: "candidate execution failed",
        context: { pairKey: candidate.pairKey, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async handleDeferredLiveCandidate(candidate: ArbCandidate, now: number): Promise<void> {
    try {
      this.options.latency?.recordPreSubmitDb?.(0);
      const executionStartedAt = Date.now();
      const result = await this.executor.execute(candidate);
      this.options.latency?.recordExecution(Date.now() - executionStartedAt);
      if (result.executionTimings?.hotGateMs != null) this.options.latency?.recordHotGate?.(result.executionTimings.hotGateMs);
      result.executionTimings = { ...result.executionTimings, preSubmitDbMs: 0 };

      const insertStartedAt = Date.now();
      const signalId = await this.signals.insertSignal({
        candidate,
        action: result.action,
        failureReason: result.failureReason,
      });
      this.options.latency?.recordDbInsert(Date.now() - insertStartedAt);

      const updateStartedAt = Date.now();
      const updatedSignal = await this.signals.updateSignal(signalId, result);
      this.options.latency?.recordDbUpdate(Date.now() - updateStartedAt);
      if (updatedSignal) {
        this.options.analytics?.recordSignal(updatedSignal);
        this.options.liveExposure?.observeSignal?.(updatedSignal);
      }
      if (result.liveLockReason && this.options.liveAutoHardlocksEnabled !== false) {
        await this.options.liveLocks?.engageLock({
          reason: result.liveLockReason,
          sourceSignalId: signalId,
          executionGroupId: result.executionGroupId ?? null,
          details: {
            pairKey: candidate.pairKey,
            expiryMs: candidate.expiryMs,
            action: result.action,
            kalshiFillCount: result.kalshiFillCount ?? null,
            polymarketFillCount: result.polymarketFillCount ?? null,
            kalshiFillPrice: result.kalshiFillPrice ?? null,
            polymarketFillPrice: result.polymarketFillPrice ?? null,
          },
        });
      }
      if (result.action === "filled") this.reentry.recordFill(candidate.pairKey, now);
      else if (result.action === "failed" && result.executionGroupId) this.reentry.recordAttempt(candidate.pairKey, now);
      logEvent({
        category: "SCANNER",
        message: "candidate processed",
        context: { pairKey: candidate.pairKey, action: result.action, guaranteedProfit: candidate.guaranteedProfit },
      });
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      try {
        const signalId = await this.signals.insertSignal({
          candidate,
          action: "failed",
          failureReason,
        });
        const updatedSignal = await this.signals.updateSignal(signalId, {
          action: "failed",
          failureReason,
        });
        if (updatedSignal) this.options.analytics?.recordSignal(updatedSignal);
      } catch (persistError) {
        logEvent({
          severity: "ERROR",
          category: "DB",
          message: "failed to persist deferred live execution error",
          context: { error: persistError instanceof Error ? persistError.message : String(persistError) },
        });
      }
      logEvent({
        severity: "ERROR",
        category: "SCANNER",
        message: "candidate execution failed",
        context: { pairKey: candidate.pairKey, error: failureReason },
      });
    }
  }

  private async liveCandidateBlockReason(candidate: ArbCandidate, now: number): Promise<string | null> {
    const maxTrades = Math.max(0, Math.floor(this.options.maxLiveTradesPerWindow ?? 1));
    const reservedForExpiry = this.activeLiveExpiries.get(candidate.expiryMs) ?? 0;
    if (reservedForExpiry >= maxTrades) {
      return `live scan window limit reached for expiry ${candidate.expiryMs}: ${reservedForExpiry}/${maxTrades} already reserved`;
    }
    for (const key of this.liveLegKeys(candidate)) {
      if (this.activeLiveLegs.has(key)) return `live leg already reserved in this scan: ${key}`;
    }
    const submittedAttemptReason = await this.options.liveExposure?.liveSubmittedAttemptBlockReason?.(candidate, now, maxTrades);
    if (submittedAttemptReason) return submittedAttemptReason;
    if (this.options.liveExactExposureRequired) {
      const exactExposureReason = await this.options.liveExposure?.liveExactExposureBlockReason?.(now);
      if (exactExposureReason) return exactExposureReason;
    }
    if (this.options.liveExecutionQualityGateEnabled && this.options.liveExecutionQualityOptions) {
      const qualityReason = await this.options.liveExposure?.liveExecutionQualityBlockReason?.(candidate, now, this.options.liveExecutionQualityOptions);
      if (qualityReason) return qualityReason;
    }
    if (this.options.liveAutoHardlocksEnabled === false) return null;
    return await this.options.liveExposure?.liveExposureBlockReason(
      candidate,
      now,
      maxTrades,
      this.options.maxUnresolvedExposureDollars,
    ) ?? null;
  }

  private reserveLiveCandidate(candidate: ArbCandidate): void {
    this.activeLiveExpiries.set(candidate.expiryMs, (this.activeLiveExpiries.get(candidate.expiryMs) ?? 0) + 1);
    for (const key of this.liveLegKeys(candidate)) this.activeLiveLegs.add(key);
  }

  private releaseLiveCandidate(candidate: ArbCandidate): void {
    const count = this.activeLiveExpiries.get(candidate.expiryMs) ?? 0;
    if (count <= 1) this.activeLiveExpiries.delete(candidate.expiryMs);
    else this.activeLiveExpiries.set(candidate.expiryMs, count - 1);
    for (const key of this.liveLegKeys(candidate)) this.activeLiveLegs.delete(key);
  }

  private liveLegKeys(candidate: ArbCandidate): string[] {
    return [
      `${candidate.lower.venue}:${candidate.lower.contractId}:${candidate.lower.direction}:${candidate.lower.tokenId ?? ""}`,
      `${candidate.higher.venue}:${candidate.higher.contractId}:${candidate.higher.direction}:${candidate.higher.tokenId ?? ""}`,
      `kalshi:${candidate.kalshiContractId}`,
      `polymarket:${candidate.polymarketContractId}`,
    ];
  }
}
