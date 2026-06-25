import test from "node:test";
import assert from "node:assert/strict";
import { BookStore } from "../src/books/book-store";
import { buildDashboardAnalytics } from "../src/analytics/performance";
import {
  dashboardRequestAuthorized,
  createDashboardSnapshot,
  buildSnapshotResponseBody,
  formatSseEvent,
  type DashboardRuntime,
  type DashboardSnapshotCache,
  type DashboardResponseCache,
} from "../src/dashboard/worker-api";
import type { AppConfig } from "../src/config";
import { LatencyMonitor } from "../src/latency/metrics";
import type { DashboardSignal, LiveExecutionReadiness } from "../src/types";
import type { TradingActivitySnapshot } from "../types/trading";
import { contract } from "./helpers";

function config(input: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8080,
    databaseUrl: "",
    arbEnabled: true,
    minProfitDollars: 0.01,
    reentryIntervalMs: 15_000,
    arbScanHeartbeatMs: 250,
    staleBookMs: 10_000,
    marketDiscoveryIntervalMs: 30_000,
    dashboardStreamIntervalMs: 250,
    dashboardSignalRefreshMs: 1_000,
    dashboardAnalyticsRefreshMs: 5_000,
    equityBackfillOnBoot: false,
    executionConcurrency: 2,
    discoveryBoundaryRefreshEnabled: true,
    kalshiApiBase: "",
    kalshiUiApiBase: "https://api.elections.kalshi.com",
    kalshiUiSessionPath: "/etc/pok-poly-kalshi/kalshi-ui-session.json",
    kalshiUiMarketIdCacheTtlMs: 60_000,
    kalshiUiQuickOrderCapValidated: false,
    kalshiFixHost: "mm.fix.elections.kalshi.com",
    kalshiFixPort: 8228,
    kalshiFixSenderCompId: "test-key",
    kalshiFixTargetCompId: "KalshiNR",
    kalshiFixHeartbeatSeconds: 10,
    kalshiFixConnectTimeoutMs: 1_500,
    kalshiFixOrderResponseTimeoutMs: 2_500,
    kalshiFixUseDollars: true,
    kalshiFixEnableIocCancelReport: true,
    kalshiFixPreserveOriginalOrderQty: true,
    kalshiWsUrl: "",
    kalshiBookFeedSilenceMs: 30_000,
    kalshiSeriesTicker: "KXBTC15M",
    polymarketWsUrl: "",
    polymarketBookFeedSilenceMs: 30_000,
    polymarketDiscoveryUrl: "",
    polymarketLiveDataWsUrl: "",
    polymarketPriceToBeatSymbol: "btc/usd",
    polymarketDiscoveryWindowOffsets: [-1, 0, 1],
    polymarketPriceCaptureToleranceMs: 5_000,
    polymarketMissedOpenBackfill: true,
    polymarketPrivateKey: "",
    polymarketApiKey: "",
    polymarketApiSecret: "",
    polymarketApiPassphrase: "",
    polymarketSignatureType: 0,
    polymarketFunderAddress: "",
    polymarketChainId: 137,
    polymarketClobHost: "https://clob.polymarket.com",
    polymarketGeoblockUrl: "https://polymarket.com/api/geoblock",
    polymarketGeoblockGateEnabled: true,
    polymarketOrderType: "FOK",
    liveOrderSize: 1,
    liveTakerPriceCushionCents: 2,
    liveMinExpiryMs: 30_000,
    liveMaxTradesPerWindow: 3,
    liveCollateralBufferDollars: 0.25,
    liveKalshiMinCashDollars: 5,
    liveQuoteMaxAgeMs: 750,
    liveQuoteSyncMaxSkewMs: 250,
    liveMinBookDepthShares: 1,
    liveMinExecutableLiquidityShares: 0,
    liveMaxExecutableAskSlippageCents: 0,
    liveShadowLadderCaptureEnabled: false,
    liveShadowLadderProbeSizes: [1, 2, 3, 5],
    liveOrderTimeoutMs: 2_500,
    liveHedgeMaxLossDollars: 0.02,
    liveHedgeFeeBufferDollars: 0.01,
    liveOrderPlacementMode: "parallel_limit_rest",
    kalshiHedgeOrderMode: "public_v2",
    liveAggressiveLimitRestMs: 500,
    liveParallelExecutionEnabled: false,
    liveHotPathEnabled: false,
    liveHotPathCacheMaxAgeMs: 5_000,
    liveHotPathWarmIntervalMs: 1_000,
    livePolymarketPresignEnabled: false,
    livePolymarketSignedOrderTtlMs: 5_000,
    livePolymarketFirstMinFillShares: 7,
    livePolymarketFirstMaxFillShares: 9,
    liveKalshiHedgeTimeInForce: "immediate_or_cancel",
    liveKalshiPrearmEnabled: true,
    liveKalshiPrearmMaxAgeMs: 5_000,
    liveKalshiPrearmPricePolicy: "patch_after_fill",
    liveLowLatencyHttpEnabled: true,
    liveKalshiOrderGroupEnabled: false,
    liveKalshiOrderGroupId: "",
    liveUserStreamsEnabled: false,
    liveUserStreamPretradeGraceMs: 750,
    liveUserStreamConfirmTimeoutMs: 2_500,
    livePretradeRetryAttempts: 2,
    livePretradeRetryDelayMs: 100,
    liveFinalRecoveryTimeoutMs: 3_000,
    liveFinalRecoveryPollMs: 250,
    liveAutoResolveVerifiedIncidents: true,
    liveAutoHardlocksEnabled: true,
    liveExactExposureRequired: false,
    liveExecutionQualityGateEnabled: true,
    liveExecutionQualityLookbackMs: 30 * 60 * 1_000,
    liveExecutionQualitySampleLimit: 50,
    liveExecutionQualityMinSamples: 5,
    liveExecutionQualityMinExactFillRate: 0.4,
    liveFillQualityScoringEnabled: true,
    liveFillQualityGateEnabled: false,
    liveFillQualityMinExpectedEdge: 0.01,
    liveFillQualityLookbackMs: 30 * 60 * 1_000,
    liveFillQualitySampleLimit: 200,
    liveFillQualityMinSamples: 30,
    liveFillQualityModelVersion: "heuristic-v1",
    liveLeadLagScoringEnabled: true,
    liveLeadLagGateEnabled: false,
    liveLeadLagModelVersion: "heuristic-v1",
    liveLeadLagWindowsMs: [1_000, 5_000, 15_000, 60_000],
    liveLeadLagMinConfidence: 0.65,
    liveLeadLagMaxAdverseSelectionScore: 0.75,
    livePartialFillLockMode: "quarantine",
    liveMaxUnresolvedExposureDollars: 10,
    liveMinPortfolioValueDollars: 0,
    liveReconcileBeforeTrade: false,
    kalshiUserWsUrl: "",
    polymarketUserWsUrl: "",
    dashboardApiToken: "secret-token",
    liveDynamicSizingEnabled: false,
    liveMinOrderSize: 8,
    liveMaxOrderSize: 8,
    liveDynamicSizingMaxKalshiSlippageCents: 10,
    liveDynamicSizingCashAware: false,
    liveFeeAwareGateEnabled: false,
    livePolymarketFirstCrossCents: 0,
    livePolymarketQuoteMaxAgeMs: 750,
    liveHedgeQuoteMaxAgeMs: 750,
    liveQuoteSkewBothFreshEnabled: true,
    liveApiKeyDeriveTimeoutMs: 15_000,
    liveHedgeMinCrossTicks: 2,
    liveHedgeRetryAttempts: 2,
    liveHedgeRetryBudgetMs: 1_500,
    liveHotReadinessBalanceCoverageEnabled: true,
    liveHotPathLockCacheGraceMs: 0,
    liveQuoteFreshnessFromWsOnly: false,
    liveReentrySkipZeroExposure: false,
    liveQuarantineCapSettleGraceMs: 0,
    liveConfirmationFlatMissNonBlocking: true,
    liveConfirmationOverfillTolerant: false,
    liveConfirmationStatusTolerant: false,
    liveConfirmationAcceptRestEvidence: false,
    liveAcceptStreamAckAsOrderResult: false,
    livePolymarketTimeoutRecoveryResolvesNoFill: false,
    liveFillQualityInputCacheMaxAgeMs: 0,
    liveAutoUnwindEnabled: false,
    liveAutoUnwindMaxLossDollars: 0.05,
    liveAutoUnwindTimeoutMs: 1_500,
    liveAutoUnwindResidualOnly: false,
    liveAutoUnwindRequireTerminalCounterLeg: true,
    liveAutoUnwindMaxLossCentsPerShare: 2,
    liveAutoUnwindMarketSell: false,
    livePolymarketSellAllowanceEnabled: false,
    liveNakedFlattenEnabled: false,
    liveNakedFlattenIntervalMs: 45_000,
    livePolymarketErrorConfigStripEnabled: false,
    liveHotPathTimingEnabled: false,
    dashboardSnapshotCacheMs: 1000,
    dashboardRealtimeSecret: "",
    ...input,
  };
}

