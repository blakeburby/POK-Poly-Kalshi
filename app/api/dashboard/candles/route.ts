import { hasDashboardSession } from "../../../lib/dashboard-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * Read-only spot-price candles for the price charts. Proxies Coinbase Exchange's PUBLIC
 * market-data endpoint (no auth, no keys) — purely observational reference data for the
 * dashboard. Touches nothing in the trading system. Supported assets are the ones the
 * strategy and operator care about; granularity is constrained to Coinbase's allowed set.
 */
const ASSETS = new Set(["BTC", "ETH", "SOL", "XRP"]);
const GRANULARITIES = new Set([60, 300, 900, 3600]);

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export async function GET(request: Request): Promise<Response> {
  if (!(await hasDashboardSession())) return Response.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const asset = (url.searchParams.get("asset") ?? "BTC").toUpperCase();
  const granularity = Number(url.searchParams.get("granularity") ?? "60");
  if (!ASSETS.has(asset)) return Response.json({ error: "unsupported_asset" }, { status: 400 });
  if (!GRANULARITIES.has(granularity)) return Response.json({ error: "unsupported_granularity" }, { status: 400 });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      `https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=${granularity}`,
      { signal: controller.signal, headers: { "User-Agent": "pok-terminal-dashboard", Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`coinbase_${res.status}`);
    const raw = (await res.json()) as Array<[number, number, number, number, number, number]>;
    // Coinbase returns [time(s), low, high, open, close, volume], newest-first.
    const candles: Candle[] = raw
      .map(([time, low, high, open, close, volume]) => ({
        t: time * 1000,
        o: open,
        h: high,
        l: low,
        c: close,
        v: volume,
      }))
      .sort((a, b) => a.t - b.t);
    return Response.json(
      { asset, granularity, candles },
      { headers: { "Cache-Control": "s-maxage=10, stale-while-revalidate=30" } },
    );
  } catch (error) {
    return Response.json(
      { asset, granularity, candles: [], error: error instanceof Error ? error.message : String(error) },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    clearTimeout(timeout);
  }
}
