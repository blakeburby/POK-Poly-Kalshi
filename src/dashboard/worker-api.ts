import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config";
import { buildDashboardAnalytics, oldestAnalyticsSinceMs } from "../analytics/performance";
import type { BookStore } from "../books/book-store";
import { emptyPolymarketDiagnostics } from "../discovery/polymarket";
import type { ScannerStatus } from "../scanner/scanner";
import { enumerateCandidates } from "../scanner/pairing";
import type { ArbCandidate, DashboardAnalytics, DashboardLogEntry, DashboardLatencySnapshot, DashboardSignal, DashboardSnapshot, ExecutionMode, LiveExecutionReadiness, PolymarketDiagnostics } from "../types";

interface SignalReader {
  listRecentSignals(limit?: number, executionMode?: ExecutionMode): Promise<DashboardSignal[]>;
  listFilledSignalsSince?(sinceMs: number, limit?: number, executionMode?: ExecutionMode): Promise<DashboardSignal[]>;
}

export interface DashboardDiscoveryState {
  lastDiscoveryAt: number;
  lastDiscoveryError: string | null;
}

export interface DashboardRuntime {
  config: AppConfig;
  books: BookStore;
  signals: SignalReader;
  getAnalytics?: (now: number, executionMode?: ExecutionMode) => DashboardAnalytics | Promise<DashboardAnalytics>;
  getScannerStatus: () => ScannerStatus;
  getDiscoveryState: () => DashboardDiscoveryState;
  getPolymarketDiagnostics?: (now: number) => PolymarketDiagnostics;
  getLatencySnapshot?: (now: number, snapshotBuildMs: number) => DashboardLatencySnapshot;
  getExecutionReadiness?: (now: number) => LiveExecutionReadiness | Promise<LiveExecutionReadiness>;
  getLogs: (limit?: number) => DashboardLogEntry[];
}

export interface DashboardSnapshotCache {
  recentSignals?: Partial<Record<ExecutionMode, {
    refreshedAt: number;
    value: DashboardSignal[];
  }>>;
  analytics?: Partial<Record<ExecutionMode, {
    refreshedAt: number;
    value: DashboardAnalytics;
  }>>;
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

async function cachedRecentSignals(runtime: DashboardRuntime, now: number, executionMode: ExecutionMode, cache?: DashboardSnapshotCache): Promise<DashboardSignal[]> {
  const cached = cache?.recentSignals?.[executionMode];
  if (cached && now - cached.refreshedAt < runtime.config.dashboardSignalRefreshMs) {
    return cached.value;
  }
  const value = await runtime.signals.listRecentSignals(100, executionMode);
  if (cache) {
    cache.recentSignals ??= {};
    cache.recentSignals[executionMode] = { refreshedAt: now, value };
  }
  return value;
}

async function cachedAnalytics(runtime: DashboardRuntime, now: number, executionMode: ExecutionMode, cache?: DashboardSnapshotCache): Promise<DashboardAnalytics> {
  if (runtime.getAnalytics) return runtime.getAnalytics(now, executionMode);
  const cached = cache?.analytics?.[executionMode];
  if (cached && now - cached.refreshedAt < runtime.config.dashboardAnalyticsRefreshMs) {
    return cached.value;
  }
  const analyticsSignals = await (runtime.signals.listFilledSignalsSince?.(oldestAnalyticsSinceMs(now), 10_000, executionMode) ?? Promise.resolve([]));
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
  if (cache) {
    cache.analytics ??= {};
    cache.analytics[executionMode] = { refreshedAt: now, value };
  }
  return value;
}

export async function createDashboardSnapshot(runtime: DashboardRuntime, now = Date.now(), cache?: DashboardSnapshotCache): Promise<DashboardSnapshot> {
  const snapshotStartedAt = Date.now();
  const books = runtime.books.snapshot();
  const [paperSignals, liveSignals, paperAnalytics, liveAnalytics] = await Promise.all([
    cachedRecentSignals(runtime, now, "paper", cache),
    cachedRecentSignals(runtime, now, "live", cache),
    cachedAnalytics(runtime, now, "paper", cache),
    cachedAnalytics(runtime, now, "live", cache),
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
      liveOrderTimeoutMs: runtime.config.liveOrderTimeoutMs,
      liveHedgeMaxLossDollars: runtime.config.liveHedgeMaxLossDollars,
      liveHedgeFeeBufferDollars: runtime.config.liveHedgeFeeBufferDollars,
      liveParallelExecutionEnabled: runtime.config.liveParallelExecutionEnabled,
      liveHotPathEnabled: runtime.config.liveHotPathEnabled,
      liveHotPathCacheMaxAgeMs: runtime.config.liveHotPathCacheMaxAgeMs,
      liveHotPathWarmIntervalMs: runtime.config.liveHotPathWarmIntervalMs,
      livePolymarketPresignEnabled: runtime.config.livePolymarketPresignEnabled,
      livePolymarketSignedOrderTtlMs: runtime.config.livePolymarketSignedOrderTtlMs,
      liveLowLatencyHttpEnabled: runtime.config.liveLowLatencyHttpEnabled,
      liveUserStreamsEnabled: runtime.config.liveUserStreamsEnabled,
      liveUserStreamPretradeGraceMs: runtime.config.liveUserStreamPretradeGraceMs,
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
    live: {
      recentSignals: liveSignals,
      analytics: liveAnalytics,
    },
    paper: {
      recentSignals: paperSignals,
      analytics: paperAnalytics,
    },
    recentSignals: paperSignals,
    analytics: paperAnalytics,
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
