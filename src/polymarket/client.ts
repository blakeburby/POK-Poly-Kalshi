import WebSocket from "ws";
import { z } from "zod";
import { logEvent, logThrottle } from "../logger";
import { computeReconnectDelay, isRateLimitError } from "../ws/reconnect";

type RawWebSocket = Pick<WebSocket, "on" | "send" | "close" | "readyState">;
type WebSocketFactory = (url: string) => RawWebSocket;

export interface TokenBookSnapshot {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  timestamp: number;
}

interface BookLevels {
  bids: Map<number, number>;
  asks: Map<number, number>;
  bestBidOverride: number | null;
  bestAskOverride: number | null;
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
    };
    this.books.set(tokenId, book);
    return book;
  }

  private snapshot(tokenId: string, timestamp: number): TokenBookSnapshot {
    const book = this.getBook(tokenId);
    return {
      tokenId,
      bestBid: book.bestBidOverride ?? bestBid(book.bids),
      bestAsk: book.bestAskOverride ?? bestAsk(book.asks),
      timestamp,
    };
  }
}

export class PolymarketBookClient {
  private readonly desired = new Set<string>();
  private readonly listeners = new Set<(snapshot: TokenBookSnapshot) => void>();
  private readonly parser = new PolymarketBookParser();
  private socket: RawWebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly subscribed = new Set<string>();
  private reconnectAttempts = 0;
  private intentionalClose = false;

  constructor(
    private readonly url: string,
    private readonly wsFactory: WebSocketFactory = (wsUrl) => new WebSocket(wsUrl),
  ) {}

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

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    this.subscribed.clear();
    this.socket?.close();
    this.socket = null;
  }

  private ensureSocket(): void {
    if (this.desired.size === 0) {
      this.close();
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    logEvent({ category: "POLYMARKET", message: "websocket connecting", context: { subscriptions: this.desired.size } });
    const socket = this.wsFactory(this.url);
    this.socket = socket;
    this.intentionalClose = false;

    socket.on("open", () => {
      this.reconnectAttempts = 0;
      socket.send(JSON.stringify(buildPolymarketSubscribeMessage(this.desired)));
      this.subscribed.clear();
      for (const tokenId of this.desired) this.subscribed.add(tokenId);
      this.startHeartbeat(socket);
      logEvent({ category: "POLYMARKET", message: "websocket subscribed", context: { subscriptions: this.desired.size } });
    });

    socket.on("message", (raw: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(raw.toString());
        const snapshots = this.parser.apply(payload);
        for (const snapshot of snapshots) {
          if (!this.desired.has(snapshot.tokenId)) continue;
          for (const listener of this.listeners) listener(snapshot);
        }
      } catch (error) {
        logEvent({
          severity: "ERROR",
          category: "POLYMARKET",
          message: "websocket parse error",
          context: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    });

    socket.on("error", (error: Error) => {
      logEvent({ severity: "ERROR", category: "POLYMARKET", message: "websocket error", context: { error: error.message } });
    });

    socket.on("close", (_code: number, reason: Buffer) => {
      this.socket = null;
      this.clearHeartbeat();
      this.subscribed.clear();
      if (!this.intentionalClose) this.scheduleReconnect(reason.toString());
    });
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
      logEvent({ category: "POLYMARKET", message: "websocket subscription refreshed", context: { subscriptions: next.size } });
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
          category: "POLYMARKET",
          message: "websocket heartbeat failed",
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
    if (this.reconnectTimer || this.desired.size === 0) return;
    this.reconnectAttempts += 1;
    const rateLimitBackoffUntil = isRateLimitError(reasonText) ? Date.now() + 15_000 : 0;
    const { delayMs, reason } = computeReconnectDelay({
      attempt: this.reconnectAttempts,
      now: Date.now(),
      rateLimitBackoffUntil,
    });
    logThrottle(`poly-ws-reconnect:${reason}`, 10_000, {
      severity: "WARN",
      category: "POLYMARKET",
      message: "websocket reconnect scheduled",
      context: { delayMs, reason, attempt: this.reconnectAttempts },
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delayMs);
  }
}
