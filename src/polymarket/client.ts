import WebSocket from "ws";
import { z } from "zod";
import { logEvent } from "../logger";
import type { BookLevel } from "../types";
import { isRateLimitError } from "../ws/reconnect";
import {
  ReconnectingWebSocketClient,
  type RawWebSocket,
  type ReconnectingWebSocketClientOptions,
} from "../ws/reconnecting-websocket-client";

type WebSocketFactory = (url: string) => RawWebSocket;

export interface PolymarketBookClientOptions {
  /** Force a reconnect if the open socket receives no book message for this long (ms); 0 disables. */
  feedSilenceMs?: number;
  /** Heartbeat + feed-liveness check cadence (ms). */
  heartbeatIntervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface TokenBookSnapshot {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  bidLevels: BookLevel[];
  askLevels: BookLevel[];
  hash?: string | null;
  tickSize?: number | null;
  tickSizeChangedAt?: number | null;
  timestamp: number;
}

interface BookLevels {
  bids: Map<number, number>;
  asks: Map<number, number>;
  bestBidOverride: number | null;
  bestAskOverride: number | null;
  hash: string | null;
  tickSize: number | null;
  tickSizeChangedAt: number | null;
}

const PriceLevelSchema = z.object({
  price: z.union([z.string(), z.number()]),
  size: z.union([z.string(), z.number()]),
});

const PriceChangeSchema = z.object({
  asset_id: z.string(),
  side: z.string().optional(),
  price: z.union([z.string(), z.number()]).optional(),
  size: z.union([z.string(), z.number()]).optional(),
  best_bid: z.union([z.string(), z.number()]).optional(),
  best_ask: z.union([z.string(), z.number()]).optional(),
});

const BookMessageSchema = z.object({
  event_type: z.string().optional(),
  asset_id: z.string().optional(),
  market: z.string().optional(),
  best_bid: z.union([z.string(), z.number()]).optional(),
  best_ask: z.union([z.string(), z.number()]).optional(),
  hash: z.string().optional(),
  tick_size: z.union([z.string(), z.number()]).optional(),
  bids: z.array(PriceLevelSchema).optional(),
  asks: z.array(PriceLevelSchema).optional(),
  changes: z.array(PriceChangeSchema).optional(),
  price_changes: z.array(PriceChangeSchema).optional(),
});

function toNumber(value: string | number): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function setLevel(levels: Map<number, number>, priceRaw: string | number, sizeRaw: string | number): void {
  const price = toNumber(priceRaw);
  const size = toNumber(sizeRaw);
  if (price == null || size == null) return;
  if (size <= 0) levels.delete(price);
  else levels.set(price, size);
}

function bestBid(levels: Map<number, number>): number | null {
  let best: number | null = null;
  for (const [price, size] of levels) {
    if (size <= 0) continue;
    if (best == null || price > best) best = price;
  }
  return best;
}

function bestAsk(levels: Map<number, number>): number | null {
  let best: number | null = null;
  for (const [price, size] of levels) {
    if (size <= 0) continue;
    if (best == null || price < best) best = price;
  }
  return best;
}

function sortedLevels(levels: Map<number, number>, side: "bid" | "ask"): BookLevel[] {
  return [...levels]
    .filter(([, size]) => size > 0)
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
}

export function buildPolymarketSubscribeMessage(tokenIds: Iterable<string>): Record<string, unknown> {
  return {
    type: "market",
    assets_ids: [...tokenIds].sort(),
    custom_feature_enabled: true,
  };
}

export function buildPolymarketSubscriptionUpdate(
  operation: "subscribe" | "unsubscribe",
  tokenIds: Iterable<string>,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    operation,
    assets_ids: [...tokenIds].sort(),
  };
  if (operation === "subscribe") message.custom_feature_enabled = true;
  return message;
}

export function parsePolymarketBookSocketPayload(raw: WebSocket.RawData): unknown | null {
  const text = raw.toString().trim();
  if (!text) return null;
  const heartbeat = text.toUpperCase();
  if (heartbeat === "PING" || heartbeat === "PONG") return null;
  return JSON.parse(text);
}