function signal(input: Partial<DashboardSignal> = {}): DashboardSignal {
  return {
    id: 7,
    createdAt: "2026-04-29T20:00:00.000Z",
    updatedAt: "2026-04-29T20:00:01.000Z",
    pairKey: "pair",
    expiryMs: 1_800_000_000_000,
    kalshiContractId: "kalshi",
    polymarketContractId: "poly",
    lower: { venue: "polymarket", contractId: "poly", direction: "yes", strike: 1500, ask: 0.4 },
    higher: { venue: "kalshi", contractId: "kalshi", direction: "no", strike: 1502, ask: 0.5 },
    premium: 0.9,
    guaranteedProfit: 0.1,
    overlapProfit: 1.1,
    threshold: 0.05,
    action: "filled",
    failureReason: null,
    kalshiFillId: "kalshi-fill",
    polymarketFillId: "poly-fill",
    kalshiFillPrice: 0.5,
    polymarketFillPrice: 0.4,
    executionGroupId: "live-group",
    kalshiFillCount: 5,
    polymarketFillCount: 5,
    ...input,
  };
}

function tradingActivity(now: number): TradingActivitySnapshot {
  return {
    kalshi: {
      platform: "kalshi",
      connectionStatus: "live",
      lastUpdatedAt: now - 100,
      portfolio: {
        platform: "kalshi",
        portfolioValue: 25,
        cashValue: 20,
        dayChangeDollars: 1,
        dayChangePercent: 0.04,
        lastUpdatedAt: now - 100,
      },
      positions: [],
      openOrders: [],
      history: [
        {
          id: "kalshi-activity",
          activity: "Buy",
          marketName: "KXBTC15M",
          outcome: "NO",
          shares: 5,
          value: -2.5,
          timeMs: now - 100,
          venueOrderId: "kalshi-order",
          clientOrderId: "kalshi-client",
          status: "filled",
        },
      ],
      sparkline: [
        { timestamp: now - 86_400_000, value: 24 },
        { timestamp: now, value: 25 },
      ],
    },
    polymarket: {
      platform: "polymarket",
      connectionStatus: "live",
      lastUpdatedAt: now - 100,
      portfolio: {
        platform: "polymarket",
        portfolioValue: 35,
        cashValue: 30,
        dayChangeDollars: -1,
        dayChangePercent: -0.03,
        lastUpdatedAt: now - 100,
      },
      positions: [],
      openOrders: [],
      history: [
        {
          id: "poly-activity",
          activity: "Buy",
          marketName: "btc-updown-15m",
          outcome: "YES",
          shares: 5,
          value: -2,
          timeMs: now - 100,
          venueOrderId: "poly-order",
          clientOrderId: "poly-client",
          status: "matched",
        },
      ],
      sparkline: [
        { timestamp: now - 86_400_000, value: 36 },
        { timestamp: now, value: 35 },
      ],
    },
  };
}

