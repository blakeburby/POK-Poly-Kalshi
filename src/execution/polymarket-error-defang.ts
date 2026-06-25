import axios from "axios";

/**
 * Polymarket CLOB error "defang".
 *
 * The @polymarket/clob-client-v2 SDK's internal `errorHandling()` does an UNCONDITIONAL
 * `JSON.stringify({ status, statusText, data, config: err.response.config })` on a non-2xx axios rejection
 * (dist/index.cjs:~399). `err.response.config` transitively references the request's keep-alive agent /
 * TLSSocket, whose `socket -> parser -> socket` cycle makes that `JSON.stringify` throw
 * "Converting circular structure to JSON" — and because the stringify is an ARGUMENT to `console.error`, it
 * throws BEFORE the function reaches its clean `return { error: data, status }`. The TypeError then escapes
 * `postOrder`, so the genuine (usually benign, e.g. 400 "no orders found to match") rejection reason is
 * destroyed and replaced with the circular-structure text in our `failure_reason`.
 *
 * The SDK uses the GLOBAL axios instance (`axios(...)`), and the repo has a single hoisted axios, so a global
 * response-error interceptor that replaces the circular `config` with a plain `{ url, method }` BEFORE the
 * SDK's catch runs lets that `JSON.stringify` succeed — surfacing the real rejection detail. Scoped to CLOB
 * requests by URL so no other axios caller is affected; never throws; diagnostic-only (no trading change).
 */

function looksLikePolymarketUrl(url: string): boolean {
  return /polymarket|\bclob\b/i.test(url);
}

/**
 * Replace the circular `config` on a Polymarket CLOB axios error's response with a plain, JSON-safe subset so
 * the SDK's `errorHandling()` cannot throw while serializing it. Mutates `error` in place. Never throws.
 * Exported for unit testing.
 */
export function defangPolymarketAxiosError(error: unknown): void {
  try {
    if (!axios.isAxiosError(error)) return;
    const cfg = error.config as { baseURL?: string; url?: string } | undefined;
    const url = `${cfg?.baseURL ?? ""}${cfg?.url ?? ""}`;
    if (!looksLikePolymarketUrl(url)) return;
    const response = error.response as { config?: { url?: string; method?: string } } | undefined;
    if (response && typeof response === "object") {
      const rcfg = response.config;
      // Keep only primitive, non-circular fields; this is the object the SDK stringifies.
      response.config = rcfg ? { url: rcfg.url, method: rcfg.method } : undefined;
    }
    // Defensively drop the raw ClientRequest (the other common home of the socket cycle) in case a future SDK
    // version serializes it too.
    (error as { request?: unknown }).request = undefined;
  } catch {
    // A diagnostic helper must never destabilize the request path.
  }
}

let registered = false;

/** Register the CLOB error defang as a global axios response-error interceptor exactly once. */
export function registerPolymarketAxiosErrorDefang(): void {
  if (registered) return;
  registered = true;
  axios.interceptors.response.use(undefined, (error: unknown) => {
    defangPolymarketAxiosError(error);
    return Promise.reject(error);
  });
}
