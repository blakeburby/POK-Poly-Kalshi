import test from "node:test";
import assert from "node:assert/strict";
import { AssetType, OrderType, Side, type BalanceAllowanceResponse, type SignedOrder } from "@polymarket/clob-client-v2";
import type { AppConfig } from "../src/config";
import { BookStore } from "../src/books/book-store";
import { LiveExecutor } from "../src/execution/executor";
import {
  buildKalshiV2OrderBody,
  checkPolymarketGeoblock,
  deriveOrCreatePolymarketApiCreds,
  polymarketApiCredsFromConfig,
  PolymarketOrderClient,
  type LiveOrderContext,
  type PolymarketGeoblockChecker,
  type PolymarketClobLike,
  type VenueOrderClient,
  type VenueOrderResult,
} from "../src/execution/live-clients";
import type { LiveExecutionLockInput, LiveExecutionLockWriter } from "../src/db/live-execution-locks";
import { buildDeadZoneCandidate, buildGuaranteedCandidate } from "../src/scanner/payoff";
import type { ArbLeg, LiveExecutionLock, Venue, VenueExecutionReadiness } from "../src/types";
import { buildUserStreamReadiness, defaultReconciliationReadiness, type VenueConfirmationMonitor, type VenueConfirmationResult } from "../src/execution/venue-confirmations";
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
    polymarketApiKey: "",
    polymarketApiSecret: "",
    polymarketApiPassphrase: "",
    polymarketSignatureType: 0,
    polymarketFunderAddress: "",
    polymarketChainId: 137,
    polymarketClobHost: "https://clob.polymarket.com",
    polymarketGeoblockUrl: "https://polymarket.com/api/geoblock",
    polymarketOrderType: "FOK",
    liveOrderSize: 1,
    liveMaxSlippageCents: 1,
    liveMinExpiryMs: 30_000,
    liveMaxTradesPerWindow: 1,
    liveCollateralBufferDollars: 0.25,
    liveQuoteMaxAgeMs: 750,
    liveQuoteSyncMaxSkewMs: 250,
    liveMinBookDepthShares: 1,
    liveEdgeBufferDollars: 0.03,
    liveEntryLatencyEdgeBufferDollars: 0.02,
    liveOrderTimeoutMs: 2_500,
    liveHedgeMaxLossDollars: 0.02,
    liveHedgeFeeBufferDollars: 0.01,
    liveParallelExecutionEnabled: false,
    liveKalshiOrderGroupEnabled: false,
    liveKalshiOrderGroupId: "",
    liveUserStreamsEnabled: false,
    liveUserStreamPretradeGraceMs: 750,
    liveUserStreamConfirmTimeoutMs: 2_500,
    liveReconcileBeforeTrade: false,
    kalshiUserWsUrl: "",
    polymarketUserWsUrl: "",
    dryRunSlippageEnabled: true,
    dryRunKalshiSlippageCents: 1,
    dryRunPolymarketSlippageCents: 1,
    dryRunMaxSlippageCents: 3,
    dryRunSlippageJitterCents: 1,
    dashboardApiToken: "token",
    ...input,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > 1_000) throw new Error("condition timed out");
    await sleep(5);
  }
}

const allowedGeoblock: PolymarketGeoblockChecker = async (now) => ({
  blocked: false,
  country: "US",
  region: "CA",
  checkedAt: now,
  reason: null,
});

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
      fillCount: context.size,
      requestedAt: "2026-04-29T20:00:00.000Z",
      respondedAt: "2026-04-29T20:00:00.050Z",
      error: null,
      ...this.result,
    };
  }
}

class MutatingVenueClient extends FakeVenueClient {
  constructor(
    venue: Venue,
    result: Partial<VenueOrderResult>,
    private readonly afterPlace: () => void,
  ) {
    super(venue, result);
  }

  async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
    const result = await super.placeOrder(leg, context);
    this.afterPlace();
    return result;
  }
}

class FakeLiveLockStore implements LiveExecutionLockWriter {
  lock: LiveExecutionLock | null = null;
  engageCalls = 0;

  async getActiveLock(): Promise<LiveExecutionLock | null> {
    return this.lock;
  }

