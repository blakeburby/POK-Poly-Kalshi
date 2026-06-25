import { hasDashboardSession } from "../../../lib/dashboard-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * Read-only "market releases" feed: newest / most-active prediction markets from Kalshi and
 * Polymarket, via each venue's PUBLIC listing API (no auth, no keys). Purely observational
 * reference data — touches nothing in the trading system.
 */
export interface ReleaseItem {
  venue: "kalshi" | "polymarket";
  id: string;
  title: string;
  status: string;
  createdAt: number | null;
  closeTime: number | null;
  volume: number | null;
  liquidity: number | null;
  isNew: boolean;
  url: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const ms = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    signal,
    headers: { "User-Agent": "pok-terminal-dashboard", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

async function polymarket(signal: AbortSignal): Promise<ReleaseItem[]> {
  const data = await fetchJson(
    "https://gamma-api.polymarket.com/events?closed=false&limit=40&order=startDate&ascending=false",
    signal,
  );
  const arr = Array.isArray(data) ? data : [];
  const now = Date.now();
  return arr.map((e: Record<string, unknown>) => {
    const created = ms(e.creationDate) ?? ms(e.startDate);
    return {
      venue: "polymarket" as const,
      id: String(e.id ?? e.slug ?? Math.random()),
      title: String(e.title ?? "Untitled market"),
      status: e.closed ? "closed" : e.active ? "active" : "pending",
      createdAt: created,
      closeTime: ms(e.endDate),
      volume: num(e.volume),
      liquidity: num(e.liquidity),
      isNew: Boolean(e.new) || (created != null && now - created < 24 * 3600_000),
      url: e.slug ? `https://polymarket.com/event/${String(e.slug)}` : null,
    };
  });
}

// The generic open-markets listing is dominated by multi-event parlay combos. Pull the
// strategy-relevant crypto price series directly so the feed shows real BTC/ETH markets.
const KALSHI_SERIES = ["KXBTCD", "KXBTC", "KXETHD", "KXETH"];

async function kalshi(signal: AbortSignal): Promise<ReleaseItem[]> {
  const now = Date.now();
  const results = await Promise.allSettled(
    KALSHI_SERIES.map((s) =>
      fetchJson(
        `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${s}&limit=20&status=open`,
        signal,
      ),
    ),
  );
  const out: ReleaseItem[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const arr = (r.value as { markets?: Array<Record<string, unknown>> }).markets ?? [];
    for (const m of arr) {
      const ticker = String(m.ticker ?? "");
      // Collapse per-strike markets into one row per event (Kalshi lists every strike separately).
      const eventKey = String(m.event_ticker ?? ticker);
      if (!eventKey || seen.has(eventKey)) continue;
      seen.add(eventKey);
      const created = ms(m.created_time) ?? ms(m.open_time);
      out.push({
        venue: "kalshi",
        id: ticker,
        title: String(m.title ?? (ticker || "Untitled market")),
        status: String(m.status ?? "open"),
        createdAt: created,
        closeTime: ms(m.close_time),
        volume: num(m.volume) ?? num(m.notional_value_dollars),
        liquidity: num(m.liquidity_dollars),
        isNew: created != null && now - created < 24 * 3600_000,
        url: m.event_ticker ? `https://kalshi.com/markets/${String(m.event_ticker)}` : null,
      });
    }
  }
  return out;
}

export async function GET(): Promise<Response> {
  if (!(await hasDashboardSession())) return Response.json({ error: "unauthorized" }, { status: 401 });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  const errors: Record<string, string> = {};
  try {
    const [pm, kal] = await Promise.allSettled([polymarket(controller.signal), kalshi(controller.signal)]);
    const releases: ReleaseItem[] = [];
    if (pm.status === "fulfilled") releases.push(...pm.value);
    else errors.polymarket = pm.reason instanceof Error ? pm.reason.message : String(pm.reason);
    if (kal.status === "fulfilled") releases.push(...kal.value);
    else errors.kalshi = kal.reason instanceof Error ? kal.reason.message : String(kal.reason);
    // Surface high-signal markets first: rank by traded volume, then by recency. This sinks the
    // low-volume multi-leg parlay noise from Kalshi's generic open-markets listing.
    releases.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return Response.json(
      { releases, errors, generatedAt: Date.now() },
      { headers: { "Cache-Control": "s-maxage=30, stale-while-revalidate=120" } },
    );
  } finally {
    clearTimeout(timeout);
  }
}
