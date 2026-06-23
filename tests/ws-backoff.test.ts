import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { buildKalshiSubscribeMessage, KalshiOrderbookParser, KalshiTickerClient, parseKalshiTickerSnapshot } from "../src/kalshi/client";
import { buildKalshiUserStreamSubscribeMessage, parseKalshiUserStreamMessage } from "../src/kalshi/user-stream";
import {
  buildPolymarketSubscribeMessage,
  buildPolymarketSubscriptionUpdate,
  PolymarketBookClient,
  PolymarketBookParser,
  parsePolymarketBookSocketPayload,
} from "../src/polymarket/client";
import {
  buildPolymarketUserSubscribeMessage,
  parsePolymarketUserStreamPayload,
  parsePolymarketUserStreamSocketPayload,
  PolymarketUserStreamClient,
} from "../src/polymarket/user-stream";
import { computeRateLimitBackoffDelay, computeReconnectDelay, isRateLimitError, shouldForceFeedReconnect } from "../src/ws/reconnect";

test("websocket rate-limit and reconnect delays follow backoff policy", () => {
  assert.equal(isRateLimitError("Unexpected server response: 429"), true);
  assert.equal(computeRateLimitBackoffDelay(1), 15_000);
  assert.equal(computeRateLimitBackoffDelay(3), 60_000);
  assert.deepEqual(computeReconnectDelay({ attempt: 1, now: 1_000 }), { delayMs: 1_000, reason: "socket_retry" });
  assert.deepEqual(
    computeReconnectDelay({ attempt: 1, now: 1_000, rateLimitBackoffUntil: 31_000 }),
    { delayMs: 30_000, reason: "rate_limited" },
  );
});

test("subscription messages are deterministic for reconnect resubscription", () => {
  assert.deepEqual(buildKalshiSubscribeMessage(7, ["B", "A"]), {
    id: 7,
    cmd: "subscribe",
    params: { channels: ["orderbook_delta"], market_tickers: ["A", "B"] },
  });
  assert.deepEqual(buildPolymarketSubscribeMessage(["token-b", "token-a"]), {
    type: "market",
    assets_ids: ["token-a", "token-b"],
    custom_feature_enabled: true,
  });
  assert.deepEqual(buildPolymarketSubscriptionUpdate("subscribe", ["token-b", "token-a"]), {
    operation: "subscribe",
    assets_ids: ["token-a", "token-b"],
    custom_feature_enabled: true,
  });
  assert.deepEqual(buildPolymarketSubscriptionUpdate("unsubscribe", ["token-b", "token-a"]), {
    operation: "unsubscribe",
    assets_ids: ["token-a", "token-b"],
  });
  assert.deepEqual(buildKalshiUserStreamSubscribeMessage(9, ["KXBTC-B", "KXBTC-A"]), {
    id: 9,
    cmd: "subscribe",
    params: { channels: ["user_orders", "fill"], market_tickers: ["KXBTC-A", "KXBTC-B"] },
  });
  assert.deepEqual(buildPolymarketUserSubscribeMessage({
    key: "key",
    secret: "secret",
    passphrase: "passphrase",
  }, ["condition-b", "condition-a"]), {
    auth: { apiKey: "key", secret: "secret", passphrase: "passphrase" },
    markets: ["condition-a", "condition-b"],
    type: "user",
  });
});

test("Kalshi and Polymarket parsers expose best asks from websocket payloads", () => {
  const kalshi = parseKalshiTickerSnapshot({
    market_ticker: "KXBTC15M",
    yes_bid_dollars: "0.39",
    yes_ask_dollars: "0.40",
    no_bid_dollars: "0.59",
    no_ask_dollars: "0.60",
  }, 123);
  assert.equal(kalshi?.yesAsk, 0.4);
  assert.equal(kalshi?.noAsk, 0.6);

  const parser = new PolymarketBookParser();
  const [poly] = parser.apply({
    event_type: "book",
    asset_id: "token",
    bids: [{ price: "0.39", size: "10" }],
    asks: [{ price: "0.41", size: "7" }, { price: "0.40", size: "3" }],
  }, 123);
  assert.equal(poly.bestAsk, 0.4);
  assert.equal(poly.bestBid, 0.39);

  const [change] = parser.apply({
    event_type: "price_change",
    price_changes: [{
      asset_id: "token",
      side: "SELL",
      price: "0.38",
      size: "5",
      best_bid: "0.39",
      best_ask: "0.38",
    }],
  }, 124);
  assert.equal(change.bestAsk, 0.38);
  assert.equal(change.bestBid, 0.39);

  const [best] = parser.apply({
    event_type: "best_bid_ask",
    asset_id: "token",
    best_bid: "0.42",
    best_ask: "0.43",
  }, 125);
  assert.equal(best.bestAsk, 0.43);
  assert.equal(best.bestBid, 0.42);
});

