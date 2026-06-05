import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { AssetType, OrderType, Side, type BalanceAllowanceResponse, type SignedOrder } from "@polymarket/clob-client-v2";
import type { AppConfig } from "../src/config";
import { loadConfig } from "../src/config";
import { BookStore } from "../src/books/book-store";
import { LiveExecutor } from "../src/execution/executor";
import {
  buildKalshiV2OrderBody,
  checkPolymarketGeoblock,
  deriveOrCreatePolymarketApiCreds,
  KalshiOrderClient,
  polymarketApiCredsFromConfig,
  PolymarketOrderClient,
  type LiveOrderContext,
  type PolymarketGeoblockChecker,
  type PolymarketClobLike,
  type VenueOrderClient,
  type VenueOrderResult,
} from "../src/execution/live-clients";
import { LiveExposureCache } from "../src/execution/live-hot-path";
import type { LiveExecutionLockInput, LiveExecutionLockWriter } from "../src/db/live-execution-locks";
import { buildDeadZoneCandidate, buildGuaranteedCandidate } from "../src/scanner/payoff";
import type { ArbLeg, DashboardSignal, LiveExecutionLock, Venue, VenueExecutionReadiness } from "../src/types";
import { buildUserStreamReadiness, defaultReconciliationReadiness, type VenueConfirmationMonitor, type VenueConfirmationResult } from "../src/execution/venue-confirmations";
import { contract } from "./helpers";

const { privateKey: kalshiTestPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kalshiTestPrivateKeyPem = kalshiTestPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();

async function withKalshiEnv<T>(operation: () => Promise<T>): Promise<T> {
  const previousKeyId = process.env.KALSHI_API_KEY_ID;
  const previousPrivateKey = process.env.KALSHI_PRIVATE_KEY;
  const previousPrivateKeyB64 = process.env.KALSHI_PRIVATE_KEY_B64;
  process.env.KALSHI_API_KEY_ID = "test-key";
  process.env.KALSHI_PRIVATE_KEY = kalshiTestPrivateKeyPem;
  delete process.env.KALSHI_PRIVATE_KEY_B64;
  try {
    return await operation();
  } finally {
    if (previousKeyId == null) delete process.env.KALSHI_API_KEY_ID;
    else process.env.KALSHI_API_KEY_ID = previousKeyId;
    if (previousPrivateKey == null) delete process.env.KALSHI_PRIVATE_KEY;
    else process.env.KALSHI_PRIVATE_KEY = previousPrivateKey;
    if (previousPrivateKeyB64 == null) delete process.env.KALSHI_PRIVATE_KEY_B64;
    else process.env.KALSHI_PRIVATE_KEY_B64 = previousPrivateKeyB64;
  }
}

function config(input: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8080,
    databaseUrl: "",
    arbEnabled: true,
    minProfitDollars: 0.05,
    reentryIntervalMs: 15_000,
    arbScanHeartbeatMs: 250,
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
    liveTakerPriceCushionCents: 2,
    liveMinExpiryMs: 30_000,
    liveMaxTradesPerWindow: 3,
    liveCollateralBufferDollars: 0.25,
    liveKalshiMinCashDollars: 0,
    liveQuoteMaxAgeMs: 750,
    liveQuoteSyncMaxSkewMs: 250,
    liveMinBookDepthShares: 1,
    liveOrderTimeoutMs: 2_500,
    liveHedgeMaxLossDollars: 0.02,
    liveHedgeFeeBufferDollars: 0.01,
    liveOrderPlacementMode: "parallel_limit_rest",
    liveAggressiveLimitRestMs: 500,
    liveParallelExecutionEnabled: false,
    liveHotPathEnabled: false,
    liveHotPathCacheMaxAgeMs: 5_000,
    liveHotPathWarmIntervalMs: 1_000,
    livePolymarketPresignEnabled: false,
    livePolymarketSignedOrderTtlMs: 5_000,
    livePolymarketFirstMinFillShares: 7,
    livePolymarketFirstMaxFillShares: 9,
    liveKalshiPrearmEnabled: true,
    liveKalshiPrearmMaxAgeMs: 5_000,
    liveKalshiPrearmPricePolicy: "patch_after_fill",
    liveLowLatencyHttpEnabled: true,
    liveKalshiOrderGroupEnabled: false,
    liveKalshiOrderGroupId: "",
    liveUserStreamsEnabled: false,
    liveUserStreamPretradeGraceMs: 750,
    liveUserStreamConfirmTimeoutMs: 2_500,
    livePretradeRetryAttempts: 2,
    livePretradeRetryDelayMs: 100,
    liveFinalRecoveryTimeoutMs: 3_000,
    liveFinalRecoveryPollMs: 250,
    liveAutoResolveVerifiedIncidents: true,
    liveAutoHardlocksEnabled: true,
    liveExactExposureRequired: false,
    liveExecutionQualityGateEnabled: true,
    liveExecutionQualityLookbackMs: 30 * 60 * 1_000,
    liveExecutionQualitySampleLimit: 50,
    liveExecutionQualityMinSamples: 5,
    liveExecutionQualityMinExactFillRate: 0.4,
    liveFillQualityScoringEnabled: true,
    liveFillQualityGateEnabled: false,
    liveFillQualityMinExpectedEdge: 0.01,
    liveFillQualityLookbackMs: 30 * 60 * 1_000,
    liveFillQualitySampleLimit: 200,
    liveFillQualityMinSamples: 30,
    liveFillQualityModelVersion: "heuristic-v1",
    liveLeadLagScoringEnabled: true,
    liveLeadLagGateEnabled: false,
    liveLeadLagModelVersion: "heuristic-v1",
    liveLeadLagWindowsMs: [1_000, 5_000, 15_000, 60_000],
    liveLeadLagMinConfidence: 0.65,
    liveLeadLagMaxAdverseSelectionScore: 0.75,
    livePartialFillLockMode: "lock",
    liveMaxUnresolvedExposureDollars: 10,
    liveReconcileBeforeTrade: false,
    kalshiUserWsUrl: "",
    polymarketUserWsUrl: "",
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
  confirmations: Partial<Record<Venue, Partial<VenueConfirmationResult>>> = {};

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
    const override = this.confirmations[result.venue] ?? {};
    const status = override.status ?? this.resultStatus;
    return {
      venue: result.venue,
      status,
      reason: status === "confirmed" ? null : `${result.venue} stream ${status}`,
      clientOrderId: result.clientOrderId,
      venueOrderId: result.orderId,
      fillCount: result.fillCount,
      fillPrice: result.fillPrice,
      fee: result.fee ?? null,
      exchangeTimestampMs: result.exchangeTimestampMs ?? null,
      receivedAtMs: 1_800_000_000_100,
      eventType: "test",
      ...override,
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

function seedPolymarketLeadingHistory(books: BookStore, now: number): void {
  books.applyPolymarketSnapshot({
    tokenId: "yes-token",
    bestBid: 0.36,
    bestAsk: 0.38,
    bidLevels: [{ price: 0.36, size: 20 }],
    askLevels: [{ price: 0.38, size: 20 }],
    timestamp: now - 5_000,
  });
  books.applyKalshiSnapshot({
    marketTicker: "kalshi",
    yesBid: null,
    yesAsk: null,
    noBid: 0.46,
    noAsk: 0.48,
    noBidLevels: [{ price: 0.46, size: 20 }],
    noAskLevels: [{ price: 0.48, size: 20 }],
    timestamp: now - 5_000,
  });
  books.applyPolymarketSnapshot({
    tokenId: "yes-token",
    bestBid: 0.39,
    bestAsk: 0.4,
    bidLevels: [{ price: 0.39, size: 20 }],
    askLevels: [{ price: 0.4, size: 20 }],
    timestamp: now - 4_000,
  });
  books.applyKalshiSnapshot({
    marketTicker: "kalshi",
    yesBid: null,
    yesAsk: null,
    noBid: 0.46,
    noAsk: 0.48,
    noBidLevels: [{ price: 0.46, size: 20 }],
    noAskLevels: [{ price: 0.48, size: 20 }],
    timestamp: now - 4_000,
  });
  books.applyKalshiSnapshot({
    marketTicker: "kalshi",
    yesBid: null,
    yesAsk: null,
    noBid: 0.49,
    noAsk: 0.5,
    noBidLevels: [{ price: 0.49, size: 20 }],
    noAskLevels: [{ price: 0.5, size: 20 }],
    timestamp: now - 2_000,
  });
  books.applyPolymarketSnapshot({
    tokenId: "yes-token",
    bestBid: 0.39,
    bestAsk: 0.4,
    bidLevels: [{ price: 0.39, size: 20 }],
    askLevels: [{ price: 0.4, size: 20 }],
    timestamp: now,
  });
  books.applyKalshiSnapshot({
    marketTicker: "kalshi",
    yesBid: null,
    yesAsk: null,
    noBid: 0.49,
    noAsk: 0.5,
    noBidLevels: [{ price: 0.49, size: 20 }],
    noAskLevels: [{ price: 0.5, size: 20 }],
    timestamp: now,
  });
}

function qualitySignal(now: number, input: Partial<DashboardSignal> = {}): DashboardSignal {
  return {
    id: input.id ?? 1,
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 10_000).toISOString(),
    pairKey: "pair",
    expiryMs: now + 900_000,
    kalshiContractId: "kalshi",
    polymarketContractId: "poly",
    lower: { venue: "polymarket", contractId: "poly", direction: "yes", strike: 1500, ask: 0.4 },
    higher: { venue: "kalshi", contractId: "kalshi", direction: "no", strike: 1502, ask: 0.5 },
    premium: 0.9,
    guaranteedProfit: 0.1,
    overlapProfit: 1.1,
    threshold: 0.01,
    action: "filled",
    failureReason: null,
    kalshiFillId: "kalshi-fill",
    polymarketFillId: "poly-fill",
    kalshiFillPrice: 0.5,
    polymarketFillPrice: 0.4,
    executionGroupId: "group",
    kalshiStatus: "filled",
    polymarketStatus: "filled",
    kalshiFillCount: 8,
    polymarketFillCount: 8,
    partialFill: false,
    executionTimings: { kalshiOrderRttMs: 100, polymarketOrderRttMs: 150 },
    ...input,
  };
}

function qualityReader(now: number, signals: DashboardSignal[]) {
  return {
    unresolvedRiskQuarantineExposureDollars: async () => 0,
    listLiveExecutionQualitySignals: async () => signals,
    liveRiskQuarantineStatus: async () => ({ total: 0, count: 0 }),
    liveExactExposureBlockReason: async () => null,
  };
}

function exactQualitySignals(now: number, count = 40): DashboardSignal[] {
  return Array.from({ length: count }, (_, index) => qualitySignal(now, { id: index + 1, executionGroupId: `exact-${index}` }));
}

function poorQualitySignals(now: number, count = 40): DashboardSignal[] {
  return Array.from({ length: count }, (_, index) => qualitySignal(now, {
    id: index + 1,
    action: "failed",
    failureReason: "risk quarantined: Polymarket mismatch",
    kalshiStatus: "filled",
    polymarketStatus: index % 2 === 0 ? "unknown" : "unexpected_fill_count",
    kalshiFillCount: 5,
    polymarketFillCount: index % 3 === 0 ? 0 : 5.25,
    partialFill: true,
    polymarketError: index % 2 === 0 ? "order response timeout after 2500ms" : null,
    executionTimings: { kalshiOrderRttMs: 100, polymarketOrderRttMs: index % 2 === 0 ? 2500 : 1800 },
    riskQuarantineExposureDollars: 2.5,
  }));
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

  const limitRest = buildKalshiV2OrderBody({
    venue: "kalshi",
    contractId: "KXBTC15M-LIMIT",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
  }, {
    executionGroupId: "group",
    clientOrderId: "client-limit",
    size: 1,
    maxBuyPrice: 0.41,
    placementMode: "parallel_limit_rest",
    limitRestMs: 500,
  });
  assert.equal(limitRest.time_in_force, "good_till_canceled");

  const market = buildKalshiV2OrderBody({
    venue: "kalshi",
    contractId: "KXBTC15M-MARKET",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
  }, {
    executionGroupId: "group",
    clientOrderId: "client-market",
    size: 1,
    maxBuyPrice: 0.41,
    placementMode: "parallel_market",
  });
  assert.equal(market.time_in_force, "immediate_or_cancel");
});

test("Kalshi order client pre-arms request during preflight and patches final price", async () => {
  const calls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchFn = async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    if (new URL(String(url)).pathname.endsWith("/portfolio/balance")) {
      return new Response(JSON.stringify({ balance_dollars: "100.00" }), { status: 200 });
    }
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {},
      headers: init?.headers as Record<string, string>,
    });
    return new Response(JSON.stringify({
      order: {
        order_id: "kalshi-prearmed",
        client_order_id: "client-prearm",
        status: "executed",
        fill_count: "5",
        yes_price_dollars: "0.5300",
      },
    }), { status: 200 });
  };
  const client = new KalshiOrderClient(config({
    liveKalshiPrearmEnabled: true,
    liveKalshiPrearmMaxAgeMs: 5_000,
  }), fetchFn as typeof fetch);
  const leg: ArbLeg = { venue: "kalshi", contractId: "KXBTC15M-PREARM", direction: "yes", strike: 1500, ask: 0.5 };
  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client-prearm",
    size: 5,
    maxBuyPrice: 0.51,
    placementMode: "polymarket_first_exact",
  };

  const result = await withKalshiEnv(async () => {
    assert.equal(await client.preflightOrder(leg, context), null);
    assert.equal(calls.length, 0);
    assert.equal(context.preflight?.kalshiPreparedOrder?.bodyTemplate.price, "0.5100");
    return client.placeOrder(leg, { ...context, maxBuyPrice: 0.53, preflight: context.preflight });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.body.price, "0.5300");
  assert.equal(
    calls[0]?.headers["KALSHI-ACCESS-TIMESTAMP"],
    context.preflight?.kalshiPreparedOrder?.headers["KALSHI-ACCESS-TIMESTAMP"],
  );
  assert.equal(result.metadata?.kalshiPreparedUsed, true);
  assert.equal(result.metadata?.kalshiPreparedFallbackReason, null);
  assert.equal(result.metadata?.kalshiPrearmOriginalMaxBuyPrice, 0.51);
  assert.equal(result.metadata?.kalshiSubmittedMaxBuyPrice, 0.53);
});

