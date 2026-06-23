# Environment Variable Reference

This is the single source of operator/onboarding truth for the live arbitrage worker's
configuration.

## How config works

All configuration is centralized in [`src/config.ts`](../src/config.ts) via the
`loadConfig(env)` function. This is the **one** place environment variables are parsed — they
are read through the `envString` / `envNumber` / `envBoolean` / `envNumberList` helpers (plus a
handful of typed enum parsers) into a single `AppConfig` object. **Never read `process.env`
directly elsewhere** in the worker; add new keys to `loadConfig` so this table stays the source
of truth.

On the VPS the worker reads `/etc/pok-poly-kalshi/worker.env` (a systemd `EnvironmentFile=`).
The committed template is [`deploy/vps/pok-worker.env.example`](../deploy/vps/pok-worker.env.example) —
copy it to `worker.env` and fill in secrets. Never commit the filled version.

Helper semantics:

- **number** — parsed with `Number()`; must be finite or `loadConfig` throws. Empty/unset → default.
- **boolean** — accepts `1/true/yes/on` and `0/false/no/off` (case-insensitive); anything else throws. Empty/unset → default.
- **list** — comma-separated numbers; any non-finite element throws. Empty/unset → default.
- **enum** — fixed set of string values; anything else throws.
- **string** — trimmed; empty/unset → default (often `""`).

A few keys default to the value of *another* key (noted inline). Three cross-field invariants are
enforced at load and **throw** on violation:

- `LIVE_DYNAMIC_SIZING_ENABLED=true` requires `ARB_EXECUTION_CONCURRENCY=1`.
- `LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES` must be `> 0` and `<= LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES`.
- `LIVE_HEDGE_MAX_LOSS_DOLLARS` is floored at `LIVE_HEDGE_FEE_BUFFER_DOLLARS + LIVE_HEDGE_MIN_CROSS_TICKS * 0.01` (the configured value can only raise it).

---

## Core / runtime

| Env var | Type | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | number | `8080` | HTTP server / health-endpoint port (`port`). |
| `DATABASE_URL` | string | `""` (required for live) | Postgres connection string (`databaseUrl`). |
| `ARB_ENABLED` | boolean | `true` | Master switch; `false` monitors without placing new entries (`arbEnabled`). |
| `ARB_MIN_PROFIT_DOLLARS` | number | `0.01` | Minimum profit per opportunity to act (`minProfitDollars`). |
| `ARB_REENTRY_INTERVAL_MS` | number | `15000` | Throttle between re-attempts on the same window (`reentryIntervalMs`). |
| `ARB_SCAN_HEARTBEAT_MS` | number | `250` | Arb scan-loop heartbeat cadence (`arbScanHeartbeatMs`). |
| `ARB_EXECUTION_CONCURRENCY` | number | `1` | Concurrent live executions; >1 disallowed with dynamic sizing (`executionConcurrency`). |
| `STALE_BOOK_MS` | number | `10000` | Age beyond which an orderbook is considered stale (`staleBookMs`). |
| `MARKET_DISCOVERY_INTERVAL_MS` | number | `300000` | Backstop full-discovery cadence (`marketDiscoveryIntervalMs`). |
| `DISCOVERY_BOUNDARY_REFRESH_ENABLED` | boolean | `true` | Refresh discovery at 15-min window boundaries (`discoveryBoundaryRefreshEnabled`). |

## Kalshi

