import WebSocket from "ws";
import { logEvent, logThrottle } from "../logger";
import type { PolymarketPriceBeatRecord, PolymarketPriceBeatRepository } from "../db/polymarket-price-beats";
import { computeReconnectDelay, isRateLimitError } from "../ws/reconnect";

type RawWebSocket = Pick<WebSocket, "on" | "send" | "close" | "readyState">;
type WebSocketFactory = (url: string) => RawWebSocket;

export interface PolymarketPriceBeatWindow {
  marketSlug: string;
  conditionId: string | null;
  eventStartMs: number;
  expiryMs: number;
}

export interface PolymarketChainlinkTick {
  symbol: string | null;
  value: number;
  timestampMs: number;
  receivedAtMs: number;
}

export interface PolymarketPriceToBeatRuntimeDiagnostics {
  lastChainlinkTickAt: number | null;
  lastChainlinkTickAgeMs: number | null;
  nextCaptureWindowStartMs: number | null;
}

export interface PolymarketPriceToBeatServiceOptions {
  url: string;
  symbol: string;
  toleranceMs: number;
  store: PolymarketPriceBeatRepository;
  wsFactory?: WebSocketFactory;
  onCapture?: (record: PolymarketPriceBeatRecord) => void;
}

function numberFrom(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampFrom(value: unknown): number | null {
  const parsed = numberFrom(value);
  if (parsed == null) return null;
  return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function walkValues(value: unknown, visitor: (candidate: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkValues(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  visitor(candidate);
  for (const child of Object.values(candidate)) walkValues(child, visitor);
}

export function buildPolymarketPriceSubscriptionMessage(symbol: string): Record<string, unknown> {
  return {
    action: "subscribe",
    subscriptions: [
      {
        topic: "crypto_prices_chainlink",
        type: "update",
        filters: JSON.stringify({ symbol }),
      },
    ],
  };
}

export function parsePolymarketChainlinkTicks(raw: unknown, receivedAtMs = Date.now()): PolymarketChainlinkTick[] {
  const ticks: PolymarketChainlinkTick[] = [];
  walkValues(raw, (candidate) => {
    const value = numberFrom(candidate.value ?? candidate.full_accuracy_value ?? candidate.price);
    const timestampMs = timestampFrom(candidate.timestamp ?? candidate.ts ?? candidate.time);
    if (value == null || timestampMs == null) return;
    const symbol = typeof candidate.symbol === "string" ? candidate.symbol : null;
    ticks.push({ symbol, value, timestampMs, receivedAtMs });
  });
  return ticks
    .filter((tick, index, all) => all.findIndex((other) => other.timestampMs === tick.timestampMs && other.value === tick.value) === index)
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

function shouldCaptureTick(window: PolymarketPriceBeatWindow, tick: PolymarketChainlinkTick, toleranceMs: number): boolean {
  return tick.timestampMs >= window.eventStartMs && tick.timestampMs - window.eventStartMs <= toleranceMs;
}

export class PolymarketPriceToBeatService {
  private readonly windows = new Map<string, PolymarketPriceBeatWindow>();
  private readonly captured = new Set<string>();
  private readonly captureInFlight = new Set<string>();
  private readonly wsFactory: WebSocketFactory;
  private readonly onCapture?: (record: PolymarketPriceBeatRecord) => void;
  private socket: RawWebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private lastChainlinkTickAt: number | null = null;

  constructor(private readonly options: PolymarketPriceToBeatServiceOptions) {
    this.wsFactory = options.wsFactory ?? ((wsUrl) => new WebSocket(wsUrl));
    this.onCapture = options.onCapture;
  }

  start(): void {
    this.intentionalClose = false;
    this.ensureSocket();
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  setCaptureWindows(windows: PolymarketPriceBeatWindow[], now = Date.now()): void {
    const next = new Map<string, PolymarketPriceBeatWindow>();
    for (const window of windows) {
      if (window.expiryMs <= now) continue;
      if (this.captured.has(window.marketSlug)) continue;
      next.set(window.marketSlug, window);
    }
    this.windows.clear();
    for (const [slug, window] of next) this.windows.set(slug, window);
  }

  getDiagnostics(now = Date.now()): PolymarketPriceToBeatRuntimeDiagnostics {
    const pendingStarts = [...this.windows.values()]
      .map((window) => window.eventStartMs)
      .filter((eventStartMs) => eventStartMs >= now - this.options.toleranceMs)
      .sort((left, right) => left - right);
    return {
      lastChainlinkTickAt: this.lastChainlinkTickAt,
      lastChainlinkTickAgeMs: this.lastChainlinkTickAt == null ? null : Math.max(0, now - this.lastChainlinkTickAt),
      nextCaptureWindowStartMs: pendingStarts[0] ?? null,
    };
  }

  async handleTicksForTest(ticks: PolymarketChainlinkTick[]): Promise<void> {
    for (const tick of ticks) await this.handleTick(tick);
  }

  private ensureSocket(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    logEvent({ category: "POLYMARKET_PRICE", message: "price-to-beat websocket connecting", context: { symbol: this.options.symbol } });
    const socket = this.wsFactory(this.options.url);
    this.socket = socket;
    this.intentionalClose = false;

    socket.on("open", () => {
      this.reconnectAttempts = 0;
      socket.send(JSON.stringify(buildPolymarketPriceSubscriptionMessage(this.options.symbol)));
      this.startHeartbeat(socket);
      logEvent({ category: "POLYMARKET_PRICE", message: "price-to-beat websocket subscribed", context: { symbol: this.options.symbol } });
    });

    socket.on("message", (raw: WebSocket.RawData) => {
      try {
        const text = raw.toString().trim();
        if (!text || text === "PING" || text === "PONG") return;
        const payload = JSON.parse(text);
        const ticks = parsePolymarketChainlinkTicks(payload);
        for (const tick of ticks) void this.handleTick(tick);
      } catch (error) {
        logEvent({
          severity: "ERROR",
          category: "POLYMARKET_PRICE",
          message: "price-to-beat websocket parse error",
          context: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    });

    socket.on("error", (error: Error) => {
      logEvent({ severity: "ERROR", category: "POLYMARKET_PRICE", message: "price-to-beat websocket error", context: { error: error.message } });
    });

    socket.on("close", (_code: number, reason: Buffer) => {
      this.socket = null;
      this.clearHeartbeat();
      if (!this.intentionalClose) this.scheduleReconnect(reason.toString());
    });
  }

  private async handleTick(tick: PolymarketChainlinkTick): Promise<void> {
    if (tick.symbol && tick.symbol.toLowerCase() !== this.options.symbol.toLowerCase()) return;
    this.lastChainlinkTickAt = Math.max(this.lastChainlinkTickAt ?? 0, tick.timestampMs);
    for (const window of this.windows.values()) {
      if (!shouldCaptureTick(window, tick, this.options.toleranceMs)) continue;
      if (this.captured.has(window.marketSlug) || this.captureInFlight.has(window.marketSlug)) continue;
      this.captureInFlight.add(window.marketSlug);
      const record: PolymarketPriceBeatRecord = {
        marketSlug: window.marketSlug,
        conditionId: window.conditionId,
        eventStartMs: window.eventStartMs,
        expiryMs: window.expiryMs,
        priceToBeat: tick.value,
        source: "chainlink_ws",
        sourceTimestampMs: tick.timestampMs,
      };
      try {
        await this.options.store.upsert(record);
        this.captured.add(window.marketSlug);
        this.windows.delete(window.marketSlug);
        this.onCapture?.(record);
        logEvent({
          category: "POLYMARKET_PRICE",
          message: "captured Polymarket price-to-beat",
          context: { marketSlug: window.marketSlug, priceToBeat: tick.value, sourceTimestampMs: tick.timestampMs },
        });
      } catch (error) {
        logEvent({
          severity: "ERROR",
          category: "POLYMARKET_PRICE",
          message: "failed to persist Polymarket price-to-beat",
          context: { marketSlug: window.marketSlug, error: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        this.captureInFlight.delete(window.marketSlug);
      }
    }
  }

  private startHeartbeat(socket: RawWebSocket): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat();
        return;
      }
      try {
        socket.send("PING");
      } catch (error) {
        logEvent({
          severity: "ERROR",
          category: "POLYMARKET_PRICE",
          message: "price-to-beat websocket heartbeat failed",
          context: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }, 10_000);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(reasonText: string): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const rateLimitBackoffUntil = isRateLimitError(reasonText) ? Date.now() + 15_000 : 0;
    const { delayMs, reason } = computeReconnectDelay({
      attempt: this.reconnectAttempts,
      now: Date.now(),
      rateLimitBackoffUntil,
    });
    logThrottle(`poly-price-ws-reconnect:${reason}`, 10_000, {
      severity: "WARN",
      category: "POLYMARKET_PRICE",
      message: "price-to-beat websocket reconnect scheduled",
      context: { delayMs, reason, attempt: this.reconnectAttempts },
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delayMs);
  }
}