test("dashboard bearer token accepts valid requests and rejects missing or invalid requests", () => {
  assert.equal(dashboardRequestAuthorized({ authorization: "Bearer secret-token" }, "secret-token"), true);
  assert.equal(dashboardRequestAuthorized({ authorization: "Bearer wrong-token" }, "secret-token"), false);
  assert.equal(dashboardRequestAuthorized({}, "secret-token"), false);
  assert.equal(dashboardRequestAuthorized({ authorization: "Bearer secret-token" }, ""), false);
});

test("dashboard snapshot includes books, scanner status, recent signals, live candidates, and logs", async () => {
  const books = new BookStore();
  const now = 1_800_000_000_000;
  books.setPolymarketContracts([
    contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, updatedAt: now }),
  ]);
  books.setKalshiContracts([
    contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, updatedAt: now }),
  ]);
  const runtime: DashboardRuntime = {
    config: config(),
    books,
    signals: {
      listRecentSignals: async () => [signal()],
      listFilledSignalsSince: async () => [
        signal({
          updatedAt: new Date(now - 1_000).toISOString(),
          kalshiFillPrice: 0.51,
          polymarketFillPrice: 0.41,
        }),
      ],
    },
    getScannerStatus: () => ({
      scanning: false,
      lastScanAt: now - 500,
      lastCandidateCount: 1,
      queuedExecutions: 0,
      activeExecutions: 0,
    }),
    getDiscoveryState: () => ({ lastDiscoveryAt: now - 1000, lastDiscoveryError: null }),
    getPolymarketDiagnostics: () => ({
      marketsFound: 1,
      readyContracts: 1,
      pendingStrikeCount: 0,
      missingStrikeCount: 0,
      invalidMarketCount: 0,
      lastChainlinkTickAt: now - 200,
      lastChainlinkTickAgeMs: 200,
      nextCaptureWindowStartMs: null,
      skippedReasons: [],
      markets: [],
    }),
    getExecutionReadiness: () =>
      ({
        mode: "live",
        liveTrading: true,
        protectedOnly: true,
        orderSize: 1,
        orderType: "FOK",
        takerPriceCushionCents: 2,
        minExpiryMs: 30_000,
        maxTradesPerWindow: 3,
        collateralBufferDollars: 0.25,
        partialFillLocked: false,
        circuitBreakerLocked: false,
        circuitBreakerReason: null,
        circuitBreaker: null,
        kalshi: { configured: true, ready: true, reason: null, balance: null, allowance: null, lastCheckedAt: now },
        polymarket: {
          configured: true,
          ready: false,
          reason: "Polymarket collateral balance 0 is below required canary collateral 1",
          balance: 0,
          allowance: 10,
          lastCheckedAt: now,
          signerAddress: "0x1111...2222",
          funderAddress: "0x3333...4444",
          signatureType: 2,
          collateralBalanceRaw: 0,
          collateralBalanceNormalized: 0,
          collateralAllowanceRaw: 10_000_000,
          collateralAllowanceNormalized: 10,
          requiredCollateral: 1,
        },
        lastAttempt: null,
      }) as unknown as LiveExecutionReadiness,
    getLogs: () => [{ timestamp: new Date(now).toISOString(), severity: "INFO", category: "SCANNER", message: "ok" }],
    getLatencySnapshot: (latencyNow, snapshotBuildMs) => {
      const latency = new LatencyMonitor();
      latency.recordWsToBookApply("kalshi", latencyNow - 3, latencyNow);
      latency.recordWsToBookApply("polymarket", latencyNow - 5, latencyNow);
      return latency.snapshot(books.snapshot(), latencyNow, runtime.config, snapshotBuildMs);
    },
    getTradingActivity: (snapshotNow) => tradingActivity(snapshotNow),
  };

  const snapshot = await createDashboardSnapshot(runtime, now);
  assert.equal(snapshot.health.ok, true);
  assert.equal(snapshot.health.scanHeartbeatMs, 250);
  assert.equal(snapshot.health.liveMaxTradesPerWindow, 3);
  assert.equal(snapshot.health.liveOrderSize, 1);
  assert.equal(snapshot.health.liveKalshiMinCashDollars, 5);
  assert.equal(snapshot.health.livePolymarketFirstMinFillShares, 7);
  assert.equal(snapshot.health.livePolymarketFirstMaxFillShares, 9);
  assert.equal(snapshot.health.liveLeadLagScoringEnabled, true);
  assert.equal(snapshot.health.liveLeadLagGateEnabled, false);
  assert.equal(snapshot.scanner.lastScanAgeMs, 500);
  assert.equal(snapshot.books.kalshi.length, 1);
  assert.equal(snapshot.books.polymarket.length, 1);
  assert.equal(snapshot.liveCandidates.length, 1);
  assert.equal(snapshot.syntheticStructures?.length, 2);
  assert.equal(snapshot.syntheticStructures?.[0].risk?.classification, "true_arbitrage");
  assert.equal(snapshot.syntheticStructures?.[1].risk?.classification, "probabilistic_bet");
  assert.equal(snapshot.diagnostics.polymarket.readyContracts, 1);
  assert.equal(snapshot.recentSignals[0].action, "filled");
  assert.equal(snapshot.analytics?.hourly.filledTrades, 1);
  assert.equal(snapshot.analytics?.hourly.netPnl, 0.08);
  assert.equal(snapshot.analytics?.daily.window, "daily");
  assert.equal(snapshot.analytics?.weekly.window, "weekly");
  assert.equal(snapshot.tradingActivity.kalshi.history[0].venueOrderId, "kalshi-order");
  assert.equal(snapshot.tradingActivity.polymarket.history[0].venueOrderId, "poly-order");
  assert.equal(snapshot.execution?.polymarket.ready, false);
  assert.equal(snapshot.execution?.circuitBreakerLocked, false);
  assert.equal(snapshot.execution?.polymarket.funderAddress, "0x3333...4444");
  assert.equal(snapshot.execution?.polymarket.collateralBalanceNormalized, 0);
  assert.equal(snapshot.logs[0].category, "SCANNER");
  assert.equal(snapshot.latency?.books.kalshi.latestMs, 0);
  assert.equal(snapshot.latency?.wsToBookApplyMs.kalshi.latestMs, 3);
  assert.equal(snapshot.latency?.dashboard.streamIntervalMs, 250);
});

