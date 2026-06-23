import WebSocket from "ws";
import { z } from "zod";
import { getKalshiWebsocketHeaders } from "./auth";
import { logEvent, logThrottle } from "../logger";
import type { BookLevel } from "../types";
import { computeRateLimitBackoffDelay, computeReconnectDelay, isRateLimitError, shouldForceFeedReconnect } from "../ws/reconnect";

type RawWebSocket = Pick<WebSocket, "on" | "send" | "close" | "readyState">;
type WebSocketFactory = (url: string, options: { headers: Record<string, string> }) => RawWebSocket;

export interface KalshiTickerClientOptions {
  /** Force a reconnect if the open socket receives no orderbook update for this long (ms); 0 disables. */
  feedSilenceMs?: number;
  /** Feed-liveness check cadence (ms). */
  heartbeatIntervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface KalshiTickerSnapshot {
  marketTicker: string;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  yesBidLevels?: BookLevel[];
  yesAskLevels?: BookLevel[];
  noBidLevels?: BookLevel[];
  noAskLevels?: BookLevel[];
  sequence?: number | null;
  bookHash?: string | null;
  tickSize?: number | null;
  tickSizeChangedAt?: number | null;
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

// Kalshi trades integer contracts, so any level size below this is dust (e.g. float residue from repeated
// orderbook_delta add/subtract, observed as ~8.5e-14) and must be treated as zero — otherwise depthWeightedAsk
// walks phantom levels and computes a garbage VWAP/edge.
const MIN_LEVEL_SIZE = 1e-6;
// Backstop cap on levels emitted per side. Kalshi is a 1¢ grid (≤99 real prices); more than this means the
// book Map accumulated near-duplicate/float-noise prices — bound the array so the per-scan sort/walk stays cheap.
const MAX_BOOK_LEVELS = 120;

function normalizePrice(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return null;
  const normalized = parsed > 1 ? Math.max(0, Math.min(100, parsed)) / 100 : Math.max(0, Math.min(1, parsed));
  // Round to a 4-decimal grid so float-imprecise prices (0.2600001 vs 0.26) collapse to the SAME Map key
  // instead of accumulating as distinct near-duplicate levels (the 440-levels-on-one-contract bug).
  return Math.round(normalized * 10_000) / 10_000;
}

function normalizeSize(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed >= MIN_LEVEL_SIZE ? parsed : null;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseLevel(value: unknown): BookLevel | null {
  if (Array.isArray(value)) {
    const price = normalizePrice(value[0]);
    const size = normalizeSize(value[1]);
    return price == null || size == null ? null : { price, size };
  }
  const record = rawRecord(value);
  if (!record) return null;
  const price = normalizePrice(record.price ?? record.yes_price ?? record.no_price);
  const size = normalizeSize(record.size ?? record.quantity ?? record.count);
  return price == null || size == null ? null : { price, size };
}

function sortedBids(levels: Iterable<BookLevel>): BookLevel[] {
  return [...levels]
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size >= MIN_LEVEL_SIZE)
    .sort((a, b) => b.price - a.price)
    .slice(0, MAX_BOOK_LEVELS);
}

function askFromOppositeBids(levels: Iterable<BookLevel>): BookLevel[] {
  return [...levels]
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size >= MIN_LEVEL_SIZE)
    .map((level) => ({ price: Math.round((1 - level.price) * 10_000) / 10_000, size: level.size }))
    .sort((a, b) => a.price - b.price)
    .slice(0, MAX_BOOK_LEVELS);
}

function bestBid(levels: BookLevel[]): number | null {
  return levels[0]?.price ?? null;
}

function bestAsk(levels: BookLevel[]): number | null {
  return levels[0]?.price ?? null;
}

export function buildKalshiSubscribeMessage(id: number, marketTickers: Iterable<string>): Record<string, unknown> {
  return {
    id,
    cmd: "subscribe",
    params: {
      channels: ["orderbook_delta"],
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

interface KalshiBookState {
  yesBids: Map<number, number>;
  noBids: Map<number, number>;
  sequence: number | null;
}

function setBookLevel(levels: Map<number, number>, price: number | null, size: number | null): void {
  if (price == null || size == null) return;
  // Treat dust (≤ epsilon) as zero so delta-accumulation residue doesn't persist as a phantom level.
  if (size < MIN_LEVEL_SIZE) levels.delete(price);
  else levels.set(price, size);
}

function levelsFromMap(levels: Map<number, number>): BookLevel[] {
  return sortedBids([...levels].map(([price, size]) => ({ price, size })));
}

function extractLevels(raw: Record<string, unknown>, keys: string[]): BookLevel[] {
  for (const key of keys) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    return value.map(parseLevel).filter((level): level is BookLevel => level != null);
  }
  return [];
}

export class KalshiOrderbookParser {
  private readonly books = new Map<string, KalshiBookState>();

  apply(type: string | undefined, raw: unknown, timestamp = Date.now()): KalshiTickerSnapshot | null {
    if (type === "ticker") return parseKalshiTickerSnapshot(raw, timestamp);
    const record = rawRecord(raw);
    if (!record) return null;
    const marketTicker = String(record.market_ticker ?? record.marketTicker ?? "");
    if (!marketTicker) return null;

    const state = this.getState(marketTicker);
    if (
      type === "orderbook_snapshot"
      || record.yes
      || record.no
      || record.yes_bids
      || record.no_bids
      || record.yes_dollars
      || record.no_dollars
      || record.yes_dollars_fp
      || record.no_dollars_fp
    ) {
      state.yesBids.clear();
      state.noBids.clear();
      for (const level of extractLevels(record, ["yes", "yes_bids", "yes_bid", "yes_levels", "yes_dollars", "yes_dollars_fp"])) {
        setBookLevel(state.yesBids, level.price, level.size);
      }
      for (const level of extractLevels(record, ["no", "no_bids", "no_bid", "no_levels", "no_dollars", "no_dollars_fp"])) {
        setBookLevel(state.noBids, level.price, level.size);
      }
    }

    if (type === "orderbook_delta" || record.delta || record.side) {
      const side = String(record.side ?? record.contract_side ?? record.outcome ?? "").toLowerCase();
      const price = normalizePrice(record.price ?? record.price_dollars ?? record.yes_price ?? record.no_price);
      const delta = numberOrNull(record.delta ?? record.delta_fp ?? record.size_delta ?? record.quantity_delta);
      const absoluteSize = normalizeSize(record.size ?? record.quantity ?? record.count);
      const book = side.includes("no") ? state.noBids : state.yesBids;
      const currentSize = price == null ? null : book.get(price) ?? 0;
      const nextSize = absoluteSize ?? (delta == null || currentSize == null ? null : currentSize + delta);
      setBookLevel(book, price, nextSize);
    }

    state.sequence = numberOrNull(record.seq ?? record.sequence ?? record.sid) ?? state.sequence;
    return this.snapshot(marketTicker, timestamp);
  }

  getSnapshot(marketTicker: string, timestamp = Date.now()): KalshiTickerSnapshot | null {
    if (!this.books.has(marketTicker)) return null;
    return this.snapshot(marketTicker, timestamp);
  }

  private getState(marketTicker: string): KalshiBookState {
    const existing = this.books.get(marketTicker);
    if (existing) return existing;
    const state = { yesBids: new Map<number, number>(), noBids: new Map<number, number>(), sequence: null };
    this.books.set(marketTicker, state);
    return state;
  }

  private snapshot(marketTicker: string, timestamp: number): KalshiTickerSnapshot {
    const state = this.getState(marketTicker);
    const yesBidLevels = levelsFromMap(state.yesBids);
    const noBidLevels = levelsFromMap(state.noBids);
    const yesAskLevels = askFromOppositeBids(noBidLevels);
    const noAskLevels = askFromOppositeBids(yesBidLevels);
    return {
      marketTicker,
      yesBid: bestBid(yesBidLevels),
      yesAsk: bestAsk(yesAskLevels),
      noBid: bestBid(noBidLevels),
      noAsk: bestAsk(noAskLevels),
      yesBidLevels,
      yesAskLevels,
      noBidLevels,
      noAskLevels,
      sequence: state.sequence,
      timestamp,
    };
  }
}

export class KalshiTickerClient {
  private readonly desired = new Set<string>();
  private readonly listeners = new Set<(snapshot: KalshiTickerSnapshot) => void>();
  private readonly latest = new Map<string, KalshiTickerSnapshot>();
  private readonly parser = new KalshiOrderbookParser();
  private socket: RawWebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private rateLimitBackoffUntil = 0;
  private rateLimitAttempts = 0;
  private messageId = 1;
  private intentionalClose = false;
  private subscriptionFingerprint = "";
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private readonly feedSilenceMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly url: string,
    private readonly wsFactory: WebSocketFactory = (wsUrl, options) => new WebSocket(wsUrl, options),
    options: KalshiTickerClientOptions = {},
  ) {
    // Feed-liveness watchdog: force a reconnect when the socket stays open but no orderbook update arrives
    // for this long (0 disables). The Kalshi market WS has no PING/keepalive, so a server that goes silent
    // without closing the socket would otherwise leave the book to age out undetected.
    this.feedSilenceMs = options.feedSilenceMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.now = options.now ?? (() => Date.now());
  }

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
    this.clearHeartbeat();
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
      this.lastMessageAt = this.now();
      this.subscriptionFingerprint = this.subscriptionFingerprintFor(this.desired);
      socket.send(JSON.stringify(buildKalshiSubscribeMessage(this.messageId++, this.desired)));
      this.startHeartbeat(socket);
      logEvent({ category: "KALSHI", message: "websocket subscribed", context: { subscriptions: this.desired.size } });
    });