  async engageLock(input: LiveExecutionLockInput): Promise<LiveExecutionLock> {
    this.engageCalls += 1;
    if (this.lock) return this.lock;
    this.lock = {
      id: 1,
      createdAt: new Date(1_800_000_000_000).toISOString(),
      reason: input.reason,
      severity: input.severity ?? "critical",
      sourceSignalId: input.sourceSignalId ?? null,
      executionGroupId: input.executionGroupId ?? null,
      details: input.details ?? {},
      clearedAt: null,
      clearReason: null,
    };
    return this.lock;
  }
}

class FakeConfirmationMonitor implements VenueConfirmationMonitor {
  readonly waitCalls: Venue[] = [];
  preflightReason: string | null = null;
  resultStatus: VenueConfirmationResult["status"] = "confirmed";

  userStreamReadiness(now = 1_800_000_000_000) {
    const stream = {
      enabled: true,
      connected: true,
      subscribed: true,
      reason: null,
      lastConnectedAt: now,
      lastEventAt: now,
      lastError: null,
    };
    return buildUserStreamReadiness(true, 2_500, stream, stream, now);
  }

  reconciliationReadiness(now = 1_800_000_000_000) {
    return defaultReconciliationReadiness(true, now, this.preflightReason);
  }

  async preflight(): Promise<string | null> {
    return this.preflightReason;
  }

  async waitForVenueResult(result: VenueOrderResult): Promise<VenueConfirmationResult> {
    this.waitCalls.push(result.venue);
    return {
      venue: result.venue,
      status: this.resultStatus,
      reason: this.resultStatus === "confirmed" ? null : `${result.venue} stream ${this.resultStatus}`,
      clientOrderId: result.clientOrderId,
      venueOrderId: result.orderId,
      fillCount: result.fillCount,
      fillPrice: result.fillPrice,
      fee: result.fee ?? null,
      exchangeTimestampMs: result.exchangeTimestampMs ?? null,
      receivedAtMs: 1_800_000_000_100,
      eventType: "test",
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

function kalshiLowerLiveCandidate(now: number) {
  const lower = contract({ venue: "kalshi", contractId: "kalshi", strike: 1500, yesAsk: 0.4, updatedAt: now });
  const higher = contract({ venue: "polymarket", contractId: "poly", strike: 1502, noAsk: 0.5, noTokenId: "no-token", updatedAt: now });
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
  assert.equal("order_group_id" in yes, false);

  const no = buildKalshiV2OrderBody({
    venue: "kalshi",
    contractId: "KXBTC15M-NO",
    direction: "no",
    strike: 1502,
    ask: 0.5,
  }, { executionGroupId: "group", clientOrderId: "client-no", size: 1, maxBuyPrice: 0.51 });

  assert.equal(no.side, "ask");
  assert.equal(no.price, "0.4900");
  assert.equal("order_group_id" in no, false);
});

test("Polymarket order client builds an exact-size marketable buy for the selected token", async () => {
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

    async cancelOrder(): Promise<unknown> {
      throw new Error("exact fill should not cancel");
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }
  const fake = new FakeClob();
  const client = new PolymarketOrderClient(config(), async () => fake, allowedGeoblock);
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
  assert.equal(fake.postedType, OrderType.GTC);
  assert.equal(result.fillPrice, 0.41);
  assert.equal(result.fillCount, 1);

  const readiness = await client.readiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.balance, 10);
  assert.equal(readiness.allowance, 10);
});

test("Polymarket order client reuses fresh preflight readiness and orderbook data for placement", async () => {
  class ReuseFakeClob implements PolymarketClobLike {
    balanceCalls = 0;
    bookCalls = 0;

    async getOrderBook() {
      this.bookCalls += 1;
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true, orderID: "poly-order", status: "filled", takingAmount: "5", makingAmount: "2" };
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      this.balanceCalls += 1;
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }
  const fake = new ReuseFakeClob();
  const client = new PolymarketOrderClient(config(), async () => fake, allowedGeoblock);
  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.41,
    requiredCollateral: 2.3,
  };
  const leg: ArbLeg = {
    venue: "polymarket",
    contractId: "poly",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
    tokenId: "yes-token",
  };

  assert.equal(await client.preflightOrder(leg, context), null);
  const result = await client.placeOrder(leg, context);

  assert.equal(result.fillCount, 5);
  assert.equal(fake.balanceCalls, 1);
  assert.equal(fake.bookCalls, 1);
});

