import type { BookStore } from "../books/book-store";
import type { ArbExecutor } from "../execution/executor";
import { logEvent } from "../logger";
import type { ArbCandidate } from "../types";
import type { SignalStore } from "../db/signals";
import { pairExecutableCandidates } from "./pairing";
import { ReentryThrottle } from "./reentry";

export interface ScannerOptions {
  enabled: boolean;
  minProfitDollars: number;
  staleBookMs: number;
}

export interface ScannerStatus {
  scanning: boolean;
  lastScanAt: number;
  lastCandidateCount: number;
}

export class CrossVenueArbScanner {
  private scanning = false;
  private lastScanAt = 0;
  private lastCandidateCount = 0;

  constructor(
    private readonly books: BookStore,
    private readonly signals: SignalStore,
    private readonly executor: ArbExecutor,
    private readonly reentry: ReentryThrottle,
    private readonly options: ScannerOptions,
  ) {}

  status(): ScannerStatus {
    return {
      scanning: this.scanning,
      lastScanAt: this.lastScanAt,
      lastCandidateCount: this.lastCandidateCount,
    };
  }

  async scan(now = Date.now()): Promise<ArbCandidate[]> {
    if (!this.options.enabled || this.scanning) return [];
    this.scanning = true;
    this.lastScanAt = now;
    try {
      const polymarket = this.books.getPolymarketContracts(this.options.staleBookMs, now);
      const kalshi = this.books.getKalshiContracts(this.options.staleBookMs, now);
      const candidates = pairExecutableCandidates(polymarket, kalshi, this.options.minProfitDollars);
      this.lastCandidateCount = candidates.length;
      for (const candidate of candidates) await this.handleCandidate(candidate, now);
      return candidates;
    } finally {
      this.scanning = false;
    }
  }

  private async handleCandidate(candidate: ArbCandidate, now: number): Promise<void> {
    if (!this.reentry.canEnter(candidate.pairKey, now)) return;
    const signalId = await this.signals.insertSignal({ candidate, action: "skipped", failureReason: "pending_execution" });
    try {
      const result = await this.executor.execute(candidate);
      await this.signals.updateSignal(signalId, result);
      if (result.action === "filled") this.reentry.recordFill(candidate.pairKey, now);
      logEvent({
        category: "SCANNER",
        message: "candidate processed",
        context: { pairKey: candidate.pairKey, action: result.action, guaranteedProfit: candidate.guaranteedProfit },
      });
    } catch (error) {
      await this.signals.updateSignal(signalId, {
        action: "failed",
        failureReason: error instanceof Error ? error.message : String(error),
      });
      logEvent({
        severity: "ERROR",
        category: "SCANNER",
        message: "candidate execution failed",
        context: { pairKey: candidate.pairKey, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