| Env var | Type | Default | Purpose |
| --- | --- | --- | --- |
| `KALSHI_API_BASE` | string | `https://api.elections.kalshi.com/trade-api/v2` | Kalshi REST trade-api base URL (`kalshiApiBase`). |
| `KALSHI_UI_API_BASE` | string | `https://api.elections.kalshi.com` | Kalshi UI (quick-order) API base (`kalshiUiApiBase`). |
| `KALSHI_UI_SESSION_PATH` | string | `/etc/pok-poly-kalshi/kalshi-ui-session.json` | Path to cached Kalshi UI session file (`kalshiUiSessionPath`). |
| `KALSHI_UI_MARKET_ID_CACHE_TTL_MS` | number | `60000` | TTL for the UI market-id lookup cache (`kalshiUiMarketIdCacheTtlMs`). |
| `KALSHI_UI_QUICK_ORDER_CAP_VALIDATED` | boolean | `false` | Asserts the UI quick-order size cap has been validated (`kalshiUiQuickOrderCapValidated`). |
| `KALSHI_FIX_HOST` | string | `mm.fix.elections.kalshi.com` | Kalshi FIX gateway host (`kalshiFixHost`). |
| `KALSHI_FIX_PORT` | number | `8228` | Kalshi FIX gateway port (`kalshiFixPort`). |
| `KALSHI_FIX_SENDER_COMP_ID` | string | value of `KALSHI_API_KEY_ID` | FIX SenderCompID (`kalshiFixSenderCompId`). |
| `KALSHI_FIX_TARGET_COMP_ID` | string | `KalshiNR` | FIX TargetCompID (`kalshiFixTargetCompId`). |
| `KALSHI_FIX_HEARTBEAT_SECONDS` | number | `10` | FIX session heartbeat interval (`kalshiFixHeartbeatSeconds`). |
| `KALSHI_FIX_CONNECT_TIMEOUT_MS` | number | `1500` | FIX connect timeout (`kalshiFixConnectTimeoutMs`). |
| `KALSHI_FIX_ORDER_RESPONSE_TIMEOUT_MS` | number | value of `LIVE_ORDER_TIMEOUT_MS` (`2500`) | FIX order-response wait timeout (`kalshiFixOrderResponseTimeoutMs`). |
| `KALSHI_FIX_USE_DOLLARS` | boolean | `true` | Price FIX orders in dollars vs cents (`kalshiFixUseDollars`). |
| `KALSHI_FIX_ENABLE_IOC_CANCEL_REPORT` | boolean | `true` | Expect/accept IOC cancel reports over FIX (`kalshiFixEnableIocCancelReport`). |
| `KALSHI_FIX_PRESERVE_ORIGINAL_ORDER_QTY` | boolean | `true` | Keep original OrderQty in FIX reports (`kalshiFixPreserveOriginalOrderQty`). |
| `KALSHI_WS_URL` | string | `wss://api.elections.kalshi.com/trade-api/ws/v2` | Kalshi market-data WS URL (`kalshiWsUrl`). |
| `KALSHI_BOOK_FEED_SILENCE_MS` | number | `30000` | Force WS reconnect after this silent gap; `0` disables watchdog (`kalshiBookFeedSilenceMs`). |
| `KALSHI_SERIES_TICKER` | string | `KXBTC15M` | Kalshi series to trade (`kalshiSeriesTicker`). |
| `KALSHI_USER_WS_URL` | string | value of `KALSHI_WS_URL` (`wss://api.elections.kalshi.com/trade-api/ws/v2`) | Kalshi private user-fills WS URL (`kalshiUserWsUrl`). |

## Polymarket

| Env var | Type | Default | Purpose |
| --- | --- | --- | --- |
| `POLYMARKET_WS_URL` | string | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | Polymarket market-data WS URL (`polymarketWsUrl`). |
| `POLYMARKET_BOOK_FEED_SILENCE_MS` | number | `30000` | Force WS reconnect after this silent gap; `0` disables watchdog (`polymarketBookFeedSilenceMs`). |
| `POLYMARKET_DISCOVERY_URL` | string | `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&tag_slug=crypto` | Gamma markets discovery query (`polymarketDiscoveryUrl`). |
| `POLYMARKET_LIVE_DATA_WS_URL` | string | `wss://ws-live-data.polymarket.com` | Live-data (price-to-beat) WS URL (`polymarketLiveDataWsUrl`). |
| `POLYMARKET_PRICE_TO_BEAT_SYMBOL` | string | `btc/usd` | Symbol for price-to-beat hydration (`polymarketPriceToBeatSymbol`). |
| `POLYMARKET_DISCOVERY_WINDOW_OFFSETS` | list | `-1,0,1,2,3,4,5,6` | 15-min window offsets to discover (`polymarketDiscoveryWindowOffsets`). |
| `POLYMARKET_PRICE_CAPTURE_TOLERANCE_MS` | number | `5000` | Tolerance window for capturing the price-to-beat (`polymarketPriceCaptureToleranceMs`). |
| `POLYMARKET_MISSED_OPEN_BACKFILL` | boolean | `true` | Backfill a missed window-open price (`polymarketMissedOpenBackfill`). |
| `POLYMARKET_PRIVATE_KEY` | string | `""` (required for live) | EOA private key for CLOB signing (`polymarketPrivateKey`). |
| `POLYMARKET_API_KEY` | string | `""` (derived if blank) | L2 CLOB API key (`polymarketApiKey`). |
| `POLYMARKET_API_SECRET` | string | `""` (derived if blank) | L2 CLOB API secret (`polymarketApiSecret`). |
| `POLYMARKET_API_PASSPHRASE` | string | `""` (derived if blank) | L2 CLOB API passphrase (`polymarketApiPassphrase`). |
| `POLYMARKET_SIGNATURE_TYPE` | number | `0` | CLOB order signature type (`polymarketSignatureType`). |
| `POLYMARKET_FUNDER_ADDRESS` | string | `""` (required for live) | Funder/proxy wallet address (`polymarketFunderAddress`). |
| `POLYMARKET_CHAIN_ID` | number | `137` | Polygon chain id (`polymarketChainId`). |
| `POLYMARKET_CLOB_HOST` | string | `https://clob.polymarket.com` | CLOB REST host (`polymarketClobHost`). |
| `POLYMARKET_GEOBLOCK_URL` | string | `https://polymarket.com/api/geoblock` | Geoblock-check endpoint (`polymarketGeoblockUrl`). |
| `POLYMARKET_GEOBLOCK_GATE_ENABLED` | boolean | `true` | If false, geoblock is advisory (reported, not trade-blocking) (`polymarketGeoblockGateEnabled`). |
| `POLYMARKET_ORDER_TYPE` | enum (`FOK`/`FAK`) | `FAK` | Polymarket order type; anything but `FOK` → `FAK` (`polymarketOrderType`). |
| `POLYMARKET_USER_WS_URL` | string | `wss://ws-subscriptions-clob.polymarket.com/ws/user` | Polymarket private user-fills WS URL (`polymarketUserWsUrl`). |