test("Kalshi orderbook parser handles current dollars_fp snapshot and delta frames", () => {
  const parser = new KalshiOrderbookParser();
  const snapshot = parser.apply("orderbook_snapshot", {
    market_ticker: "KXBTC15M",
    yes_dollars_fp: [["0.3900", "10.00"], ["0.3800", "4.00"]],
    no_dollars_fp: [["0.6100", "7.00"], ["0.6000", "6.00"]],
  }, 1_800_000_000_000);

  assert.equal(snapshot?.yesBid, 0.39);
  assert.equal(snapshot?.yesAsk, 0.39);
  assert.equal(snapshot?.noBid, 0.61);
  assert.equal(snapshot?.noAsk, 0.61);
  assert.deepEqual(snapshot?.yesAskLevels?.[0], { price: 0.39, size: 7 });
  assert.deepEqual(snapshot?.noAskLevels?.[0], { price: 0.61, size: 10 });

  const delta = parser.apply("orderbook_delta", {
    market_ticker: "KXBTC15M",
    side: "yes",
    price_dollars: "0.4000",
    delta_fp: "5.00",
  }, 1_800_000_000_100);

  assert.equal(delta?.yesBid, 0.4);
  assert.deepEqual(delta?.noAskLevels?.[0], { price: 0.6, size: 5 });
});

test("Kalshi orderbook parser prunes dust sizes and consolidates float-noise prices (bounded book)", () => {
  const parser = new KalshiOrderbookParser();
  const snapshot = parser.apply("orderbook_snapshot", {
    market_ticker: "KXBTC15M",
    // 0.39 and 0.39000001 must collapse to ONE price key; the 0.38 femto-share dust level must be dropped.
    yes_dollars_fp: [["0.3900", "10.00"], ["0.39000001", "4.00"], ["0.3800", "0.00000000005"]],
    no_dollars_fp: [["0.6100", "7.00"]],
  }, 1_800_000_000_000);

  assert.equal(snapshot?.yesBidLevels?.length, 1, "float-noise prices consolidate; dust level dropped");
  assert.equal(snapshot?.yesBidLevels?.[0].price, 0.39);
  const allLevels = [
    ...(snapshot?.yesBidLevels ?? []),
    ...(snapshot?.noBidLevels ?? []),
    ...(snapshot?.yesAskLevels ?? []),
    ...(snapshot?.noAskLevels ?? []),
  ];
  assert.ok(allLevels.length > 0 && allLevels.every((l) => l.size >= 1e-6), "no dust levels survive");

  // A delta that drives a level's size down to dust residue must DELETE it, not leave a phantom level.
  parser.apply("orderbook_snapshot", { market_ticker: "KX2", yes_dollars_fp: [["0.4000", "5.00"]] }, 1_800_000_000_000);
  const drained = parser.apply("orderbook_delta", {
    market_ticker: "KX2",
    side: "yes",
    price_dollars: "0.4000",
    delta_fp: "-4.9999999", // 5 - 4.9999999 = 1e-7 < dust epsilon → level removed
  }, 1_800_000_000_100);
  assert.equal(drained?.yesBidLevels?.length, 0, "dust residue from a delta is pruned, not kept");
});

test("Polymarket CLOB websocket parser ignores heartbeat text frames", () => {
  assert.equal(parsePolymarketBookSocketPayload(Buffer.from("PONG")), null);
  assert.equal(parsePolymarketBookSocketPayload(Buffer.from("PING")), null);
  assert.equal(parsePolymarketBookSocketPayload(Buffer.from(" pong \n")), null);
  assert.deepEqual(parsePolymarketBookSocketPayload(Buffer.from('{"event_type":"best_bid_ask","asset_id":"token","best_ask":"0.45"}')), {
    event_type: "best_bid_ask",
    asset_id: "token",
    best_ask: "0.45",
  });
});

