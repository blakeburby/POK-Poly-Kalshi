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

export async function discoverPolymarketBtcContracts(config: AppConfig = loadConfig(), now = Date.now()): Promise<BinaryContract[]> {
  const response = await fetch(config.polymarketDiscoveryUrl);
  if (!response.ok) throw new Error(`Polymarket discovery failed ${response.status}: ${await response.text()}`);
  const payload = await response.json() as PolymarketMarket[] | { data?: PolymarketMarket[]; markets?: PolymarketMarket[] };
  const markets = Array.isArray(payload) ? payload : payload.data ?? payload.markets ?? [];
  const contracts: BinaryContract[] = [];

  for (const market of markets) {
    if (market.active === false || market.closed === true || !isBtc15MinuteMarket(market)) continue;
    const strike = numberFrom(market.line) ?? numberFrom(market.strike) ?? strikeFromText(market.question, market.title, market.description, market.slug);
    const expiryMs = timeFrom(market.endDate, market.end_date, market.game_start_time);
    const contractId = market.conditionId ?? market.condition_id ?? market.id ?? market.slug;
    const { yesTokenId, noTokenId } = outcomeTokenIds(market);
    if (!contractId || strike == null || expiryMs == null || !yesTokenId || !noTokenId) continue;
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

  logEvent({ category: "DISCOVERY", message: "Polymarket contracts discovered", context: { count: contracts.length } });
  return contracts;
}
