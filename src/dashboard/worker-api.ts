import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config";
import { buildDashboardAnalytics, oldestAnalyticsSinceMs } from "../analytics/performance";
import type { BookStore } from "../books/book-store";
import { emptyPolymarketDiagnostics } from "../discovery/polymarket";
import type { ScannerStatus } from "../scanner/scanner";
import { enumerateCandidates } from "../scanner/pairing";
import type { ArbCandidate, DashboardAnalytics, DashboardLogEntry, DashboardLatencySnapshot, DashboardSignal, DashboardSnapshot, LiveExecutionReadiness, PolymarketDiagnostics } from "../types";
import { emptyTradingActivity } from "../trading/activity";
import type { TradingActivityEvent, TradingActivitySnapshot, TradingPlatform, TradingPlatformActivity } from "../../types/trading";

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
  getTradingActivity?: (now: number, readiness?: LiveExecutionReadiness) => TradingActivitySnapshot | Promise<TradingActivitySnapshot>;
  getTradingPlatformActivity?: (platform: TradingPlatform, now: number, readiness?: LiveExecutionReadiness) => TradingPlatformActivity | Promise<TradingPlatformActivity>;
  subscribeTradingActivityEvents?: (listener: (event: TradingActivityEvent) => void) => () => void;
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
  tradingActivity?: {
    refreshedAt: number;
    value: TradingActivitySnapshot;
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
  const cached = cache?.recentSignals;
  if (cached && now - cached.refreshedAt < runtime.config.dashboardSignalRefreshMs) {
    return cached.value;
  }
  const value = await runtime.signals.listRecentSignals(100);
  if (cache) {
    cache.recentSignals = { refreshedAt: now, value };
  }
  return value;
}