test("dashboard snapshot cache avoids querying heavy DB-backed sections on every stream tick", async () => {
  const books = new BookStore();
  const now = 1_800_000_000_000;
  let recentCalls = 0;
  let analyticsCalls = 0;
  const runtime: DashboardRuntime = {
    config: config(),
    books,
    signals: {
      listRecentSignals: async () => {
        recentCalls += 1;
        return [signal()];
      },
      listFilledSignalsSince: async () => {
        analyticsCalls += 1;
        return [signal()];
      },
    },
    getScannerStatus: () => ({
      scanning: false,
      lastScanAt: now,
      lastCandidateCount: 0,
      queuedExecutions: 0,
      activeExecutions: 0,
    }),
    getDiscoveryState: () => ({ lastDiscoveryAt: now, lastDiscoveryError: null }),
    getLogs: () => [],
  };
  const cache: DashboardSnapshotCache = {};

  await createDashboardSnapshot(runtime, now, cache);
  await createDashboardSnapshot(runtime, now + 250, cache);
  assert.equal(recentCalls, 1);
  assert.equal(analyticsCalls, 1);

  await createDashboardSnapshot(runtime, now + 1_001, cache);
  assert.equal(recentCalls, 2);
  assert.equal(analyticsCalls, 1);

  await createDashboardSnapshot(runtime, now + 5_001, cache);
  assert.equal(recentCalls, 3);
  assert.equal(analyticsCalls, 2);
});