test("Polymarket order client cancels open remainders and flags non-exact fills", async () => {
  class FakeClob implements PolymarketClobLike {
    cancelCalls = 0;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(): Promise<SignedOrder> {
      return { tokenId: "yes-token" } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true, orderID: "poly-order", status: "live", takingAmount: "115", makingAmount: "1.15" };
    }

    async cancelOrder(): Promise<unknown> {
      this.cancelCalls += 1;
      return { canceled: true };
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }

  const fake = new FakeClob();
  const client = new PolymarketOrderClient(config(), async () => fake, allowedGeoblock);
  const result = await client.placeOrder({
    venue: "polymarket",
    contractId: "poly",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
    tokenId: "yes-token",
  }, { executionGroupId: "group", clientOrderId: "client", size: 5, maxBuyPrice: 0.23 });

  assert.equal(fake.cancelCalls, 1);
  assert.equal(result.status, "unexpected_fill_count");
  assert.equal(result.fillCount, 115);
  assert.equal(result.fillPrice, 0.01);
  assert.match(result.error ?? "", /filled 115 shares for requested exact size 5/);
});

test("Polymarket direct API creds are preferred when all relayer fields are present", () => {
  const creds = polymarketApiCredsFromConfig(config({
    polymarketApiKey: "api-key",
    polymarketApiSecret: "api-secret",
    polymarketApiPassphrase: "api-passphrase",
  }));

  assert.deepEqual(creds, {
    key: "api-key",
    secret: "api-secret",
    passphrase: "api-passphrase",
  });

  assert.equal(polymarketApiCredsFromConfig(config({
    polymarketApiKey: "api-key",
    polymarketApiSecret: "",
    polymarketApiPassphrase: "api-passphrase",
  })), null);
});

test("Polymarket API credentials derive before creating new keys", async () => {
  let deriveCalls = 0;
  let createCalls = 0;
  const derived = await deriveOrCreatePolymarketApiCreds({
    async deriveApiKey() {
      deriveCalls += 1;
      return { key: "derived-key", secret: "derived-secret", passphrase: "derived-passphrase" };
    },
    async createApiKey() {
      createCalls += 1;
      throw new Error("create should not run");
    },
  });

  assert.equal(derived.source, "derived");
  assert.equal(derived.creds.key, "derived-key");
  assert.equal(deriveCalls, 1);
  assert.equal(createCalls, 0);

  const created = await deriveOrCreatePolymarketApiCreds({
    async deriveApiKey() {
      throw new Error("no existing key");
    },
    async createApiKey() {
      return { key: "created-key", secret: "created-secret", passphrase: "created-passphrase" };
    },
  });

  assert.equal(created.source, "created");
  assert.equal(created.creds.key, "created-key");
});

test("Polymarket geoblock check parses allowed, blocked, and unknown responses", async () => {
  const allowed = await checkPolymarketGeoblock(config(), (async () => new Response(JSON.stringify({
    blocked: false,
    country: "US",
    region: "CA",
  }))) as typeof fetch, 123);

  assert.equal(allowed.blocked, false);
  assert.equal(allowed.country, "US");
  assert.equal(allowed.region, "CA");
  assert.equal(allowed.checkedAt, 123);
  assert.equal(allowed.reason, null);

  const blocked = await checkPolymarketGeoblock(config(), (async () => new Response(JSON.stringify({
    blocked: true,
    country: "GB",
    region: "ENG",
  }))) as typeof fetch, 456);

  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason ?? "", /blocked from worker egress/);

  const unknown = await checkPolymarketGeoblock(config(), (async () => new Response("{}", { status: 200 })) as typeof fetch, 789);
  assert.equal(unknown.blocked, null);
  assert.match(unknown.reason ?? "", /boolean blocked field/);
});