async function cachedAnalytics(runtime: DashboardRuntime, now: number, cache?: DashboardSnapshotCache): Promise<DashboardAnalytics> {
  if (runtime.getAnalytics) return runtime.getAnalytics(now);
  const cached = cache?.analytics;
  if (cached && now - cached.refreshedAt < runtime.config.dashboardAnalyticsRefreshMs) {
    return cached.value;
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
  if (cache) {
    cache.analytics = { refreshedAt: now, value };
  }
  return value;
}

async function cachedTradingActivity(
  runtime: DashboardRuntime,
  now: number,
  readiness: LiveExecutionReadiness | undefined,
  cache?: DashboardSnapshotCache,
): Promise<TradingActivitySnapshot> {
  const cached = cache?.tradingActivity;
  if (cached && now - cached.refreshedAt < runtime.config.dashboardSignalRefreshMs) {
    return cached.value;
  }
  const value = runtime.getTradingActivity
    ? await runtime.getTradingActivity(now, readiness)
    : emptyTradingActivity(now);
  if (cache) {
    cache.tradingActivity = { refreshedAt: now, value };
  }
  return value;
}

export async function createDashboardSnapshot(runtime: DashboardRuntime, now = Date.now(), cache?: DashboardSnapshotCache): Promise<DashboardSnapshot> {
  const snapshotStartedAt = Date.now();
  const books = runtime.books.snapshot();
  const scannerStatus = runtime.getScannerStatus();
  const [recentSignals, analytics] = await Promise.all([
    cachedRecentSignals(runtime, now, cache),
    cachedAnalytics(runtime, now, cache),
  ]);
  const execution = await runtime.getExecutionReadiness?.(now);
  const tradingActivity = await cachedTradingActivity(runtime, now, execution, cache);
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
      liveTrading: true,
      arbEnabled: runtime.config.arbEnabled,
      minProfitDollars: runtime.config.minProfitDollars,
      reentryIntervalMs: runtime.config.reentryIntervalMs,
      scanHeartbeatMs: runtime.config.arbScanHeartbeatMs,
      staleBookMs: runtime.config.staleBookMs,
      liveMaxTradesPerWindow: runtime.config.liveMaxTradesPerWindow,
      liveTakerPriceCushionCents: runtime.config.liveTakerPriceCushionCents,
      liveQuoteMaxAgeMs: runtime.config.liveQuoteMaxAgeMs,
      liveQuoteSyncMaxSkewMs: runtime.config.liveQuoteSyncMaxSkewMs,
      liveMinBookDepthShares: runtime.config.liveMinBookDepthShares,
      liveOrderTimeoutMs: runtime.config.liveOrderTimeoutMs,
      liveHedgeMaxLossDollars: runtime.config.liveHedgeMaxLossDollars,
      liveHedgeFeeBufferDollars: runtime.config.liveHedgeFeeBufferDollars,
      liveOrderPlacementMode: runtime.config.liveOrderPlacementMode,
      liveAggressiveLimitRestMs: runtime.config.liveAggressiveLimitRestMs,
      liveParallelExecutionEnabled: runtime.config.liveParallelExecutionEnabled,
      liveHotPathEnabled: runtime.config.liveHotPathEnabled,
      liveHotPathCacheMaxAgeMs: runtime.config.liveHotPathCacheMaxAgeMs,
      liveHotPathWarmIntervalMs: runtime.config.liveHotPathWarmIntervalMs,
      livePolymarketPresignEnabled: runtime.config.livePolymarketPresignEnabled,
      livePolymarketSignedOrderTtlMs: runtime.config.livePolymarketSignedOrderTtlMs,
      liveKalshiPrearmEnabled: runtime.config.liveKalshiPrearmEnabled,
      liveKalshiPrearmMaxAgeMs: runtime.config.liveKalshiPrearmMaxAgeMs,
      liveKalshiPrearmPricePolicy: runtime.config.liveKalshiPrearmPricePolicy,
      liveLowLatencyHttpEnabled: runtime.config.liveLowLatencyHttpEnabled,
      liveUserStreamsEnabled: runtime.config.liveUserStreamsEnabled,
      liveUserStreamPretradeGraceMs: runtime.config.liveUserStreamPretradeGraceMs,
      liveUserStreamConfirmTimeoutMs: runtime.config.liveUserStreamConfirmTimeoutMs,
      livePretradeRetryAttempts: runtime.config.livePretradeRetryAttempts,
      livePretradeRetryDelayMs: runtime.config.livePretradeRetryDelayMs,
      liveFinalRecoveryTimeoutMs: runtime.config.liveFinalRecoveryTimeoutMs,
      liveFinalRecoveryPollMs: runtime.config.liveFinalRecoveryPollMs,
      liveAutoResolveVerifiedIncidents: runtime.config.liveAutoResolveVerifiedIncidents,
      liveAutoHardlocksEnabled: runtime.config.liveAutoHardlocksEnabled,
      liveExactExposureRequired: runtime.config.liveExactExposureRequired,
      liveExecutionQualityGateEnabled: runtime.config.liveExecutionQualityGateEnabled,
      liveExecutionQualityLookbackMs: runtime.config.liveExecutionQualityLookbackMs,
      liveExecutionQualitySampleLimit: runtime.config.liveExecutionQualitySampleLimit,
      liveExecutionQualityMinSamples: runtime.config.liveExecutionQualityMinSamples,
      liveExecutionQualityMinExactFillRate: runtime.config.liveExecutionQualityMinExactFillRate,
      livePartialFillLockMode: runtime.config.livePartialFillLockMode,
      liveMaxUnresolvedExposureDollars: runtime.config.liveMaxUnresolvedExposureDollars,
      liveReconcileBeforeTrade: runtime.config.liveReconcileBeforeTrade,
    },
    latency: runtime.getLatencySnapshot?.(now, snapshotBuildMs),
    discovery: runtime.getDiscoveryState(),
    scanner: {
      ...scannerStatus,
      lastScanAgeMs: scannerStatus.lastScanAt > 0 ? Math.max(0, now - scannerStatus.lastScanAt) : null,
    },
    books,
    diagnostics: {
      polymarket: runtime.getPolymarketDiagnostics?.(now) ?? emptyPolymarketDiagnostics(),
    },
    liveCandidates,
    syntheticStructures,
    recentSignals,
    analytics,
    tradingActivity,
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

async function writeTradingActivity(response: ServerResponse, runtime: DashboardRuntime, platform: TradingPlatform | null): Promise<void> {
  const now = Date.now();
  const readiness = await runtime.getExecutionReadiness?.(now);
  if (platform && runtime.getTradingPlatformActivity) {
    sendJson(response, 200, await runtime.getTradingPlatformActivity(platform, now, readiness));
    return;
  }
  sendJson(response, 200, runtime.getTradingActivity ? await runtime.getTradingActivity(now, readiness) : emptyTradingActivity(now));
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
  const unsubscribe = runtime.subscribeTradingActivityEvents?.((event) => {
    response.write(formatSseEvent("tradingActivity", event));
  });
  const timer = setInterval(() => void send(), Math.max(50, runtime.config.dashboardStreamIntervalMs));
  response.on("close", () => {
    clearInterval(timer);
    unsubscribe?.();
  });
}

export async function handleDashboardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DashboardRuntime,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  if (pathname !== "/dashboard/snapshot" && pathname !== "/dashboard/stream" && pathname !== "/trading/activity") return false;

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

  if (pathname === "/trading/activity") {
    const rawPlatform = url.searchParams.get("platform");
    const platform = rawPlatform === "kalshi" || rawPlatform === "polymarket" ? rawPlatform : null;
    if (rawPlatform && !platform) {
      sendJson(response, 400, { error: "invalid_platform" });
      return true;
    }
    await writeTradingActivity(response, runtime, platform);
    return true;
  }

  await writeStream(response, runtime);
  return true;
}
