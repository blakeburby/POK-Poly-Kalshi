import test from "node:test";
import assert from "node:assert/strict";
import { buildKalshiSubscribeMessage, KalshiOrderbookParser, parseKalshiTickerSnapshot } from "../src/kalshi/client";
import { buildKalshiUserStreamSubscribeMessage, parseKalshiUserStreamMessage } from "../src/kalshi/user-stream";
import {
  buildPolymarketSubscribeMessage,
  buildPolymarketSubscriptionUpdate,
  PolymarketBookParser,
  parsePolymarketBookSocketPayload,
} from "../src/polymarket/client";
import { buildPolymarketUserSubscribeMessage, parsePolymarketUserStreamPayload, parsePolymarketUserStreamSocketPayload } from "../src/polymarket/user-stream";
import { computeRateLimitBackoffDelay, computeReconnectDelay, isRateLimitError } from "../src/ws/reconnect";

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
