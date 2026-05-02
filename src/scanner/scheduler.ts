import { logEvent } from "../logger";

export interface ScanSchedulerTarget {
  scan(now?: number): Promise<unknown>;
}

export interface ScanSchedulerLatencySink {
  recordCoalescedScan(): void;
}

export class CoalescedScanScheduler {
  private running = false;
  private pending = false;
  private pendingNow = 0;

  constructor(
    private readonly target: ScanSchedulerTarget,
    private readonly latency?: ScanSchedulerLatencySink,
  ) {}

  requestScan(now = Date.now()): void {
    if (this.running) {
      this.pending = true;
      this.pendingNow = Math.max(this.pendingNow, now);
      this.latency?.recordCoalescedScan();
      return;
    }
    void this.run(now);
  }

  status(): { running: boolean; pending: boolean } {
    return { running: this.running, pending: this.pending };
  }

  private async run(now: number): Promise<void> {
    this.running = true;
    try {
      await this.target.scan(now);
    } catch (error) {
      logEvent({
        severity: "ERROR",
        category: "SCANNER",
        message: "coalesced scan failed",
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      this.running = false;
      if (this.pending) {
        const nextNow = this.pendingNow || Date.now();
        this.pending = false;
        this.pendingNow = 0;
        queueMicrotask(() => void this.run(nextNow));
      }
    }
  }
}