test("Kalshi order client falls back to live signing when pre-armed request is stale", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const fetchFn = async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    if (new URL(String(url)).pathname.endsWith("/portfolio/balance")) {
      return new Response(JSON.stringify({ balance_dollars: "100.00" }), { status: 200 });
    }
    calls.push({ body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {} });
    return new Response(JSON.stringify({
      order: {
        order_id: "kalshi-stale-prearm",
        client_order_id: "client-stale",
        status: "executed",
        fill_count: "5",
        yes_price_dollars: "0.5300",
      },
    }), { status: 200 });
  };
  const client = new KalshiOrderClient(config({
    liveKalshiPrearmEnabled: true,
    liveKalshiPrearmMaxAgeMs: 10,
  }), fetchFn as typeof fetch);
  const leg: ArbLeg = { venue: "kalshi", contractId: "KXBTC15M-STALE", direction: "yes", strike: 1500, ask: 0.5 };
  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client-stale",
    size: 5,
    maxBuyPrice: 0.51,
    placementMode: "polymarket_first_exact",
  };

  const result = await withKalshiEnv(async () => {
    assert.equal(await client.preflightOrder(leg, context), null);
    const preparedAt = context.preflight?.kalshiPreparedOrder?.preparedAt;
    assert.equal(typeof preparedAt, "number");
    return client.placeOrder(leg, {
      ...context,
      maxBuyPrice: 0.53,
      requestedAt: preparedAt! + 50,
      preflight: context.preflight,
    });
  });

  assert.equal(calls[0]?.body.price, "0.5300");
  assert.equal(result.metadata?.kalshiPreparedUsed, false);
  assert.match(String(result.metadata?.kalshiPreparedFallbackReason), /expired_/);
});

test("Kalshi order client uses capped IOC order in parallel_market mode", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const fetchFn = async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    if (new URL(String(url)).pathname.endsWith("/portfolio/balance")) {
      return new Response(JSON.stringify({ balance_dollars: "100.00" }), { status: 200 });
    }
    calls.push({ body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {} });
    return new Response(JSON.stringify({
      order: {
        order_id: "kalshi-market",
        client_order_id: "client-market",
        status: "executed",
        fill_count: "5",
        yes_price_dollars: "0.5100",
      },
    }), { status: 200 });
  };
  const client = new KalshiOrderClient(config(), fetchFn as typeof fetch);

  const result = await withKalshiEnv(() => client.placeOrder({
    venue: "kalshi",
    contractId: "KXBTC15M-MARKET",
    direction: "yes",
    strike: 1500,
    ask: 0.5,
  }, {
    executionGroupId: "group",
    clientOrderId: "client-market",
    size: 5,
    maxBuyPrice: 0.51,
    placementMode: "parallel_market",
  }));

  assert.equal(calls[0]?.body.time_in_force, "immediate_or_cancel");
  assert.equal(calls[0]?.body.price, "0.5100");
  assert.equal(result.status, "filled");
  assert.equal(result.metadata?.orderPlacementMode, "parallel_market");
  assert.equal(result.metadata?.kalshiTimeInForce, "immediate_or_cancel");
});

test("Kalshi order client preflight blocks when cash cannot cover hedge collateral", async () => {
  const fetchFn = async (url: Parameters<typeof fetch>[0]): Promise<Response> => {
    if (new URL(String(url)).pathname.endsWith("/portfolio/balance")) {
      return new Response(JSON.stringify({ balance_dollars: "0.03" }), { status: 200 });
    }
    throw new Error("order submit should not run when Kalshi collateral is insufficient");
  };
  const client = new KalshiOrderClient(config(), fetchFn as typeof fetch);

  const reason = await withKalshiEnv(() => client.preflightOrder({
    venue: "kalshi",
    contractId: "KXBTC15M-COLLATERAL",
    direction: "yes",
    strike: 1500,
    ask: 0.5,
  }, {
    executionGroupId: "group",
    clientOrderId: "client-collateral",
    size: 8,
    maxBuyPrice: 0.52,
    requiredCollateral: 4.41,
    placementMode: "polymarket_first_exact",
  }));

  assert.match(reason ?? "", /Kalshi cash balance 0.03 is below required operating cash 4.41/);
});

test("Kalshi order client preflight requires configured multi-trade operating cash floor", async () => {
  const fetchFn = async (url: Parameters<typeof fetch>[0]): Promise<Response> => {
    if (new URL(String(url)).pathname.endsWith("/portfolio/balance")) {
      return new Response(JSON.stringify({ balance_dollars: "20.00" }), { status: 200 });
    }
    throw new Error("order submit should not run when Kalshi operating cash is below the configured floor");
  };
  const client = new KalshiOrderClient(config({ liveKalshiMinCashDollars: 30 }), fetchFn as typeof fetch);

  const reason = await withKalshiEnv(() => client.preflightOrder({
    venue: "kalshi",
    contractId: "KXBTC15M-CASHFLOOR",
    direction: "yes",
    strike: 1500,
    ask: 0.5,
  }, {
    executionGroupId: "group",
    clientOrderId: "client-cash-floor",
    size: 8,
    maxBuyPrice: 0.52,
    requiredCollateral: 4.41,
    placementMode: "polymarket_first_exact",
  }));

  assert.match(reason ?? "", /Kalshi cash balance 20 is below required operating cash 30/);
});

test("Kalshi order client uses aggressive GTC limit and cancels unfilled remainder", async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const responses: Array<Record<string, unknown>> = [
    {
      order: {
        order_id: "kalshi-order",
        client_order_id: "client",
        status: "resting",
        fill_count: "0",
        yes_price_dollars: "0.4100",
      },
    },
    {
      order: {
        order_id: "kalshi-order",
        client_order_id: "client",
        status: "resting",
        fill_count: "0",
        yes_price_dollars: "0.4100",
      },
    },
    { order_id: "kalshi-order", client_order_id: "client", reduced_by: "1.00" },
    {
      order: {
        order_id: "kalshi-order",
        client_order_id: "client",
        status: "canceled",
        fill_count: "0",
        yes_price_dollars: "0.4100",
      },
    },
  ];
  const fetchFn = async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    if (new URL(String(url)).pathname.endsWith("/portfolio/balance")) {
      return new Response(JSON.stringify({ balance_dollars: "100.00" }), { status: 200 });
    }
    calls.push({
      method: init?.method ?? "GET",
      path: new URL(String(url)).pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null,
    });
    return new Response(JSON.stringify(responses.shift() ?? {}), { status: 200 });
  };
  const client = new KalshiOrderClient(config(), fetchFn as typeof fetch);

  const result = await withKalshiEnv(() => client.placeOrder({
    venue: "kalshi",
    contractId: "KXBTC15M-LIMIT",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
  }, {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 1,
    maxBuyPrice: 0.41,
    placementMode: "parallel_limit_rest",
    limitRestMs: 0,
  }));

  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.path, "/trade-api/v2/portfolio/events/orders");
  assert.equal(calls[0]?.body?.time_in_force, "good_till_canceled");
  assert.equal(calls[1]?.method, "GET");
  assert.equal(calls[1]?.path, "/trade-api/v2/portfolio/orders/kalshi-order");
  assert.equal(calls[2]?.method, "DELETE");
  assert.equal(calls[2]?.path, "/trade-api/v2/portfolio/events/orders/kalshi-order");
  assert.equal(calls[3]?.method, "GET");
  assert.equal(calls[3]?.path, "/trade-api/v2/portfolio/orders/kalshi-order");
  assert.equal(result.status, "canceled");
  assert.equal(result.fillCount, 0);
  assert.match(result.error ?? "", /canceled without exact fill/);
  assert.equal(result.metadata?.kalshiCancelStatus, "canceled");
  assert.equal(result.metadata?.kalshiFinalStatus, "canceled");
});

test("Kalshi order client recovers a timed-out submit by client order ID", async () => {
  const calls: Array<{ method: string; path: string; search: string }> = [];
  const fetchFn = async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const parsed = new URL(String(url));
    calls.push({ method: init?.method ?? "GET", path: parsed.pathname, search: parsed.search });
    return new Response(JSON.stringify({
      orders: [
        {
          order_id: "kalshi-order",
          client_order_id: "client-timeout",
          ticker: "KXBTC15M-LATE",
          status: "executed",
          fill_count_fp: "5.00",
          no_price_dollars: "0.3100",
          taker_fees_dollars: "0.0000",
          ts_ms: 1_800_000_000_300,
        },
      ],
    }), { status: 200 });
  };
  const client = new KalshiOrderClient(config(), fetchFn as typeof fetch);
  const timedOut: VenueOrderResult = {
    venue: "kalshi",
    clientOrderId: "client-timeout",
    orderId: null,
    status: "unknown",
    fillPrice: null,
    fillCount: null,
    requestedAt: "2026-04-29T20:00:00.000Z",
    respondedAt: "2026-04-29T20:00:02.500Z",
    error: "order response timeout after 2500ms",
  };

  const result = await withKalshiEnv(() => client.recoverTimedOutOrder!({
    venue: "kalshi",
    contractId: "KXBTC15M-LATE",
    direction: "no",
    strike: 1500,
    ask: 0.31,
  }, {
    executionGroupId: "group",
    clientOrderId: "client-timeout",
    size: 5,
    maxBuyPrice: 0.31,
  }, timedOut));

  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.path, "/trade-api/v2/portfolio/orders");
  assert.match(calls[0]?.search ?? "", /ticker=KXBTC15M-LATE/);
  assert.equal(result?.status, "filled");
  assert.equal(result?.error, null);
  assert.equal(result?.orderId, "kalshi-order");
  assert.equal(result?.fillCount, 5);
  assert.equal(result?.fillPrice, 0.31);
  assert.equal(result?.metadata?.kalshiTimeoutRecoveryStatus, "found_by_client_order_id");
  assert.equal(result?.metadata?.kalshiFinalFillSource, "timeout_recovery_query");
});

