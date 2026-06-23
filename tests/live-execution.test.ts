import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetType, OrderType, Side, type BalanceAllowanceResponse, type SignedOrder } from "@polymarket/clob-client-v2";
import type { AppConfig } from "../src/config";
import { loadConfig } from "../src/config";
import { BookStore } from "../src/books/book-store";
import { LiveExecutor } from "../src/execution/executor";
import {
  buildKalshiUiQuickOrderBody,
  buildKalshiV2OrderBody,
  checkPolymarketGeoblock,
  createKalshiOrderClient,
  deriveOrCreatePolymarketApiCreds,
  KalshiOrderClient,
  KalshiFixOrderClient,
  type KalshiFixOrderSessionLike,
  KalshiUiQuickOrderClient,
  polymarketApiCredsFromConfig,
  resolvePolymarketApiCreds,
  resetPolymarketApiCredsMemo,
  isPolymarketAuthError,
  PolymarketOrderClient,
  type LiveOrderContext,
  type PolymarketGeoblockChecker,
  type PolymarketClobLike,
  type VenueOrderClient,
  type VenueOrderResult,
  type VenueUnwindOutcome,
  type VenueUnwindRequest,
} from "../src/execution/live-clients";
import { LiveExposureCache } from "../src/execution/live-hot-path";
import type { LiveExecutionLockInput, LiveExecutionLockWriter } from "../src/db/live-execution-locks";
import { buildDeadZoneCandidate, buildGuaranteedCandidate } from "../src/scanner/payoff";
import type { ArbLeg, DashboardSignal, LiveExecutionLock, Venue, VenueExecutionReadiness } from "../src/types";
import { buildUserStreamReadiness, defaultReconciliationReadiness, type VenueConfirmationMonitor, type VenueConfirmationResult } from "../src/execution/venue-confirmations";
import { buildKalshiFixNewOrderFields, encodeFixMessage, extractFixMessages, kalshiFixLimitPriceField, parseFixMessage, parseKalshiFixExecutionReport, type KalshiFixOrderInput } from "../src/kalshi/fix";
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
    kalshiUiApiBase: "https://api.elections.kalshi.com",
    kalshiUiSessionPath: "/etc/pok-poly-kalshi/kalshi-ui-session.json",
    kalshiUiMarketIdCacheTtlMs: 60_000,
    kalshiUiQuickOrderCapValidated: false,
    kalshiFixHost: "mm.fix.elections.kalshi.com",
    kalshiFixPort: 8228,
    kalshiFixSenderCompId: "test-key",
    kalshiFixTargetCompId: "KalshiNR",
    kalshiFixHeartbeatSeconds: 10,
    kalshiFixConnectTimeoutMs: 1_500,
    kalshiFixOrderResponseTimeoutMs: 2_500,
    kalshiFixUseDollars: true,
    kalshiFixEnableIocCancelReport: true,
    kalshiFixPreserveOriginalOrderQty: true,
    kalshiWsUrl: "",
    kalshiSeriesTicker: "KXBTC15M",
    polymarketWsUrl: "",
    polymarketBookFeedSilenceMs: 30_000,
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
    polymarketGeoblockGateEnabled: true,
    polymarketOrderType: "FOK",
    liveOrderSize: 1,
    liveDynamicSizingEnabled: false,
    liveMinOrderSize: 1,
    liveMaxOrderSize: 1,
    liveDynamicSizingMaxKalshiSlippageCents: 10,
    liveTakerPriceCushionCents: 2,
    liveFeeAwareGateEnabled: false,
    liveMinExpiryMs: 30_000,
    liveMaxTradesPerWindow: 3,
    liveCollateralBufferDollars: 0.25,
    liveKalshiMinCashDollars: 0,
    liveQuoteMaxAgeMs: 750,
    livePolymarketQuoteMaxAgeMs: 750,
    liveHedgeQuoteMaxAgeMs: 750,
    liveQuoteSyncMaxSkewMs: 250,
    liveMinBookDepthShares: 1,
    liveMinExecutableLiquidityShares: 0,
    liveMaxExecutableAskSlippageCents: 0,
    liveShadowLadderCaptureEnabled: false,
    liveShadowLadderProbeSizes: [1, 2, 3, 5],
    liveOrderTimeoutMs: 2_500,
    liveHedgeMaxLossDollars: 0.02,
    liveHedgeFeeBufferDollars: 0.01,
    liveHedgeMinCrossTicks: 2,
    liveHedgeRetryAttempts: 0,
    liveHedgeRetryBudgetMs: 1_500,
    livePolymarketFirstCrossCents: 0,
    liveOrderPlacementMode: "parallel_limit_rest",
    kalshiHedgeOrderMode: "public_v2",
    liveAggressiveLimitRestMs: 500,
    liveParallelExecutionEnabled: false,
    liveHotPathEnabled: false,
    liveHotPathCacheMaxAgeMs: 5_000,
    liveHotPathWarmIntervalMs: 1_000,
    livePolymarketPresignEnabled: false,
    livePolymarketSignedOrderTtlMs: 5_000,
    livePolymarketFirstMinFillShares: 7,
    livePolymarketFirstMaxFillShares: 9,
    liveKalshiHedgeTimeInForce: "immediate_or_cancel",
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
    liveConfirmationFlatMissNonBlocking: true,
    liveConfirmationOverfillTolerant: false,
    liveConfirmationAcceptRestEvidence: false,
    livePolymarketTimeoutRecoveryResolvesNoFill: false,
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
    liveAutoUnwindEnabled: false,
    liveAutoUnwindMaxLossDollars: 0.05,
    liveAutoUnwindTimeoutMs: 1_500,
    kalshiUserWsUrl: "",
    polymarketUserWsUrl: "",
    dashboardApiToken: "token",
    ...input,
  };
}

function kalshiUiSessionFile(input: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "kalshi-ui-session-"));
  const path = join(dir, "session.json");
  writeFileSync(path, JSON.stringify({
    userId: "user-123",
    cookie: "kalshi_session=test-session",
    csrfToken: "csrf-test",
    ...input,
  }));
  chmodSync(path, 0o600);
  return path;
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

// Implements the optional C1 unwind adapter with a fixed configurable outcome.
class UnwindableVenueClient extends FakeVenueClient {
  unwindCalls = 0;
  lastUnwindRequest: VenueUnwindRequest | null = null;

  constructor(venue: Venue, result: Partial<VenueOrderResult>, private readonly outcome: VenueUnwindOutcome | null) {
    super(venue, result);
  }

  async unwindPosition(request: VenueUnwindRequest): Promise<VenueUnwindOutcome | null> {
    this.unwindCalls += 1;
    this.lastUnwindRequest = request;
    return this.outcome;
  }
}

// Returns a different result per call (last entry repeats) so a retry path can be exercised.
class SequencedVenueClient extends FakeVenueClient {
  private call = 0;

  constructor(venue: Venue, private readonly results: Partial<VenueOrderResult>[]) {
    super(venue);
  }

  async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
    const spec = this.results[Math.min(this.call, this.results.length - 1)] ?? {};
    this.call += 1;
    this.placed.push({ leg, context });
    return {
      venue: this.venue,
      clientOrderId: context.clientOrderId,
      orderId: `${this.venue}-order-${this.call}`,
      status: "filled",
      fillPrice: leg.ask,
      fillCount: context.size,
      requestedAt: "2026-04-29T20:00:00.000Z",
      respondedAt: "2026-04-29T20:00:00.050Z",
      error: null,
      ...spec,
    };
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
  }, { executionGroupId: "group", clientOrderId: "client-yes", size: 1, maxBuyPrice: 0.41, placementMode: "polymarket_first_exact" });

  assert.equal(yes.ticker, "KXBTC15M-YES");
  assert.equal(yes.side, "bid");
  assert.equal(yes.price, "0.4100");
  assert.equal(yes.count, "1.00");
  assert.equal(yes.time_in_force, "immediate_or_cancel");
  assert.equal("order_group_id" in yes, false);

  const no = buildKalshiV2OrderBody({
    venue: "kalshi",
    contractId: "KXBTC15M-NO",
    direction: "no",
    strike: 1502,
    ask: 0.5,
  }, { executionGroupId: "group", clientOrderId: "client-no", size: 1, maxBuyPrice: 0.51, placementMode: "polymarket_first_exact" });

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

  const parallelQuick = buildKalshiV2OrderBody({
    venue: "kalshi",
    contractId: "KXBTC15M-QUICK",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
  }, {
    executionGroupId: "group",
    clientOrderId: "client-quick",
    size: 1,
    maxBuyPrice: 0.41,
    placementMode: "parallel_quick",
  });
  assert.equal(parallelQuick.time_in_force, "immediate_or_cancel");

  const configuredFok = buildKalshiV2OrderBody({
    venue: "kalshi",
    contractId: "KXBTC15M-FOK",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
  }, {
    executionGroupId: "group",
    clientOrderId: "client-fok",
    size: 1,
    maxBuyPrice: 0.41,
    placementMode: "polymarket_first_exact",
  }, { hedgeTimeInForce: "fill_or_kill" });
  assert.equal(configuredFok.time_in_force, "fill_or_kill");

  // T1.3: the Kalshi FIRST leg under kalshi_first_exact is always atomic FOK (exact integer size or 0),
  // independent of the configured hedge TIF. Locks in the default-branch behavior of kalshiTimeInForce.
  const kalshiFirst = buildKalshiV2OrderBody({
    venue: "kalshi",
    contractId: "KXBTC15M-KFIRST",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
  }, {
    executionGroupId: "group",
    clientOrderId: "client-kfirst",
    size: 1,
    maxBuyPrice: 0.41,
    placementMode: "kalshi_first_exact",
  }, { hedgeTimeInForce: "immediate_or_cancel" });
  assert.equal(kalshiFirst.time_in_force, "fill_or_kill");
});

test("Kalshi UI Quick Order body maps YES and NO legs onto user-side market orders", () => {
  const yes = buildKalshiUiQuickOrderBody({
    venue: "kalshi",
    contractId: "KXBTC15M-YES",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
  }, { executionGroupId: "group", clientOrderId: "client-yes", size: 5, maxBuyPrice: 0.61 }, "market-yes");

  assert.equal(yes.market_id, "market-yes");
  assert.equal(yes.count_fp, "5.00");
  assert.equal(yes.side, "yes");
  assert.equal(yes.user_side, "yes");
  assert.equal(yes.order_action, "buy");
  assert.equal(yes.order_type, "market");
  assert.equal(yes.time_in_force, "immediate_or_cancel");
  assert.equal(yes.post_only, false);
  assert.equal(yes.price_dollars, "0.6100");
  assert.equal(yes.max_cost_cents, 305);

  const no = buildKalshiUiQuickOrderBody({
    venue: "kalshi",
    contractId: "KXBTC15M-NO",
    direction: "no",
    strike: 1502,
    ask: 0.5,
  }, { executionGroupId: "group", clientOrderId: "client-no", size: 1.77, maxBuyPrice: 0.54 }, "market-no");

  assert.equal(no.side, "no");
  assert.equal(no.user_side, "no");
  assert.equal(no.price_dollars, "0.5400");
  assert.equal(no.max_cost_cents, 95);
});