test("Polymarket user websocket parser ignores benign text control frames", () => {
  assert.equal(parsePolymarketUserStreamSocketPayload(Buffer.from("PONG")), null);
  assert.equal(parsePolymarketUserStreamSocketPayload(Buffer.from("PING")), null);
  assert.equal(parsePolymarketUserStreamSocketPayload(Buffer.from("NO NEW MARKETS")), null);
  assert.throws(
    () => parsePolymarketUserStreamSocketPayload(Buffer.from("INVALID OPERATION")),
    /Unexpected token/,
  );
});

test("Polymarket user stream does not re-auth unchanged open subscriptions", async () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const sent: string[] = [];
  const socket = {
    readyState: 0,
    on(event: string, callback: (...args: any[]) => void) {
      handlers.set(event, callback);
    },
    send(payload: string) {
      sent.push(payload);
    },
    close() {
      socket.readyState = 3;
      handlers.get("close")?.(1000, Buffer.alloc(0));
    },
  };

  const client = new PolymarketUserStreamClient(
    "wss://example.invalid",
    { recordEvent: async () => {} } as unknown as ConstructorParameters<typeof PolymarketUserStreamClient>[1],
    async () => ({ key: "key", secret: "secret", passphrase: "passphrase" }),
    () => socket as unknown as ReturnType<NonNullable<ConstructorParameters<typeof PolymarketUserStreamClient>[3]>>,
  );

  client.setSubscriptions(["condition-a"]);
  socket.readyState = 1;
  handlers.get("open")?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);

  client.setSubscriptions(["condition-a"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);

  client.close();
});