test("Polymarket order client builds a market FOK buy for the selected token", async () => {
  class FakeClob implements PolymarketClobLike {
    createdMarketOrder: { tokenID: string; price: number; amount: number; side: Side; orderType?: OrderType; metadata?: string } | null = null;
    postedType: OrderType | undefined;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async createMarketOrder(order: { tokenID: string; price: number; amount: number; side: Side; orderType?: OrderType; metadata?: string }): Promise<SignedOrder> {
      this.createdMarketOrder = order;
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

  assert.equal(fake.createdMarketOrder?.tokenID, "yes-token");
  assert.equal(fake.createdMarketOrder?.price, 0.41);
  assert.equal(fake.createdMarketOrder?.amount, 0.41);
  assert.equal(fake.createdMarketOrder?.side, Side.BUY);
  assert.equal(fake.createdMarketOrder?.orderType, OrderType.FOK);
  assert.equal(fake.postedType, OrderType.FOK);
  assert.equal(result.fillPrice, 0.41);
  assert.equal(result.fillCount, 1);
  assert.equal(result.metadata?.polymarketRequestedSpend, 0.41);
  assert.equal(result.metadata?.polymarketFokStatus, "filled");

  const readiness = await client.readiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.balance, 10);
  assert.equal(readiness.allowance, 10);
});

test("Polymarket order client uses FAK market order in parallel_fak mode", async () => {
  class FakeClob implements PolymarketClobLike {
    createdMarketOrder: { tokenID: string; price: number; amount: number; side: Side; orderType?: OrderType; metadata?: string } | null = null;
    postedType: OrderType | undefined;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async createMarketOrder(order: { tokenID: string; price: number; amount: number; side: Side; orderType?: OrderType; metadata?: string }): Promise<SignedOrder> {
      this.createdMarketOrder = order;
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(_order: SignedOrder, orderType?: OrderType): Promise<unknown> {
      this.postedType = orderType;
      return { success: true, orderID: "poly-order", status: "matched", takingAmount: "5.128204", makingAmount: "4.00" };
    }

    async cancelOrder(): Promise<unknown> {
      throw new Error("matched FAK should not cancel");
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }
  const fake = new FakeClob();
  const client = new PolymarketOrderClient(config({ polymarketOrderType: "FOK" }), async () => fake, allowedGeoblock);
  const result = await client.placeOrder({
    venue: "polymarket",
    contractId: "poly",
    direction: "yes",
    strike: 1500,
    ask: 0.78,
    tokenId: "yes-token",
  }, {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.8,
    placementMode: "parallel_fak",
  });

  assert.equal(fake.createdMarketOrder?.tokenID, "yes-token");
  assert.equal(fake.createdMarketOrder?.price, 0.8);
  assert.equal(fake.createdMarketOrder?.amount, 4);
  assert.equal(fake.createdMarketOrder?.side, Side.BUY);
  assert.equal(fake.createdMarketOrder?.orderType, OrderType.FAK);
  assert.equal(fake.postedType, OrderType.FAK);
  assert.equal(result.status, "unexpected_fill_count");
  assert.equal(result.fillPrice, 0.78);
  assert.equal(result.fillCount, 5.128204);
  assert.match(result.error ?? "", /requested exact size 5/);
  assert.equal(result.metadata?.orderPlacementMode, "parallel_fak");
  assert.equal(result.metadata?.polymarketOrderType, OrderType.FAK);
  assert.equal(result.metadata?.polymarketMarketOrderStatus, "matched");
  assert.equal(result.metadata?.polymarketRequestedSpend, 4);
  assert.equal(result.metadata?.polymarketWorstPrice, 0.8);
  assert.equal(result.metadata?.polymarketTakingAmount, 5.128204);
  assert.equal(result.metadata?.polymarketMakingAmount, 4);
});

test("Polymarket order client uses FAK market order in parallel_market mode", async () => {
  class FakeClob implements PolymarketClobLike {
    createOrderCalls = 0;
    createdMarketOrder: { tokenID: string; price: number; amount: number; side: Side; orderType?: OrderType; metadata?: string } | null = null;
    postedType: OrderType | undefined;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }): Promise<SignedOrder> {
      this.createOrderCalls += 1;
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async createMarketOrder(order: { tokenID: string; price: number; amount: number; side: Side; orderType?: OrderType; metadata?: string }): Promise<SignedOrder> {
      this.createdMarketOrder = order;
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(_order: SignedOrder, orderType?: OrderType): Promise<unknown> {
      this.postedType = orderType;
      return { success: true, orderID: "poly-order", status: "matched", takingAmount: "5", makingAmount: "4.00" };
    }

    async cancelOrder(): Promise<unknown> {
      throw new Error("matched FAK should not cancel");
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }
  const fake = new FakeClob();
  const client = new PolymarketOrderClient(config({ polymarketOrderType: "FOK" }), async () => fake, allowedGeoblock);
  const result = await client.placeOrder({
    venue: "polymarket",
    contractId: "poly",
    direction: "yes",
    strike: 1500,
    ask: 0.78,
    tokenId: "yes-token",
  }, {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.8,
    placementMode: "parallel_market",
  });

  assert.equal(fake.createOrderCalls, 0);
  assert.equal(fake.createdMarketOrder?.tokenID, "yes-token");
  assert.equal(fake.createdMarketOrder?.price, 0.8);
  assert.equal(fake.createdMarketOrder?.amount, 4);
  assert.equal(fake.createdMarketOrder?.orderType, OrderType.FAK);
  assert.equal(fake.postedType, OrderType.FAK);
  assert.equal(result.status, "matched");
  assert.equal(result.fillCount, 5);
  assert.equal(result.metadata?.orderPlacementMode, "parallel_market");
  assert.equal(result.metadata?.polymarketOrderType, OrderType.FAK);
});

test("Polymarket order client uses share-sized FAK limit order in polymarket_first_exact mode", async () => {
  class FakeClob implements PolymarketClobLike {
    createdOrder: { tokenID: string; price: number; size: number; side: Side; metadata?: string } | null = null;
    createdMarketOrder: { tokenID: string; price: number; amount: number; side: Side; orderType?: OrderType; metadata?: string } | null = null;
    postedType: OrderType | undefined;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }): Promise<SignedOrder> {
      this.createdOrder = order;
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async createMarketOrder(order: { tokenID: string; price: number; amount: number; side: Side; orderType?: OrderType; metadata?: string }): Promise<SignedOrder> {
      this.createdMarketOrder = order;
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(_order: SignedOrder, orderType?: OrderType): Promise<unknown> {
      this.postedType = orderType;
      return { success: true, orderID: "poly-order", status: "matched", takingAmount: "5", makingAmount: "4.00" };
    }

    async cancelOrder(): Promise<unknown> {
      throw new Error("matched FAK should not cancel");
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }
  const fake = new FakeClob();
  const client = new PolymarketOrderClient(config({ polymarketOrderType: "FOK" }), async () => fake, allowedGeoblock);
  const result = await client.placeOrder({
    venue: "polymarket",
    contractId: "poly",
    direction: "yes",
    strike: 1500,
    ask: 0.78,
    tokenId: "yes-token",
  }, {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.8,
    placementMode: "polymarket_first_exact",
  });

  assert.equal(fake.createdOrder?.tokenID, "yes-token");
  assert.equal(fake.createdOrder?.price, 0.8);
  assert.equal(fake.createdOrder?.size, 5);
  assert.equal(fake.createdOrder?.side, Side.BUY);
  assert.equal(fake.createdMarketOrder, null);
  assert.equal(fake.postedType, OrderType.FAK);
  assert.equal(result.status, "matched");
  assert.equal(result.fillCount, 5);
  assert.equal(result.metadata?.orderPlacementMode, "polymarket_first_exact");
  assert.equal(result.metadata?.polymarketOrderType, OrderType.FAK);
  assert.equal(result.metadata?.polymarketOrderKind, "share_limit");
  assert.equal(result.metadata?.polymarketRequestedShares, 5);
});

test("Polymarket order client builds aggressive GTC limit and cancels unfilled remainder", async () => {
  class FakeClob implements PolymarketClobLike {
    createdOrder: { tokenID: string; price: number; size: number; side: Side; metadata?: string } | null = null;
    postedType: OrderType | undefined;
    postOnly: boolean | undefined;
    cancelCalls = 0;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }): Promise<SignedOrder> {
      this.createdOrder = order;
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(_order: SignedOrder, orderType?: OrderType, postOnly?: boolean): Promise<unknown> {
      this.postedType = orderType;
      this.postOnly = postOnly;
      return { success: true, orderID: "poly-order", status: "live", takingAmount: "1", makingAmount: "0.41" };
    }

    async cancelOrder(): Promise<unknown> {
      this.cancelCalls += 1;
      return { canceled: ["poly-order"] };
    }

    async getOrder(): Promise<unknown> {
      return { id: "poly-order", status: "canceled", size_matched: "0", price: "0.41", asset_id: "yes-token" };
    }

    async getOpenOrders(): Promise<unknown[]> {
      return [];
    }

    async getTrades(): Promise<unknown[]> {
      return [];
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
  }, {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 1,
    maxBuyPrice: 0.41,
    placementMode: "parallel_limit_rest",
    limitRestMs: 0,
  });

  assert.equal(fake.createdOrder?.tokenID, "yes-token");
  assert.equal(fake.createdOrder?.price, 0.41);
  assert.equal(fake.createdOrder?.size, 1);
  assert.equal(fake.createdOrder?.side, Side.BUY);
  assert.equal(fake.postedType, OrderType.GTC);
  assert.equal(fake.postOnly, false);
  assert.equal(fake.cancelCalls, 1);
  assert.equal(result.status, "canceled");
  assert.equal(result.fillCount, 0);
  assert.match(result.error ?? "", /canceled without exact fill/);
  assert.equal(result.metadata?.polymarketOrderType, OrderType.GTC);
  assert.equal(result.metadata?.polymarketCancelStatus, "canceled");
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

    async createMarketOrder(order: { tokenID: string }): Promise<SignedOrder> {
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

test("Polymarket hot-path preflight uses warmed readiness and metadata without network calls", async () => {
  const now = 1_800_000_000_000;
  class HotFakeClob implements PolymarketClobLike {
    balanceCalls = 0;
    bookCalls = 0;
    tickCalls = 0;
    negRiskCalls = 0;
    versionCalls = 0;
    createCalls = 0;

    async getOrderBook() {
      this.bookCalls += 1;
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async getTickSize() {
      this.tickCalls += 1;
      return "0.01" as const;
    }

    async getNegRisk() {
      this.negRiskCalls += 1;
      return false;
    }

    async resolveVersion() {
      this.versionCalls += 1;
      return 2;
    }

    async createOrder(order: { tokenID: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async createMarketOrder(order: { tokenID: string }): Promise<SignedOrder> {
      this.createCalls += 1;
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
  const fake = new HotFakeClob();
  const client = new PolymarketOrderClient(config({
    liveHotPathEnabled: true,
    liveHotPathCacheMaxAgeMs: 5_000,
  }), async () => fake, allowedGeoblock);
  await client.warm?.({ now, tokenIds: ["yes-token"], requiredCollateral: 2.3 });
  assert.equal(fake.balanceCalls, 1);
  assert.equal(fake.bookCalls, 1);

  fake.balanceCalls = 0;
  fake.bookCalls = 0;
  fake.tickCalls = 0;
  fake.negRiskCalls = 0;
  fake.versionCalls = 0;

  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.41,
    requiredCollateral: 2.3,
    requestedAt: now + 100,
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
  assert.equal(fake.balanceCalls, 0);
  assert.equal(fake.bookCalls, 0);
  assert.equal(fake.tickCalls, 0);
  assert.equal(fake.negRiskCalls, 0);
  assert.equal(fake.versionCalls, 0);
  assert.equal(fake.createCalls, 1);
});

test("Polymarket optional pre-sign stores signed order for hot-path placement", async () => {
  const now = 1_800_000_000_000;
  class PresignFakeClob implements PolymarketClobLike {
    createCalls = 0;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID, salt: this.createCalls } as unknown as SignedOrder;
    }

    async createMarketOrder(order: { tokenID: string }): Promise<SignedOrder> {
      this.createCalls += 1;
      return { tokenId: order.tokenID, salt: this.createCalls } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true, orderID: "poly-order", status: "filled", takingAmount: "5", makingAmount: "2" };
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }
  const fake = new PresignFakeClob();
  const client = new PolymarketOrderClient(config({
    liveHotPathEnabled: true,
    livePolymarketPresignEnabled: true,
  }), async () => fake, allowedGeoblock);
  await client.warm?.({ now, tokenIds: ["yes-token"], requiredCollateral: 2.3 });
  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.41,
    requiredCollateral: 2.3,
    requestedAt: now + 100,
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
  assert.equal(fake.createCalls, 1);
  const result = await client.placeOrder(leg, context);

  assert.equal(result.fillCount, 5);
  assert.equal(fake.createCalls, 1);
  assert.equal(result.signMs, context.preflight?.polymarketSignMs ?? 0);
  assert.equal(result.metadata?.polymarketSignedOrderReused, true);
  assert.equal(result.metadata?.polymarketSignedOrderFallbackReason, null);
  assert.equal(result.metadata?.polymarketPostOrderMs != null, true);
  assert.equal(result.metadata?.polymarketSignedOrderSalt, "1");
});

test("Polymarket exact-first pre-sign stores share-sized FAK limit order", async () => {
  const now = 1_800_000_000_000;
  class PresignFakeClob implements PolymarketClobLike {
    createOrderCalls = 0;
    createMarketOrderCalls = 0;
    createdOrder: { tokenID: string; price: number; size: number; side: Side; metadata?: string } | null = null;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }): Promise<SignedOrder> {
      this.createOrderCalls += 1;
      this.createdOrder = order;
      return { tokenId: order.tokenID, salt: this.createOrderCalls } as unknown as SignedOrder;
    }

    async createMarketOrder(order: { tokenID: string }): Promise<SignedOrder> {
      this.createMarketOrderCalls += 1;
      return { tokenId: order.tokenID, salt: this.createMarketOrderCalls } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true, orderID: "poly-order", status: "filled", takingAmount: "5", makingAmount: "2" };
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }
  const fake = new PresignFakeClob();
  const client = new PolymarketOrderClient(config({
    liveHotPathEnabled: true,
    livePolymarketPresignEnabled: true,
  }), async () => fake, allowedGeoblock);
  await client.warm?.({ now, tokenIds: ["yes-token"], requiredCollateral: 2.3 });
  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.41,
    requiredCollateral: 2.3,
    requestedAt: now + 100,
    placementMode: "polymarket_first_exact",
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
  assert.equal(fake.createOrderCalls, 1);
  assert.equal(fake.createMarketOrderCalls, 0);
  assert.equal(fake.createdOrder?.size, 5);
  assert.equal(context.preflight?.polymarketSignedOrderKind, "share_limit");
  assert.equal(context.preflight?.polymarketSignedOrderSize, 5);

  const result = await client.placeOrder(leg, context);

  assert.equal(result.fillCount, 5);
  assert.equal(fake.createOrderCalls, 1);
  assert.equal(result.metadata?.polymarketSignedOrderReused, true);
  assert.equal(result.metadata?.polymarketOrderKind, "share_limit");
});

test("Polymarket expired pre-signed order falls back to live signing", async () => {
  const now = 1_800_000_000_000;
  class PresignFakeClob implements PolymarketClobLike {
    createCalls = 0;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID, salt: this.createCalls } as unknown as SignedOrder;
    }

    async createMarketOrder(order: { tokenID: string }): Promise<SignedOrder> {
      this.createCalls += 1;
      return { tokenId: order.tokenID, salt: this.createCalls } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true, orderID: "poly-order", status: "filled", takingAmount: "5", makingAmount: "2" };
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }
  const fake = new PresignFakeClob();
  const client = new PolymarketOrderClient(config({
    liveHotPathEnabled: true,
    livePolymarketPresignEnabled: true,
    livePolymarketSignedOrderTtlMs: 50,
  }), async () => fake, allowedGeoblock);
  await client.warm?.({ now, tokenIds: ["yes-token"], requiredCollateral: 2.3 });
  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.41,
    requiredCollateral: 2.3,
    requestedAt: now + 100,
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
  assert.equal(fake.createCalls, 1);
  context.preflight!.polymarketSignedOrderCreatedAt = now - 10_000;

  const result = await client.placeOrder(leg, context);

  assert.equal(result.fillCount, 5);
  assert.equal(fake.createCalls, 2);
  assert.equal(result.metadata?.polymarketSignedOrderReused, false);
  assert.match(String(result.metadata?.polymarketSignedOrderFallbackReason), /expired/);
});

test("Polymarket mismatched pre-signed price falls back to live signing", async () => {
  const now = 1_800_000_000_000;
  class PresignFakeClob implements PolymarketClobLike {
    createCalls = 0;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID, salt: this.createCalls } as unknown as SignedOrder;
    }

    async createMarketOrder(order: { tokenID: string }): Promise<SignedOrder> {
      this.createCalls += 1;
      return { tokenId: order.tokenID, salt: this.createCalls } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true, orderID: "poly-order", status: "filled", takingAmount: "5", makingAmount: "2.1" };
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }
  const fake = new PresignFakeClob();
  const client = new PolymarketOrderClient(config({
    liveHotPathEnabled: true,
    livePolymarketPresignEnabled: true,
  }), async () => fake, allowedGeoblock);
  await client.warm?.({ now, tokenIds: ["yes-token"], requiredCollateral: 2.3 });
  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.41,
    requiredCollateral: 2.3,
    requestedAt: now + 100,
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
  assert.equal(fake.createCalls, 1);
  context.maxBuyPrice = 0.42;

  const result = await client.placeOrder(leg, context);

  assert.equal(result.fillCount, 5);
  assert.equal(fake.createCalls, 2);
  assert.equal(result.metadata?.polymarketSignedOrderReused, false);
  assert.equal(result.metadata?.polymarketSignedOrderFallbackReason, "price_changed");
});

test("Polymarket timeout recovery resolves unambiguous recent FAK trade evidence", async () => {
  const submittedAt = 1_800_000_000_000;
  class RecoveryFakeClob implements PolymarketClobLike {
    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true, orderID: "poly-order", status: "matched", takingAmount: "5", makingAmount: "2" };
    }

    async getTrades(): Promise<unknown[]> {
      return [{
        id: "trade-1",
        taker_order_id: "poly-order",
        asset_id: "yes-token",
        side: Side.BUY,
        size: "5",
        price: "0.40",
        match_time: new Date(submittedAt + 100).toISOString(),
        maker_orders: [],
      }];
    }

    async getOpenOrders(): Promise<unknown[]> {
      return [];
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }
  const client = new PolymarketOrderClient(config({ liveFinalRecoveryTimeoutMs: 0 }), async () => new RecoveryFakeClob(), allowedGeoblock);
  const timedOut: VenueOrderResult = {
    venue: "polymarket",
    clientOrderId: "client",
    orderId: null,
    status: "unknown",
    fillPrice: null,
    fillCount: null,
    requestedAt: new Date(submittedAt).toISOString(),
    respondedAt: new Date(submittedAt + 2_500).toISOString(),
    error: "order response timeout after 2500ms",
    metadata: {
      pendingReconciliation: true,
      polymarketSignedOrderSalt: "123",
      polymarketSignedOrderMakerAmount: "2000000",
      polymarketSignedOrderTakerAmount: "5000000",
    },
  };

  const result = await client.recoverTimedOutOrder!({
    venue: "polymarket",
    contractId: "poly",
    direction: "yes",
    strike: 1500,
    ask: 0.39,
    tokenId: "yes-token",
  }, {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.42,
    placementMode: "parallel_fak",
  }, timedOut);

  assert.equal(result?.status, "filled");
  assert.equal(result?.orderId, "poly-order");
  assert.equal(result?.fillCount, 5);
  assert.equal(result?.fillPrice, 0.4);
  assert.equal(result?.metadata?.polymarketTimeoutRecoveryStatus, "found_unambiguous_recent_trade");
});

test("Polymarket timeout recovery leaves ambiguous recent trade evidence unknown", async () => {
  const submittedAt = 1_800_000_000_000;
  class RecoveryFakeClob implements PolymarketClobLike {
    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(order: { tokenID: string }): Promise<SignedOrder> {
      return { tokenId: order.tokenID } as unknown as SignedOrder;
    }

    async postOrder(): Promise<unknown> {
      return { success: true, orderID: "poly-order", status: "matched", takingAmount: "5", makingAmount: "2" };
    }

    async getTrades(): Promise<unknown[]> {
      return ["poly-a", "poly-b"].map((orderId, index) => ({
        id: `trade-${index}`,
        taker_order_id: orderId,
        asset_id: "yes-token",
        side: Side.BUY,
        size: "5",
        price: "0.40",
        match_time: new Date(submittedAt + 100 + index).toISOString(),
        maker_orders: [],
      }));
    }

    async getOpenOrders(): Promise<unknown[]> {
      return [];
    }

    async getBalanceAllowance(): Promise<BalanceAllowanceResponse> {
      return { balance: "10", allowance: "10" };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }
  const client = new PolymarketOrderClient(config({ liveFinalRecoveryTimeoutMs: 0 }), async () => new RecoveryFakeClob(), allowedGeoblock);
  const timedOut: VenueOrderResult = {
    venue: "polymarket",
    clientOrderId: "client",
    orderId: null,
    status: "unknown",
    fillPrice: null,
    fillCount: null,
    requestedAt: new Date(submittedAt).toISOString(),
    respondedAt: new Date(submittedAt + 2_500).toISOString(),
    error: "order response timeout after 2500ms",
  };

  const result = await client.recoverTimedOutOrder!({
    venue: "polymarket",
    contractId: "poly",
    direction: "yes",
    strike: 1500,
    ask: 0.39,
    tokenId: "yes-token",
  }, {
    executionGroupId: "group",
    clientOrderId: "client",
    size: 5,
    maxBuyPrice: 0.42,
    placementMode: "parallel_fak",
  }, timedOut);

  assert.equal(result?.status, "unknown");
  assert.equal(result?.metadata?.polymarketTimeoutRecoveryStatus, "ambiguous_recent_trades");
  assert.equal(result?.metadata?.polymarketTimeoutRecoveryMatchedTradeGroups, 2);
});

test("Polymarket order client cancels open orders and does not treat live status as a fill", async () => {
  class FakeClob implements PolymarketClobLike {
    cancelCalls = 0;

    async getOrderBook() {
      return { min_order_size: "1", tick_size: "0.01" as const, neg_risk: false };
    }

    async createOrder(): Promise<SignedOrder> {
      return { tokenId: "yes-token" } as unknown as SignedOrder;
    }

    async createMarketOrder(): Promise<SignedOrder> {
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
  assert.equal(result.status, "live");
  assert.equal(result.fillCount, 0);
  assert.equal(result.fillPrice, null);
  assert.match(result.error ?? "", /status live did not immediately fill expected 5 shares/);
  assert.match(result.error ?? "", /canceled open order/);
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

test("Polymarket live preflight reuses cached collateral when it covers candidate spend", async () => {
  class BalanceChangingFakeClob implements PolymarketClobLike {
    balanceCalls = 0;
    orderBookCalls = 0;

    async getOrderBook() {
      this.orderBookCalls += 1;
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

  assert.equal(reason, null);
  assert.equal(fake.balanceCalls, 1);
  assert.equal(fake.orderBookCalls, 1);

  const secondReason = await client.preflightOrder({
    venue: "polymarket",
    contractId: "poly",
    direction: "yes",
    strike: 1500,
    ask: 0.9,
    tokenId: "yes-token",
  }, {
    executionGroupId: "group-2",
    clientOrderId: "client-2",
    size: 5,
    maxBuyPrice: 0.9,
    requiredCollateral: 4.75,
    requestedAt: 1_800_000_000_700,
  });
  assert.equal(secondReason, null);
  assert.equal(fake.balanceCalls, 1);
  assert.equal(fake.orderBookCalls, 1);
});

test("Polymarket live preflight refreshes collateral when cached readiness does not cover candidate spend", async () => {
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
        balance: this.balanceCalls === 1 ? "2000000" : "9000000",
        allowance: "10000000",
      };
    }

    async updateBalanceAllowance(): Promise<void> {}
  }

  const fake = new BalanceChangingFakeClob();
  const client = new PolymarketOrderClient(config({
    liveOrderSize: 2,
    liveCollateralBufferDollars: 0.25,
    polymarketSignatureType: 2,
    polymarketFunderAddress: "0xAC3b15cD52358c88c97C87FCB7fE67c1b9F0F2B0",
  }), async () => fake, allowedGeoblock);

  const cached = await client.readiness(1_800_000_000_000);
  assert.equal(cached.ready, true);
  assert.equal(cached.balance, 2);

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

  assert.equal(reason, null);
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
  assert.equal(polymarket.placed[0].context.maxBuyPrice, 0.42);
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

test("live executor sequential fallback chooses live VWAP over lower-strike venue", async () => {
  const now = 1_799_999_900_000;
  const lower = contract({
    venue: "kalshi",
    contractId: "kalshi-lower-strike",
    strike: 1500,
    yesAsk: 0.65,
    yesAskLevels: [{ price: 0.61, size: 5 }],
    updatedAt: now,
  });
  const higher = contract({
    venue: "polymarket",
    contractId: "poly-higher-strike",
    strike: 1502,
    noAsk: 0.23,
    noAskLevels: [{ price: 0.25, size: 5 }],
    noTokenId: "no-token",
    updatedAt: now,
  });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);
  const books = new BookStore();
  books.setKalshiContracts([lower]);
  books.setPolymarketContracts([higher]);
  const order: Venue[] = [];
  class OrderedClient extends FakeVenueClient {
    async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
      order.push(this.venue);
      return super.placeOrder(leg, context);
    }
  }
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5 }),
    books,
    new OrderedClient("kalshi"),
    new OrderedClient("polymarket"),
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.deepEqual(order, ["polymarket", "kalshi"]);
  assert.equal(result.executionTimings?.firstVenue, "polymarket");
  assert.equal(result.executionTimings?.firstVenueVwap, 0.25);
  assert.match(result.executionTimings?.firstVenueReason ?? "", /kalshi=0.6100 polymarket=0.2500/);
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
        metadata: this.venue === "polymarket" ? { polymarketPostOrderMs: 11 } : undefined,
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
  assert.equal(result.executionTimings?.candidateToSubmitMs, 80);
  assert.equal(result.executionTimings?.kalshiOrderRttMs, 10);
  assert.equal(result.executionTimings?.kalshiRttMs, 10);
  assert.equal(result.executionTimings?.polymarketOrderRttMs, 15);
  assert.equal(result.executionTimings?.polymarketRttMs, 15);
  assert.equal(result.executionTimings?.polymarketPostOrderMs, 11);
});

test("live executor keeps parallel market available and starts both venue orders concurrently after preflight", async () => {
  const defaults = loadConfig({});
  assert.equal(defaults.liveParallelExecutionEnabled, true);
  assert.equal(defaults.liveOrderPlacementMode, "polymarket_first_exact");
  assert.equal(defaults.polymarketOrderType, "FAK");
  assert.equal(loadConfig({ LIVE_ORDER_PLACEMENT_MODE: "parallel_market" }).liveOrderPlacementMode, "parallel_market");
  assert.equal(loadConfig({ LIVE_ORDER_PLACEMENT_MODE: "parallel_limit_rest" }).liveOrderPlacementMode, "parallel_limit_rest");
  assert.equal(loadConfig({ LIVE_ORDER_PLACEMENT_MODE: "parallel_fak" }).liveOrderPlacementMode, "parallel_fak");
  assert.equal(loadConfig({ LIVE_ORDER_PLACEMENT_MODE: "polymarket_first_exact" }).liveOrderPlacementMode, "polymarket_first_exact");
  assert.equal(loadConfig({}).liveAutoHardlocksEnabled, true);
  assert.equal(loadConfig({ LIVE_AUTO_HARDLOCKS_ENABLED: "false" }).liveAutoHardlocksEnabled, false);
  assert.equal(loadConfig({}).liveExactExposureRequired, false);
  assert.equal(loadConfig({ LIVE_EXACT_EXPOSURE_REQUIRED: "true" }).liveExactExposureRequired, true);
  assert.equal(loadConfig({}).liveExecutionQualityGateEnabled, true);
  assert.equal(loadConfig({}).liveKalshiMinCashDollars, 30);
  assert.equal(loadConfig({ LIVE_KALSHI_MIN_CASH_DOLLARS: "100" }).liveKalshiMinCashDollars, 100);
  assert.equal(loadConfig({}).liveFillQualityScoringEnabled, true);
  assert.equal(loadConfig({}).liveFillQualityGateEnabled, false);
  assert.equal(loadConfig({}).liveFillQualityMinExpectedEdge, 0.01);
  assert.equal(loadConfig({}).liveFillQualityLookbackMs, 30 * 60 * 1_000);
  assert.equal(loadConfig({}).liveFillQualitySampleLimit, 200);
  assert.equal(loadConfig({}).liveFillQualityMinSamples, 30);
  assert.equal(loadConfig({}).liveFillQualityModelVersion, "heuristic-v1");
  assert.equal(loadConfig({}).liveLeadLagScoringEnabled, true);
  assert.equal(loadConfig({}).liveLeadLagGateEnabled, false);
  assert.equal(loadConfig({}).liveLeadLagModelVersion, "heuristic-v1");
  assert.deepEqual(loadConfig({}).liveLeadLagWindowsMs, [1_000, 5_000, 15_000, 60_000]);
  assert.equal(loadConfig({}).liveLeadLagMinConfidence, 0.65);
  assert.equal(loadConfig({}).liveLeadLagMaxAdverseSelectionScore, 0.75);
  assert.equal(loadConfig({}).liveOrderSize, 8);
  assert.equal(loadConfig({}).liveMinBookDepthShares, 10);
  assert.equal(loadConfig({}).livePolymarketFirstMinFillShares, 8);
  assert.equal(loadConfig({}).livePolymarketFirstMaxFillShares, 8);
  assert.equal(loadConfig({ LIVE_ORDER_SIZE: "5" }).livePolymarketFirstMinFillShares, 5);
  assert.equal(loadConfig({ LIVE_ORDER_SIZE: "5" }).livePolymarketFirstMaxFillShares, 5);
  assert.equal(loadConfig({ LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES: "4.5", LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES: "5.5" }).livePolymarketFirstMinFillShares, 4.5);
  assert.throws(
    () => loadConfig({ LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES: "6.1", LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES: "6" }),
    /LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES/,
  );
  assert.equal(loadConfig({}).liveKalshiPrearmEnabled, true);
  assert.equal(loadConfig({}).liveKalshiPrearmMaxAgeMs, 5_000);
  assert.equal(loadConfig({}).liveKalshiPrearmPricePolicy, "patch_after_fill");
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
  const kalshi = new ParallelClient("kalshi");
  const polymarket = new ParallelClient("polymarket");
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 1,
      liveOrderPlacementMode: "parallel_market",
      liveParallelExecutionEnabled: false,
      polymarketOrderType: defaults.polymarketOrderType,
      liveOrderTimeoutMs: 5_000,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const execution = executor.execute(candidate);
  await waitFor(() => starts.includes("kalshi") && starts.includes("polymarket"));
  releaseKalshi();
  const result = await execution;

  assert.equal(result.executionStrategy, "parallel_market");
  assert.equal(result.action, "filled");
  assert.equal(result.executionTimings?.firstVenue, null);
  assert.match(result.executionTimings?.firstVenueReason ?? "", /capped market orders submitted concurrently/);
  assert.deepEqual(starts.sort(), ["kalshi", "polymarket"]);
  assert.equal(kalshi.placed[0]?.context.placementMode, "parallel_market");
  assert.equal(polymarket.placed[0]?.context.placementMode, "parallel_market");
  assert.equal(polymarket.placed[0]?.context.limitRestMs, undefined);
});

test("live executor keeps parallel aggressive limit available when configured", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(
    config({ liveOrderSize: 1, liveParallelExecutionEnabled: true, liveOrderPlacementMode: "parallel_limit_rest" }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "parallel_limit_rest");
  assert.equal(result.action, "filled");
  assert.match(result.executionTimings?.firstVenueReason ?? "", /aggressive limit orders submitted concurrently/);
  assert.equal(kalshi.placed[0]?.context.placementMode, "parallel_limit_rest");
  assert.equal(polymarket.placed[0]?.context.limitRestMs, 500);
});

test("live executor keeps parallel FOK available when configured", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(
    config({ liveOrderSize: 1, liveParallelExecutionEnabled: true, liveOrderPlacementMode: "parallel_fok" }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "parallel_fok");
  assert.equal(result.action, "filled");
  assert.equal(kalshi.placed[0]?.context.placementMode, "parallel_fok");
});

test("live executor uses parallel_fak and audits fractional Polymarket fills without auto-hardlock when disabled", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 5, fillPrice: 0.16 });
  const polymarket = new FakeVenueClient("polymarket", {
    status: "unexpected_fill_count",
    fillCount: 5.128204,
    fillPrice: 0.78,
    metadata: {
      orderPlacementMode: "parallel_fak",
      polymarketOrderType: OrderType.FAK,
      polymarketRequestedSpend: 4,
      polymarketWorstPrice: 0.8,
      polymarketTakingAmount: 5.128204,
      polymarketMakingAmount: 4,
    },
  });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveParallelExecutionEnabled: true,
      liveOrderPlacementMode: "parallel_fak",
      liveAutoHardlocksEnabled: false,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
    locks,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "parallel_fak");
  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.match(result.liveLockReason ?? "", /venue fill mismatch/);
  assert.equal(result.polymarketFillCount, 5.128204);
  assert.equal(result.polymarketFillPrice, 0.78);
  assert.equal(kalshi.placed[0]?.context.placementMode, "parallel_fak");
  assert.equal(polymarket.placed[0]?.context.placementMode, "parallel_fak");
  assert.match(result.executionTimings?.firstVenueReason ?? "", /Polymarket FAK/);
  assert.equal(locks.engageCalls, 0);
  const readiness = await executor.readiness(now);
  assert.equal(readiness.riskState, "auto_hardlocks_disabled");
  assert.equal(readiness.partialFillLocked, false);
});

test("live executor uses polymarket_first_exact and submits Kalshi after Polymarket fill is inside configured range", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
  const polymarket = new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 });
  const executor = new LiveExecutor(
    config({ liveOrderSize: 8, liveOrderPlacementMode: "polymarket_first_exact" }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "polymarket_first_exact");
  assert.equal(result.action, "filled");
  assert.equal(result.partialFill, false);
  assert.equal(polymarket.placed.length, 1);
  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed[0]?.context.placementMode, "polymarket_first_exact");
  assert.equal(kalshi.placed[0]?.context.placementMode, "polymarket_first_exact");
  assert.equal(kalshi.placed[0]?.context.maxBuyPrice, 0.61);
  assert.equal(result.executionTimings?.firstVenue, "polymarket");
  assert.match(result.executionTimings?.firstVenueReason ?? "", /7-9 shares/);
  assert.equal(result.executionTimings?.polymarketExactEvidenceSource, "rest_response");
  assert.equal(typeof result.executionTimings?.polyExactToKalshiSubmitMs, "number");
  assert.equal(result.executionTimings?.polymarketHedgeTriggerSource, "rest_response");
  assert.equal(result.executionTimings?.polymarketHedgeTriggerFillCount, 8);
  assert.equal(result.executionTimings?.polymarketHedgeTriggerExact, true);
  assert.equal(typeof result.executionTimings?.polyHedgeTriggerToKalshiSubmitMs, "number");
});