test("Kalshi UI Quick Order readiness fails closed until cap behavior is validated", async () => {
  const sessionPath = kalshiUiSessionFile();
  const client = new KalshiUiQuickOrderClient(config({
    kalshiHedgeOrderMode: "ui_quick_order",
    kalshiUiSessionPath: sessionPath,
    kalshiUiQuickOrderCapValidated: false,
  }), (async (url: Parameters<typeof fetch>[0]): Promise<Response> => {
    if (new URL(String(url)).pathname.endsWith("/portfolio/balance")) {
      return new Response(JSON.stringify({ balance_dollars: "100.00" }), { status: 200 });
    }
    throw new Error("readiness should not call private UI endpoints when cap validation is false");
  }) as typeof fetch);

  const readiness = await withKalshiEnv(() => client.readiness(1_800_000_000_000));

  assert.equal(readiness.ready, false);
  assert.match(readiness.reason ?? "", /CAP_VALIDATED/);
});

test("Kalshi UI Quick Order client refuses unsupported placement modes", async () => {
  const client = new KalshiUiQuickOrderClient(config({
    kalshiHedgeOrderMode: "ui_quick_order",
  }));
  const leg: ArbLeg = { venue: "kalshi", contractId: "KXBTC15M-MARKET", direction: "yes", strike: 1500, ask: 0.5 };
  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client-ui",
    size: 1,
    maxBuyPrice: 0.5,
    placementMode: "parallel_market",
  };

  assert.match(await client.preflightOrder(leg, context) ?? "", /only supported/);
  await assert.rejects(() => client.placeOrder(leg, context), /only supported/);
});

