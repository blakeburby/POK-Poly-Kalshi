import type { LiveKalshiHedgeOrderMode, LiveKalshiPrearmPricePolicy, LiveOrderPlacementMode, LivePartialFillLockMode } from "./types";

export interface AppConfig {
  port: number;
  databaseUrl: string;
  arbEnabled: boolean;
  minProfitDollars: number;
  reentryIntervalMs: number;
  arbScanHeartbeatMs: number;
  staleBookMs: number;
  marketDiscoveryIntervalMs: number;
  dashboardStreamIntervalMs: number;
  dashboardSignalRefreshMs: number;
  dashboardAnalyticsRefreshMs: number;
  executionConcurrency: number;
  discoveryBoundaryRefreshEnabled: boolean;
  kalshiApiBase: string;
  kalshiUiApiBase: string;
  kalshiUiSessionPath: string;
  kalshiUiMarketIdCacheTtlMs: number;
  kalshiUiQuickOrderCapValidated: boolean;
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
  liveTakerPriceCushionCents: number;
  liveMinExpiryMs: number;
  liveMaxTradesPerWindow: number;
  liveCollateralBufferDollars: number;
  liveKalshiMinCashDollars: number;
  liveQuoteMaxAgeMs: number;
  liveQuoteSyncMaxSkewMs: number;
  liveMinBookDepthShares: number;
  liveOrderTimeoutMs: number;
  liveHedgeMaxLossDollars: number;
  liveHedgeFeeBufferDollars: number;
  liveOrderPlacementMode: LiveOrderPlacementMode;
  kalshiHedgeOrderMode: LiveKalshiHedgeOrderMode;
  liveAggressiveLimitRestMs: number;
  liveParallelExecutionEnabled: boolean;
  liveHotPathEnabled: boolean;
  liveHotPathCacheMaxAgeMs: number;
  liveHotPathWarmIntervalMs: number;
  livePolymarketPresignEnabled: boolean;
  livePolymarketSignedOrderTtlMs: number;
  livePolymarketFirstMinFillShares: number;
  livePolymarketFirstMaxFillShares: number;
  liveKalshiPrearmEnabled: boolean;
  liveKalshiPrearmMaxAgeMs: number;
  liveKalshiPrearmPricePolicy: LiveKalshiPrearmPricePolicy;
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
  liveExactExposureRequired: boolean;
  liveExecutionQualityGateEnabled: boolean;
  liveExecutionQualityLookbackMs: number;
  liveExecutionQualitySampleLimit: number;
  liveExecutionQualityMinSamples: number;
  liveExecutionQualityMinExactFillRate: number;
  liveFillQualityScoringEnabled: boolean;
  liveFillQualityGateEnabled: boolean;
  liveFillQualityMinExpectedEdge: number;
  liveFillQualityLookbackMs: number;
  liveFillQualitySampleLimit: number;
  liveFillQualityMinSamples: number;
  liveFillQualityModelVersion: string;
  liveLeadLagScoringEnabled: boolean;
  liveLeadLagGateEnabled: boolean;
  liveLeadLagModelVersion: string;
  liveLeadLagWindowsMs: number[];
  liveLeadLagMinConfidence: number;
  liveLeadLagMaxAdverseSelectionScore: number;
  livePartialFillLockMode: LivePartialFillLockMode;
  liveMaxUnresolvedExposureDollars: number;
  liveReconcileBeforeTrade: boolean;
  kalshiUserWsUrl: string;
  polymarketUserWsUrl: string;
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
  const value = envString(env, "LIVE_ORDER_PLACEMENT_MODE", "polymarket_first_exact").toLowerCase();
  if (
    value === "parallel_market"
    || value === "parallel_quick"
    || value === "parallel_fok"
    || value === "parallel_fak"
    || value === "parallel_limit_rest"
    || value === "polymarket_first_exact"
  ) return value;
  throw new Error("LIVE_ORDER_PLACEMENT_MODE must be parallel_market, parallel_quick, parallel_fok, parallel_fak, parallel_limit_rest, or polymarket_first_exact");
}

function envLiveKalshiHedgeOrderMode(env: NodeJS.ProcessEnv): LiveKalshiHedgeOrderMode {
  const value = envString(env, "KALSHI_HEDGE_ORDER_MODE", "public_v2").toLowerCase();
  if (value === "public_v2" || value === "ui_quick_order") return value;
  throw new Error("KALSHI_HEDGE_ORDER_MODE must be public_v2 or ui_quick_order");
}

function envLivePartialFillLockMode(env: NodeJS.ProcessEnv): LivePartialFillLockMode {
  const value = envString(env, "LIVE_PARTIAL_FILL_LOCK_MODE", "quarantine").toLowerCase();
  if (value === "lock" || value === "quarantine") return value;
  throw new Error("LIVE_PARTIAL_FILL_LOCK_MODE must be lock or quarantine");
}