## Live execution

The biggest group. Sub-grouped by concern.

### Sizing

| Env var | Type | Default | Purpose |
| --- | --- | --- | --- |
| `LIVE_ORDER_SIZE` | number | `8` | Base order size in shares/contracts (`liveOrderSize`). |
| `LIVE_DYNAMIC_SIZING_ENABLED` | boolean | `false` | Enable liquidity-aware dynamic sizing; requires concurrency=1 (`liveDynamicSizingEnabled`). |
| `LIVE_MIN_ORDER_SIZE` | number | value of `LIVE_ORDER_SIZE` (floored at 1) | Lower bound of the dynamic size band (`liveMinOrderSize`). |
| `LIVE_MAX_ORDER_SIZE` | number | value of `LIVE_ORDER_SIZE` (floored at min) | Upper bound of the dynamic size band (`liveMaxOrderSize`). |
| `LIVE_DYNAMIC_SIZING_MAX_KALSHI_SLIPPAGE_CENTS` | number | `10` | Max Kalshi ask slippage when scaling up (`liveDynamicSizingMaxKalshiSlippageCents`). |
| `LIVE_DYNAMIC_SIZING_CASH_AWARE` | boolean | `false` | Let dynamic sizing dip down to the largest affordable size (`liveDynamicSizingCashAware`). |

### Hot path

| Env var | Type | Default | Purpose |
| --- | --- | --- | --- |
| `LIVE_HOT_PATH_ENABLED` | boolean | `true` | Use the cached hot-path execution route (`liveHotPathEnabled`). |
| `LIVE_HOT_PATH_CACHE_MAX_AGE_MS` | number | `5000` | Max age of hot-path readiness cache (`liveHotPathCacheMaxAgeMs`). |
| `LIVE_HOT_READINESS_BALANCE_COVERAGE_ENABLED` | boolean | `true` | Allow larger sizes if cached balance/allowance covers them (`liveHotReadinessBalanceCoverageEnabled`). |
| `LIVE_HOT_PATH_LOCK_CACHE_GRACE_MS` | number | `0` | Grace serving last-good lock state past cache max age (`liveHotPathLockCacheGraceMs`). |
| `LIVE_HOT_PATH_WARM_INTERVAL_MS` | number | `1000` | Hot-path warm-loop cadence (`liveHotPathWarmIntervalMs`). |
| `LIVE_LOW_LATENCY_HTTP_ENABLED` | boolean | `true` | Enable low-latency HTTP agent/keep-alive tuning (`liveLowLatencyHttpEnabled`). |
| `LIVE_POLYMARKET_PRESIGN_ENABLED` | boolean | `false` | Pre-sign Polymarket orders ahead of submit (`livePolymarketPresignEnabled`). |
| `LIVE_POLYMARKET_SIGNED_ORDER_TTL_MS` | number | `5000` | TTL of a pre-signed order (`livePolymarketSignedOrderTtlMs`). |
| `LIVE_API_KEY_DERIVE_TIMEOUT_MS` | number | `15000` (floored at 1000) | Timeout for one-time L2 API-key derive/create (`liveApiKeyDeriveTimeoutMs`). |

### Hedge

