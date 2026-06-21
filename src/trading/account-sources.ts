import { AssetType } from "@polymarket/clob-client-v2";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config";
import { logEvent } from "../logger";
import { getKalshiHeaders } from "../kalshi/auth";
import {
  defaultPolymarketClientFactory,
  type PolymarketClobClientBundle,
  type PolymarketClobLike,
} from "../execution/live-clients";
import type { LiveExecutionReadiness } from "../types";
import type {
  TradingActivitySnapshot,
  TradingHistoryRow,
  TradingOpenOrder,
  TradingPlatform,
  TradingPlatformActivity,
  TradingPortfolioSummary,
  TradingPosition,
  TradingSparklinePoint,
} from "../../types/trading";

type JsonRecord = Record<string, unknown>;
type FetchFn = typeof fetch;
type PolymarketClientFactory = (config: AppConfig) => Promise<PolymarketClobLike | PolymarketClobClientBundle>;

export interface AccountSourceOptions {
  config: AppConfig;
  readiness?: LiveExecutionReadiness | null;
  history: TradingHistoryRow[];
  now: number;
  fetchFn?: FetchFn;
  polymarketClientFactory?: PolymarketClientFactory;
  getPolymarketClient?: () => Promise<PolymarketClobLike>;
}

interface PlatformAccountData {
  portfolio: TradingPortfolioSummary;
  positions: TradingPosition[];
  openOrders: TradingOpenOrder[];
  history?: TradingHistoryRow[];
  sparkline?: TradingSparklinePoint[];
  lastUpdatedAt: number | null;
}

const POLYMARKET_DATA_API_BASE = "https://data-api.polymarket.com";
const KALSHI_ACCOUNT_REQUEST_TIMEOUT_MS = 3_500;
const POLYMARKET_ACCOUNT_REQUEST_TIMEOUT_MS = 3_500;

function logPolymarketAccountWarn(source: string, error: unknown): void {
  logEvent({
    severity: "WARN",
    category: "POLYMARKET",
    message: "polymarket account sub-fetch failed; degrading instead of dropping the venue",
    context: { source, error: error instanceof Error ? error.message : String(error) },
  });
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function firstNumber(record: JsonRecord | null | undefined, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = numberOrNull(record[key]);
    if (value != null) return value;
  }
  return null;
}

function firstMoney(record: JsonRecord | null | undefined, centsKeys: string[], dollarKeys: string[]): number | null {
  const dollarValue = firstNumber(record, dollarKeys);
  if (dollarValue != null) return rounded(dollarValue);
  const centsValue = firstNumber(record, centsKeys);
  return centsToDollars(centsValue);
}

function firstString(record: JsonRecord | null | undefined, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = stringOrNull(record[key]);
    if (value) return value;
  }
  return null;
}

function rounded(value: number | null): number | null {
  return value == null ? null : Math.round(value * 1_000_000) / 1_000_000;
}

function centsToDollars(value: number | null): number | null {
  return value == null ? null : rounded(value / 100);
}

function usdcRawToDollars(value: number | null): number | null {
  if (value == null) return null;
  return value > 10_000 ? rounded(value / 1_000_000) : rounded(value);
}

function priceFromUnknown(value: unknown): number | null {
  const parsed = numberOrNull(value);
  if (parsed == null) return null;
  return parsed > 1 ? rounded(parsed / 100) : rounded(parsed);
}

function centsFieldToDollars(record: JsonRecord | null | undefined, keys: string[]): number | null {
  const value = firstNumber(record, keys);
  return centsToDollars(value);
}

