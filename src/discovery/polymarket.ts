import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import type {
  PolymarketPriceBeatRecord,
  PolymarketPriceBeatRepository,
  PolymarketPriceBeatSource,
} from "../db/polymarket-price-beats";
import { logEvent } from "../logger";
import type {
  BinaryContract,
  PolymarketDiagnostics,
  PolymarketMarketDiagnostic,
  PolymarketStrikeStatus,
} from "../types";
import type { PolymarketPriceBeatWindow } from "../polymarket/price-to-beat";

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
  startDate?: unknown;
  start_date?: unknown;
  eventStartTime?: unknown;
  event_start_time?: unknown;
  game_start_time?: unknown;
  priceToBeat?: unknown;
  price_to_beat?: unknown;
  eventMetadata?: unknown;
  event_metadata?: unknown;
  outcomes?: unknown;
  clobTokenIds?: unknown;
  clob_token_ids?: unknown;
}

export interface PolymarketDiscoveryResult {
  contracts: BinaryContract[];
  captureWindows: PolymarketPriceBeatWindow[];
  diagnostics: PolymarketDiagnostics;
}

export interface PolymarketDiscoveryDependencies {
  priceBeatStore?: PolymarketPriceBeatRepository;
  fetchFn?: typeof fetch;
  pageBaseUrl?: string;
}

function arrayFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
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
      const numeric = numberFrom(value);
      if (numeric != null && /^\d+(\.\d+)?$/.test(value.trim()))
        return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function marketText(market: PolymarketMarket): string {
  return [market.question, market.title, market.description, market.slug].filter(Boolean).join(" ");
}

function isBtc15MinuteMarket(market: PolymarketMarket): boolean {
  const text = marketText(market);
  return /BTC|Bitcoin/i.test(text) && /(15\s?m|15-minute|15 minute|up or down|updown)/i.test(text);
}

function slugStartMs(slug: string | undefined): number | null {
  const match = slug?.match(/btc-updown-15m-(\d{10,13})$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function eventStartMsForMarket(market: PolymarketMarket): number | null {
  return (
    slugStartMs(market.slug) ??
    timeFrom(market.startDate, market.start_date, market.eventStartTime, market.event_start_time)
  );
}

function expiryMsForMarket(market: PolymarketMarket, eventStartMs: number | null): number | null {
  return (
    timeFrom(market.endDate, market.end_date, market.game_start_time) ??
    (eventStartMs == null ? null : eventStartMs + 15 * 60_000)
  );
}

function conditionId(market: PolymarketMarket): string | null {
  return market.conditionId ?? market.condition_id ?? market.id ?? null;
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

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function eventMetadataPriceToBeat(value: unknown): number | null {
  const metadata = parseMetadata(value);
  if (!metadata) return null;
  return numberFrom(metadata.priceToBeat ?? metadata.price_to_beat);
}

function directPriceToBeat(market: PolymarketMarket): number | null {
  return (
    numberFrom(market.priceToBeat) ??
    numberFrom(market.price_to_beat) ??
    eventMetadataPriceToBeat(market.eventMetadata ?? market.event_metadata)
  );
}

function uniqueMarkets(markets: PolymarketMarket[]): PolymarketMarket[] {
  const seen = new Set<string>();
  const unique: PolymarketMarket[] = [];
  for (const market of markets) {
    const key = conditionId(market) ?? market.slug ?? market.question ?? market.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(market);
  }
  return unique;
}

function discoveryStarts(config: AppConfig, now: number): number[] {
  const windowMs = 15 * 60 * 1000;
  const currentWindowStart = Math.floor(now / windowMs) * windowMs;
  return config.polymarketDiscoveryWindowOffsets.map((offset) => currentWindowStart + offset * windowMs);
}

function diagnostic(
  market: PolymarketMarket,
  status: PolymarketStrikeStatus,
  reason: string,
  priceToBeat: number | null,
  source: string | null,
): PolymarketMarketDiagnostic {
  const eventStartMs = eventStartMsForMarket(market);
  const expiryMs = expiryMsForMarket(market, eventStartMs);
  return {
    marketSlug: market.slug ?? conditionId(market) ?? "unknown",
    conditionId: conditionId(market),
    eventStartMs,
    expiryMs,
    priceToBeat,
    strikeSource: source,
    status,
    reason,
  };
}

export function emptyPolymarketDiagnostics(): PolymarketDiagnostics {
  return {
    marketsFound: 0,
    readyContracts: 0,
    pendingStrikeCount: 0,
    missingStrikeCount: 0,
    invalidMarketCount: 0,
    lastChainlinkTickAt: null,
    lastChainlinkTickAgeMs: null,
    nextCaptureWindowStartMs: null,
    skippedReasons: [],
    markets: [],
  };
}

async function fetchMarkets(url: string, fetchFn: typeof fetch): Promise<PolymarketMarket[]> {
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`Polymarket discovery failed ${response.status}: ${await response.text()}`);
  const payload = (await response.json()) as
    | PolymarketMarket[]
    | { data?: PolymarketMarket[]; markets?: PolymarketMarket[] };
  return Array.isArray(payload) ? payload : (payload.data ?? payload.markets ?? []);
}

async function discoverPolymarketBtc15mBySlug(
  config: AppConfig,
  now: number,
  fetchFn: typeof fetch,
): Promise<{ markets: PolymarketMarket[]; errors: string[] }> {
  const starts = discoveryStarts(config, now);
  const batches = await Promise.allSettled(
    starts.map((startMs) =>
      fetchMarkets(
        `https://gamma-api.polymarket.com/markets?slug=btc-updown-15m-${Math.floor(startMs / 1000)}&active=true&closed=false`,
        fetchFn,
      ),
    ),
  );
  const markets = batches.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const errors = batches
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
  if (markets.length > 0) {
    logEvent({
      category: "DISCOVERY",
      message: "Polymarket BTC 15m slug fallback discovered markets",
      context: { count: markets.length },
    });
  }
  return { markets, errors };
}

function findEventMetadataPriceToBeat(value: unknown): number | null {
  const fromMetadata = eventMetadataPriceToBeat(
    (value as { eventMetadata?: unknown; event_metadata?: unknown })?.eventMetadata ??
      (value as { event_metadata?: unknown })?.event_metadata,
  );
  if (fromMetadata != null) return fromMetadata;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEventMetadataPriceToBeat(item);
      if (found != null) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findEventMetadataPriceToBeat(child);
    if (found != null) return found;
  }
  return null;
}

function objectsWithSlug(value: unknown, slug: string, matches: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) objectsWithSlug(item, slug, matches);
    return matches;
  }
  if (!value || typeof value !== "object") return matches;
  const candidate = value as Record<string, unknown>;
  if (candidate.slug === slug || candidate.marketSlug === slug) matches.push(candidate);
  for (const child of Object.values(candidate)) objectsWithSlug(child, slug, matches);
  return matches;
}