test("live executor persists fill-quality snapshot in shadow mode without blocking submission", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
  const polymarket = new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "polymarket_first_exact",
      liveExecutionQualityGateEnabled: false,
      liveFillQualityScoringEnabled: true,
      liveFillQualityGateEnabled: false,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
    undefined,
    undefined,
    undefined,
    qualityReader(now, poorQualitySignals(now)),
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.equal(polymarket.placed.length, 1);
  assert.equal(kalshi.placed.length, 1);
  assert.equal(result.fillQualitySnapshot?.shadowMode, true);
  assert.equal(result.fillQualitySnapshot?.gateEnabled, false);
  assert.equal(result.leadLagSnapshot?.shadowMode, true);
  assert.equal(result.leadLagSnapshot?.gateEnabled, false);
  assert.equal(result.expectedExecutableEdge, result.fillQualitySnapshot?.expectedExecutableEdge);
});

test("live executor lead/lag gate skips before venue submit on adverse Polymarket-leading movement", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore(5);
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  seedPolymarketLeadingHistory(books, now);
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
  const polymarket = new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "polymarket_first_exact",
      liveExecutionQualityGateEnabled: false,
      liveLeadLagScoringEnabled: true,
      liveLeadLagGateEnabled: true,
      liveLeadLagWindowsMs: [5_000, 15_000, 60_000],
      liveLeadLagMaxAdverseSelectionScore: 0.3,
      liveFillQualityScoringEnabled: false,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "skipped");
  assert.match(result.failureReason ?? "", /lead-lag adverse selection score/);
  assert.equal(result.leadLagSnapshot?.gatePassed, false);
  assert.equal(polymarket.placed.length, 0);
  assert.equal(kalshi.placed.length, 0);
});

