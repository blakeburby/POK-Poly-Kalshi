import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import type { LiveExecutionLockWriter } from "../db/live-execution-locks";
import type { VenueOrderEventWriter } from "../db/venue-order-events";
import { protectedCandidateBlockReason } from "../scanner/safety";
import type { ArbCandidate, ArbLeg, BinaryContract, ExecutionResult, ExecutionTimings, LiveExecutionLastAttempt, LiveExecutionReadiness, QuoteSnapshot, Venue, VenueConfirmations, VenueExecutionReadiness } from "../types";
import {
  failedVenueResult,
  generatedClientOrderId,
  KalshiOrderClient,
  PolymarketOrderClient,
  type LiveOrderContext,
  type VenueOrderClient,
  type VenueOrderResult,
} from "./live-clients";
import { evaluateLiveQuoteQuality } from "./quote-quality";
import { buildUserStreamReadiness, defaultReconciliationReadiness, type VenueConfirmationMonitor, type VenueConfirmationResult } from "./venue-confirmations";

export interface ArbExecutor {
  execute(candidate: ArbCandidate): Promise<ExecutionResult>;
}

export interface DryRunSlippageOptions {
  enabled: boolean;
  kalshiSlippageCents: number;
  polymarketSlippageCents: number;
  maxSlippageCents: number;
  jitterCents: number;
}

