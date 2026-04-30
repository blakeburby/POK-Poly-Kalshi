import test from "node:test";
import assert from "node:assert/strict";
import { buildKalshiSubscribeMessage, parseKalshiTickerSnapshot } from "../src/kalshi/client";
import {
  buildPolymarketSubscribeMessage,
  buildPolymarketSubscriptionUpdate,
  PolymarketBookParser,
} from "../src/polymarket/client";
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
    params: { channels: ["ticker"], market_tickers: ["A", "B"] },
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