test("live executor fill-quality gate skips before venue submit when expected edge is too low", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
  const polymarket = new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "polymarket_first_exact",
      liveExecutionQualityGateEnabled: false,
      liveFillQualityScoringEnabled: true,
      liveFillQualityGateEnabled: true,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
    undefined,
    undefined,
    undefined,
    qualityReader(now, poorQualitySignals(now)),
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "skipped");
  assert.match(result.failureReason ?? "", /fill-quality expected executable edge/);
  assert.equal(result.fillQualitySnapshot?.gatePassed, false);
  assert.equal(polymarket.placed.length, 0);
  assert.equal(kalshi.placed.length, 0);
});

test("live executor fill-quality gate allows candidate when expected edge clears one cent", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
  const polymarket = new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "polymarket_first_exact",
      liveExecutionQualityGateEnabled: false,
      liveFillQualityScoringEnabled: true,
      liveFillQualityGateEnabled: true,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
    undefined,
    undefined,
    undefined,
    qualityReader(now, exactQualitySignals(now)),
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.equal(result.fillQualitySnapshot?.gatePassed, true);
  assert.ok((result.expectedExecutableEdge ?? 0) >= 0.01);
  assert.equal(polymarket.placed.length, 1);
  assert.equal(kalshi.placed.length, 1);
});