| Env var | Type | Default | Purpose |
| --- | --- | --- | --- |
| `LIVE_ORDER_PLACEMENT_MODE` | enum | `polymarket_first_exact` | Leg ordering/mode; see enum values below (`liveOrderPlacementMode`). |
| `KALSHI_HEDGE_ORDER_MODE` | enum (`public_v2`/`ui_quick_order`/`fix_ioc`) | `public_v2` | Kalshi hedge order route (`kalshiHedgeOrderMode`). |
| `LIVE_KALSHI_HEDGE_TIME_IN_FORCE` | enum (`immediate_or_cancel`/`fill_or_kill`) | `fill_or_kill` | Kalshi hedge TIF; FOK avoids stranded partials (`liveKalshiHedgeTimeInForce`). |
| `LIVE_AGGRESSIVE_LIMIT_REST_MS` | number | `500` | Rest time for the aggressive-limit placement mode (`liveAggressiveLimitRestMs`). |
| `LIVE_PARALLEL_EXECUTION_ENABLED` | boolean | `true` | Allow parallel-leg placement modes (`liveParallelExecutionEnabled`). |
| `LIVE_HEDGE_MAX_LOSS_DOLLARS` | number | `0.03` (floored — see invariants) | Per-contract hedge loss budget / post-fill loss lock (`liveHedgeMaxLossDollars`). |
| `LIVE_HEDGE_FEE_BUFFER_DOLLARS` | number | `0.01` | Fee buffer baked into the hedge cap (`liveHedgeFeeBufferDollars`). |
| `LIVE_HEDGE_MIN_CROSS_TICKS` | number | `2` (floored at 0) | Min Kalshi ticks the hedge cap must clear over breakeven (`liveHedgeMinCrossTicks`). |
| `LIVE_HEDGE_RETRY_ATTEMPTS` | number | `2` (floored at 0) | FOK-then-reprice retries on a clean 0-fill hedge (`liveHedgeRetryAttempts`). |
| `LIVE_HEDGE_RETRY_BUDGET_MS` | number | `1500` (floored at 0) | Total time budget across hedge retries (`liveHedgeRetryBudgetMs`). |
| `LIVE_KALSHI_PREARM_ENABLED` | boolean | `true` | Pre-arm a resting Kalshi hedge order (`liveKalshiPrearmEnabled`). |
| `LIVE_KALSHI_PREARM_MAX_AGE_MS` | number | `5000` | Max age of a pre-armed Kalshi order (`liveKalshiPrearmMaxAgeMs`). |
| `LIVE_KALSHI_PREARM_PRICE_POLICY` | enum (`patch_after_fill`) | `patch_after_fill` | Pre-arm pricing policy (`liveKalshiPrearmPricePolicy`). |
| `LIVE_KALSHI_ORDER_GROUP_ENABLED` | boolean | `true` | Use a Kalshi order group for collateral safety (`liveKalshiOrderGroupEnabled`). |
| `LIVE_KALSHI_ORDER_GROUP_ID` | string | `""` | Pre-created Kalshi order-group id (`liveKalshiOrderGroupId`). |

`LIVE_ORDER_PLACEMENT_MODE` accepts: `parallel_market`, `parallel_quick`, `parallel_fok`,
`parallel_fak`, `parallel_limit_rest`, `polymarket_first_exact`, `kalshi_first_exact`.

### Quote quality

