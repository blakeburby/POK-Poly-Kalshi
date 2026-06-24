// Shared numeric primitives for the execution path. `roundPrice` was copy-pasted byte-for-byte across
// executor.ts, live-clients.ts, and quote-quality.ts; consolidating it here removes the risk of the copies
// silently diverging (which has already happened once — economic-prices.ts intentionally rounds to a finer
// 9-decimal grid and is deliberately NOT this function).

/** Round a price/dollar amount to the 4-decimal (1/100¢) money tick used across the live execution path. */
export function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
