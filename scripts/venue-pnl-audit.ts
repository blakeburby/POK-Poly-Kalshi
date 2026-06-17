import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config";
import { getKalshiHeaders } from "../src/kalshi/auth";

/**
 * READ-ONLY venue-truth P&L audit. Computes arb-only (BTC 15-minute) take-home
 * profit NET OF FEES and open exposure directly from Kalshi + Polymarket — the
 * authoritative source — so we can validate the numbers (and lock the exact API
 * field names) before wiring this into the dashboard.
 *
 * Writes nothing. Run on the live worker host (Montreal) where venue creds exist:
 *   set -a; . /etc/pok-poly-kalshi/worker.env; set +a
 *   npx tsx scripts/venue-pnl-audit.ts
 *
 * Arb markets: Kalshi ticker `KXBTC15M*`; Polymarket title "Bitcoin Up or Down".
 */

type Rec = Record<string, unknown>;
const KALSHI_BTC15M = /^KXBTC15M/i;
const POLY_BTC = /bitcoin up or down/i;
const POLY_DATA_API = "https://data-api.polymarket.com";

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
// Kalshi money fields arrive in cents under bare names, dollars under *_dollars.
const money = (r: Rec | null, centsKeys: string[], dollarKeys: string[] = []): number | null => {
  const d = firstNum(r, dollarKeys); if (d != null) return round(d);
  const c = firstNum(r, centsKeys); return c == null ? null : round(c / 100);
};
const round = (n: number | null): number | null => n == null ? null : Math.round(n * 1e6) / 1e6;
const str = (v: unknown): string | null => { const s = v == null ? null : String(v).trim(); return s || null; };
const firstStr = (r: Rec | null, keys: string[]): string | null => { if (!r) return null; for (const k of keys) { const s = str(r[k]); if (s) return s; } return null; };
const sum = (xs: (number | null)[]): number => round(xs.reduce<number>((a, x) => a + (x ?? 0), 0)) ?? 0;
const arr = (v: unknown): Rec[] => Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === "object") : [];

