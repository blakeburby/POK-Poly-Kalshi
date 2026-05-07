export interface FilledAttempt {
  pairKey: string;
  filledAtMs: number;
}

export class ReentryThrottle {
  private readonly lastEntryByPair = new Map<string, number>();

  constructor(private readonly intervalMs: number) {}

  hydrate(attempts: FilledAttempt[]): void {
    for (const attempt of attempts) this.recordFill(attempt.pairKey, attempt.filledAtMs);
  }

  canEnter(pairKey: string, now = Date.now()): boolean {
    const lastEntry = this.lastEntryByPair.get(pairKey);
    return lastEntry == null || now - lastEntry >= this.intervalMs;
  }

  recordAttempt(pairKey: string, attemptedAtMs = Date.now()): void {
    const previous = this.lastEntryByPair.get(pairKey) ?? 0;
    if (attemptedAtMs >= previous) this.lastEntryByPair.set(pairKey, attemptedAtMs);
  }

  recordFill(pairKey: string, filledAtMs = Date.now()): void {
    this.recordAttempt(pairKey, filledAtMs);
  }

  nextAllowedAt(pairKey: string): number | null {
    const lastEntry = this.lastEntryByPair.get(pairKey);
    return lastEntry == null ? null : lastEntry + this.intervalMs;
  }
}
