import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import { getKalshiHeaders } from "../kalshi/auth";
import { logEvent } from "../logger";
import type { BinaryContract } from "../types";

interface KalshiMarket {
  ticker?: string;
  market_ticker?: string;
  title?: string;
  subtitle?: string;
  strike?: unknown;
  floor_strike?: unknown;
  target_price?: unknown;
  close_time?: unknown;
  expiration_time?: unknown;
  expected_expiration_time?: unknown;
  status?: string;
}

function numberFrom(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function timeFrom(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value > 1_000_000_000_000 ? value : value * 1000;
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function strikeFromText(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const matches = value.matchAll(/\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g);
    for (const match of matches) {
      const parsed = numberFrom(match[1]);
      if (parsed != null && parsed > 1000) return parsed;
    }
  }
  return null;
}

function marketStrike(market: KalshiMarket): number | null {
  return (
    numberFrom(market.floor_strike) ??
    numberFrom(market.strike) ??
    numberFrom(market.target_price) ??
    strikeFromText(market.subtitle, market.title)
  );
}

function marketExpiry(market: KalshiMarket): number | null {
  return timeFrom(market.expiration_time, market.expected_expiration_time, market.close_time);
}

function marketsPath(config: AppConfig): { url: URL; signPath: string } {
  const base = new URL(config.kalshiApiBase);
  const basePath = base.pathname.replace(/\/$/, "");
  base.pathname = `${basePath}/markets`;
  base.searchParams.set("series_ticker", config.kalshiSeriesTicker);
  base.searchParams.set("status", "open");
  return { url: base, signPath: `${base.pathname}${base.search}` };
}

export async function discoverKalshiBtcContracts(config: AppConfig = loadConfig(), now = Date.now()): Promise<BinaryContract[]> {
  const { url, signPath } = marketsPath(config);
  const response = await fetch(url, { headers: getKalshiHeaders("GET", signPath) });
  if (!response.ok) throw new Error(`Kalshi discovery failed ${response.status}: ${await response.text()}`);
  const payload = await response.json() as { markets?: KalshiMarket[] };
  const markets = Array.isArray(payload.markets) ? payload.markets : [];
  const contracts: BinaryContract[] = [];

  for (const market of markets) {
    const contractId = market.ticker ?? market.market_ticker;
    const strike = marketStrike(market);
    const expiryMs = marketExpiry(market);
    if (!contractId || strike == null || expiryMs == null) continue;
    contracts.push({
      venue: "kalshi",
      contractId,
      asset: "BTC",
      expiryMs,
      strike,
      yesAsk: null,
      noAsk: null,
      yesBid: null,
      noBid: null,
      title: market.title ?? null,
      updatedAt: now,
    });
  }

  logEvent({ category: "DISCOVERY", message: "Kalshi contracts discovered", context: { count: contracts.length } });
  return contracts;
}
