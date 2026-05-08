import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config";
import { buildDashboardAnalytics, oldestAnalyticsSinceMs } from "../analytics/performance";
import type { BookStore } from "../books/book-store";
import { emptyPolymarketDiagnostics } from "../discovery/polymarket";
import type { ScannerStatus } from "../scanner/scanner";
import { enumerateCandidates } from "../scanner/pairing";
import type { ArbCandidate, DashboardAnalytics, DashboardLogEntry, DashboardLatencySnapshot, DashboardSignal, DashboardSnapshot, LiveExecutionReadiness, PolymarketDiagnostics } from "../types";

interface SignalReader {
  listRecentSignals(limit?: number): Promise<DashboardSignal[]>;
  listFilledSignalsSince?(sinceMs: number, limit?: number): Promise<DashboardSignal[]>;
}

export interface DashboardDiscoveryState {
  lastDiscoveryAt: number;
  lastDiscoveryError: string | null;
}

export interface DashboardRuntime {
  config: AppConfig;
  books: BookStore;
  signals: SignalReader;
  getAnalytics?: (now: number) => DashboardAnalytics | Promise<DashboardAnalytics>;
  getScannerStatus: () => ScannerStatus;
  getDiscoveryState: () => DashboardDiscoveryState;
  getPolymarketDiagnostics?: (now: number) => PolymarketDiagnostics;
  getLatencySnapshot?: (now: number, snapshotBuildMs: number) => DashboardLatencySnapshot;
  getExecutionReadiness?: (now: number) => LiveExecutionReadiness | Promise<LiveExecutionReadiness>;
  getLogs: (limit?: number) => DashboardLogEntry[];
}