test("Kalshi UI Quick Order client resolves UI market id and posts market IOC order", async () => {
  const sessionPath = kalshiUiSessionFile();
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown>; cookie?: string | null; csrf?: string | null }> = [];
  const fetchFn = async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const parsed = new URL(String(url));
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string> | undefined;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ method, path: parsed.pathname, body, cookie: headers?.Cookie ?? null, csrf: headers?.["X-CSRF-Token"] ?? null });
    if (parsed.pathname.endsWith("/portfolio/balance")) {
      return new Response(JSON.stringify({ balance_dollars: "100.00" }), { status: 200 });
    }
    if (parsed.pathname.endsWith("/event_positions/KXBTC15M-26JUN140300")) {
      return new Response(JSON.stringify({
        event_position: {
          market_positions: [{
            market_id: "ui-market-123",
            market_ticker: "KXBTC15M-26JUN140300-00",
          }],
        },
      }), { status: 200 });
    }
    if (method === "POST" && parsed.pathname.endsWith("/orders")) {
      assert.equal(body?.order_type, "market");
      assert.equal(body?.time_in_force, "immediate_or_cancel");
      assert.equal(body?.market_id, "ui-market-123");
      return new Response(JSON.stringify({
        order: {
          order_id: "ui-order-1",
          market_id: "ui-market-123",
          market_ticker: "KXBTC15M-26JUN140300-00",
          status: "pending",
          order_type: "market",
          user_side: "yes",
          price_dollars: "0.5400",
          fill_count_fp: "1.00",
          remaining_count_fp: "0.00",
        },
      }), { status: 201 });
    }
    if (method === "GET" && parsed.pathname.endsWith("/orders/ui-order-1")) {
      return new Response(JSON.stringify({
        order: {
          order_id: "ui-order-1",
          market_id: "ui-market-123",
          market_ticker: "KXBTC15M-26JUN140300-00",
          status: "executed",
          order_type: "market",
          user_side: "yes",
          price_dollars: "0.5400",
          fill_count_fp: "1.00",
          remaining_count_fp: "0.00",
          taker_fill_cost_dollars: "0.5400",
          taker_fees_dollars: "0.0100",
          updated_ts: "2026-06-14T06:49:27.93588Z",
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  };
  const client = new KalshiUiQuickOrderClient(config({
    kalshiHedgeOrderMode: "ui_quick_order",
    kalshiUiSessionPath: sessionPath,
    kalshiUiQuickOrderCapValidated: true,
  }), fetchFn as typeof fetch);
  const leg: ArbLeg = { venue: "kalshi", contractId: "KXBTC15M-26JUN140300-00", direction: "yes", strike: 1500, ask: 0.54 };
  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client-ui",
    size: 1,
    maxBuyPrice: 0.54,
    placementMode: "polymarket_first_exact",
  };

  const result = await withKalshiEnv(async () => {
    assert.equal(await client.preflightOrder(leg, context), null);
    return client.placeOrder(leg, context);
  });

  const post = calls.find((call) => call.method === "POST" && call.path.endsWith("/orders"));
  assert.ok(post);
  assert.equal(post.cookie, "kalshi_session=test-session");
  assert.equal(post.csrf, "csrf-test");
  assert.equal(result.status, "filled");
  assert.equal(result.fillPrice, 0.54);
  assert.equal(result.fee, 0.01);
  assert.equal(result.metadata?.kalshiOrderRoute, "ui_quick_order");
  assert.equal(result.metadata?.kalshiUiFinalRecordUsed, true);
});

test("Kalshi UI Quick Order client supports captured WAF-header session without cookie in parallel_quick", async () => {
  const sessionPath = kalshiUiSessionFile({
    cookie: null,
    headers: { "x-aws-waf-token": "waf-test" },
  });
  const calls: Array<{ method: string; path: string; cookie?: string | null; csrf?: string | null; waf?: string | null }> = [];
  const fetchFn = async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const parsed = new URL(String(url));
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      method,
      path: parsed.pathname,
      cookie: headers?.Cookie ?? null,
      csrf: headers?.["X-CSRF-Token"] ?? null,
      waf: headers?.["x-aws-waf-token"] ?? null,
    });
    if (parsed.pathname.endsWith("/portfolio/balance")) {
      return new Response(JSON.stringify({ balance_dollars: "100.00" }), { status: 200 });
    }
    if (parsed.pathname.endsWith("/event_positions/KXBTC15M-26JUN140300")) {
      return new Response(JSON.stringify({
        event_position: {
          market_positions: [{
            market_id: "ui-market-123",
            market_ticker: "KXBTC15M-26JUN140300-00",
          }],
        },
      }), { status: 200 });
    }
    if (method === "POST" && parsed.pathname.endsWith("/orders")) {
      return new Response(JSON.stringify({
        order: {
          order_id: "ui-order-1",
          market_id: "ui-market-123",
          market_ticker: "KXBTC15M-26JUN140300-00",
          status: "executed",
          user_side: "yes",
          price_dollars: "0.5400",
          fill_count_fp: "1.00",
          remaining_count_fp: "0.00",
        },
      }), { status: 201 });
    }
    if (method === "GET" && parsed.pathname.endsWith("/orders/ui-order-1")) {
      return new Response(JSON.stringify({
        order: {
          order_id: "ui-order-1",
          market_id: "ui-market-123",
          market_ticker: "KXBTC15M-26JUN140300-00",
          status: "executed",
          user_side: "yes",
          price_dollars: "0.5400",
          fill_count_fp: "1.00",
          remaining_count_fp: "0.00",
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  };
  const client = new KalshiUiQuickOrderClient(config({
    kalshiHedgeOrderMode: "ui_quick_order",
    kalshiUiSessionPath: sessionPath,
    kalshiUiQuickOrderCapValidated: true,
  }), fetchFn as typeof fetch);
  const leg: ArbLeg = { venue: "kalshi", contractId: "KXBTC15M-26JUN140300-00", direction: "yes", strike: 1500, ask: 0.54 };
  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client-ui",
    size: 1,
    maxBuyPrice: 0.54,
    placementMode: "parallel_quick",
  };

  const result = await withKalshiEnv(() => client.placeOrder(leg, context));
  const post = calls.find((call) => call.method === "POST" && call.path.endsWith("/orders"));

  assert.ok(post);
  assert.equal(post.cookie, null);
  assert.equal(post.csrf, "csrf-test");
  assert.equal(post.waf, "waf-test");
  assert.equal(result.status, "filled");
  assert.equal(result.metadata?.orderPlacementMode, "parallel_quick");
});

test("Kalshi order client factory selects UI Quick Order mode only when configured", () => {
  assert.ok(createKalshiOrderClient(config()) instanceof KalshiOrderClient);
  assert.ok(createKalshiOrderClient(config({ kalshiHedgeOrderMode: "ui_quick_order" })) instanceof KalshiUiQuickOrderClient);
  assert.ok(createKalshiOrderClient(config({ kalshiHedgeOrderMode: "fix_ioc" })) instanceof KalshiFixOrderClient);
});

test("Kalshi FIX helpers build capped IOC limit orders with strict price rounding", () => {
  assert.equal(kalshiFixLimitPriceField(0.615, "yes", true), "0.6150");
  assert.equal(kalshiFixLimitPriceField(0.615, "yes", false), "61");
  assert.equal(kalshiFixLimitPriceField(0.385, "no", false), "39");

  const fields = buildKalshiFixNewOrderFields({
    clientOrderId: "client-fix",
    symbol: "KXBTC15M-26JUN140300-00",
    direction: "yes",
    quantity: 5,
    yesBookLimitPrice: 0.615,
    maxExecutionCostDollars: 3.075,
    timeInForce: "immediate_or_cancel",
    orderGroupId: "group-1",
  }, { useDollars: true }, "20260614-21:00:00.123");
  const byTag = Object.fromEntries(fields.map(([tag, value]) => [String(tag), String(value)]));
  assert.equal(byTag["11"], "client-fix");
  assert.equal(byTag["38"], "5.00");
  assert.equal(byTag["40"], "2");
  assert.equal(byTag["44"], "0.6150");
  assert.equal(byTag["54"], "1");
  assert.equal(byTag["59"], "3");
  assert.equal(byTag["2964"], "1");
  assert.equal(byTag["21006"], "true");
  assert.equal(byTag["21009"], "3.0750");

  const encoded = encodeFixMessage([[35, "D"], [34, 2], [49, "sender"], [56, "KalshiNR"], ...fields]);
  const extracted = extractFixMessages(`noise${encoded}`).messages;
  assert.equal(extracted.length, 1);
  const parsed = parseFixMessage(extracted[0]);
  assert.equal(parsed["8"], "FIXT.1.1");
  assert.equal(parsed["35"], "D");
  assert.equal(parsed["11"], "client-fix");
  assert.match(parsed["10"], /^\d{3}$/);
});

test("Kalshi FIX execution reports parse fill, fee, and timestamps", () => {
  const report = parseKalshiFixExecutionReport({
    "11": "client-fix",
    "14": "5.00",
    "17": "4;7",
    "37": "order-fix",
    "39": "2",
    "6": "0.6100",
    "137": "0.0020",
    "150": "F",
    "151": "0.00",
    "60": "20260614-21:00:00.123",
  }, true);
  assert.equal(report.clientOrderId, "client-fix");
  assert.equal(report.orderId, "order-fix");
  assert.equal(report.cumulativeQuantity, 5);
  assert.equal(report.averageYesBookPrice, 0.61);
  assert.equal(report.feeDollars, 0.002);
  assert.equal(report.exchangeTimestampMs, Date.parse("2026-06-14T21:00:00.123Z"));
});

test("Kalshi FIX order client submits NO hedge through capped supported IOC route", async () => {
  let placed: KalshiFixOrderInput | null = null;
  const session: KalshiFixOrderSessionLike = {
    async readiness() {
      return { ready: true, reason: null };
    },
    async warm() {
      return undefined;
    },
    async placeOrder(input) {
      placed = input;
      return {
        clientOrderId: input.clientOrderId,
        orderId: "fix-order-1",
        status: "filled",
        fillCount: input.quantity,
        averageYesBookPrice: input.yesBookLimitPrice,
        feeDollars: 0.001,
        exchangeTimestampMs: Date.parse("2026-06-14T21:00:00.123Z"),
        text: null,
        ambiguous: false,
        reports: [{
          clientOrderId: input.clientOrderId,
          orderId: "fix-order-1",
          execId: "1;1",
          ordStatus: "2",
          execType: "F",
          text: null,
          cumulativeQuantity: input.quantity,
          leavesQuantity: 0,
          averageYesBookPrice: input.yesBookLimitPrice,
          lastYesBookPrice: input.yesBookLimitPrice,
          lastQuantity: input.quantity,
          feeDollars: 0.001,
          exchangeTimestampMs: Date.parse("2026-06-14T21:00:00.123Z"),
          rawTags: {},
        }],
      };
    },
  };
  const fetchFn = async (): Promise<Response> => new Response(JSON.stringify({ balance_dollars: "100.00" }), { status: 200 });
  const client = new KalshiFixOrderClient(config({
    kalshiHedgeOrderMode: "fix_ioc",
    liveKalshiHedgeTimeInForce: "immediate_or_cancel",
  }), fetchFn as typeof fetch, session);
  const leg: ArbLeg = { venue: "kalshi", contractId: "KXBTC15M-26JUN140300-00", direction: "no", strike: 1500, ask: 0.61 };
  const context: LiveOrderContext = {
    executionGroupId: "group",
    clientOrderId: "client-fix",
    size: 5,
    maxBuyPrice: 0.61,
    requiredCollateral: 3.3,
    placementMode: "parallel_quick",
  };

  const reason = await withKalshiEnv(() => client.preflightOrder(leg, context));
  assert.equal(reason, null);
  const result = await withKalshiEnv(() => client.placeOrder(leg, context));

  assert.ok(placed);
  assert.equal(placed.clientOrderId, "client-fix");
  assert.equal(placed.symbol, leg.contractId);
  assert.equal(placed.direction, "no");
  assert.equal(placed.quantity, 5);
  assert.equal(placed.yesBookLimitPrice, 0.39);
  assert.equal(placed.maxExecutionCostDollars, 3.05);
  assert.equal(placed.timeInForce, "immediate_or_cancel");
  assert.equal(result.status, "filled");
  assert.equal(result.fillPrice, 0.61);
  assert.equal(result.metadata?.kalshiOrderRoute, "fix_ioc");
  assert.equal(result.metadata?.kalshiFixMaxExecutionCostDollars, 3.05);
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

test("LA1: Kalshi preflight reuses a warm, margin-covered readiness cache but forces a fresh balance check when thin", async () => {
  const makeClient = (balanceDollars: string) => {
    let balanceCalls = 0;
    const fetchFn = async (url: Parameters<typeof fetch>[0]): Promise<Response> => {
      if (new URL(String(url)).pathname.endsWith("/portfolio/balance")) {
        balanceCalls += 1;
        return new Response(JSON.stringify({ balance_dollars: balanceDollars }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    };
    const client = new KalshiOrderClient(config({ liveKalshiPrearmEnabled: false }), fetchFn as typeof fetch);
    return { client, balanceCalls: () => balanceCalls };
  };
  const leg: ArbLeg = { venue: "kalshi", contractId: "KXBTC15M-LA1", direction: "yes", strike: 1500, ask: 0.5 };
  const base: LiveOrderContext = { executionGroupId: "g", clientOrderId: "c", size: 5, maxBuyPrice: 1, requiredCollateral: 5.25, placementMode: "polymarket_first_exact" };

  // Funded with headroom ($100 >> 5.25 + margin): first preflight forces a fetch and warms the cache; the
  // second (the executor's refreshed preflight) reuses it -> only ONE balance RTT.
  await withKalshiEnv(async () => {
    const { client, balanceCalls } = makeClient("100.00");
    assert.equal(await client.preflightOrder(leg, { ...base, requestedAt: 1_000 }), null);
    assert.equal(await client.preflightOrder(leg, { ...base, requestedAt: 1_010 }), null);
    assert.equal(balanceCalls(), 1);
  });

  // Thin balance (5.50, only ~0.25 over the 5.25 requirement): the safety margin forces a fresh balance check
  // every time so a recent drawdown cannot let an underfunded hedge through -> TWO balance RTTs.
  await withKalshiEnv(async () => {
    const { client, balanceCalls } = makeClient("5.50");
    assert.equal(await client.preflightOrder(leg, { ...base, requestedAt: 1_000 }), null);
    assert.equal(await client.preflightOrder(leg, { ...base, requestedAt: 1_010 }), null);
    assert.equal(balanceCalls(), 2);
  });
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

test("Polymarket order client uses exact-share FAK limit order in parallel_quick mode", async () => {
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
    placementMode: "parallel_quick",
  });

  assert.equal(fake.createdOrder?.tokenID, "yes-token");
  assert.equal(fake.createdOrder?.price, 0.8);
  assert.equal(fake.createdOrder?.size, 5);
  assert.equal(fake.createdMarketOrder, null);
  assert.equal(fake.postedType, OrderType.FAK);
  assert.equal(result.status, "matched");
  assert.equal(result.metadata?.orderPlacementMode, "parallel_quick");
  assert.equal(result.metadata?.polymarketOrderKind, "share_limit");
  assert.equal(result.metadata?.polymarketRequestedShares, 5);
  assert.equal(result.metadata?.polymarketRequestedSpend, 4);
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

test("Polymarket timeout recovery stamps the order type on a not_found result (lock-24/25/26 fix)", async () => {
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
      return [];
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
  // An executor-level REST-response timeout synthesizes the timed-out result WITHOUT polymarketOrderType
  // (only the client-level postOrder result carries it). This is the exact input that caused the recurring
  // false no-fill-timeout lock: recovery resolves not_found, but isVerifiedNoFillAfterRecovery cannot recognize
  // it because the order type was dropped.
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
      orderResponseTimeoutMs: 2_500,
      pendingReconciliation: true,
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
    placementMode: "polymarket_first_exact",
  }, timedOut);

  assert.equal(result?.status, "unknown");
  assert.equal(result?.fillCount ?? null, null);
  assert.equal(result?.metadata?.polymarketTimeoutRecoveryStatus, "not_found");
  // The fix: the resolved order type is restored even though the timed-out result dropped it, so a downstream
  // isVerifiedNoFillAfterRecovery check can recognize this leg as the zero-exposure FAK no-fill it is.
  assert.equal(result?.metadata?.polymarketOrderType, "FAK");
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

test("resolvePolymarketApiCreds uses configured env creds without deriving (bypass)", async () => {
  resetPolymarketApiCredsMemo();
  const resolved = await resolvePolymarketApiCreds(config({
    polymarketApiKey: "env-key",
    polymarketApiSecret: "env-secret",
    polymarketApiPassphrase: "env-passphrase",
  }));
  assert.equal(resolved.source, "configured");
  assert.deepEqual(resolved.creds, { key: "env-key", secret: "env-secret", passphrase: "env-passphrase" });
});

test("Polymarket client retries after a transient factory failure instead of poisoning the cache", async () => {
  // A single api-key derive timeout previously cached the rejected client promise for the whole process,
  // blocking every subsequent order. The factory must be re-invoked after a failure.
  let calls = 0;
  const fake = {
    getBalanceAllowance: async () => ({ balance: "10000000", allowance: "10000000" }),
    updateBalanceAllowance: async () => {},
  } as unknown as PolymarketClobLike;
  const flakyFactory = async () => {
    calls += 1;
    if (calls === 1) throw new Error("Could not derive or create api key: timeout of 2500ms exceeded");
    return fake;
  };
  const client = new PolymarketOrderClient(config(), flakyFactory, allowedGeoblock);

  const first = await client.readiness();
  assert.equal(first.ready, false); // first attempt fails (derive timeout) — but must NOT poison

  const second = await client.readiness();
  assert.ok(calls >= 2, `factory should be retried after a failure, but was called ${calls} time(s)`);
  assert.equal(second.ready, true); // retry obtains the client and reads a healthy balance
});

test("isPolymarketAuthError detects 401 / unauthorized and ignores unrelated errors", () => {
  assert.equal(isPolymarketAuthError(Object.assign(new Error("nope"), { status: 401 })), true);
  assert.equal(isPolymarketAuthError({ response: { status: 401 } }), true);
  assert.equal(isPolymarketAuthError(new Error("401 Unauthorized")), true);
  assert.equal(isPolymarketAuthError(new Error("invalid api key")), true);
  assert.equal(isPolymarketAuthError(new Error("timeout of 2500ms exceeded")), false);
  assert.equal(isPolymarketAuthError(new Error("no orders found to match")), false);
  assert.equal(isPolymarketAuthError(null), false);
});

test("Polymarket client re-derives creds after a 401 (stale L2 key self-heals, not a permanent block)", async () => {
  resetPolymarketApiCredsMemo();
  // First-built client's balance call 401s (stale/expired creds); after invalidation the factory is
  // re-invoked and the freshly-built client reads a healthy balance.
  let factoryCalls = 0;
  const factory = async () => {
    factoryCalls += 1;
    if (factoryCalls === 1) {
      return {
        getBalanceAllowance: async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }); },
        updateBalanceAllowance: async () => {},
      } as unknown as PolymarketClobLike;
    }
    return {
      getBalanceAllowance: async () => ({ balance: "10000000", allowance: "10000000" }),
      updateBalanceAllowance: async () => {},
    } as unknown as PolymarketClobLike;
  };
  const client = new PolymarketOrderClient(config(), factory, allowedGeoblock);

  const first = await client.readiness();
  assert.equal(first.ready, false); // 401 → not ready, and the cached client must be invalidated

  const second = await client.readiness();
  assert.ok(factoryCalls >= 2, `client should re-derive after a 401, but factory was called ${factoryCalls} time(s)`);
  assert.equal(second.ready, true); // fresh creds → healthy balance → ready
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

test("Polymarket geoblock gate can be disabled so a blocked egress is advisory, not a hard block", async () => {
  class FundedFakeClob implements PolymarketClobLike {
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

  // blocked:true, but POLYMARKET_GEOBLOCK_GATE_ENABLED=false -> readiness must NOT short-circuit. It proceeds
  // to the live balance/creds check and goes green, while still reporting the geoblock verdict advisorily.
  let factoryCalls = 0;
  const advisory = new PolymarketOrderClient(config({
    polymarketGeoblockGateEnabled: false,
    polymarketSignatureType: 2,
    polymarketFunderAddress: "0xAC3b15cD52358c88c97C87FCB7fE67c1b9F0F2B0",
  }), async () => {
    factoryCalls += 1;
    return new FundedFakeClob();
  }, async (now) => ({
    blocked: true,
    country: "CA",
    region: "QC",
    checkedAt: now,
    reason: "Polymarket CLOB trading blocked from worker egress",
  }));
  const advisoryReadiness = await advisory.readiness(1_800_000_000_000);

  assert.equal(advisoryReadiness.ready, true);
  assert.equal(advisoryReadiness.reason, null);
  assert.equal(advisoryReadiness.balance, 9);
  // The geoblock verdict is still surfaced (so /health + the dashboard keep showing the true region).
  assert.equal(advisoryReadiness.geoblockBlocked, true);
  assert.equal(advisoryReadiness.geoblockCountry, "CA");
  assert.equal(advisoryReadiness.geoblockRegion, "QC");
  assert.equal(advisoryReadiness.geoblockCheckedAt, 1_800_000_000_000);
  assert.ok(factoryCalls > 0, "the live balance/creds path runs when the geoblock gate is advisory");

  // An unknown (blocked:null) verdict also stops hard-blocking once the gate is disabled.
  const unknownAdvisory = new PolymarketOrderClient(config({
    polymarketGeoblockGateEnabled: false,
    polymarketSignatureType: 2,
    polymarketFunderAddress: "0xAC3b15cD52358c88c97C87FCB7fE67c1b9F0F2B0",
  }), async () => new FundedFakeClob(), async (now) => ({
    blocked: null,
    country: null,
    region: null,
    checkedAt: now,
    reason: "Polymarket geoblock check failed: timeout",
  }));
  const unknownAdvisoryReadiness = await unknownAdvisory.readiness(1_800_000_000_500);

  assert.equal(unknownAdvisoryReadiness.ready, true);
  assert.equal(unknownAdvisoryReadiness.geoblockBlocked, null);
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
  assert.equal(loadConfig({ LIVE_ORDER_PLACEMENT_MODE: "parallel_quick" }).liveOrderPlacementMode, "parallel_quick");
  assert.equal(loadConfig({ LIVE_ORDER_PLACEMENT_MODE: "parallel_limit_rest" }).liveOrderPlacementMode, "parallel_limit_rest");
  assert.equal(loadConfig({ LIVE_ORDER_PLACEMENT_MODE: "parallel_fak" }).liveOrderPlacementMode, "parallel_fak");
  assert.equal(loadConfig({ LIVE_ORDER_PLACEMENT_MODE: "polymarket_first_exact" }).liveOrderPlacementMode, "polymarket_first_exact");
  assert.equal(loadConfig({ LIVE_ORDER_PLACEMENT_MODE: "kalshi_first_exact" }).liveOrderPlacementMode, "kalshi_first_exact");
  assert.equal(loadConfig({}).liveAutoHardlocksEnabled, true);
  assert.equal(loadConfig({ LIVE_AUTO_HARDLOCKS_ENABLED: "false" }).liveAutoHardlocksEnabled, false);
  assert.equal(loadConfig({}).polymarketGeoblockGateEnabled, true);
  assert.equal(loadConfig({ POLYMARKET_GEOBLOCK_GATE_ENABLED: "false" }).polymarketGeoblockGateEnabled, false);
  assert.equal(loadConfig({}).polymarketBookFeedSilenceMs, 30_000);
  assert.equal(loadConfig({ POLYMARKET_BOOK_FEED_SILENCE_MS: "0" }).polymarketBookFeedSilenceMs, 0);
  assert.equal(loadConfig({}).liveExactExposureRequired, false);
  assert.equal(loadConfig({ LIVE_EXACT_EXPOSURE_REQUIRED: "true" }).liveExactExposureRequired, true);
  assert.equal(loadConfig({}).liveExecutionQualityGateEnabled, true);
  assert.equal(loadConfig({}).liveKalshiMinCashDollars, 5);
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
  // T1.1: MAX defaults to liveOrderSize + 1 so a natural FAK overfill routes into the floor-hedge.
  assert.equal(loadConfig({}).livePolymarketFirstMaxFillShares, 9);
  assert.equal(loadConfig({ LIVE_ORDER_SIZE: "5" }).livePolymarketFirstMinFillShares, 5);
  assert.equal(loadConfig({ LIVE_ORDER_SIZE: "5" }).livePolymarketFirstMaxFillShares, 6);
  assert.equal(loadConfig({ LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES: "4.5", LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES: "5.5" }).livePolymarketFirstMinFillShares, 4.5);
  assert.throws(
    () => loadConfig({ LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES: "6.1", LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES: "6" }),
    /LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES/,
  );
  // P0-2: the effective hedge loss budget is floored at feeBuffer + minCrossTicks*tick so the hedge
  // cap always clears at least N Kalshi ticks of crossing headroom, while remaining the single source
  // of truth for the post-fill loss lock.
  assert.equal(loadConfig({}).livePolymarketQuoteMaxAgeMs, 750); // default = general bar (inert)
  assert.equal(loadConfig({ LIVE_POLYMARKET_QUOTE_MAX_AGE_MS: "300" }).livePolymarketQuoteMaxAgeMs, 300);
  assert.equal(loadConfig({ LIVE_QUOTE_MAX_AGE_MS: "600", LIVE_POLYMARKET_QUOTE_MAX_AGE_MS: "900" }).livePolymarketQuoteMaxAgeMs, 600); // clamped: never looser than general bar
  // P3: the hedge (second leg) quote bound can only LOOSEN the general bar (default = inert).
  assert.equal(loadConfig({}).liveHedgeQuoteMaxAgeMs, 750);
  assert.equal(loadConfig({ LIVE_HEDGE_QUOTE_MAX_AGE_MS: "2000" }).liveHedgeQuoteMaxAgeMs, 2000);
  assert.equal(loadConfig({ LIVE_QUOTE_MAX_AGE_MS: "750", LIVE_HEDGE_QUOTE_MAX_AGE_MS: "300" }).liveHedgeQuoteMaxAgeMs, 750); // clamped: never tighter than general bar
  assert.equal(loadConfig({}).liveHedgeMinCrossTicks, 2);
  assert.equal(loadConfig({}).liveHedgeMaxLossDollars, 0.03); // max(0.03 default, 0.01 + 2*0.01)
  assert.equal(loadConfig({ LIVE_HEDGE_MAX_LOSS_DOLLARS: "0.01" }).liveHedgeMaxLossDollars, 0.03); // floor still applies
  assert.equal(loadConfig({ LIVE_HEDGE_MAX_LOSS_DOLLARS: "0.08" }).liveHedgeMaxLossDollars, 0.08); // configured value above floor wins
  assert.equal(loadConfig({ LIVE_HEDGE_MIN_CROSS_TICKS: "0", LIVE_HEDGE_MAX_LOSS_DOLLARS: "0.02" }).liveHedgeMaxLossDollars, 0.02);
  assert.equal(loadConfig({}).liveKalshiPrearmEnabled, true);
  assert.equal(loadConfig({}).liveKalshiPrearmMaxAgeMs, 5_000);
  assert.equal(loadConfig({}).liveKalshiPrearmPricePolicy, "patch_after_fill");
  // P0-3: the hedge leg is fill_or_kill by default (atomic; no Kalshi partial can strand the pair).
  assert.equal(loadConfig({}).liveKalshiHedgeTimeInForce, "fill_or_kill");
  assert.equal(loadConfig({ LIVE_KALSHI_HEDGE_TIME_IN_FORCE: "immediate_or_cancel" }).liveKalshiHedgeTimeInForce, "immediate_or_cancel");
  assert.equal(loadConfig({ LIVE_KALSHI_HEDGE_TIME_IN_FORCE: "fill_or_kill" }).liveKalshiHedgeTimeInForce, "fill_or_kill");
  // Kept at 2500 to satisfy the execution.orderTimeoutMs<=2500 readiness gate (bounds the worst-case
  // leg1->leg2 one-sided window); FOK kills return fast so the bounded retry does not need a longer timeout.
  assert.equal(loadConfig({}).liveOrderTimeoutMs, 2_500);
  assert.equal(loadConfig({}).liveHedgeRetryAttempts, 2);
  assert.equal(loadConfig({ LIVE_HEDGE_RETRY_ATTEMPTS: "0" }).liveHedgeRetryAttempts, 0);
  // LA4: bounded wall-clock budget for the hedge-retry loop (keeps the one-sided window from stretching).
  assert.equal(loadConfig({}).liveHedgeRetryBudgetMs, 1_500);
  assert.equal(loadConfig({ LIVE_HEDGE_RETRY_BUDGET_MS: "800" }).liveHedgeRetryBudgetMs, 800);
  assert.equal(loadConfig({ KALSHI_HEDGE_ORDER_MODE: "fix_ioc" }).kalshiHedgeOrderMode, "fix_ioc");
  assert.equal(loadConfig({}).kalshiFixHost, "mm.fix.elections.kalshi.com");
  assert.equal(loadConfig({}).kalshiFixPort, 8228);
  assert.equal(loadConfig({}).kalshiFixTargetCompId, "KalshiNR");
  assert.equal(loadConfig({}).kalshiFixHeartbeatSeconds, 10);
  assert.equal(loadConfig({}).kalshiFixConnectTimeoutMs, 1_500);
  assert.equal(loadConfig({}).kalshiFixOrderResponseTimeoutMs, 2_500); // derives from LIVE_ORDER_TIMEOUT_MS default
  assert.equal(loadConfig({ KALSHI_FIX_ORDER_RESPONSE_TIMEOUT_MS: "2000" }).kalshiFixOrderResponseTimeoutMs, 2_000);
  assert.equal(loadConfig({}).kalshiFixUseDollars, true);
  assert.equal(loadConfig({ KALSHI_FIX_USE_DOLLARS: "false" }).kalshiFixUseDollars, false);
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

test("live executor synchronizes parallel_quick dispatch after both refreshed preflights", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const events: string[] = [];
  class TrackingClient extends FakeVenueClient {
    async preflightOrder(): Promise<string | null> {
      events.push(`${this.venue}:preflight`);
      return null;
    }

    async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
      events.push(`${this.venue}:place`);
      return super.placeOrder(leg, context);
    }
  }
  const kalshi = new TrackingClient("kalshi");
  const polymarket = new TrackingClient("polymarket");
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 1,
      liveOrderPlacementMode: "parallel_quick",
      liveParallelExecutionEnabled: false,
      kalshiHedgeOrderMode: "ui_quick_order",
      kalshiUiQuickOrderCapValidated: true,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "parallel_quick");
  assert.equal(result.action, "filled");
  assert.equal(result.executionTimings?.firstVenue, null);
  assert.match(result.executionTimings?.firstVenueReason ?? "", /Kalshi UI Quick Order and Polymarket exact-share FAK/);
  assert.deepEqual(events, [
    "kalshi:preflight",
    "polymarket:preflight",
    "kalshi:preflight",
    "polymarket:preflight",
    "kalshi:place",
    "polymarket:place",
  ]);
  assert.equal(kalshi.placed[0]?.context.placementMode, "parallel_quick");
  assert.equal(polymarket.placed[0]?.context.placementMode, "parallel_quick");
  assert.equal(kalshi.placed[0]?.context.requestedAt, polymarket.placed[0]?.context.requestedAt);
  assert.equal(result.executionTimings?.venueSubmitSkewMs, 0);
  assert.equal(result.executionTimings?.parallelDispatchAtMs, now);
  assert.equal(result.executionTimings?.parallelDispatchCallSkewMs, 0);
  assert.equal(result.executionTimings?.parallelSettledAtMs, now);
});

test("live executor fails closed for parallel_quick UI mode without cap validation", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");

  const unvalidatedCap = new LiveExecutor(
    config({
      liveOrderSize: 1,
      liveOrderPlacementMode: "parallel_quick",
      kalshiHedgeOrderMode: "ui_quick_order",
      kalshiUiQuickOrderCapValidated: false,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );
  const unvalidatedCapResult = await unvalidatedCap.execute(candidate);
  assert.equal(unvalidatedCapResult.action, "skipped");
  assert.match(unvalidatedCapResult.failureReason ?? "", /KALSHI_UI_QUICK_ORDER_CAP_VALIDATED=true/);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarket.placed.length, 0);
});

test("live executor blocks parallel_quick before dispatch when book depth is below configured minimum", async () => {
  const now = 1_799_999_900_000;
  const lower = contract({
    venue: "polymarket",
    contractId: "poly",
    strike: 1500,
    yesAsk: 0.4,
    yesAskLevels: [{ price: 0.4, size: 5 }],
    yesTokenId: "yes-token",
    updatedAt: now,
  });
  const higher = contract({
    venue: "kalshi",
    contractId: "kalshi",
    strike: 1502,
    noAsk: 0.5,
    noAskLevels: [{ price: 0.5, size: 10 }],
    updatedAt: now,
  });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveMinBookDepthShares: 10,
      liveOrderPlacementMode: "parallel_quick",
      kalshiHedgeOrderMode: "public_v2",
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "skipped");
  assert.match(result.failureReason ?? "", /polymarket yes depth 5 below required 10/);
  assert.equal(kalshi.placed.length, 0);
  assert.equal(polymarket.placed.length, 0);
});

test("live executor allows parallel_quick with supported Kalshi public V2 IOC mode", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 1,
      liveOrderPlacementMode: "parallel_quick",
      kalshiHedgeOrderMode: "public_v2",
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "parallel_quick");
  assert.equal(result.action, "filled");
  assert.match(result.executionTimings?.firstVenueReason ?? "", /Kalshi public V2 IOC/);
});

test("live executor allows parallel_quick with supported Kalshi FIX IOC mode", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi");
  const polymarket = new FakeVenueClient("polymarket");
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 1,
      liveOrderPlacementMode: "parallel_quick",
      kalshiHedgeOrderMode: "fix_ioc",
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "parallel_quick");
  assert.equal(result.action, "filled");
  assert.match(result.executionTimings?.firstVenueReason ?? "", /Kalshi FIX IOC/);
});

test("live executor hardlocks one-sided parallel_quick fills instead of auto-unwinding", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 5, fillPrice: 0.5 });
  const polymarket = new FakeVenueClient("polymarket", { status: "failed", fillCount: 0, error: "venue rejected" });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveOrderPlacementMode: "parallel_quick",
      kalshiHedgeOrderMode: "ui_quick_order",
      kalshiUiQuickOrderCapValidated: true,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
    locks,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "parallel_quick");
  assert.equal(result.action, "failed");
  assert.equal(result.partialFill, true);
  assert.match(result.liveLockReason ?? "", /venue fill mismatch/);
  assert.equal(locks.engageCalls, 1);
  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed.length, 1);
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