async function kalshiGet(config: ReturnType<typeof loadConfig>, path: string, params: Record<string, string>): Promise<Rec> {
  const url = new URL(config.kalshiApiBase);
  url.pathname = url.pathname.replace(/\/$/, "") + path;
  url.search = new URLSearchParams(params).toString();
  const res = await fetch(url, { headers: getKalshiHeaders("GET", url.pathname + url.search) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as Rec;
}

/** Page through a Kalshi list endpoint via its `cursor`, collecting rows under `key`. */
async function kalshiAll(config: ReturnType<typeof loadConfig>, path: string, key: string, extra: Record<string, string> = {}): Promise<Rec[]> {
  const out: Rec[] = [];
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    const params: Record<string, string> = { limit: "500", ...extra };
    if (cursor) params.cursor = cursor;
    const payload = await kalshiGet(config, path, params);
    out.push(...arr(payload[key]));
    cursor = str(payload.cursor) ?? "";
    if (!cursor) break;
  }
  return out;
}

async function polyGet(path: string, address: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${POLY_DATA_API}${path}`);
  url.searchParams.set("user", address);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// "2026-06-16 11:30" -> cutoff ms under both UTC and ET (EDT, -04:00) interpretations.
function parseCutoffs(arg: string | undefined): { utc: number; et: number } | null {
  if (!arg) return null;
  const iso = arg.trim().replace(" ", "T");
  const withSecs = /T\d{2}:\d{2}$/.test(iso) ? `${iso}:00` : iso;
  return { utc: Date.parse(`${withSecs}Z`), et: Date.parse(`${withSecs}-04:00`) };
}
const kalshiSettledMs = (s: Rec): number | null => { const t = Date.parse(String(s.settled_time ?? s.settled_at ?? "")); return Number.isFinite(t) ? t : null; };
// Polymarket window start is encoded in the slug, e.g. "btc-updown-15m-1781714700".
const polyWindowMs = (p: Rec): number | null => { const m = /(\d{9,})/.exec(String(p.slug ?? p.eventSlug ?? "")); return m ? Number(m[1]) * 1000 : null; };

async function main(): Promise<void> {
  const config = loadConfig();
  const out: Rec = {};
  const cutoffs = parseCutoffs(process.argv[2]);
  out.cutoff = cutoffs ? { input: process.argv[2], asUTC: new Date(cutoffs.utc).toISOString(), asET: new Date(cutoffs.et).toISOString() } : "none (lifetime)";

  // ---- KALSHI (BTC 15m) ----
  // Kalshi splits realized P&L across endpoints, so compute multiple candidates and
  // dump sample rows; we'll pick the authoritative one by comparing to the account.
  try {
    const [positions, settlements, fills] = await Promise.all([
      kalshiAll(config, "/portfolio/positions", "market_positions"),
      kalshiAll(config, "/portfolio/settlements", "settlements"),
      kalshiAll(config, "/portfolio/fills", "fills"),
    ]);
    const isBtc = (r: Rec) => KALSHI_BTC15M.test(firstStr(r, ["ticker", "market_ticker", "event_ticker"]) ?? "");
    const btcPos = positions.filter(isBtc);
    const btcSettled = settlements.filter(isBtc);
    const btcFills = fills.filter(isBtc);
    // revenue is in cents; *_total_cost and fee_cost are in dollars (confirmed from sample rows).
    const settRevenue = (s: Rec) => money(s, ["revenue"], ["revenue_dollars"]) ?? 0;
    const settCost = (s: Rec) => (firstNum(s, ["yes_total_cost_dollars"]) ?? 0) + (firstNum(s, ["no_total_cost_dollars"]) ?? 0);
    const settFee = (s: Rec) => firstNum(s, ["fee_cost", "fees_dollars"]) ?? 0;
    // Self-contained per-settlement net (robust — does NOT depend on the truncated fills feed).
    const realized_via_settlements_net = sum(btcSettled.map((s) => round(settRevenue(s) - settCost(s) - settFee(s))));
    const settledRevenue = sum(btcSettled.map(settRevenue));
    const settledCost = sum(btcSettled.map((s) => round(settCost(s))));
    const settledFees = sum(btcSettled.map(settFee));
    // Cash-flow cross-check from fills (incomplete if fills are truncated — see counts).
    const fillCash = sum(btcFills.map((f) => {
      const isSell = (firstStr(f, ["action", "side"]) ?? "").toLowerCase().includes("sell") || (firstStr(f, ["book_side"]) ?? "") === "ask";
      const outcome = (firstStr(f, ["outcome_side", "side"]) ?? "").toLowerCase();
      const price = outcome === "no" ? firstNum(f, ["no_price_dollars"]) : firstNum(f, ["yes_price_dollars"]);
      const gross = (price ?? 0) * (firstNum(f, ["count_fp", "count"]) ?? 0);
      return round((isSell ? gross : -gross) - (firstNum(f, ["fee_cost"]) ?? 0));
    }));
    const fillFees = sum(btcFills.map((f) => firstNum(f, ["fee_cost"])));
    const realized_via_cashflow = round(fillCash + settledRevenue);
    const openExposure = sum(btcPos.filter((p) => Math.abs(firstNum(p, ["position", "position_fp", "net_position"]) ?? 0) > 1e-6)
      .map((p) => money(p, ["market_value", "market_exposure"], ["market_exposure_dollars"])));
    // Per-settlement net keyed by settled_time, so we can scope to the new model.
    const netSince = (cutoffMs: number) => {
      const inWin = btcSettled.filter((s) => { const t = kalshiSettledMs(s); return t != null && t >= cutoffMs; });
      return { count: inWin.length, realizedNet: sum(inWin.map((s) => round(settRevenue(s) - settCost(s) - settFee(s)))), fees: sum(inWin.map(settFee)) };
    };
    const settledTimes = btcSettled.map(kalshiSettledMs).filter((t): t is number => t != null).sort((a, b) => a - b);
    out.kalshi = {
      counts: { positions: positions.length, btcPositions: btcPos.length, btcSettlements: btcSettled.length, btcFills: btcFills.length, fillsTruncated: btcFills.length < btcSettled.length },
      settledTimeRange: settledTimes.length ? { earliest: new Date(settledTimes[0]).toISOString(), latest: new Date(settledTimes[settledTimes.length - 1]).toISOString() } : null,
      lifetime: { realized_via_settlements_net, settledRevenue, settledCost, settledFees },
      sinceCutoff_UTC: cutoffs ? netSince(cutoffs.utc) : null,
      sinceCutoff_ET: cutoffs ? netSince(cutoffs.et) : null,
      realized_via_cashflow_fills_plus_settlement: realized_via_cashflow,
      fillFees, openExposure,
      SAMPLE_settlement: btcSettled[0] ?? settlements[0] ?? null,
    };
  } catch (e) { out.kalshi = { ERROR: e instanceof Error ? e.message : String(e) }; }

  // ---- POLYMARKET (BTC 15m) ----
  try {
    const address = config.polymarketFunderAddress?.trim()
      || privateKeyToAccount((config.polymarketPrivateKey.trim().startsWith("0x") ? config.polymarketPrivateKey.trim() : `0x${config.polymarketPrivateKey.trim()}`) as `0x${string}`).address;
    const raw = await polyGet("/positions", address, { limit: "500", sizeThreshold: "0" });
    const positions = Array.isArray(raw) ? arr(raw) : arr((raw as Rec).positions);
    const btc = positions.filter((p) => POLY_BTC.test(firstStr(p, ["title", "slug", "market"]) ?? ""));
    // A position is "ended" once its market resolved (redeemable, or curPrice pinned to 0/1).
    const isEnded = (p: Rec) => p.redeemable === true || [0, 1].includes(firstNum(p, ["curPrice"]) ?? -1);
    // realizedPnl stays 0 until on-chain redemption; cashPnl is the true settled P&L for ended positions.
    const realized = sum(btc.filter(isEnded).map((p) => firstNum(p, ["cashPnl", "cash_pnl"])));
    const realizedPnl_redeemedOnly = sum(btc.map((p) => firstNum(p, ["realizedPnl", "realized_pnl"])));
    const openExposure = sum(btc.filter((p) => !isEnded(p) && (firstNum(p, ["size"]) ?? 0) > 1e-6)
      .map((p) => firstNum(p, ["currentValue", "current_value", "value"])));
    const unredeemed = btc.filter((p) => p.redeemable === true);
    const polyNetSince = (cutoffMs: number) => {
      const inWin = btc.filter(isEnded).filter((p) => { const t = polyWindowMs(p); return t != null && t >= cutoffMs; });
      return { count: inWin.length, realized: sum(inWin.map((p) => firstNum(p, ["cashPnl", "cash_pnl"]))) };
    };
    const polyTimes = btc.map(polyWindowMs).filter((t): t is number => t != null).sort((a, b) => a - b);
    out.polymarket = {
      address, btcPositions: btc.length, totalPositions: positions.length, endedCount: btc.filter(isEnded).length, unredeemedCount: unredeemed.length,
      windowRange: polyTimes.length ? { earliest: new Date(polyTimes[0]).toISOString(), latest: new Date(polyTimes[polyTimes.length - 1]).toISOString() } : null,
      lifetime: { realizedTakeHome_netFees: realized, realizedPnl_redeemedOnly, openExposure },
      sinceCutoff_UTC: cutoffs ? polyNetSince(cutoffs.utc) : null,
      sinceCutoff_ET: cutoffs ? polyNetSince(cutoffs.et) : null,
      SAMPLE_position: btc[0] ?? positions[0] ?? null,
    };
  } catch (e) { out.polymarket = { ERROR: e instanceof Error ? e.message : String(e) }; }

  const kLife = (out.kalshi as Rec)?.lifetime as Rec | undefined;
  const pLife = (out.polymarket as Rec)?.lifetime as Rec | undefined;
  const kUtc = (out.kalshi as Rec)?.sinceCutoff_UTC as Rec | null | undefined;
  const kEt = (out.kalshi as Rec)?.sinceCutoff_ET as Rec | null | undefined;
  const pUtc = (out.polymarket as Rec)?.sinceCutoff_UTC as Rec | null | undefined;
  const pEt = (out.polymarket as Rec)?.sinceCutoff_ET as Rec | null | undefined;
  const n = (v: unknown) => typeof v === "number" ? v : 0;
  out.COMBINED = {
    NOTE: "Kalshi settlement-net is the robust source. Combined = Kalshi realized + Polymarket cashPnl. sinceCutoff = new-model take-home; pick UTC or ET per how you meant the cutoff.",
    lifetime_realizedTakeHome_netFees: round(n(kLife?.realized_via_settlements_net) + n(pLife?.realizedTakeHome_netFees)),
    newModel_sinceCutoff_UTC: cutoffs ? { realizedTakeHome_netFees: round(n(kUtc?.realizedNet) + n(pUtc?.realized)), kalshi: round(n(kUtc?.realizedNet)), kalshiFees: round(n(kUtc?.fees)), polymarket: round(n(pUtc?.realized)), kalshiSettlements: kUtc?.count ?? 0, polyPositions: pUtc?.count ?? 0 } : null,
    newModel_sinceCutoff_ET: cutoffs ? { realizedTakeHome_netFees: round(n(kEt?.realizedNet) + n(pEt?.realized)), kalshi: round(n(kEt?.realizedNet)), kalshiFees: round(n(kEt?.fees)), polymarket: round(n(pEt?.realized)), kalshiSettlements: kEt?.count ?? 0, polyPositions: pEt?.count ?? 0 } : null,
    openExposure_markedToMarket: round(n((pLife as Rec)?.openExposure) + n((out.kalshi as Rec)?.openExposure)),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