test("Polymarket readiness requires proxy funder and funded collateral", async () => {
  class FakeClob implements PolymarketClobLike {
    updateCalls = 0;

    constructor(
      private balance: string,
      private allowance: string | null = "10000000",
      private readonly balanceAfterUpdate?: string,
      private readonly allowanceAfterUpdate?: string | null,
    ) {}

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true };
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: this.balance, allowance: this.allowance };
    }

    async updateBalanceAllowance(): Promise<void> {
      this.updateCalls += 1;
      if (this.balanceAfterUpdate !== undefined) this.balance = this.balanceAfterUpdate;
      if (this.allowanceAfterUpdate !== undefined) this.allowance = this.allowanceAfterUpdate;
    }
  }

  let factoryCalls = 0;
  const missingFunder = new PolymarketOrderClient(config({
    polymarketSignatureType: 2,
    polymarketFunderAddress: "",
  }), async () => {
    factoryCalls += 1;
    return new FakeClob("9000000");
  }, allowedGeoblock);
  const missingFunderReadiness = await missingFunder.readiness();
  assert.equal(missingFunderReadiness.ready, false);
  assert.match(missingFunderReadiness.reason ?? "", /POLYMARKET_FUNDER_ADDRESS/);
  assert.equal(factoryCalls, 0);

  const zeroBalance = new PolymarketOrderClient(config({
    polymarketSignatureType: 2,
    polymarketFunderAddress: "0xAC3b15cD52358c88c97C87FCB7fE67c1b9F0F2B0",
  }), async () => new FakeClob("0", "10000000"), allowedGeoblock);
  const zeroBalanceReadiness = await zeroBalance.readiness();
  assert.equal(zeroBalanceReadiness.ready, false);
  assert.match(zeroBalanceReadiness.reason ?? "", /collateral balance/);
  assert.equal(zeroBalanceReadiness.balance, 0);
  assert.equal(zeroBalanceReadiness.signatureType, 2);
  assert.equal(zeroBalanceReadiness.funderAddress, "0xAC3b...F2B0");
  assert.equal(zeroBalanceReadiness.clobBalanceSynced, true);

  const funded = new PolymarketOrderClient(config({
    polymarketSignatureType: 2,
    polymarketFunderAddress: "0xAC3b15cD52358c88c97C87FCB7fE67c1b9F0F2B0",
  }), async () => new FakeClob("9000000", "10000000"), allowedGeoblock);
  const fundedReadiness = await funded.readiness();
  assert.equal(fundedReadiness.ready, true);
  assert.equal(fundedReadiness.balance, 9);
  assert.equal(fundedReadiness.allowance, 10);
  assert.equal(fundedReadiness.collateralBalanceRaw, 9_000_000);
  assert.equal(fundedReadiness.collateralBalanceNormalized, 9);
  assert.equal(fundedReadiness.clobCredentialsSource, "configured");
  assert.equal(fundedReadiness.clobCredentialsDerived, false);
  assert.equal(fundedReadiness.clobBalanceSynced, null);
});

test("Polymarket readiness is not ready when worker egress is geoblocked or unknown", async () => {
  class FakeClob implements PolymarketClobLike {
    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true };
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "9000000", allowance: "10000000" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }

  let factoryCalls = 0;
  const blocked = new PolymarketOrderClient(config({
    polymarketSignatureType: 2,
    polymarketFunderAddress: "0xAC3b15cD52358c88c97C87FCB7fE67c1b9F0F2B0",
  }), async () => {
    factoryCalls += 1;
    return new FakeClob();
  }, async (now) => ({
    blocked: true,
    country: "US",
    region: "NY",
    checkedAt: now,
    reason: "Polymarket CLOB trading blocked from worker egress",
  }));
  const blockedReadiness = await blocked.readiness(1_800_000_000_000);

  assert.equal(blockedReadiness.ready, false);
  assert.match(blockedReadiness.reason ?? "", /blocked from worker egress/);
  assert.equal(blockedReadiness.geoblockBlocked, true);
  assert.equal(blockedReadiness.geoblockCountry, "US");
  assert.equal(blockedReadiness.geoblockRegion, "NY");
  assert.equal(blockedReadiness.geoblockCheckedAt, 1_800_000_000_000);
  assert.equal(factoryCalls, 0);

  const unknown = new PolymarketOrderClient(config({
    polymarketSignatureType: 2,
    polymarketFunderAddress: "0xAC3b15cD52358c88c97C87FCB7fE67c1b9F0F2B0",
  }), async () => new FakeClob(), async (now) => ({
    blocked: null,
    country: null,
    region: null,
    checkedAt: now,
    reason: "Polymarket geoblock check failed: timeout",
  }));
  const unknownReadiness = await unknown.readiness(1_800_000_000_500);

  assert.equal(unknownReadiness.ready, false);
  assert.equal(unknownReadiness.geoblockBlocked, null);
  assert.match(unknownReadiness.reason ?? "", /timeout/);
});