test("authenticated user stream parsers normalize venue order events", () => {
  const kalshiOrder = parseKalshiUserStreamMessage({
    type: "user_order",
    sid: 22,
    msg: {
      order_id: "kalshi-order",
      client_order_id: "kalshi-client",
      ticker: "KXBTC15M",
      status: "executed",
      side: "yes",
      yes_price_dollars: "0.3500",
      fill_count_fp: "5.00",
      remaining_count_fp: "0.00",
      created_ts_ms: 1_800_000_000_123,
    },
  }, 1_800_000_000_200);
  assert.equal(kalshiOrder?.venue, "kalshi");
  assert.equal(kalshiOrder?.eventType, "user_order");
  assert.equal(kalshiOrder?.clientOrderId, "kalshi-client");
  assert.equal(kalshiOrder?.fillCount, 5);
  assert.equal(kalshiOrder?.fillPrice, 0.35);

  const kalshiNoAskOrder = parseKalshiUserStreamMessage({
    type: "user_order",
    sid: 24,
    msg: {
      order_id: "kalshi-no-order",
      client_order_id: "kalshi-no-client",
      ticker: "KXBTC15M",
      status: "executed",
      side: "ask",
      is_yes: false,
      yes_price_dollars: "0.5400",
      fill_count_fp: "5.00",
      remaining_count_fp: "0.00",
      created_ts_ms: 1_800_000_000_223,
    },
  }, 1_800_000_000_250);
  assert.equal(kalshiNoAskOrder?.fillPrice, 0.46);

  const kalshiFill = parseKalshiUserStreamMessage({
    type: "fill",
    sid: 23,
    msg: {
      order_id: "kalshi-order",
      market_ticker: "KXBTC15M",
      purchased_side: "no",
      yes_price_dollars: "0.81",
      count_fp: "5.00",
      ts_ms: 1_800_000_000_300,
    },
  }, 1_800_000_000_350);
  assert.equal(kalshiFill?.status, "filled");
  assert.equal(kalshiFill?.fillPrice, 0.19);

  const [polyTrade, polyOrder] = parsePolymarketUserStreamPayload([
    {
      event_type: "trade",
      asset_id: "yes-token",
      market: "condition",
      status: "MATCHED",
      taker_order_id: "poly-order",
      side: "BUY",
      size: "5",
      price: "0.91",
      timestamp: "1800000000",
    },
    {
      event_type: "order",
      id: "poly-order",
      asset_id: "yes-token",
      market: "condition",
      type: "UPDATE",
      original_size: "5",
      size_matched: "5",
      price: "0.91",
      side: "BUY",
      timestamp: "1800000001",
    },
  ], 1_800_000_001_100);
  assert.equal(polyTrade.venue, "polymarket");
  assert.equal(polyTrade.eventType, "trade");
  assert.equal(polyTrade.status, "matched");
  assert.equal(polyTrade.fillCount, 5);
  assert.equal(polyTrade.fillPrice, 0.91);
  assert.equal(polyOrder.status, "matched");
  assert.equal(polyOrder.remainingCount, 0);
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The book clients' socket factory expects a `ws` RawWebSocket (a Pick of the real WebSocket type,
// with its overloaded typed `on`). FakeBookSocket is a deliberately-loose test double, so its return
// is cast to each client's actual factory-return type at the call site.
type PolymarketSocketFactoryReturn = ReturnType<NonNullable<ConstructorParameters<typeof PolymarketBookClient>[1]>>;
type KalshiSocketFactoryReturn = ReturnType<NonNullable<ConstructorParameters<typeof KalshiTickerClient>[1]>>;

class FakeBookSocket {
  readyState = 1; // WebSocket.OPEN
  sent: string[] = [];
  closeCount = 0;
  private readonly handlers = new Map<string, (...args: unknown[]) => void>();
  on(event: string, cb: (...args: unknown[]) => void): void { this.handlers.set(event, cb); }
  send(data: unknown): void { this.sent.push(String(data)); }
  close(): void {
    this.closeCount += 1;
    this.readyState = 3; // CLOSED
    this.handlers.get("close")?.(1006, Buffer.from(""));
  }
  fire(event: string, ...args: unknown[]): void { this.handlers.get(event)?.(...args); }
}

test("shouldForceFeedReconnect fires only on an open, subscribed, silent feed", () => {
  const base = { now: 100_000, lastMessageAt: 0, feedSilenceMs: 30_000, desiredSubscriptions: 2, socketOpen: true };
  assert.equal(shouldForceFeedReconnect(base), true, "open + subscribed + silent beyond threshold -> reconnect");
  assert.equal(shouldForceFeedReconnect({ ...base, lastMessageAt: 80_000 }), false, "20s silence < 30s threshold -> stay");
  assert.equal(shouldForceFeedReconnect({ ...base, lastMessageAt: 70_000 }), false, "exactly at threshold (not strictly greater) -> stay");
  assert.equal(shouldForceFeedReconnect({ ...base, feedSilenceMs: 0 }), false, "watchdog disabled -> never reconnect");
  assert.equal(shouldForceFeedReconnect({ ...base, socketOpen: false }), false, "closed socket handled by close-driven reconnect, not this");
  assert.equal(shouldForceFeedReconnect({ ...base, desiredSubscriptions: 0 }), false, "nothing subscribed -> not a silent-feed condition");
});

test("PolymarketBookClient forces a reconnect when the open book feed goes silent", async () => {
  let clock = 0;
  const sockets: FakeBookSocket[] = [];
  const client = new PolymarketBookClient("wss://x", () => {
    const s = new FakeBookSocket();
    sockets.push(s);
    return s as unknown as PolymarketSocketFactoryReturn;
  }, { feedSilenceMs: 100, heartbeatIntervalMs: 5, now: () => clock });

  client.setSubscriptions(["token-a"]);
  const first = sockets[0];
  first.fire("open"); // lastMessageAt = now() = 0, full subscribe sent, heartbeat started
  clock = 1_000; // 1000ms of silence, well beyond the 100ms threshold
  await delay(40); // let the 5ms heartbeat tick run

  assert.ok(first.closeCount >= 1, "a silent feed forced the socket closed (which triggers a fresh reconnect+resubscribe)");
  client.close();
});

test("PolymarketBookClient keeps a live feed connected and pings it (no false reconnect)", async () => {
  let clock = 0;
  const sockets: FakeBookSocket[] = [];
  const client = new PolymarketBookClient("wss://x", () => {
    const s = new FakeBookSocket();
    sockets.push(s);
    return s as unknown as PolymarketSocketFactoryReturn;
  }, { feedSilenceMs: 100, heartbeatIntervalMs: 5, now: () => clock });

  client.setSubscriptions(["token-a"]);
  const sock = sockets[0];
  sock.fire("open"); // lastMessageAt = 0
  clock = 80; // still inside the 100ms window
  // A real book payload MUST reset the silence clock to 80 (load-bearing): at clock=160 the silence-since-
  // message is 80ms (< 100, alive), but silence-since-open is 160ms, so a broken reset would force-close.
  sock.fire("message", Buffer.from(JSON.stringify({
    event_type: "book",
    asset_id: "token-a",
    bids: [{ price: "0.39", size: "10" }],
    asks: [{ price: "0.41", size: "7" }],
  })));
  clock = 160;
  await delay(40);

  assert.equal(sock.closeCount, 0, "a live feed is never force-closed");
  assert.ok(sock.sent.some((m) => m === "PING"), "heartbeat still pings a healthy socket");
  client.close();
});

// Kalshi market-data WS auth (getKalshiWebsocketHeaders) requires a signing key; set test creds around
// any client that opens a socket.
const kalshiTestKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
function withKalshiTestEnv<T>(fn: () => T): T {
  const prev = {
    id: process.env.KALSHI_API_KEY_ID,
    pk: process.env.KALSHI_PRIVATE_KEY,
    b64: process.env.KALSHI_PRIVATE_KEY_B64,
  };
  process.env.KALSHI_API_KEY_ID = "test-key";
  process.env.KALSHI_PRIVATE_KEY = kalshiTestKeyPem;
  delete process.env.KALSHI_PRIVATE_KEY_B64;
  try {
    return fn();
  } finally {
    if (prev.id == null) delete process.env.KALSHI_API_KEY_ID; else process.env.KALSHI_API_KEY_ID = prev.id;
    if (prev.pk == null) delete process.env.KALSHI_PRIVATE_KEY; else process.env.KALSHI_PRIVATE_KEY = prev.pk;
    if (prev.b64 == null) delete process.env.KALSHI_PRIVATE_KEY_B64; else process.env.KALSHI_PRIVATE_KEY_B64 = prev.b64;
  }
}

test("KalshiTickerClient forces a reconnect when the open orderbook feed goes silent", async () => {
  const { client, first } = withKalshiTestEnv(() => {
    let clockRef = { v: 0 };
    const sockets: FakeBookSocket[] = [];
    const c = new KalshiTickerClient("wss://x", () => {
      const s = new FakeBookSocket();
      sockets.push(s);
      return s as unknown as KalshiSocketFactoryReturn;
    }, { feedSilenceMs: 100, heartbeatIntervalMs: 5, now: () => clockRef.v });
    c.setSubscriptions(["KXBTC15M"]);
    const f = sockets[0];
    f.fire("open"); // lastMessageAt = 0, subscribe sent, heartbeat started
    clockRef.v = 1_000; // 1000ms silence > 100ms threshold
    return { client: c, first: f };
  });
  await delay(40); // let the 5ms heartbeat tick run
  assert.ok(first.closeCount >= 1, "a silent Kalshi orderbook feed forced the socket closed (triggers reconnect+resubscribe)");
  client.close();
});

test("KalshiTickerClient keeps a live orderbook feed connected (no false reconnect)", async () => {
  const { client, sock } = withKalshiTestEnv(() => {
    const clockRef = { v: 0 };
    const sockets: FakeBookSocket[] = [];
    const c = new KalshiTickerClient("wss://x", () => {
      const s = new FakeBookSocket();
      sockets.push(s);
      return s as unknown as KalshiSocketFactoryReturn;
    }, { feedSilenceMs: 100, heartbeatIntervalMs: 5, now: () => clockRef.v });
    c.setSubscriptions(["KXBTC15M"]);
    const s = sockets[0];
    s.fire("open"); // lastMessageAt = 0
    clockRef.v = 80; // still inside the 100ms window
    // A real orderbook snapshot MUST reset the silence clock to 80. This is load-bearing: at clock=160 below
    // the silence-since-snapshot is 80ms (< 100, alive), but silence-since-open is 160ms — so a broken reset
    // would force-close and fail this test.
    s.fire("message", Buffer.from(JSON.stringify({
      type: "orderbook_snapshot",
      msg: { market_ticker: "KXBTC15M", yes_dollars_fp: [["0.3900", "10.00"]], no_dollars_fp: [["0.6100", "7.00"]] },
    })));
    clockRef.v = 160;
    return { client: c, sock: s };
  });
  await delay(40);
  assert.equal(sock.closeCount, 0, "a live Kalshi feed is never force-closed");
  client.close();
});
