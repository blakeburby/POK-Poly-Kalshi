import WebSocket from "ws";
import { getKalshiWebsocketHeaders } from "./auth";
import { logEvent, logThrottle } from "../logger";
import type { VenueOrderEventWriter } from "../db/venue-order-events";
import type { UserStreamVenueState } from "../types";
import { computeReconnectDelay, isRateLimitError } from "../ws/reconnect";

type RawWebSocket = Pick<WebSocket, "on" | "send" | "close" | "readyState">;
type WebSocketFactory = (url: string, options: { headers: Record<string, string> }) => RawWebSocket;

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestampMs(value: unknown): number | null {
  const parsed = numberOrNull(value);
  if (parsed == null) return null;
  return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
}

function economicPrice(rawPrice: unknown, side: unknown): number | null {
  const yesPrice = numberOrNull(rawPrice);
  if (yesPrice == null) return null;
  const normalized = yesPrice > 1 ? yesPrice / 100 : yesPrice;
  const sideText = String(side ?? "").toLowerCase();
  const price = sideText.includes("no") ? 1 - normalized : normalized;
  const bounded = Math.max(0, Math.min(1, price));
  return Math.round(bounded * 1_000_000_000) / 1_000_000_000;
}

function economicSide(msg: Record<string, unknown>, fallbackSide: string | null): string | null {
  const purchasedSide = stringOrNull(msg.purchased_side);
  if (purchasedSide) return purchasedSide;
  if (msg.is_yes === false || String(msg.is_yes).toLowerCase() === "false") return "no";
  if (msg.is_yes === true || String(msg.is_yes).toLowerCase() === "true") return "yes";
  if (fallbackSide === "yes" || fallbackSide === "no") return fallbackSide;
  return fallbackSide;
}

export function buildKalshiUserStreamSubscribeMessage(id: number, marketTickers: Iterable<string>): Record<string, unknown> {
  const tickers = [...marketTickers].sort();
  const params: Record<string, unknown> = { channels: ["user_orders", "fill"] };
  if (tickers.length > 0) params.market_tickers = tickers;
  return { id, cmd: "subscribe", params };
}

export function parseKalshiUserStreamMessage(payload: unknown, receivedAtMs = Date.now()) {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  if (!record) return null;
  const type = stringOrNull(record.type);
  const msg = record.msg && typeof record.msg === "object" && !Array.isArray(record.msg) ? record.msg as Record<string, unknown> : null;
  if (!type || !msg) return null;

  if (type === "user_order") {
    const side = stringOrNull(msg.side) ?? (msg.is_yes === false ? "no" : "yes");
    const priceSide = economicSide(msg, side);
    return {
      venue: "kalshi" as const,
      clientOrderId: stringOrNull(msg.client_order_id),
      venueOrderId: stringOrNull(msg.order_id),
      eventType: "user_order",
      marketId: stringOrNull(msg.ticker) ?? stringOrNull(msg.market_ticker),
      side,
      status: stringOrNull(msg.status) ?? "unknown",
      fillCount: numberOrNull(msg.fill_count_fp ?? msg.fill_count),
      remainingCount: numberOrNull(msg.remaining_count_fp ?? msg.remaining_count),
      fillPrice: economicPrice(msg.yes_price_dollars ?? msg.yes_price, priceSide),
      fee: numberOrNull(msg.taker_fees_dollars ?? msg.maker_fees_dollars),
      exchangeTimestampMs: timestampMs(msg.last_update_ts_ms ?? msg.created_ts_ms),
      sequence: numberOrNull(record.sid),
      receivedAtMs,
      raw: { type, msg },
    };
  }

  if (type === "fill") {
    const side = stringOrNull(msg.purchased_side) ?? stringOrNull(msg.side);
    const priceSide = economicSide(msg, side);
    return {
      venue: "kalshi" as const,
      clientOrderId: null,
      venueOrderId: stringOrNull(msg.order_id),
      eventType: "fill",
      marketId: stringOrNull(msg.market_ticker) ?? stringOrNull(msg.ticker),
      side,
      status: "filled",
      fillCount: numberOrNull(msg.count_fp ?? msg.count),
      remainingCount: null,
      fillPrice: economicPrice(msg.yes_price_dollars ?? msg.yes_price, priceSide),
      fee: numberOrNull(msg.fee ?? msg.fees_dollars),
      exchangeTimestampMs: timestampMs(msg.ts_ms ?? msg.ts),
      sequence: numberOrNull(record.sid),
      receivedAtMs,
      raw: { type, msg },
    };
  }

  return null;
}