export class PolymarketBookParser {
  private readonly books = new Map<string, BookLevels>();

  apply(raw: unknown, timestamp = Date.now()): TokenBookSnapshot[] {
    const messages = Array.isArray(raw) ? raw : [raw];
    const snapshots: TokenBookSnapshot[] = [];

    for (const message of messages) {
      const parsed = BookMessageSchema.safeParse(message);
      if (!parsed.success) continue;
      const eventType = parsed.data.event_type ?? "";

      if (eventType === "book" && parsed.data.asset_id) {
        const book = this.getBook(parsed.data.asset_id);
        book.bids.clear();
        book.asks.clear();
        book.bestBidOverride = null;
        book.bestAskOverride = null;
        this.applyMetadata(book, parsed.data, timestamp);
        for (const bid of parsed.data.bids ?? []) setLevel(book.bids, bid.price, bid.size);
        for (const ask of parsed.data.asks ?? []) setLevel(book.asks, ask.price, ask.size);
        snapshots.push(this.snapshot(parsed.data.asset_id, timestamp));
      }

      if (eventType === "price_change") {
        const priceChanges = parsed.data.price_changes ?? parsed.data.changes ?? [];
        for (const change of priceChanges) {
          const book = this.getBook(change.asset_id);
          const side = change.side?.toUpperCase() ?? "";
          if (change.price != null && change.size != null) {
            if (side === "BUY" || side === "BID") setLevel(book.bids, change.price, change.size);
            if (side === "SELL" || side === "ASK") setLevel(book.asks, change.price, change.size);
          }
          if (change.best_bid != null) book.bestBidOverride = toNumber(change.best_bid);
          else if (side === "BUY" || side === "BID") book.bestBidOverride = null;
          if (change.best_ask != null) book.bestAskOverride = toNumber(change.best_ask);
          else if (side === "SELL" || side === "ASK") book.bestAskOverride = null;
          snapshots.push(this.snapshot(change.asset_id, timestamp));
        }
      }

      if (eventType === "best_bid_ask" && parsed.data.asset_id) {
        const book = this.getBook(parsed.data.asset_id);
        this.applyMetadata(book, parsed.data, timestamp);
        if (parsed.data.best_bid != null) book.bestBidOverride = toNumber(parsed.data.best_bid);
        if (parsed.data.best_ask != null) book.bestAskOverride = toNumber(parsed.data.best_ask);
        snapshots.push(this.snapshot(parsed.data.asset_id, timestamp));
      }
    }

    return snapshots;
  }

  getSnapshot(tokenId: string, timestamp = Date.now()): TokenBookSnapshot | null {
    if (!this.books.has(tokenId)) return null;
    return this.snapshot(tokenId, timestamp);
  }

  private getBook(tokenId: string): BookLevels {
    const existing = this.books.get(tokenId);
    if (existing) return existing;
    const book = {
      bids: new Map<number, number>(),
      asks: new Map<number, number>(),
      bestBidOverride: null,
      bestAskOverride: null,
      hash: null,
      tickSize: null,
      tickSizeChangedAt: null,
    };
    this.books.set(tokenId, book);
    return book;
  }

  private applyMetadata(
    book: BookLevels,
    data: { hash?: string; tick_size?: string | number },
    timestamp: number,
  ): void {
    if (data.hash) book.hash = data.hash;
    if (data.tick_size != null) {
      const tickSize = toNumber(data.tick_size);
      if (tickSize != null && book.tickSize != null && book.tickSize !== tickSize) book.tickSizeChangedAt = timestamp;
      if (tickSize != null) book.tickSize = tickSize;
    }
  }

  private snapshot(tokenId: string, timestamp: number): TokenBookSnapshot {
    const book = this.getBook(tokenId);
    const bidLevels = sortedLevels(book.bids, "bid");
    const askLevels = sortedLevels(book.asks, "ask");
    return {
      tokenId,
      bestBid: book.bestBidOverride ?? bestBid(book.bids),
      bestAsk: book.bestAskOverride ?? bestAsk(book.asks),
      bidLevels,
      askLevels,
      hash: book.hash,
      tickSize: book.tickSize,
      tickSizeChangedAt: book.tickSizeChangedAt,
      timestamp,
    };
  }
}