export function extractPolymarketPagePriceToBeat(html: string, marketSlug: string): number | null {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    const pageData = JSON.parse(match[1]);
    for (const candidate of objectsWithSlug(pageData, marketSlug)) {
      const found = findEventMetadataPriceToBeat(candidate);
      if (found != null) return found;
    }
  } catch {
    return null;
  }
  return null;
}

async function backfillPagePriceToBeat(
  marketSlug: string,
  fetchFn: typeof fetch,
  pageBaseUrl: string,
): Promise<number | null> {
  const response = await fetchFn(`${pageBaseUrl.replace(/\/$/, "")}/event/${marketSlug}`);
  if (!response.ok) return null;
  return extractPolymarketPagePriceToBeat(await response.text(), marketSlug);
}

async function persistPriceBeat(
  store: PolymarketPriceBeatRepository | undefined,
  market: PolymarketMarket,
  priceToBeat: number,
  source: PolymarketPriceBeatSource,
  sourceTimestampMs: number | null,
): Promise<void> {
  if (!store || !market.slug) return;
  const eventStartMs = eventStartMsForMarket(market);
  const expiryMs = expiryMsForMarket(market, eventStartMs);
  if (eventStartMs == null || expiryMs == null) return;
  await store.upsert({
    marketSlug: market.slug,
    conditionId: conditionId(market),
    eventStartMs,
    expiryMs,
    priceToBeat,
    source,
    sourceTimestampMs,
  });
}

async function evaluateMarket(
  market: PolymarketMarket,
  storeRecord: PolymarketPriceBeatRecord | null,
  config: AppConfig,
  now: number,
  deps: Required<Pick<PolymarketDiscoveryDependencies, "fetchFn" | "pageBaseUrl">> &
    Pick<PolymarketDiscoveryDependencies, "priceBeatStore">,
): Promise<{
  contract: BinaryContract | null;
  captureWindow: PolymarketPriceBeatWindow | null;
  diagnostic: PolymarketMarketDiagnostic;
}> {
  const marketSlug = market.slug;
  const marketConditionId = conditionId(market);
  const eventStartMs = eventStartMsForMarket(market);
  const expiryMs = expiryMsForMarket(market, eventStartMs);
  const { yesTokenId, noTokenId } = outcomeTokenIds(market);

  if (!marketSlug || !marketConditionId || eventStartMs == null || expiryMs == null || !yesTokenId || !noTokenId) {
    return {
      contract: null,
      captureWindow: null,
      diagnostic: diagnostic(
        market,
        "invalid_market",
        "missing slug, condition id, expiry, event start, or token ids",
        null,
        null,
      ),
    };
  }

  let priceToBeat = storeRecord?.priceToBeat ?? null;
  let source = storeRecord?.source ?? null;
  const direct = directPriceToBeat(market);
  if (priceToBeat == null && direct != null) {
    priceToBeat = direct;
    source = "gamma";
    await persistPriceBeat(deps.priceBeatStore, market, direct, "gamma", eventStartMs);
  }

  if (
    priceToBeat == null &&
    config.polymarketMissedOpenBackfill &&
    now > eventStartMs + config.polymarketPriceCaptureToleranceMs
  ) {
    const pageStrike = await backfillPagePriceToBeat(marketSlug, deps.fetchFn, deps.pageBaseUrl);
    if (pageStrike != null) {
      priceToBeat = pageStrike;
      source = "page_metadata";
      await persistPriceBeat(deps.priceBeatStore, market, pageStrike, "page_metadata", eventStartMs);
    }
  }

  if (priceToBeat != null) {
    return {
      captureWindow: null,
      diagnostic: diagnostic(market, "ready", "strike hydrated", priceToBeat, source),
      contract: {
        venue: "polymarket",
        contractId: marketConditionId,
        asset: "BTC",
        expiryMs,
        strike: priceToBeat,
        yesAsk: null,
        noAsk: null,
        yesBid: null,
        noBid: null,
        yesTokenId,
        noTokenId,
        title: market.question ?? market.title ?? null,
        marketSlug,
        updatedAt: now,
      },
    };
  }

  const captureWindow = expiryMs > now ? { marketSlug, conditionId: marketConditionId, eventStartMs, expiryMs } : null;
  const status: PolymarketStrikeStatus =
    now <= eventStartMs + config.polymarketPriceCaptureToleranceMs ? "pending_strike" : "missing_strike";
  const reason =
    status === "pending_strike"
      ? "waiting for first Polymarket Chainlink tick at window open"
      : "no exact price-to-beat in store or page metadata";
  return {
    contract: null,
    captureWindow,
    diagnostic: diagnostic(market, status, reason, null, null),
  };
}