test("P0: an in-band Polymarket overfill classifies as a clean FILLED pair when liveConfirmationOverfillTolerant is on", async () => {
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
      liveOrderSize: 5,
      // band = max(0, max - size) = max(0, 6 - 5) = 1.0 share, covering the 0.128 over-hedge.
      livePolymarketFirstMaxFillShares: 6,
      liveParallelExecutionEnabled: true,
      liveOrderPlacementMode: "parallel_fak",
      liveConfirmationOverfillTolerant: true,
      liveAutoHardlocksEnabled: false,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
    locks,
  );

  const result = await executor.execute(candidate);

  // Same overfill the strict path books as a failed/partial/quarantine is now the completed hedged pair it
  // actually is: Kalshi 5 + Polymarket ~5.13 (the integer floor-hedge covers 5; the sub-share residual is
  // the bounded, intended FAK over-hedge). Fill count is preserved verbatim for venue-truth accounting.
  assert.equal(result.action, "filled");
  assert.equal(result.partialFill, false);
  assert.equal(result.liveLockReason ?? null, null);
  assert.equal(result.polymarketFillCount, 5.128204);
  assert.equal(result.kalshiFillCount, 5);
  assert.equal(locks.engageCalls, 0);
});

test("W2: a dynamically-sized fill at the selected size (10 > liveOrderSize 5) classifies as a clean filled pair", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now); // deep books (999 @ 0.4 poly / 0.5 kalshi)
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 10, fillPrice: 0.5 });
  const polymarket = new FakeVenueClient("polymarket", {
    status: "matched", fillCount: 10, fillPrice: 0.4,
    metadata: { orderPlacementMode: "parallel_fak", polymarketOrderType: OrderType.FAK, polymarketTakingAmount: 10 },
  });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveDynamicSizingEnabled: true,
      liveMinOrderSize: 5,
      liveMaxOrderSize: 10,
      liveDynamicSizingMaxKalshiSlippageCents: 10,
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

  // The selector sizes up to 10 (deep books, edge holds, no slippage); both legs fill 10 and — critically —
  // the classification uses the SELECTED size (10), so a clean 10/10 fill is `filled`, not a "huge overfill
  // vs 5" partial. Order was actually placed at size 10.
  assert.equal(kalshi.placed[0]?.context.size, 10);
  assert.equal(polymarket.placed[0]?.context.size, 10);
  assert.equal(result.action, "filled");
  assert.equal(result.partialFill, false);
  assert.equal(result.kalshiFillCount, 10);
  assert.equal(result.polymarketFillCount, 10);
  assert.equal(locks.engageCalls, 0);
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