test("Polymarket readiness syncs CLOB balance allowance before deciding readiness", async () => {
  class SyncingFakeClob implements PolymarketClobLike {
    updateCalls = 0;
    private balance = "0";

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true };
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: this.balance, allowance: null };
    }

    async updateBalanceAllowance(): Promise<void> {
      this.updateCalls += 1;
      this.balance = "9000000";
    }
  }

  const fake = new SyncingFakeClob();
  const client = new PolymarketOrderClient(config({
    polymarketSignatureType: 2,
    polymarketFunderAddress: "0xAC3b15cD52358c88c97C87FCB7fE67c1b9F0F2B0",
  }), async () => ({ client: fake, credentialsSource: "derived" }), allowedGeoblock);
  const readiness = await client.readiness();

  assert.equal(readiness.ready, true);
  assert.equal(readiness.balance, 9);
  assert.equal(readiness.clobCredentialsSource, "derived");
  assert.equal(readiness.clobCredentialsDerived, true);
  assert.equal(readiness.clobBalanceSynced, true);
  assert.equal(fake.updateCalls, 1);
});

test("Polymarket live preflight forces fresh collateral for candidate-specific spend", async () => {
  class BalanceChangingFakeClob implements PolymarketClobLike {
    balanceCalls = 0;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true };
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      this.balanceCalls += 1;
      return {
        balance: this.balanceCalls === 1 ? "9000000" : "2000000",
        allowance: "10000000",
      };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }

  const fake = new BalanceChangingFakeClob();
  const client = new PolymarketOrderClient(config({
    liveOrderSize: 5,
    liveCollateralBufferDollars: 0.25,
    polymarketSignatureType: 2,
    polymarketFunderAddress: "0xAC3b15cD52358c88c97C87FCB7fE67c1b9F0F2B0",
  }), async () => fake, allowedGeoblock);

  const cached = await client.readiness(1_800_000_000_000);
  assert.equal(cached.ready, true);
  assert.equal(cached.balance, 9);

  const reason = await client.preflightOrder({
    venue: "polymarket",
    contractId: "poly",
    direction: "yes",
    strike: 1500,
    ask: 0.91,
    tokenId: "yes-token",
  }, {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.91,
    requiredCollateral: 4.8,
    requestedAt: 1_800_000_000_500,
  });

  assert.match(reason ?? "", /balance 2 is below required live collateral 4.8/);
  assert.equal(fake.balanceCalls, 2);
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
  assert.match(result.executionGroupId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(result.partialFill, false);
  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed.length, 1);
  assert.equal(polymarket.placed[0].context.maxBuyPrice, 0.4);
  assert.equal(kalshi.placed[0].context.maxBuyPrice, 0.61);
});

test("live executor captures the cheaper Polymarket leg before hedging Kalshi", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const order: Venue[] = [];
  class OrderedClient extends FakeVenueClient {
    async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
      order.push(this.venue);
      return super.placeOrder(leg, context);
    }
  }
  const executor = new LiveExecutor(
    config(),
    books,
    new OrderedClient("kalshi"),
    new OrderedClient("polymarket"),
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.deepEqual(order, ["polymarket", "kalshi"]);
});

test("live executor supports configured venue minimum size when both venues fill exactly", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(config({ liveOrderSize: 5 }), books, kalshi, polymarket, () => now);

  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.equal(result.partialFill, false);
  assert.equal(result.kalshiFillCount, 5);
  assert.equal(result.polymarketFillCount, 5);
  assert.equal(kalshi.placed[0].context.size, 5);
  assert.equal(polymarket.placed[0].context.size, 5);
});

test("live executor hedges Polymarket after Kalshi fill even when refreshed arb edge is below threshold", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = kalshiLowerLiveCandidate(now);
  const books = new BookStore();
  books.setKalshiContracts([lower]);
  books.setPolymarketContracts([higher]);
  const movedPolymarket = { ...higher, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 5 }], updatedAt: now };
  const kalshi = new MutatingVenueClient("kalshi", { fillPrice: 0.5, fillCount: 5 }, () => {
    books.setPolymarketContracts([movedPolymarket]);
  });
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(config({ liveOrderSize: 5 }), books, kalshi, polymarket, () => now);

  const result = await executor.execute(candidate);

  assert.equal(polymarket.placed.length, 1);
  assert.equal(polymarket.placed[0].leg.ask, 0.5);
  assert.equal(polymarket.placed[0].context.maxBuyPrice, 0.51);
  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, false);
  assert.equal(result.riskHedge, true);
  assert.equal(result.hedgeCapPrice, 0.51);
  assert.equal(result.realizedGuaranteedProfit, 0);
  assert.match(result.failureReason ?? "", /risk hedge completed below normal profit threshold/);
});

