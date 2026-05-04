import test from "node:test";
import assert from "node:assert/strict";
import { AssetType, OrderType, Side, type BalanceAllowanceResponse, type SignedOrder } from "@polymarket/clob-client-v2";
import type { AppConfig } from "../src/config";
import { BookStore } from "../src/books/book-store";
import { LiveExecutor } from "../src/execution/executor";
import {
  buildKalshiV2OrderBody,
  PolymarketOrderClient,
  type LiveOrderContext,
  type PolymarketClobLike,
  type VenueOrderClient,
  type VenueOrderResult,
} from "../src/execution/live-clients";
import { buildDeadZoneCandidate, buildGuaranteedCandidate } from "../src/scanner/payoff";
import type { ArbLeg, Venue, VenueExecutionReadiness } from "../src/types";
import { contract } from "./helpers";

function config(input: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8080,
    databaseUrl: "",
    arbEnabled: true,
    liveTrading: true,
    minProfitDollars: 0.05,
    reentryIntervalMs: 15_000,
    staleBookMs: 10_000,
    marketDiscoveryIntervalMs: 30_000,
    dashboardStreamIntervalMs: 250,
    dashboardSignalRefreshMs: 1_000,
    dashboardAnalyticsRefreshMs: 5_000,
    executionConcurrency: 1,
    discoveryBoundaryRefreshEnabled: true,
    kalshiApiBase: "https://api.elections.kalshi.com/trade-api/v2",
    kalshiWsUrl: "",
    kalshiSeriesTicker: "KXBTC15M",
    polymarketWsUrl: "",
    polymarketDiscoveryUrl: "",
    polymarketLiveDataWsUrl: "",
    polymarketPriceToBeatSymbol: "btc/usd",
    polymarketDiscoveryWindowOffsets: [0],
    polymarketPriceCaptureToleranceMs: 5_000,
    polymarketMissedOpenBackfill: true,
    polymarketPrivateKey: "0xabc",
    polymarketSignatureType: 0,
    polymarketFunderAddress: "",
    polymarketChainId: 137,
    polymarketClobHost: "https://clob.polymarket.com",
    polymarketOrderType: "FOK",
    liveOrderSize: 1,
    liveMaxSlippageCents: 1,
    liveMinExpiryMs: 30_000,
    dryRunSlippageEnabled: true,
    dryRunKalshiSlippageCents: 1,
    dryRunPolymarketSlippageCents: 1,
    dryRunMaxSlippageCents: 3,
    dryRunSlippageJitterCents: 1,
    dashboardApiToken: "token",
    ...input,
  };
}

function ready(venue: Venue): VenueExecutionReadiness {
  return { configured: true, ready: true, reason: null, balance: venue === "polymarket" ? 10 : null, allowance: venue === "polymarket" ? 10 : null, lastCheckedAt: 1_800_000_000_000 };
}

class FakeVenueClient implements VenueOrderClient {
  readonly placed: { leg: ArbLeg; context: LiveOrderContext }[] = [];

  constructor(
    readonly venue: Venue,
    private readonly result: Partial<VenueOrderResult> = {},
  ) {}

  async readiness(): Promise<VenueExecutionReadiness> {
    return ready(this.venue);
  }

  async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
    this.placed.push({ leg, context });
    return {
      venue: this.venue,
      clientOrderId: context.clientOrderId,
      orderId: `${this.venue}-order`,
      status: "filled",
      fillPrice: leg.ask,
      fillCount: 1,
      requestedAt: "2026-04-29T20:00:00.000Z",
      respondedAt: "2026-04-29T20:00:00.050Z",
      error: null,
      ...this.result,
    };
  }
}

function liveCandidate(now: number) {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesTokenId: "yes-token", updatedAt: now });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, updatedAt: now });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);
  return { candidate, lower, higher };
}

test("Kalshi V2 order body maps YES and NO legs onto the YES order book", () => {
  const yes = buildKalshiV2OrderBody({
    venue: "kalshi",
    contractId: "KXBTC15M-YES",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
  }, { executionGroupId: "group", clientOrderId: "client-yes", size: 1, maxBuyPrice: 0.41 });

  assert.equal(yes.ticker, "KXBTC15M-YES");
  assert.equal(yes.side, "bid");
  assert.equal(yes.price, "0.4100");
  assert.equal(yes.count, "1.00");
  assert.equal(yes.time_in_force, "fill_or_kill");

  const no = buildKalshiV2OrderBody({
    venue: "kalshi",
    contractId: "KXBTC15M-NO",
    direction: "no",
    strike: 1502,
    ask: 0.5,
  }, { executionGroupId: "group", clientOrderId: "client-no", size: 1, maxBuyPrice: 0.51 });

  assert.equal(no.side, "ask");
  assert.equal(no.price, "0.4900");
});

