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

/**
 * Feed-liveness watchdog predicate. A WebSocket can stay socket-open while the server silently stops
 * delivering data (e.g. order-book deltas): app-level heartbeats keep sending, the socket never emits a
 * `close`, so reconnect logic (which is close-driven) never fires and the feed is silently dead. This
 * returns true when the connection is open with active subscriptions but no message has arrived within
 * `feedSilenceMs` — the caller should force a reconnect (close → reconnect re-sends a full subscribe).
 * `feedSilenceMs <= 0` disables the watchdog.
 */
export function shouldForceFeedReconnect(input: {
  now: number;
  lastMessageAt: number;
  feedSilenceMs: number;
  desiredSubscriptions: number;
  socketOpen: boolean;
}): boolean {
  if (input.feedSilenceMs <= 0) return false;
  if (!input.socketOpen) return false;
  if (input.desiredSubscriptions <= 0) return false;
  return input.now - input.lastMessageAt > input.feedSilenceMs;
}