export class KalshiUserStreamClient {
  private readonly desired = new Set<string>();
  private socket: RawWebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private messageId = 1;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private state: UserStreamVenueState = {
    enabled: true,
    connected: false,
    subscribed: false,
    reason: "not connected",
    lastConnectedAt: null,
    lastEventAt: null,
    lastError: null,
  };

  constructor(
    private readonly url: string,
    private readonly events: VenueOrderEventWriter,
    private readonly wsFactory: WebSocketFactory = (wsUrl, options) => new WebSocket(wsUrl, options),
  ) {}

  status(): UserStreamVenueState {
    return { ...this.state };
  }

  setSubscriptions(marketTickers: Iterable<string>): void {
    this.desired.clear();
    for (const ticker of marketTickers) this.desired.add(ticker);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.subscribe(this.socket);
      return;
    }
    this.ensureSocket();
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.state = { ...this.state, connected: false, subscribed: false, reason: "closed by worker" };
  }

  private ensureSocket(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    let headers: Record<string, string>;
    try {
      headers = getKalshiWebsocketHeaders();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, connected: false, subscribed: false, reason, lastError: reason };
      logThrottle("kalshi-user-ws-auth", 60_000, { severity: "WARN", category: "KALSHI_USER", message: "user websocket auth unavailable", context: { reason } });
      return;
    }

    logEvent({ category: "KALSHI_USER", message: "user websocket connecting", context: { subscriptions: this.desired.size } });
    const socket = this.wsFactory(this.url, { headers });
    this.socket = socket;
    this.intentionalClose = false;

    socket.on("open", () => {
      this.reconnectAttempts = 0;
      this.state = { ...this.state, connected: true, reason: null, lastConnectedAt: Date.now(), lastError: null };
      this.subscribe(socket);
    });

    socket.on("message", (raw: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(raw.toString()) as unknown;
        const event = parseKalshiUserStreamMessage(payload);
        if (!event) return;
        this.state = { ...this.state, lastEventAt: event.receivedAtMs ?? Date.now(), reason: null };
        void this.events.recordEvent(event);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.state = { ...this.state, lastError: reason };
        logEvent({ severity: "ERROR", category: "KALSHI_USER", message: "user websocket parse error", context: { error: reason } });
      }
    });

    socket.on("error", (error: Error) => {
      this.state = { ...this.state, lastError: error.message, reason: error.message };
      logEvent({ severity: "ERROR", category: "KALSHI_USER", message: "user websocket error", context: { error: error.message } });
    });

    socket.on("close", (_code: number, reason: Buffer) => {
      const reasonText = reason.toString() || "closed";
      this.socket = null;
      this.state = { ...this.state, connected: false, subscribed: false, reason: reasonText };
      if (!this.intentionalClose) {
        this.scheduleReconnect(reasonText);
      }
    });
  }

  private subscribe(socket: RawWebSocket): void {
    socket.send(JSON.stringify(buildKalshiUserStreamSubscribeMessage(this.messageId++, this.desired)));
    this.state = { ...this.state, subscribed: true, reason: null };
    logEvent({ category: "KALSHI_USER", message: "user websocket subscribed", context: { subscriptions: this.desired.size } });
  }

  private scheduleReconnect(reasonText: string): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const { delayMs, reason } = computeReconnectDelay({
      attempt: this.reconnectAttempts,
      now: Date.now(),
      rateLimitBackoffUntil: isRateLimitError(reasonText) ? Date.now() + 15_000 : 0,
    });
    logThrottle(`kalshi-user-ws-reconnect:${reason}`, 10_000, {
      severity: "WARN",
      category: "KALSHI_USER",
      message: "user websocket reconnect scheduled",
      context: { delayMs, reason, attempt: this.reconnectAttempts },
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delayMs);
  }
}