function timestampMs(value: unknown): number | null {
  const numeric = numberOrNull(value);
  if (numeric != null) return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  const text = stringOrNull(value);
  if (!text) return null;
  const parsed = new Date(text).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function accountSparkline(value: number | null, now: number, dayChangeDollars: number | null = null): TradingSparklinePoint[] {
  const y = value ?? 0;
  const start = value != null && dayChangeDollars != null ? rounded(value - dayChangeDollars) ?? y : y;
  return [
    { timestamp: now - 24 * 60 * 60_000, value: start },
    { timestamp: now, value: y },
  ];
}

async function fetchJson(fetchFn: FetchFn, url: URL, init?: RequestInit): Promise<unknown> {
  const response = await fetchFn(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url.pathname} failed ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) as unknown : {};
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchJsonWithTimeout(fetchFn: FetchFn, url: URL, init: RequestInit | undefined, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchJson(fetchFn, url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchKalshiJson(config: AppConfig, fetchFn: FetchFn, path: string, search?: URLSearchParams): Promise<unknown> {
  const url = new URL(config.kalshiApiBase);
  const basePath = url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}${path}`;
  if (search) url.search = search.toString();
  const signPath = `${url.pathname}${url.search}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KALSHI_ACCOUNT_REQUEST_TIMEOUT_MS);
  try {
    return await fetchJson(fetchFn, url, { method: "GET", headers: getKalshiHeaders("GET", signPath), signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function rowsFromPayload(payload: unknown, keys: string[]): JsonRecord[] {
  if (Array.isArray(payload)) return payload.map(asRecord).filter((row): row is JsonRecord => row != null);
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of keys) {
    const rows = asArray(record[key]).map(asRecord).filter((row): row is JsonRecord => row != null);
    if (rows.length > 0) return rows;
  }
  return [];
}

function normalizeKalshiBalance(payload: unknown, platform: TradingPlatform, now: number): TradingPortfolioSummary {
  const record = asRecord(payload);
  const breakdownCash = rowsFromPayload(record?.balance_breakdown, [])
    .reduce((total, row) => total + (firstNumber(row, ["balance"]) ?? 0), 0);
  const cashValue = firstMoney(
    record,
    ["balance", "available_balance", "available_balance_cents", "cash_balance", "cash_balance_cents", "cash"],
    ["balance_dollars", "available_balance_dollars", "cash_balance_dollars", "cash_dollars"],
  ) ?? (breakdownCash > 0 ? rounded(breakdownCash) : null);
  const portfolioValue = firstMoney(
    record,
    ["portfolio_value", "portfolioValue", "portfolio_value_cents", "equity", "total_value"],
    ["portfolio_value_dollars", "portfolioValueDollars", "equity_dollars", "total_value_dollars"],
  ) ?? cashValue;
  return {
    platform,
    portfolioValue,
    cashValue,
    dayChangeDollars: null,
    dayChangePercent: null,
    lastUpdatedAt: timestampMs(record?.updated_ts) ?? now,
  };
}

function normalizeKalshiPosition(row: JsonRecord, now: number): TradingPosition | null {
  const ticker = firstString(row, ["ticker", "market_ticker", "marketTicker", "event_ticker", "eventTicker"]);
  if (!ticker) return null;
  const rawPosition = firstNumber(row, ["position", "position_fp", "net_position", "netPosition", "count"]);
  const yesCount = firstNumber(row, ["yes_count", "yesCount", "yes_count_fp"]);
  const noCount = firstNumber(row, ["no_count", "noCount", "no_count_fp"]);
  const signedShares = rawPosition ?? (yesCount != null && noCount != null ? yesCount - noCount : yesCount ?? (noCount == null ? null : -noCount));
  if (signedShares == null || Math.abs(signedShares) < 0.000001) return null;
  const shares = Math.abs(signedShares);
  const outcome = firstString(row, ["outcome", "side", "contract_side"]) ?? (signedShares >= 0 ? "YES" : "NO");
  const value = firstMoney(
    row,
    ["market_value", "marketValue", "value", "exposure", "market_exposure"],
    ["market_exposure_dollars", "event_exposure_dollars", "value_dollars", "exposure_dollars"],
  );
  const averagePrice = priceFromUnknown(firstNumber(row, ["average_price", "avg_price", "avgPrice", "price"]))
    ?? (value == null || shares <= 0 ? null : rounded(Math.abs(value) / shares));
  return {
    id: ticker,
    market: ticker,
    outcome: outcome.toUpperCase(),
    shares,
    value,
    averagePrice,
    updatedAt: timestampMs(row.last_updated_ts ?? row.updated_at ?? row.update_time ?? row.ts) ?? now,
  };
}

function normalizeKalshiOpenOrder(row: JsonRecord, now: number): TradingOpenOrder | null {
  const id = firstString(row, ["order_id", "orderId", "client_order_id", "clientOrderId"]);
  const market = firstString(row, ["ticker", "market_ticker", "marketTicker"]);
  if (!id || !market) return null;
  const count = firstNumber(row, ["remaining_count", "remainingCount", "remaining_count_fp", "count", "original_count", "initial_count_fp"]);
  if (count == null || count <= 0) return null;
  const action = firstString(row, ["action", "side"]) ?? "buy";
  const rawSide = action.toLowerCase();
  const yesPrice = priceFromUnknown(row.yes_price_dollars ?? row.yes_price ?? row.price);
  const noPrice = priceFromUnknown(row.no_price_dollars ?? row.no_price);
  const outcome = firstString(row, ["outcome_side", "contract_side", "outcome"]) ?? (rawSide === "ask" ? "NO" : "YES");
  const price = outcome.toLowerCase() === "no" ? (noPrice ?? (yesPrice == null ? null : rounded(1 - yesPrice))) : yesPrice;
  return {
    id,
    market,
    outcome: outcome.toUpperCase(),
    side: rawSide.includes("sell") || rawSide === "ask" ? "Sell" : "Buy",
    shares: count,
    price,
    value: price == null ? null : rounded(count * price),
    status: firstString(row, ["status"]) ?? "open",
    updatedAt: timestampMs(row.last_update_time ?? row.updated_at ?? row.created_time ?? row.created_at) ?? now,
  };
}

function normalizeKalshiFill(row: JsonRecord, now: number): TradingHistoryRow | null {
  const id = firstString(row, ["trade_id", "fill_id", "order_id", "id"]) ?? `${firstString(row, ["ticker"]) ?? "kalshi"}-${now}`;
  const marketName = firstString(row, ["ticker", "market_ticker", "marketTicker"]);
  if (!marketName) return null;
  const shares = firstNumber(row, ["count", "count_fp", "fill_count", "fillCount", "fill_count_fp"]);
  if (shares == null || shares <= 0) return null;
  const action = (firstString(row, ["action", "side"]) ?? "buy").toLowerCase();
  const outcome = (firstString(row, ["outcome_side", "contract_side", "outcome", "side"]) ?? "OUTCOME").toUpperCase();
  const price = outcome.toLowerCase() === "no"
    ? priceFromUnknown(row.no_price_dollars ?? row.no_price ?? row.price)
    : priceFromUnknown(row.yes_price_dollars ?? row.yes_price ?? row.price);
  const value = price == null ? null : rounded(shares * price);
  const activity = action.includes("sell") || action === "ask" ? "Sell" : "Buy";
  return {
    id,
    activity,
    marketName,
    outcome,
    shares,
    value: value == null ? null : activity === "Buy" ? -value : value,
    timeMs: timestampMs(row.created_time ?? row.created_at ?? row.ts) ?? now,
    venueOrderId: firstString(row, ["order_id", "orderId"]),
    clientOrderId: firstString(row, ["client_order_id", "clientOrderId"]),
    status: "filled",
  };
}

async function kalshiAccountActivity(options: AccountSourceOptions): Promise<PlatformAccountData> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now;
  const [balancePayload, positionsPayload, ordersPayload, fillsPayload] = await Promise.all([
    fetchKalshiJson(options.config, fetchFn, "/portfolio/balance"),
    fetchKalshiJson(options.config, fetchFn, "/portfolio/positions", new URLSearchParams({ limit: "500", count_filter: "position" })),
    fetchKalshiJson(options.config, fetchFn, "/portfolio/orders", new URLSearchParams({ limit: "100", status: "resting" })),
    fetchKalshiJson(options.config, fetchFn, "/portfolio/fills", new URLSearchParams({ limit: "100" })).catch(() => null),
  ]);
  const portfolio = normalizeKalshiBalance(balancePayload, "kalshi", now);
  const positions = rowsFromPayload(positionsPayload, ["market_positions", "positions"])
    .map((row) => normalizeKalshiPosition(row, now))
    .filter((row): row is TradingPosition => row != null)
    .sort((left, right) => (right.value ?? 0) - (left.value ?? 0));
  const positionValue = positions.reduce((total, position) => total + (position.value ?? 0), 0);
  if ((portfolio.portfolioValue == null || portfolio.portfolioValue <= 0) && portfolio.cashValue != null) {
    portfolio.portfolioValue = rounded(portfolio.cashValue + positionValue);
  }
  const openOrders = rowsFromPayload(ordersPayload, ["orders"])
    .map((row) => normalizeKalshiOpenOrder(row, now))
    .filter((row): row is TradingOpenOrder => row != null);
  const apiHistory = rowsFromPayload(fillsPayload, ["fills"])
    .map((row) => normalizeKalshiFill(row, now))
    .filter((row): row is TradingHistoryRow => row != null);
  return {
    portfolio,
    positions,
    openOrders,
    history: apiHistory.length > 0 ? apiHistory : undefined,
    sparkline: accountSparkline(portfolio.portfolioValue, now, portfolio.dayChangeDollars),
    lastUpdatedAt: now,
  };
}

function normalizePrivateKey(privateKey: string): `0x${string}` {
  const trimmed = privateKey.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

function polymarketAccountAddress(config: AppConfig): string | null {
  if (config.polymarketFunderAddress.trim()) return config.polymarketFunderAddress.trim();
  if (!config.polymarketPrivateKey.trim()) return null;
  return privateKeyToAccount(normalizePrivateKey(config.polymarketPrivateKey)).address;
}

async function polymarketDataApi(path: string, address: string, fetchFn: FetchFn, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${POLYMARKET_DATA_API_BASE}${path}`);
  url.searchParams.set("user", address);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return fetchJsonWithTimeout(fetchFn, url, undefined, POLYMARKET_ACCOUNT_REQUEST_TIMEOUT_MS);
}

/** Mark-to-market of a Polymarket position = size × current price. The data-api zeroes
 *  `currentValue` for resolved/redeemable positions, which would drop unredeemed WINNERS to $0;
 *  the price-based mark keeps them valued (loser curPrice 0 -> $0, winner curPrice ~1 -> ~size). */
function polymarketPositionValue(row: JsonRecord, shares: number): number | null {
  const curPrice = firstNumber(row, ["curPrice", "cur_price"]);
  if (curPrice != null && curPrice >= 0) return shares * curPrice;
  return firstNumber(row, ["currentValue", "current_value", "value"]);
}

function normalizePolymarketPosition(row: JsonRecord, now: number): TradingPosition | null {
  const asset = firstString(row, ["asset", "token", "asset_id"]);
  const market = firstString(row, ["title", "slug", "conditionId", "condition_id"]);
  const shares = firstNumber(row, ["size", "balance", "tokens"]);
  if (!asset || !market || shares == null || Math.abs(shares) < 0.000001) return null;
  return {
    id: asset,
    market,
    outcome: firstString(row, ["outcome"]) ?? "OUTCOME",
    shares,
    value: rounded(polymarketPositionValue(row, shares)),
    averagePrice: rounded(firstNumber(row, ["avgPrice", "avg_price", "averagePrice"])),
    updatedAt: timestampMs(row.updatedAt ?? row.updateTime ?? row.endDate) ?? now,
  };
}

function normalizePolymarketOpenOrder(row: JsonRecord, now: number): TradingOpenOrder | null {
  const id = firstString(row, ["id", "order_id", "orderID"]);
  const market = firstString(row, ["market", "conditionId", "condition_id"]);
  if (!id || !market) return null;
  const originalSize = firstNumber(row, ["original_size", "originalSize", "size"]) ?? 0;
  const matched = firstNumber(row, ["size_matched", "sizeMatched"]) ?? 0;
  const shares = Math.max(0, originalSize - matched);
  if (shares <= 0) return null;
  const price = priceFromUnknown(row.price);
  return {
    id,
    market,
    outcome: firstString(row, ["outcome", "asset_id"]) ?? "OUTCOME",
    side: (firstString(row, ["side"]) ?? "BUY").toLowerCase().includes("sell") ? "Sell" : "Buy",
    shares,
    price,
    value: price == null ? null : rounded(shares * price),
    status: firstString(row, ["status"]) ?? "open",
    updatedAt: timestampMs(row.created_at ?? row.createdAt ?? row.updated_at) ?? now,
  };
}

function normalizePolymarketActivity(row: JsonRecord, now: number): TradingHistoryRow | null {
  const type = (firstString(row, ["type", "activityType", "side"]) ?? "").toLowerCase();
  if (type && !["buy", "sell", "trade"].some((part) => type.includes(part))) return null;
  const shares = firstNumber(row, ["size", "shares", "amount"]);
  if (shares == null || shares <= 0) return null;
  const activity = type.includes("sell") ? "Sell" : "Buy";
  const price = priceFromUnknown(row.price ?? row.avgPrice);
  const value = rounded(firstNumber(row, ["usdcSize", "value", "currentValue"])) ?? (price == null ? null : rounded(shares * price));
  return {
    id: firstString(row, ["transactionHash", "transaction_hash", "id", "orderId"]) ?? `polymarket-${now}`,
    activity,
    marketName: firstString(row, ["title", "slug", "market", "conditionId"]) ?? "Polymarket",
    outcome: firstString(row, ["outcome", "asset"]) ?? "OUTCOME",
    shares,
    value: value == null ? null : activity === "Buy" ? -Math.abs(value) : Math.abs(value),
    timeMs: timestampMs(row.timestamp ?? row.time ?? row.createdAt ?? row.date) ?? now,
    venueOrderId: firstString(row, ["orderId", "order_id"]),
    clientOrderId: null,
    status: "filled",
  };
}

async function resolvePolymarketClient(options: AccountSourceOptions): Promise<PolymarketClobLike> {
  if (options.getPolymarketClient) return options.getPolymarketClient();
  const factory = options.polymarketClientFactory ?? defaultPolymarketClientFactory;
  const clientOrBundle = await factory(options.config);
  return "client" in clientOrBundle ? clientOrBundle.client : clientOrBundle;
}

async function polymarketCashAndOpenOrders(options: AccountSourceOptions): Promise<{ cashValue: number | null; openOrders: TradingOpenOrder[] }> {
  const client = await withTimeout(
    resolvePolymarketClient(options),
    POLYMARKET_ACCOUNT_REQUEST_TIMEOUT_MS,
    "Polymarket account client",
  );
  const [balanceAllowance, openOrders] = await Promise.all([
    withTimeout(
      client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
      POLYMARKET_ACCOUNT_REQUEST_TIMEOUT_MS,
      "Polymarket collateral balance",
    ),
    withTimeout(
      client.getOpenOrders?.({}, true) ?? Promise.resolve([]),
      POLYMARKET_ACCOUNT_REQUEST_TIMEOUT_MS,
      "Polymarket open orders",
    ),
  ]);
  return {
    cashValue: usdcRawToDollars(numberOrNull(balanceAllowance.balance)),
    openOrders: openOrders
      .map(asRecord)
      .filter((row): row is JsonRecord => row != null)
      .map((row) => normalizePolymarketOpenOrder(row, options.now))
      .filter((row): row is TradingOpenOrder => row != null),
  };
}

async function polymarketAccountActivity(options: AccountSourceOptions): Promise<PlatformAccountData> {
  const address = polymarketAccountAddress(options.config);
  if (!address) throw new Error("Polymarket account address is not configured");
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now;
  // Each sub-fetch is INDEPENDENTLY fault-tolerant. A transient data-api failure (positions/value) must not
  // collapse the whole venue — the CLOB collateral balance is the critical figure — and a CLOB balance
  // failure falls back to readiness. Only when EVERY source yields nothing do we report the venue as
  // unavailable (portfolioValue null) so the carry-forward / "missing venue" path engages, rather than
  // silently fabricating $0 or dropping Polymarket from the combined total.
  const [positionsPayload, valuePayload, activityPayload, accountState] = await Promise.all([
    polymarketDataApi("/positions", address, fetchFn, { limit: "500", sizeThreshold: "0" }).catch((error) => { logPolymarketAccountWarn("positions", error); return null; }),
    polymarketDataApi("/value", address, fetchFn).catch((error) => { logPolymarketAccountWarn("value", error); return null; }),
    polymarketDataApi("/activity", address, fetchFn, { limit: "100" }).catch(() => null),
    polymarketCashAndOpenOrders(options).catch((error) => { logPolymarketAccountWarn("balance", error); return { cashValue: null, openOrders: [] as TradingOpenOrder[] }; }),
  ]);
  const positionRows = rowsFromPayload(positionsPayload, ["positions"]);
  const positions = positionRows
    .map((row) => normalizePolymarketPosition(row, now))
    .filter((row): row is TradingPosition => row != null)
    .sort((left, right) => (right.value ?? 0) - (left.value ?? 0));
  const valueRecord = rowsFromPayload(valuePayload, ["value"])[0] ?? asRecord(valuePayload);
  const summedPositions = positions.reduce((total, position) => total + (position.value ?? 0), 0);
  const reportedValue = firstNumber(valueRecord, ["value"]);
  // Prefer the /value endpoint only when it reports a positive total; it returns 0/empty for
  // resolved positions, which would zero out genuine open MTM — fall back to the summed marks.
  const positionsValue = reportedValue != null && reportedValue > 0 ? reportedValue : summedPositions;
  const cashValue = accountState.cashValue ?? options.readiness?.polymarket.balance ?? options.readiness?.polymarket.collateralBalanceNormalized ?? null;
  // Null (unavailable) when no source produced a usable signal — never fabricate $0, which would corrupt the
  // combined total and the equity curve. A real $0 only arises when the CLOB balance genuinely returns 0.
  const hasSignal = cashValue != null || positions.length > 0 || (reportedValue != null && reportedValue > 0);
  const portfolioValue = hasSignal ? rounded((cashValue ?? 0) + positionsValue) : null;
  const accountPnl = positionRows.reduce((total, row) => {
    return total
      + (firstNumber(row, ["cashPnl", "cash_pnl"]) ?? 0)
      + (firstNumber(row, ["realizedPnl", "realized_pnl"]) ?? 0);
  }, 0);
  const apiHistory = rowsFromPayload(activityPayload, ["activity"])
    .map((row) => normalizePolymarketActivity(row, now))
    .filter((row): row is TradingHistoryRow => row != null);
  return {
    portfolio: {
      platform: "polymarket",
      portfolioValue,
      cashValue,
      dayChangeDollars: Number.isFinite(accountPnl) && accountPnl !== 0 ? rounded(accountPnl) : null,
      dayChangePercent: null,
      lastUpdatedAt: now,
    },
    positions,
    openOrders: accountState.openOrders,
    history: apiHistory.length > 0 ? apiHistory : undefined,
    sparkline: accountSparkline(portfolioValue, now, Number.isFinite(accountPnl) && accountPnl !== 0 ? rounded(accountPnl) : null),
    lastUpdatedAt: now,
  };
}

export async function accountBackedPlatformActivity(
  platform: TradingPlatform,
  fallback: TradingPlatformActivity,
  options: AccountSourceOptions,
): Promise<TradingPlatformActivity> {
  try {
    const account = platform === "kalshi"
      ? await kalshiAccountActivity(options)
      : await polymarketAccountActivity(options);
    return {
      platform,
      connectionStatus: "live",
      lastUpdatedAt: account.lastUpdatedAt,
      portfolio: account.portfolio,
      positions: account.positions,
      openOrders: account.openOrders,
      history: account.history ?? fallback.history,
      sparkline: account.sparkline ?? accountSparkline(account.portfolio.portfolioValue, options.now, account.portfolio.dayChangeDollars),
    };
  } catch (error) {
    logEvent({
      severity: "WARN",
      category: platform === "kalshi" ? "KALSHI" : "POLYMARKET",
      message: "account source unavailable; falling back to readiness balance",
      context: { platform, error: error instanceof Error ? error.message : String(error) },
    });
    const cashValue = platform === "polymarket"
      ? options.readiness?.polymarket.balance ?? options.readiness?.polymarket.collateralBalanceNormalized ?? null
      : options.readiness?.kalshi.balance ?? null;
    return {
      ...fallback,
      connectionStatus: "reconnecting",
      positions: [],
      openOrders: [],
      portfolio: {
        ...fallback.portfolio,
        portfolioValue: cashValue,
        cashValue,
        dayChangeDollars: null,
        dayChangePercent: null,
      },
      sparkline: accountSparkline(cashValue, options.now),
    };
  }
}

export async function accountBackedTradingActivity(
  fallback: TradingActivitySnapshot,
  options: Omit<AccountSourceOptions, "history">,
): Promise<TradingActivitySnapshot> {
  const [kalshi, polymarket] = await Promise.all([
    accountBackedPlatformActivity("kalshi", fallback.kalshi, { ...options, history: fallback.kalshi.history }),
    accountBackedPlatformActivity("polymarket", fallback.polymarket, { ...options, history: fallback.polymarket.history }),
  ]);
  return { kalshi, polymarket };
}
