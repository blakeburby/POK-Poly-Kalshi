import type { LiveKalshiHedgeOrderMode, LiveKalshiHedgeTimeInForce, LiveKalshiPrearmPricePolicy, LiveOrderPlacementMode, LivePartialFillLockMode } from "./types";

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
  equityBackfillOnBoot: boolean;
  executionConcurrency: number;
  discoveryBoundaryRefreshEnabled: boolean;
  kalshiApiBase: string;
  kalshiUiApiBase: string;
  kalshiUiSessionPath: string;
  kalshiUiMarketIdCacheTtlMs: number;
  kalshiUiQuickOrderCapValidated: boolean;
  kalshiFixHost: string;
  kalshiFixPort: number;
  kalshiFixSenderCompId: string;
  kalshiFixTargetCompId: string;
  kalshiFixHeartbeatSeconds: number;
  kalshiFixConnectTimeoutMs: number;
  kalshiFixOrderResponseTimeoutMs: number;
  kalshiFixUseDollars: boolean;
  kalshiFixEnableIocCancelReport: boolean;
  kalshiFixPreserveOriginalOrderQty: boolean;
  kalshiWsUrl: string;
  kalshiBookFeedSilenceMs: number;
  kalshiSeriesTicker: string;
  polymarketWsUrl: string;
  polymarketBookFeedSilenceMs: number;
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
  polymarketGeoblockGateEnabled: boolean;
  polymarketOrderType: "FOK" | "FAK";
  liveOrderSize: number;
  liveDynamicSizingEnabled: boolean;
  liveMinOrderSize: number;
  liveMaxOrderSize: number;
  liveDynamicSizingMaxKalshiSlippageCents: number;
  liveDynamicSizingCashAware: boolean;
  liveTakerPriceCushionCents: number;
  liveFeeAwareGateEnabled: boolean;
  livePolymarketFirstCrossCents: number;
  liveMinExpiryMs: number;
  liveMaxTradesPerWindow: number;
  liveCollateralBufferDollars: number;
  liveKalshiMinCashDollars: number;
  liveQuoteMaxAgeMs: number;
  livePolymarketQuoteMaxAgeMs: number;
  liveHedgeQuoteMaxAgeMs: number;
  liveQuoteSyncMaxSkewMs: number;
  liveQuoteSkewBothFreshEnabled: boolean;
  liveMinBookDepthShares: number;
  // Default-inert anti-dust guards (0 = off) that make a future LIVE_ORDER_SIZE cut safe: require N
  // genuine ask contracts within a price band of the best ask, and/or bound worstAsk(size)-topAsk
  // slippage, so a single-lot phantom/stale top-of-book quote cannot qualify even at size 1.
  liveMinExecutableLiquidityShares: number;
  liveMaxExecutableAskSlippageCents: number;
  liveOrderTimeoutMs: number;
  liveApiKeyDeriveTimeoutMs: number;
  liveHedgeMaxLossDollars: number;
  liveHedgeFeeBufferDollars: number;
  liveHedgeMinCrossTicks: number;
  liveHedgeRetryAttempts: number;
  liveHedgeRetryBudgetMs: number;
  liveOrderPlacementMode: LiveOrderPlacementMode;
  kalshiHedgeOrderMode: LiveKalshiHedgeOrderMode;
  liveAggressiveLimitRestMs: number;
  liveParallelExecutionEnabled: boolean;
  liveHotPathEnabled: boolean;
  liveHotPathCacheMaxAgeMs: number;
  liveHotReadinessBalanceCoverageEnabled: boolean;
  liveHotPathLockCacheGraceMs: number;
  liveHotPathWarmIntervalMs: number;
  liveQuoteFreshnessFromWsOnly: boolean;
  liveReentrySkipZeroExposure: boolean;
  liveQuarantineCapSettleGraceMs: number;
  livePolymarketPresignEnabled: boolean;
  livePolymarketSignedOrderTtlMs: number;
  livePolymarketFirstMinFillShares: number;
  livePolymarketFirstMaxFillShares: number;
  liveKalshiHedgeTimeInForce: LiveKalshiHedgeTimeInForce;
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
  liveConfirmationFlatMissNonBlocking: boolean;
  liveConfirmationOverfillTolerant: boolean;
  liveConfirmationStatusTolerant: boolean;
  liveConfirmationAcceptRestEvidence: boolean;
  liveAcceptStreamAckAsOrderResult: boolean;
  livePolymarketTimeoutRecoveryResolvesNoFill: boolean;
  liveExactExposureRequired: boolean;
  liveExecutionQualityGateEnabled: boolean;
  liveExecutionQualityLookbackMs: number;
  liveExecutionQualitySampleLimit: number;
  liveExecutionQualityMinSamples: number;
  liveExecutionQualityMinExactFillRate: number;
  // Read-only diagnostics (default OFF): when enabled, below-threshold-edge skips persist per-leg ask
  // ladders + executable edge at several probe sizes so we can classify phantom dust vs shallow-real
  // depth before reducing LIVE_ORDER_SIZE. Zero trading impact; runs only on the already-rejected path.
  liveShadowLadderCaptureEnabled: boolean;
  liveShadowLadderProbeSizes: number[];
  liveFillQualityScoringEnabled: boolean;
  liveFillQualityGateEnabled: boolean;
  liveFillQualityMinExpectedEdge: number;
  liveFillQualityLookbackMs: number;
  liveFillQualitySampleLimit: number;
  liveFillQualityMinSamples: number;
  liveFillQualityInputCacheMaxAgeMs: number;
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
  liveAutoUnwindEnabled: boolean;
  liveAutoUnwindMaxLossDollars: number;
  liveAutoUnwindTimeoutMs: number;
  kalshiUserWsUrl: string;
  polymarketUserWsUrl: string;
  dashboardApiToken: string;
  dashboardRealtimeSecret: string;
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
    || value === "kalshi_first_exact"
  ) return value;
  throw new Error("LIVE_ORDER_PLACEMENT_MODE must be parallel_market, parallel_quick, parallel_fok, parallel_fak, parallel_limit_rest, polymarket_first_exact, or kalshi_first_exact");
}