test("polymarket_first_exact sends Kalshi from exact REST before Polymarket stream confirmation", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
  const polymarket = new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 });
  class DelayedPolymarketConfirmation extends FakeConfirmationMonitor {
    resolvePolymarket: (() => void) | null = null;

    async waitForVenueResult(result: VenueOrderResult): Promise<VenueConfirmationResult> {
      this.waitCalls.push(result.venue);
      if (result.venue !== "polymarket") return super.waitForVenueResult(result);
      return await new Promise<VenueConfirmationResult>((resolve) => {
        this.resolvePolymarket = () => resolve({
          venue: "polymarket",
          status: "confirmed",
          reason: null,
          clientOrderId: result.clientOrderId,
          venueOrderId: result.orderId,
          fillCount: 8,
          fillPrice: 0.4,
          fee: null,
          exchangeTimestampMs: null,
          receivedAtMs: now + 100,
          eventType: "delayed_test",
        });
      });
    }
  }
  const monitor = new DelayedPolymarketConfirmation();
  const executor = new LiveExecutor(
    config({ liveOrderSize: 8, liveOrderPlacementMode: "polymarket_first_exact", liveUserStreamsEnabled: true }),
    books,
    kalshi,
    polymarket,
    () => now,
    undefined,
    undefined,
    monitor,
  );

  const executing = executor.execute(candidate);
  await waitFor(() => kalshi.placed.length === 1);
  assert.equal(monitor.waitCalls[0], "polymarket");
  monitor.resolvePolymarket?.();
  const result = await executing;

  assert.equal(result.action, "filled");
  assert.equal(result.executionTimings?.polymarketExactEvidenceSource, "rest_response");
  assert.equal(result.executionTimings?.polymarketHedgeTriggerSource, "rest_response");
  assert.equal(result.executionTimings?.polymarketHedgeTriggerFillCount, 8);
  assert.equal(kalshi.placed.length, 1);
});

test("polymarket_first_exact sends Kalshi from exact stream evidence while REST is still pending", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
  class SlowUnknownPolymarketClient extends FakeVenueClient {
    async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
      this.placed.push({ leg, context });
      await sleep(150);
      const requestedAt = context.requestedAt ?? now;
      return {
        venue: "polymarket",
        clientOrderId: context.clientOrderId,
        orderId: "polymarket-order",
        status: "unknown",
        fillPrice: null,
        fillCount: null,
        requestedAt: new Date(requestedAt).toISOString(),
        respondedAt: new Date(requestedAt + 150).toISOString(),
        error: "late ambiguous REST response",
        metadata: { polymarketPostOrderMs: 150 },
      };
    }
  }
  class ImmediateStreamConfirmation extends FakeConfirmationMonitor {
    async waitForVenueResult(result: VenueOrderResult): Promise<VenueConfirmationResult> {
      this.waitCalls.push(result.venue);
      if (result.venue !== "polymarket") return super.waitForVenueResult(result);
      return {
        venue: "polymarket",
        status: "confirmed",
        reason: null,
        clientOrderId: result.clientOrderId,
        venueOrderId: "polymarket-stream-order",
        fillCount: 8,
        fillPrice: 0.4,
        fee: null,
        exchangeTimestampMs: null,
        receivedAtMs: now + 1,
        eventType: "stream_test",
      };
    }
  }
  const polymarket = new SlowUnknownPolymarketClient("polymarket");
  const monitor = new ImmediateStreamConfirmation();
  const executor = new LiveExecutor(
    config({ liveOrderSize: 8, liveOrderPlacementMode: "polymarket_first_exact", liveUserStreamsEnabled: true }),
    books,
    kalshi,
    polymarket,
    () => now,
    undefined,
    undefined,
    monitor,
  );

  const executing = executor.execute(candidate);
  await waitFor(() => kalshi.placed.length === 1);
  const result = await executing;

  assert.equal(result.action, "filled");
  assert.equal(result.polymarketFillId, "polymarket-stream-order");
  assert.equal(result.executionTimings?.polymarketExactEvidenceSource, "private_stream");
  assert.equal(result.executionTimings?.polymarketHedgeTriggerSource, "private_stream");
  assert.equal(result.executionTimings?.polymarketHedgeTriggerFillCount, 8);
  assert.equal(result.executionTimings?.polymarketHedgeTriggerExact, true);
  assert.equal(typeof result.executionTimings?.polyExactToKalshiSubmitMs, "number");
  assert.equal(typeof result.executionTimings?.polyHedgeTriggerToKalshiSubmitMs, "number");
});

test("polymarket_first_exact sends Kalshi from in-range stream mismatch evidence while REST is still pending", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
  class SlowUnknownPolymarketClient extends FakeVenueClient {
    async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
      this.placed.push({ leg, context });
      await sleep(150);
      const requestedAt = context.requestedAt ?? now;
      return {
        venue: "polymarket",
        clientOrderId: context.clientOrderId,
        orderId: "polymarket-order",
        status: "unknown",
        fillPrice: null,
        fillCount: null,
        requestedAt: new Date(requestedAt).toISOString(),
        respondedAt: new Date(requestedAt + 150).toISOString(),
        error: "late ambiguous REST response",
        metadata: { polymarketPostOrderMs: 150 },
      };
    }
  }
  class ImmediateMismatchStreamConfirmation extends FakeConfirmationMonitor {
    async waitForVenueResult(result: VenueOrderResult): Promise<VenueConfirmationResult> {
      this.waitCalls.push(result.venue);
      if (result.venue !== "polymarket") return super.waitForVenueResult(result);
      return {
        venue: "polymarket",
        status: "mismatch",
        reason: "filled 8.2 shares for expected size 8",
        clientOrderId: result.clientOrderId,
        venueOrderId: "polymarket-stream-order",
        fillCount: 8.2,
        fillPrice: 0.4,
        fee: null,
        exchangeTimestampMs: null,
        receivedAtMs: now + 1,
        eventType: "stream_test",
      };
    }
  }
  const polymarket = new SlowUnknownPolymarketClient("polymarket");
  const monitor = new ImmediateMismatchStreamConfirmation();
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "polymarket_first_exact",
      liveUserStreamsEnabled: true,
      liveAutoHardlocksEnabled: false,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
    undefined,
    undefined,
    monitor,
  );

  const executing = executor.execute(candidate);
  await waitFor(() => kalshi.placed.length === 1);
  const result = await executing;

  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.equal(result.polymarketFillId, "polymarket-stream-order");
  assert.equal(result.polymarketFillCount, 8.2);
  assert.equal(result.executionTimings?.polymarketHedgeTriggerSource, "private_stream");
  assert.equal(result.executionTimings?.polymarketHedgeTriggerFillCount, 8.2);
  assert.equal(result.executionTimings?.polymarketHedgeTriggerExact, false);
  assert.equal(result.executionTimings?.polymarketExactEvidenceSource, null);
  assert.equal(typeof result.executionTimings?.polyHedgeTriggerToKalshiSubmitMs, "number");
});

test("polymarket_first_exact submits Kalshi after fractional Polymarket fill inside configured range but keeps partial audit", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
  const polymarket = new FakeVenueClient("polymarket", {
    status: "unexpected_fill_count",
    fillCount: 8.128204,
    fillPrice: 0.4,
    error: "Polymarket FAK returned fractional fill",
  });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "polymarket_first_exact",
      liveAutoHardlocksEnabled: false,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
    locks,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "polymarket_first_exact");
  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.equal(polymarket.placed.length, 1);
  assert.equal(kalshi.placed.length, 1);
  assert.equal(result.kalshiFillCount, 8);
  assert.equal(result.polymarketFillCount, 8.128204);
  assert.equal(result.executionTimings?.polymarketHedgeTriggerSource, "rest_response");
  assert.equal(result.executionTimings?.polymarketHedgeTriggerFillCount, 8.128204);
  assert.equal(result.executionTimings?.polymarketHedgeTriggerMinFillShares, 7);
  assert.equal(result.executionTimings?.polymarketHedgeTriggerMaxFillShares, 9);
  assert.equal(result.executionTimings?.polymarketHedgeTriggerExact, false);
  assert.equal(result.executionTimings?.polymarketExactEvidenceSource, null);
  assert.equal(typeof result.executionTimings?.polyHedgeTriggerToKalshiSubmitMs, "number");
  assert.match(result.liveLockReason ?? "", /venue fill mismatch/);
  assert.equal(locks.engageCalls, 0);
});

test("polymarket_first_exact treats configured Polymarket fill range boundaries as hedge triggers", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  for (const fillCount of [7, 8, 8.5, 9]) {
    const books = new BookStore();
    books.setPolymarketContracts([lower]);
    books.setKalshiContracts([higher]);
    const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
    const polymarket = new FakeVenueClient("polymarket", { fillCount, fillPrice: 0.4 });
    const executor = new LiveExecutor(
      config({
        liveOrderSize: 8,
        liveOrderPlacementMode: "polymarket_first_exact",
        liveAutoHardlocksEnabled: false,
      }),
      books,
      kalshi,
      polymarket,
      () => now,
    );

    const result = await executor.execute(candidate);

    assert.equal(polymarket.placed.length, 1);
    assert.equal(kalshi.placed.length, 1);
    assert.equal(result.action, fillCount === 8 ? "filled" : "failed");
    assert.equal(result.partialFill, fillCount !== 8);
    assert.equal(result.executionTimings?.polymarketHedgeTriggerFillCount, fillCount);
  }
});

test("polymarket_first_exact does not submit Kalshi when Polymarket fill is outside configured range", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  for (const fillCount of [0, 6.99, 9.01]) {
    const books = new BookStore();
    books.setPolymarketContracts([lower]);
    books.setKalshiContracts([higher]);
    const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
    const polymarket = new FakeVenueClient("polymarket", {
      status: fillCount === 0 ? "unfilled" : "unexpected_fill_count",
      fillCount,
      fillPrice: fillCount === 0 ? null : 0.4,
      error: fillCount === 0 ? null : "Polymarket FAK returned out-of-range fill",
    });
    const executor = new LiveExecutor(
      config({
        liveOrderSize: 8,
        liveOrderPlacementMode: "polymarket_first_exact",
        liveAutoHardlocksEnabled: false,
      }),
      books,
      kalshi,
      polymarket,
      () => now,
    );

    const result = await executor.execute(candidate);

    assert.equal(polymarket.placed.length, 1);
    assert.equal(kalshi.placed.length, 0);
    assert.match(result.kalshiError ?? "", /outside configured hedge range|not available inside configured hedge range/);
  }
});

test("polymarket_first_exact marks exposure when Kalshi misses after exact Polymarket fill", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi", {
    status: "failed",
    fillCount: 0,
    fillPrice: null,
    error: "Kalshi FOK rejected",
  });
  const polymarket = new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "polymarket_first_exact",
      liveAutoHardlocksEnabled: false,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.equal(polymarket.placed.length, 1);
  assert.equal(kalshi.placed.length, 1);
  assert.match(result.liveLockReason ?? "", /venue fill mismatch/);
  assert.match(result.failureReason ?? "", /risk quarantined|venue fill mismatch|Kalshi FOK rejected/);
  assert.equal(result.recoveryEvidence?.failureClassification && (result.recoveryEvidence.failureClassification as Record<string, unknown>).category, "liquidity_or_partial_fill");
});

test("live executor skips without submitting when preflight exceeds quote freshness window", async () => {
  let now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  class SlowPreflightClient extends FakeVenueClient {
    constructor(venue: Venue, private readonly preflightMs: number) {
      super(venue);
    }

    async preflightOrder(): Promise<string | null> {
      now += this.preflightMs;
      return null;
    }
  }
  const kalshi = new SlowPreflightClient("kalshi", 800);
  const polymarket = new SlowPreflightClient("polymarket", 0);
  const executor = new LiveExecutor(
    config({ liveOrderSize: 1, liveParallelExecutionEnabled: true, liveQuoteMaxAgeMs: 750 }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "skipped");
  assert.match(result.failureReason ?? "", /preflight took 800ms/);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarket.placed.length, 0);
});

test("live executor locks parallel one-sided fills", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveParallelExecutionEnabled: true }),
    books,
    new FakeVenueClient("kalshi", { fillCount: 5 }),
    new FakeVenueClient("polymarket", { status: "failed", fillCount: 0, error: "venue rejected" }),
    () => now,
    locks,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "parallel_limit_rest");
  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.match(result.liveLockReason ?? "", /venue fill mismatch kalshi=5 polymarket=0/);
  assert.equal(locks.engageCalls, 1);
});