test("live executor locks with hedge-cap reason when Polymarket cannot hedge within max loss", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = kalshiLowerLiveCandidate(now);
  const books = new BookStore();
  books.setKalshiContracts([lower]);
  books.setPolymarketContracts([higher]);
  const movedPolymarket = { ...higher, noAsk: 0.52, noAskLevels: [{ price: 0.52, size: 5 }], updatedAt: now };
  const locks = new FakeLiveLockStore();
  const kalshi = new MutatingVenueClient("kalshi", { fillPrice: 0.5, fillCount: 5 }, () => {
    books.setPolymarketContracts([movedPolymarket]);
  });
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(config({ liveOrderSize: 5 }), books, kalshi, polymarket, () => now, locks);

  const result = await executor.execute(candidate);

  assert.equal(polymarket.placed.length, 0);
  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.equal(result.riskHedge, true);
  assert.match(result.liveLockReason ?? "", /Polymarket hedge cap preflight failed/);
  assert.match((await locks.getActiveLock())?.reason ?? "", /Polymarket hedge worst ask 0.5200 exceeds cap 0.5100/);
});

test("live executor timing metrics separate preflight from venue order RTTs", async () => {
  let now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  class TimedClient extends FakeVenueClient {
    constructor(venue: Venue, private readonly preflightMs: number, private readonly orderMs: number) {
      super(venue);
    }

    async preflightOrder(): Promise<string | null> {
      now += this.preflightMs;
      return null;
    }

    async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
      this.placed.push({ leg, context });
      const requestedAt = context.requestedAt ?? now;
      now = requestedAt + this.orderMs;
      return {
        venue: this.venue,
        clientOrderId: context.clientOrderId,
        orderId: `${this.venue}-order`,
        status: "filled",
        fillPrice: leg.ask,
        fillCount: context.size,
        requestedAt: new Date(requestedAt).toISOString(),
        respondedAt: new Date(now).toISOString(),
        error: null,
      };
    }
  }
  const executor = new LiveExecutor(
    config({ liveOrderSize: 1 }),
    books,
    new TimedClient("kalshi", 30, 10),
    new TimedClient("polymarket", 20, 15),
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionTimings?.preflightMs, 50);
  assert.equal(result.executionTimings?.candidateToSubmitMs, 50);
  assert.equal(result.executionTimings?.kalshiOrderRttMs, 10);
  assert.equal(result.executionTimings?.kalshiRttMs, 10);
  assert.equal(result.executionTimings?.polymarketOrderRttMs, 15);
  assert.equal(result.executionTimings?.polymarketRttMs, 15);
});

test("live executor keeps parallel canary disabled by default and starts both venue orders concurrently when enabled", async () => {
  assert.equal(config().liveParallelExecutionEnabled, false);
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const starts: Venue[] = [];
  let releaseKalshi = () => undefined;
  class ParallelClient extends FakeVenueClient {
    async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
      starts.push(this.venue);
      if (this.venue === "kalshi") {
        await new Promise<void>((resolve) => {
          releaseKalshi = resolve;
        });
      }
      return super.placeOrder(leg, context);
    }
  }
  const executor = new LiveExecutor(
    config({ liveOrderSize: 1, liveParallelExecutionEnabled: true, liveOrderTimeoutMs: 5_000 }),
    books,
    new ParallelClient("kalshi"),
    new ParallelClient("polymarket"),
    () => now,
  );

  const execution = executor.execute(candidate);
  await waitFor(() => starts.includes("kalshi") && starts.includes("polymarket"));
  releaseKalshi();
  const result = await execution;

  assert.equal(result.executionStrategy, "parallel_canary");
  assert.equal(result.action, "filled");
  assert.deepEqual(starts.sort(), ["kalshi", "polymarket"]);
});

test("live executor keeps immediate hedge flow and then requires private stream confirmations", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const monitor = new FakeConfirmationMonitor();
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveUserStreamsEnabled: true, liveReconcileBeforeTrade: true }),
    books,
    kalshi,
    polymarket,
    () => now,
    undefined,
    undefined,
    monitor,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.deepEqual(monitor.waitCalls, ["polymarket", "kalshi"]);
  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed.length, 1);
  assert.equal(result.venueConfirmations?.kalshi?.status, "confirmed");
  assert.equal(result.venueConfirmations?.polymarket?.status, "confirmed");
});