function legForVenue(candidate: ArbCandidate, venue: "kalshi" | "polymarket"): ArbLeg | null {
  if (candidate.lower.venue === venue) return candidate.lower;
  if (candidate.higher.venue === venue) return candidate.higher;
  return null;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function failed(reason: string): ExecutionResult {
  return {
    action: "failed",
    failureReason: reason,
    kalshiFillId: null,
    polymarketFillId: null,
    kalshiFillPrice: null,
    polymarketFillPrice: null,
  };
}

function skipped(reason: string): ExecutionResult {
  return {
    action: "skipped",
    failureReason: reason,
    kalshiFillId: null,
    polymarketFillId: null,
    kalshiFillPrice: null,
    polymarketFillPrice: null,
  };
}

function liveLocked(reason: string): ExecutionResult {
  return {
    ...failed(reason),
    liveLockReason: reason,
  };
}

function protectedGuardFailure(candidate: ArbCandidate, minProfitDollars: number): ExecutionResult | null {
  const blockReason = protectedCandidateBlockReason(candidate, minProfitDollars);
  return blockReason ? failed(`protected-spread-only guard: ${blockReason}`) : null;
}

export class DryRunSlippageModel {
  constructor(
    private readonly options: DryRunSlippageOptions,
    private readonly random: () => number = Math.random,
  ) {}

  static fromConfig(config: AppConfig, random?: () => number): DryRunSlippageModel {
    return new DryRunSlippageModel({
      enabled: config.dryRunSlippageEnabled,
      kalshiSlippageCents: config.dryRunKalshiSlippageCents,
      polymarketSlippageCents: config.dryRunPolymarketSlippageCents,
      maxSlippageCents: config.dryRunMaxSlippageCents,
      jitterCents: config.dryRunSlippageJitterCents,
    }, random);
  }

  fillPrice(leg: ArbLeg | null): number | null {
    if (!leg) return null;
    if (!this.options.enabled) return roundPrice(leg.ask);

    const baseCents = leg.venue === "kalshi" ? this.options.kalshiSlippageCents : this.options.polymarketSlippageCents;
    const jitterCents = Math.max(0, this.options.jitterCents) * clampUnit(this.random());
    const maxCents = Math.max(0, this.options.maxSlippageCents);
    const slippageCents = Math.min(maxCents, Math.max(0, baseCents) + jitterCents);
    return roundPrice(Math.min(1, leg.ask + slippageCents / 100));
  }
}

export class DryRunExecutor implements ArbExecutor {
  constructor(
    private readonly slippage = DryRunSlippageModel.fromConfig(loadConfig()),
    private readonly minProfitDollars = loadConfig().minProfitDollars,
  ) {}

  async execute(candidate: ArbCandidate): Promise<ExecutionResult> {
    const guardFailure = protectedGuardFailure(candidate, this.minProfitDollars);
    if (guardFailure) return guardFailure;
    return {
      action: "filled",
      failureReason: null,
      kalshiFillId: `dry-run-kalshi-${Date.now()}`,
      polymarketFillId: `dry-run-polymarket-${Date.now()}`,
      kalshiFillPrice: this.slippage.fillPrice(legForVenue(candidate, "kalshi")),
      polymarketFillPrice: this.slippage.fillPrice(legForVenue(candidate, "polymarket")),
    };
  }
}

export interface LiveExecutionBookReader {
  snapshot(): { kalshi: BinaryContract[]; polymarket: BinaryContract[] };
}

interface PreparedLeg {
  leg: ArbLeg;
  maxBuyPrice: number;
}

interface PreparedExecution {
  kalshi: PreparedLeg;
  polymarket: PreparedLeg;
  quoteSnapshot: QuoteSnapshot;
}

function emptyVenueReadiness(reason: string, now: number): VenueExecutionReadiness {
  return {
    configured: false,
    ready: false,
    reason,
    balance: null,
    allowance: null,
    lastCheckedAt: now,
  };
}

export function dryRunExecutionReadiness(config: AppConfig, now = Date.now()): LiveExecutionReadiness {
  return {
    mode: "dry_run",
    liveTrading: false,
    protectedOnly: true,
    orderSize: config.liveOrderSize,
    orderType: config.polymarketOrderType,
    maxSlippageCents: config.liveMaxSlippageCents,
    minExpiryMs: config.liveMinExpiryMs,
    maxTradesPerWindow: config.liveMaxTradesPerWindow,
    collateralBufferDollars: config.liveCollateralBufferDollars,
    quoteMaxAgeMs: config.liveQuoteMaxAgeMs,
    quoteSyncMaxSkewMs: config.liveQuoteSyncMaxSkewMs,
    minBookDepthShares: config.liveMinBookDepthShares,
    edgeBufferDollars: config.liveEdgeBufferDollars,
    orderTimeoutMs: config.liveOrderTimeoutMs,
    kalshiOrderGroupEnabled: config.liveKalshiOrderGroupEnabled && Boolean(config.liveKalshiOrderGroupId),
    userStreams: buildUserStreamReadiness(false, config.liveUserStreamConfirmTimeoutMs, undefined, undefined, now),
    reconciliation: defaultReconciliationReadiness(false, null, null),
    partialFillLocked: false,
    circuitBreakerLocked: false,
    circuitBreakerReason: null,
    circuitBreaker: null,
    kalshi: emptyVenueReadiness("dry-run mode", now),
    polymarket: emptyVenueReadiness("dry-run mode", now),
    lastAttempt: null,
  };
}

export class LiveExecutor implements ArbExecutor {
  private partialFillLocked = false;
  private lastAttempt: LiveExecutionLastAttempt | null = null;

  constructor(
    private readonly config: AppConfig = loadConfig(),
    private readonly books?: LiveExecutionBookReader,
    private readonly kalshiClient: VenueOrderClient = new KalshiOrderClient(config),
    private readonly polymarketClient: VenueOrderClient = new PolymarketOrderClient(config),
    private readonly now: () => number = Date.now,
    private readonly liveLocks?: LiveExecutionLockWriter,
    private readonly orderEvents?: VenueOrderEventWriter,
    private readonly confirmationMonitor?: VenueConfirmationMonitor,
  ) {}

  async readiness(now = this.now()): Promise<LiveExecutionReadiness> {
    const [kalshi, polymarket, activeLock] = await Promise.all([
      this.kalshiClient.readiness(now),
      this.polymarketClient.readiness(now),
      this.liveLocks?.getActiveLock() ?? Promise.resolve(null),
    ]);
    const userStreams = this.confirmationMonitor?.userStreamReadiness(now)
      ?? buildUserStreamReadiness(
        this.config.liveUserStreamsEnabled,
        this.config.liveUserStreamConfirmTimeoutMs,
        undefined,
        undefined,
        now,
      );
    const reconciliation = this.confirmationMonitor?.reconciliationReadiness(now)
      ?? defaultReconciliationReadiness(
        this.config.liveReconcileBeforeTrade,
        null,
        this.config.liveUserStreamsEnabled ? "live reconciliation monitor is not configured" : null,
      );
    return {
      mode: "live",
      liveTrading: this.config.liveTrading,
      protectedOnly: true,
      orderSize: this.config.liveOrderSize,
      orderType: this.config.polymarketOrderType,
      maxSlippageCents: this.config.liveMaxSlippageCents,
      minExpiryMs: this.config.liveMinExpiryMs,
      maxTradesPerWindow: this.config.liveMaxTradesPerWindow,
      collateralBufferDollars: this.config.liveCollateralBufferDollars,
      quoteMaxAgeMs: this.config.liveQuoteMaxAgeMs,
      quoteSyncMaxSkewMs: this.config.liveQuoteSyncMaxSkewMs,
      minBookDepthShares: this.config.liveMinBookDepthShares,
      edgeBufferDollars: this.config.liveEdgeBufferDollars,
      orderTimeoutMs: this.config.liveOrderTimeoutMs,
      kalshiOrderGroupEnabled: this.config.liveKalshiOrderGroupEnabled && Boolean(this.config.liveKalshiOrderGroupId),
      userStreams,
      reconciliation,
      partialFillLocked: this.partialFillLocked,
      circuitBreakerLocked: Boolean(activeLock),
      circuitBreakerReason: activeLock?.reason ?? null,
      circuitBreaker: activeLock ?? null,
      kalshi,
      polymarket,
      lastAttempt: this.lastAttempt,
    };
  }

  async execute(candidate: ArbCandidate): Promise<ExecutionResult> {
    const executeStartedAt = this.now();
    const guardFailure = protectedGuardFailure(candidate, this.config.minProfitDollars);
    if (guardFailure) return guardFailure;
    const activeLock = await this.liveLocks?.getActiveLock();
    if (activeLock) return failed(`live circuit breaker locked: ${activeLock.reason}`);
    if (this.partialFillLocked) return liveLocked("live execution locked after unsafe fill; manual operator review required before trading resumes");
    const monitorFailure = await this.confirmationPreflight(candidate);
    if (monitorFailure) return monitorFailure;
    const kalshiLeg = legForVenue(candidate, "kalshi");
    const polymarketLeg = legForVenue(candidate, "polymarket");
    if (!kalshiLeg || !polymarketLeg) return this.failed("candidate must contain one Kalshi leg and one Polymarket leg");

    const prepared = this.prepareExecution(candidate, kalshiLeg, polymarketLeg);
    if (typeof prepared === "string") return skipped(prepared);

    const executionGroupId = randomUUID();
    const requestedAt = this.now();
    const kalshiClientOrderId = generatedClientOrderId("kalshi");
    const polymarketClientOrderId = generatedClientOrderId("polymarket");
    const kalshiContext: LiveOrderContext = {
      executionGroupId,
      clientOrderId: kalshiClientOrderId,
      size: this.config.liveOrderSize,
      maxBuyPrice: prepared.kalshi.maxBuyPrice,
      requestedAt,
      orderGroupId: this.config.liveKalshiOrderGroupEnabled ? this.config.liveKalshiOrderGroupId || undefined : undefined,
    };
    const polymarketContext: LiveOrderContext = {
      executionGroupId,
      clientOrderId: polymarketClientOrderId,
      size: this.config.liveOrderSize,
      maxBuyPrice: prepared.polymarket.maxBuyPrice,
      requiredCollateral: roundPrice(this.config.liveOrderSize * prepared.polymarket.maxBuyPrice + this.config.liveCollateralBufferDollars),
      requestedAt,
    };
    const preflightFailure = await this.preflightVenueOrders([
      { client: this.kalshiClient, leg: prepared.kalshi.leg, context: kalshiContext },
      { client: this.polymarketClient, leg: prepared.polymarket.leg, context: polymarketContext },
    ]);
    if (preflightFailure) {
      return {
        ...skipped(preflightFailure),
        quoteSnapshot: prepared.quoteSnapshot,
        depthVwap: prepared.quoteSnapshot.projectedPremium,
        projectedEdgeAfterFees: prepared.quoteSnapshot.projectedEdgeAfterFees,
      };
    }
    // Submit Kalshi first during live canary. A read-only Kalshi key returns a
    // write-scope 403; placing Polymarket in parallel would create a one-sided
    // position. If Kalshi is not accepted exactly, abort before Polymarket.
    const kalshi = await this.placeVenueOrder(this.kalshiClient, prepared.kalshi.leg, kalshiContext);
    if (!this.isExactVenueFill(kalshi)) {
      return await this.resultFromVenueOrders(executionGroupId, kalshi, {
        venue: "polymarket",
        clientOrderId: polymarketClientOrderId,
        orderId: null,
        status: "not_submitted",
        fillPrice: null,
        fillCount: null,
        requestedAt: new Date(requestedAt).toISOString(),
        respondedAt: new Date(this.now()).toISOString(),
        error: "not submitted because Kalshi leg did not fill exactly",
      }, {
        quoteSnapshot: prepared.quoteSnapshot,
        executionTimings: this.executionTimings(executeStartedAt, kalshi, null),
      });
    }

    const refreshed = this.prepareExecution(candidate, prepared.kalshi.leg, prepared.polymarket.leg);
    if (typeof refreshed === "string") {
      return await this.resultFromVenueOrders(executionGroupId, kalshi, {
        venue: "polymarket",
        clientOrderId: polymarketClientOrderId,
        orderId: null,
        status: "not_submitted",
        fillPrice: null,
        fillCount: null,
        requestedAt: new Date(this.now()).toISOString(),
        respondedAt: new Date(this.now()).toISOString(),
        error: `not submitted because fresh post-Kalshi quote preflight failed: ${refreshed}`,
      }, {
        quoteSnapshot: prepared.quoteSnapshot,
        executionTimings: this.executionTimings(executeStartedAt, kalshi, null),
      });
    }

    const refreshedPolymarketContext: LiveOrderContext = {
      ...polymarketContext,
      maxBuyPrice: refreshed.polymarket.maxBuyPrice,
      requiredCollateral: roundPrice(this.config.liveOrderSize * refreshed.polymarket.maxBuyPrice + this.config.liveCollateralBufferDollars),
      requestedAt: this.now(),
    };
    const postFillPreflight = await this.preflightVenueOrders([
      { client: this.polymarketClient, leg: refreshed.polymarket.leg, context: refreshedPolymarketContext },
    ]);
    if (postFillPreflight) {
      return await this.resultFromVenueOrders(executionGroupId, kalshi, {
        venue: "polymarket",
        clientOrderId: polymarketClientOrderId,
        orderId: null,
        status: "not_submitted",
        fillPrice: null,
        fillCount: null,
        requestedAt: new Date(this.now()).toISOString(),
        respondedAt: new Date(this.now()).toISOString(),
        error: `not submitted because fresh Polymarket preflight failed: ${postFillPreflight}`,
      }, {
        quoteSnapshot: refreshed.quoteSnapshot,
        executionTimings: this.executionTimings(executeStartedAt, kalshi, null),
      });
    }

    const polymarket = await this.placeVenueOrder(this.polymarketClient, refreshed.polymarket.leg, refreshedPolymarketContext);
    const venueConfirmations = await this.confirmVenueOrders(executionGroupId, [
      { result: kalshi, leg: prepared.kalshi.leg, submittedAtMs: requestedAt },
      { result: polymarket, leg: refreshed.polymarket.leg, submittedAtMs: refreshedPolymarketContext.requestedAt ?? this.now() },
    ]);

    return await this.resultFromVenueOrders(executionGroupId, kalshi, polymarket, {
      quoteSnapshot: refreshed.quoteSnapshot,
      executionTimings: this.executionTimings(executeStartedAt, kalshi, polymarket),
      venueConfirmations,
    });
  }

  private failed(reason: string): ExecutionResult {
    return failed(reason);
  }

  private prepareExecution(candidate: ArbCandidate, kalshiLeg: ArbLeg, polymarketLeg: ArbLeg): PreparedExecution | string {
    const now = this.now();
    if (!Number.isFinite(this.config.liveOrderSize) || this.config.liveOrderSize <= 0) return "LIVE_ORDER_SIZE must be greater than 0";
    if (candidate.expiryMs - now < this.config.liveMinExpiryMs) return "candidate too close to expiry for live execution";
    const evaluation = evaluateLiveQuoteQuality(candidate, this.liveBooksForPreflight(kalshiLeg, polymarketLeg), this.config, now);
    if (!evaluation.ok) return evaluation.reason ?? "live quote quality preflight failed";
    if (!evaluation.kalshiLeg || !evaluation.polymarketLeg || evaluation.kalshiMaxBuyPrice == null || evaluation.polymarketMaxBuyPrice == null) {
      return "live quote quality preflight missing executable legs";
    }
    return {
      kalshi: { leg: evaluation.kalshiLeg, maxBuyPrice: evaluation.kalshiMaxBuyPrice },
      polymarket: { leg: evaluation.polymarketLeg, maxBuyPrice: evaluation.polymarketMaxBuyPrice },
      quoteSnapshot: evaluation.snapshot,
    };
  }

  private liveBooksForPreflight(kalshiLeg: ArbLeg, polymarketLeg: ArbLeg): { kalshi: BinaryContract[]; polymarket: BinaryContract[] } {
    if (this.books) return this.books.snapshot();
    const synthetic = (leg: ArbLeg): BinaryContract => ({
      venue: leg.venue,
      contractId: leg.contractId,
      asset: "BTC",
      expiryMs: 0,
      strike: leg.strike,
      yesAsk: leg.direction === "yes" ? leg.ask : null,
      noAsk: leg.direction === "no" ? leg.ask : null,
      yesBid: null,
      noBid: null,
      yesAskLevels: leg.direction === "yes" ? [{ price: leg.ask, size: Number.POSITIVE_INFINITY }] : [],
      noAskLevels: leg.direction === "no" ? [{ price: leg.ask, size: Number.POSITIVE_INFINITY }] : [],
      tokenId: leg.tokenId,
      updatedAt: this.now(),
    } as BinaryContract);
    return {
      kalshi: [synthetic(kalshiLeg)],
      polymarket: [synthetic(polymarketLeg)],
    };
  }

  private currentAsk(leg: ArbLeg): BinaryContract | null {
    if (!this.books) return {
      venue: leg.venue,
      contractId: leg.contractId,
      asset: "BTC",
      expiryMs: 0,
      strike: leg.strike,
      yesAsk: leg.direction === "yes" ? leg.ask : null,
      noAsk: leg.direction === "no" ? leg.ask : null,
      yesBid: null,
      noBid: null,
      tokenId: leg.tokenId,
      updatedAt: this.now(),
    } as BinaryContract;
    const snapshot = this.books.snapshot();
    return snapshot[leg.venue].find((contract) => contract.contractId === leg.contractId) ?? null;
  }

  private async placeVenueOrder(client: VenueOrderClient, leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
    try {
      const timeoutMs = Math.max(1, this.config.liveOrderTimeoutMs);
      const timeout = new Promise<VenueOrderResult>((resolve) => {
        setTimeout(() => {
          resolve(failedVenueResult(
            client.venue,
            context.clientOrderId,
            new Error(`order response timeout after ${timeoutMs}ms`),
            context.requestedAt ?? this.now(),
          ));
        }, timeoutMs);
      });
      return await Promise.race([client.placeOrder(leg, context), timeout]);
    } catch (error) {
      return failedVenueResult(client.venue, context.clientOrderId, error, context.requestedAt ?? this.now());
    }
  }

  private async preflightVenueOrders(
    orders: Array<{ client: VenueOrderClient; leg: ArbLeg; context: LiveOrderContext }>,
  ): Promise<string | null> {
    for (const order of orders) {
      try {
        const reason = await order.client.preflightOrder?.(order.leg, order.context);
        if (reason) return reason;
      } catch (error) {
        return `${order.client.venue} live preflight failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return null;
  }

  private async confirmationPreflight(candidate: ArbCandidate): Promise<ExecutionResult | null> {
    if (!this.config.liveUserStreamsEnabled) return null;
    const reason = this.confirmationMonitor
      ? await this.confirmationMonitor.preflight(candidate, this.now())
      : "live user stream confirmation is enabled but not configured";
    if (!reason) return null;
    const lockReason = `live safety lock engaged: ${reason}`;
    await this.liveLocks?.engageLock({ reason: lockReason, details: { phase: "user_stream_preflight" } });
    return liveLocked(lockReason);
  }

  private isExactVenueFill(result: VenueOrderResult): boolean {
    return !result.error
      && (result.fillCount ?? 0) >= this.config.liveOrderSize
      && Math.abs((result.fillCount ?? 0) - this.config.liveOrderSize) <= 0.000001;
  }

  private async confirmVenueOrders(
    executionGroupId: string,
    orders: Array<{ result: VenueOrderResult; leg: ArbLeg; submittedAtMs: number }>,
  ): Promise<VenueConfirmations | null> {
    if (!this.config.liveUserStreamsEnabled || !this.confirmationMonitor) return null;
    const entries = await Promise.all(orders.map(async ({ result, leg, submittedAtMs }) => {
      const confirmation = await this.confirmationMonitor!.waitForVenueResult(result, {
        executionGroupId,
        expectedSize: this.config.liveOrderSize,
        leg,
        submittedAtMs,
        timeoutMs: this.config.liveUserStreamConfirmTimeoutMs,
      });
      return [result.venue, this.confirmationRecord(confirmation)] as const;
    }));
    return Object.fromEntries(entries);
  }

  private confirmationRecord(confirmation: VenueConfirmationResult): Record<string, unknown> {
    return {
      status: confirmation.status,
      reason: confirmation.reason,
      clientOrderId: confirmation.clientOrderId,
      venueOrderId: confirmation.venueOrderId,
      fillCount: confirmation.fillCount,
      fillPrice: confirmation.fillPrice,
      fee: confirmation.fee,
      exchangeTimestampMs: confirmation.exchangeTimestampMs,
      receivedAtMs: confirmation.receivedAtMs,
      eventType: confirmation.eventType,
    };
  }

  private async resultFromVenueOrders(
    executionGroupId: string,
    kalshi: VenueOrderResult,
    polymarket: VenueOrderResult,
    metadata: { quoteSnapshot?: QuoteSnapshot | null; executionTimings?: ExecutionTimings | null; venueConfirmations?: VenueConfirmations | null } = {},
  ): Promise<ExecutionResult> {
    await Promise.all([
      this.orderEvents?.recordVenueResult(executionGroupId, kalshi) ?? Promise.resolve(),
      this.orderEvents?.recordVenueResult(executionGroupId, polymarket) ?? Promise.resolve(),
    ]);
    const kalshiFilled = this.isExactVenueFill(kalshi);
    const polymarketFilled = this.isExactVenueFill(polymarket);
    const kalshiFillCount = kalshi.fillCount ?? 0;
    const polymarketFillCount = polymarket.fillCount ?? 0;
    const kalshiHasFill = kalshiFillCount > 0;
    const polymarketHasFill = polymarketFillCount > 0;
    const unexpectedFillCount = (kalshiHasFill && !kalshiFilled) || (polymarketHasFill && !polymarketFilled);
    const fillCountMismatch = kalshiHasFill && polymarketHasFill && Math.abs(kalshiFillCount - polymarketFillCount) > 0.000001;
    const partialFill = kalshiFilled !== polymarketFilled || unexpectedFillCount || fillCountMismatch;
    const realizedGuaranteedProfit = kalshi.fillPrice != null && polymarket.fillPrice != null
      ? roundPrice(1 - (kalshi.fillPrice + polymarket.fillPrice + this.realizedFeePerSpread(kalshi, polymarket)))
      : null;
    const realizedEdgeUnsafe = kalshiHasFill && polymarketHasFill && (
      realizedGuaranteedProfit == null || realizedGuaranteedProfit + 1e-9 < this.config.minProfitDollars
    );
    const liveLockReason = this.confirmationLockReason(metadata.venueConfirmations)
      ?? this.liveLockReason(partialFill, realizedGuaranteedProfit, kalshi, polymarket);
    if (liveLockReason) this.partialFillLocked = true;
    const failureReason = [kalshi, polymarket]
      .filter((result) => result.error || (result.fillCount ?? 0) < this.config.liveOrderSize)
      .map((result) => `${result.venue}: ${result.error ?? result.status}`)
      .join("; ") || null;
    const action: ExecutionResult["action"] = kalshiFilled && polymarketFilled && !partialFill && !realizedEdgeUnsafe && !liveLockReason
      ? "filled"
      : "failed";
    this.lastAttempt = {
      executionGroupId,
      action,
      partialFill,
      failureReason: liveLockReason ?? failureReason,
      liveLockReason,
      kalshiStatus: kalshi.status,
      polymarketStatus: polymarket.status,
      completedAt: this.now(),
    };
    const result: ExecutionResult = {
      action,
      failureReason: liveLockReason ?? failureReason,
      kalshiFillId: kalshi.orderId,
      polymarketFillId: polymarket.orderId,
      kalshiFillPrice: kalshi.fillPrice,
      polymarketFillPrice: polymarket.fillPrice,
      executionGroupId,
      kalshiClientOrderId: kalshi.clientOrderId,
      polymarketClientOrderId: polymarket.clientOrderId,
      kalshiStatus: kalshi.status,
      polymarketStatus: polymarket.status,
      kalshiFillCount: kalshi.fillCount,
      polymarketFillCount: polymarket.fillCount,
      kalshiRequestedAt: kalshi.requestedAt,
      kalshiRespondedAt: kalshi.respondedAt,
      polymarketRequestedAt: polymarket.requestedAt,
      polymarketRespondedAt: polymarket.respondedAt,
      kalshiError: kalshi.error,
      polymarketError: polymarket.error,
      partialFill,
      liveLockReason,
      quoteSnapshot: metadata.quoteSnapshot ?? null,
      depthVwap: metadata.quoteSnapshot?.projectedPremium ?? null,
      projectedEdgeAfterFees: metadata.quoteSnapshot?.projectedEdgeAfterFees ?? null,
      executionTimings: metadata.executionTimings ?? null,
      venueConfirmations: metadata.venueConfirmations ?? {
        kalshi: {
          status: kalshi.status,
          exchangeTimestampMs: kalshi.exchangeTimestampMs ?? null,
          fee: kalshi.fee ?? null,
        },
        polymarket: {
          status: polymarket.status,
          exchangeTimestampMs: polymarket.exchangeTimestampMs ?? null,
          fee: polymarket.fee ?? null,
        },
      },
    };
    if (liveLockReason) {
      await this.liveLocks?.engageLock({
        reason: liveLockReason,
        executionGroupId,
        details: {
          kalshiStatus: kalshi.status,
          polymarketStatus: polymarket.status,
          kalshiFillCount,
          polymarketFillCount,
          kalshiFillPrice: kalshi.fillPrice,
          polymarketFillPrice: polymarket.fillPrice,
          kalshiFee: kalshi.fee ?? null,
          polymarketFee: polymarket.fee ?? null,
          realizedGuaranteedProfit,
          quoteSnapshot: metadata.quoteSnapshot ?? null,
          executionTimings: metadata.executionTimings ?? null,
        },
      });
    }
    return result;
  }

  private realizedFeePerSpread(kalshi: VenueOrderResult, polymarket: VenueOrderResult): number {
    const totalFees = (kalshi.fee ?? 0) + (polymarket.fee ?? 0);
    const filledSize = Math.min(kalshi.fillCount ?? 0, polymarket.fillCount ?? 0);
    if (!Number.isFinite(totalFees) || totalFees <= 0 || filledSize <= 0) return 0;
    return totalFees / filledSize;
  }

  private confirmationLockReason(confirmations: VenueConfirmations | null | undefined): string | null {
    for (const venue of ["kalshi", "polymarket"] as const) {
      const confirmation = confirmations?.[venue];
      if (!confirmation || typeof confirmation !== "object") continue;
      const status = String((confirmation as Record<string, unknown>).status ?? "");
      const reason = (confirmation as Record<string, unknown>).reason;
      if (["timeout", "mismatch", "failed"].includes(status)) {
        return `live safety lock engaged: ${venue} private stream confirmation ${status}${typeof reason === "string" && reason ? `: ${reason}` : ""}`;
      }
    }
    return null;
  }

  private executionTimings(startedAt: number, kalshi: VenueOrderResult | null, polymarket: VenueOrderResult | null): ExecutionTimings {
    const timing = (result: VenueOrderResult | null): number | null => {
      if (!result) return null;
      const requestedAt = Date.parse(result.requestedAt);
      const respondedAt = Date.parse(result.respondedAt);
      if (!Number.isFinite(requestedAt) || !Number.isFinite(respondedAt)) return null;
      return Math.max(0, respondedAt - requestedAt);
    };
    const completedAt = polymarket ? Date.parse(polymarket.respondedAt) : kalshi ? Date.parse(kalshi.respondedAt) : this.now();
    return {
      candidateToSubmitMs: Math.max(0, (kalshi ? Date.parse(kalshi.requestedAt) : startedAt) - startedAt),
      kalshiRttMs: timing(kalshi),
      polymarketRttMs: timing(polymarket),
      totalMs: Number.isFinite(completedAt) ? Math.max(0, completedAt - startedAt) : null,
    };
  }

  private liveLockReason(
    partialFill: boolean,
    realizedGuaranteedProfit: number | null,
    kalshi: VenueOrderResult,
    polymarket: VenueOrderResult,
  ): string | null {
    const kalshiFillCount = kalshi.fillCount ?? 0;
    const polymarketFillCount = polymarket.fillCount ?? 0;
    const hasAnyFill = kalshiFillCount > 0 || polymarketFillCount > 0;
    const hasUnknownResponse = [kalshi, polymarket].some((result) => result.error?.toLowerCase().includes("timeout")
      || result.status === "unknown");
    if (hasUnknownResponse) {
      return "live safety lock engaged: venue order response was timeout/unknown and requires reconciliation";
    }
    if (!hasAnyFill) return null;
    if (partialFill) {
      return `live safety lock engaged: venue fill mismatch kalshi=${kalshiFillCount} polymarket=${polymarketFillCount}`;
    }
    if (realizedGuaranteedProfit == null) {
      return "live safety lock engaged: filled order missing realized fill prices";
    }
    if (realizedGuaranteedProfit + 1e-9 < this.config.minProfitDollars) {
      return `live safety lock engaged: realized edge ${realizedGuaranteedProfit.toFixed(4)} below threshold ${this.config.minProfitDollars.toFixed(4)}`;
    }
    return null;
  }
}
