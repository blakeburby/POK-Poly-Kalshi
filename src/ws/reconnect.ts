export function isRateLimitError(message: string | null | undefined): boolean {
  return typeof message === "string" && /\b429\b|rate.?limit/i.test(message);
}

export function computeRateLimitBackoffDelay(attempt: number, baseMs = 15_000, maxMs = 120_000): number {
  return Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
}

export function computeReconnectDelay(input: {
  attempt: number;
  now: number;
  maxMs?: number;
  rateLimitBackoffUntil?: number;
}): { delayMs: number; reason: "socket_retry" | "rate_limited" } {
  const retryDelay = Math.min(input.maxMs ?? 30_000, 1000 * Math.pow(2, Math.max(0, input.attempt - 1)));
  const rateLimitDelay = Math.max(0, (input.rateLimitBackoffUntil ?? 0) - input.now);
  return rateLimitDelay > retryDelay
    ? { delayMs: rateLimitDelay, reason: "rate_limited" }
    : { delayMs: retryDelay, reason: "socket_retry" };
}