test("polymarket_first_exact routes Kalshi hedge through UI Quick Order only after Polymarket fill evidence", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const sessionPath = kalshiUiSessionFile();
  const polymarket = new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 });
  let uiPostSawPolymarketFill = false;
  const fetchFn = async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const parsed = new URL(String(url));
    const method = init?.method ?? "GET";
    if (parsed.pathname.endsWith("/portfolio/balance")) {
      return new Response(JSON.stringify({ balance_dollars: "100.00" }), { status: 200 });
    }
    if (parsed.pathname.endsWith("/event_positions/kalshi")) {
      return new Response(JSON.stringify({
        event_position: {
          market_positions: [{
            market_id: "ui-market-kalshi",
            market_ticker: "kalshi",
          }],
        },
      }), { status: 200 });
    }
    if (method === "POST" && parsed.pathname.endsWith("/orders")) {
      uiPostSawPolymarketFill = polymarket.placed.length === 1;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      assert.equal(body.order_type, "market");
      assert.equal(body.time_in_force, "immediate_or_cancel");
      assert.equal(body.price_dollars, "0.6100");
      return new Response(JSON.stringify({
        order: {
          order_id: "ui-hedge-order",
          market_id: "ui-market-kalshi",
          market_ticker: "kalshi",
          status: "pending",
          order_type: "market",
          user_side: "no",
          price_dollars: "0.5000",
          fill_count_fp: "8.00",
          remaining_count_fp: "0.00",
        },
      }), { status: 201 });
    }
    if (method === "GET" && parsed.pathname.endsWith("/orders/ui-hedge-order")) {
      return new Response(JSON.stringify({
        order: {
          order_id: "ui-hedge-order",
          market_id: "ui-market-kalshi",
          market_ticker: "kalshi",
          status: "executed",
          order_type: "market",
          user_side: "no",
          price_dollars: "0.5000",
          fill_count_fp: "8.00",
          remaining_count_fp: "0.00",
          taker_fill_cost_dollars: "4.0000",
          taker_fees_dollars: "0.0000",
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  };
  const kalshi = new KalshiUiQuickOrderClient(config({
    liveOrderSize: 8,
    liveOrderPlacementMode: "polymarket_first_exact",
    kalshiHedgeOrderMode: "ui_quick_order",
    kalshiUiSessionPath: sessionPath,
    kalshiUiQuickOrderCapValidated: true,
  }), fetchFn as typeof fetch);
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "polymarket_first_exact",
      kalshiHedgeOrderMode: "ui_quick_order",
      kalshiUiSessionPath: sessionPath,
      kalshiUiQuickOrderCapValidated: true,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await withKalshiEnv(() => executor.execute(candidate));

  assert.equal(result.action, "filled");
  assert.equal(result.kalshiFillId, "ui-hedge-order");
  assert.equal(result.kalshiStatus, "filled");
  assert.equal(uiPostSawPolymarketFill, true);
  assert.equal(polymarket.placed.length, 1);
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

test("LA5: fill-quality is scored ONCE when the gate is off and TWICE when on, with identical accept/reject (parity)", async () => {
  const now = 1_799_999_900_000;
  const buildExecutor = (gateEnabled: boolean) => {
    const { candidate, lower, higher } = liveCandidate(now);
    const books = new BookStore();
    books.setPolymarketContracts([lower]);
    books.setKalshiContracts([higher]);
    let scoreCalls = 0;
    const reader = {
      unresolvedRiskQuarantineExposureDollars: async () => 0,
      listLiveExecutionQualitySignals: async () => { scoreCalls += 1; return exactQualitySignals(now); },
      liveRiskQuarantineStatus: async () => ({ total: 0, count: 0 }),
      liveExactExposureBlockReason: async () => null,
    };
    const executor = new LiveExecutor(
      config({
        liveOrderSize: 8,
        liveOrderPlacementMode: "polymarket_first_exact",
        liveExecutionQualityGateEnabled: false,
        liveFillQualityScoringEnabled: true,
        liveFillQualityGateEnabled: gateEnabled,
      }),
      books,
      new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 }),
      new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 }),
      () => now,
      undefined,
      undefined,
      undefined,
      reader,
    );
    return { executor, candidate, scoreCalls: () => scoreCalls };
  };

  // Gate OFF (default): the post-preflight refresh recompute is skipped -> scored once; outcome unchanged.
  const off = buildExecutor(false);
  const offResult = await off.executor.execute(off.candidate);
  assert.equal(offResult.action, "filled");
  assert.equal(off.scoreCalls(), 1);
  assert.ok(offResult.fillQualitySnapshot != null);

  // Gate ON: the refresh recompute is preserved (must re-decide on the refreshed quote) -> scored twice.
  const on = buildExecutor(true);
  const onResult = await on.executor.execute(on.candidate);
  assert.equal(onResult.action, "filled");
  assert.equal(on.scoreCalls(), 2);
  assert.equal(onResult.fillQualitySnapshot?.gatePassed, true);
});

