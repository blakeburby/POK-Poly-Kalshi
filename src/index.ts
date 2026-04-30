import { createServer } from "node:http";
import { BookStore } from "./books/book-store";
import { loadConfig } from "./config";
import { handleDashboardRequest } from "./dashboard/worker-api";
import { createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { PolymarketPriceBeatStore } from "./db/polymarket-price-beats";
import { SignalStore } from "./db/signals";
import { discoverKalshiBtcContracts } from "./discovery/kalshi";
import { discoverPolymarketBtcContractsWithDiagnostics, emptyPolymarketDiagnostics } from "./discovery/polymarket";
import { DryRunExecutor, LiveExecutor } from "./execution/executor";
import { KalshiTickerClient } from "./kalshi/client";
import { getRecentLogs, logEvent } from "./logger";
import { PolymarketBookClient } from "./polymarket/client";
import { PolymarketPriceToBeatService } from "./polymarket/price-to-beat";
import { ReentryThrottle } from "./scanner/reentry";
import { CrossVenueArbScanner } from "./scanner/scanner";
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
  const priceBeats = new PolymarketPriceBeatStore(pool);
  const reentry = new ReentryThrottle(config.reentryIntervalMs);
  reentry.hydrate(await signals.loadRecentFilledAttempts());
  const executor = config.liveTrading ? new LiveExecutor(config) : new DryRunExecutor();
  const scanner = new CrossVenueArbScanner(books, signals, executor, reentry, {
    enabled: config.arbEnabled,
    minProfitDollars: config.minProfitDollars,
    staleBookMs: config.staleBookMs,
  });

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
    books.applyKalshiSnapshot(snapshot);
    void scanner.scan(snapshot.timestamp);
  });
  polymarket.onSnapshot((snapshot) => {
    books.applyPolymarketSnapshot(snapshot);
    void scanner.scan(snapshot.timestamp);
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

  async function refreshDiscovery(): Promise<void> {
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
      lastDiscoveryAt = Date.now();
      lastDiscoveryError = null;
    } catch (error) {
      lastDiscoveryError = error instanceof Error ? error.message : String(error);
      logEvent({ severity: "ERROR", category: "DISCOVERY", message: "discovery refresh failed", context: { error: lastDiscoveryError } });
    }
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

  const server = createServer((request, response) => {
    void (async () => {
      const handled = await handleDashboardRequest(request, response, {
        config,
        books,
        signals,
        getScannerStatus: () => scanner.status(),
        getDiscoveryState: () => ({ lastDiscoveryAt, lastDiscoveryError }),
        getPolymarketDiagnostics: livePolymarketDiagnostics,
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
    kalshi.close();
    polymarket.close();
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