    socket.on("message", (raw: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(raw.toString()) as { type?: string; msg?: unknown };
        const snapshot = this.parser.apply(payload.type, payload.msg);
        if (!snapshot) return;
        // A real orderbook snapshot proves the book feed is alive — reset the silence watchdog clock.
        this.lastMessageAt = this.now();
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
      this.clearHeartbeat();
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

  private startHeartbeat(socket: RawWebSocket): void {
    this.clearHeartbeat();
    // Watchdog disabled → no liveness interval needed (unlike Polymarket, the Kalshi interval has no PING
    // to keep alive, so it would otherwise be a pure no-op tick for the life of the connection).
    if (this.feedSilenceMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat();
        return;
      }
      // Feed-liveness watchdog: the Kalshi market socket can stay open while the server stops sending
      // orderbook updates. The close-driven reconnect never fires in that case, so detect the silence
      // here and force a reconnect (close → scheduleReconnect → fresh full subscribe).
      if (shouldForceFeedReconnect({
        now: this.now(),
        lastMessageAt: this.lastMessageAt,
        feedSilenceMs: this.feedSilenceMs,
        desiredSubscriptions: this.desired.size,
        socketOpen: socket.readyState === WebSocket.OPEN,
      })) {
        logThrottle("kalshi-ws-feed-silent", 30_000, {
          severity: "WARN",
          category: "KALSHI",
          message: "websocket feed silent, forcing reconnect",
          context: { silenceMs: this.now() - this.lastMessageAt, feedSilenceMs: this.feedSilenceMs, subscriptions: this.desired.size },
        });
        socket.close();
      }
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
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
