import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config";
import { buildDashboardAnalytics, oldestAnalyticsSinceMs } from "../analytics/performance";
import type { BookStore } from "../books/book-store";
import { emptyPolymarketDiagnostics } from "../discovery/polymarket";
import { time } from "../diagnostics/hot-path-timing";
import type { ScannerStatus } from "../scanner/scanner";
import { enumerateCandidates } from "../scanner/pairing";
import type {
  ArbCandidate,
  BinaryContract,
  DashboardAnalytics,
  DashboardLogEntry,
  DashboardLatencySnapshot,
  DashboardSignal,
  DashboardSnapshot,
  LiveExecutionReadiness,
  PolymarketDiagnostics,
} from "../types";
import { emptyTradingActivity } from "../trading/activity";
import { trimSignalForTransport, recentSignalsSignature } from "./signal-transport";
import type {
  TradingActivityEvent,
  TradingActivitySnapshot,
  TradingPlatform,
  TradingPlatformActivity,
  VenuePnlSnapshot,
  EquityCurveSnapshot,
} from "../../types/trading";

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
  getTradingActivity?: (
    now: number,
    readiness?: LiveExecutionReadiness,
  ) => TradingActivitySnapshot | Promise<TradingActivitySnapshot>;
  getVenuePnl?: (now: number) => VenuePnlSnapshot | Promise<VenuePnlSnapshot>;
  getEquityCurve?: (now: number) => EquityCurveSnapshot | Promise<EquityCurveSnapshot>;
  /** Dashboard-only equity sampler hook; called when a fresh trading-activity value is built. */
  recordEquitySample?: (activity: TradingActivitySnapshot, now: number) => void;
  getTradingPlatformActivity?: (
    platform: TradingPlatform,
    now: number,
    readiness?: LiveExecutionReadiness,
  ) => TradingPlatformActivity | Promise<TradingPlatformActivity>;
  subscribeTradingActivityEvents?: (listener: (event: TradingActivityEvent) => void) => () => void;
  /**
   * Wakes open realtime streams the instant a real trade is written so the ledger updates in ~network RTT
   * instead of on the TTL-bounded poll. Each stream subscribes on connect, unsubscribes on close.
   */
  signalsNotifier?: { subscribe(listener: () => void): () => void };
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
  venuePnl?: {
    refreshedAt: number;
    value: VenuePnlSnapshot | undefined;
  };
  equityCurve?: {
    refreshedAt: number;
    value: EquityCurveSnapshot | undefined;
  };
  execution?: {
    refreshedAt: number;
    value: LiveExecutionReadiness | undefined;
  };
}

/** Venue-API-backed reads (readiness, trading activity) change slowly; cache them
 *  longer than book/signal data so frequent dashboard polls stay cheap. */
function heavyRefreshMs(runtime: DashboardRuntime): number {
  return Math.max(runtime.config.dashboardSignalRefreshMs, 5_000);
}