test("live executor treats exact paired fills as filled even when realized edge is below entry threshold", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveParallelExecutionEnabled: true, minProfitDollars: 0.05 }),
    books,
    new FakeVenueClient("kalshi", { fillCount: 5, fillPrice: 0.55 }),
    new FakeVenueClient("polymarket", { fillCount: 5, fillPrice: 0.5 }),
    () => now,
    locks,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.equal(result.partialFill, false);
  assert.equal(result.realizedGuaranteedProfit, -0.05);
  assert.equal(result.liveLockReason, null);
  assert.equal(locks.engageCalls, 0);
});

test("live executor resolves a Kalshi timeout from private-stream confirmation before locking", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const monitor = new FakeConfirmationMonitor();
  monitor.confirmations = {
    kalshi: {
      status: "confirmed",
      venueOrderId: "kalshi-late-order",
      fillCount: 5,
      fillPrice: 0.31,
      fee: 0,
      exchangeTimestampMs: now + 3_400,
      receivedAtMs: now + 3_457,
    },
    polymarket: {
      status: "confirmed",
      venueOrderId: "poly-order",
      fillCount: 5,
      fillPrice: 0.62,
      fee: 0,
      exchangeTimestampMs: now + 480,
      receivedAtMs: now + 483,
    },
  };
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveParallelExecutionEnabled: true, liveUserStreamsEnabled: true }),
    books,
    new FakeVenueClient("kalshi", {
      orderId: null,
      status: "unknown",
      fillPrice: null,
      fillCount: null,
      respondedAt: new Date(now + 2_500).toISOString(),
      error: "order response timeout after 2500ms",
    }),
    new FakeVenueClient("polymarket", {
      orderId: "poly-order",
      status: "filled",
      fillPrice: 0.62,
      fillCount: 5,
      respondedAt: new Date(now + 483).toISOString(),
    }),
    () => now,
    locks,
    undefined,
    monitor,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.equal(result.partialFill, false);
  assert.equal(result.liveLockReason, null);
  assert.equal(result.kalshiStatus, "filled");
  assert.equal(result.kalshiError, null);
  assert.equal(result.kalshiFillId, "kalshi-late-order");
  assert.equal(result.kalshiFillCount, 5);
  assert.equal(result.kalshiFillPrice, 0.31);
  assert.equal(result.polymarketFillCount, 5);
  assert.equal(result.realizedGuaranteedProfit, 0.07);
  assert.equal(result.recoveryStatus, "auto_resolved_paired_fill");
  assert.equal(result.finalizationMs, 3_457);
  assert.equal(result.executionTimings?.totalMs, 3_457);
  assert.deepEqual(monitor.waitCalls.sort(), ["kalshi", "polymarket"]);
  assert.equal(locks.engageCalls, 0);
});

test("live executor keeps the lock when a timed-out venue is unresolved by stream confirmation", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const monitor = new FakeConfirmationMonitor();
  monitor.confirmations = {
    kalshi: { status: "timeout", reason: "kalshi stream did not confirm", fillCount: null, fillPrice: null },
    polymarket: { status: "confirmed", fillCount: 5, fillPrice: 0.4 },
  };
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveParallelExecutionEnabled: true, liveUserStreamsEnabled: true }),
    books,
    new FakeVenueClient("kalshi", {
      orderId: null,
      status: "unknown",
      fillPrice: null,
      fillCount: null,
      error: "order response timeout after 2500ms",
    }),
    new FakeVenueClient("polymarket", { status: "filled", fillCount: 5 }),
    () => now,
    locks,
    undefined,
    monitor,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.match(result.liveLockReason ?? "", /private stream confirmation timeout/);
  assert.equal(result.recoveryStatus, "operator_required");
  assert.equal(locks.engageCalls, 1);
});

test("live executor quarantines a bounded one-sided fill instead of hard-locking", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const monitor = new FakeConfirmationMonitor();
  monitor.confirmations = {
    kalshi: { status: "timeout", reason: "kalshi stream did not confirm", fillCount: null, fillPrice: null },
    polymarket: { status: "confirmed", fillCount: 5, fillPrice: 0.84 },
  };
  const exposureReader = { unresolvedRiskQuarantineExposureDollars: async () => 0 };
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveParallelExecutionEnabled: true,
      liveUserStreamsEnabled: true,
      livePartialFillLockMode: "quarantine",
      liveMaxUnresolvedExposureDollars: 10,
    }),
    books,
    new FakeVenueClient("kalshi", {
      orderId: null,
      status: "unknown",
      fillPrice: null,
      fillCount: null,
      error: "order response timeout after 2500ms",
      metadata: {
        kalshiTimeoutRecoveryAttempted: true,
        kalshiTimeoutRecoveryStatus: "not_found",
      },
    }),
    new FakeVenueClient("polymarket", { status: "filled", fillCount: 5, fillPrice: 0.84 }),
    () => now,
    locks,
    undefined,
    monitor,
    exposureReader,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.equal(result.liveLockReason, null);
  assert.equal(result.recoveryStatus, "risk_quarantined");
  assert.equal(result.riskQuarantineExposureDollars, 4.2);
  assert.match(result.riskQuarantineReason ?? "", /within cap 10.00/);
  assert.equal(locks.engageCalls, 0);
  const readiness = await executor.readiness(now);
  assert.equal(readiness.riskState, "quarantined");
});

test("live executor readiness surfaces persisted quarantined exposure after restart", async () => {
  const now = 1_799_999_900_000;
  const { lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const exposureReader = {
    unresolvedRiskQuarantineExposureDollars: async () => 4.2,
    liveRiskQuarantineStatus: async () => ({ total: 4.2, count: 1 }),
  };
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveParallelExecutionEnabled: true,
      liveUserStreamsEnabled: true,
      livePartialFillLockMode: "quarantine",
      liveMaxUnresolvedExposureDollars: 10,
    }),
    books,
    new FakeVenueClient("kalshi"),
    new FakeVenueClient("polymarket"),
    () => now,
    new FakeLiveLockStore(),
    undefined,
    new FakeConfirmationMonitor(),
    exposureReader,
  );

  const readiness = await executor.readiness(now);

  assert.equal(readiness.riskState, "quarantined");
  assert.equal(readiness.reconciliation.quarantinedExposureDollars, 4.2);
  assert.equal(readiness.reconciliation.quarantinedSignalCount, 1);
  assert.match(readiness.riskStateReason ?? "", /trading with quarantined unresolved exposure 4.20/);
});

test("live executor readiness does not block on unresolved exact exposure when guard is disabled", async () => {
  const now = 1_799_999_900_000;
  const { lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const exposureReader = {
    unresolvedRiskQuarantineExposureDollars: async () => 0,
    liveRiskQuarantineStatus: async () => ({ total: 0, count: 0 }),
    liveExactExposureBlockReason: async () => {
      throw new Error("exact-exposure reader should not run when disabled");
    },
  };
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveAutoHardlocksEnabled: false,
      liveExactExposureRequired: false,
      liveExecutionQualityGateEnabled: false,
      liveUserStreamsEnabled: true,
    }),
    books,
    new FakeVenueClient("kalshi"),
    new FakeVenueClient("polymarket"),
    () => now,
    new FakeLiveLockStore(),
    undefined,
    new FakeConfirmationMonitor(),
    exposureReader,
  );

  const readiness = await executor.readiness(now);

  assert.equal(readiness.exactExposureRequired, false);
  assert.equal(readiness.riskState, "auto_hardlocks_disabled");
  assert.doesNotMatch(readiness.riskStateReason ?? "", /exact-exposure guard/);
});

test("live executor readiness blocks unresolved exact exposure when guard is enabled", async () => {
  const now = 1_799_999_900_000;
  const { lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const exposureReader = {
    unresolvedRiskQuarantineExposureDollars: async () => 0,
    liveRiskQuarantineStatus: async () => ({ total: 0, count: 0 }),
    liveExactExposureBlockReason: async () => "live exact-exposure guard blocked: signal #119283 is marked partial_fill",
  };
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveAutoHardlocksEnabled: false,
      liveExactExposureRequired: true,
      liveExecutionQualityGateEnabled: false,
      liveUserStreamsEnabled: true,
    }),
    books,
    new FakeVenueClient("kalshi"),
    new FakeVenueClient("polymarket"),
    () => now,
    new FakeLiveLockStore(),
    undefined,
    new FakeConfirmationMonitor(),
    exposureReader,
  );

  const readiness = await executor.readiness(now);

  assert.equal(readiness.exactExposureRequired, true);
  assert.equal(readiness.riskState, "blocked");
  assert.match(readiness.riskStateReason ?? "", /signal #119283 is marked partial_fill/);
});

test("live exposure cache reads persisted quarantine totals from the backing store", async () => {
  const cache = new LiveExposureCache({
    listLiveExposureSignals: async () => [],
    unresolvedRiskQuarantineExposureDollars: async () => 4.2,
    liveRiskQuarantineStatus: async () => ({ total: 4.2, count: 1 }),
  }, 5_000, 10, () => 1_800_000_000_000);

  await cache.refresh();

  assert.equal(await cache.unresolvedRiskQuarantineExposureDollars(), 4.2);
  assert.deepEqual(await cache.liveRiskQuarantineStatus(), { total: 4.2, count: 1 });
});

test("live exposure cache enforces submitted attempt cap from warmed attempts and observed signals", async () => {
  const now = 1_799_999_900_000;
  const { candidate } = liveCandidate(now);
  const attempt = (id: number, action: "filled" | "failed" | "skipped", executionGroupId: string | null): DashboardSignal => ({
    id,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    pairKey: `pair-${id}`,
    expiryMs: candidate.expiryMs,
    kalshiContractId: `kalshi-${id}`,
    polymarketContractId: `poly-${id}`,
    lower: { venue: "polymarket", contractId: `poly-${id}`, strike: 1500, direction: "yes", ask: 0.4 },
    higher: { venue: "kalshi", contractId: `kalshi-${id}`, strike: 1502, direction: "no", ask: 0.5 },
    premium: 0.9,
    guaranteedProfit: 0.1,
    overlapProfit: 1.1,
    threshold: 0.05,
    action,
    failureReason: action === "failed" ? "venue failed" : null,
    kalshiFillId: null,
    polymarketFillId: null,
    kalshiFillPrice: null,
    polymarketFillPrice: null,
    executionGroupId,
  });
  const cache = new LiveExposureCache({
    listLiveExposureSignals: async () => [],
    listLiveSubmittedAttemptSignals: async () => [
      attempt(1, "filled", "group-1"),
      attempt(2, "failed", "group-2"),
      attempt(3, "skipped", null),
    ],
  }, 5_000, 10, () => now);

  await cache.refresh(now);

  assert.equal(await cache.liveSubmittedAttemptBlockReason(candidate, now, 3), null);
  cache.observeSignal(attempt(4, "failed", "group-4"));
  assert.match(await cache.liveSubmittedAttemptBlockReason(candidate, now, 3) ?? "", /submitted attempt limit reached/);
});

test("live exposure cache blocks unresolved exact-exposure problems independently of hardlocks", async () => {
  const now = 1_799_999_900_000;
  const { candidate } = liveCandidate(now);
  const partial: DashboardSignal = {
    id: 41,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    pairKey: "partial",
    expiryMs: candidate.expiryMs,
    kalshiContractId: "kalshi",
    polymarketContractId: "poly",
    lower: { venue: "polymarket", contractId: "poly", strike: 1500, direction: "yes", ask: 0.4 },
    higher: { venue: "kalshi", contractId: "kalshi", strike: 1502, direction: "no", ask: 0.5 },
    premium: 0.9,
    guaranteedProfit: 0.1,
    overlapProfit: 1.1,
    threshold: 0.05,
    action: "failed",
    failureReason: "venue fill mismatch",
    kalshiFillId: null,
    polymarketFillId: "poly-fill",
    kalshiFillPrice: null,
    polymarketFillPrice: 0.4,
    kalshiFillCount: 0,
    polymarketFillCount: 5,
    partialFill: true,
    executionGroupId: "group-partial",
  };
  const cache = new LiveExposureCache({
    listLiveExposureSignals: async () => [],
    listLiveExactExposureSignals: async () => [partial],
  }, 5_000, 10, () => now);

  await cache.refresh(now);

  assert.match(await cache.liveExactExposureBlockReason(now) ?? "", /exact-exposure guard blocked/);
});