test("dashboard snapshot RESPONSE cache reuses the serialized body within the TTL, rebuilds after", async () => {
  const books = new BookStore();
  const now = 1_800_000_000_000;
  const makeRuntime = (cacheMs: number): DashboardRuntime => ({
    config: { ...config(), dashboardSnapshotCacheMs: cacheMs },
    books,
    signals: {
      listRecentSignals: async () => [signal()],
      listFilledSignalsSince: async () => [signal()],
    },
    getScannerStatus: () => ({
      scanning: false,
      lastScanAt: now,
      lastCandidateCount: 0,
      queuedExecutions: 0,
      activeExecutions: 0,
    }),
    getDiscoveryState: () => ({ lastDiscoveryAt: now, lastDiscoveryError: null }),
    getLogs: () => [],
  });

  const runtime = makeRuntime(1_000);
  const rc: DashboardResponseCache = {};
  const b1 = await buildSnapshotResponseBody(runtime, now, rc);
  const b2 = await buildSnapshotResponseBody(runtime, now + 500, rc); // within TTL -> cached
  const b3 = await buildSnapshotResponseBody(runtime, now + 1_001, rc); // past TTL -> rebuilt
  assert.equal(b2, b1); // byte-identical serialized body (cache hit, no rebuild/re-serialize)
  assert.notEqual(b3, b1);
  assert.equal(JSON.parse(b1).generatedAt, now);
  assert.equal(JSON.parse(b3).generatedAt, now + 1_001);

  // TTL=0 disables the cache: each call rebuilds with a fresh generatedAt.
  const off = makeRuntime(0);
  const rc2: DashboardResponseCache = {};
  const c1 = await buildSnapshotResponseBody(off, now, rc2);
  const c2 = await buildSnapshotResponseBody(off, now + 10, rc2);
  assert.notEqual(c2, c1);
});