function envLiveKalshiPrearmPricePolicy(env: NodeJS.ProcessEnv): LiveKalshiPrearmPricePolicy {
  const value = envString(env, "LIVE_KALSHI_PREARM_PRICE_POLICY", "patch_after_fill").toLowerCase();
  if (value === "patch_after_fill") return value;
  throw new Error("LIVE_KALSHI_PREARM_PRICE_POLICY must be patch_after_fill");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const liveOrderSize = envNumber(env, "LIVE_ORDER_SIZE", 8);
  const livePolymarketFirstMinFillShares = envNumber(env, "LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES", liveOrderSize);
  const livePolymarketFirstMaxFillShares = envNumber(env, "LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES", liveOrderSize);
  if (livePolymarketFirstMinFillShares <= 0 || livePolymarketFirstMaxFillShares <= 0 || livePolymarketFirstMinFillShares > livePolymarketFirstMaxFillShares) {
    throw new Error("LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES must be greater than 0 and less than or equal to LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES");
  }
  return {
    port: envNumber(env, "PORT", 8080),
    databaseUrl: envString(env, "DATABASE_URL"),
    arbEnabled: envBoolean(env, "ARB_ENABLED", true),
    minProfitDollars: envNumber(env, "ARB_MIN_PROFIT_DOLLARS", 0.01),
    reentryIntervalMs: envNumber(env, "ARB_REENTRY_INTERVAL_MS", 15_000),
    arbScanHeartbeatMs: envNumber(env, "ARB_SCAN_HEARTBEAT_MS", 250),
    staleBookMs: envNumber(env, "STALE_BOOK_MS", 10_000),
    marketDiscoveryIntervalMs: envNumber(env, "MARKET_DISCOVERY_INTERVAL_MS", 30_000),
    dashboardStreamIntervalMs: envNumber(env, "DASHBOARD_STREAM_INTERVAL_MS", 250),
    dashboardSignalRefreshMs: envNumber(env, "DASHBOARD_SIGNAL_REFRESH_MS", 1_000),
    dashboardAnalyticsRefreshMs: envNumber(env, "DASHBOARD_ANALYTICS_REFRESH_MS", 5_000),
    executionConcurrency: envNumber(env, "ARB_EXECUTION_CONCURRENCY", 2),
    discoveryBoundaryRefreshEnabled: envBoolean(env, "DISCOVERY_BOUNDARY_REFRESH_ENABLED", true),
    kalshiApiBase: envString(env, "KALSHI_API_BASE", "https://api.elections.kalshi.com/trade-api/v2"),
    kalshiUiApiBase: envString(env, "KALSHI_UI_API_BASE", "https://api.elections.kalshi.com"),
    kalshiUiSessionPath: envString(env, "KALSHI_UI_SESSION_PATH", "/etc/pok-poly-kalshi/kalshi-ui-session.json"),
    kalshiUiMarketIdCacheTtlMs: envNumber(env, "KALSHI_UI_MARKET_ID_CACHE_TTL_MS", 60_000),
    kalshiUiQuickOrderCapValidated: envBoolean(env, "KALSHI_UI_QUICK_ORDER_CAP_VALIDATED", false),
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
    polymarketOrderType: envString(env, "POLYMARKET_ORDER_TYPE", "FAK").toUpperCase() === "FOK" ? "FOK" : "FAK",
    liveOrderSize,
    liveTakerPriceCushionCents: envNumber(env, "LIVE_TAKER_PRICE_CUSHION_CENTS", 2),
    liveMinExpiryMs: envNumber(env, "LIVE_MIN_EXPIRY_MS", 30_000),
    liveMaxTradesPerWindow: envNumber(env, "LIVE_MAX_TRADES_PER_WINDOW", 3),
    liveCollateralBufferDollars: envNumber(env, "LIVE_COLLATERAL_BUFFER_DOLLARS", 0.25),
    liveKalshiMinCashDollars: envNumber(env, "LIVE_KALSHI_MIN_CASH_DOLLARS", 30),
    liveQuoteMaxAgeMs: envNumber(env, "LIVE_QUOTE_MAX_AGE_MS", 750),
    liveQuoteSyncMaxSkewMs: envNumber(env, "LIVE_QUOTE_SYNC_MAX_SKEW_MS", 250),
    liveMinBookDepthShares: envNumber(env, "LIVE_MIN_BOOK_DEPTH_SHARES", 10),
    liveOrderTimeoutMs: envNumber(env, "LIVE_ORDER_TIMEOUT_MS", 2_500),
    liveHedgeMaxLossDollars: envNumber(env, "LIVE_HEDGE_MAX_LOSS_DOLLARS", 0.02),
    liveHedgeFeeBufferDollars: envNumber(env, "LIVE_HEDGE_FEE_BUFFER_DOLLARS", 0.01),
    liveOrderPlacementMode: envLiveOrderPlacementMode(env),
    kalshiHedgeOrderMode: envLiveKalshiHedgeOrderMode(env),
    liveAggressiveLimitRestMs: envNumber(env, "LIVE_AGGRESSIVE_LIMIT_REST_MS", 500),
    liveParallelExecutionEnabled: envBoolean(env, "LIVE_PARALLEL_EXECUTION_ENABLED", true),
    liveHotPathEnabled: envBoolean(env, "LIVE_HOT_PATH_ENABLED", true),
    liveHotPathCacheMaxAgeMs: envNumber(env, "LIVE_HOT_PATH_CACHE_MAX_AGE_MS", 5_000),
    liveHotPathWarmIntervalMs: envNumber(env, "LIVE_HOT_PATH_WARM_INTERVAL_MS", 1_000),
    livePolymarketPresignEnabled: envBoolean(env, "LIVE_POLYMARKET_PRESIGN_ENABLED", false),
    livePolymarketSignedOrderTtlMs: envNumber(env, "LIVE_POLYMARKET_SIGNED_ORDER_TTL_MS", 5_000),
    livePolymarketFirstMinFillShares,
    livePolymarketFirstMaxFillShares,
    liveKalshiPrearmEnabled: envBoolean(env, "LIVE_KALSHI_PREARM_ENABLED", true),
    liveKalshiPrearmMaxAgeMs: envNumber(env, "LIVE_KALSHI_PREARM_MAX_AGE_MS", 5_000),
    liveKalshiPrearmPricePolicy: envLiveKalshiPrearmPricePolicy(env),
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
    liveExactExposureRequired: envBoolean(env, "LIVE_EXACT_EXPOSURE_REQUIRED", false),
    liveExecutionQualityGateEnabled: envBoolean(env, "LIVE_EXECUTION_QUALITY_GATE_ENABLED", true),
    liveExecutionQualityLookbackMs: envNumber(env, "LIVE_EXECUTION_QUALITY_LOOKBACK_MS", 30 * 60 * 1_000),
    liveExecutionQualitySampleLimit: envNumber(env, "LIVE_EXECUTION_QUALITY_SAMPLE_LIMIT", 50),
    liveExecutionQualityMinSamples: envNumber(env, "LIVE_EXECUTION_QUALITY_MIN_SAMPLES", 5),
    liveExecutionQualityMinExactFillRate: envNumber(env, "LIVE_EXECUTION_QUALITY_MIN_EXACT_FILL_RATE", 0.4),
    liveFillQualityScoringEnabled: envBoolean(env, "LIVE_FILL_QUALITY_SCORING_ENABLED", true),
    liveFillQualityGateEnabled: envBoolean(env, "LIVE_FILL_QUALITY_GATE_ENABLED", false),
    liveFillQualityMinExpectedEdge: envNumber(env, "LIVE_FILL_QUALITY_MIN_EXPECTED_EDGE", 0.01),
    liveFillQualityLookbackMs: envNumber(env, "LIVE_FILL_QUALITY_LOOKBACK_MS", 30 * 60 * 1_000),
    liveFillQualitySampleLimit: envNumber(env, "LIVE_FILL_QUALITY_SAMPLE_LIMIT", 200),
    liveFillQualityMinSamples: envNumber(env, "LIVE_FILL_QUALITY_MIN_SAMPLES", 30),
    liveFillQualityModelVersion: envString(env, "LIVE_FILL_QUALITY_MODEL_VERSION", "heuristic-v1"),
    liveLeadLagScoringEnabled: envBoolean(env, "LIVE_LEAD_LAG_SCORING_ENABLED", true),
    liveLeadLagGateEnabled: envBoolean(env, "LIVE_LEAD_LAG_GATE_ENABLED", false),
    liveLeadLagModelVersion: envString(env, "LIVE_LEAD_LAG_MODEL_VERSION", "heuristic-v1"),
    liveLeadLagWindowsMs: envNumberList(env, "LIVE_LEAD_LAG_WINDOWS_MS", [1_000, 5_000, 15_000, 60_000]),
    liveLeadLagMinConfidence: envNumber(env, "LIVE_LEAD_LAG_MIN_CONFIDENCE", 0.65),
    liveLeadLagMaxAdverseSelectionScore: envNumber(env, "LIVE_LEAD_LAG_MAX_ADVERSE_SELECTION_SCORE", 0.75),
    livePartialFillLockMode: envLivePartialFillLockMode(env),
    liveMaxUnresolvedExposureDollars: envNumber(env, "LIVE_MAX_UNRESOLVED_EXPOSURE_DOLLARS", 10),
    liveReconcileBeforeTrade: envBoolean(env, "LIVE_RECONCILE_BEFORE_TRADE", true),
    kalshiUserWsUrl: envString(env, "KALSHI_USER_WS_URL", envString(env, "KALSHI_WS_URL", "wss://api.elections.kalshi.com/trade-api/ws/v2")),
    polymarketUserWsUrl: envString(env, "POLYMARKET_USER_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/user"),
    dashboardApiToken: envString(env, "DASHBOARD_API_TOKEN"),
  };
}