| Env var | Type | Default | Purpose |
| --- | --- | --- | --- |
| `LIVE_TAKER_PRICE_CUSHION_CENTS` | number | `2` | Cents cushion added to taker limit prices (`liveTakerPriceCushionCents`). |
| `LIVE_FEE_AWARE_GATE_ENABLED` | boolean | `false` | Subtract expected Kalshi taker fee in the entry gate (`liveFeeAwareGateEnabled`). |
| `LIVE_POLYMARKET_FIRST_CROSS_CENTS` | number | `0` (floored at 0) | Extra marketable offset on the Polymarket first-leg FAK limit (`livePolymarketFirstCrossCents`). |
| `LIVE_MIN_EXPIRY_MS` | number | `30000` | Min time-to-expiry to enter (`liveMinExpiryMs`). |
| `LIVE_MAX_TRADES_PER_WINDOW` | number | `3` | Max entries per 15-min window (`liveMaxTradesPerWindow`). |
| `LIVE_COLLATERAL_BUFFER_DOLLARS` | number | `0.25` | Collateral headroom buffer (`liveCollateralBufferDollars`). |
| `LIVE_KALSHI_MIN_CASH_DOLLARS` | number | `5` | Min Kalshi cash required to trade (`liveKalshiMinCashDollars`). |
| `LIVE_QUOTE_MAX_AGE_MS` | number | `750` | General per-leg quote freshness bound (`liveQuoteMaxAgeMs`). |
| `LIVE_POLYMARKET_QUOTE_MAX_AGE_MS` | number | value of `LIVE_QUOTE_MAX_AGE_MS` (clamped tighter) | Optional tighter bound for the Polymarket leg (`livePolymarketQuoteMaxAgeMs`). |
| `LIVE_HEDGE_QUOTE_MAX_AGE_MS` | number | value of `LIVE_QUOTE_MAX_AGE_MS` (clamped looser) | Optional looser bound for the hedge leg (`liveHedgeQuoteMaxAgeMs`). |
| `LIVE_QUOTE_SYNC_MAX_SKEW_MS` | number | `250` | Max allowed skew between the two legs' quotes (`liveQuoteSyncMaxSkewMs`). |
| `LIVE_QUOTE_SKEW_BOTH_FRESH_ENABLED` | boolean | `true` | Skip skew gate when both legs are individually fresh (`liveQuoteSkewBothFreshEnabled`). |
| `LIVE_MIN_BOOK_DEPTH_SHARES` | number | `10` | Min top-of-book depth to consider (`liveMinBookDepthShares`). |
| `LIVE_MIN_EXECUTABLE_LIQUIDITY_SHARES` | number | `0` (off; floored at 0) | Anti-dust: require N genuine ask shares in band (`liveMinExecutableLiquidityShares`). |
| `LIVE_MAX_EXECUTABLE_ASK_SLIPPAGE_CENTS` | number | `0` (off; floored at 0) | Anti-dust: bound worstAsk(size)−topAsk slippage (`liveMaxExecutableAskSlippageCents`). |
| `LIVE_ORDER_TIMEOUT_MS` | number | `2500` | Per-order submit/response timeout (`liveOrderTimeoutMs`). |
| `LIVE_QUOTE_FRESHNESS_FROM_WS_ONLY` | boolean | `false` | Only WS snapshots advance freshness, not discovery (`liveQuoteFreshnessFromWsOnly`). |
| `LIVE_REENTRY_SKIP_ZERO_EXPOSURE` | boolean | `false` | Don't throttle re-entry on a zero-exposure no-fill (`liveReentrySkipZeroExposure`). |

### Confirmation

| Env var | Type | Default | Purpose |
| --- | --- | --- | --- |
| `LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES` | number | value of `LIVE_ORDER_SIZE` | Min Polymarket fill before Kalshi hedges (`livePolymarketFirstMinFillShares`). |
| `LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES` | number | `LIVE_ORDER_SIZE + 1` | Max in-band Polymarket fill (covers FAK overfill) (`livePolymarketFirstMaxFillShares`). |
| `LIVE_USER_STREAMS_ENABLED` | boolean | `true` | Use private user-fill streams for confirmation (`liveUserStreamsEnabled`). |
| `LIVE_USER_STREAM_PRETRADE_GRACE_MS` | number | `750` | Grace for user-stream readiness before trading (`liveUserStreamPretradeGraceMs`). |
| `LIVE_USER_STREAM_CONFIRM_TIMEOUT_MS` | number | `2500` | Timeout waiting for stream fill confirmation (`liveUserStreamConfirmTimeoutMs`). |
| `LIVE_PRETRADE_RETRY_ATTEMPTS` | number | `2` | Pre-trade readiness retry attempts (`livePretradeRetryAttempts`). |
| `LIVE_PRETRADE_RETRY_DELAY_MS` | number | `100` | Delay between pre-trade retries (`livePretradeRetryDelayMs`). |
| `LIVE_FINAL_RECOVERY_TIMEOUT_MS` | number | `3000` | Timeout for post-order final recovery poll (`liveFinalRecoveryTimeoutMs`). |
| `LIVE_FINAL_RECOVERY_POLL_MS` | number | `250` | Poll interval during final recovery (`liveFinalRecoveryPollMs`). |
| `LIVE_CONFIRMATION_FLAT_MISS_NONBLOCKING` | boolean | `true` | A flat (zero-fill) confirm miss is non-blocking (`liveConfirmationFlatMissNonBlocking`). |
| `LIVE_CONFIRMATION_OVERFILL_TOLERANT` | boolean | `false` | Treat in-band FAK overfill as a clean two-sided fill (`liveConfirmationOverfillTolerant`). |
| `LIVE_CONFIRMATION_STATUS_TOLERANT` | boolean | `false` | Confirm on positive in-band fill regardless of lifecycle status (`liveConfirmationStatusTolerant`). |
| `LIVE_CONFIRM_ACCEPT_REST_EVIDENCE` | boolean | `false` | Accept REST order-response fill evidence on a stream timeout (`liveConfirmationAcceptRestEvidence`). |
| `LIVE_ACCEPT_STREAM_ACK_AS_ORDER_RESULT` | boolean | `false` | Finalize Polymarket result from stream ack before REST returns (`liveAcceptStreamAckAsOrderResult`). |
| `LIVE_POLYMARKET_TIMEOUT_RECOVERY_RESOLVES_NO_FILL` | boolean | `false` | Treat a not-found timeout-recovery as a definitive no-fill (`livePolymarketTimeoutRecoveryResolvesNoFill`). |
| `LIVE_EXACT_EXPOSURE_REQUIRED` | boolean | `false` | Require exact matched exposure across legs (`liveExactExposureRequired`). |

