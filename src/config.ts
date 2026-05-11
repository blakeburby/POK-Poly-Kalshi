import type { LiveOrderPlacementMode, LivePartialFillLockMode } from "./types";

export interface AppConfig {
  port: number;
  databaseUrl: string;
  arbEnabled: boolean;
  liveTrading: boolean;
  minProfitDollars: number;
  reentryIntervalMs: number;
  staleBookMs: number;
  marketDiscoveryIntervalMs: number;
  dashboardStreamIntervalMs: number;
  dashboardSignalRefreshMs: number;
  dashboardAnalyticsRefreshMs: number;
  executionConcurrency: number;
  discoveryBoundaryRefreshEnabled: boolean;
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
  polymarketPrivateKey: string;
  polymarketApiKey: string;
  polymarketApiSecret: string;
  polymarketApiPassphrase: string;
  polymarketSignatureType: number;
  polymarketFunderAddress: string;
  polymarketChainId: number;
  polymarketClobHost: string;
  polymarketGeoblockUrl: string;
  polymarketOrderType: "FOK" | "FAK";
  liveOrderSize: number;
  liveMaxSlippageCents: number;
  liveTakerPriceCushionCents: number;
  liveMinExpiryMs: number;
  liveMaxTradesPerWindow: number;
  liveCollateralBufferDollars: number;
  liveQuoteMaxAgeMs: number;
  liveQuoteSyncMaxSkewMs: number;
  liveMinBookDepthShares: number;
  liveOrderTimeoutMs: number;
  liveHedgeMaxLossDollars: number;
  liveHedgeFeeBufferDollars: number;
  liveOrderPlacementMode: LiveOrderPlacementMode;
  liveAggressiveLimitRestMs: number;
  liveParallelExecutionEnabled: boolean;
  liveHotPathEnabled: boolean;
  liveHotPathCacheMaxAgeMs: number;
  liveHotPathWarmIntervalMs: number;
  livePolymarketPresignEnabled: boolean;
  livePolymarketSignedOrderTtlMs: number;
  liveLowLatencyHttpEnabled: boolean;
  liveKalshiOrderGroupEnabled: boolean;
  liveKalshiOrderGroupId: string;
  liveUserStreamsEnabled: boolean;
  liveUserStreamPretradeGraceMs: number;
  liveUserStreamConfirmTimeoutMs: number;
  livePretradeRetryAttempts: number;
  livePretradeRetryDelayMs: number;
  liveFinalRecoveryTimeoutMs: number;
  liveFinalRecoveryPollMs: number;
  liveAutoResolveVerifiedIncidents: boolean;
  liveAutoHardlocksEnabled: boolean;
  livePartialFillLockMode: LivePartialFillLockMode;
  liveMaxUnresolvedExposureDollars: number;
  liveReconcileBeforeTrade: boolean;
  kalshiUserWsUrl: string;
  polymarketUserWsUrl: string;
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

function envLiveOrderPlacementMode(env: NodeJS.ProcessEnv): LiveOrderPlacementMode {
  const value = envString(env, "LIVE_ORDER_PLACEMENT_MODE", "parallel_limit_rest").toLowerCase();
  if (value === "parallel_fok" || value === "parallel_limit_rest") return value;
  throw new Error("LIVE_ORDER_PLACEMENT_MODE must be parallel_fok or parallel_limit_rest");
}

function envLivePartialFillLockMode(env: NodeJS.ProcessEnv): LivePartialFillLockMode {
  const value = envString(env, "LIVE_PARTIAL_FILL_LOCK_MODE", "quarantine").toLowerCase();
  if (value === "lock" || value === "quarantine") return value;
  throw new Error("LIVE_PARTIAL_FILL_LOCK_MODE must be lock or quarantine");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const liveOrderSize = envNumber(env, "LIVE_ORDER_SIZE", 1);
  const liveMaxSlippageCents = envNumber(env, "LIVE_MAX_SLIPPAGE_CENTS", 1);
  return {
    port: envNumber(env, "PORT", 8080),
    databaseUrl: envString(env, "DATABASE_URL"),
    arbEnabled: envBoolean(env, "ARB_ENABLED", true),
    liveTrading: envBoolean(env, "ARB_LIVE_TRADING", false),
    minProfitDollars: envNumber(env, "ARB_MIN_PROFIT_DOLLARS", 0.05),
    reentryIntervalMs: envNumber(env, "ARB_REENTRY_INTERVAL_MS", 15_000),
    staleBookMs: envNumber(env, "STALE_BOOK_MS", 10_000),
    marketDiscoveryIntervalMs: envNumber(env, "MARKET_DISCOVERY_INTERVAL_MS", 30_000),
    dashboardStreamIntervalMs: envNumber(env, "DASHBOARD_STREAM_INTERVAL_MS", 250),
    dashboardSignalRefreshMs: envNumber(env, "DASHBOARD_SIGNAL_REFRESH_MS", 1_000),
    dashboardAnalyticsRefreshMs: envNumber(env, "DASHBOARD_ANALYTICS_REFRESH_MS", 5_000),
    executionConcurrency: envNumber(env, "ARB_EXECUTION_CONCURRENCY", 2),
    discoveryBoundaryRefreshEnabled: envBoolean(env, "DISCOVERY_BOUNDARY_REFRESH_ENABLED", true),
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
    polymarketPrivateKey: envString(env, "POLYMARKET_PRIVATE_KEY"),
    polymarketApiKey: envString(env, "POLYMARKET_API_KEY"),
    polymarketApiSecret: envString(env, "POLYMARKET_API_SECRET"),
    polymarketApiPassphrase: envString(env, "POLYMARKET_API_PASSPHRASE"),
    polymarketSignatureType: envNumber(env, "POLYMARKET_SIGNATURE_TYPE", 0),
    polymarketFunderAddress: envString(env, "POLYMARKET_FUNDER_ADDRESS"),
    polymarketChainId: envNumber(env, "POLYMARKET_CHAIN_ID", 137),
    polymarketClobHost: envString(env, "POLYMARKET_CLOB_HOST", "https://clob.polymarket.com"),
    polymarketGeoblockUrl: envString(env, "POLYMARKET_GEOBLOCK_URL", "https://polymarket.com/api/geoblock"),
    polymarketOrderType: envString(env, "POLYMARKET_ORDER_TYPE", "FOK").toUpperCase() === "FAK" ? "FAK" : "FOK",
    liveOrderSize,
    liveMaxSlippageCents,
    liveTakerPriceCushionCents: envNumber(env, "LIVE_TAKER_PRICE_CUSHION_CENTS", 2),
    liveMinExpiryMs: envNumber(env, "LIVE_MIN_EXPIRY_MS", 30_000),
    liveMaxTradesPerWindow: envNumber(env, "LIVE_MAX_TRADES_PER_WINDOW", 1),
    liveCollateralBufferDollars: envNumber(env, "LIVE_COLLATERAL_BUFFER_DOLLARS", 0.25),
    liveQuoteMaxAgeMs: envNumber(env, "LIVE_QUOTE_MAX_AGE_MS", 750),
    liveQuoteSyncMaxSkewMs: envNumber(env, "LIVE_QUOTE_SYNC_MAX_SKEW_MS", 250),
    liveMinBookDepthShares: envNumber(env, "LIVE_MIN_BOOK_DEPTH_SHARES", liveOrderSize),
    liveOrderTimeoutMs: envNumber(env, "LIVE_ORDER_TIMEOUT_MS", 2_500),
    liveHedgeMaxLossDollars: envNumber(env, "LIVE_HEDGE_MAX_LOSS_DOLLARS", 0.02),
    liveHedgeFeeBufferDollars: envNumber(env, "LIVE_HEDGE_FEE_BUFFER_DOLLARS", 0.01),
    liveOrderPlacementMode: envLiveOrderPlacementMode(env),
    liveAggressiveLimitRestMs: envNumber(env, "LIVE_AGGRESSIVE_LIMIT_REST_MS", 500),
    liveParallelExecutionEnabled: envBoolean(env, "LIVE_PARALLEL_EXECUTION_ENABLED", true),
    liveHotPathEnabled: envBoolean(env, "LIVE_HOT_PATH_ENABLED", true),
    liveHotPathCacheMaxAgeMs: envNumber(env, "LIVE_HOT_PATH_CACHE_MAX_AGE_MS", 5_000),
    liveHotPathWarmIntervalMs: envNumber(env, "LIVE_HOT_PATH_WARM_INTERVAL_MS", 1_000),
    livePolymarketPresignEnabled: envBoolean(env, "LIVE_POLYMARKET_PRESIGN_ENABLED", false),
    livePolymarketSignedOrderTtlMs: envNumber(env, "LIVE_POLYMARKET_SIGNED_ORDER_TTL_MS", 5_000),
    liveLowLatencyHttpEnabled: envBoolean(env, "LIVE_LOW_LATENCY_HTTP_ENABLED", true),
    liveKalshiOrderGroupEnabled: envBoolean(env, "LIVE_KALSHI_ORDER_GROUP_ENABLED", true),
    liveKalshiOrderGroupId: envString(env, "LIVE_KALSHI_ORDER_GROUP_ID"),
    liveUserStreamsEnabled: envBoolean(env, "LIVE_USER_STREAMS_ENABLED", true),
    liveUserStreamPretradeGraceMs: envNumber(env, "LIVE_USER_STREAM_PRETRADE_GRACE_MS", 750),
    liveUserStreamConfirmTimeoutMs: envNumber(env, "LIVE_USER_STREAM_CONFIRM_TIMEOUT_MS", 2_500),
    livePretradeRetryAttempts: envNumber(env, "LIVE_PRETRADE_RETRY_ATTEMPTS", 2),
    livePretradeRetryDelayMs: envNumber(env, "LIVE_PRETRADE_RETRY_DELAY_MS", 100),
    liveFinalRecoveryTimeoutMs: envNumber(env, "LIVE_FINAL_RECOVERY_TIMEOUT_MS", 3_000),
    liveFinalRecoveryPollMs: envNumber(env, "LIVE_FINAL_RECOVERY_POLL_MS", 250),
    liveAutoResolveVerifiedIncidents: envBoolean(env, "LIVE_AUTO_RESOLVE_VERIFIED_INCIDENTS", true),
    liveAutoHardlocksEnabled: envBoolean(env, "LIVE_AUTO_HARDLOCKS_ENABLED", true),
    livePartialFillLockMode: envLivePartialFillLockMode(env),
    liveMaxUnresolvedExposureDollars: envNumber(env, "LIVE_MAX_UNRESOLVED_EXPOSURE_DOLLARS", 10),
    liveReconcileBeforeTrade: envBoolean(env, "LIVE_RECONCILE_BEFORE_TRADE", true),
    kalshiUserWsUrl: envString(env, "KALSHI_USER_WS_URL", envString(env, "KALSHI_WS_URL", "wss://api.elections.kalshi.com/trade-api/ws/v2")),
    polymarketUserWsUrl: envString(env, "POLYMARKET_USER_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/user"),
    dryRunSlippageEnabled: envBoolean(env, "DRY_RUN_SLIPPAGE_ENABLED", true),
    dryRunKalshiSlippageCents: envNumber(env, "DRY_RUN_KALSHI_SLIPPAGE_CENTS", 1),
    dryRunPolymarketSlippageCents: envNumber(env, "DRY_RUN_POLYMARKET_SLIPPAGE_CENTS", 1),
    dryRunMaxSlippageCents: envNumber(env, "DRY_RUN_MAX_SLIPPAGE_CENTS", 3),
    dryRunSlippageJitterCents: envNumber(env, "DRY_RUN_SLIPPAGE_JITTER_CENTS", 1),
    dashboardApiToken: envString(env, "DASHBOARD_API_TOKEN"),
  };
}