// Trim book depth in the DASHBOARD snapshot only (top N levels/side) so frequent polling serializes a small
// payload instead of the full book (which had ballooned to hundreds of levels). Display-only: live EXECUTION
// reads the BookStore directly (runtime.books.snapshot() in the executor), never this trimmed JSON.
const SNAPSHOT_MAX_BOOK_LEVELS = 25;
function trimBookSnapshot(books: { kalshi: BinaryContract[]; polymarket: BinaryContract[] }): {
  kalshi: BinaryContract[];
  polymarket: BinaryContract[];
} {
  const cap = (c: BinaryContract): BinaryContract => ({
    ...c,
    yesAskLevels: c.yesAskLevels?.slice(0, SNAPSHOT_MAX_BOOK_LEVELS),
    noAskLevels: c.noAskLevels?.slice(0, SNAPSHOT_MAX_BOOK_LEVELS),
    yesBidLevels: c.yesBidLevels?.slice(0, SNAPSHOT_MAX_BOOK_LEVELS),
    noBidLevels: c.noBidLevels?.slice(0, SNAPSHOT_MAX_BOOK_LEVELS),
  });
  return { kalshi: books.kalshi.map(cap), polymarket: books.polymarket.map(cap) };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  // Time the synchronous serialize — large dashboard payloads (the ~778KB /dashboard/snapshot) stringify on
  // the event loop and are a candidate event-loop-lag source.
  response.end(time("dashboardSerialize", () => JSON.stringify(body)));
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

async function cachedRecentSignals(
  runtime: DashboardRuntime,
  now: number,
  cache?: DashboardSnapshotCache,
): Promise<DashboardSignal[]> {
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

async function cachedAnalytics(
  runtime: DashboardRuntime,
  now: number,
  cache?: DashboardSnapshotCache,
): Promise<DashboardAnalytics> {
  // Cache BOTH the live-analytics path and the DB-fallback path. Previously the getAnalytics path returned
  // uncached on EVERY poll, recomputing hourly/daily/weekly aggregates per request and adding steady CPU.
  const cached = cache?.analytics;
  const ttl = runtime.getAnalytics ? heavyRefreshMs(runtime) : runtime.config.dashboardAnalyticsRefreshMs;
  if (cached && now - cached.refreshedAt < ttl) {
    return cached.value;
  }
  if (runtime.getAnalytics) {
    const live = await runtime.getAnalytics(now);
    if (cache) cache.analytics = { refreshedAt: now, value: live };
    return live;
  }
  const analyticsSignals = await (runtime.signals.listFilledSignalsSince?.(oldestAnalyticsSinceMs(now), 10_000) ??
    Promise.resolve([]));
  const value = buildDashboardAnalytics(analyticsSignals, now, {
    mode: "fallback_db",
    lastUpdatedAt: analyticsSignals
      .map((signal) => new Date(signal.updatedAt).getTime())
      .filter((timestamp) => Number.isFinite(timestamp))
      .reduce<number | null>((latest, timestamp) => (latest == null ? timestamp : Math.max(latest, timestamp)), null),
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
  if (cached && now - cached.refreshedAt < heavyRefreshMs(runtime)) {
    return cached.value;
  }
  const value = runtime.getTradingActivity
    ? await runtime.getTradingActivity(now, readiness)
    : emptyTradingActivity(now);
  if (cache) {
    cache.tradingActivity = { refreshedAt: now, value };
  }
  // Sample combined equity off the freshly-built activity (throttled + failure-isolated downstream).
  runtime.recordEquitySample?.(value, now);
  return value;
}

/** Venue-truth P&L changes only on settlements (~every 15m), so cache it well past the
 *  heavy-read window to keep the venue API load light on the live worker. */
function venuePnlRefreshMs(runtime: DashboardRuntime): number {
  return Math.max(heavyRefreshMs(runtime), 30_000);
}

async function cachedVenuePnl(
  runtime: DashboardRuntime,
  now: number,
  cache?: DashboardSnapshotCache,
): Promise<VenuePnlSnapshot | undefined> {
  if (!runtime.getVenuePnl) return undefined;
  const cached = cache?.venuePnl;
  if (cached && now - cached.refreshedAt < venuePnlRefreshMs(runtime)) {
    return cached.value;
  }
  let value: VenuePnlSnapshot | undefined;
  try {
    value = await runtime.getVenuePnl(now);
  } catch {
    value = cached?.value; // keep the last good P&L on a transient venue failure
  }
  if (cache) {
    cache.venuePnl = { refreshedAt: now, value };
  }
  return value;
}

/** Equity curve reads the persisted series; it only changes as samples accrue (~60s), so a
 *  30s cache keeps the polled snapshot cheap. Keeps last-good on a transient DB failure. */
function equityCurveRefreshMs(runtime: DashboardRuntime): number {
  return Math.max(heavyRefreshMs(runtime), 30_000);
}

async function cachedEquityCurve(
  runtime: DashboardRuntime,
  now: number,
  cache?: DashboardSnapshotCache,
): Promise<EquityCurveSnapshot | undefined> {
  if (!runtime.getEquityCurve) return undefined;
  const cached = cache?.equityCurve;
  if (cached && now - cached.refreshedAt < equityCurveRefreshMs(runtime)) {
    return cached.value;
  }
  let value: EquityCurveSnapshot | undefined;
  try {
    value = await runtime.getEquityCurve(now);
  } catch {
    value = cached?.value;
  }
  if (cache) {
    cache.equityCurve = { refreshedAt: now, value };
  }
  return value;
}

async function cachedExecutionReadiness(
  runtime: DashboardRuntime,
  now: number,
  cache?: DashboardSnapshotCache,
): Promise<LiveExecutionReadiness | undefined> {
  if (!runtime.getExecutionReadiness) return undefined;
  const cached = cache?.execution;
  if (cached && now - cached.refreshedAt < heavyRefreshMs(runtime)) {
    return cached.value;
  }
  const value = await runtime.getExecutionReadiness(now);
  if (cache) {
    cache.execution = { refreshedAt: now, value };
  }
  return value;
}

function buildHealth(runtime: DashboardRuntime): DashboardSnapshot["health"] {
  return {
    ok: true,
    liveTrading: true,
    arbEnabled: runtime.config.arbEnabled,
    minProfitDollars: runtime.config.minProfitDollars,
    reentryIntervalMs: runtime.config.reentryIntervalMs,
    scanHeartbeatMs: runtime.config.arbScanHeartbeatMs,
    staleBookMs: runtime.config.staleBookMs,
    liveMaxTradesPerWindow: runtime.config.liveMaxTradesPerWindow,
    liveOrderSize: runtime.config.liveOrderSize,
    liveTakerPriceCushionCents: runtime.config.liveTakerPriceCushionCents,
    liveKalshiMinCashDollars: runtime.config.liveKalshiMinCashDollars,
    liveQuoteMaxAgeMs: runtime.config.liveQuoteMaxAgeMs,
    liveQuoteSyncMaxSkewMs: runtime.config.liveQuoteSyncMaxSkewMs,
    liveMinBookDepthShares: runtime.config.liveMinBookDepthShares,
    liveOrderTimeoutMs: runtime.config.liveOrderTimeoutMs,
    liveHedgeMaxLossDollars: runtime.config.liveHedgeMaxLossDollars,
    liveHedgeFeeBufferDollars: runtime.config.liveHedgeFeeBufferDollars,
    liveHedgeMinCrossTicks: runtime.config.liveHedgeMinCrossTicks,
    liveOrderPlacementMode: runtime.config.liveOrderPlacementMode,
    kalshiHedgeOrderMode: runtime.config.kalshiHedgeOrderMode,
    kalshiUiQuickOrderCapValidated: runtime.config.kalshiUiQuickOrderCapValidated,
    kalshiFixHost: runtime.config.kalshiFixHost,
    kalshiFixPort: runtime.config.kalshiFixPort,
    kalshiFixTargetCompId: runtime.config.kalshiFixTargetCompId,
    kalshiFixUseDollars: runtime.config.kalshiFixUseDollars,
    liveAggressiveLimitRestMs: runtime.config.liveAggressiveLimitRestMs,
    liveParallelExecutionEnabled: runtime.config.liveParallelExecutionEnabled,
    liveHotPathEnabled: runtime.config.liveHotPathEnabled,
    liveHotPathCacheMaxAgeMs: runtime.config.liveHotPathCacheMaxAgeMs,
    liveHotPathWarmIntervalMs: runtime.config.liveHotPathWarmIntervalMs,
    livePolymarketPresignEnabled: runtime.config.livePolymarketPresignEnabled,
    livePolymarketSignedOrderTtlMs: runtime.config.livePolymarketSignedOrderTtlMs,
    livePolymarketFirstMinFillShares: runtime.config.livePolymarketFirstMinFillShares,
    livePolymarketFirstMaxFillShares: runtime.config.livePolymarketFirstMaxFillShares,
    liveKalshiHedgeTimeInForce: runtime.config.liveKalshiHedgeTimeInForce,
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
    polymarketGeoblockGateEnabled: runtime.config.polymarketGeoblockGateEnabled,
    liveExactExposureRequired: runtime.config.liveExactExposureRequired,
    liveExecutionQualityGateEnabled: runtime.config.liveExecutionQualityGateEnabled,
    liveExecutionQualityLookbackMs: runtime.config.liveExecutionQualityLookbackMs,
    liveExecutionQualitySampleLimit: runtime.config.liveExecutionQualitySampleLimit,
    liveExecutionQualityMinSamples: runtime.config.liveExecutionQualityMinSamples,
    liveExecutionQualityMinExactFillRate: runtime.config.liveExecutionQualityMinExactFillRate,
    liveFillQualityScoringEnabled: runtime.config.liveFillQualityScoringEnabled,
    liveFillQualityGateEnabled: runtime.config.liveFillQualityGateEnabled,
    liveFillQualityMinExpectedEdge: runtime.config.liveFillQualityMinExpectedEdge,
    liveFillQualityLookbackMs: runtime.config.liveFillQualityLookbackMs,
    liveFillQualitySampleLimit: runtime.config.liveFillQualitySampleLimit,
    liveFillQualityMinSamples: runtime.config.liveFillQualityMinSamples,
    liveFillQualityModelVersion: runtime.config.liveFillQualityModelVersion,
    liveLeadLagScoringEnabled: runtime.config.liveLeadLagScoringEnabled,
    liveLeadLagGateEnabled: runtime.config.liveLeadLagGateEnabled,
    liveLeadLagModelVersion: runtime.config.liveLeadLagModelVersion,
    liveLeadLagWindowsMs: runtime.config.liveLeadLagWindowsMs,
    liveLeadLagMinConfidence: runtime.config.liveLeadLagMinConfidence,
    liveLeadLagMaxAdverseSelectionScore: runtime.config.liveLeadLagMaxAdverseSelectionScore,
    livePartialFillLockMode: runtime.config.livePartialFillLockMode,
    liveMaxUnresolvedExposureDollars: runtime.config.liveMaxUnresolvedExposureDollars,
    liveReconcileBeforeTrade: runtime.config.liveReconcileBeforeTrade,
  };
}

function sortedCandidates(
  runtime: DashboardRuntime,
  now: number,
): { liveCandidates: ArbCandidate[]; syntheticStructures: ArbCandidate[] } {
  const paired = enumerateCandidates(
    runtime.books.getPolymarketContracts(runtime.config.staleBookMs, now),
    runtime.books.getKalshiContracts(runtime.config.staleBookMs, now),
    runtime.config.minProfitDollars,
  );
  const liveCandidates = paired.executable.sort(
    (left, right) => right.guaranteedProfit - left.guaranteedProfit || left.expiryMs - right.expiryMs,
  );
  const syntheticStructures = [...paired.executable, ...paired.rejected].sort((left, right) => {
    const classificationRank = (candidate: ArbCandidate): number => {
      if (candidate.risk?.classification === "true_arbitrage") return 0;
      if (candidate.risk?.classification === "guaranteed_below_threshold") return 1;
      return 2;
    };
    return (
      classificationRank(left) - classificationRank(right) ||
      (right.risk?.worstCaseProfit ?? right.guaranteedProfit) - (left.risk?.worstCaseProfit ?? left.guaranteedProfit) ||
      left.expiryMs - right.expiryMs
    );
  });
  return { liveCandidates, syntheticStructures };
}

/**
 * Lightweight, in-memory-only slice for high-frequency polling (~sub-second):
 * books, scanner, live candidates, readiness/op-status, diagnostics, latency,
 * health. Deliberately omits the heavy DB/venue reads (recentSignals, analytics,
 * tradingActivity, logs) which the dashboard polls on a slower cadence.
 */
export async function createLiveSnapshot(
  runtime: DashboardRuntime,
  now = Date.now(),
  cache?: DashboardSnapshotCache,
): Promise<Partial<DashboardSnapshot>> {
  const startedAt = Date.now();
  const books = time("liveSnapshotTrim", () => trimBookSnapshot(runtime.books.snapshot()));
  const scannerStatus = runtime.getScannerStatus();
  const execution = await cachedExecutionReadiness(runtime, now, cache);
  const { liveCandidates, syntheticStructures } = sortedCandidates(runtime, now);
  const buildMs = Math.max(0, Date.now() - startedAt);
  return {
    generatedAt: now,
    health: buildHealth(runtime),
    latency: runtime.getLatencySnapshot?.(now, buildMs),
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
    execution,
  };
}

export async function createDashboardSnapshot(
  runtime: DashboardRuntime,
  now = Date.now(),
  cache?: DashboardSnapshotCache,
): Promise<DashboardSnapshot> {
  const snapshotStartedAt = Date.now();
  const books = trimBookSnapshot(runtime.books.snapshot());
  const scannerStatus = runtime.getScannerStatus();
  const [recentSignals, analytics] = await Promise.all([
    cachedRecentSignals(runtime, now, cache),
    cachedAnalytics(runtime, now, cache),
  ]);
  const execution = await cachedExecutionReadiness(runtime, now, cache);
  const [tradingActivity, venuePnl, equityCurve] = await Promise.all([
    cachedTradingActivity(runtime, now, execution, cache),
    cachedVenuePnl(runtime, now, cache),
    cachedEquityCurve(runtime, now, cache),
  ]);
  const { liveCandidates, syntheticStructures } = sortedCandidates(runtime, now);

  const snapshotBuildMs = Math.max(0, Date.now() - snapshotStartedAt);
  return {
    generatedAt: now,
    health: buildHealth(runtime),
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
    // Transport-trim at the source so BOTH the snapshot endpoint and the SSE stream (which bypasses the
    // Vercel proxy) emit the same lightweight signals; the proxy trim is then idempotent.
    recentSignals: recentSignals.map(trimSignalForTransport),
    analytics,
    tradingActivity,
    venuePnl,
    equityCurve,
    execution,
    logs: runtime.getLogs(150),
  };
}

export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Shared across all dashboard requests (snapshot polls + stream) so the
// expensive reads (recent signals, readiness, trading activity) are reused
// within their refresh windows instead of rebuilt on every poll.
const sharedSnapshotCache: DashboardSnapshotCache = {};

async function writeSnapshot(response: ServerResponse, runtime: DashboardRuntime): Promise<void> {
  sendJson(response, 200, await createDashboardSnapshot(runtime, Date.now(), sharedSnapshotCache));
}

async function writeLive(response: ServerResponse, runtime: DashboardRuntime): Promise<void> {
  sendJson(response, 200, await createLiveSnapshot(runtime, Date.now(), sharedSnapshotCache));
}

async function writeTradingActivity(
  response: ServerResponse,
  runtime: DashboardRuntime,
  platform: TradingPlatform | null,
): Promise<void> {
  const now = Date.now();
  const readiness = await runtime.getExecutionReadiness?.(now);
  if (platform && runtime.getTradingPlatformActivity) {
    sendJson(response, 200, await runtime.getTradingPlatformActivity(platform, now, readiness));
    return;
  }
  sendJson(
    response,
    200,
    runtime.getTradingActivity ? await runtime.getTradingActivity(now, readiness) : emptyTradingActivity(now),
  );
}

async function writeStream(response: ServerResponse, runtime: DashboardRuntime): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = async (): Promise<void> => {
    try {
      response.write(
        formatSseEvent("snapshot", await createDashboardSnapshot(runtime, Date.now(), sharedSnapshotCache)),
      );
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

/** Validate a short-lived browser realtime token: `${expiryMs}.${HMAC(expiryMs)}`. */
function realtimeTokenValid(token: string | null, secret: string): boolean {
  if (!secret || !token) return false;
  const [expStr, sig] = token.split(".", 2);
  const exp = Number(expStr);
  if (!expStr || !sig || !Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = createHmac("sha256", secret).update(expStr).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Stable signature of the meaningful live state — excludes volatile timestamps/ages
 *  so the stream only pushes when something a viewer cares about actually changes. */
function liveSignature(s: Partial<DashboardSnapshot>): string {
  const e = s.execution;
  return JSON.stringify({
    b: s.books,
    c: s.liveCandidates,
    n: s.scanner?.lastCandidateCount,
    sc: s.scanner?.scanning,
    r: e?.riskState,
    cb: e?.circuitBreakerLocked,
    pf: e?.partialFillLocked,
    kr: e?.kalshi?.ready,
    pr: e?.polymarket?.ready,
    kb: e?.kalshi?.balance,
    pb: e?.polymarket?.balance,
    ex: e?.reconciliation?.quarantinedExposureDollars,
    kc: e?.userStreams?.kalshi?.connected,
    pc: e?.userStreams?.polymarket?.connected,
    eq: e?.executionQuality?.exactPairFillRate,
    mm: e?.executionQuality?.mismatchRate,
    est: e?.executionQuality?.estimatedExecutableEdge,
    dx: s.diagnostics?.polymarket?.readyContracts,
  });
}

/** SSE push of the live slice — emits a "live" event only when the signature changes
 *  (heartbeat comment otherwise), so idle bandwidth stays near zero. */
async function writeLiveStream(response: ServerResponse, runtime: DashboardRuntime, origin: string): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": origin || "*",
    Vary: "Origin",
  });
  let lastSig = "";
  let lastSignalsSig = "";
  const tick = async (): Promise<void> => {
    try {
      const now = Date.now();
      const slice = await createLiveSnapshot(runtime, now, sharedSnapshotCache);
      const sig = liveSignature(slice);
      // Freshness: push recentSignals over the realtime stream the moment the ledger changes (a new/updated
      // trade), instead of waiting for the ~6s heavy poll. Detected via a cheap fingerprint of the cached
      // signals (cache TTL = dashboardSignalRefreshMs, shared across streams), so it only ships the
      // (transport-trimmed) list on actual change — never every 250ms frame.
      const recentSignals = await cachedRecentSignals(runtime, now, sharedSnapshotCache);
      const signalsSig = recentSignalsSignature(recentSignals);
      const signalsChanged = signalsSig !== lastSignalsSig;
      if (sig !== lastSig || signalsChanged) {
        lastSig = sig;
        if (signalsChanged) {
          lastSignalsSig = signalsSig;
          (slice as Partial<DashboardSnapshot>).recentSignals = recentSignals.map(trimSignalForTransport);
        }
        response.write(formatSseEvent("live", slice));
      } else {
        response.write(": hb\n\n");
      }
    } catch (error) {
      response.write(formatSseEvent("error", { message: error instanceof Error ? error.message : String(error) }));
    }
  };
  // Serialize tick invocations: the 250ms timer and the event-driven notify both run tick() and share
  // lastSig/lastSignalsSig, so a concurrent pair could interleave at an await and double-ship. runTick lets
  // at most one tick run at a time; a notify arriving mid-tick coalesces into a single trailing re-run.
  let ticking = false;
  let rerun = false;
  const runTick = async (): Promise<void> => {
    if (ticking) {
      rerun = true;
      return;
    }
    ticking = true;
    try {
      await tick();
    } finally {
      ticking = false;
      if (rerun) {
        rerun = false;
        void runTick();
      }
    }
  };
  await runTick();
  // 250ms matches the scanner heartbeat (scanHeartbeatMs); the live slice can't
  // change faster than the source data refreshes, so pushing more often gains nothing. The notify path below
  // collapses the freshness floor for the ledger from this poll interval down to ~network RTT.
  const timer = setInterval(() => void runTick(), 250);
  // Event-driven freshness: when a real trade is written, push the new ledger row immediately. The shared
  // recentSignals cache may still be within its TTL and would otherwise return the pre-trade list, so force a
  // refetch (refreshedAt=0) before ticking. tick()'s recentSignalsSignature guard still prevents any
  // double-ship vs the timer. Sparse (~79 real trades/day), so this adds no meaningful DB or socket load.
  const unsubscribe = runtime.signalsNotifier?.subscribe(() => {
    if (sharedSnapshotCache.recentSignals) sharedSnapshotCache.recentSignals.refreshedAt = 0;
    void runTick();
  });
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

  // Direct browser realtime stream: token-query (or bearer) auth + CORS, handled
  // before the generic bearer gate since EventSource can't set an Authorization header.
  if (pathname === "/dashboard/live/stream") {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "";
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization",
        Vary: "Origin",
      });
      response.end();
      return true;
    }
    const authed =
      realtimeTokenValid(url.searchParams.get("token"), runtime.config.dashboardRealtimeSecret) ||
      (!!runtime.config.dashboardApiToken &&
        dashboardRequestAuthorized(request.headers, runtime.config.dashboardApiToken));
    if (!authed) {
      response.writeHead(401, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin || "*",
        Vary: "Origin",
      });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return true;
    }
    await writeLiveStream(response, runtime, origin);
    return true;
  }

  if (
    pathname !== "/dashboard/snapshot" &&
    pathname !== "/dashboard/live" &&
    pathname !== "/dashboard/stream" &&
    pathname !== "/trading/activity"
  )
    return false;

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

  if (pathname === "/dashboard/live") {
    await writeLive(response, runtime);
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