function envLiveKalshiHedgeOrderMode(env: NodeJS.ProcessEnv): LiveKalshiHedgeOrderMode {
  const value = envString(env, "KALSHI_HEDGE_ORDER_MODE", "public_v2").toLowerCase();
  if (value === "public_v2" || value === "ui_quick_order" || value === "fix_ioc") return value;
  throw new Error("KALSHI_HEDGE_ORDER_MODE must be public_v2, ui_quick_order, or fix_ioc");
}

function envLiveKalshiHedgeTimeInForce(env: NodeJS.ProcessEnv): LiveKalshiHedgeTimeInForce {
  // Default fill_or_kill (P0-3): the Kalshi hedge leg must be all-or-nothing so it never strands a
  // Kalshi partial against the first-leg fill (the two_sided_mismatched_size source). Both the REST
  // and FIX routes support FOK; ui_quick_order remains IOC by construction.
  const value = envString(env, "LIVE_KALSHI_HEDGE_TIME_IN_FORCE", "fill_or_kill").toLowerCase();
  if (value === "immediate_or_cancel" || value === "fill_or_kill") return value;
  throw new Error("LIVE_KALSHI_HEDGE_TIME_IN_FORCE must be immediate_or_cancel or fill_or_kill");
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
  // Upper bound defaults to liveOrderSize + 1 so a natural Polymarket FAK OVERFILL (e.g. 5.17857 on a
  // size-5 order, from CLOB maker-amount rounding) still passes the hedge-trigger range and routes into
  // the A2 floor-hedge (hedge floor(fill) on Kalshi, leaving the <1-share remainder to the bounded
  // quarantine) instead of being rejected as unexpected_fill_count and stranding the WHOLE fill
  // one-sided (the live signal 2599386 failure). The floor-hedge can only shrink net exposure
  // (hedgeShares = floor(fill) <= fill), never open opposite-side risk. MIN stays at liveOrderSize so a
  // genuine underfill is still declined (no new opening-risk surface).
  const livePolymarketFirstMaxFillShares = envNumber(env, "LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES", liveOrderSize + 1);
  // W2 liquidity-aware dynamic sizing. Default MIN=MAX=liveOrderSize so the size band is a single point and
  // selectExecutableSize returns liveOrderSize unchanged (byte-identical) even if the flag is flipped on by
  // mistake. Raising MAX (after shadow-ladder data confirms headroom) lets each entry scale to the largest
  // size Kalshi depth supports within the slippage band, capped by bankroll. MIN never drops below 1.
  const liveMinOrderSize = Math.max(1, envNumber(env, "LIVE_MIN_ORDER_SIZE", liveOrderSize));
  const liveMaxOrderSize = Math.max(liveMinOrderSize, envNumber(env, "LIVE_MAX_ORDER_SIZE", liveOrderSize));
  const liveDynamicSizingEnabled = envBoolean(env, "LIVE_DYNAMIC_SIZING_ENABLED", false);
  const executionConcurrency = envNumber(env, "ARB_EXECUTION_CONCURRENCY", 1);
  if (liveDynamicSizingEnabled && executionConcurrency > 1) {
    // The dynamic-size selector stores the selected size in a single per-execution field on LiveExecutor,
    // which is only safe when executeOnce is serialized. Refuse to start otherwise rather than risk a
    // cross-execution size mix-up that would misclassify fills.
    throw new Error("LIVE_DYNAMIC_SIZING_ENABLED=true requires ARB_EXECUTION_CONCURRENCY=1");
  }
  if (livePolymarketFirstMinFillShares <= 0 || livePolymarketFirstMaxFillShares <= 0 || livePolymarketFirstMinFillShares > livePolymarketFirstMaxFillShares) {
    throw new Error("LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES must be greater than 0 and less than or equal to LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES");
  }
  // Tick-aware hedge loss budget (per-contract price units, NOT total dollars). The hedge cap is
  // derived as `1 - firstFill - fee - feeBuffer + liveHedgeMaxLossDollars`, and the post-fill loss
  // lock accepts a completed pair only when realized edge >= -liveHedgeMaxLossDollars. Because both
  // use the SAME knob, the cap can never imply a fill that later trips the loss lock. To guarantee
  // the cap clears at least `liveHedgeMinCrossTicks` Kalshi ticks over breakeven net of the fee
  // buffer, the effective budget is floored at feeBuffer + minCrossTicks * tick. Kalshi prices are
  // cent-quantized so one tick = $0.01.
  const KALSHI_PRICE_TICK = 0.01;
  const liveHedgeFeeBufferDollars = envNumber(env, "LIVE_HEDGE_FEE_BUFFER_DOLLARS", 0.01);
  const liveHedgeMinCrossTicks = Math.max(0, envNumber(env, "LIVE_HEDGE_MIN_CROSS_TICKS", 2));
  const configuredHedgeMaxLossDollars = envNumber(env, "LIVE_HEDGE_MAX_LOSS_DOLLARS", 0.03);
  const liveHedgeMaxLossDollars = Math.max(
    configuredHedgeMaxLossDollars,
    liveHedgeFeeBufferDollars + liveHedgeMinCrossTicks * KALSHI_PRICE_TICK,
  );
  return {
    port: envNumber(env, "PORT", 8080),
    databaseUrl: envString(env, "DATABASE_URL"),
    arbEnabled: envBoolean(env, "ARB_ENABLED", true),
    minProfitDollars: envNumber(env, "ARB_MIN_PROFIT_DOLLARS", 0.01),
    reentryIntervalMs: envNumber(env, "ARB_REENTRY_INTERVAL_MS", 15_000),
    arbScanHeartbeatMs: envNumber(env, "ARB_SCAN_HEARTBEAT_MS", 250),
    staleBookMs: envNumber(env, "STALE_BOOK_MS", 10_000),
    // Backstop discovery cadence only. Timeliness comes from the 15-min window-boundary refreshes
    // (discoveryBoundaryRefreshEnabled) + the per-capture queueRediscovery trigger; re-running full discovery
    // (2 HTTP fetches + strike resolution + hot-path warmup) every 30s was needless steady CPU/network churn.
    marketDiscoveryIntervalMs: envNumber(env, "MARKET_DISCOVERY_INTERVAL_MS", 300_000),
    dashboardStreamIntervalMs: envNumber(env, "DASHBOARD_STREAM_INTERVAL_MS", 1_000),
    dashboardSignalRefreshMs: envNumber(env, "DASHBOARD_SIGNAL_REFRESH_MS", 1_000),
    dashboardAnalyticsRefreshMs: envNumber(env, "DASHBOARD_ANALYTICS_REFRESH_MS", 5_000),
    // Dashboard-only: one-time realized-P&L reconstruction to seed the equity curve when empty.
    equityBackfillOnBoot: envBoolean(env, "EQUITY_BACKFILL_ON_BOOT", false),
    // Default 1 (P0-4): serialize live attempts so two concurrent scans cannot both reserve the same
    // Kalshi hedge collateral and double-spend it. Raise only after per-attempt collateral reservation lands.
    executionConcurrency,
    discoveryBoundaryRefreshEnabled: envBoolean(env, "DISCOVERY_BOUNDARY_REFRESH_ENABLED", true),
    kalshiApiBase: envString(env, "KALSHI_API_BASE", "https://api.elections.kalshi.com/trade-api/v2"),
    kalshiUiApiBase: envString(env, "KALSHI_UI_API_BASE", "https://api.elections.kalshi.com"),
    kalshiUiSessionPath: envString(env, "KALSHI_UI_SESSION_PATH", "/etc/pok-poly-kalshi/kalshi-ui-session.json"),
    kalshiUiMarketIdCacheTtlMs: envNumber(env, "KALSHI_UI_MARKET_ID_CACHE_TTL_MS", 60_000),
    kalshiUiQuickOrderCapValidated: envBoolean(env, "KALSHI_UI_QUICK_ORDER_CAP_VALIDATED", false),
    kalshiFixHost: envString(env, "KALSHI_FIX_HOST", "mm.fix.elections.kalshi.com"),
    kalshiFixPort: envNumber(env, "KALSHI_FIX_PORT", 8228),
    kalshiFixSenderCompId: envString(env, "KALSHI_FIX_SENDER_COMP_ID", envString(env, "KALSHI_API_KEY_ID")),
    kalshiFixTargetCompId: envString(env, "KALSHI_FIX_TARGET_COMP_ID", "KalshiNR"),
    kalshiFixHeartbeatSeconds: envNumber(env, "KALSHI_FIX_HEARTBEAT_SECONDS", 10),
    kalshiFixConnectTimeoutMs: envNumber(env, "KALSHI_FIX_CONNECT_TIMEOUT_MS", 1_500),
    kalshiFixOrderResponseTimeoutMs: envNumber(env, "KALSHI_FIX_ORDER_RESPONSE_TIMEOUT_MS", envNumber(env, "LIVE_ORDER_TIMEOUT_MS", 2_500)),
    kalshiFixUseDollars: envBoolean(env, "KALSHI_FIX_USE_DOLLARS", true),
    kalshiFixEnableIocCancelReport: envBoolean(env, "KALSHI_FIX_ENABLE_IOC_CANCEL_REPORT", true),
    kalshiFixPreserveOriginalOrderQty: envBoolean(env, "KALSHI_FIX_PRESERVE_ORIGINAL_ORDER_QTY", true),
    kalshiWsUrl: envString(env, "KALSHI_WS_URL", "wss://api.elections.kalshi.com/trade-api/ws/v2"),
    // Force a Kalshi market-data WS reconnect if the open socket goes silent (no orderbook update) this
    // long. The Kalshi book feed has no PING/keepalive, so a silent-but-open socket is otherwise
    // undetectable until a natural close. 0 disables the watchdog.
    kalshiBookFeedSilenceMs: envNumber(env, "KALSHI_BOOK_FEED_SILENCE_MS", 30_000),
    kalshiSeriesTicker: envString(env, "KALSHI_SERIES_TICKER", "KXBTC15M"),
    polymarketWsUrl: envString(env, "POLYMARKET_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/market"),
    // Force a market-data WS reconnect if the open socket goes silent (no book message) this long. Recovers
    // a silently-dead feed that the close-driven reconnect path can't detect. 0 disables the watchdog.
    polymarketBookFeedSilenceMs: envNumber(env, "POLYMARKET_BOOK_FEED_SILENCE_MS", 30_000),
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
    // When false, the Polymarket geoblock check is treated as ADVISORY: readiness/deploy gates no longer
    // hard-block on geoblockBlocked!==false. The geoblock status is still fetched and reported (so /health and
    // the dashboard keep showing the true country/region/blocked verdict), it just stops pausing trading.
    // Default true preserves the original hard-gate behavior byte-for-byte.
    polymarketGeoblockGateEnabled: envBoolean(env, "POLYMARKET_GEOBLOCK_GATE_ENABLED", true),
    polymarketOrderType: envString(env, "POLYMARKET_ORDER_TYPE", "FAK").toUpperCase() === "FOK" ? "FOK" : "FAK",
    liveOrderSize,
    liveDynamicSizingEnabled,
    liveMinOrderSize,
    liveMaxOrderSize,
    liveDynamicSizingMaxKalshiSlippageCents: envNumber(env, "LIVE_DYNAMIC_SIZING_MAX_KALSHI_SLIPPAGE_CENTS", 10),
    // M2: when true, dynamic sizing is given the cached Kalshi balance so a deep window whose largest size
    // would over-reserve dipping cash sizes DOWN to the largest affordable size instead of skipping the trade
    // entirely. Default false = selector gets null cash (cash-unaware; byte-identical).
    liveDynamicSizingCashAware: envBoolean(env, "LIVE_DYNAMIC_SIZING_CASH_AWARE", false),
    liveTakerPriceCushionCents: envNumber(env, "LIVE_TAKER_PRICE_CUSHION_CENTS", 2),
    // When true, the entry gate subtracts an explicit expected Kalshi taker fee (~0.07*p*(1-p) per share,
    // the same model realizedFeePerSpread measures post-fill) from the cushioned edge, so the taker cushion
    // only has to cover latency/slippage — which lets LIVE_TAKER_PRICE_CUSHION_CENTS be cut safely. Default
    // off = the cushion-only edge (projectedEdgeAfterFees == projectedEdgeAtLimit), byte-identical to today.
    liveFeeAwareGateEnabled: envBoolean(env, "LIVE_FEE_AWARE_GATE_ENABLED", false),
    // P1-5: extra marketable offset (cents) applied ONLY to the Polymarket first-leg FAK limit in
    // polymarket_first_exact, so the order crosses 1-2 ticks of post-quote book movement instead of
    // missing. Default 0 = inert (build-but-disabled until Kalshi is funded; see RUNBOOK). The
    // cushioned-edge gate (quote-quality.ts) still rejects any limit that would erase guaranteed profit,
    // and it only affects the FIRST/cancelable order, so it cannot add directional exposure.
    livePolymarketFirstCrossCents: Math.max(0, envNumber(env, "LIVE_POLYMARKET_FIRST_CROSS_CENTS", 0)),
    liveMinExpiryMs: envNumber(env, "LIVE_MIN_EXPIRY_MS", 30_000),
    liveMaxTradesPerWindow: envNumber(env, "LIVE_MAX_TRADES_PER_WINDOW", 3),
    liveCollateralBufferDollars: envNumber(env, "LIVE_COLLATERAL_BUFFER_DOLLARS", 0.25),
    liveKalshiMinCashDollars: envNumber(env, "LIVE_KALSHI_MIN_CASH_DOLLARS", 5),
    liveQuoteMaxAgeMs: envNumber(env, "LIVE_QUOTE_MAX_AGE_MS", 750),
    // B2 (P2-10): optional TIGHTER freshness bound for the staleness-prone Polymarket (cross/committing)
    // leg, to reduce crossing on stale CLOB quotes. Clamped to <= the general bar so it can only tighten,
    // never loosen. Default = the general bar (inert).
    livePolymarketQuoteMaxAgeMs: Math.min(
      envNumber(env, "LIVE_QUOTE_MAX_AGE_MS", 750),
      Math.max(1, envNumber(env, "LIVE_POLYMARKET_QUOTE_MAX_AGE_MS", envNumber(env, "LIVE_QUOTE_MAX_AGE_MS", 750))),
    ),
    // P3: optional LOOSER freshness bound for the second (hedge) leg only. The first (committing) leg has
    // already filled by the time the hedge is priced, so rejecting the hedge on a slightly-stale hedge quote
    // strands the filled leg one-sided. A looser hedge bound submits the FOK hedge anyway (the hedge-cap
    // price check still bounds loss; a moved book simply kills the FOK cleanly). Clamped to >= the general
    // bar so it can only loosen, never tighten. Default = the general bar (inert / byte-identical).
    liveHedgeQuoteMaxAgeMs: Math.max(
      envNumber(env, "LIVE_QUOTE_MAX_AGE_MS", 750),
      envNumber(env, "LIVE_HEDGE_QUOTE_MAX_AGE_MS", envNumber(env, "LIVE_QUOTE_MAX_AGE_MS", 750)),
    ),
    liveQuoteSyncMaxSkewMs: envNumber(env, "LIVE_QUOTE_SYNC_MAX_SKEW_MS", 250),
    // When true (default), don't skip on quote skew if BOTH legs are individually within liveQuoteMaxAgeMs
    // (each fresh enough to fill — skew just reflects one venue being quieter). Set false to restore the
    // strict absolute-skew gate. The execution layer (FAK/FOK + cushion) safely handles a book that moved.
    liveQuoteSkewBothFreshEnabled: envBoolean(env, "LIVE_QUOTE_SKEW_BOTH_FRESH_ENABLED", true),
    liveMinBookDepthShares: envNumber(env, "LIVE_MIN_BOOK_DEPTH_SHARES", 10),
    liveMinExecutableLiquidityShares: Math.max(0, envNumber(env, "LIVE_MIN_EXECUTABLE_LIQUIDITY_SHARES", 0)),
    liveMaxExecutableAskSlippageCents: Math.max(0, envNumber(env, "LIVE_MAX_EXECUTABLE_ASK_SLIPPAGE_CENTS", 0)),
    liveOrderTimeoutMs: envNumber(env, "LIVE_ORDER_TIMEOUT_MS", 2_500),
    // One-time L2 API-key derive/create is NOT a hot-path order — give it a generous budget instead of the
    // 2500ms order timeout (the global axios default), which was cutting derivation short and blocking trading.
    liveApiKeyDeriveTimeoutMs: Math.max(1_000, envNumber(env, "LIVE_API_KEY_DERIVE_TIMEOUT_MS", 15_000)),
    liveHedgeRetryAttempts: Math.max(0, envNumber(env, "LIVE_HEDGE_RETRY_ATTEMPTS", 2)),
    liveHedgeRetryBudgetMs: Math.max(0, envNumber(env, "LIVE_HEDGE_RETRY_BUDGET_MS", 1_500)),
    liveHedgeMaxLossDollars,
    liveHedgeFeeBufferDollars,
    liveHedgeMinCrossTicks,
    liveOrderPlacementMode: envLiveOrderPlacementMode(env),
    kalshiHedgeOrderMode: envLiveKalshiHedgeOrderMode(env),
    liveAggressiveLimitRestMs: envNumber(env, "LIVE_AGGRESSIVE_LIMIT_REST_MS", 500),
    liveParallelExecutionEnabled: envBoolean(env, "LIVE_PARALLEL_EXECUTION_ENABLED", true),
    liveHotPathEnabled: envBoolean(env, "LIVE_HOT_PATH_ENABLED", true),
    liveHotPathCacheMaxAgeMs: envNumber(env, "LIVE_HOT_PATH_CACHE_MAX_AGE_MS", 5_000),
    // P1.4: with dynamic sizing on, a candidate can need more collateral than the warm loop pre-warmed the
    // Polymarket readiness cache for (warmed at liveOrderSize). When true (default), the hot-path readiness
    // check stops hard-skipping such candidates and instead checks whether the cache's ACTUAL last-seen
    // balance + allowance cover the candidate's collateral (same predicates as a live checkReadiness, no extra
    // fetch) -- it only serves ready when the account demonstrably funds the larger size. Set false to restore
    // the strict warmed-coverage skip. Safe: Polymarket is the cancelable FAK first leg (an over-estimate just
    // FAK-misses, no one-sided exposure); never makes smaller candidates stricter.
    liveHotReadinessBalanceCoverageEnabled: envBoolean(env, "LIVE_HOT_READINESS_BALANCE_COVERAGE_ENABLED", true),
    // H1: grace beyond the lock-cache max age during which getActiveLock serves the LAST-GOOD lock state (and
    // kicks a background refresh) instead of synthesizing a critical breaker that halts ALL scanning on a
    // transient DB-read lag. Safe because locks are self-engaged by this single worker (engageLock updates the
    // cache synchronously, single-worker-per-DB), so last-good never hides a self-engaged lock. Beyond
    // max-age + grace the cache is presumed broken -> fail-safe block. Default 0 = byte-identical (block the
    // instant the cache exceeds max age).
    liveHotPathLockCacheGraceMs: envNumber(env, "LIVE_HOT_PATH_LOCK_CACHE_GRACE_MS", 0),
    liveHotPathWarmIntervalMs: envNumber(env, "LIVE_HOT_PATH_WARM_INTERVAL_MS", 1_000),
    // H2: when true, only a real WS book snapshot advances a contract's updatedAt; periodic discovery refreshes
    // no longer reset the freshness clock (which let a silently-dead WS feed pass the 750ms quote gate).
    // Default false = byte-identical (discovery bumps freshness via Math.max).
    liveQuoteFreshnessFromWsOnly: envBoolean(env, "LIVE_QUOTE_FRESHNESS_FROM_WS_ONLY", false),
    // H4: when true, a zero-exposure no-fill (Polymarket FAK found no match, Kalshi never submitted, both legs
    // 0) does NOT trip the re-entry throttle, so a still-profitable window can be re-attempted immediately
    // instead of being benched for the 5s reentry interval. Default false = throttle every failed attempt.
    liveReentrySkipZeroExposure: envBoolean(env, "LIVE_REENTRY_SKIP_ZERO_EXPOSURE", false),
    // H3: exclude quarantines whose market settled more than this many ms ago from the unresolved-exposure
    // cap, so settled-but-unreconciled tails (realized P&L, not live risk) cannot silently accumulate to the
    // cap and halt trading. Default 0 = count all unresolved quarantines (byte-identical).
    liveQuarantineCapSettleGraceMs: envNumber(env, "LIVE_QUARANTINE_CAP_SETTLE_GRACE_MS", 0),
    livePolymarketPresignEnabled: envBoolean(env, "LIVE_POLYMARKET_PRESIGN_ENABLED", false),
    livePolymarketSignedOrderTtlMs: envNumber(env, "LIVE_POLYMARKET_SIGNED_ORDER_TTL_MS", 5_000),
    livePolymarketFirstMinFillShares,
    livePolymarketFirstMaxFillShares,
    liveKalshiHedgeTimeInForce: envLiveKalshiHedgeTimeInForce(env),
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
    liveConfirmationFlatMissNonBlocking: envBoolean(env, "LIVE_CONFIRMATION_FLAT_MISS_NONBLOCKING", true),
    // When true, a Polymarket FAK fill within the operator's overfill band
    // ([liveOrderSize, livePolymarketFirstMaxFillShares]) is classified as a clean two-sided fill
    // instead of an unexpected_fill_count mismatch/quarantine. The Kalshi integer floor-hedge already
    // covers the whole-share portion; the sub-share residual is the intended, bounded FAK over-hedge.
    // Default off = byte-identical strict-exact classification (the 1e-6 mismatch behavior).
    liveConfirmationOverfillTolerant: envBoolean(env, "LIVE_CONFIRMATION_OVERFILL_TOLERANT", false),
    // C1: Polymarket's user-stream emits a 3-stage trade lifecycle (matched -> mined -> confirmed). The
    // strict confirming-status whitelist excludes "mined", so when the `mined` event resolves the pending
    // confirmation, confirmationFromEvent falls through to "mismatch" REGARDLESS of fill count — quarantining
    // completed, hedged, in-band fills (even exact 5/5). When true, a non-failed event carrying a positive
    // in-band fill confirms regardless of its lifecycle status string. Default off = strict whitelist (today).
    liveConfirmationStatusTolerant: envBoolean(env, "LIVE_CONFIRMATION_STATUS_TOLERANT", false),
    // When true, a private-stream confirmation TIMEOUT on a venue whose REST order response already
    // evidenced the fill (error-free, fillCount > 0) is NOT treated as unconfirmed exposure: the order
    // response itself confirms the fill, and a genuine late surplus still locks via the coordinator's
    // knownOrder reconciliation. Recovers the ~half of confirmation timeouts that actually filled both legs.
    // Default off = a stream timeout still quarantines (today's behavior).
    liveConfirmationAcceptRestEvidence: envBoolean(env, "LIVE_CONFIRM_ACCEPT_REST_EVIDENCE", false),
    // P1: in polymarket_first_exact, when the user-stream delivers the authoritative fill (hedge-trigger
    // source = private_stream) BEFORE the REST order response returns, finalize the Polymarket result from
    // that stream evidence instead of blocking on the slow REST response/recovery (measured p90 ~6s, p95 ~8s;
    // ~22% of orders hit the >2.5s timeout->recovery tail). The merge already takes every fill field from the
    // stream evidence — REST only supplied forensic metadata — so this is a latency change, not a fill-data
    // change; the late REST is drained in the background. Default off = block on REST as today.
    liveAcceptStreamAckAsOrderResult: envBoolean(env, "LIVE_ACCEPT_STREAM_ACK_AS_ORDER_RESULT", false),
    // When true, a Polymarket FAK order that times out (status "unknown") but whose timeout-recovery poll
    // reached the venue and found NO order/trade/open-order ("not_found") is treated as a DEFINITIVE no-fill
    // (a FAK cannot rest, so no evidence == no fill). This auto-resolves settled no-fill timeouts that would
    // otherwise hard-lock for manual reconciliation (the lock-24 gap). Default off = "unknown" stays locked.
    livePolymarketTimeoutRecoveryResolvesNoFill: envBoolean(env, "LIVE_POLYMARKET_TIMEOUT_RECOVERY_RESOLVES_NO_FILL", false),
    liveExactExposureRequired: envBoolean(env, "LIVE_EXACT_EXPOSURE_REQUIRED", false),
    liveExecutionQualityGateEnabled: envBoolean(env, "LIVE_EXECUTION_QUALITY_GATE_ENABLED", true),
    liveExecutionQualityLookbackMs: envNumber(env, "LIVE_EXECUTION_QUALITY_LOOKBACK_MS", 30 * 60 * 1_000),
    liveExecutionQualitySampleLimit: envNumber(env, "LIVE_EXECUTION_QUALITY_SAMPLE_LIMIT", 50),
    liveExecutionQualityMinSamples: envNumber(env, "LIVE_EXECUTION_QUALITY_MIN_SAMPLES", 5),
    liveExecutionQualityMinExactFillRate: envNumber(env, "LIVE_EXECUTION_QUALITY_MIN_EXACT_FILL_RATE", 0.4),
    liveShadowLadderCaptureEnabled: envBoolean(env, "LIVE_SHADOW_LADDER_CAPTURE_ENABLED", false),
    liveShadowLadderProbeSizes: envNumberList(env, "LIVE_SHADOW_LADDER_PROBE_SIZES", [1, 2, 3, 5]),
    liveFillQualityScoringEnabled: envBoolean(env, "LIVE_FILL_QUALITY_SCORING_ENABLED", true),
    liveFillQualityGateEnabled: envBoolean(env, "LIVE_FILL_QUALITY_GATE_ENABLED", false),
    liveFillQualityMinExpectedEdge: envNumber(env, "LIVE_FILL_QUALITY_MIN_EXPECTED_EDGE", 0.01),
    liveFillQualityLookbackMs: envNumber(env, "LIVE_FILL_QUALITY_LOOKBACK_MS", 30 * 60 * 1_000),
    liveFillQualitySampleLimit: envNumber(env, "LIVE_FILL_QUALITY_SAMPLE_LIMIT", 200),
    liveFillQualityMinSamples: envNumber(env, "LIVE_FILL_QUALITY_MIN_SAMPLES", 30),
    // P2: the fill-quality snapshot does two DB reads (recent signals + venue events) on the
    // candidate->submit hot path. The gate is off by default, so the snapshot is shadow telemetry — under
    // pg-pool contention those reads are the hotGateMs p90 tail. When >0, cache the two read RESULTS for this
    // many ms (per-candidate scoreFillQuality CPU still runs fresh), so clustered executions reuse one query.
    // Default 0 = no cache = byte-identical (fresh reads every execution).
    liveFillQualityInputCacheMaxAgeMs: envNumber(env, "LIVE_FILL_QUALITY_INPUT_CACHE_MAX_AGE_MS", 0),
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
    // C1 bounded same-window auto-unwind backstop. Default OFF. When enabled (and a venue client provides
    // an unwindPosition adapter), a one-sided fill that would otherwise be quarantined/locked is first
    // reduced toward flat via a loss-bounded opposing order; on failure/over-cap it falls through to the
    // unchanged quarantine/hardlock path. Only ever reduces an existing position — never opens new exposure.
    liveAutoUnwindEnabled: envBoolean(env, "LIVE_AUTO_UNWIND_ENABLED", false),
    liveAutoUnwindMaxLossDollars: Math.max(0, envNumber(env, "LIVE_AUTO_UNWIND_MAX_LOSS_DOLLARS", 0.05)),
    liveAutoUnwindTimeoutMs: Math.max(1, envNumber(env, "LIVE_AUTO_UNWIND_TIMEOUT_MS", 1_500)),
    kalshiUserWsUrl: envString(env, "KALSHI_USER_WS_URL", envString(env, "KALSHI_WS_URL", "wss://api.elections.kalshi.com/trade-api/ws/v2")),
    polymarketUserWsUrl: envString(env, "POLYMARKET_USER_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/user"),
    dashboardApiToken: envString(env, "DASHBOARD_API_TOKEN"),
    dashboardRealtimeSecret: envString(env, "DASHBOARD_REALTIME_SECRET"),
  };
}