export class PolymarketBookClient extends ReconnectingWebSocketClient {
  private readonly listeners = new Set<(snapshot: TokenBookSnapshot) => void>();
  private readonly parser = new PolymarketBookParser();
  private readonly subscribed = new Set<string>();
  protected readonly sendsPing = true; // Polymarket CLOB needs a periodic PING keepalive.

  constructor(
    private readonly url: string,
    private readonly wsFactory: WebSocketFactory = (wsUrl) => new WebSocket(wsUrl),
    options: PolymarketBookClientOptions = {},
  ) {
    // Feed-liveness watchdog (in the base): force a reconnect when the socket stays open but no book message
    // arrives for feedSilenceMs (0 disables). A reconnect re-sends a full subscribe, recovering a silently-dead
    // feed that the close-driven reconnect path cannot detect on its own.
    super("POLYMARKET", "poly-ws", options);
  }

  onSnapshot(listener: (snapshot: TokenBookSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSubscriptions(tokenIds: Iterable<string>): void {
    const previous = new Set(this.desired);
    this.desired.clear();
    for (const tokenId of tokenIds) this.desired.add(tokenId);
    if (this.desired.size === 0) {
      this.close();
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.applySubscriptionDelta(previous, this.desired);
      return;
    }
    this.ensureSocket();
  }

  protected createSocket(): RawWebSocket | null {
    logEvent({
      category: "POLYMARKET",
      message: "websocket connecting",
      context: { subscriptions: this.desired.size },
    });
    return this.wsFactory(this.url);
  }

  protected onOpen(socket: RawWebSocket): void {
    socket.send(JSON.stringify(buildPolymarketSubscribeMessage(this.desired)));
    this.subscribed.clear();
    for (const tokenId of this.desired) this.subscribed.add(tokenId);
  }

  protected handleMessage(raw: WebSocket.RawData): void {
    const payload = parsePolymarketBookSocketPayload(raw);
    if (payload == null) return;
    const snapshots = this.parser.apply(payload);
    // Reset the silence watchdog only on real book data (a `book` snapshot or a `price_change` both yield
    // snapshots) — not on bare acks/keepalives — so a feed that delivers everything except book deltas is
    // still detected as silent.
    if (snapshots.length > 0) this.lastMessageAt = this.now();
    for (const snapshot of snapshots) {
      if (!this.desired.has(snapshot.tokenId)) continue;
      for (const listener of this.listeners) listener(snapshot);
    }
  }

  protected sendHeartbeat(socket: RawWebSocket): void {
    try {
      socket.send("PING");
    } catch (error) {
      logEvent({
        severity: "ERROR",
        category: "POLYMARKET",
        message: "websocket heartbeat failed",
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  protected resetSubscriptionState(): void {
    this.subscribed.clear();
  }

  protected reconnectRateLimitBackoffUntil(reasonText: string): number {
    return isRateLimitError(reasonText) ? Date.now() + 15_000 : 0;
  }

  private applySubscriptionDelta(previous: Set<string>, next: Set<string>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const added = [...next].filter((tokenId) => !previous.has(tokenId));
    const removed = [...previous].filter((tokenId) => !next.has(tokenId));
    if (added.length > 0) {
      this.socket.send(JSON.stringify(buildPolymarketSubscriptionUpdate("subscribe", added)));
      for (const tokenId of added) this.subscribed.add(tokenId);
    }
    if (removed.length > 0) {
      this.socket.send(JSON.stringify(buildPolymarketSubscriptionUpdate("unsubscribe", removed)));
      for (const tokenId of removed) this.subscribed.delete(tokenId);
    }
    if (added.length > 0 || removed.length > 0) {
      logEvent({
        category: "POLYMARKET",
        message: "websocket subscription refreshed",
        context: { subscriptions: next.size },
      });
    }
  }
}
