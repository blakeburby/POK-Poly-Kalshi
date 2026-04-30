export interface FilledAttempt {
  pairKey: string;
  filledAtMs: number;
}

export class ReentryThrottle {
  private readonly lastFillByPair = new Map<string, number>();

  constructor(private readonly intervalMs: number) {}

  hydrate(attempts: FilledAttempt[]): void {
    for (const attempt of attempts) this.recordFill(attempt.pairKey, attempt.filledAtMs);
  }

  canEnter(pairKey: string, now = Date.now()): boolean {
    const lastFill = this.lastFillByPair.get(pairKey);
    return lastFill == null || now - lastFill >= this.intervalMs;
  }

  recordFill(pairKey: string, filledAtMs = Date.now()): void {
    const previous = this.lastFillByPair.get(pairKey) ?? 0;
    if (filledAtMs >= previous) this.lastFillByPair.set(pairKey, filledAtMs);
  }

  nextAllowedAt(pairKey: string): number | null {
    const lastFill = this.lastFillByPair.get(pairKey);
    return lastFill == null ? null : lastFill + this.intervalMs;
  }
}