test("P2: liveFillQualityInputCacheMaxAgeMs reuses the shadow fill-quality DB read across clustered executions", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  let readCalls = 0;
  const reader = {
    unresolvedRiskQuarantineExposureDollars: async () => 0,
    listLiveExecutionQualitySignals: async () => { readCalls += 1; return exactQualitySignals(now); },
    liveRiskQuarantineStatus: async () => ({ total: 0, count: 0 }),
    liveExactExposureBlockReason: async () => null,
  };
  const make = (ttl: number) => new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "polymarket_first_exact",
      liveFillQualityScoringEnabled: true,
      liveFillQualityGateEnabled: false,
      liveFillQualityInputCacheMaxAgeMs: ttl,
    }),
    books,
    new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 }),
    new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 }),
    () => now, undefined, undefined, undefined, reader,
  );

  // Cache ON: two executions within the TTL share a single DB read (off the contended pg pool).
  readCalls = 0;
  const cached = make(5_000);
  assert.equal((await cached.execute(candidate)).action, "filled");
  assert.equal((await cached.execute(candidate)).action, "filled");
  assert.equal(readCalls, 1, "second clustered execution should reuse the cached fill-quality inputs");

  // Cache OFF (default 0): each execution reads fresh — byte-identical to today.
  readCalls = 0;
  const uncached = make(0);
  await uncached.execute(candidate);
  await uncached.execute(candidate);
  assert.equal(readCalls, 2, "with the cache disabled each execution reads fresh");
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

test("P1: liveAcceptStreamAckAsOrderResult finalizes from the stream ack WITHOUT blocking on the slow REST", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });

  // REST stays pending until we explicitly release it (simulates the measured p90 ~6s slow-REST tail). The
  // stream confirmation arrives immediately. The point of P1: execute() must finalize off the stream ack
  // while the REST is still unresolved.
  let restResolved = false;
  let releaseRest: (() => void) | null = null;
  const restGate = new Promise<void>((resolve) => { releaseRest = resolve; });
  class GatedSlowRestClient extends FakeVenueClient {
    async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
      this.placed.push({ leg, context });
      await restGate;
      restResolved = true;
      const requestedAt = context.requestedAt ?? now;
      return {
        venue: "polymarket",
        clientOrderId: context.clientOrderId,
        orderId: "polymarket-rest-order",
        status: "filled",
        fillPrice: 0.4,
        fillCount: 8,
        requestedAt: new Date(requestedAt).toISOString(),
        respondedAt: new Date(requestedAt + 6_000).toISOString(),
        error: null,
        metadata: { polymarketPostOrderMs: 6_000 },
      };
    }
  }
  class ImmediateStreamConfirmation extends FakeConfirmationMonitor {
    async waitForVenueResult(result: VenueOrderResult): Promise<VenueConfirmationResult> {
      this.waitCalls.push(result.venue);
      if (result.venue !== "polymarket") return super.waitForVenueResult(result);
      return {
        venue: "polymarket", status: "confirmed", reason: null,
        clientOrderId: result.clientOrderId, venueOrderId: "polymarket-stream-order",
        fillCount: 8, fillPrice: 0.4, fee: null, exchangeTimestampMs: null,
        receivedAtMs: now + 1, eventType: "stream_test",
      };
    }
  }
  const polymarket = new GatedSlowRestClient("polymarket");
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "polymarket_first_exact",
      liveUserStreamsEnabled: true,
      liveAcceptStreamAckAsOrderResult: true,
      liveOrderTimeoutMs: 5_000,
    }),
    books, kalshi, polymarket, () => now, undefined, undefined, new ImmediateStreamConfirmation(),
  );

  const result = await executor.execute(candidate);

  // The decisive assertion: we finalized while REST was still pending (no blocking on the slow tail).
  assert.equal(restResolved, false, "execute() must NOT have waited for the slow REST");
  assert.equal(result.action, "filled");
  assert.equal(result.partialFill, false);
  assert.equal(result.polymarketFillId, "polymarket-stream-order"); // from the stream, not the REST order id
  assert.equal(result.polymarketFillCount, 8);
  assert.equal(result.executionTimings?.polymarketExactEvidenceSource, "private_stream");
  assert.equal(result.executionTimings?.polymarketHedgeTriggerSource, "private_stream");
  assert.equal(kalshi.placed.length, 1);

  // Release the gate so the background REST drain settles and clears its timeout (no lingering handles).
  releaseRest?.();
  await sleep(0);
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

test("polymarket_first_exact floor-hedges a natural FAK overfill just above order size and quarantines the sub-share residual (T1.1 regression for signal 2599386)", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
  // FAK overfilled to 8.97 (> requested 8). Before T1.1 the exact [8,8] range rejected this -> Kalshi
  // never submitted -> the WHOLE 8.97 stranded one-sided. With MAX = size + 1 it now floor-hedges.
  const polymarket = new FakeVenueClient("polymarket", {
    status: "unexpected_fill_count",
    fillCount: 8.97,
    fillPrice: 0.4,
    error: "Polymarket FAK overfilled above requested size",
  });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      livePolymarketFirstMinFillShares: 8,
      livePolymarketFirstMaxFillShares: 9,
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

  // The hedge MUST be submitted (the regression assertion) and sized to floor(8.97)=8.
  assert.equal(kalshi.placed.length, 1);
  assert.equal(kalshi.placed[0]?.context.size, 8);
  assert.equal(result.kalshiFillCount, 8);
  assert.equal(result.polymarketFillCount, 8.97);
  // The matched 8/8 portion is fully hedged; only the <1-share residual is one-sided -> partial/quarantine.
  assert.equal(result.partialFill, true);
  assert.equal(result.action, "failed");
  assert.match(result.liveLockReason ?? "", /venue fill mismatch/);
  assert.equal(locks.engageCalls, 0);
});

test("polymarket_first_exact still rejects an overfill above the max band -> Kalshi not submitted, stays flat-of-hedge (T1.1 boundary)", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const kalshi = new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 });
  // 9.4 is above the size+1 band (max 9); the hedge trigger must stay closed so an arbitrarily large
  // overfill can never silently trigger an oversized floor-hedge.
  const polymarket = new FakeVenueClient("polymarket", {
    status: "unexpected_fill_count",
    fillCount: 9.4,
    fillPrice: 0.4,
    error: "Polymarket FAK overfilled beyond band",
  });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      livePolymarketFirstMinFillShares: 8,
      livePolymarketFirstMaxFillShares: 9,
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

  assert.equal(kalshi.placed.length, 0);
  assert.equal(result.polymarketFillCount, 9.4);
  assert.equal(result.partialFill, true);
});

test("shadow ladder capture attaches a ladder to the below-threshold skip only when enabled (T2.4)", async () => {
  const now = 1_799_999_900_000;
  // Top-of-book executable (0.40 + 0.50 = 0.90 -> 0.10 edge) but the size-8 worst ask collapses the
  // edge below threshold, so this skips with the "cushioned executable edge ... below threshold" reason.
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesAskLevels: [{ price: 0.4, size: 1 }, { price: 0.56, size: 999 }], yesTokenId: "yes-token", updatedAt: now });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, noAskLevels: [{ price: 0.5, size: 999 }], updatedAt: now });
  const candidate = buildGuaranteedCandidate(poly, kalshi, 0.05);
  assert.ok(candidate);

  const makeExecutor = (captureEnabled: boolean) => {
    const books = new BookStore();
    books.setPolymarketContracts([poly]);
    books.setKalshiContracts([kalshi]);
    return new LiveExecutor(
      config({
        liveOrderSize: 8,
        liveOrderPlacementMode: "polymarket_first_exact",
        liveShadowLadderCaptureEnabled: captureEnabled,
        liveShadowLadderProbeSizes: [1, 2, 3, 8],
      }),
      books,
      new FakeVenueClient("kalshi", { fillCount: 8, fillPrice: 0.5 }),
      new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 }),
      () => now,
    );
  };

  const enabled = await makeExecutor(true).execute(candidate!);
  assert.equal(enabled.action, "skipped");
  assert.match(enabled.failureReason ?? "", /cushioned executable edge/);
  assert.ok(enabled.quoteSnapshot?.shadowLadder, "shadow ladder should be attached when enabled");
  assert.deepEqual(enabled.quoteSnapshot?.shadowLadder?.probeSizes, [1, 2, 3, 8]);
  assert.ok((enabled.quoteSnapshot?.shadowLadder?.polymarket?.probes.length ?? 0) >= 4);

  const disabled = await makeExecutor(false).execute(candidate!);
  assert.equal(disabled.action, "skipped");
  assert.match(disabled.failureReason ?? "", /cushioned executable edge/);
  // Default-off path is byte-identical to the legacy bare skip: no quoteSnapshot, no shadow ladder.
  assert.equal(disabled.quoteSnapshot, undefined);
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

    // The hedge is sized to the integer floor of the ACTUAL Polymarket fill (P0-1), not the static
    // configured order size. An integer fill (7, 8, 9) produces an exactly matched hedge; a fractional
    // in-range fill (8.5) hedges the floor (8) so only the 0.5 remainder stays one-sided.
    assert.equal(polymarket.placed.length, 1);
    assert.equal(kalshi.placed.length, 1);
    assert.equal(kalshi.placed[0]?.context.size, Math.floor(fillCount + 0.000001));
    assert.equal(result.action, fillCount === 8 ? "filled" : "failed");
    assert.equal(result.partialFill, fillCount !== 8);
    assert.equal(result.executionTimings?.polymarketHedgeTriggerFillCount, fillCount);
  }
});

