import { createServer } from "node:http";
import { oldestAnalyticsSinceMs } from "./analytics/performance";
import { AnalyticsStore } from "./analytics/store";
import { BookStore } from "./books/book-store";
import { loadConfig } from "./config";
import { handleDashboardRequest } from "./dashboard/worker-api";
import { createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { LiveExecutionLockStore } from "./db/live-execution-locks";
import { PolymarketPriceBeatStore } from "./db/polymarket-price-beats";
import { SignalStore } from "./db/signals";
import { VenueOrderEventHub, VenueOrderEventStore } from "./db/venue-order-events";
import { discoverKalshiBtcContracts } from "./discovery/kalshi";
import { discoverPolymarketBtcContractsWithDiagnostics, emptyPolymarketDiagnostics } from "./discovery/polymarket";
import { DryRunExecutor, DryRunSlippageModel, LiveExecutor } from "./execution/executor";
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
import { CoalescedScanScheduler } from "./scanner/scheduler";
import type { PolymarketDiagnostics } from "./types";

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  await runMigrations(pool);

  const books = new BookStore();
  const signals = new SignalStore(pool);
  const liveLocks = new LiveExecutionLockStore(pool);
  const orderEvents = new VenueOrderEventHub(new VenueOrderEventStore(pool));
  const priceBeats = new PolymarketPriceBeatStore(pool);
  const reentry = new ReentryThrottle(config.reentryIntervalMs);
  const latency = new LatencyMonitor();
  reentry.hydrate(await signals.loadRecentFilledAttempts());
  const paperAnalytics = new AnalyticsStore();
  const liveAnalytics = new AnalyticsStore();
  async function reconcileAnalytics(): Promise<void> {
    const now = Date.now();
    const sinceMs = oldestAnalyticsSinceMs(now);
    const [paperSignals, liveSignals] = await Promise.all([
      signals.listFilledSignalsSince(sinceMs, 10_000, "paper"),
      signals.listFilledSignalsSince(sinceMs, 10_000, "live"),
    ]);
    paperAnalytics.reconcileFilledSignals(paperSignals, now);
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
    reconciliationStore: signals,
    liveLocks,
    now: Date.now,
  });
  const liveReadinessProbe = new LiveExecutor(config, books, undefined, undefined, Date.now, liveLocks, orderEvents, confirmationMonitor);
  const executor = config.liveTrading ? liveReadinessProbe : new DryRunExecutor(DryRunSlippageModel.fromConfig(config), config.minProfitDollars);
  const scanner = new CrossVenueArbScanner(books, signals, executor, reentry, {
    enabled: config.arbEnabled,
    minProfitDollars: config.minProfitDollars,
    staleBookMs: config.staleBookMs,
    executionConcurrency: config.executionConcurrency,
    liveTrading: config.liveTrading,
    maxLiveTradesPerWindow: config.liveMaxTradesPerWindow,
    liveExposure: signals,
    liveLocks,
    latency,
    analytics: config.liveTrading ? liveAnalytics : paperAnalytics,
  });
  const scanScheduler = new CoalescedScanScheduler(scanner, latency);

  const kalshi = new KalshiTickerClient(config.kalshiWsUrl);
  const polymarket = new PolymarketBookClient(config.polymarketWsUrl);
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
        lastDiscoveryAt = Date.now();
        lastDiscoveryError = null;
      } catch (error) {
        lastDiscoveryError = error instanceof Error ? error.message : String(error);
        logEvent({ severity: "ERROR", category: "DISCOVERY", message: "discovery refresh failed", context: { error: lastDiscoveryError } });
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
  const discoveryTimer = setInterval(() => void refreshDiscovery(), config.marketDiscoveryIntervalMs);
  const analyticsTimer = setInterval(() => void reconcileAnalytics().catch((error) => {
    logEvent({ severity: "ERROR", category: "DB", message: "analytics reconciliation failed", context: { error: error instanceof Error ? error.message : String(error) } });
  }), Math.max(1_000, config.dashboardAnalyticsRefreshMs));
  const boundaryDiscoveryTimers = scheduleBoundaryRefreshes();

  const server = createServer((request, response) => {
    void (async () => {
      const handled = await handleDashboardRequest(request, response, {
        config,
        books,
        signals,
        getAnalytics: (now, executionMode = "paper") => (executionMode === "live" ? liveAnalytics : paperAnalytics).snapshot(now, { staleAfterMs: Math.max(30_000, config.dashboardAnalyticsRefreshMs * 3) }),
        getScannerStatus: () => scanner.status(),
        getDiscoveryState: () => ({ lastDiscoveryAt, lastDiscoveryError }),
        getPolymarketDiagnostics: livePolymarketDiagnostics,
        getLatencySnapshot: (now, snapshotBuildMs) => latency.snapshot(books.snapshot(), now, config, snapshotBuildMs),
        getExecutionReadiness: async (now) => {
          const readiness = await liveReadinessProbe.readiness(now);
          if (config.liveTrading) return readiness;
          return {
            ...readiness,
            mode: "dry_run" as const,
            liveTrading: false,
            partialFillLocked: false,
            lastAttempt: null,
          };
        },
        getLogs: getRecentLogs,
      });
      if (handled) return;

      if (request.url === "/health") {
        sendJson(response, 200, { ok: true, liveTrading: config.liveTrading, arbEnabled: config.arbEnabled });
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
    logEvent({ category: "BOOT", message: "worker listening", context: { port: config.port, liveTrading: config.liveTrading } });
  });

  const shutdown = async (): Promise<void> => {
    clearInterval(discoveryTimer);
    clearInterval(analyticsTimer);
    for (const timer of boundaryDiscoveryTimers) clearTimeout(timer);
    kalshi.close();
    polymarket.close();
    kalshiUserStream?.close();
    polymarketUserStream?.close();
    polymarketPriceToBeat.close();
    server.close();
    await pool.end();
  };

  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
}

main().catch((error) => {
  logEvent({ severity: "ERROR", category: "BOOT", message: "worker failed", context: { error: error instanceof Error ? error.message : String(error) } });
  process.exitCode = 1;
});