export interface DashboardSnapshotCache {
  recentSignals?: {
    refreshedAt: number;
    value: DashboardSignal[];
  };
  analytics?: {
    refreshedAt: number;
    value: DashboardAnalytics;
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function dashboardRequestAuthorized(headers: IncomingMessage["headers"], token: string): boolean {
  if (!token) return false;
  const authorization = headers.authorization;
  if (!authorization) return false;
  const [scheme, value] = authorization.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && typeof value === "string" && safeEqual(value, token);
}

async function cachedRecentSignals(runtime: DashboardRuntime, now: number, cache?: DashboardSnapshotCache): Promise<DashboardSignal[]> {
  if (cache?.recentSignals && now - cache.recentSignals.refreshedAt < runtime.config.dashboardSignalRefreshMs) {
    return cache.recentSignals.value;
  }
  const value = await runtime.signals.listRecentSignals(100);
  if (cache) cache.recentSignals = { refreshedAt: now, value };
  return value;
}

async function cachedAnalytics(runtime: DashboardRuntime, now: number, cache?: DashboardSnapshotCache): Promise<DashboardAnalytics> {
  if (runtime.getAnalytics) return runtime.getAnalytics(now);
  if (cache?.analytics && now - cache.analytics.refreshedAt < runtime.config.dashboardAnalyticsRefreshMs) {
    return cache.analytics.value;
  }
  const analyticsSignals = await (runtime.signals.listFilledSignalsSince?.(oldestAnalyticsSinceMs(now), 10_000) ?? Promise.resolve([]));
  const value = buildDashboardAnalytics(analyticsSignals, now, {
    mode: "fallback_db",
    lastUpdatedAt: analyticsSignals
      .map((signal) => new Date(signal.updatedAt).getTime())
      .filter((timestamp) => Number.isFinite(timestamp))
      .reduce<number | null>((latest, timestamp) => latest == null ? timestamp : Math.max(latest, timestamp), null),
    lastDbReconciledAt: now,
    computeMs: 0,
    sourceSignalCount: analyticsSignals.length,
    stale: false,
  });
  if (cache) cache.analytics = { refreshedAt: now, value };
  return value;
}

export async function createDashboardSnapshot(runtime: DashboardRuntime, now = Date.now(), cache?: DashboardSnapshotCache): Promise<DashboardSnapshot> {
  const snapshotStartedAt = Date.now();
  const books = runtime.books.snapshot();
  const [recentSignals, analytics] = await Promise.all([
    cachedRecentSignals(runtime, now, cache),
    cachedAnalytics(runtime, now, cache),
  ]);
  const execution = await runtime.getExecutionReadiness?.(now);
  const paired = enumerateCandidates(
    runtime.books.getPolymarketContracts(runtime.config.staleBookMs, now),
    runtime.books.getKalshiContracts(runtime.config.staleBookMs, now),
    runtime.config.minProfitDollars,
  );
  const liveCandidates = paired.executable.sort((left, right) => right.guaranteedProfit - left.guaranteedProfit || left.expiryMs - right.expiryMs);
  const syntheticStructures = [...paired.executable, ...paired.rejected].sort((left, right) => {
    const classificationRank = (candidate: ArbCandidate): number => {
      if (candidate.risk?.classification === "true_arbitrage") return 0;
      if (candidate.risk?.classification === "guaranteed_below_threshold") return 1;
      return 2;
    };
    return classificationRank(left) - classificationRank(right)
      || (right.risk?.worstCaseProfit ?? right.guaranteedProfit) - (left.risk?.worstCaseProfit ?? left.guaranteedProfit)
      || left.expiryMs - right.expiryMs;
  });

  const snapshotBuildMs = Math.max(0, Date.now() - snapshotStartedAt);
  return {
    generatedAt: now,
    health: {
      ok: true,
      liveTrading: runtime.config.liveTrading,
      arbEnabled: runtime.config.arbEnabled,
      minProfitDollars: runtime.config.minProfitDollars,
      reentryIntervalMs: runtime.config.reentryIntervalMs,
      staleBookMs: runtime.config.staleBookMs,
      liveMaxTradesPerWindow: runtime.config.liveMaxTradesPerWindow,
      liveQuoteMaxAgeMs: runtime.config.liveQuoteMaxAgeMs,
      liveQuoteSyncMaxSkewMs: runtime.config.liveQuoteSyncMaxSkewMs,
      liveMinBookDepthShares: runtime.config.liveMinBookDepthShares,
      liveEdgeBufferDollars: runtime.config.liveEdgeBufferDollars,
      liveOrderTimeoutMs: runtime.config.liveOrderTimeoutMs,
      liveUserStreamsEnabled: runtime.config.liveUserStreamsEnabled,
      liveUserStreamConfirmTimeoutMs: runtime.config.liveUserStreamConfirmTimeoutMs,
      liveReconcileBeforeTrade: runtime.config.liveReconcileBeforeTrade,
    },
    latency: runtime.getLatencySnapshot?.(now, snapshotBuildMs),
    discovery: runtime.getDiscoveryState(),
    scanner: runtime.getScannerStatus(),
    books,
    diagnostics: {
      polymarket: runtime.getPolymarketDiagnostics?.(now) ?? emptyPolymarketDiagnostics(),
    },
    liveCandidates,
    syntheticStructures,
    recentSignals,
    analytics,
    execution,
    logs: runtime.getLogs(150),
  };
}

export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function writeSnapshot(response: ServerResponse, runtime: DashboardRuntime): Promise<void> {
  sendJson(response, 200, await createDashboardSnapshot(runtime));
}

async function writeStream(response: ServerResponse, runtime: DashboardRuntime): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const cache: DashboardSnapshotCache = {};
  const send = async (): Promise<void> => {
    try {
      response.write(formatSseEvent("snapshot", await createDashboardSnapshot(runtime, Date.now(), cache)));
    } catch (error) {
      response.write(formatSseEvent("error", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  await send();
  const timer = setInterval(() => void send(), Math.max(50, runtime.config.dashboardStreamIntervalMs));
  response.on("close", () => clearInterval(timer));
}

export async function handleDashboardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DashboardRuntime,
): Promise<boolean> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname !== "/dashboard/snapshot" && pathname !== "/dashboard/stream") return false;

  if (!runtime.config.dashboardApiToken) {
    sendJson(response, 503, { error: "dashboard_token_not_configured" });
    return true;
  }
  if (!dashboardRequestAuthorized(request.headers, runtime.config.dashboardApiToken)) {
    sendJson(response, 401, { error: "unauthorized" });
    return true;
  }

  if (pathname === "/dashboard/snapshot") {
    await writeSnapshot(response, runtime);
    return true;
  }

  await writeStream(response, runtime);
  return true;
}