### Fill quality / lead-lag

| Env var | Type | Default | Purpose |
| --- | --- | --- | --- |
| `LIVE_EXECUTION_QUALITY_GATE_ENABLED` | boolean | `true` | Gate entries on recent execution-quality stats (`liveExecutionQualityGateEnabled`). |
| `LIVE_EXECUTION_QUALITY_LOOKBACK_MS` | number | `1800000` (30 min) | Lookback for execution-quality samples (`liveExecutionQualityLookbackMs`). |
| `LIVE_EXECUTION_QUALITY_SAMPLE_LIMIT` | number | `50` | Max execution-quality samples considered (`liveExecutionQualitySampleLimit`). |
| `LIVE_EXECUTION_QUALITY_MIN_SAMPLES` | number | `5` | Min samples before the gate applies (`liveExecutionQualityMinSamples`). |
| `LIVE_EXECUTION_QUALITY_MIN_EXACT_FILL_RATE` | number | `0.4` | Min exact-fill rate to keep trading (`liveExecutionQualityMinExactFillRate`). |
| `LIVE_SHADOW_LADDER_CAPTURE_ENABLED` | boolean | `false` | Capture per-leg ask ladders on rejected candidates (diagnostics) (`liveShadowLadderCaptureEnabled`). |
| `LIVE_SHADOW_LADDER_PROBE_SIZES` | list | `1,2,3,5` | Probe sizes for shadow-ladder capture (`liveShadowLadderProbeSizes`). |
| `LIVE_FILL_QUALITY_SCORING_ENABLED` | boolean | `true` | Compute fill-quality scores (telemetry) (`liveFillQualityScoringEnabled`). |
| `LIVE_FILL_QUALITY_GATE_ENABLED` | boolean | `false` | Gate entries on fill-quality score (`liveFillQualityGateEnabled`). |
| `LIVE_FILL_QUALITY_MIN_EXPECTED_EDGE` | number | `0.01` | Min expected edge from the fill-quality model (`liveFillQualityMinExpectedEdge`). |
| `LIVE_FILL_QUALITY_LOOKBACK_MS` | number | `1800000` (30 min) | Lookback for fill-quality samples (`liveFillQualityLookbackMs`). |
| `LIVE_FILL_QUALITY_SAMPLE_LIMIT` | number | `200` | Max fill-quality samples considered (`liveFillQualitySampleLimit`). |
| `LIVE_FILL_QUALITY_MIN_SAMPLES` | number | `30` | Min samples before the fill-quality gate applies (`liveFillQualityMinSamples`). |
| `LIVE_FILL_QUALITY_INPUT_CACHE_MAX_AGE_MS` | number | `0` (off) | Cache fill-quality input reads this long (`liveFillQualityInputCacheMaxAgeMs`). |
| `LIVE_FILL_QUALITY_MODEL_VERSION` | string | `heuristic-v1` | Fill-quality model version tag (`liveFillQualityModelVersion`). |
| `LIVE_LEAD_LAG_SCORING_ENABLED` | boolean | `true` | Compute lead-lag / adverse-selection scores (`liveLeadLagScoringEnabled`). |
| `LIVE_LEAD_LAG_GATE_ENABLED` | boolean | `false` | Gate entries on lead-lag score (`liveLeadLagGateEnabled`). |
| `LIVE_LEAD_LAG_MODEL_VERSION` | string | `heuristic-v1` | Lead-lag model version tag (`liveLeadLagModelVersion`). |
| `LIVE_LEAD_LAG_WINDOWS_MS` | list | `1000,5000,15000,60000` | Lookback windows for lead-lag scoring (`liveLeadLagWindowsMs`). |
| `LIVE_LEAD_LAG_MIN_CONFIDENCE` | number | `0.65` | Min lead-lag confidence to trade (`liveLeadLagMinConfidence`). |
| `LIVE_LEAD_LAG_MAX_ADVERSE_SELECTION_SCORE` | number | `0.75` | Max tolerated adverse-selection score (`liveLeadLagMaxAdverseSelectionScore`). |

