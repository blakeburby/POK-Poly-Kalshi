import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config";
import { getKalshiHeaders } from "../kalshi/auth";
import type { TradingConnectionState, VenuePnlLeg, VenuePnlSnapshot } from "../../types/trading";

/**
 * Venue-truth realized P&L for the BTC 15-minute arb, net of fees.
 *
 * Source of truth is the VENUES, not the bot's signal DB:
 *  - Kalshi: `/portfolio/settlements` gives, per settled market, `revenue` (cents),
 *    `{yes,no}_total_cost_dollars`, and `fee_cost` (dollars). Realized = revenue − cost − fee.
 *    The settlements feed is complete (the `/portfolio/fills` feed is truncated, so it is NOT
 *    used for P&L). `/portfolio/positions` provides currently-open exposure (market value).
 *  - Polymarket: data-api `/positions` gives per-position `cashPnl` (the realized result of a
 *    resolved market; `realizedPnl` stays 0 until on-chain redemption). Polymarket CLOB trading
 *    fees are ~0, so cashPnl is take-home. Open exposure = currentValue of still-live positions.
 *
 * Validated against the live accounts via scripts/venue-pnl-audit.ts before being wired in.
 * All network work is wrapped so a venue hiccup degrades a leg to `reconnecting` with zeros
 * rather than throwing into the snapshot/worker path.
 */

type Rec = Record<string, unknown>;
type FetchFn = typeof fetch;

const KALSHI_BTC15M = /^KXBTC15M/i;
const POLY_BTC = /bitcoin up or down/i;
const POLY_DATA_API = "https://data-api.polymarket.com";
const KALSHI_TIMEOUT_MS = 4_000;
const POLY_TIMEOUT_MS = 4_000;
export const VENUE_PNL_SCOPE = "BTC 15-minute arb";

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const firstNum = (r: Rec | null, keys: string[]): number | null => {
  if (!r) return null;
  for (const k of keys) { const n = num(r[k]); if (n != null) return n; }
  return null;
};
const str = (v: unknown): string | null => { const s = v == null ? null : String(v).trim(); return s || null; };
const firstStr = (r: Rec | null, keys: string[]): string | null => { if (!r) return null; for (const k of keys) { const s = str(r[k]); if (s) return s; } return null; };
const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const sum = (xs: (number | null)[]): number => round(xs.reduce<number>((a, x) => a + (x ?? 0), 0));
const arr = (v: unknown): Rec[] => Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === "object") : [];
/** Kalshi money: bare field is cents, `*_dollars` is dollars. */
const money = (r: Rec | null, centsKeys: string[], dollarKeys: string[]): number => {
  const d = firstNum(r, dollarKeys); if (d != null) return d;
  const c = firstNum(r, centsKeys); return c == null ? 0 : c / 100;
};

async function fetchJson(fetchFn: FetchFn, url: URL, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${url.pathname} ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function kalshiAll(config: AppConfig, fetchFn: FetchFn, path: string, key: string): Promise<Rec[]> {
  const out: Rec[] = [];
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    const url = new URL(config.kalshiApiBase);
    url.pathname = url.pathname.replace(/\/$/, "") + path;
    url.search = new URLSearchParams(cursor ? { limit: "500", cursor } : { limit: "500" }).toString();
    const payload = await fetchJson(fetchFn, url, { method: "GET", headers: getKalshiHeaders("GET", url.pathname + url.search) }, KALSHI_TIMEOUT_MS) as Rec;
    out.push(...arr(payload[key]));
    cursor = str(payload.cursor) ?? "";
    if (!cursor) break;
  }
  return out;
}

function emptyLeg(platform: VenuePnlLeg["platform"], connectionStatus: TradingConnectionState): VenuePnlLeg {
  return { platform, connectionStatus, realizedTakeHome: 0, feesPaid: 0, grossRevenue: 0, cost: 0, openExposure: 0, settledCount: 0, openCount: 0, unredeemedCount: 0, lastUpdatedAt: null };
}

