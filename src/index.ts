import { createServer } from "node:http";
import { oldestAnalyticsSinceMs } from "./analytics/performance";
import { AnalyticsStore } from "./analytics/store";
import { BookStore } from "./books/book-store";
import { loadConfig } from "./config";
import { handleDashboardRequest } from "./dashboard/worker-api";
import { DashboardSignalsNotifier } from "./dashboard/signals-notifier";
import { createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { LiveExecutionLockStore } from "./db/live-execution-locks";
import { PolymarketPriceBeatStore } from "./db/polymarket-price-beats";
import { SignalStore } from "./db/signals";
import { VenueOrderEventHub, VenueOrderEventStore } from "./db/venue-order-events";
import { discoverKalshiBtcContracts } from "./discovery/kalshi";
import { discoverPolymarketBtcContractsWithDiagnostics, emptyPolymarketDiagnostics } from "./discovery/polymarket";
import { LiveExecutor } from "./execution/executor";
import { buildPublicWorkerHealth } from "./health";
import { startRuntimeHealthMonitor, sampleRuntimeHealth, getRuntimeHealth } from "./diagnostics/runtime-health";
import { installLowLatencyHttpTransport, preconnectLiveHttpEndpoints } from "./execution/http-transport";
import { CachedLiveExecutionLockStore, LiveExposureCache } from "./execution/live-hot-path";
import { buildUserStreamReadiness, LiveVenueConfirmationCoordinator } from "./execution/venue-confirmations";
import { KalshiTickerClient } from "./kalshi/client";
import { KalshiUserStreamClient } from "./kalshi/user-stream";
import { LatencyMonitor } from "./latency/metrics";
import { getRecentLogs, logEvent } from "./logger";
import { PolymarketBookClient } from "./polymarket/client";
import { PolymarketPriceToBeatService } from "./polymarket/price-to-beat";
import { PolymarketUserStreamClient } from "./polymarket/user-stream";
import { ReentryThrottle } from "./scanner/reentry";
import { CrossVenueArbScanner } from "./scanner/scanner";
import { computeVenuePnl } from "./trading/venue-pnl";
import { PortfolioEquityStore } from "./db/portfolio-equity";
import { EquitySampler } from "./trading/equity-sampler";
import { CoalescedScanScheduler, createScanHeartbeat } from "./scanner/scheduler";
import { createIdempotentShutdown } from "./shutdown";
import { TradingActivityStore, tradingActivityEventFromVenueEvent } from "./trading/activity";
import type { PolymarketDiagnostics } from "./types";

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const config = loadConfig();
  installLowLatencyHttpTransport(config);
  void preconnectLiveHttpEndpoints(config);
  const pool = createPool(config);
  await runMigrations(pool);

  const books = new BookStore(config.liveOrderSize, config.liveQuoteFreshnessFromWsOnly);
  const signals = new SignalStore(pool, config.liveQuarantineCapSettleGraceMs);
  const baseLiveLocks = new LiveExecutionLockStore(pool);
  const cachedLiveLocks = config.liveHotPathEnabled ? new CachedLiveExecutionLockStore(baseLiveLocks, config.liveHotPathCacheMaxAgeMs, Date.now, config.liveHotPathLockCacheGraceMs) : null;
  const liveLocks = cachedLiveLocks ?? baseLiveLocks;
  const liveExposureCache = config.liveHotPathEnabled
    ? new LiveExposureCache(signals, config.liveHotPathCacheMaxAgeMs, config.liveMaxUnresolvedExposureDollars)
    : null;
  const liveExposure = liveExposureCache ?? signals;
  const orderEvents = new VenueOrderEventHub(new VenueOrderEventStore(pool));
  const tradingActivity = new TradingActivityStore(pool, config);
  // Dashboard-only: persistent combined-portfolio equity curve. Sampled passively off the
  // dashboard's trading-activity refresh (no extra venue calls), failure-isolated; the
  // trading path never reads this table.
  const portfolioEquity = new PortfolioEquityStore(pool);
  const equitySampler = new EquitySampler(portfolioEquity);
  // Optional one-time seed (off by default): reconstruct an APPROXIMATE historical curve from
  // realized arb P&L, anchored to today's real equity. Realized-only (no historical open-position
  // MTM), ignores deposits/withdrawals — the live sampler is the source of truth going forward.
  if (config.equityBackfillOnBoot) {
    void (async (): Promise<void> => {
      try {
        if ((await portfolioEquity.count()) > 0) return;
        const now = Date.now();
        const activity = await tradingActivity.getSnapshot({ now });
        const current = (activity.kalshi.portfolio.portfolioValue ?? 0) + (activity.polymarket.portfolio.portfolioValue ?? 0);
        const fills = (await signals.listFilledSignalsSince(0, 50_000))
          .map((s) => ({ t: new Date(s.updatedAt).getTime(), pnl: (s.realizedGuaranteedProfit ?? 0) * config.liveOrderSize }))
          .filter((f) => Number.isFinite(f.t))
          .sort((a, b) => a.t - b.t);
        const total = fills.reduce((acc, f) => acc + f.pnl, 0);
        let cum = 0;
        const points = fills.map((f) => {
          cum += f.pnl;
          return { sampledAtMs: f.t, kalshiValue: null, polymarketValue: null, combinedValue: current - (total - cum), kalshiCash: null, polymarketCash: null, source: "reconstructed" as const };
        });
        if (points.length) await portfolioEquity.recordMany(points);
        logEvent({ severity: "INFO", category: "DB", message: "equity curve backfilled", context: { points: points.length } });
      } catch (error) {
        logEvent({ severity: "WARN", category: "DB", message: "equity backfill failed", context: { error: error instanceof Error ? error.message : String(error) } });
      }
    })();
  }
  const priceBeats = new PolymarketPriceBeatStore(pool);
  const reentry = new ReentryThrottle(config.reentryIntervalMs);
  const latency = new LatencyMonitor();
  reentry.hydrate(await signals.loadRecentFilledAttempts());
  const liveAnalytics = new AnalyticsStore();
  async function reconcileAnalytics(): Promise<void> {
    const now = Date.now();
    const sinceMs = oldestAnalyticsSinceMs(now);
    const liveSignals = await signals.listFilledSignalsSince(sinceMs, 10_000);
    liveAnalytics.reconcileFilledSignals(liveSignals, now);
  }
  await reconcileAnalytics();
  const kalshiUserStream = config.liveUserStreamsEnabled ? new KalshiUserStreamClient(config.kalshiUserWsUrl, orderEvents) : null;
  const polymarketUserStream = config.liveUserStreamsEnabled ? PolymarketUserStreamClient.fromConfig(config, orderEvents) : null;
  const confirmationMonitor = new LiveVenueConfirmationCoordinator({
    enabled: config.liveUserStreamsEnabled,
    confirmTimeoutMs: config.liveUserStreamConfirmTimeoutMs,
    reconcileBeforeTrade: config.liveReconcileBeforeTrade,
    eventSource: orderEvents,
    streamReadiness: (now) => buildUserStreamReadiness(
      config.liveUserStreamsEnabled,
      config.liveUserStreamConfirmTimeoutMs,
      kalshiUserStream?.status(),
      polymarketUserStream?.status(),
      now,
    ),
    reconciliationStore: liveExposure,
    maxUnresolvedExposureDollars: config.liveMaxUnresolvedExposureDollars,
    autoHardlocksEnabled: config.liveAutoHardlocksEnabled,
    flatMissNonBlocking: config.liveConfirmationFlatMissNonBlocking,
    // Floor-hedge band: a Polymarket fractional overfill up to this many shares over the order size is
    // hedged + cap-quarantined by the executor (T1.1), not a circuit-breaker event.
    overfillToleranceShares: Math.max(0, config.livePolymarketFirstMaxFillShares - config.liveOrderSize),
    // When on, the same band also makes an in-band overfill CONFIRM (not mismatch) so a near-complete
    // hedged fill is classified as filled instead of quarantined. Off by default (strict-exact).
    confirmationOverfillTolerant: config.liveConfirmationOverfillTolerant,
    // C1: confirm an in-band positive fill even when the resolving stream event carries a non-whitelisted
    // Polymarket lifecycle status (e.g. "mined") instead of quarantining it as a confirmation mismatch.
    confirmationStatusTolerant: config.liveConfirmationStatusTolerant,
    allowUnresolvedRisk: !config.liveAutoHardlocksEnabled,
    liveLocks,
    now: Date.now,
  });
  const liveReadinessProbe = new LiveExecutor(config, books, undefined, undefined, Date.now, liveLocks, orderEvents, confirmationMonitor, liveExposure);
  // One shared notifier: the scanner fires it after each real-attempt persist; open dashboard realtime
  // streams subscribe and push the new ledger row within ~network RTT (instead of the TTL-bounded poll).
  const signalsNotifier = new DashboardSignalsNotifier();
  const scanner = new CrossVenueArbScanner(books, signals, liveReadinessProbe, reentry, {
    enabled: config.arbEnabled,
    minProfitDollars: config.minProfitDollars,
    staleBookMs: config.staleBookMs,
    executionConcurrency: config.executionConcurrency,
    maxLiveTradesPerWindow: config.liveMaxTradesPerWindow,
    maxUnresolvedExposureDollars: config.liveMaxUnresolvedExposureDollars,
    liveAutoHardlocksEnabled: config.liveAutoHardlocksEnabled,
    liveReentrySkipZeroExposure: config.liveReentrySkipZeroExposure,
    liveExactExposureRequired: config.liveExactExposureRequired,
    liveExecutionQualityGateEnabled: config.liveExecutionQualityGateEnabled,
    liveExecutionQualityOptions: {
      enabled: config.liveExecutionQualityGateEnabled,
      lookbackMs: config.liveExecutionQualityLookbackMs,
      sampleLimit: config.liveExecutionQualitySampleLimit,
      minSamples: config.liveExecutionQualityMinSamples,
      minExactFillRate: config.liveExecutionQualityMinExactFillRate,
    },
    liveExposure,
    liveLocks,
    deferLivePersistence: config.liveHotPathEnabled,
    latency,
    analytics: liveAnalytics,
    signalsNotifier,
  });
  const scanScheduler = new CoalescedScanScheduler(scanner, latency);

  const kalshi = new KalshiTickerClient(config.kalshiWsUrl, undefined, {
    feedSilenceMs: config.kalshiBookFeedSilenceMs,
  });
  const polymarket = new PolymarketBookClient(config.polymarketWsUrl, undefined, {
    feedSilenceMs: config.polymarketBookFeedSilenceMs,
  });
  let queueRediscovery = (): void => {};
  const polymarketPriceToBeat = new PolymarketPriceToBeatService({
    url: config.polymarketLiveDataWsUrl,
    symbol: config.polymarketPriceToBeatSymbol,
    toleranceMs: config.polymarketPriceCaptureToleranceMs,
    store: priceBeats,
    onCapture: () => queueRediscovery(),
  });
  let lastDiscoveryAt = 0;
  let lastDiscoveryError: string | null = null;
  let polymarketDiagnostics: PolymarketDiagnostics = emptyPolymarketDiagnostics();

  kalshi.onSnapshot((snapshot) => {
    const appliedAt = Date.now();
    books.applyKalshiSnapshot(snapshot);
    latency.recordWsToBookApply("kalshi", snapshot.timestamp, appliedAt);
    scanScheduler.requestScan(appliedAt);
  });
  polymarket.onSnapshot((snapshot) => {
    const appliedAt = Date.now();
    books.applyPolymarketSnapshot(snapshot);
    latency.recordWsToBookApply("polymarket", snapshot.timestamp, appliedAt);
    scanScheduler.requestScan(appliedAt);
  });

  function livePolymarketDiagnostics(now = Date.now()): PolymarketDiagnostics {
    const runtime = polymarketPriceToBeat.getDiagnostics(now);
    return {
      ...polymarketDiagnostics,
      lastChainlinkTickAt: runtime.lastChainlinkTickAt,
      lastChainlinkTickAgeMs: runtime.lastChainlinkTickAgeMs,
      nextCaptureWindowStartMs: runtime.nextCaptureWindowStartMs ?? polymarketDiagnostics.nextCaptureWindowStartMs,
    };
  }

  let discoveryInFlight: Promise<void> | null = null;
  let discoveryRetryTimer: NodeJS.Timeout | null = null;
  function refreshDiscovery(): Promise<void> {
    if (discoveryInFlight) return discoveryInFlight;
    discoveryInFlight = (async () => {
      try {
        const [kalshiContracts, polymarketResult] = await Promise.all([
          discoverKalshiBtcContracts(config),
          discoverPolymarketBtcContractsWithDiagnostics(config, Date.now(), { priceBeatStore: priceBeats }),
        ]);
        books.setKalshiContracts(kalshiContracts);
        books.setPolymarketContracts(polymarketResult.contracts);
        polymarketDiagnostics = polymarketResult.diagnostics;
        polymarketPriceToBeat.setCaptureWindows(polymarketResult.captureWindows);
        kalshi.setSubscriptions(books.getKalshiTickers());
        polymarket.setSubscriptions(books.getPolymarketTokenIds());
        if (config.liveUserStreamsEnabled) {
          kalshiUserStream?.setSubscriptions(books.getKalshiTickers());
          polymarketUserStream?.setSubscriptions(books.getPolymarketConditionIds());
        }
        if (config.liveHotPathEnabled) {
          void warmHotPath().catch((error) => {
            logEvent({ severity: "WARN", category: "DISCOVERY", message: "hot-path warmup after discovery failed", context: { error: error instanceof Error ? error.message : String(error) } });
          });
        }
        lastDiscoveryAt = Date.now();
        lastDiscoveryError = null;
      } catch (error) {
        lastDiscoveryError = error instanceof Error ? error.message : String(error);
        logEvent({ severity: "ERROR", category: "DISCOVERY", message: "discovery refresh failed", context: { error: lastDiscoveryError } });
        // The steady interval is a 5-min backstop, so retry a FAILED discovery sooner — otherwise a transient
        // fetch error could leave the worker without fresh contracts for minutes. One in-flight retry at a time.
        if (!discoveryRetryTimer) {
          discoveryRetryTimer = setTimeout(() => { discoveryRetryTimer = null; void refreshDiscovery(); }, 30_000);
        }
      } finally {
        discoveryInFlight = null;
      }
    })();
    return discoveryInFlight;
  }

  function scheduleBoundaryRefreshes(): NodeJS.Timeout[] {
    if (!config.discoveryBoundaryRefreshEnabled) return [];
    const timers: NodeJS.Timeout[] = [];
    const intervalMs = 15 * 60_000;
    const offsets = [-1_000, 250, 3_000];
    const scheduleNext = (): void => {
      const now = Date.now();
      const nextBoundary = Math.ceil(now / intervalMs) * intervalMs;
      for (const offset of offsets) {
        const delay = Math.max(0, nextBoundary + offset - now);
        timers.push(setTimeout(() => void refreshDiscovery(), delay));
      }
      timers.push(setTimeout(scheduleNext, Math.max(1_000, nextBoundary + intervalMs - now)));
    };
    scheduleNext();
    return timers;
  }

  let rediscoveryQueued = false;
  queueRediscovery = () => {
    if (rediscoveryQueued) return;
    rediscoveryQueued = true;
    setTimeout(() => {
      rediscoveryQueued = false;
      void refreshDiscovery();
    }, 250);
  };

  polymarketPriceToBeat.start();
  await refreshDiscovery();
  async function warmHotPath(): Promise<void> {
    if (!config.liveHotPathEnabled) return;
    const now = Date.now();
    await Promise.all([
      cachedLiveLocks?.refresh() ?? Promise.resolve(),
      liveExposureCache?.refresh(now) ?? Promise.resolve(),
      liveReadinessProbe.warm({ now, tokenIds: books.getPolymarketTokenIds() }),
    ]);
  }
  await warmHotPath().catch((error) => {
    logEvent({ severity: "WARN", category: "BOOT", message: "initial hot-path warmup failed", context: { error: error instanceof Error ? error.message : String(error) } });
  });
  const discoveryTimer = setInterval(() => void refreshDiscovery(), config.marketDiscoveryIntervalMs);
  const hotPathWarmTimer = setInterval(() => {
    void warmHotPath().catch((error) => {
      logEvent({ severity: "WARN", category: "BOOT", message: "hot-path warmup failed", context: { error: error instanceof Error ? error.message : String(error) } });
    });
  }, Math.max(250, config.liveHotPathWarmIntervalMs));
  const scanHeartbeatTimer = createScanHeartbeat({
    enabled: config.arbEnabled,
    intervalMs: config.arbScanHeartbeatMs,
    getLastScanAt: () => scanner.status().lastScanAt,
    requestScan: (now) => scanScheduler.requestScan(now),
  });
  const analyticsTimer = setInterval(() => void reconcileAnalytics().catch((error) => {
    logEvent({ severity: "ERROR", category: "DB", message: "analytics reconciliation failed", context: { error: error instanceof Error ? error.message : String(error) } });
  }), Math.max(1_000, config.dashboardAnalyticsRefreshMs));
  // Runtime-health watchdog: surface event-loop stall / CPU steal (burst-credit throttle) immediately instead
  // of letting it silently halt trading. Single sampler so the /proc/stat steal delta stays consistent.
  startRuntimeHealthMonitor();
  const runtimeHealthTimer = setInterval(() => {
    const h = sampleRuntimeHealth();
    if (h.eventLoopLagP99Ms > 1_000 || (h.cpuStealPercent ?? 0) > 40) {
      logEvent({
        severity: "WARN",
        category: "BOOT",
        message: "runtime health degraded: event-loop stall / CPU throttle",
        context: { eventLoopLagMeanMs: h.eventLoopLagMeanMs, eventLoopLagP99Ms: h.eventLoopLagP99Ms, cpuStealPercent: h.cpuStealPercent },
      });
    }
  }, 10_000);
  const boundaryDiscoveryTimers = scheduleBoundaryRefreshes();

  const server = createServer((request, response) => {
    void (async () => {
      const handled = await handleDashboardRequest(request, response, {
        config,
        books,
        signals,
        getAnalytics: (now) => liveAnalytics.snapshot(now, { staleAfterMs: Math.max(30_000, config.dashboardAnalyticsRefreshMs * 3) }),
        getScannerStatus: () => scanner.status(),
        getDiscoveryState: () => ({ lastDiscoveryAt, lastDiscoveryError }),
        getPolymarketDiagnostics: livePolymarketDiagnostics,
        getLatencySnapshot: (now, snapshotBuildMs) => latency.snapshot(books.snapshot(), now, config, snapshotBuildMs),
        getExecutionReadiness: async (now) => {
          return liveReadinessProbe.readiness(now);
        },
        getTradingActivity: (now, readiness) => tradingActivity.getSnapshot({ now, readiness }),
        getVenuePnl: (now) => computeVenuePnl(config, now),
        getEquityCurve: async (now) => {
          const points = await portfolioEquity.listSince(0, 400);
          return {
            generatedAt: now,
            currentCombinedValue: points.at(-1)?.v ?? null,
            earliestSampledAtMs: await portfolioEquity.earliestSampledAtMs(),
            points,
          };
        },
        recordEquitySample: (activity, now) => equitySampler.maybeSample(activity, now),
        getTradingPlatformActivity: (platform, now, readiness) => tradingActivity.getPlatformActivity(platform, { now, readiness }),
        subscribeTradingActivityEvents: (listener) => orderEvents.onEvent((event) => {
          listener(tradingActivityEventFromVenueEvent(event));
        }),
        signalsNotifier,
        getLogs: getRecentLogs,
      });
      if (handled) return;

      const requestUrl = new URL(request.url ?? "/", "http://worker.local");
      if (requestUrl.pathname === "/health") {
        const now = Date.now();
        let readiness = null;
        let readinessError: unknown = null;
        if (["1", "true", "yes"].includes((requestUrl.searchParams.get("readiness") ?? "").toLowerCase())) {
          try {
            readiness = await liveReadinessProbe.readiness(now);
          } catch (error) {
            readinessError = error;
          }
        }
        sendJson(response, 200, {
          ...buildPublicWorkerHealth({
            config,
            scannerStatus: scanner.status(),
            now,
            readiness,
            readinessError,
          }),
          runtimeHealth: getRuntimeHealth(),
        });
        return;
      }
      if (request.url === "/status") {
        sendJson(response, 200, {
          discovery: { lastDiscoveryAt, lastDiscoveryError },
          scanner: scanner.status(),
          books: books.snapshot(),
          diagnostics: { polymarket: livePolymarketDiagnostics() },
        });
        return;
      }
      if (request.url === "/logs") {
        sendJson(response, 200, { logs: getRecentLogs() });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    })().catch((error) => {
      logEvent({ severity: "ERROR", category: "BOOT", message: "request failed", context: { error: error instanceof Error ? error.message : String(error) } });
      if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
      else response.end();
    });
  });

  server.listen(config.port, () => {
    logEvent({ category: "BOOT", message: "worker listening", context: { port: config.port, liveTrading: true } });
  });

  const shutdown = createIdempotentShutdown(async (): Promise<void> => {
    clearInterval(discoveryTimer);
    clearInterval(hotPathWarmTimer);
    if (scanHeartbeatTimer) clearInterval(scanHeartbeatTimer);
    clearInterval(analyticsTimer);
    clearInterval(runtimeHealthTimer);
    if (discoveryRetryTimer) clearTimeout(discoveryRetryTimer);
    for (const timer of boundaryDiscoveryTimers) clearTimeout(timer);
    kalshi.close();
    polymarket.close();
    kalshiUserStream?.close();
    polymarketUserStream?.close();
    polymarketPriceToBeat.close();
    server.close();
    await pool.end();
  });

  const handleShutdownSignal = (signal: NodeJS.Signals): void => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        logEvent({
          severity: "ERROR",
          category: "BOOT",
          message: "worker shutdown failed",
          context: { signal, error: error instanceof Error ? error.message : String(error) },
        });
        process.exit(1);
      });
  };

  process.on("SIGINT", handleShutdownSignal);
  process.on("SIGTERM", handleShutdownSignal);
}

main().catch((error) => {
  logEvent({ severity: "ERROR", category: "BOOT", message: "worker failed", context: { error: error instanceof Error ? error.message : String(error) } });
  process.exitCode = 1;
});