test("live executor skips transient pre-trade user stream outage without persistent lock", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const locks = new FakeLiveLockStore();
  const monitor = new FakeConfirmationMonitor();
  monitor.preflightReason = "Polymarket user stream is not connected/subscribed";
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveUserStreamsEnabled: true, liveUserStreamPretradeGraceMs: 0 }),
    books,
    kalshi,
    polymarket,
    () => now,
    locks,
    undefined,
    monitor,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "skipped");
  assert.match(result.failureReason ?? "", /live user stream preflight skipped/);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarket.placed.length, 0);
  assert.equal(locks.engageCalls, 0);
  assert.equal(await locks.getActiveLock(), null);
});

for (const preflightReason of [
  "refreshing Polymarket user subscriptions",
  "refreshing Kalshi user subscriptions",
]) {
  test(`live executor skips transient pre-trade subscription refresh without persistent lock: ${preflightReason}`, async () => {
    const now = 1_799_999_900_000;
    const { candidate, lower, higher } = liveCandidate(now);
    const books = new BookStore();
    books.setPolymarketContracts([lower]);
    books.setKalshiContracts([higher]);
    const kalshi = new FakeVenueClient("kalshi");
    const polymarket = new FakeVenueClient("polymarket");
    const locks = new FakeLiveLockStore();
    const monitor = new FakeConfirmationMonitor();
    monitor.preflightReason = preflightReason;
    const executor = new LiveExecutor(
      config({ liveOrderSize: 5, liveUserStreamsEnabled: true, liveUserStreamPretradeGraceMs: 0 }),
      books,
      kalshi,
      polymarket,
      () => now,
      locks,
      undefined,
      monitor,
    );

    const result = await executor.execute(candidate);

    assert.equal(result.action, "skipped");
    assert.match(result.failureReason ?? "", /live user stream preflight skipped/);
    assert.equal(kalshi.placed.length, 0);
    assert.equal(polymarket.placed.length, 0);
    assert.equal(locks.engageCalls, 0);
    assert.equal(await locks.getActiveLock(), null);
  });
}

test("live executor grace-retries pre-trade user streams before submitting orders", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const locks = new FakeLiveLockStore();
  class ReconnectingMonitor extends FakeConfirmationMonitor {
    preflightCalls = 0;

    async preflight(): Promise<string | null> {
      this.preflightCalls += 1;
      return this.preflightCalls === 1 ? "Polymarket user stream is not subscribed" : null;
    }
  }
  const monitor = new ReconnectingMonitor();
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveUserStreamsEnabled: true, liveUserStreamPretradeGraceMs: 1 }),
    books,
    kalshi,
    polymarket,
    () => now,
    locks,
    undefined,
    monitor,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.equal(monitor.preflightCalls, 2);
  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed.length, 1);
  assert.equal(locks.engageCalls, 0);
});

test("live executor still locks persistent pre-trade reconciliation failures", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const locks = new FakeLiveLockStore();
  const monitor = new FakeConfirmationMonitor();
  monitor.preflightReason = "live reconciliation blocked: signal #7 has venue fills without private-stream confirmations";
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveUserStreamsEnabled: true, liveUserStreamPretradeGraceMs: 0 }),
    books,
    kalshi,
    polymarket,
    () => now,
    locks,
    undefined,
    monitor,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.match(result.liveLockReason ?? "", /live reconciliation blocked/);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarket.placed.length, 0);
  assert.equal(locks.engageCalls, 1);
  assert.match((await locks.getActiveLock())?.reason ?? "", /live reconciliation blocked/);
});

test("live executor locks when private stream confirmation times out", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const monitor = new FakeConfirmationMonitor();
  monitor.resultStatus = "timeout";
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveUserStreamsEnabled: true }),
    books,
    new FakeVenueClient("kalshi"),
    new FakeVenueClient("polymarket"),
    () => now,
    locks,
    undefined,
    monitor,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.match(result.liveLockReason ?? "", /private stream confirmation timeout/);
  assert.equal(locks.engageCalls, 1);
  assert.match((await locks.getActiveLock())?.reason ?? "", /private stream confirmation timeout/);
});

