import test from "node:test";
import assert from "node:assert/strict";
import { TradingActivityStore, tradingActivityEventFromVenueEvent } from "../src/trading/activity";
import type { LiveExecutionReadiness } from "../src/types";

const now = 1_800_000_000_000;

function readiness(): LiveExecutionReadiness {
  return {
    mode: "live",
    liveTrading: true,
    protectedOnly: true,
    orderSize: 5,
    orderType: "FOK",
    minExpiryMs: 60_000,
    maxTradesPerWindow: 1,
    collateralBufferDollars: 0.25,
    quoteMaxAgeMs: 750,
    quoteSyncMaxSkewMs: 250,
    minBookDepthShares: 5,
    orderTimeoutMs: 2_500,
    kalshiOrderGroupEnabled: false,
    userStreams: {
      enabled: true,
      ready: true,
      reason: null,
      confirmTimeoutMs: 2_500,
      kalshi: { enabled: true, connected: true, subscribed: true, reason: null, lastConnectedAt: now, lastEventAt: now, lastError: null },
      polymarket: { enabled: true, connected: true, subscribed: true, reason: null, lastConnectedAt: now, lastEventAt: now, lastError: null },
      lastUserStreamEventAt: now,
      confirmationLagMs: 10,
    },
    reconciliation: { enabled: true, clean: true, reason: null, checkedAt: now, lastReconciliationAt: now },
    riskState: "trading",
    riskStateReason: null,
    partialFillLocked: false,
    circuitBreakerLocked: false,
    circuitBreakerReason: null,
    circuitBreaker: null,
    kalshi: { configured: true, ready: true, reason: null, balance: 20, allowance: null, lastCheckedAt: now },
    polymarket: { configured: true, ready: true, reason: null, balance: 30, allowance: 30, lastCheckedAt: now, collateralBalanceNormalized: 30 },
    lastAttempt: null,
  };
}

test("trading activity store returns per-platform live history and portfolio data", async () => {
  const db = {
    query: async <T = Record<string, unknown>>(_sql: string, values?: unknown[]) => {
      const platform = values?.[0];
      const rows = platform === "kalshi"
        ? [{
            id: 1,
            created_at: new Date(now - 1_000),
            execution_group_id: "group",
            venue: "kalshi",
            client_order_id: "kalshi-client",
            venue_order_id: "kalshi-order",
            event_type: "fill",
            asset_id: null,
            market_id: "KXBTC15M",
            side: "no",
            status: "filled",
            fill_count: 5,
            remaining_count: 0,
            fill_price: 0.51,
            fee: 0,
            exchange_ts: new Date(now - 1_000),
            received_at: new Date(now - 950),
            raw: {},
          }]
        : [{
            id: 2,
            created_at: new Date(now - 900),
            execution_group_id: "group",
            venue: "polymarket",
            client_order_id: "poly-client",
            venue_order_id: "poly-order",
            event_type: "trade",
            asset_id: "token-yes",
            market_id: "btc-updown-15m",
            side: "BUY",
            status: "matched",
            fill_count: 5,
            remaining_count: 0,
            fill_price: 0.41,
            fee: 0,
            exchange_ts: new Date(now - 900),
            received_at: new Date(now - 850),
            raw: {},
          }];
      return {
        rows: rows as unknown as T[],
      };
    },
  };
  const store = new TradingActivityStore(db);
  const snapshot = await store.getSnapshot({ now, readiness: readiness() });

  assert.equal(snapshot.kalshi.portfolio.cashValue, 20);
  assert.equal(snapshot.polymarket.portfolio.cashValue, 30);
  assert.equal(snapshot.kalshi.history[0].marketName, "KXBTC15M");
  assert.equal(snapshot.kalshi.history[0].value, -2.55);
  assert.equal(snapshot.polymarket.history[0].venueOrderId, "poly-order");
  assert.equal(snapshot.polymarket.positions[0].shares, 5);
});

test("venue stream events normalize into safe trading activity events", () => {
  const event = tradingActivityEventFromVenueEvent({
    venue: "polymarket",
    clientOrderId: "client",
    venueOrderId: "order",
    eventType: "trade",
    marketId: "btc-updown-15m",
    side: "BUY",
    status: "matched",
    fillCount: 5,
    fillPrice: 0.39,
    exchangeTimestampMs: now - 2_000,
    receivedAtMs: now - 1_900,
    raw: { status: "matched" },
  }, now);

  assert.equal(event.platform, "polymarket");
  assert.equal(event.row?.activity, "Buy");
  assert.equal(event.row?.value, -1.95);
  assert.equal(event.row?.venueOrderId, "order");
  assert.equal(JSON.stringify(event).includes("private"), false);
});