### Risk / locks

| Env var | Type | Default | Purpose |
| --- | --- | --- | --- |
| `LIVE_AUTO_RESOLVE_VERIFIED_INCIDENTS` | boolean | `true` | Auto-resolve incidents verified flat (`liveAutoResolveVerifiedIncidents`). |
| `LIVE_AUTO_HARDLOCKS_ENABLED` | boolean | `true` | Allow auto hard-locks on loss-cap/exposure breach (`liveAutoHardlocksEnabled`). |
| `LIVE_PARTIAL_FILL_LOCK_MODE` | enum (`lock`/`quarantine`) | `quarantine` | How a one-sided partial fill is handled (`livePartialFillLockMode`). |
| `LIVE_MAX_UNRESOLVED_EXPOSURE_DOLLARS` | number | `10` | Cap on unresolved exposure before halting (`liveMaxUnresolvedExposureDollars`). |
| `LIVE_QUARANTINE_CAP_SETTLE_GRACE_MS` | number | `0` | Exclude settled-but-unreconciled quarantines from the cap after this age (`liveQuarantineCapSettleGraceMs`). |
| `LIVE_RECONCILE_BEFORE_TRADE` | boolean | `true` | Run reconciliation before each entry (`liveReconcileBeforeTrade`). |
| `LIVE_AUTO_UNWIND_ENABLED` | boolean | `false` | Loss-bounded same-window auto-unwind backstop (`liveAutoUnwindEnabled`). |
| `LIVE_AUTO_UNWIND_MAX_LOSS_DOLLARS` | number | `0.05` (floored at 0) | Max loss the auto-unwind may realize (`liveAutoUnwindMaxLossDollars`). |
| `LIVE_AUTO_UNWIND_TIMEOUT_MS` | number | `1500` (floored at 1) | Timeout for an auto-unwind order (`liveAutoUnwindTimeoutMs`). |

## Dashboard

| Env var | Type | Default | Purpose |
| --- | --- | --- | --- |
| `DASHBOARD_STREAM_INTERVAL_MS` | number | `1000` | Dashboard live-stream push cadence (`dashboardStreamIntervalMs`). |
| `DASHBOARD_SIGNAL_REFRESH_MS` | number | `1000` | Dashboard signal-table refresh cadence (`dashboardSignalRefreshMs`). |
| `DASHBOARD_ANALYTICS_REFRESH_MS` | number | `5000` | Dashboard analytics refresh cadence (`dashboardAnalyticsRefreshMs`). |
| `DASHBOARD_API_TOKEN` | string | `""` (required for live) | Bearer token shared with the Vercel dashboard (`dashboardApiToken`). |
| `DASHBOARD_REALTIME_SECRET` | string | `""` | Secret for the dashboard realtime channel (`dashboardRealtimeSecret`). |
| `EQUITY_BACKFILL_ON_BOOT` | boolean | `false` | One-time equity-curve realized-P&L backfill on boot (`equityBackfillOnBoot`). |

---

## Required (no safe default)

These default to empty strings in `loadConfig` but the worker cannot trade live without them.
Secrets — never commit. `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY` / `KALSHI_PRIVATE_KEY_B64`
are read in `src/kalshi/auth.ts` (and referenced inside `loadConfig` as the FIX SenderCompID
fallback); they throw at auth time if missing.

| Env var | Why required |
| --- | --- |
| `DATABASE_URL` | Postgres connection; nothing persists without it. |
| `KALSHI_API_KEY_ID` | Kalshi API auth key id (throws if missing at auth). |
| `KALSHI_PRIVATE_KEY` *(or `KALSHI_PRIVATE_KEY_B64`)* | Kalshi RSA signing key; one of the two is required. |
| `POLYMARKET_PRIVATE_KEY` | EOA key for CLOB order signing. |
| `POLYMARKET_FUNDER_ADDRESS` | Funder/proxy wallet that holds collateral. |
| `DASHBOARD_API_TOKEN` | Bearer token the dashboard uses to reach the worker API. |

L2 Polymarket creds (`POLYMARKET_API_KEY` / `_API_SECRET` / `_API_PASSPHRASE`) are optional —
they are derived from `POLYMARKET_PRIVATE_KEY` at runtime if left blank.

---

## Drift check (`pok-worker.env.example`)

