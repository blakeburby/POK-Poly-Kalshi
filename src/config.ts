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
  polymarketOrderEndpoint: string;
  polymarketApiKey: string;
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
    polymarketOrderEndpoint: envString(env, "POLYMARKET_ORDER_ENDPOINT"),
    polymarketApiKey: envString(env, "POLYMARKET_API_KEY"),
    dashboardApiToken: envString(env, "DASHBOARD_API_TOKEN"),
  };
}