test("live exposure cache blocks when recent execution quality is poor", async () => {
  const now = 1_799_999_900_000;
  const { candidate } = liveCandidate(now);
  const miss = (id: number): DashboardSignal => ({
    id,
    createdAt: new Date(now - id * 1_000).toISOString(),
    updatedAt: new Date(now - id * 1_000).toISOString(),
    pairKey: `miss-${id}`,
    expiryMs: candidate.expiryMs,
    kalshiContractId: `kalshi-${id}`,
    polymarketContractId: `poly-${id}`,
    lower: { venue: "polymarket", contractId: `poly-${id}`, strike: 1500, direction: "yes", ask: 0.4 },
    higher: { venue: "kalshi", contractId: `kalshi-${id}`, strike: 1502, direction: "no", ask: 0.5 },
    premium: 0.9,
    guaranteedProfit: 0.1,
    overlapProfit: 1.1,
    threshold: 0.05,
    action: "failed",
    failureReason: "venue fill mismatch",
    kalshiFillId: `kalshi-fill-${id}`,
    polymarketFillId: null,
    kalshiFillPrice: 0.5,
    polymarketFillPrice: null,
    kalshiFillCount: 5,
    polymarketFillCount: 0,
    partialFill: true,
    executionGroupId: `group-${id}`,
    executionTimings: { polymarketOrderRttMs: 2_500 },
  });
  const cache = new LiveExposureCache({
    listLiveExposureSignals: async () => [],
    listLiveExecutionQualitySignals: async () => [1, 2, 3, 4, 5].map(miss),
  }, 5_000, 10, () => now);

  await cache.refresh(now);

  const reason = await cache.liveExecutionQualityBlockReason(candidate, now, {
    enabled: true,
    lookbackMs: 30 * 60 * 1_000,
    sampleLimit: 50,
    minSamples: 5,
    minExactFillRate: 0.4,
  });
  assert.match(reason ?? "", /Polymarket exact paired fill rate 0.0% below 40.0%/);
});

test("live executor hard-locks quarantined fills when exposure cap would be exceeded", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const monitor = new FakeConfirmationMonitor();
  monitor.confirmations = {
    kalshi: { status: "timeout", reason: "kalshi stream did not confirm", fillCount: null, fillPrice: null },
    polymarket: { status: "confirmed", fillCount: 5, fillPrice: 0.84 },
  };
  const exposureReader = { unresolvedRiskQuarantineExposureDollars: async () => 6 };
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveParallelExecutionEnabled: true,
      liveUserStreamsEnabled: true,
      livePartialFillLockMode: "quarantine",
      liveMaxUnresolvedExposureDollars: 10,
    }),
    books,
    new FakeVenueClient("kalshi", {
      orderId: null,
      status: "unknown",
      fillPrice: null,
      fillCount: null,
      error: "order response timeout after 2500ms",
      metadata: {
        kalshiTimeoutRecoveryAttempted: true,
        kalshiTimeoutRecoveryStatus: "not_found",
      },
    }),
    new FakeVenueClient("polymarket", { status: "filled", fillCount: 5, fillPrice: 0.84 }),
    () => now,
    locks,
    undefined,
    monitor,
    exposureReader,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.match(result.liveLockReason ?? "", /private stream confirmation timeout/);
  assert.equal(result.riskQuarantinedAt, null);
  assert.equal(locks.engageCalls, 1);
});

test("live executor hard-locks partials when an open order cannot be ruled out", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const exposureReader = { unresolvedRiskQuarantineExposureDollars: async () => 0 };
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveParallelExecutionEnabled: true,
      livePartialFillLockMode: "quarantine",
      liveMaxUnresolvedExposureDollars: 10,
    }),
    books,
    new FakeVenueClient("kalshi", { status: "filled", fillCount: 5, fillPrice: 0.4 }),
    new FakeVenueClient("polymarket", {
      status: "unknown",
      fillCount: 0,
      fillPrice: null,
      error: "polymarket limit_rest cancellation/final state unverified",
      metadata: { polymarketOpenOrderCount: 1 },
    }),
    () => now,
    locks,
    undefined,
    undefined,
    exposureReader,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.match(result.liveLockReason ?? "", /timeout\/unknown|fill mismatch/);
  assert.equal(result.riskQuarantinedAt, null);
  assert.equal(locks.engageCalls, 1);
});

test("live executor preserves lock reason but suppresses automatic hardlock when disabled", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const monitor = new FakeConfirmationMonitor();
  monitor.confirmations = {
    kalshi: { status: "timeout", reason: "kalshi stream did not confirm", fillCount: null, fillPrice: null },
    polymarket: { status: "confirmed", fillCount: 5, fillPrice: 0.84 },
  };
  const exposureReader = { unresolvedRiskQuarantineExposureDollars: async () => 6 };
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveParallelExecutionEnabled: true,
      liveUserStreamsEnabled: true,
      livePartialFillLockMode: "quarantine",
      liveMaxUnresolvedExposureDollars: 10,
      liveAutoHardlocksEnabled: false,
    }),
    books,
    new FakeVenueClient("kalshi", {
      orderId: null,
      status: "unknown",
      fillPrice: null,
      fillCount: null,
      error: "order response timeout after 2500ms",
      metadata: {
        kalshiTimeoutRecoveryAttempted: true,
        kalshiTimeoutRecoveryStatus: "not_found",
      },
    }),
    new FakeVenueClient("polymarket", { status: "filled", fillCount: 5, fillPrice: 0.84 }),
    () => now,
    locks,
    undefined,
    monitor,
    exposureReader,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.match(result.liveLockReason ?? "", /private stream confirmation timeout/);
  assert.equal(result.recoveryStatus, "operator_required");
  assert.equal(locks.engageCalls, 0);
  const readiness = await executor.readiness(now);
  assert.equal(readiness.riskState, "auto_hardlocks_disabled");
  assert.equal(readiness.partialFillLocked, false);
  assert.equal(readiness.circuitBreakerLocked, false);
});

test("live executor does not lock when both parallel limit orders cancel with zero fills", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveParallelExecutionEnabled: true }),
    books,
    new FakeVenueClient("kalshi", { status: "canceled", fillCount: 0, error: "kalshi limit_rest order canceled without exact fill" }),
    new FakeVenueClient("polymarket", { status: "canceled", fillCount: 0, error: "polymarket limit_rest order canceled without exact fill" }),
    () => now,
    locks,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "parallel_limit_rest");
  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, false);
  assert.equal(result.liveLockReason, null);
  assert.equal(result.recoveryStatus, "auto_resolved_no_exposure");
  assert.match(result.reconciliationResolutionReason ?? "", /verified both venues have zero fill/);
  assert.equal(locks.engageCalls, 0);
});

test("live executor locks when aggressive limit cancellation cannot be verified", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveParallelExecutionEnabled: true }),
    books,
    new FakeVenueClient("kalshi", { status: "unknown", fillCount: 0, error: "kalshi limit_rest cancellation/final state unverified" }),
    new FakeVenueClient("polymarket", { status: "canceled", fillCount: 0, error: "polymarket limit_rest order canceled without exact fill" }),
    () => now,
    locks,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "parallel_limit_rest");
  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, false);
  assert.match(result.liveLockReason ?? "", /timeout\/unknown/);
  assert.equal(result.recoveryStatus, "operator_required");
  assert.equal(locks.engageCalls, 1);
});

test("live executor locks parallel Polymarket partial and overfills", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  for (const fillCount of [2, 6]) {
    const books = new BookStore();
    books.setPolymarketContracts([lower]);
    books.setKalshiContracts([higher]);
    const locks = new FakeLiveLockStore();
    const executor = new LiveExecutor(
      config({ liveOrderSize: 5, liveParallelExecutionEnabled: true }),
      books,
      new FakeVenueClient("kalshi", { fillCount: 5 }),
      new FakeVenueClient("polymarket", { fillCount, status: "filled", fillPrice: 0.4 }),
      () => now,
      locks,
    );

    const result = await executor.execute(candidate);

    assert.equal(result.executionStrategy, "parallel_limit_rest");
    assert.equal(result.action, "failed");
    assert.equal(result.partialFill, true);
    assert.match(result.liveLockReason ?? "", /venue fill mismatch|venue unexpected fill count/);
    assert.equal(locks.engageCalls, 1);
  }
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
  assert.equal(typeof result.executionTimings?.polymarketConfirmationMs, "number");
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

test("live hot-path user stream outage bounded-retries before skipping without a persistent lock", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const locks = new FakeLiveLockStore();
  class FlappingMonitor extends FakeConfirmationMonitor {
    preflightCalls = 0;

    async preflight(): Promise<string | null> {
      this.preflightCalls += 1;
      return "Polymarket user stream is not subscribed";
    }
  }
  const monitor = new FlappingMonitor();
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveUserStreamsEnabled: true, liveUserStreamPretradeGraceMs: 750, liveHotPathEnabled: true, livePretradeRetryAttempts: 2, livePretradeRetryDelayMs: 1 }),
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
  assert.match(result.failureReason ?? "", /live hot-path user stream preflight skipped/);
  assert.equal(result.recoveryStatus, "pretrade_retry");
  assert.equal(result.recoveryAttempts, 2);
  assert.equal(monitor.preflightCalls, 3);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarket.placed.length, 0);
  assert.equal(locks.engageCalls, 0);
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

test("live executor bounded-retries transient pre-trade user stream state before submitting orders", async () => {
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
      return this.preflightCalls < 3 ? "refreshing Polymarket user subscriptions" : null;
    }
  }
  const monitor = new ReconnectingMonitor();
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, liveUserStreamsEnabled: true, liveUserStreamPretradeGraceMs: 0, livePretradeRetryAttempts: 2, livePretradeRetryDelayMs: 1 }),
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
  assert.equal(result.recoveryStatus, "pretrade_retry");
  assert.equal(result.recoveryAttempts, 2);
  assert.equal(monitor.preflightCalls, 3);
  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed.length, 1);
  assert.equal(locks.engageCalls, 0);
});

test("live executor bounded-retries stale hot-path preflight cache before submitting orders", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  class StaleThenReadyClient extends FakeVenueClient {
    preflightCalls = 0;

    async preflightOrder(): Promise<string | null> {
      this.preflightCalls += 1;
      return this.preflightCalls === 1
        ? "Polymarket hot readiness cache is stale: age 6000ms exceeds 5000ms"
        : null;
    }
  }
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new StaleThenReadyClient("polymarket");
  const executor = new LiveExecutor(
    config({ liveOrderSize: 5, livePretradeRetryAttempts: 2, livePretradeRetryDelayMs: 1 }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.equal(result.recoveryStatus, "pretrade_retry");
  assert.equal(result.recoveryAttempts, 1);
  assert.equal(polymarket.preflightCalls, 2);
  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed.length, 1);
});

test("live executor blocks persistent pre-trade reconciliation failures without creating a new lock", async () => {
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
  assert.match(result.failureReason ?? "", /live preflight blocked before order submission/);
  assert.equal(result.liveLockReason, undefined);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarket.placed.length, 0);
  assert.equal(locks.engageCalls, 0);
  assert.equal(await locks.getActiveLock(), null);
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

test("live executor ignores persistent circuit breakers while auto-hardlocks are disabled", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  await locks.engageLock({ reason: "manual incident lock", executionGroupId: "prior-group" });
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(config({ liveOrderSize: 5, liveAutoHardlocksEnabled: false }), books, kalshi, polymarket, () => now, locks);

  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed.length, 1);
  const readiness = await executor.readiness(now);
  assert.equal(readiness.riskState, "auto_hardlocks_disabled");
  assert.equal(readiness.circuitBreakerLocked, false);
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

test("live executor does not submit Polymarket when Kalshi hedge collateral preflight fails", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  class InsufficientKalshiCollateralClient extends FakeVenueClient {
    async preflightOrder(): Promise<string | null> {
      return "Kalshi cash balance 0.03 is below required operating cash 4.41";
    }
  }
  const kalshi = new InsufficientKalshiCollateralClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(config({ liveOrderSize: 8 }), books, kalshi, polymarket, () => now);

  const result = await executor.execute(candidate);

  assert.equal(result.action, "skipped");
  assert.match(result.failureReason ?? "", /Kalshi cash balance 0.03 is below required operating cash/);
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

  const rawEdgeOnlyBooks = new BookStore();
  rawEdgeOnlyBooks.setPolymarketContracts([{ ...lower, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 999 }], updatedAt: now }]);
  rawEdgeOnlyBooks.setKalshiContracts([{ ...higher, noAsk: 0.55, noAskLevels: [{ price: 0.55, size: 999 }], updatedAt: now }]);
  const rawEdgeOnlyExecutor = new LiveExecutor(config(), rawEdgeOnlyBooks, kalshi, polymarket, () => now);
  const rawEdgeOnly = await rawEdgeOnlyExecutor.execute(candidate);
  assert.equal(rawEdgeOnly.action, "skipped");
  assert.match(rawEdgeOnly.failureReason ?? "", /cushioned executable edge 0.0100 below threshold 0.0500/);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarket.placed.length, 0);
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
