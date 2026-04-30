import WebSocket from "ws";
import { z } from "zod";
import { getKalshiWebsocketHeaders } from "./auth";
import { logEvent, logThrottle } from "../logger";
import { computeRateLimitBackoffDelay, computeReconnectDelay, isRateLimitError } from "../ws/reconnect";

type RawWebSocket = Pick<WebSocket, "on" | "send" | "close" | "readyState">;
type WebSocketFactory = (url: string, options: { headers: Record<string, string> }) => RawWebSocket;

export interface KalshiTickerSnapshot {
  marketTicker: string;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  timestamp: number;
}

const NumberLikeSchema = z.union([z.number(), z.string()]).nullable().optional();
const TickerMessageSchema = z.object({
  market_ticker: z.string(),
  yes_bid_dollars: NumberLikeSchema,
  yes_ask_dollars: NumberLikeSchema,
  no_bid_dollars: NumberLikeSchema,
  no_ask_dollars: NumberLikeSchema,
});

function dollarsToCentsDollars(value: unknown, mode: "bid" | "ask"): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return null;
  const cents = parsed * 100;
  const rounded = mode === "ask" ? Math.ceil(cents) : Math.floor(cents);
  return Math.max(0, Math.min(100, rounded)) / 100;
}

export function buildKalshiSubscribeMessage(id: number, marketTickers: Iterable<string>): Record<string, unknown> {
  return {
    id,
    cmd: "subscribe",
    params: {
      channels: ["ticker"],
      market_tickers: [...marketTickers].sort(),
    },
  };
}

export function parseKalshiTickerSnapshot(raw: unknown, timestamp = Date.now()): KalshiTickerSnapshot | null {
  const parsed = TickerMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const yesBid = dollarsToCentsDollars(parsed.data.yes_bid_dollars, "bid");
  const yesAsk = dollarsToCentsDollars(parsed.data.yes_ask_dollars, "ask");
  const noBidDirect = dollarsToCentsDollars(parsed.data.no_bid_dollars, "bid");
  const noAskDirect = dollarsToCentsDollars(parsed.data.no_ask_dollars, "ask");
  return {
    marketTicker: parsed.data.market_ticker,
    yesBid,
    yesAsk,
    noBid: noBidDirect ?? (yesAsk != null ? Math.max(0, 1 - yesAsk) : null),
    noAsk: noAskDirect ?? (yesBid != null ? Math.min(1, 1 - yesBid) : null),
    timestamp,
  };
}

export class KalshiTickerClient {
  private readonly desired = new Set<string>();
  private readonly listeners = new Set<(snapshot: KalshiTickerSnapshot) => void>();
  private readonly latest = new Map<string, KalshiTickerSnapshot>();
  private socket: RawWebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private rateLimitBackoffUntil = 0;
  private rateLimitAttempts = 0;
  private messageId = 1;
  private intentionalClose = false;
  private subscriptionFingerprint = "";

  constructor(
    private readonly url: string,
    private readonly wsFactory: WebSocketFactory = (wsUrl, options) => new WebSocket(wsUrl, options),
  ) {}

  onSnapshot(listener: (snapshot: KalshiTickerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSubscriptions(marketTickers: Iterable<string>): void {
    const previousFingerprint = this.subscriptionFingerprintFor(this.desired);
    this.desired.clear();
    for (const ticker of marketTickers) this.desired.add(ticker);
    const nextFingerprint = this.subscriptionFingerprintFor(this.desired);
    if (this.socket?.readyState === WebSocket.OPEN && previousFingerprint !== nextFingerprint) {
      this.subscriptionFingerprint = nextFingerprint;
      this.socket.send(JSON.stringify(buildKalshiSubscribeMessage(this.messageId++, this.desired)));
      logEvent({ category: "KALSHI", message: "websocket subscription refreshed", context: { subscriptions: this.desired.size } });
      return;
    }
    this.ensureSocket();
  }

  getLatest(marketTicker: string): KalshiTickerSnapshot | null {
    return this.latest.get(marketTicker) ?? null;
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.subscriptionFingerprint = "";
  }

  private ensureSocket(): void {
    if (this.desired.size === 0) {
      this.close();
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    let headers: Record<string, string>;
    try {
      headers = getKalshiWebsocketHeaders();
    } catch (error) {
      logThrottle("kalshi-ws-auth", 60_000, {
        severity: "WARN",
        category: "KALSHI",
        message: "Kalshi websocket auth unavailable",
        context: { reason: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    logEvent({ category: "KALSHI", message: "websocket connecting", context: { subscriptions: this.desired.size } });
    const socket = this.wsFactory(this.url, { headers });
    this.socket = socket;
    this.intentionalClose = false;

    socket.on("open", () => {
      this.reconnectAttempts = 0;
      this.rateLimitAttempts = 0;
      this.rateLimitBackoffUntil = 0;
      this.subscriptionFingerprint = this.subscriptionFingerprintFor(this.desired);
      socket.send(JSON.stringify(buildKalshiSubscribeMessage(this.messageId++, this.desired)));
      logEvent({ category: "KALSHI", message: "websocket subscribed", context: { subscriptions: this.desired.size } });
    });

    socket.on("message", (raw: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(raw.toString()) as { type?: string; msg?: unknown };
        if (payload.type !== "ticker") return;
        const snapshot = parseKalshiTickerSnapshot(payload.msg);
        if (!snapshot) return;
        this.latest.set(snapshot.marketTicker, snapshot);
        for (const listener of this.listeners) listener(snapshot);
      } catch (error) {
        logEvent({
          severity: "ERROR",
          category: "KALSHI",
          message: "websocket parse error",
          context: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    });

    socket.on("error", (error: Error) => {
      if (isRateLimitError(error.message)) this.registerRateLimit(error.message);
      logEvent({ severity: "ERROR", category: "KALSHI", message: "websocket error", context: { error: error.message } });
    });

    socket.on("close", (_code: number, reason: Buffer) => {
      const reasonText = reason.toString();
      if (!this.intentionalClose && isRateLimitError(reasonText)) this.registerRateLimit(reasonText);
      this.socket = null;
      this.subscriptionFingerprint = "";
      if (!this.intentionalClose) this.scheduleReconnect();
    });
  }

  private subscriptionFingerprintFor(tickers: Iterable<string>): string {
    return [...tickers].sort().join("|");
  }

  private registerRateLimit(details: string): void {
    this.rateLimitAttempts += 1;
    const delay = computeRateLimitBackoffDelay(this.rateLimitAttempts);
    this.rateLimitBackoffUntil = Math.max(this.rateLimitBackoffUntil, Date.now() + delay);
    logThrottle("kalshi-ws-rate-limit", 15_000, {
      severity: "WARN",
      category: "KALSHI",
      message: "websocket rate limited",
      context: { retryInMs: delay, details },
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.desired.size === 0) return;
    this.reconnectAttempts += 1;
    const { delayMs, reason } = computeReconnectDelay({
      attempt: this.reconnectAttempts,
      now: Date.now(),
      rateLimitBackoffUntil: this.rateLimitBackoffUntil,
    });
    logThrottle(`kalshi-ws-reconnect:${reason}`, 10_000, {
      severity: "WARN",
      category: "KALSHI",
      message: "websocket reconnect scheduled",
      context: { delayMs, reason, attempt: this.reconnectAttempts },
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delayMs);
  }
}
