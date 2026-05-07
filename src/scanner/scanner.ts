import type { BookStore } from "../books/book-store";
import type { ArbExecutor } from "../execution/executor";
import { logEvent } from "../logger";
import type { ArbCandidate, DashboardSignal } from "../types";
import type { SignalStore } from "../db/signals";
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
  latency?: {
    recordScanStarted(at?: number): void;
    recordScanDuration(durationMs: number, completedAt?: number): void;
    recordDbInsert(durationMs: number): void;
    recordDbUpdate(durationMs: number): void;
    recordExecution(durationMs: number): void;
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
      const candidates = pairExecutableCandidates(polymarket, kalshi, this.options.minProfitDollars);
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
        this.recordQueueState();
        this.drainExecutionQueue();
      });
    }
  }

  private recordQueueState(): void {
    this.options.latency?.recordQueueState(this.executionQueue.length, this.activeExecutions);
  }

  private async handleCandidate(candidate: ArbCandidate, now: number): Promise<void> {
    const insertStartedAt = Date.now();
    const signalId = await this.signals.insertSignal({ candidate, action: "skipped", failureReason: "pending_execution" });
    this.options.latency?.recordDbInsert(Date.now() - insertStartedAt);
    try {
      const executionStartedAt = Date.now();
      const result = await this.executor.execute(candidate);
      this.options.latency?.recordExecution(Date.now() - executionStartedAt);
      const updateStartedAt = Date.now();
      const updatedSignal = await this.signals.updateSignal(signalId, result);
      this.options.latency?.recordDbUpdate(Date.now() - updateStartedAt);
      if (updatedSignal) this.options.analytics?.recordSignal(updatedSignal);
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
}