test("dashboard snapshot uses hot analytics provider without polling filled signals", async () => {
  const books = new BookStore();
  const now = 1_800_000_000_000;
  let analyticsCalls = 0;
  let hotAnalyticsCalls = 0;
  const runtime: DashboardRuntime = {
    config: config(),
    books,
    signals: {
      listRecentSignals: async () => [],
      listFilledSignalsSince: async () => {
        analyticsCalls += 1;
        return [signal()];
      },
    },
    getAnalytics: (snapshotNow) => {
      hotAnalyticsCalls += 1;
      return buildDashboardAnalytics([signal()], snapshotNow, {
        mode: "hot_cache",
        lastUpdatedAt: snapshotNow,
        lastDbReconciledAt: snapshotNow - 500,
        computeMs: 1,
        sourceSignalCount: 1,
        stale: false,
      });
    },
    getScannerStatus: () => ({
      scanning: false,
      lastScanAt: now,
      lastCandidateCount: 0,
      queuedExecutions: 0,
      activeExecutions: 0,
    }),
    getDiscoveryState: () => ({ lastDiscoveryAt: now, lastDiscoveryError: null }),
    getLogs: () => [],
  };

  await createDashboardSnapshot(runtime, now);
  await createDashboardSnapshot(runtime, now + 250);
  assert.equal(analyticsCalls, 0);
  assert.equal(hotAnalyticsCalls, 2);
});

test("dashboard stream events are valid SSE snapshot frames", () => {
  const frame = formatSseEvent("snapshot", { ok: true });
  assert.equal(frame, 'event: snapshot\ndata: {"ok":true}\n\n');
});

test("dashboard stream can emit sanitized trading activity frames", () => {
  const frame = formatSseEvent("tradingActivity", {
    platform: "polymarket",
    row: { id: "row", venueOrderId: "order-id" },
  });
  assert.equal(frame.includes("PRIVATE_KEY"), false);
  assert.match(frame, /^event: tradingActivity/);
  assert.match(frame, /order-id/);
});