export async function discoverPolymarketBtcContractsWithDiagnostics(
  config: AppConfig = loadConfig(),
  now = Date.now(),
  dependencies: PolymarketDiscoveryDependencies = {},
): Promise<PolymarketDiscoveryResult> {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const pageBaseUrl = dependencies.pageBaseUrl ?? "https://polymarket.com";
  const skippedReasons = new Set<string>();

  let baseMarkets: PolymarketMarket[] = [];
  try {
    baseMarkets = await fetchMarkets(config.polymarketDiscoveryUrl, fetchFn);
  } catch (error) {
    skippedReasons.add(error instanceof Error ? error.message : String(error));
  }
  const slugDiscovery = await discoverPolymarketBtc15mBySlug(config, now, fetchFn);
  for (const error of slugDiscovery.errors) skippedReasons.add(error);

  const markets = uniqueMarkets([...baseMarkets, ...slugDiscovery.markets]).filter(
    (market) => market.active !== false && market.closed !== true && isBtc15MinuteMarket(market),
  );
  const marketSlugs = markets.map((market) => market.slug).filter((slug): slug is string => Boolean(slug));
  const stored = dependencies.priceBeatStore
    ? await dependencies.priceBeatStore.getBySlugs(marketSlugs)
    : new Map<string, PolymarketPriceBeatRecord>();

  const contracts: BinaryContract[] = [];
  const captureWindows: PolymarketPriceBeatWindow[] = [];
  const diagnostics: PolymarketMarketDiagnostic[] = [];

  for (const market of markets) {
    const evaluated = await evaluateMarket(
      market,
      market.slug ? (stored.get(market.slug) ?? null) : null,
      config,
      now,
      {
        fetchFn,
        pageBaseUrl,
        priceBeatStore: dependencies.priceBeatStore,
      },
    );
    if (evaluated.contract) contracts.push(evaluated.contract);
    if (evaluated.captureWindow) captureWindows.push(evaluated.captureWindow);
    diagnostics.push(evaluated.diagnostic);
    if (evaluated.diagnostic.status !== "ready") skippedReasons.add(evaluated.diagnostic.reason);
  }

  const resultDiagnostics: PolymarketDiagnostics = {
    ...emptyPolymarketDiagnostics(),
    marketsFound: markets.length,
    readyContracts: contracts.length,
    pendingStrikeCount: diagnostics.filter((item) => item.status === "pending_strike").length,
    missingStrikeCount: diagnostics.filter((item) => item.status === "missing_strike").length,
    invalidMarketCount: diagnostics.filter((item) => item.status === "invalid_market").length,
    skippedReasons: [...skippedReasons].slice(0, 12),
    markets: diagnostics.slice(0, 32),
  };

  if (markets.length > 0 && contracts.length === 0) {
    logEvent({
      severity: "WARN",
      category: "DISCOVERY",
      message: "Polymarket BTC 15m markets found without scanner-ready strikes",
      context: {
        marketsFound: markets.length,
        pendingStrikeCount: resultDiagnostics.pendingStrikeCount,
        missingStrikeCount: resultDiagnostics.missingStrikeCount,
        skippedReasons: resultDiagnostics.skippedReasons,
      },
    });
  }
  logEvent({
    category: "DISCOVERY",
    message: "Polymarket contracts discovered",
    context: {
      count: contracts.length,
      marketsFound: markets.length,
      pendingStrikeCount: resultDiagnostics.pendingStrikeCount,
    },
  });

  return { contracts, captureWindows, diagnostics: resultDiagnostics };
}

export async function discoverPolymarketBtcContracts(
  config: AppConfig = loadConfig(),
  now = Date.now(),
): Promise<BinaryContract[]> {
  return (await discoverPolymarketBtcContractsWithDiagnostics(config, now)).contracts;
}
