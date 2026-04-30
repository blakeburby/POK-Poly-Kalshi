import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import { logEvent } from "../logger";
import type { BinaryContract } from "../types";

interface PolymarketMarket {
  id?: string;
  conditionId?: string;
  condition_id?: string;
  slug?: string;
  question?: string;
  title?: string;
  description?: string;
  active?: boolean;
  closed?: boolean;
  endDate?: unknown;
  end_date?: unknown;
  game_start_time?: unknown;
  line?: unknown;
  strike?: unknown;
  priceToBeat?: unknown;
  price_to_beat?: unknown;
  outcomes?: unknown;
  clobTokenIds?: unknown;
  clob_token_ids?: unknown;
}

function arrayFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value.split(",").map((part) => part.trim()).filter(Boolean);
  }
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

function marketText(market: PolymarketMarket): string {
  return [market.question, market.title, market.description, market.slug].filter(Boolean).join(" ");
}

function isBtc15MinuteMarket(market: PolymarketMarket): boolean {
  const text = marketText(market);
  return /BTC|Bitcoin/i.test(text) && /(15\s?m|15-minute|15 minute|up or down)/i.test(text);
}

function outcomeTokenIds(market: PolymarketMarket): { yesTokenId: string | null; noTokenId: string | null } {
  const outcomes = arrayFrom(market.outcomes);
  const tokenIds = arrayFrom(market.clobTokenIds ?? market.clob_token_ids);
  let yesTokenId: string | null = null;
  let noTokenId: string | null = null;
  for (let index = 0; index < tokenIds.length; index += 1) {
    const outcome = outcomes[index]?.toLowerCase() ?? "";
    if (["yes", "up"].includes(outcome)) yesTokenId = tokenIds[index] ?? null;
    if (["no", "down"].includes(outcome)) noTokenId = tokenIds[index] ?? null;
  }
  return { yesTokenId: yesTokenId ?? tokenIds[0] ?? null, noTokenId: noTokenId ?? tokenIds[1] ?? null };
}

function contractsFromMarkets(markets: PolymarketMarket[], now: number): BinaryContract[] {
  const contracts: BinaryContract[] = [];
  const seen = new Set<string>();

  for (const market of markets) {
    if (market.active === false || market.closed === true || !isBtc15MinuteMarket(market)) continue;
    const strike =
      numberFrom(market.priceToBeat) ??
      numberFrom(market.price_to_beat) ??
      numberFrom(market.line) ??
      numberFrom(market.strike) ??
      strikeFromText(market.question, market.title, market.description);
    const expiryMs = timeFrom(market.endDate, market.end_date, market.game_start_time);
    const contractId = market.conditionId ?? market.condition_id ?? market.id ?? market.slug;
    const { yesTokenId, noTokenId } = outcomeTokenIds(market);
    if (!contractId || seen.has(contractId) || strike == null || expiryMs == null || !yesTokenId || !noTokenId) continue;
    seen.add(contractId);
    contracts.push({
      venue: "polymarket",
      contractId,
      asset: "BTC",
      expiryMs,
      strike,
      yesAsk: null,
      noAsk: null,
      yesBid: null,
      noBid: null,
      yesTokenId,
      noTokenId,
      title: market.question ?? market.title ?? null,
      marketSlug: market.slug ?? null,
      updatedAt: now,
    });
  }

  return contracts;
}

async function fetchMarkets(url: string): Promise<PolymarketMarket[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Polymarket discovery failed ${response.status}: ${await response.text()}`);
  const payload = await response.json() as PolymarketMarket[] | { data?: PolymarketMarket[]; markets?: PolymarketMarket[] };
  return Array.isArray(payload) ? payload : payload.data ?? payload.markets ?? [];
}

async function discoverPolymarketBtc15mBySlug(now: number): Promise<PolymarketMarket[]> {
  const windowMs = 15 * 60 * 1000;
  const currentWindowStart = Math.floor(now / windowMs) * windowMs;
  const starts = [-1, 0, 1, 2, 3, 4].map((offset) => Math.floor((currentWindowStart + offset * windowMs) / 1000));
  const batches = await Promise.allSettled(
    starts.map((start) => fetchMarkets(`https://gamma-api.polymarket.com/markets?slug=btc-updown-15m-${start}&active=true&closed=false`)),
  );
  const markets = batches.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (markets.length > 0) {
    logEvent({ category: "DISCOVERY", message: "Polymarket BTC 15m slug fallback discovered markets", context: { count: markets.length } });
  }
  return markets;
}

export async function discoverPolymarketBtcContracts(config: AppConfig = loadConfig(), now = Date.now()): Promise<BinaryContract[]> {
  const markets = await fetchMarkets(config.polymarketDiscoveryUrl);
  let contracts = contractsFromMarkets(markets, now);
  if (contracts.length === 0) {
    const fallbackMarkets = await discoverPolymarketBtc15mBySlug(now);
    contracts = contractsFromMarkets(fallbackMarkets, now);
    if (fallbackMarkets.length > 0 && contracts.length === 0) {
      logEvent({
        severity: "WARN",
        category: "DISCOVERY",
        message: "Polymarket BTC 15m markets found without price-to-beat strike",
        context: { count: fallbackMarkets.length },
      });
    }
  }

  logEvent({ category: "DISCOVERY", message: "Polymarket contracts discovered", context: { count: contracts.length } });
  return contracts;
}
