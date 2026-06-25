import { hasDashboardSession } from "../../../lib/dashboard-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * Read-only spot prices for the header ticker. Lightweight companion to the candles route —
 * one current price per asset from Coinbase's PUBLIC ticker endpoint (no auth, no keys).
 * Observational reference data only; touches nothing in the trading system.
 */
const ASSETS = ["BTC", "ETH", "SOL", "XRP"] as const;

export async function GET(): Promise<Response> {
  if (!(await hasDashboardSession())) return Response.json({ error: "unauthorized" }, { status: 401 });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const results = await Promise.allSettled(
      ASSETS.map((a) =>
        fetch(`https://api.exchange.coinbase.com/products/${a}-USD/ticker`, {
          signal: controller.signal,
          headers: { "User-Agent": "pok-terminal-dashboard", Accept: "application/json" },
        }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`http_${r.status}`)))),
      ),
    );
    const prices: Record<string, number | null> = {};
    ASSETS.forEach((a, i) => {
      const r = results[i];
      const p = r.status === "fulfilled" ? Number((r.value as { price?: string }).price) : NaN;
      prices[a] = Number.isFinite(p) ? p : null;
    });
    return Response.json(
      { prices, generatedAt: Date.now() },
      { headers: { "Cache-Control": "s-maxage=5, stale-while-revalidate=15" } },
    );
  } catch (error) {
    return Response.json(
      { prices: {}, error: error instanceof Error ? error.message : String(error) },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    clearTimeout(timeout);
  }
}
