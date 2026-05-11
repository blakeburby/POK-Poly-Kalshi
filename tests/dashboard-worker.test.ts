import test from "node:test";
import assert from "node:assert/strict";
import { BookStore } from "../src/books/book-store";
import { buildDashboardAnalytics } from "../src/analytics/performance";
import { dashboardRequestAuthorized, createDashboardSnapshot, formatSseEvent, type DashboardRuntime, type DashboardSnapshotCache } from "../src/dashboard/worker-api";
import type { AppConfig } from "../src/config";
import { LatencyMonitor } from "../src/latency/metrics";
import type { DashboardSignal } from "../src/types";
import { contract } from "./helpers";

function config(input: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8080,
    databaseUrl: "",
    arbEnabled: true,
    liveTrading: false,
    minProfitDollars: 0.05,
    reentryIntervalMs: 15_000,
    staleBookMs: 10_000,
    marketDiscoveryIntervalMs: 30_000,
    dashboardStreamIntervalMs: 250,
    dashboardSignalRefreshMs: 1_000,
    dashboardAnalyticsRefreshMs: 5_000,
    executionConcurrency: 2,
    discoveryBoundaryRefreshEnabled: true,
    kalshiApiBase: "",
    kalshiWsUrl: "",
    kalshiSeriesTicker: "KXBTC15M",
    polymarketWsUrl: "",
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
    polymarketOrderType: "FOK",
    liveOrderSize: 1,
    liveMaxSlippageCents: 1,
    liveMinExpiryMs: 30_000,
    liveMaxTradesPerWindow: 1,
    liveCollateralBufferDollars: 0.25,
    liveQuoteMaxAgeMs: 750,
    liveQuoteSyncMaxSkewMs: 250,
    liveMinBookDepthShares: 1,
    liveOrderTimeoutMs: 2_500,
    liveHedgeMaxLossDollars: 0.02,
    liveHedgeFeeBufferDollars: 0.01,
    liveOrderPlacementMode: "parallel_limit_rest",
    liveAggressiveLimitRestMs: 500,
    liveParallelExecutionEnabled: false,
    liveHotPathEnabled: false,
    liveHotPathCacheMaxAgeMs: 5_000,
    liveHotPathWarmIntervalMs: 1_000,
    livePolymarketPresignEnabled: false,
    livePolymarketSignedOrderTtlMs: 5_000,
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
    livePartialFillLockMode: "quarantine",
    liveMaxUnresolvedExposureDollars: 10,
    liveReconcileBeforeTrade: false,
    kalshiUserWsUrl: "",
    polymarketUserWsUrl: "",
    dryRunSlippageEnabled: true,
    dryRunKalshiSlippageCents: 1,
    dryRunPolymarketSlippageCents: 1,
    dryRunMaxSlippageCents: 3,
    dryRunSlippageJitterCents: 1,
    dashboardApiToken: "secret-token",
    ...input,
  };
}

