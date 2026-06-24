import WebSocket from "ws";
import { logEvent, logThrottle, type LogCategory } from "../logger";
import { computeReconnectDelay, shouldForceFeedReconnect } from "./reconnect";

export type RawWebSocket = Pick<WebSocket, "on" | "send" | "close" | "readyState">;

export interface ReconnectingWebSocketClientOptions {
  feedSilenceMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => number;
}

/**
 * Shared socket-state-machine for the two order-BOOK feed clients (KalshiTickerClient, PolymarketBookClient).
 * It owns the parts that were copy-pasted between them and that must stay in lockstep — the open/message/error/
 * close handler wiring, the feed-silence watchdog tick, the exponential reconnect-backoff scheduling, and
 * graceful close — so a fix to the watchdog (which regressed once) happens in ONE place. Everything venue-
 * specific (auth, subscribe format, parse, PING keepalive, rate-limit source) stays in the subclass via hooks,
 * so this is behavior-preserving: the existing ws-backoff tests for both clients pass unchanged.
 *
 * NOT used by the user-STREAM clients — they have no feed-silence watchdog and a different (async-creds /
 * forcible-resubscribe / structured-state) lifecycle, so forcing them in would be a leaky abstraction.
 */
export abstract class ReconnectingWebSocketClient {
  protected readonly desired = new Set<string>();
  protected socket: RawWebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  protected reconnectAttempts = 0;
  protected intentionalClose = false;
  protected lastMessageAt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  protected readonly feedSilenceMs: number;
  protected readonly heartbeatIntervalMs: number;
  protected readonly now: () => number;

  protected constructor(
    protected readonly category: LogCategory,
    protected readonly logKeyPrefix: string,
    options: ReconnectingWebSocketClientOptions = {},
  ) {
    this.feedSilenceMs = options.feedSilenceMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.now = options.now ?? (() => Date.now());
  }

  // ----- venue hooks (subclass) -----
  /** Build + open the socket (incl. the venue "websocket connecting" log + any auth). Return null to abort
   *  the connect attempt without scheduling a reconnect (e.g. auth temporarily unavailable). */
  protected abstract createSocket(): RawWebSocket | null;
  /** Post-open: send subscribe message(s) + set venue subscription bookkeeping. reconnectAttempts/lastMessageAt
   *  have already been reset; startHeartbeat + the "subscribed" log run after this. */
  protected abstract onOpen(socket: RawWebSocket): void;
  /** Parse + dispatch one frame. Set `this.lastMessageAt = this.now()` only when a REAL book snapshot/delta
   *  arrives (not acks/keepalives) so the silence watchdog isn't falsely reset. Throwing is caught + logged. */
  protected abstract handleMessage(raw: WebSocket.RawData): void;
  /** Reset venue subscription bookkeeping on close (Kalshi fingerprint / Polymarket subscribed-set). */
  protected abstract resetSubscriptionState(): void;
  /** True if the heartbeat sends a keepalive PING (so the interval must run even when the watchdog is off). */
  protected abstract readonly sendsPing: boolean;
  /** The rate-limit backoff deadline fed to computeReconnectDelay (Kalshi: persistent field; Polymarket: from
   *  the close reason). */
  protected abstract reconnectRateLimitBackoffUntil(reasonText: string): number;
  /** Optional keepalive on each heartbeat tick (Polymarket PING; Kalshi none). */
  protected sendHeartbeat(_socket: RawWebSocket): void {}
  /** Optional venue reaction to a socket error before the shared error log (Kalshi rate-limit registration). */
  protected onSocketError(_error: Error): void {}
  /** Optional venue reaction to a close reason before teardown (Kalshi rate-limit-on-close). */
  protected onCloseReason(_reasonText: string): void {}

  // ----- shared lifecycle -----
  protected ensureSocket(): void {
    if (this.desired.size === 0) {
      this.close();
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    const socket = this.createSocket();
    if (!socket) return;
    this.socket = socket;
    this.intentionalClose = false;

    socket.on("open", () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = this.now();
      this.onOpen(socket);
      this.startHeartbeat(socket);
      logEvent({ category: this.category, message: "websocket subscribed", context: { subscriptions: this.desired.size } });
    });

    socket.on("message", (raw: WebSocket.RawData) => {
      try {
        this.handleMessage(raw);
      } catch (error) {
        logEvent({
          severity: "ERROR",
          category: this.category,
          message: "websocket parse error",
          context: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    });

    socket.on("error", (error: Error) => {
      this.onSocketError(error);
      logEvent({ severity: "ERROR", category: this.category, message: "websocket error", context: { error: error.message } });
    });

    socket.on("close", (_code: number, reason: Buffer) => {
      const reasonText = reason.toString();
      this.onCloseReason(reasonText);
      this.socket = null;
      this.resetSubscriptionState();
      this.clearHeartbeat();
      if (!this.intentionalClose) this.scheduleReconnect(reasonText);
    });
  }

  private startHeartbeat(socket: RawWebSocket): void {
    this.clearHeartbeat();
    // No keepalive + no watchdog => the interval would be a pure no-op for the life of the connection, so skip
    // it (matches the Kalshi book client). Polymarket sends a PING, so it keeps the interval regardless.
    if (this.feedSilenceMs <= 0 && !this.sendsPing) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat();
        return;
      }
      // Feed-liveness watchdog: a socket can stay open while the server stops sending book deltas — the
      // close-driven reconnect never fires, so detect the silence here and force a reconnect
      // (close -> scheduleReconnect -> fresh full subscribe).
      if (shouldForceFeedReconnect({
        now: this.now(),
        lastMessageAt: this.lastMessageAt,
        feedSilenceMs: this.feedSilenceMs,
        desiredSubscriptions: this.desired.size,
        socketOpen: socket.readyState === WebSocket.OPEN,
      })) {
        logThrottle(`${this.logKeyPrefix}-feed-silent`, 30_000, {
          severity: "WARN",
          category: this.category,
          message: "websocket feed silent, forcing reconnect",
          context: { silenceMs: this.now() - this.lastMessageAt, feedSilenceMs: this.feedSilenceMs, subscriptions: this.desired.size },
        });
        socket.close();
        return;
      }
      this.sendHeartbeat(socket);
    }, this.heartbeatIntervalMs);
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
      rateLimitBackoffUntil: this.reconnectRateLimitBackoffUntil(reasonText),
    });
    logThrottle(`${this.logKeyPrefix}-reconnect:${reason}`, 10_000, {
      severity: "WARN",
      category: this.category,
      message: "websocket reconnect scheduled",
      context: { delayMs, reason, attempt: this.reconnectAttempts },
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delayMs);
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    this.resetSubscriptionState();
    this.socket?.close();
    this.socket = null;
  }
}