/** Pure computation from already-fetched Kalshi rows (no network/auth) — unit-testable. */
export function kalshiLegFromRows(positions: Rec[], settlements: Rec[], now: number): VenuePnlLeg {
  const isBtc = (r: Rec) => KALSHI_BTC15M.test(firstStr(r, ["ticker", "market_ticker", "event_ticker"]) ?? "");
  const settled = settlements.filter(isBtc);
  const grossRevenue = sum(settled.map((s) => money(s, ["revenue"], ["revenue_dollars"])));
  const cost = sum(settled.map((s) => (firstNum(s, ["yes_total_cost_dollars"]) ?? 0) + (firstNum(s, ["no_total_cost_dollars"]) ?? 0)));
  const feesPaid = sum(settled.map((s) => firstNum(s, ["fee_cost", "fees_dollars"])));
  const openBtc = positions.filter((p) => isBtc(p) && Math.abs(firstNum(p, ["position", "position_fp", "net_position"]) ?? 0) > 1e-6);
  const openExposure = sum(openBtc.map((p) => money(p, ["market_value", "market_exposure"], ["market_exposure_dollars", "market_value_dollars"])));
  return {
    platform: "kalshi", connectionStatus: "live",
    realizedTakeHome: round(grossRevenue - cost - feesPaid),
    feesPaid, grossRevenue, cost, openExposure,
    settledCount: settled.length, openCount: openBtc.length, unredeemedCount: 0,
    lastUpdatedAt: now,
  };
}

async function kalshiLeg(config: AppConfig, fetchFn: FetchFn, now: number): Promise<VenuePnlLeg> {
  try {
    const [positions, settlements] = await Promise.all([
      kalshiAll(config, fetchFn, "/portfolio/positions", "market_positions"),
      kalshiAll(config, fetchFn, "/portfolio/settlements", "settlements"),
    ]);
    return kalshiLegFromRows(positions, settlements, now);
  } catch {
    return emptyLeg("kalshi", "reconnecting");
  }
}

function polymarketAddress(config: AppConfig): string | null {
  if (config.polymarketFunderAddress?.trim()) return config.polymarketFunderAddress.trim();
  const key = config.polymarketPrivateKey?.trim();
  if (!key) return null;
  return privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address;
}

/** Pure computation from already-fetched Polymarket position rows (no network) — unit-testable. */
export function polymarketLegFromRows(positions: Rec[], now: number): VenuePnlLeg {
  const btc = positions.filter((p) => POLY_BTC.test(firstStr(p, ["title", "slug", "market"]) ?? ""));
  const isEnded = (p: Rec) => p.redeemable === true || [0, 1].includes(firstNum(p, ["curPrice"]) ?? -1);
  const ended = btc.filter(isEnded);
  const realizedTakeHome = sum(ended.map((p) => firstNum(p, ["cashPnl", "cash_pnl"])));
  const cost = sum(ended.map((p) => firstNum(p, ["initialValue", "initial_value"])));
  const open = btc.filter((p) => !isEnded(p) && (firstNum(p, ["size"]) ?? 0) > 1e-6);
  const openExposure = sum(open.map((p) => firstNum(p, ["currentValue", "current_value", "value"])));
  return {
    platform: "polymarket", connectionStatus: "live",
    realizedTakeHome,
    feesPaid: 0, // Polymarket CLOB trading fee is ~0; cashPnl is already take-home.
    grossRevenue: round(realizedTakeHome + cost), cost, openExposure,
    settledCount: ended.length, openCount: open.length,
    unredeemedCount: btc.filter((p) => p.redeemable === true).length,
    lastUpdatedAt: now,
  };
}

async function polymarketLeg(config: AppConfig, fetchFn: FetchFn, now: number): Promise<VenuePnlLeg> {
  try {
    const address = polymarketAddress(config);
    if (!address) return emptyLeg("polymarket", "reconnecting");
    const url = new URL(`${POLY_DATA_API}/positions`);
    url.searchParams.set("user", address);
    url.searchParams.set("limit", "500");
    url.searchParams.set("sizeThreshold", "0");
    const payload = await fetchJson(fetchFn, url, { method: "GET" }, POLY_TIMEOUT_MS);
    const positions = Array.isArray(payload) ? arr(payload) : arr((payload as Rec).positions);
    return polymarketLegFromRows(positions, now);
  } catch {
    return emptyLeg("polymarket", "reconnecting");
  }
}

export async function computeVenuePnl(config: AppConfig, now = Date.now(), fetchFn: FetchFn = fetch): Promise<VenuePnlSnapshot> {
  const [kalshi, polymarket] = await Promise.all([
    kalshiLeg(config, fetchFn, now),
    polymarketLeg(config, fetchFn, now),
  ]);
  return {
    generatedAt: now,
    scope: VENUE_PNL_SCOPE,
    kalshi,
    polymarket,
    combinedRealizedTakeHome: round(kalshi.realizedTakeHome + polymarket.realizedTakeHome),
    combinedOpenExposure: round(kalshi.openExposure + polymarket.openExposure),
    combinedFeesPaid: round(kalshi.feesPaid + polymarket.feesPaid),
    note: "Realized take-home from venue settlements/positions, net of fees. Excludes intra-window unwinds and any settlements beyond the venue's retention window.",
  };
}
