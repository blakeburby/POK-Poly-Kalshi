import WebSocket from "ws";
import type { ApiKeyCreds } from "@polymarket/clob-client-v2";
import type { AppConfig } from "../config";
import type { LiveExecutionLockWriter } from "../db/live-execution-locks";
import type { VenueOrderEventInput, VenueOrderEventWriter } from "../db/venue-order-events";
import { resolvePolymarketApiCreds } from "../execution/live-clients";
import { logEvent, logThrottle } from "../logger";
import type { UserStreamVenueState } from "../types";
import { computeReconnectDelay, isRateLimitError } from "../ws/reconnect";

type RawWebSocket = Pick<WebSocket, "on" | "send" | "close" | "readyState"> & { ping?: () => void };
type WebSocketFactory = (url: string) => RawWebSocket;
type CredentialsFactory = () => Promise<ApiKeyCreds>;

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

function normalizeEventType(value: unknown): string | null {
  const raw = stringOrNull(value);
  return raw ? raw.toLowerCase() : null;
}

function normalizedOrderStatus(message: Record<string, unknown>): string {
  const rawStatus = stringOrNull(message.status);
  if (rawStatus && ["FAILED", "REJECTED", "CANCELED", "CANCELLED"].includes(rawStatus.toUpperCase())) {
    return rawStatus.toLowerCase();
  }
  const type = String(message.type ?? "").toUpperCase();
  const matched = numberOrNull(message.size_matched);
  if (type === "UPDATE" && matched != null && matched > 0) return "matched";
  if (type === "CANCELLATION") return "canceled";
  if (type === "PLACEMENT") return "placed";
  return type.toLowerCase() || "unknown";
}

export function buildPolymarketUserSubscribeMessage(creds: ApiKeyCreds): Record<string, unknown> {
  return {
    auth: {
      apiKey: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    },
    type: "user",
  };
}

export function parsePolymarketUserStreamSocketPayload(raw: WebSocket.RawData): VenueOrderEventInput[] | null {
  const text = raw.toString().trim();
  if (!text || ["PONG", "PING", "NO NEW MARKETS"].includes(text.toUpperCase())) return null;
  return parsePolymarketUserStreamPayload(JSON.parse(text));
}

export function parsePolymarketUserStreamPayload(raw: unknown, receivedAtMs = Date.now()): VenueOrderEventInput[] {
  const messages = Array.isArray(raw) ? raw : [raw];
  const events: VenueOrderEventInput[] = [];
  for (const message of messages) {
    const record = message && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : null;
    if (!record) continue;
    const eventType = normalizeEventType(record.event_type);
    if (eventType === "trade") {
      const status = stringOrNull(record.status)?.toLowerCase() ?? "matched";
      const orderId = stringOrNull(record.taker_order_id) ?? stringOrNull(record.id);
      events.push({
        venue: "polymarket" as const,
        clientOrderId: null,
        venueOrderId: orderId,
        eventType: "trade",
        assetId: stringOrNull(record.asset_id),
        marketId: stringOrNull(record.market),
        side: stringOrNull(record.side),
        status,
        fillCount: numberOrNull(record.size),
        remainingCount: null,
        fillPrice: numberOrNull(record.price),
        fee: numberOrNull(record.fee),
        exchangeTimestampMs: timestampMs(record.timestamp ?? record.matchtime ?? record.last_update),
        sequence: stringOrNull(record.id),
        receivedAtMs,
        raw: record,
      });
      continue;
    }

    if (eventType === "order") {
      const originalSize = numberOrNull(record.original_size);
      const matchedSize = numberOrNull(record.size_matched);
      events.push({
        venue: "polymarket" as const,
        clientOrderId: null,
        venueOrderId: stringOrNull(record.id),
        eventType: "order",
        assetId: stringOrNull(record.asset_id),
        marketId: stringOrNull(record.market),
        side: stringOrNull(record.side),
        status: normalizedOrderStatus(record),
        fillCount: matchedSize,
        remainingCount: originalSize != null && matchedSize != null
          ? Math.max(0, originalSize - matchedSize)
          : null,
        fillPrice: numberOrNull(record.price),
        fee: numberOrNull(record.fee),
        exchangeTimestampMs: timestampMs(record.timestamp),
        sequence: stringOrNull(record.id),
        receivedAtMs,
        raw: record,
      });
    }
  }
  return events;
}