`loadConfig` reads ~153 distinct keys (counting cross-key fallbacks like `KALSHI_PRIVATE_KEY_B64`,
`KALSHI_API_KEY_ID`, and `NODE_ENV` that are consumed outside `loadConfig`). The committed
template `deploy/vps/pok-worker.env.example` documents ~101 of them. The following keys that the
code reads are **absent from the example** — operators should sync them in (most are
default-inert flags, but the unset ones still merit a documented line):

**Core / runtime**
- `STALE_BOOK_MS`
- `MARKET_DISCOVERY_INTERVAL_MS`
- `DISCOVERY_BOUNDARY_REFRESH_ENABLED`

**Kalshi**
- `KALSHI_API_BASE`
- `KALSHI_UI_API_BASE`
- `KALSHI_UI_SESSION_PATH`
- `KALSHI_UI_MARKET_ID_CACHE_TTL_MS`
- `KALSHI_UI_QUICK_ORDER_CAP_VALIDATED`
- `KALSHI_WS_URL`
- `KALSHI_BOOK_FEED_SILENCE_MS`
- `KALSHI_SERIES_TICKER`

**Polymarket**
- `POLYMARKET_WS_URL`
- `POLYMARKET_BOOK_FEED_SILENCE_MS`
- `POLYMARKET_DISCOVERY_URL`
- `POLYMARKET_GEOBLOCK_GATE_ENABLED`

**Live execution — sizing / dynamic**
- `LIVE_DYNAMIC_SIZING_ENABLED`
- `LIVE_MIN_ORDER_SIZE`
- `LIVE_MAX_ORDER_SIZE`
- `LIVE_DYNAMIC_SIZING_MAX_KALSHI_SLIPPAGE_CENTS`
- `LIVE_DYNAMIC_SIZING_CASH_AWARE`

**Live execution — hot path / hedge**
- `LIVE_HOT_PATH_LOCK_CACHE_GRACE_MS`
- `LIVE_HOT_READINESS_BALANCE_COVERAGE_ENABLED`
- `LIVE_API_KEY_DERIVE_TIMEOUT_MS`
- `LIVE_HEDGE_RETRY_BUDGET_MS`

**Live execution — quote quality**
- `LIVE_FEE_AWARE_GATE_ENABLED`
- `LIVE_POLYMARKET_FIRST_CROSS_CENTS`
- `LIVE_POLYMARKET_QUOTE_MAX_AGE_MS`
- `LIVE_HEDGE_QUOTE_MAX_AGE_MS`
- `LIVE_QUOTE_SKEW_BOTH_FRESH_ENABLED`
- `LIVE_MIN_EXECUTABLE_LIQUIDITY_SHARES`
- `LIVE_MAX_EXECUTABLE_ASK_SLIPPAGE_CENTS`
- `LIVE_QUOTE_FRESHNESS_FROM_WS_ONLY`
- `LIVE_REENTRY_SKIP_ZERO_EXPOSURE`

**Live execution — confirmation**
- `LIVE_CONFIRMATION_FLAT_MISS_NONBLOCKING`
- `LIVE_CONFIRMATION_OVERFILL_TOLERANT`
- `LIVE_CONFIRMATION_STATUS_TOLERANT`
- `LIVE_CONFIRM_ACCEPT_REST_EVIDENCE`
- `LIVE_ACCEPT_STREAM_ACK_AS_ORDER_RESULT`
- `LIVE_POLYMARKET_TIMEOUT_RECOVERY_RESOLVES_NO_FILL`

**Live execution — fill quality / diagnostics**
- `LIVE_SHADOW_LADDER_CAPTURE_ENABLED`
- `LIVE_SHADOW_LADDER_PROBE_SIZES`
- `LIVE_FILL_QUALITY_INPUT_CACHE_MAX_AGE_MS`

**Live execution — risk / locks**
- `LIVE_QUARANTINE_CAP_SETTLE_GRACE_MS`
- `LIVE_AUTO_UNWIND_ENABLED`
- `LIVE_AUTO_UNWIND_MAX_LOSS_DOLLARS`
- `LIVE_AUTO_UNWIND_TIMEOUT_MS`

**Dashboard**
- `DASHBOARD_STREAM_INTERVAL_MS`
- `DASHBOARD_SIGNAL_REFRESH_MS`
- `DASHBOARD_ANALYTICS_REFRESH_MS`
- `DASHBOARD_REALTIME_SECRET`
- `EQUITY_BACKFILL_ON_BOOT`

> Note: the example does set `POLYMARKET_SIGNATURE_TYPE=3` and `ARB_REENTRY_INTERVAL_MS=60000`,
> which differ from the code defaults (`0` and `15000`). Those are intentional deployment
> overrides, not drift.
