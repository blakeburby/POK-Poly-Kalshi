// Shared numeric primitives for the execution path. `roundPrice` was copy-pasted byte-for-byte across
// executor.ts, live-clients.ts, and quote-quality.ts; consolidating it here removes the risk of the copies
// silently diverging (which has already happened once — economic-prices.ts intentionally rounds to a finer
// 9-decimal grid and is deliberately NOT this function).

/** Round a price/dollar amount to the 4-decimal (1/100¢) money tick used across the live execution path. */
export function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Round a price UP to the nearest exchange `tick` (e.g. 0.01). Used by the loss-capped residual-unwind SELL
 * limit: a sell limit fills only at prices >= the limit, so to keep realized loss within the cap the limit
 * must be the worst-acceptable sell price rounded UP — rounding DOWN would set a lower floor and let the
 * venue fill below the cap. The `- 1e-9` epsilon keeps an already-on-tick value from being bumped a full
 * tick by floating-point error. `tick <= 0` falls back to plain money rounding.
 */
export function ceilToTick(value: number, tick: number): number {
  if (!(tick > 0)) return roundPrice(value);
  return roundPrice(Math.ceil(value / tick - 1e-9) * tick);
}
