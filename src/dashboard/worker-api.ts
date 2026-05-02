import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config";
import { buildDashboardAnalytics, oldestAnalyticsSinceMs } from "../analytics/performance";
import type { BookStore } from "../books/book-store";
import { emptyPolymarketDiagnostics } from "../discovery/polymarket";
import type { ScannerStatus } from "../scanner/scanner";
import { enumerateCandidates } from "../scanner/pairing";
import type { ArbCandidate, DashboardLogEntry, DashboardSignal, DashboardSnapshot, PolymarketDiagnostics } from "../types";

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
  getScannerStatus: () => ScannerStatus;
  getDiscoveryState: () => DashboardDiscoveryState;
  getPolymarketDiagnostics?: (now: number) => PolymarketDiagnostics;
  getLogs: (limit?: number) => DashboardLogEntry[];
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

export async function createDashboardSnapshot(runtime: DashboardRuntime, now = Date.now()): Promise<DashboardSnapshot> {
  const books = runtime.books.snapshot();
  const [recentSignals, analyticsSignals] = await Promise.all([
    runtime.signals.listRecentSignals(100),
    runtime.signals.listFilledSignalsSince?.(oldestAnalyticsSinceMs(now), 10_000) ?? Promise.resolve([]),
  ]);
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

  return {
    generatedAt: now,
    health: {
      ok: true,
      liveTrading: runtime.config.liveTrading,
      arbEnabled: runtime.config.arbEnabled,
      minProfitDollars: runtime.config.minProfitDollars,
      reentryIntervalMs: runtime.config.reentryIntervalMs,
      staleBookMs: runtime.config.staleBookMs,
    },
    discovery: runtime.getDiscoveryState(),
    scanner: runtime.getScannerStatus(),
    books,
    diagnostics: {
      polymarket: runtime.getPolymarketDiagnostics?.(now) ?? emptyPolymarketDiagnostics(),
    },
    liveCandidates,
    syntheticStructures,
    recentSignals,
    analytics: buildDashboardAnalytics(analyticsSignals, now),
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

  const send = async (): Promise<void> => {
    try {
      response.write(formatSseEvent("snapshot", await createDashboardSnapshot(runtime)));
    } catch (error) {
      response.write(formatSseEvent("error", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  await send();
  const timer = setInterval(() => void send(), 1000);
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
