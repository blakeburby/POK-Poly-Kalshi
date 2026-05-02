export interface AppConfig {
  port: number;
  databaseUrl: string;
  arbEnabled: boolean;
  liveTrading: boolean;
  minProfitDollars: number;
  reentryIntervalMs: number;
  staleBookMs: number;
  marketDiscoveryIntervalMs: number;
  kalshiApiBase: string;
  kalshiWsUrl: string;
  kalshiSeriesTicker: string;
  polymarketWsUrl: string;
  polymarketDiscoveryUrl: string;
  polymarketLiveDataWsUrl: string;
  polymarketPriceToBeatSymbol: string;
  polymarketDiscoveryWindowOffsets: number[];
  polymarketPriceCaptureToleranceMs: number;
  polymarketMissedOpenBackfill: boolean;
  polymarketOrderEndpoint: string;
  polymarketApiKey: string;
  dryRunSlippageEnabled: boolean;
  dryRunKalshiSlippageCents: number;
  dryRunPolymarketSlippageCents: number;
  dryRunMaxSlippageCents: number;
  dryRunSlippageJitterCents: number;
  dashboardApiToken: string;
}

function envString(env: NodeJS.ProcessEnv, key: string, fallback = ""): string {
  return env[key]?.trim() || fallback;
}

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = envString(env, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a finite number`);
  return parsed;
}

function envBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = envString(env, key).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${key} must be boolean-like`);
}

function envNumberList(env: NodeJS.ProcessEnv, key: string, fallback: number[]): number[] {
  const raw = envString(env, key);
  if (!raw) return fallback;
  const parsed = raw.split(",").map((part) => Number(part.trim()));
  if (parsed.some((value) => !Number.isFinite(value))) throw new Error(`${key} must be a comma-separated list of numbers`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: envNumber(env, "PORT", 8080),
    databaseUrl: envString(env, "DATABASE_URL"),
    arbEnabled: envBoolean(env, "ARB_ENABLED", true),
    liveTrading: envBoolean(env, "ARB_LIVE_TRADING", false),
    minProfitDollars: envNumber(env, "ARB_MIN_PROFIT_DOLLARS", 0.05),
    reentryIntervalMs: envNumber(env, "ARB_REENTRY_INTERVAL_MS", 15_000),
    staleBookMs: envNumber(env, "STALE_BOOK_MS", 10_000),
    marketDiscoveryIntervalMs: envNumber(env, "MARKET_DISCOVERY_INTERVAL_MS", 30_000),
    kalshiApiBase: envString(env, "KALSHI_API_BASE", "https://api.elections.kalshi.com/trade-api/v2"),
    kalshiWsUrl: envString(env, "KALSHI_WS_URL", "wss://api.elections.kalshi.com/trade-api/ws/v2"),
    kalshiSeriesTicker: envString(env, "KALSHI_SERIES_TICKER", "KXBTC15M"),
    polymarketWsUrl: envString(env, "POLYMARKET_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/market"),
    polymarketDiscoveryUrl: envString(
      env,
      "POLYMARKET_DISCOVERY_URL",
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&tag_slug=crypto",
    ),
    polymarketLiveDataWsUrl: envString(env, "POLYMARKET_LIVE_DATA_WS_URL", "wss://ws-live-data.polymarket.com"),
    polymarketPriceToBeatSymbol: envString(env, "POLYMARKET_PRICE_TO_BEAT_SYMBOL", "btc/usd"),
    polymarketDiscoveryWindowOffsets: envNumberList(env, "POLYMARKET_DISCOVERY_WINDOW_OFFSETS", [-1, 0, 1, 2, 3, 4, 5, 6]),
    polymarketPriceCaptureToleranceMs: envNumber(env, "POLYMARKET_PRICE_CAPTURE_TOLERANCE_MS", 5_000),
    polymarketMissedOpenBackfill: envBoolean(env, "POLYMARKET_MISSED_OPEN_BACKFILL", true),
    polymarketOrderEndpoint: envString(env, "POLYMARKET_ORDER_ENDPOINT"),
    polymarketApiKey: envString(env, "POLYMARKET_API_KEY"),
    dryRunSlippageEnabled: envBoolean(env, "DRY_RUN_SLIPPAGE_ENABLED", true),
    dryRunKalshiSlippageCents: envNumber(env, "DRY_RUN_KALSHI_SLIPPAGE_CENTS", 1),
    dryRunPolymarketSlippageCents: envNumber(env, "DRY_RUN_POLYMARKET_SLIPPAGE_CENTS", 1),
    dryRunMaxSlippageCents: envNumber(env, "DRY_RUN_MAX_SLIPPAGE_CENTS", 3),
    dryRunSlippageJitterCents: envNumber(env, "DRY_RUN_SLIPPAGE_JITTER_CENTS", 1),
    dashboardApiToken: envString(env, "DASHBOARD_API_TOKEN"),
  };
}