test("polymarket_first_exact retries the FOK Kalshi hedge after a clean 0-fill miss (P0-3)", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  // First Kalshi FOK attempt is a clean 0-fill miss (book moved a tick); the retry fills exactly.
  const kalshi = new SequencedVenueClient("kalshi", [
    { status: "canceled", fillCount: 0, fillPrice: null, error: "kalshi filled 0 shares for requested exact size 8" },
    { status: "filled", fillCount: 8, fillPrice: 0.5 },
  ]);
  const polymarket = new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "polymarket_first_exact",
      liveHedgeRetryAttempts: 2,
      liveAutoHardlocksEnabled: false,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(polymarket.placed.length, 1);
  assert.equal(kalshi.placed.length, 2); // initial miss + one retry that fills
  assert.match(kalshi.placed[1]?.context.clientOrderId ?? "", /-r1$/);
  assert.equal(result.action, "filled");
  assert.equal(result.partialFill, false);
  assert.equal(result.kalshiFillCount, 8);
  assert.equal(result.polymarketFillCount, 8);
});

test("hedge retry does not fire on insufficient_balance and never double-submits (P0-3 safety)", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  // A hard collateral failure must not be retried (it will not change), and an ambiguous/unknown
  // result must not be retried (it may have filled — double-submit would create exposure).
  for (const spec of [
    { status: "rejected" as const, fillCount: 0, fillPrice: null, error: "kalshi insufficient_balance" },
    { status: "unknown" as const, fillCount: null, fillPrice: null, error: "order response timeout" },
  ]) {
    const kalshi = new SequencedVenueClient("kalshi", [spec, { status: "filled", fillCount: 8, fillPrice: 0.5 }]);
    const polymarket = new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 });
    const executor = new LiveExecutor(
      config({
        liveOrderSize: 8,
        liveOrderPlacementMode: "polymarket_first_exact",
        liveHedgeRetryAttempts: 2,
        liveAutoHardlocksEnabled: false,
      }),
      books,
      kalshi,
      polymarket,
      () => now,
    );

    const result = await executor.execute(candidate);

    assert.equal(kalshi.placed.length, 1); // no retry: terminal/ambiguous result
    assert.equal(result.action, "failed");
  }
});

test("kalshi_first_exact commits Kalshi first and hedges Polymarket after an exact Kalshi fill (P2-8)", async () => {
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
      liveOrderPlacementMode: "kalshi_first_exact",
      liveAutoHardlocksEnabled: false,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.executionStrategy, "kalshi_first_exact");
  assert.equal(result.executionTimings?.firstVenue, "kalshi");
  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed.length, 1);
  assert.equal(result.action, "filled");
  assert.equal(result.partialFill, false);
  assert.equal(result.kalshiFillCount, 8);
  assert.equal(result.polymarketFillCount, 8);
});

test("kalshi_first_exact never sends Polymarket when the Kalshi first leg misses (no one-sided exposure)", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  // Kalshi FOK first leg fills 0 (killed): Polymarket must never be sent, leaving a flat position.
  const kalshi = new FakeVenueClient("kalshi", { status: "canceled", fillCount: 0, fillPrice: null, error: "kalshi FOK killed without fill" });
  const polymarket = new FakeVenueClient("polymarket", { fillCount: 8, fillPrice: 0.4 });
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 8,
      liveOrderPlacementMode: "kalshi_first_exact",
      liveAutoHardlocksEnabled: false,
    }),
    books,
    kalshi,
    polymarket,
    () => now,
  );

  const result = await executor.execute(candidate);

  assert.equal(kalshi.placed.length, 1);
  assert.equal(polymarket.placed.length, 0); // never sent -> flat, zero exposure
  assert.equal(result.action, "failed");
  assert.equal(result.polymarketFillCount ?? 0, 0); // unsubmitted hedge has no fill
  assert.equal(result.kalshiFillCount ?? 0, 0); // Kalshi FOK killed without fill
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

// The recurring lock-24/25/26 false positive: a Polymarket FAK that gets NO fill but whose REST response timed
// out leaves the user-stream confirmation waiting for a fill event that never arrives -> it resolves to
// "timeout". When BOTH legs are provably flat (zero exposure) and recovery DEFINITIVELY found no order/trade
// (not_found), that timeout is a benign no-fill miss, not unconfirmed exposure, and must NOT trip the breaker.
test("live executor does NOT lock a verified zero-exposure Polymarket no-fill stream-timeout (lock-24/25/26 fix)", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const monitor = new FakeConfirmationMonitor();
  monitor.confirmations = {
    polymarket: { status: "timeout", reason: "polymarket user stream did not confirm 5 shares within 2500ms", fillCount: null, fillPrice: null },
    kalshi: { status: "not_required", fillCount: 0, fillPrice: null },
  };
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveParallelExecutionEnabled: true,
      liveUserStreamsEnabled: true,
      // The operator's recovery switch alone must be sufficient — even with the general flat-miss switch off.
      liveConfirmationFlatMissNonBlocking: false,
      livePolymarketTimeoutRecoveryResolvesNoFill: true,
    }),
    books,
    // Kalshi: a clean definitive no-fill (zero exposure on the hedge leg).
    new FakeVenueClient("kalshi", { orderId: null, status: "rejected", fillPrice: null, fillCount: 0, error: "kalshi rejected" }),
    // Polymarket: a REST-response timeout that recovery DEFINITIVELY resolved to no-fill (not_found), FAK.
    new FakeVenueClient("polymarket", {
      orderId: null,
      status: "unknown",
      fillPrice: null,
      fillCount: null,
      error: "order response timeout after 2500ms",
      metadata: {
        polymarketTimeoutRecoveryAttempted: true,
        polymarketTimeoutRecoveryStatus: "not_found",
        polymarketOrderType: "FAK",
      },
    }),
    () => now,
    locks,
    undefined,
    monitor,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed"); // a no-fill is not a completed arb...
  assert.equal(result.partialFill, false); // ...but it is NOT one-sided exposure...
  assert.equal(result.liveLockReason, null); // ...so it must NOT engage the breaker.
  assert.notEqual(result.recoveryStatus, "operator_required");
  assert.equal(locks.engageCalls, 0);
});

test("live executor STILL locks a Polymarket no-fill timeout that leaves a one-sided Kalshi fill", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const monitor = new FakeConfirmationMonitor();
  monitor.confirmations = {
    polymarket: { status: "timeout", reason: "polymarket user stream did not confirm 5 shares within 2500ms", fillCount: null, fillPrice: null },
    kalshi: { status: "confirmed", fillCount: 5, fillPrice: 0.55 },
  };
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveParallelExecutionEnabled: true,
      liveUserStreamsEnabled: true,
      liveConfirmationFlatMissNonBlocking: false,
      livePolymarketTimeoutRecoveryResolvesNoFill: true,
    }),
    books,
    // Kalshi FILLED — genuine one-sided exposure; the suppression must NOT apply.
    new FakeVenueClient("kalshi", { status: "filled", fillCount: 5, fillPrice: 0.55 }),
    new FakeVenueClient("polymarket", {
      orderId: null,
      status: "unknown",
      fillPrice: null,
      fillCount: null,
      error: "order response timeout after 2500ms",
      metadata: {
        polymarketTimeoutRecoveryAttempted: true,
        polymarketTimeoutRecoveryStatus: "not_found",
        polymarketOrderType: "FAK",
      },
    }),
    () => now,
    locks,
    undefined,
    monitor,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.notEqual(result.liveLockReason, null);
  assert.equal(locks.engageCalls, 1);
});

test("live executor STILL locks a Polymarket no-fill timeout that recovery could not verify (query_failed)", async () => {
  const now = 1_799_999_900_000;
  const { candidate, lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const locks = new FakeLiveLockStore();
  const monitor = new FakeConfirmationMonitor();
  monitor.confirmations = {
    polymarket: { status: "timeout", reason: "polymarket user stream did not confirm 5 shares within 2500ms", fillCount: null, fillPrice: null },
    kalshi: { status: "not_required", fillCount: 0, fillPrice: null },
  };
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveParallelExecutionEnabled: true,
      liveUserStreamsEnabled: true,
      liveConfirmationFlatMissNonBlocking: false,
      livePolymarketTimeoutRecoveryResolvesNoFill: true,
    }),
    books,
    new FakeVenueClient("kalshi", { orderId: null, status: "rejected", fillPrice: null, fillCount: 0, error: "kalshi rejected" }),
    // Recovery could NOT reach Polymarket to verify (query_failed) — the leg's exposure is unverified, so a
    // confirmation timeout still locks for reconciliation. Only a DEFINITIVE not_found resolves to no-fill.
    new FakeVenueClient("polymarket", {
      orderId: null,
      status: "unknown",
      fillPrice: null,
      fillCount: null,
      error: "order response timeout after 2500ms",
      metadata: {
        polymarketTimeoutRecoveryAttempted: true,
        polymarketTimeoutRecoveryStatus: "query_failed",
        polymarketOrderType: "FAK",
      },
    }),
    () => now,
    locks,
    undefined,
    monitor,
  );

  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.match(result.liveLockReason ?? "", /private stream confirmation timeout/);
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