export class PolymarketUserStreamClient {
  private readonly desired = new Set<string>();
  private socket: RawWebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
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
    private readonly credentialsFactory: CredentialsFactory,
    private readonly wsFactory: WebSocketFactory = (wsUrl) => new WebSocket(wsUrl),
    private readonly liveLocks?: LiveExecutionLockWriter,
  ) {}

  static fromConfig(config: AppConfig, events: VenueOrderEventWriter, liveLocks?: LiveExecutionLockWriter): PolymarketUserStreamClient {
    return new PolymarketUserStreamClient(
      config.polymarketUserWsUrl,
      events,
      async () => (await resolvePolymarketApiCreds(config)).creds,
      undefined,
      liveLocks,
    );
  }

  status(): UserStreamVenueState {
    return { ...this.state };
  }

  setSubscriptions(conditionIds: Iterable<string>): void {
    this.desired.clear();
    for (const id of conditionIds) this.desired.add(id);
    if (this.desired.size === 0) {
      this.state = { ...this.state, subscribed: false, reason: "no Polymarket markets discovered" };
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      void this.subscribe(this.socket);
      return;
    }
    void this.ensureSocket();
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.state = { ...this.state, connected: false, subscribed: false, reason: "closed by worker" };
  }

  private async ensureSocket(): Promise<void> {
    if (this.desired.size === 0) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    logEvent({ category: "POLYMARKET_USER", message: "user websocket connecting", context: { subscriptions: this.desired.size } });
    const socket = this.wsFactory(this.url);
    this.socket = socket;
    this.intentionalClose = false;

    socket.on("open", () => {
      this.reconnectAttempts = 0;
      this.state = { ...this.state, connected: true, reason: null, lastConnectedAt: Date.now(), lastError: null };
      void this.subscribe(socket);
      this.startHeartbeat(socket);
    });

    socket.on("message", (raw: WebSocket.RawData) => {
      try {
        const events = parsePolymarketUserStreamSocketPayload(raw);
        if (!events) return;
        for (const event of events) {
          this.state = { ...this.state, lastEventAt: event.receivedAtMs ?? Date.now(), reason: null };
          void this.events.recordEvent(event);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.state = { ...this.state, lastError: reason };
        logEvent({ severity: "ERROR", category: "POLYMARKET_USER", message: "user websocket parse error", context: { error: reason } });
      }
    });

    socket.on("error", (error: Error) => {
      const wasConnected = this.state.connected || this.state.lastConnectedAt != null;
      this.state = { ...this.state, lastError: error.message, reason: error.message };
      logEvent({ severity: "ERROR", category: "POLYMARKET_USER", message: "user websocket error", context: { error: error.message } });
      if (wasConnected) void this.lockOnDisconnect(error.message);
    });

    socket.on("close", (_code: number, reason: Buffer) => {
      const reasonText = reason.toString() || "closed";
      const wasConnected = this.state.connected || this.state.lastConnectedAt != null;
      this.socket = null;
      this.clearHeartbeat();
      this.state = { ...this.state, connected: false, subscribed: false, reason: reasonText };
      if (!this.intentionalClose) {
        if (wasConnected) void this.lockOnDisconnect(reasonText);
        this.scheduleReconnect(reasonText);
      }
    });
  }

  private async subscribe(socket: RawWebSocket): Promise<void> {
    try {
      const creds = await this.credentialsFactory();
      socket.send(JSON.stringify(buildPolymarketUserSubscribeMessage(creds)));
      this.state = { ...this.state, subscribed: true, reason: null };
      logEvent({ category: "POLYMARKET_USER", message: "user websocket subscribed", context: { subscriptions: this.desired.size } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, subscribed: false, reason, lastError: reason };
      logEvent({ severity: "ERROR", category: "POLYMARKET_USER", message: "user websocket auth failed", context: { error: reason } });
    }
  }

  private startHeartbeat(socket: RawWebSocket): void {
    this.clearHeartbeat();
    if (!socket.ping) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat();
        return;
      }
      socket.ping?.();
    }, 10_000);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(reasonText: string): void {
    if (this.reconnectTimer || this.desired.size === 0) return;
    this.reconnectAttempts += 1;
    const { delayMs, reason } = computeReconnectDelay({
      attempt: this.reconnectAttempts,
      now: Date.now(),
      rateLimitBackoffUntil: isRateLimitError(reasonText) ? Date.now() + 15_000 : 0,
    });
    logThrottle(`poly-user-ws-reconnect:${reason}`, 10_000, {
      severity: "WARN",
      category: "POLYMARKET_USER",
      message: "user websocket reconnect scheduled",
      context: { delayMs, reason, attempt: this.reconnectAttempts },
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureSocket();
    }, delayMs);
  }

  private async lockOnDisconnect(reasonText: string): Promise<void> {
    await this.liveLocks?.engageLock({
      reason: `live safety lock engaged: Polymarket user stream disconnected: ${reasonText}`,
      details: {
        venue: "polymarket",
        phase: "user_stream_disconnect",
        reason: reasonText,
      },
    });
  }
}
