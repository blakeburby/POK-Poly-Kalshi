import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config";
import type { BookStore } from "../books/book-store";
import type { ScannerStatus } from "../scanner/scanner";
import { pairExecutableCandidates } from "../scanner/pairing";
import type { DashboardLogEntry, DashboardSignal, DashboardSnapshot } from "../types";

interface SignalReader {
  listRecentSignals(limit?: number): Promise<DashboardSignal[]>;
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
  const liveCandidates = pairExecutableCandidates(
    runtime.books.getPolymarketContracts(runtime.config.staleBookMs, now),
    runtime.books.getKalshiContracts(runtime.config.staleBookMs, now),
    runtime.config.minProfitDollars,
  ).sort((left, right) => right.guaranteedProfit - left.guaranteedProfit || left.expiryMs - right.expiryMs);

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
    liveCandidates,
    recentSignals: await runtime.signals.listRecentSignals(100),
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