function oneSidedAutoUnwindExecutor(autoUnwindEnabled: boolean, outcome: VenueUnwindOutcome | null, now: number, locks: FakeLiveLockStore) {
  const { lower, higher } = liveCandidate(now);
  const books = new BookStore();
  books.setPolymarketContracts([lower]);
  books.setKalshiContracts([higher]);
  const monitor = new FakeConfirmationMonitor();
  monitor.confirmations = {
    kalshi: { status: "timeout", reason: "kalshi stream did not confirm", fillCount: null, fillPrice: null },
    polymarket: { status: "confirmed", fillCount: 5, fillPrice: 0.84 },
  };
  const exposureReader = { unresolvedRiskQuarantineExposureDollars: async () => 0 };
  const polymarket = new UnwindableVenueClient("polymarket", { status: "filled", fillCount: 5, fillPrice: 0.84 }, outcome);
  const executor = new LiveExecutor(
    config({
      liveOrderSize: 5,
      liveParallelExecutionEnabled: true,
      liveUserStreamsEnabled: true,
      livePartialFillLockMode: "quarantine",
      liveMaxUnresolvedExposureDollars: 10,
      liveAutoUnwindEnabled: autoUnwindEnabled,
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
    polymarket,
    () => now,
    locks,
    undefined,
    monitor,
    exposureReader,
  );
  return { executor, polymarket };
}

test("auto-unwind flattens a one-sided fill instead of quarantining when enabled (C1)", async () => {
  const now = 1_799_999_900_000;
  const { candidate } = liveCandidate(now);
  const locks = new FakeLiveLockStore();
  const { executor, polymarket } = oneSidedAutoUnwindExecutor(true, { flattened: true, lossDollars: 0.03 }, now, locks);

  const result = await executor.execute(candidate);

  assert.equal(polymarket.unwindCalls, 1); // unwound the FILLED Polymarket leg
  assert.equal(polymarket.lastUnwindRequest?.fillCount, 5);
  assert.equal(polymarket.lastUnwindRequest?.maxLossDollars, 0.05);
  assert.notEqual(result.recoveryStatus, "risk_quarantined"); // flattened -> no quarantine
  assert.equal(result.liveLockReason, null);
  assert.equal(result.riskQuarantineExposureDollars ?? null, null);
  assert.equal(locks.engageCalls, 0);
  const evidence = result.recoveryEvidence as Record<string, unknown> | null;
  assert.equal((evidence?.autoUnwind as Record<string, unknown>)?.flattened, true);
});

test("auto-unwind falls through to quarantine when the unwind cannot complete (C1 fall-through)", async () => {
  const now = 1_799_999_900_000;
  const { candidate } = liveCandidate(now);
  const locks = new FakeLiveLockStore();
  const { executor, polymarket } = oneSidedAutoUnwindExecutor(true, { flattened: false, reason: "no liquidity within cap" }, now, locks);

  const result = await executor.execute(candidate);

  assert.equal(polymarket.unwindCalls, 1);
  assert.equal(result.recoveryStatus, "risk_quarantined"); // identical to today when unwind fails
  assert.equal(result.riskQuarantineExposureDollars, 4.2);
  assert.equal(locks.engageCalls, 0);
});

test("auto-unwind is never attempted when disabled (C1 default-off is inert)", async () => {
  const now = 1_799_999_900_000;
  const { candidate } = liveCandidate(now);
  const locks = new FakeLiveLockStore();
  const { executor, polymarket } = oneSidedAutoUnwindExecutor(false, { flattened: true, lossDollars: 0.0 }, now, locks);

  const result = await executor.execute(candidate);

  assert.equal(polymarket.unwindCalls, 0); // disabled -> never called
  assert.equal(result.recoveryStatus, "risk_quarantined");
  assert.equal(result.riskQuarantineExposureDollars, 4.2);
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

test("LA2: exposure cache serves last-good in the soft-stale window (background refresh) and blocks past the hard ceiling", async () => {
  let clock = 1_800_000_000_000;
  let reads = 0;
  let failReads = false;
  const cache = new LiveExposureCache({
    listLiveExposureSignals: async () => { reads += 1; if (failReads) throw new Error("db down"); return []; },
  }, 5_000, 10, () => clock);
  const { candidate } = liveCandidate(1_799_999_900_000);

  await cache.refresh();
  assert.equal(reads, 1);
  // Fresh (age 0 <= maxAge 5000): no block, no new read.
  assert.equal(await cache.liveExposureBlockReason(candidate, clock, 3), null);
  assert.equal(reads, 1);

  // Soft-stale (age 8000: > maxAge 5000, <= hard 15000): serves last-good (no block) and kicks a BACKGROUND
  // refresh. Make that refresh fail so freshness does not advance, to set up the hard-ceiling case.
  failReads = true;
  clock += 8_000;
  assert.equal(await cache.liveExposureBlockReason(candidate, clock, 3), null);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reads, 2); // background refresh attempted (and failed silently), hot path did NOT block

  // Hard-stale (age 18000 > hard ceiling 15000): must block on a synchronous refresh; refresh fails -> blocks.
  clock += 10_000;
  const blocked = await cache.liveExposureBlockReason(candidate, clock, 3);
  assert.match(blocked ?? "", /refresh failed|stale/);
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

test("live exposure cache ignores old execution quality rows touched by later reconciliation", async () => {
  const now = 1_799_999_900_000;
  const { candidate } = liveCandidate(now);
  const oldButTouched = (id: number): DashboardSignal => ({
    id,
    createdAt: new Date(now - 24 * 60 * 60_000).toISOString(),
    updatedAt: new Date(now - id * 1_000).toISOString(),
    pairKey: `old-miss-${id}`,
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
    failureReason: "historical miss reconciled by operator",
    kalshiFillId: null,
    polymarketFillId: null,
    kalshiFillPrice: null,
    polymarketFillPrice: null,
    kalshiFillCount: 0,
    polymarketFillCount: 0,
    partialFill: false,
    executionGroupId: `group-${id}`,
  });
  const cache = new LiveExposureCache({
    listLiveExposureSignals: async () => [],
    listLiveExecutionQualitySignals: async () => [1, 2, 3, 4, 5].map(oldButTouched),
  }, 5_000, 10, () => now);

  await cache.refresh(now);

  const status = await cache.liveExecutionQualityStatus(now, {
    enabled: true,
    lookbackMs: 30 * 60 * 1_000,
    sampleLimit: 50,
    minSamples: 5,
    minExactFillRate: 0.4,
  });
  assert.equal(status.sampleCount, 0);
  assert.equal(status.ok, true);
  assert.equal(await cache.liveExecutionQualityBlockReason(candidate, now, {
    enabled: true,
    lookbackMs: 30 * 60 * 1_000,
    sampleLimit: 50,
    minSamples: 5,
    minExactFillRate: 0.4,
  }), null);
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

test("P1: a confirmation timeout does NOT lock when REST already evidenced both fills (accept REST evidence); flag-off restores the lock", async () => {
  const now = 1_799_999_900_000;
  const run = async (acceptRestEvidence: boolean) => {
    const { candidate, lower, higher } = liveCandidate(now);
    const books = new BookStore();
    books.setPolymarketContracts([lower]);
    books.setKalshiContracts([higher]);
    const locks = new FakeLiveLockStore();
    const monitor = new FakeConfirmationMonitor();
    // Both legs FILLED via the REST order response, but the private user stream is slow and the
    // confirmation times out — the ~half of timeouts that actually completed both legs.
    monitor.resultStatus = "timeout";
    const executor = new LiveExecutor(
      config({ liveOrderSize: 5, liveUserStreamsEnabled: true, liveConfirmationAcceptRestEvidence: acceptRestEvidence }),
      books,
      new FakeVenueClient("kalshi"),
      new FakeVenueClient("polymarket"),
      () => now,
      locks,
      undefined,
      monitor,
    );
    const result = await executor.execute(candidate);
    return { result, engageCalls: locks.engageCalls };
  };

  // Flag ON: the order responses confirm the fills, so a slow stream is not unconfirmed exposure -> filled.
  const on = await run(true);
  assert.equal(on.result.action, "filled");
  assert.equal(on.result.liveLockReason ?? null, null);
  assert.equal(on.engageCalls, 0);

  // Flag OFF (default): a confirmation timeout still engages the breaker (today's behavior).
  const off = await run(false);
  assert.equal(off.result.action, "failed");
  assert.match(off.result.liveLockReason ?? "", /private stream confirmation timeout/);
  assert.equal(off.engageCalls, 1);
});

test("P1-gap: a FAK no-fill timeout that recovery verified (not_found) does NOT lock when resolved; flag-off restores the lock (lock-24)", async () => {
  const now = 1_799_999_900_000;
  const run = async (resolvesNoFill: boolean) => {
    const { candidate, lower, higher } = liveCandidate(now);
    const books = new BookStore();
    books.setPolymarketContracts([lower]);
    books.setKalshiContracts([higher]);
    const locks = new FakeLiveLockStore();
    const monitor = new FakeConfirmationMonitor();
    monitor.resultStatus = "timeout"; // private stream never confirms (the lock-24 trigger)
    const executor = new LiveExecutor(
      config({
        liveOrderSize: 5,
        liveUserStreamsEnabled: true,
        liveOrderPlacementMode: "polymarket_first_exact",
        liveConfirmationFlatMissNonBlocking: true,
        livePolymarketTimeoutRecoveryResolvesNoFill: resolvesNoFill,
      }),
      books,
      new FakeVenueClient("kalshi"), // hedge never submitted (Polymarket gave no in-range fill)
      // Polymarket FAK timed out ("unknown"); recovery reached the venue and found nothing -> not_found.
      new FakeVenueClient("polymarket", {
        status: "unknown",
        fillCount: 0,
        fillPrice: null,
        error: "polymarket FAK postOrder failed: timeout of 2500ms exceeded",
        metadata: { polymarketOrderType: "FAK", polymarketTimeoutRecoveryAttempted: true, polymarketTimeoutRecoveryStatus: "not_found" },
      }),
      () => now,
      locks,
      undefined,
      monitor,
    );
    const result = await executor.execute(candidate);
    return { result, engageCalls: locks.engageCalls };
  };

  // Flag ON: a FAK cannot rest, and recovery confirmed no order/trade/open-order -> definitively no fill ->
  // both legs provably flat -> no hard-lock (auto-resolves instead of requiring manual reconciliation).
  const on = await run(true);
  assert.equal(on.result.liveLockReason ?? null, null);
  assert.equal(on.engageCalls, 0);

  // Flag OFF (default): "unknown" stays ambiguous -> hard-lock for reconciliation (today's lock-24 behavior).
  const off = await run(false);
  assert.match(off.result.liveLockReason ?? "", /private stream confirmation timeout/);
  assert.equal(off.engageCalls, 1);
});

test("stream confirmation timeout does NOT lock when both legs are definitively flat (zero exposure); flag-off restores the lock", async () => {
  const now = 1_799_999_900_000;
  const run = async (flatMissNonBlocking: boolean) => {
    const { candidate, lower, higher } = liveCandidate(now);
    const books = new BookStore();
    books.setPolymarketContracts([lower]);
    books.setKalshiContracts([higher]);
    const locks = new FakeLiveLockStore();
    const monitor = new FakeConfirmationMonitor();
    monitor.resultStatus = "timeout"; // Polymarket WS drop -> first-leg confirmation times out
    const executor = new LiveExecutor(
      config({
        liveOrderSize: 5,
        liveUserStreamsEnabled: true,
        liveOrderPlacementMode: "polymarket_first_exact",
        liveConfirmationFlatMissNonBlocking: flatMissNonBlocking,
      }),
      books,
      new FakeVenueClient("kalshi"), // hedge never submitted because the first leg fails
      // Polymarket FAK definitively rejected (no fill): both legs end flat, so there is no exposure.
      new FakeVenueClient("polymarket", { status: "failed", fillCount: 0, fillPrice: null, error: "polymarket FAK postOrder failed: no orders found to match" }),
      () => now,
      locks,
      undefined,
      monitor,
    );
    const result = await executor.execute(candidate);
    return { result, engageCalls: locks.engageCalls };
  };

  // Flag ON (default): a transient WS drop on a zero-fill attempt is a clean miss, not a critical halt.
  const on = await run(true);
  assert.equal(on.result.action, "failed");
  assert.equal(on.result.liveLockReason ?? null, null);
  assert.equal(on.engageCalls, 0);

  // Flag OFF: rollback to the previous behavior — the confirmation timeout still engages the breaker.
  const off = await run(false);
  assert.match(off.result.liveLockReason ?? "", /private stream confirmation timeout/);
  assert.equal(off.engageCalls, 1);
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