test("live executor locks when realized fills no longer satisfy guaranteed edge", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = kalshiLowerLiveCandidate(now);
  const books = new BookStore();
  books.setKalshiContracts([lower]);
  books.setPolymarketContracts([higher]);
  const locks = new FakeLiveLockStore();
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, minProfitDollars: 0.05 }),
    books,
    new FakeVenueClient("kalshi", { fillPrice: 0.19, fillCount: 5 }),
    new FakeVenueClient("polymarket", { fillPrice: 0.91, fillCount: 5 }),
    () => now,
    locks,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, false);
  assert.match(result.liveLockReason ?? "", /risk hedge realized edge -0.1000 below loss cap -0.0200/);
  assert.equal(locks.engageCalls, 1);
  assert.equal((await locks.getActiveLock())?.reason, result.liveLockReason);
  const readiness = await executor.readiness(now);
  assert.equal(readiness.circuitBreakerLocked, true);
  assert.equal(readiness.circuitBreakerReason, result.liveLockReason);
});

test("live executor refuses to trade when a persistent circuit breaker is active", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  await locks.engageLock({ reason: "manual incident lock", executionGroupId: "prior-group" });
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(config({ liveOrderSize: 5 }), books, kalshi, polymarket, () => now, locks);

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.match(result.failureReason ?? "", /live circuit breaker locked: manual incident lock/);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarket.placed.length, 0);
  const readiness = await executor.readiness(now);
  assert.equal(readiness.circuitBreakerLocked, true);
  assert.equal(readiness.circuitBreaker?.executionGroupId, "prior-group");
});

test("live executor does not submit Polymarket when first Kalshi leg fails", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = kalshiLowerLiveCandidate(now);
  const books = new BookStore();
  books.setKalshiContracts([lower]);
  books.setPolymarketContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi", {
    status: "failed",
    fillCount: null,
    error: "Kalshi order failed 403: insufficient scope: write required",
  });
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(config({ liveOrderSize: 5 }), books, kalshi, polymarket, () => now);

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, false);
  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed.length, 0);
  assert.match(result.failureReason ?? "", /write required/);
  assert.match(result.polymarketError ?? "", /not submitted because Kalshi leg did not fill exactly/);
});

test("live executor preflights Polymarket minimum size before placing Kalshi", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  class MinSizePolymarketClient extends FakeVenueClient {
    async preflightOrder(_leg: ArbLeg, context: LiveOrderContext): Promise<string | null> {
      return `Polymarket min order size 5 exceeds configured live order size ${context.size}`;
    }
  }
  const polymarket = new MinSizePolymarketClient("polymarket");
  const executor = new LiveExecutor(config({ liveOrderSize: 1 }), books, kalshi, polymarket, () => now);

  const result = await executor.execute(candidate);

  assert.equal(result.action, "skipped");
  assert.match(result.failureReason ?? "", /min order size 5/);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarket.placed.length, 0);
});

test("live executor blocks Kalshi placement when Polymarket worker egress is geoblocked", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  let polymarketFactoryCalls = 0;
  const polymarket = new PolymarketOrderClient(config({
    polymarketSignatureType: 2,
    polymarketFunderAddress: "0xAC3b15cD52358c88c97C87FCB7fE67c1b9F0F2B0",
  }), async () => {
    polymarketFactoryCalls += 1;
    throw new Error("geoblock preflight should stop before CLOB client construction");
  }, async (checkedAt) => ({
    blocked: true,
    country: "US",
    region: "NY",
    checkedAt,
    reason: "Polymarket CLOB trading blocked from worker egress",
  }));
  const executor = new LiveExecutor(config({ liveOrderSize: 5 }), books, kalshi, polymarket, () => now);

  const result = await executor.execute(candidate);

  assert.equal(result.action, "skipped");
  assert.match(result.failureReason ?? "", /blocked from worker egress/);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarketFactoryCalls, 0);
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
  expensiveBooks.setPolymarketContracts([{ ...lower, yesAsk: 0.48, yesAskLevels: [{ price: 0.48, size: 999 }], updatedAt: now }]);
  expensiveBooks.setKalshiContracts([{ ...higher, noAsk: 0.48, noAskLevels: [{ price: 0.48, size: 999 }], updatedAt: now }]);
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

  const { candidate, lower, higher } = kalshiLowerLiveCandidate(now);
  const books = new BookStore();
  books.setKalshiContracts([lower]);
  books.setPolymarketContracts([higher]);
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
  assert.match(partial.failureReason ?? "", /venue fill mismatch/);
  const readiness = await executor.readiness(now);
  assert.equal(readiness.partialFillLocked, true);
  const locked = await executor.execute(candidate);
  assert.match(locked.failureReason ?? "", /locked after unsafe fill/);
});