function signal(input: Partial<DashboardSignal> = {}): DashboardSignal {
  return {
    id: 7,
    createdAt: "2026-04-29T20:00:00.000Z",
    updatedAt: "2026-04-29T20:00:01.000Z",
    executionMode: "paper",
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
    ...input,
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
  books.setPolymarketContracts([contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, updatedAt: now })]);
  books.setKalshiContracts([contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, updatedAt: now })]);
  const runtime: DashboardRuntime = {
    config: config(),
    books,
    signals: {
      listRecentSignals: async (_limit, executionMode) => [signal({ id: executionMode === "live" ? 8 : 7, executionMode: executionMode ?? "paper" })],
      listFilledSignalsSince: async (_since, _limit, executionMode) => [signal({
        executionMode: executionMode ?? "paper",
        updatedAt: new Date(now - 1_000).toISOString(),
        kalshiFillPrice: 0.51,
        polymarketFillPrice: 0.41,
      })],
    },
    getScannerStatus: () => ({ scanning: false, lastScanAt: now - 500, lastCandidateCount: 1, queuedExecutions: 0, activeExecutions: 0 }),
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
    getExecutionReadiness: () => ({
      mode: "live",
      liveTrading: false,
      protectedOnly: true,
      orderSize: 1,
      orderType: "FOK",
      maxSlippageCents: 1,
      minExpiryMs: 30_000,
      maxTradesPerWindow: 1,
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
    }),
    getLogs: () => [{ timestamp: new Date(now).toISOString(), severity: "INFO", category: "SCANNER", message: "ok" }],
    getLatencySnapshot: (latencyNow, snapshotBuildMs) => {
      const latency = new LatencyMonitor();
      latency.recordWsToBookApply("kalshi", latencyNow - 3, latencyNow);
      latency.recordWsToBookApply("polymarket", latencyNow - 5, latencyNow);
      return latency.snapshot(books.snapshot(), latencyNow, runtime.config, snapshotBuildMs);
    },
  };

  const snapshot = await createDashboardSnapshot(runtime, now);
  assert.equal(snapshot.health.ok, true);
  assert.equal(snapshot.health.liveMaxTradesPerWindow, 1);
  assert.equal(snapshot.books.kalshi.length, 1);
  assert.equal(snapshot.books.polymarket.length, 1);
  assert.equal(snapshot.liveCandidates.length, 1);
  assert.equal(snapshot.syntheticStructures?.length, 2);
  assert.equal(snapshot.syntheticStructures?.[0].risk?.classification, "true_arbitrage");
  assert.equal(snapshot.syntheticStructures?.[1].risk?.classification, "probabilistic_bet");
  assert.equal(snapshot.diagnostics.polymarket.readyContracts, 1);
  assert.equal(snapshot.recentSignals[0].action, "filled");
  assert.equal(snapshot.recentSignals[0].executionMode, "paper");
  assert.equal(snapshot.paper.recentSignals[0].executionMode, "paper");
  assert.equal(snapshot.live.recentSignals[0].executionMode, "live");
  assert.equal(snapshot.analytics?.hourly.filledTrades, 1);
  assert.equal(snapshot.paper.analytics?.hourly.filledTrades, 1);
  assert.equal(snapshot.live.analytics?.hourly.filledTrades, 1);
  assert.equal(snapshot.analytics?.hourly.netPnl, 0.08);
  assert.equal(snapshot.analytics?.daily.window, "daily");
  assert.equal(snapshot.analytics?.weekly.window, "weekly");
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
    getScannerStatus: () => ({ scanning: false, lastScanAt: now, lastCandidateCount: 0, queuedExecutions: 0, activeExecutions: 0 }),
    getDiscoveryState: () => ({ lastDiscoveryAt: now, lastDiscoveryError: null }),
    getLogs: () => [],
  };
  const cache: DashboardSnapshotCache = {};

  await createDashboardSnapshot(runtime, now, cache);
  await createDashboardSnapshot(runtime, now + 250, cache);
  assert.equal(recentCalls, 2);
  assert.equal(analyticsCalls, 2);

  await createDashboardSnapshot(runtime, now + 1_001, cache);
  assert.equal(recentCalls, 4);
  assert.equal(analyticsCalls, 2);

  await createDashboardSnapshot(runtime, now + 5_001, cache);
  assert.equal(recentCalls, 6);
  assert.equal(analyticsCalls, 4);
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
    getScannerStatus: () => ({ scanning: false, lastScanAt: now, lastCandidateCount: 0, queuedExecutions: 0, activeExecutions: 0 }),
    getDiscoveryState: () => ({ lastDiscoveryAt: now, lastDiscoveryError: null }),
    getLogs: () => [],
  };

  await createDashboardSnapshot(runtime, now);
  await createDashboardSnapshot(runtime, now + 250);
  assert.equal(analyticsCalls, 0);
  assert.equal(hotAnalyticsCalls, 4);
});

test("dashboard stream events are valid SSE snapshot frames", () => {
  const frame = formatSseEvent("snapshot", { ok: true });
  assert.equal(frame, "event: snapshot\ndata: {\"ok\":true}\n\n");
});
