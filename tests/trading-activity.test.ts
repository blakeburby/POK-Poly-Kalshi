import test from "node:test";
import assert from "node:assert/strict";
import { TradingActivityStore, tradingActivityEventFromVenueEvent } from "../src/trading/activity";
import { accountBackedPlatformActivity } from "../src/trading/account-sources";
import { loadConfig } from "../src/config";
import type { LiveExecutionReadiness } from "../src/types";
import type { TradingPlatformActivity } from "../types/trading";

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

test("polymarket trading activity uses account positions instead of inferred event positions", async () => {
  const wallet = "0x1111111111111111111111111111111111111111";
  const config = loadConfig({
    POLYMARKET_FUNDER_ADDRESS: wallet,
    POLYMARKET_PRIVATE_KEY: "",
  });
  const fallback: TradingPlatformActivity = {
    platform: "polymarket",
    connectionStatus: "live",
    lastUpdatedAt: now,
    portfolio: { platform: "polymarket", portfolioValue: 999, cashValue: 999, dayChangeDollars: -999, dayChangePercent: -0.9, lastUpdatedAt: now },
    positions: [{
      id: "bad-inferred-token",
      market: "bad event id",
      outcome: "BUY",
      shares: 99,
      value: 99,
      averagePrice: 1,
      updatedAt: now,
    }],
    openOrders: [],
    history: [],
    sparkline: [{ timestamp: now - 1_000, value: 999 }, { timestamp: now, value: 999 }],
  };
  const fetchFn: typeof fetch = (async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("user"), wallet);
    if (url.pathname === "/positions") {
      return new Response(JSON.stringify([{
        asset: "real-token",
        title: "Bitcoin Up or Down",
        outcome: "YES",
        size: 7,
        currentValue: 3.5,
        avgPrice: 0.5,
        cashPnl: 1.2,
        realizedPnl: 0.3,
      }]));
    }
    if (url.pathname === "/value") return new Response(JSON.stringify([{ user: wallet, value: 3.5 }]));
    if (url.pathname === "/activity") return new Response(JSON.stringify([]));
    throw new Error(`unexpected url ${url.toString()}`);
  }) as typeof fetch;
  const result = await accountBackedPlatformActivity("polymarket", fallback, {
    config,
    now,
    fetchFn,
    history: [],
    getPolymarketClient: async () => ({
      getBalanceAllowance: async () => ({ balance: "4570000", allowance: "10000000" }),
      getOpenOrders: async () => [{
        id: "open-real",
        market: "real-market",
        asset_id: "real-token",
        side: "BUY",
        original_size: "5",
        size_matched: "2",
        price: "0.4",
        outcome: "YES",
        status: "live",
        created_at: Math.floor(now / 1_000),
      }],
    } as never),
  });

  assert.equal(result.connectionStatus, "live");
  assert.equal(result.portfolio.cashValue, 4.57);
  assert.equal(result.portfolio.portfolioValue, 8.07);
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].id, "real-token");
  assert.equal(result.positions[0].market, "Bitcoin Up or Down");
  assert.equal(result.openOrders[0].id, "open-real");
});