test("Polymarket order client builds an exact-size marketable FOK buy for the selected token", async () => {
  class FakeClob implements PolymarketClobLike {
    createdOrder: { tokenID: string; price: number; size: number; side: Side; metadata?: string } | null = null;
    postedType: OrderType | undefined;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }): Promise<SignedOrder> {
      this.createdOrder = order;
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(_order: SignedOrder, orderType?: OrderType): Promise<unknown> {
      this.postedType = orderType;
      return { success: true, orderID: "poly-order", status: "filled", takingAmount: "1", makingAmount: "0.41" };
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }
  }
  const fake = new FakeClob();
  const client = new PolymarketOrderClient(config(), async () => fake);
  const result = await client.placeOrder({
    venue: "polymarket",
    contractId: "poly",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
    tokenId: "yes-token",
  }, { executionGroupId: "group", clientOrderId: "client", size: 1, maxBuyPrice: 0.41 });

  assert.equal(fake.createdOrder?.tokenID, "yes-token");
  assert.equal(fake.createdOrder?.price, 0.41);
  assert.equal(fake.createdOrder?.size, 1);
  assert.equal(fake.createdOrder?.side, Side.BUY);
  assert.equal(fake.postedType, OrderType.FOK);
  assert.equal(result.fillPrice, 0.41);
  assert.equal(result.fillCount, 1);

  const readiness = await client.readiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.balance, 10);
  assert.equal(readiness.allowance, 10);
});

test("live executor fills only protected candidates after stale book and capped-edge preflight", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(config(), books, kalshi, polymarket, () => now);

  const result = await executor.execute(candidate);
  assert.equal(result.action, "filled");
  assert.equal(result.executionGroupId?.startsWith("pok-"), true);
  assert.equal(result.partialFill, false);
  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed.length, 1);
  assert.equal(kalshi.placed[0].context.maxBuyPrice, 0.51);
  assert.equal(polymarket.placed[0].context.maxBuyPrice, 0.41);
});

test("live executor skips stale or below-threshold capped live books before placing orders", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([{ ...lower, updatedAt: now - 20_000 }]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(config(), books, kalshi, polymarket, () => now);

  const stale = await executor.execute(candidate);
  assert.equal(stale.action, "skipped");
  assert.match(stale.failureReason ?? "", /stale/);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarket.placed.length, 0);

  const expensiveBooks = new BookStore();
  expensiveBooks.setPolymarketContracts([{ ...lower, yesAsk: 0.48, updatedAt: now }]);
  expensiveBooks.setKalshiContracts([{ ...higher, noAsk: 0.48, updatedAt: now }]);
  const expensiveExecutor = new LiveExecutor(config(), expensiveBooks, kalshi, polymarket, () => now);
  const expensive = await expensiveExecutor.execute(candidate);
  assert.equal(expensive.action, "skipped");
  assert.match(expensive.failureReason ?? "", /below threshold|slippage cap/);
});

test("live executor rejects dead-zone candidates and locks after one-sided fills", async () => {
  const now = 1_799_999_900_000;
  const deadZone = buildDeadZoneCandidate(
    contract({ venue: "polymarket", contractId: "poly-dead", strike: 1500, noAsk: 0.4, noTokenId: "no-token", updatedAt: now }),
    contract({ venue: "kalshi", contractId: "kalshi-dead", strike: 1502, yesAsk: 0.5, updatedAt: now }),
    0.05,
  );
  assert.ok(deadZone);
  const deadZoneExecutor = new LiveExecutor(config(), undefined, new FakeVenueClient("kalshi"), new FakeVenueClient("polymarket"), () => now);
  const blocked = await deadZoneExecutor.execute(deadZone);
  assert.equal(blocked.action, "failed");
  assert.match(blocked.failureReason ?? "", /protected-spread-only guard/);

  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const executor = new LiveExecutor(
    config(),
    books,
    new FakeVenueClient("kalshi"),
    new FakeVenueClient("polymarket", { status: "failed", fillCount: 0, error: "venue rejected" }),
    () => now,
  );
  const partial = await executor.execute(candidate);
  assert.equal(partial.action, "failed");
  assert.equal(partial.partialFill, true);
  assert.match(partial.failureReason ?? "", /partial fill lock engaged/);
  const readiness = await executor.readiness(now);
  assert.equal(readiness.partialFillLocked, true);
  const locked = await executor.execute(candidate);
  assert.match(locked.failureReason ?? "", /locked after partial fill/);
});
