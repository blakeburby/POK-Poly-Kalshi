import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import type { LiveExecutionLockWriter } from "../db/live-execution-locks";
import type { VenueOrderEventWriter } from "../db/venue-order-events";
import { protectedCandidateBlockReason } from "../scanner/safety";
import type { ArbCandidate, ArbLeg, BinaryContract, ExecutionResult, ExecutionStrategy, ExecutionTimings, LiveExecutionLastAttempt, LiveExecutionReadiness, LiveRecoveryStatus, LiveRiskState, QuoteSnapshot, ReconciliationResolution, Venue, VenueConfirmations, VenueExecutionReadiness } from "../types";
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

function waitMs(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function venueLabel(venue: Venue): string {
  return venue === "kalshi" ? "Kalshi" : "Polymarket";
}

function isTimeoutOrUnknownResult(result: VenueOrderResult): boolean {
  return result.status === "unknown" || result.error?.toLowerCase().includes("timeout") === true;
}

function isUserStreamPreflightReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  const mentionsUserStream = normalized.includes("user stream") || normalized.includes("user subscription");
  return mentionsUserStream
    && (
      normalized.includes("not connected")
      || normalized.includes("not subscribed")
      || normalized.includes("not ready")
      || normalized.includes("not configured")
      || normalized.includes("refreshing")
    );
}

function isRetryablePreSubmitReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const normalized = reason.toLowerCase();
  if (isUserStreamPreflightReason(reason)) return true;
  if (
    normalized.includes("hot-path lock cache has not been hydrated")
    || normalized.includes("hot-path lock cache is stale")
    || normalized.includes("hot-path exposure cache is stale")
    || normalized.includes("hot readiness cache is stale")
    || normalized.includes("readiness cache is stale")
  ) return true;
  if (
    normalized.includes("quote revalidation after preflight failed")
    && (
      normalized.includes("quote is stale")
      || normalized.includes("quote skew")
      || normalized.includes("tick size changed")
    )
  ) return true;
  return false;
}

function recoveryStatusLabel(status: LiveRecoveryStatus | null | undefined): string {
  return status?.replace(/_/g, " ") ?? "none";
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

interface PreparedHedge {
  leg: ArbLeg;
  maxBuyPrice: number;
  requiredCollateral: number;
  hedgeCapPrice: number;
  quoteSnapshot: QuoteSnapshot;
}

interface VenueExecutionPlan {
  venue: Venue;
  client: VenueOrderClient;
  prepared: PreparedLeg;
  context: LiveOrderContext;
  clientOrderId: string;
}

interface ExecutionMetadata {
  quoteSnapshot?: QuoteSnapshot | null;
  executionTimings?: ExecutionTimings | null;
  venueConfirmations?: VenueConfirmations | null;
  executionStrategy?: ExecutionStrategy;
  riskHedge?: boolean;
  hedgeCapPrice?: number | null;
  hedgeFailureReason?: string | null;
  postFillHedgeDecisionMs?: number | null;
  hotGateStartedAt?: number;
  hotGateCompletedAt?: number;
  recoveryStatus?: LiveRecoveryStatus | null;
  recoveryAttempts?: number | null;
  recoveryEvidence?: Record<string, unknown> | null;
  finalizationMs?: number | null;
  reconciliationResolvedAt?: string | null;
  reconciliationResolutionReason?: string | null;
  reconciliationResolution?: ReconciliationResolution | null;
  riskQuarantinedAt?: string | null;
  riskQuarantineReason?: string | null;
  riskQuarantineExposureDollars?: number | null;
  riskQuarantineEvidence?: Record<string, unknown> | null;
}

export interface RiskQuarantineExposureReader {
  unresolvedRiskQuarantineExposureDollars(): Promise<number>;
  liveRiskQuarantineStatus?(): Promise<{ total: number; count: number }>;
}

interface RiskQuarantineDecision {
  quarantinedAt: string;
  reason: string;
  exposureDollars: number;
  evidence: Record<string, unknown>;
}

interface SequentialFirstVenueDecision {
  firstVenue: Venue;
  firstVenueReason: string;
  firstVenueVwap: number | null;
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
    hedgeMaxLossDollars: config.liveHedgeMaxLossDollars,
    hedgeFeeBufferDollars: config.liveHedgeFeeBufferDollars,
    orderPlacementMode: config.liveOrderPlacementMode,
    aggressiveLimitRestMs: config.liveAggressiveLimitRestMs,
    parallelExecutionEnabled: config.liveParallelExecutionEnabled,
    hotPathEnabled: config.liveHotPathEnabled,
    hotPathCacheMaxAgeMs: config.liveHotPathCacheMaxAgeMs,
    polymarketPresignEnabled: config.livePolymarketPresignEnabled,
    partialFillLockMode: config.livePartialFillLockMode,
    maxUnresolvedExposureDollars: config.liveMaxUnresolvedExposureDollars,
    orderTimeoutMs: config.liveOrderTimeoutMs,
    kalshiOrderGroupEnabled: config.liveKalshiOrderGroupEnabled && Boolean(config.liveKalshiOrderGroupId),
    userStreams: buildUserStreamReadiness(false, config.liveUserStreamConfirmTimeoutMs, undefined, undefined, now),
    reconciliation: defaultReconciliationReadiness(false, null, null),
    riskState: "trading",
    riskStateReason: null,
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
    private readonly quarantineExposureReader?: RiskQuarantineExposureReader,
  ) {}

  async warm(options: { tokenIds?: string[]; now?: number } = {}): Promise<void> {
    const now = options.now ?? this.now();
    const requiredCollateral = roundPrice(this.config.liveOrderSize + this.config.liveCollateralBufferDollars);
    await Promise.all([
      this.kalshiClient.warm?.({ now, requiredCollateral }) ?? Promise.resolve(),
      this.polymarketClient.warm?.({ now, tokenIds: options.tokenIds, requiredCollateral }) ?? Promise.resolve(),
    ]);
  }

  async readiness(now = this.now()): Promise<LiveExecutionReadiness> {
    const [kalshi, polymarket, activeLock, quarantineStatus] = await Promise.all([
      this.kalshiClient.readiness(now),
      this.polymarketClient.readiness(now),
      this.liveLocks?.getActiveLock() ?? Promise.resolve(null),
      this.quarantineExposureReader?.liveRiskQuarantineStatus?.()
        ?? this.quarantineExposureReader?.unresolvedRiskQuarantineExposureDollars().then((total) => ({ total, count: total > 0 ? 1 : 0 }))
        ?? Promise.resolve(null),
    ]);
    const userStreams = this.confirmationMonitor?.userStreamReadiness(now)
      ?? buildUserStreamReadiness(
        this.config.liveUserStreamsEnabled,
        this.config.liveUserStreamConfirmTimeoutMs,
        undefined,
        undefined,
        now,
      );
    const baseReconciliation = this.confirmationMonitor?.reconciliationReadiness(now)
      ?? defaultReconciliationReadiness(
        this.config.liveReconcileBeforeTrade,
        null,
        this.config.liveUserStreamsEnabled ? "live reconciliation monitor is not configured" : null,
      );
    const reconciliation = quarantineStatus
      ? {
        ...baseReconciliation,
        quarantinedExposureDollars: baseReconciliation.quarantinedExposureDollars ?? quarantineStatus.total,
        quarantinedSignalCount: baseReconciliation.quarantinedSignalCount ?? quarantineStatus.count,
        quarantineCapDollars: baseReconciliation.quarantineCapDollars ?? this.config.liveMaxUnresolvedExposureDollars,
      }
      : baseReconciliation;
    const riskState = this.liveRiskState(activeLock?.reason ?? null, reconciliation, userStreams.reason);
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
      hedgeMaxLossDollars: this.config.liveHedgeMaxLossDollars,
      hedgeFeeBufferDollars: this.config.liveHedgeFeeBufferDollars,
      orderPlacementMode: this.config.liveOrderPlacementMode,
      aggressiveLimitRestMs: this.config.liveAggressiveLimitRestMs,
      parallelExecutionEnabled: this.config.liveParallelExecutionEnabled,
      hotPathEnabled: this.config.liveHotPathEnabled,
      hotPathCacheMaxAgeMs: this.config.liveHotPathCacheMaxAgeMs,
      polymarketPresignEnabled: this.config.livePolymarketPresignEnabled,
      partialFillLockMode: this.config.livePartialFillLockMode,
      maxUnresolvedExposureDollars: this.config.liveMaxUnresolvedExposureDollars,
      orderTimeoutMs: this.config.liveOrderTimeoutMs,
      kalshiOrderGroupEnabled: this.config.liveKalshiOrderGroupEnabled && Boolean(this.config.liveKalshiOrderGroupId),
      userStreams,
      reconciliation,
      riskState: riskState.state,
      riskStateReason: riskState.reason,
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
    const maxRetries = Math.max(0, Math.floor(this.config.livePretradeRetryAttempts));
    const retryDelayMs = Math.max(0, this.config.livePretradeRetryDelayMs);
    const evidence: Array<Record<string, unknown>> = [];

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const result = await this.executeOnce(candidate);
      const shouldRetry = result.executionGroupId == null
        && isRetryablePreSubmitReason(result.failureReason)
        && attempt < maxRetries;
      if (!shouldRetry) {
        return this.withRecoveryMetadata(result, {
          status: evidence.length > 0 ? "pretrade_retry" : result.recoveryStatus ?? "none",
          attempts: evidence.length,
          evidence: evidence.length > 0 ? { pretradeRetries: evidence } : result.recoveryEvidence ?? null,
        });
      }
      evidence.push({
        attempt: attempt + 1,
        reason: result.failureReason,
        at: this.now(),
      });
      await waitMs(retryDelayMs);
    }

    return this.withRecoveryMetadata(skipped("live pretrade retry loop exhausted unexpectedly"), {
      status: "pretrade_retry",
      attempts: evidence.length,
      evidence: { pretradeRetries: evidence },
    });
  }

  private async executeOnce(candidate: ArbCandidate): Promise<ExecutionResult> {
    const executeStartedAt = this.now();
    const hotGateStartedAt = executeStartedAt;
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

    let prepared = this.prepareExecution(candidate, kalshiLeg, polymarketLeg);
    if (typeof prepared === "string") return skipped(prepared);

    const executionGroupId = randomUUID();
    const kalshiClientOrderId = generatedClientOrderId("kalshi");
    const polymarketClientOrderId = generatedClientOrderId("polymarket");
    const placementMode = this.config.liveParallelExecutionEnabled ? this.config.liveOrderPlacementMode : "parallel_fok";
    const limitRestMs = placementMode === "parallel_limit_rest" ? Math.max(0, this.config.liveAggressiveLimitRestMs) : undefined;
    let kalshiContext: LiveOrderContext = {
      executionGroupId,
      clientOrderId: kalshiClientOrderId,
      size: this.config.liveOrderSize,
      maxBuyPrice: prepared.kalshi.maxBuyPrice,
      orderGroupId: this.config.liveKalshiOrderGroupEnabled ? this.config.liveKalshiOrderGroupId || undefined : undefined,
      placementMode,
      limitRestMs,
    };
    let polymarketContext: LiveOrderContext = {
      executionGroupId,
      clientOrderId: polymarketClientOrderId,
      size: this.config.liveOrderSize,
      maxBuyPrice: prepared.polymarket.maxBuyPrice,
      requiredCollateral: roundPrice(this.config.liveOrderSize * prepared.polymarket.maxBuyPrice + this.config.liveCollateralBufferDollars),
      placementMode,
      limitRestMs,
    };
    const preflightStartedAt = this.now();
    const preflightFailure = await this.preflightVenueOrders([
      { client: this.kalshiClient, leg: prepared.kalshi.leg, context: kalshiContext },
      { client: this.polymarketClient, leg: prepared.polymarket.leg, context: polymarketContext },
    ]);
    const preflightCompletedAt = this.now();
    if (preflightFailure) {
      return {
        ...skipped(preflightFailure),
        quoteSnapshot: prepared.quoteSnapshot,
        depthVwap: prepared.quoteSnapshot.projectedPremium,
        projectedEdgeAfterFees: prepared.quoteSnapshot.projectedEdgeAfterFees,
        executionTimings: this.executionTimings(executeStartedAt, null, null, { preflightStartedAt, preflightCompletedAt, hotGateStartedAt, hotGateCompletedAt: preflightCompletedAt }),
      };
    }
    if (preflightCompletedAt - preflightStartedAt > this.config.liveQuoteMaxAgeMs) {
      return {
        ...skipped(`live preflight took ${preflightCompletedAt - preflightStartedAt}ms, exceeding quote freshness window ${this.config.liveQuoteMaxAgeMs}ms`),
        quoteSnapshot: prepared.quoteSnapshot,
        depthVwap: prepared.quoteSnapshot.projectedPremium,
        projectedEdgeAfterFees: prepared.quoteSnapshot.projectedEdgeAfterFees,
        executionTimings: this.executionTimings(executeStartedAt, null, null, { preflightStartedAt, preflightCompletedAt, hotGateStartedAt, hotGateCompletedAt: preflightCompletedAt }),
      };
    }
    const refreshed = this.prepareExecution(candidate, kalshiLeg, polymarketLeg);
    if (typeof refreshed === "string") {
      return {
        ...skipped(`live quote revalidation after preflight failed: ${refreshed}`),
        quoteSnapshot: prepared.quoteSnapshot,
        depthVwap: prepared.quoteSnapshot.projectedPremium,
        projectedEdgeAfterFees: prepared.quoteSnapshot.projectedEdgeAfterFees,
        executionTimings: this.executionTimings(executeStartedAt, null, null, { preflightStartedAt, preflightCompletedAt, hotGateStartedAt, hotGateCompletedAt: this.now() }),
      };
    }
    prepared = refreshed;
    kalshiContext = { ...kalshiContext, maxBuyPrice: prepared.kalshi.maxBuyPrice };
    polymarketContext = {
      ...polymarketContext,
      maxBuyPrice: prepared.polymarket.maxBuyPrice,
      requiredCollateral: roundPrice(this.config.liveOrderSize * prepared.polymarket.maxBuyPrice + this.config.liveCollateralBufferDollars),
    };
    const hotGateCompletedAt = this.now();

    if (this.config.liveParallelExecutionEnabled) {
      const executionStrategy = placementMode === "parallel_limit_rest" ? "parallel_limit_rest" : "parallel_fok";
      const firstVenueReason = placementMode === "parallel_limit_rest"
        ? `parallel aggressive limit orders submitted concurrently with ${limitRestMs ?? 0}ms rest`
        : "parallel FOK orders submitted concurrently";
      const [kalshi, polymarket] = await Promise.all([
        this.placeVenueOrder(this.kalshiClient, prepared.kalshi.leg, kalshiContext),
        this.placeVenueOrder(this.polymarketClient, prepared.polymarket.leg, polymarketContext),
      ]);
      const venueConfirmations = await this.confirmVenueOrders(executionGroupId, [
        { result: kalshi, leg: prepared.kalshi.leg, submittedAtMs: Date.parse(kalshi.requestedAt) },
        { result: polymarket, leg: prepared.polymarket.leg, submittedAtMs: Date.parse(polymarket.requestedAt) },
      ]);
      const confirmed = this.applyVenueConfirmations(kalshi, polymarket, venueConfirmations);
      return await this.resultFromVenueOrders(executionGroupId, confirmed.kalshi, confirmed.polymarket, {
        quoteSnapshot: prepared.quoteSnapshot,
        executionTimings: this.executionTimings(executeStartedAt, confirmed.kalshi, confirmed.polymarket, {
          preflightStartedAt,
          preflightCompletedAt,
          firstVenue: null,
          firstVenueReason,
          firstVenueVwap: null,
          hotGateStartedAt,
          hotGateCompletedAt,
        }),
        venueConfirmations,
        executionStrategy,
        riskHedge: false,
      });
    }

    const kalshiPlan: VenueExecutionPlan = {
      venue: "kalshi",
      client: this.kalshiClient,
      prepared: prepared.kalshi,
      context: kalshiContext,
      clientOrderId: kalshiClientOrderId,
    };
    const polymarketPlan: VenueExecutionPlan = {
      venue: "polymarket",
      client: this.polymarketClient,
      prepared: prepared.polymarket,
      context: polymarketContext,
      clientOrderId: polymarketClientOrderId,
    };
    const firstDecision = this.selectSequentialFirstVenue(prepared);
    const firstPlan = firstDecision.firstVenue === "kalshi" ? kalshiPlan : polymarketPlan;
    const hedgePlan = firstPlan.venue === "kalshi" ? polymarketPlan : kalshiPlan;
    const results: Partial<Record<Venue, VenueOrderResult>> = {};

    // Capture the cheap leg first. The old Kalshi-first sequence let fast-moving
    // Polymarket mispricings disappear before the Polymarket order was ever sent.
    const firstResult = await this.placeVenueOrder(firstPlan.client, firstPlan.prepared.leg, firstPlan.context);
    results[firstPlan.venue] = firstResult;
    if (!this.isExactVenueFill(firstResult)) {
      results[hedgePlan.venue] = this.notSubmittedResult(
        hedgePlan.venue,
        hedgePlan.clientOrderId,
        `not submitted because ${venueLabel(firstPlan.venue)} leg did not fill exactly`,
      );
      return await this.resultFromVenueOrders(executionGroupId, results.kalshi!, results.polymarket!, {
        quoteSnapshot: prepared.quoteSnapshot,
        executionTimings: this.executionTimings(executeStartedAt, results.kalshi ?? null, results.polymarket ?? null, {
          preflightStartedAt,
          preflightCompletedAt,
          hotGateStartedAt,
          hotGateCompletedAt,
          ...firstDecision,
        }),
        executionStrategy: "sequential_hedge",
        riskHedge: false,
      });
    }

    const hedgeDecisionStartedAt = this.now();
    const hedge = this.prepareVenueHedge(candidate, firstPlan.prepared.leg, hedgePlan.prepared.leg, firstResult);
    const postFillHedgeDecisionMs = Math.max(0, this.now() - hedgeDecisionStartedAt);
    if (typeof hedge === "string") {
      const hedgeFailureReason = `${venueLabel(hedgePlan.venue)} hedge cap preflight failed: ${hedge}`;
      results[hedgePlan.venue] = this.notSubmittedResult(
        hedgePlan.venue,
        hedgePlan.clientOrderId,
        `not submitted because ${hedgeFailureReason}`,
      );
      return await this.resultFromVenueOrders(executionGroupId, results.kalshi!, results.polymarket!, {
        quoteSnapshot: prepared.quoteSnapshot,
        executionTimings: this.executionTimings(executeStartedAt, results.kalshi ?? null, results.polymarket ?? null, {
          preflightStartedAt,
          preflightCompletedAt,
          hotGateStartedAt,
          hotGateCompletedAt,
          postFillHedgeDecisionMs,
          ...firstDecision,
        }),
        executionStrategy: "sequential_hedge",
        riskHedge: true,
        hedgeCapPrice: null,
        hedgeFailureReason,
      });
    }

    const hedgeContext: LiveOrderContext = {
      ...hedgePlan.context,
      maxBuyPrice: hedge.maxBuyPrice,
      requiredCollateral: hedge.requiredCollateral,
    };
    const postFillPreflight = await this.preflightVenueOrders([
      { client: hedgePlan.client, leg: hedge.leg, context: hedgeContext },
    ]);
    if (postFillPreflight) {
      const hedgeFailureReason = `fresh ${venueLabel(hedgePlan.venue)} preflight failed: ${postFillPreflight}`;
      results[hedgePlan.venue] = this.notSubmittedResult(
        hedgePlan.venue,
        hedgePlan.clientOrderId,
        `not submitted because ${hedgeFailureReason}`,
      );
      return await this.resultFromVenueOrders(executionGroupId, results.kalshi!, results.polymarket!, {
        quoteSnapshot: hedge.quoteSnapshot,
        executionTimings: this.executionTimings(executeStartedAt, results.kalshi ?? null, results.polymarket ?? null, {
          preflightStartedAt,
          preflightCompletedAt,
          hotGateStartedAt,
          hotGateCompletedAt,
          postFillHedgeDecisionMs,
          ...firstDecision,
        }),
        executionStrategy: "sequential_hedge",
        riskHedge: true,
        hedgeCapPrice: hedge.hedgeCapPrice,
        hedgeFailureReason,
      });
    }

    const hedgeResult = await this.placeVenueOrder(hedgePlan.client, hedge.leg, hedgeContext);
    results[hedgePlan.venue] = hedgeResult;
    const venueConfirmations = await this.confirmVenueOrders(executionGroupId, [
      { result: firstResult, leg: firstPlan.prepared.leg, submittedAtMs: Date.parse(firstResult.requestedAt) },
      { result: hedgeResult, leg: hedge.leg, submittedAtMs: Date.parse(hedgeResult.requestedAt) },
    ]);
    const confirmed = this.applyVenueConfirmations(results.kalshi!, results.polymarket!, venueConfirmations);

    return await this.resultFromVenueOrders(executionGroupId, confirmed.kalshi, confirmed.polymarket, {
      quoteSnapshot: hedge.quoteSnapshot,
      executionTimings: this.executionTimings(executeStartedAt, confirmed.kalshi, confirmed.polymarket, {
        preflightStartedAt,
        preflightCompletedAt,
        hotGateStartedAt,
        hotGateCompletedAt,
        postFillHedgeDecisionMs,
        ...firstDecision,
      }),
      venueConfirmations,
      executionStrategy: "sequential_hedge",
      riskHedge: true,
      hedgeCapPrice: hedge.hedgeCapPrice,
    });
  }

  private failed(reason: string): ExecutionResult {
    return failed(reason);
  }

  private withRecoveryMetadata(
    result: ExecutionResult,
    recovery: { status: LiveRecoveryStatus; attempts?: number | null; evidence?: Record<string, unknown> | null; finalizationMs?: number | null },
  ): ExecutionResult {
    const recoveryEvidence = recovery.evidence && result.recoveryEvidence
      ? { ...result.recoveryEvidence, ...recovery.evidence }
      : recovery.evidence ?? result.recoveryEvidence ?? null;
    return {
      ...result,
      recoveryStatus: recovery.status,
      recoveryAttempts: recovery.attempts ?? result.recoveryAttempts ?? 0,
      recoveryEvidence,
      finalizationMs: recovery.finalizationMs ?? result.finalizationMs ?? null,
    };
  }

  private liveRiskState(
    circuitBreakerReason: string | null,
    reconciliation: { reason: string | null; quarantinedExposureDollars?: number | null; quarantinedSignalCount?: number | null },
    userStreamReason: string | null,
  ): { state: LiveRiskState; reason: string | null } {
    if (circuitBreakerReason) return { state: "hard_locked", reason: circuitBreakerReason };
    if (this.partialFillLocked) return { state: "hard_locked", reason: "in-memory partial-fill latch is set" };
    if (reconciliation.reason) return { state: "blocked", reason: reconciliation.reason };
    if (userStreamReason) return { state: "blocked", reason: userStreamReason };
    const status = this.lastAttempt?.recoveryStatus ?? null;
    if (status === "finalizing" || status === "pretrade_retry") {
      return { state: "recovering", reason: `last attempt recovery status: ${recoveryStatusLabel(status)}` };
    }
    const quarantinedExposure = Math.max(
      reconciliation.quarantinedExposureDollars ?? 0,
      this.lastAttempt?.riskQuarantineExposureDollars ?? 0,
    );
    if (quarantinedExposure > 0) {
      return {
        state: "quarantined",
        reason: `trading with quarantined unresolved exposure ${quarantinedExposure.toFixed(2)} across ${reconciliation.quarantinedSignalCount ?? 1} signal(s)`,
      };
    }
    return { state: "trading", reason: null };
  }

  private notSubmittedResult(venue: Venue, clientOrderId: string, error: string): VenueOrderResult {
    const now = new Date(this.now()).toISOString();
    return {
      venue,
      clientOrderId,
      orderId: null,
      status: "not_submitted",
      fillPrice: null,
      fillCount: null,
      requestedAt: now,
      respondedAt: now,
      error,
    };
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

  private prepareVenueHedge(
    candidate: ArbCandidate,
    filledLeg: ArbLeg,
    hedgeLeg: ArbLeg,
    filled: VenueOrderResult,
  ): PreparedHedge | string {
    const now = this.now();
    const hedgeVenue = venueLabel(hedgeLeg.venue);
    if (candidate.expiryMs <= now) return `candidate expired before ${hedgeVenue} hedge could be submitted`;
    if (filled.fillPrice == null) return `${venueLabel(filledLeg.venue)} fill price missing; cannot calculate ${hedgeVenue} hedge cap`;
    const knownFilledFee = Math.max(0, filled.fee ?? 0);
    const rawHedgeCapPrice = 1 - filled.fillPrice - knownFilledFee - this.config.liveHedgeFeeBufferDollars + this.config.liveHedgeMaxLossDollars;
    const hedgeCapPrice = roundPrice(Math.min(1, Math.max(0, rawHedgeCapPrice)));
    if (!Number.isFinite(hedgeCapPrice) || hedgeCapPrice <= 0) {
      return `computed ${hedgeVenue} hedge cap ${hedgeCapPrice.toFixed(4)} is not executable`;
    }

    const kalshiLeg = filledLeg.venue === "kalshi" ? filledLeg : hedgeLeg;
    const polymarketLeg = filledLeg.venue === "polymarket" ? filledLeg : hedgeLeg;
    const evaluation = evaluateLiveQuoteQuality(candidate, this.liveBooksForPreflight(kalshiLeg, polymarketLeg), this.config, now);
    const hedgeQuote = hedgeLeg.venue === "kalshi" ? evaluation.snapshot.kalshi : evaluation.snapshot.polymarket;
    if (!hedgeQuote) return `${hedgeVenue} quote missing for hedge`;
    if (hedgeQuote.quoteAgeMs != null && hedgeQuote.quoteAgeMs > this.config.liveQuoteMaxAgeMs) {
      return `${hedgeVenue} hedge quote is stale: age ${hedgeQuote.quoteAgeMs}ms exceeds ${this.config.liveQuoteMaxAgeMs}ms`;
    }
    if (hedgeQuote.topAsk == null) return `${hedgeVenue} hedge ask is unavailable`;
    if (hedgeQuote.worstAsk == null || hedgeQuote.vwap == null) {
      return `${hedgeVenue} hedge depth ${roundPrice(hedgeQuote.depth)} below required ${hedgeQuote.depthRequired}`;
    }
    if (hedgeQuote.worstAsk > hedgeCapPrice + 1e-9) {
      return `${hedgeVenue} hedge worst ask ${hedgeQuote.worstAsk.toFixed(4)} exceeds cap ${hedgeCapPrice.toFixed(4)}`;
    }
    const leg = hedgeLeg.venue === "kalshi"
      ? evaluation.kalshiLeg ?? { ...hedgeLeg, ask: hedgeQuote.topAsk }
      : evaluation.polymarketLeg ?? { ...hedgeLeg, ask: hedgeQuote.topAsk };
    return {
      leg,
      maxBuyPrice: hedgeCapPrice,
      requiredCollateral: roundPrice(this.config.liveOrderSize * hedgeCapPrice + this.config.liveCollateralBufferDollars),
      hedgeCapPrice,
      quoteSnapshot: evaluation.snapshot,
    };
  }

  private selectSequentialFirstVenue(prepared: PreparedExecution): SequentialFirstVenueDecision {
    const kalshiVwap = prepared.quoteSnapshot.kalshi?.vwap ?? prepared.kalshi.maxBuyPrice;
    const polymarketVwap = prepared.quoteSnapshot.polymarket?.vwap ?? prepared.polymarket.maxBuyPrice;
    const kalshiWorstAsk = prepared.quoteSnapshot.kalshi?.worstAsk ?? prepared.kalshi.maxBuyPrice;
    const polymarketWorstAsk = prepared.quoteSnapshot.polymarket?.worstAsk ?? prepared.polymarket.maxBuyPrice;
    const reason = `fresh depth VWAP kalshi=${kalshiVwap.toFixed(4)} polymarket=${polymarketVwap.toFixed(4)}`;
    if (kalshiVwap < polymarketVwap - 1e-9) {
      return { firstVenue: "kalshi", firstVenueReason: reason, firstVenueVwap: kalshiVwap };
    }
    if (polymarketVwap < kalshiVwap - 1e-9) {
      return { firstVenue: "polymarket", firstVenueReason: reason, firstVenueVwap: polymarketVwap };
    }
    if (kalshiWorstAsk < polymarketWorstAsk - 1e-9) {
      return { firstVenue: "kalshi", firstVenueReason: `${reason}; tie broken by worst ask`, firstVenueVwap: kalshiVwap };
    }
    if (polymarketWorstAsk < kalshiWorstAsk - 1e-9) {
      return { firstVenue: "polymarket", firstVenueReason: `${reason}; tie broken by worst ask`, firstVenueVwap: polymarketVwap };
    }
    return {
      firstVenue: "polymarket",
      firstVenueReason: `${reason}; exact tie broken toward Polymarket to reduce CLOB stale-quote exposure`,
      firstVenueVwap: polymarketVwap,
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
    const submittedAt = this.now();
    const timeoutMs = Math.max(1, this.config.liveOrderTimeoutMs);
    const abortController = new AbortController();
    const submittedContext: LiveOrderContext = { ...context, requestedAt: submittedAt, signal: abortController.signal };
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<VenueOrderResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
        const timedOut = failedVenueResult(
          client.venue,
          context.clientOrderId,
          new Error(`order response timeout after ${timeoutMs}ms`),
          submittedAt,
        );
        resolve({
          ...timedOut,
          status: "unknown",
          metadata: {
            ...(timedOut.metadata ?? {}),
            orderResponseTimeoutMs: timeoutMs,
            pendingReconciliation: true,
          },
        });
      }, timeoutMs);
    });
    const order = client.placeOrder(leg, submittedContext)
      .catch((error) => failedVenueResult(client.venue, context.clientOrderId, error, submittedAt));
    let result = await Promise.race([order, timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (isTimeoutOrUnknownResult(result) && client.recoverTimedOutOrder) {
      try {
        const recovered = await client.recoverTimedOutOrder(leg, { ...submittedContext, signal: undefined }, result);
        if (recovered) result = recovered;
      } catch (error) {
        result = {
          ...result,
          metadata: {
            ...(result.metadata ?? {}),
            timeoutRecoveryError: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
    return result;
  }

  private async preflightVenueOrders(
    orders: Array<{ client: VenueOrderClient; leg: ArbLeg; context: LiveOrderContext }>,
  ): Promise<string | null> {
    const results = await Promise.all(orders.map(async (order) => {
      try {
        const reason = await order.client.preflightOrder?.(order.leg, order.context);
        return reason ? `${venueLabel(order.client.venue)} live preflight failed: ${reason}` : null;
      } catch (error) {
        return `${venueLabel(order.client.venue)} live preflight failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }));
    return results.find((reason): reason is string => reason != null) ?? null;
  }

  private async confirmationPreflight(candidate: ArbCandidate): Promise<ExecutionResult | null> {
    if (!this.config.liveUserStreamsEnabled) return null;
    let reason = this.confirmationMonitor
      ? await this.confirmationMonitor.preflight(candidate, this.now())
      : "live user stream confirmation is enabled but not configured";
    if (!reason) return null;
    if (this.config.liveHotPathEnabled && isUserStreamPreflightReason(reason)) {
      return skipped(`live hot-path user stream preflight skipped: ${reason}`);
    }
    if (isUserStreamPreflightReason(reason)) {
      const graceMs = Math.max(0, this.config.liveUserStreamPretradeGraceMs);
      if (graceMs > 0 && this.confirmationMonitor) {
        await waitMs(graceMs);
        reason = await this.confirmationMonitor.preflight(candidate, this.now());
        if (!reason) return null;
      }
      if (isUserStreamPreflightReason(reason)) {
        return skipped(`live user stream preflight skipped: ${reason}`);
      }
    }
    return failed(`live preflight blocked before order submission: ${reason}`);
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
        timeoutMs: this.confirmationTimeoutMs(result),
      });
      return [result.venue, this.confirmationRecord(confirmation)] as const;
    }));
    return Object.fromEntries(entries);
  }

  private confirmationTimeoutMs(result: VenueOrderResult): number {
    const base = Math.max(1, this.config.liveUserStreamConfirmTimeoutMs);
    if (isTimeoutOrUnknownResult(result)) return base + Math.max(0, this.config.liveFinalRecoveryTimeoutMs);
    return base;
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

  private applyVenueConfirmations(
    kalshi: VenueOrderResult,
    polymarket: VenueOrderResult,
    confirmations: VenueConfirmations | null,
  ): { kalshi: VenueOrderResult; polymarket: VenueOrderResult } {
    return {
      kalshi: this.applyVenueConfirmation(kalshi, confirmations?.kalshi),
      polymarket: this.applyVenueConfirmation(polymarket, confirmations?.polymarket),
    };
  }

  private applyVenueConfirmation(result: VenueOrderResult, confirmation: Record<string, unknown> | null | undefined): VenueOrderResult {
    if (!confirmation || confirmation.status !== "confirmed") return result;
    const fillCount = typeof confirmation.fillCount === "number" ? confirmation.fillCount : result.fillCount;
    if (fillCount == null || fillCount <= 0) return result;
    const receivedAtMs = typeof confirmation.receivedAtMs === "number" && Number.isFinite(confirmation.receivedAtMs)
      ? confirmation.receivedAtMs
      : null;
    return {
      ...result,
      clientOrderId: typeof confirmation.clientOrderId === "string" && confirmation.clientOrderId
        ? confirmation.clientOrderId
        : result.clientOrderId,
      orderId: typeof confirmation.venueOrderId === "string" && confirmation.venueOrderId
        ? confirmation.venueOrderId
        : result.orderId,
      status: "filled",
      fillCount,
      fillPrice: typeof confirmation.fillPrice === "number" ? confirmation.fillPrice : result.fillPrice,
      fee: typeof confirmation.fee === "number" ? confirmation.fee : result.fee ?? null,
      exchangeTimestampMs: typeof confirmation.exchangeTimestampMs === "number" ? confirmation.exchangeTimestampMs : result.exchangeTimestampMs ?? null,
      respondedAt: receivedAtMs == null ? result.respondedAt : new Date(receivedAtMs).toISOString(),
      error: null,
      metadata: {
        ...(result.metadata ?? {}),
        resolvedFromPrivateStreamConfirmation: true,
        privateStreamEventType: confirmation.eventType ?? null,
      },
    };
  }

  private attachRestMetadata(
    confirmations: VenueConfirmations,
    kalshi: VenueOrderResult,
    polymarket: VenueOrderResult,
  ): VenueConfirmations {
    const attach = (record: Record<string, unknown> | null | undefined, result: VenueOrderResult): Record<string, unknown> | null => {
      if (!result.metadata) return record ?? null;
      return { ...(record ?? {}), ...result.metadata };
    };
    return {
      ...confirmations,
      kalshi: attach(confirmations.kalshi, kalshi),
      polymarket: attach(confirmations.polymarket, polymarket),
    };
  }

  private hasRecoveryEvidence(result: VenueOrderResult, confirmation: Record<string, unknown> | null | undefined): boolean {
    const metadata = result.metadata ?? {};
    return Boolean(
      metadata.pendingReconciliation
      || metadata.resolvedFromPrivateStreamConfirmation
      || metadata.timeoutRecoveryError
      || metadata.orderResponseTimeoutMs
      || metadata.kalshiFinalFillSource
      || metadata.polymarketFinalFillSource
      || metadata.cancelStatus
      || metadata.canceledOpenRemainder
      || confirmation?.status === "timeout"
      || confirmation?.status === "mismatch"
      || confirmation?.status === "failed"
      || result.status === "unknown"
      || result.status === "canceled"
      || result.status === "cancelled"
      || result.error?.toLowerCase().includes("timeout") === true,
    );
  }

  private recoveryEvidenceFor(kalshi: VenueOrderResult, polymarket: VenueOrderResult, venueConfirmations: VenueConfirmations): Record<string, unknown> {
    return {
      kalshi: {
        status: kalshi.status,
        fillCount: kalshi.fillCount ?? null,
        fillPrice: kalshi.fillPrice ?? null,
        error: kalshi.error ?? null,
        orderId: kalshi.orderId ?? null,
        metadata: kalshi.metadata ?? null,
        confirmation: venueConfirmations.kalshi ?? null,
      },
      polymarket: {
        status: polymarket.status,
        fillCount: polymarket.fillCount ?? null,
        fillPrice: polymarket.fillPrice ?? null,
        error: polymarket.error ?? null,
        orderId: polymarket.orderId ?? null,
        metadata: polymarket.metadata ?? null,
        confirmation: venueConfirmations.polymarket ?? null,
      },
    };
  }

  private recoveryStatusForResult(
    liveLockReason: string | null,
    exactPairFilled: boolean,
    hasAnyFill: boolean,
    recoveryEvidencePresent: boolean,
  ): LiveRecoveryStatus {
    if (liveLockReason) return "operator_required";
    if (!this.config.liveAutoResolveVerifiedIncidents) return recoveryEvidencePresent ? "finalizing" : "none";
    if (exactPairFilled && recoveryEvidencePresent) return "auto_resolved_paired_fill";
    if (!hasAnyFill && recoveryEvidencePresent) return "auto_resolved_no_exposure";
    return recoveryEvidencePresent ? "finalizing" : "none";
  }

  private autoResolution(
    recoveryStatus: LiveRecoveryStatus,
    executionGroupId: string,
    evidence: Record<string, unknown> | null,
  ): { resolvedAt: string | null; reason: string | null; resolution: ReconciliationResolution | null } {
    if (recoveryStatus !== "auto_resolved_no_exposure") {
      return { resolvedAt: null, reason: null, resolution: null };
    }
    const resolvedAt = new Date(this.now()).toISOString();
    return {
      resolvedAt,
      reason: "auto recovery: verified both venues have zero fill and no open exposure",
      resolution: {
        resolvedBy: "worker",
        resolutionType: "auto_no_exposure",
        executionGroupId,
        evidence,
        notes: "Verified-only recovery resolved a no-exposure live attempt without a persistent lock.",
      },
    };
  }

  private async resultFromVenueOrders(
    executionGroupId: string,
    kalshi: VenueOrderResult,
    polymarket: VenueOrderResult,
    metadata: ExecutionMetadata = {},
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
    const hasAnyFill = kalshiHasFill || polymarketHasFill;
    const unexpectedFillCount = (kalshiHasFill && !kalshiFilled) || (polymarketHasFill && !polymarketFilled);
    const fillCountMismatch = kalshiHasFill && polymarketHasFill && Math.abs(kalshiFillCount - polymarketFillCount) > 0.000001;
    const partialFill = kalshiFilled !== polymarketFilled || unexpectedFillCount || fillCountMismatch;
    const realizedGuaranteedProfit = kalshi.fillPrice != null && polymarket.fillPrice != null
      ? roundPrice(1 - (kalshi.fillPrice + polymarket.fillPrice + this.realizedFeePerSpread(kalshi, polymarket)))
      : null;
    const exactPairFilled = kalshiFilled && polymarketFilled && !partialFill;
    const riskHedgeWithinLossCap = Boolean(metadata.riskHedge)
      && realizedGuaranteedProfit != null
      && realizedGuaranteedProfit + 1e-9 >= -Math.max(0, this.config.liveHedgeMaxLossDollars);
    const completedRiskHedgeBelowThreshold = exactPairFilled
      && Boolean(metadata.riskHedge)
      && riskHedgeWithinLossCap
      && realizedGuaranteedProfit != null
      && realizedGuaranteedProfit + 1e-9 < this.config.minProfitDollars;
    const realizedEdgeUnsafe = kalshiHasFill && polymarketHasFill && realizedGuaranteedProfit == null;
    const fallbackVenueConfirmations: VenueConfirmations = {
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
    };
    const venueConfirmations = this.attachRestMetadata(metadata.venueConfirmations ?? fallbackVenueConfirmations, kalshi, polymarket);
    const initialLiveLockReason = this.confirmationLockReason(metadata.venueConfirmations)
      ?? this.liveLockReason(partialFill, realizedGuaranteedProfit, kalshi, polymarket, Boolean(metadata.riskHedge), metadata.hedgeFailureReason);
    const riskQuarantine = await this.riskQuarantineDecision(initialLiveLockReason, kalshi, polymarket, metadata.venueConfirmations);
    const liveLockReason = riskQuarantine ? null : initialLiveLockReason;
    const recoveryEvidencePresent = this.hasRecoveryEvidence(kalshi, venueConfirmations.kalshi)
      || this.hasRecoveryEvidence(polymarket, venueConfirmations.polymarket)
      || metadata.recoveryStatus === "pretrade_retry";
    const recoveryStatus = metadata.recoveryStatus
      ?? (riskQuarantine ? "risk_quarantined" : this.recoveryStatusForResult(liveLockReason, exactPairFilled, hasAnyFill, recoveryEvidencePresent));
    const recoveryEvidence = metadata.recoveryEvidence
      ?? (recoveryEvidencePresent ? this.recoveryEvidenceFor(kalshi, polymarket, venueConfirmations) : null);
    const finalizationMs = metadata.finalizationMs ?? metadata.executionTimings?.totalMs ?? null;
    const autoResolution = this.autoResolution(recoveryStatus, executionGroupId, recoveryEvidence);
    if (liveLockReason) this.partialFillLocked = true;
    const venueFailureReason = [kalshi, polymarket]
      .filter((result) => result.error || (result.fillCount ?? 0) < this.config.liveOrderSize)
      .map((result) => `${result.venue}: ${result.error ?? result.status}`)
      .join("; ") || null;
    const hedgeFailureReason = completedRiskHedgeBelowThreshold
      ? `risk hedge completed below normal profit threshold: realized edge ${realizedGuaranteedProfit?.toFixed(4)} below threshold ${this.config.minProfitDollars.toFixed(4)}`
      : null;
    const failureReason = riskQuarantine
      ? `risk quarantined: ${riskQuarantine.reason}`
      : liveLockReason ?? hedgeFailureReason ?? venueFailureReason;
    const action: ExecutionResult["action"] = exactPairFilled && !realizedEdgeUnsafe && !completedRiskHedgeBelowThreshold && !liveLockReason
      ? "filled"
      : "failed";
    this.lastAttempt = {
      executionGroupId,
      action,
      partialFill,
      failureReason,
      liveLockReason,
      kalshiStatus: kalshi.status,
      polymarketStatus: polymarket.status,
      recoveryStatus,
      recoveryAttempts: metadata.recoveryAttempts ?? 0,
      finalizationMs,
      riskQuarantinedAt: riskQuarantine?.quarantinedAt ?? null,
      riskQuarantineExposureDollars: riskQuarantine?.exposureDollars ?? null,
      completedAt: this.now(),
    };
    const result: ExecutionResult = {
      action,
      failureReason,
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
      venueConfirmations,
      executionStrategy: metadata.executionStrategy ?? null,
      riskHedge: Boolean(metadata.riskHedge),
      realizedGuaranteedProfit,
      hedgeCapPrice: metadata.hedgeCapPrice ?? null,
      recoveryStatus,
      recoveryAttempts: metadata.recoveryAttempts ?? 0,
      recoveryEvidence,
      finalizationMs,
      riskQuarantinedAt: metadata.riskQuarantinedAt ?? riskQuarantine?.quarantinedAt ?? null,
      riskQuarantineReason: metadata.riskQuarantineReason ?? riskQuarantine?.reason ?? null,
      riskQuarantineExposureDollars: metadata.riskQuarantineExposureDollars ?? riskQuarantine?.exposureDollars ?? null,
      riskQuarantineEvidence: metadata.riskQuarantineEvidence ?? riskQuarantine?.evidence ?? null,
      reconciliationResolvedAt: metadata.reconciliationResolvedAt ?? autoResolution.resolvedAt,
      reconciliationResolutionReason: metadata.reconciliationResolutionReason ?? autoResolution.reason,
      reconciliationResolution: metadata.reconciliationResolution ?? autoResolution.resolution,
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
          executionStrategy: metadata.executionStrategy ?? null,
          riskHedge: Boolean(metadata.riskHedge),
          hedgeCapPrice: metadata.hedgeCapPrice ?? null,
          recoveryStatus,
          recoveryAttempts: metadata.recoveryAttempts ?? 0,
          recoveryEvidence,
          finalizationMs,
          quoteSnapshot: metadata.quoteSnapshot ?? null,
          executionTimings: metadata.executionTimings ?? null,
          kalshiRestMetadata: kalshi.metadata ?? null,
          polymarketRestMetadata: polymarket.metadata ?? null,
        },
      });
    }
    return result;
  }

  private async riskQuarantineDecision(
    lockReason: string | null,
    kalshi: VenueOrderResult,
    polymarket: VenueOrderResult,
    venueConfirmations: VenueConfirmations | null | undefined,
  ): Promise<RiskQuarantineDecision | null> {
    if (!lockReason || this.config.livePartialFillLockMode !== "quarantine") return null;
    if (!this.isRiskQuarantinableLock(lockReason)) return null;

    const openRisk = this.unverifiedOpenOrderRisk(kalshi) ?? this.unverifiedOpenOrderRisk(polymarket);
    if (openRisk) return null;

    const exposureDollars = this.unresolvedExposureDollars(kalshi, polymarket);
    if (exposureDollars == null) return null;

    const existingExposure = await this.quarantineExposureReader?.unresolvedRiskQuarantineExposureDollars().catch(() => Number.POSITIVE_INFINITY) ?? 0;
    const totalExposure = existingExposure + exposureDollars;
    if (totalExposure > this.config.liveMaxUnresolvedExposureDollars + 1e-9) return null;

    return {
      quarantinedAt: new Date(this.now()).toISOString(),
      reason: `${lockReason}; unresolved exposure ${exposureDollars.toFixed(2)} within cap ${this.config.liveMaxUnresolvedExposureDollars.toFixed(2)}`,
      exposureDollars,
      evidence: {
        originalLockReason: lockReason,
        existingQuarantinedExposureDollars: roundPrice(existingExposure),
        totalQuarantinedExposureDollars: roundPrice(totalExposure),
        maxUnresolvedExposureDollars: this.config.liveMaxUnresolvedExposureDollars,
        kalshi: this.riskQuarantineVenueEvidence(kalshi, venueConfirmations?.kalshi),
        polymarket: this.riskQuarantineVenueEvidence(polymarket, venueConfirmations?.polymarket),
      },
    };
  }

  private isRiskQuarantinableLock(reason: string): boolean {
    const normalized = reason.toLowerCase();
    return normalized.includes("private stream confirmation")
      || normalized.includes("fill mismatch")
      || normalized.includes("unexpected fill count")
      || normalized.includes("timeout/unknown");
  }

  private unresolvedExposureDollars(kalshi: VenueOrderResult, polymarket: VenueOrderResult): number | null {
    const kalshiCount = kalshi.fillCount ?? 0;
    const polymarketCount = polymarket.fillCount ?? 0;
    if (kalshiCount < 0 || polymarketCount < 0) return null;
    if (Math.abs(kalshiCount - polymarketCount) <= 0.000001) return 0;
    if (kalshiCount > polymarketCount) {
      if (kalshi.fillPrice == null) return null;
      return roundPrice((kalshiCount - polymarketCount) * kalshi.fillPrice);
    }
    if (polymarket.fillPrice == null) return null;
    return roundPrice((polymarketCount - kalshiCount) * polymarket.fillPrice);
  }

  private unverifiedOpenOrderRisk(result: VenueOrderResult): string | null {
    const status = result.status.toLowerCase();
    if (["live", "open", "resting", "delayed"].includes(status)) return `${result.venue} order may still be open (${result.status})`;
    const metadata = result.metadata ?? {};
    const cancelStatus = String(metadata.kalshiCancelStatus ?? metadata.polymarketCancelStatus ?? "");
    const openOrderCount = Number(metadata.polymarketOpenOrderCount ?? 0);
    const openOrdersError = metadata.polymarketOpenOrdersError;
    const finalFetchError = metadata.kalshiFinalFetchError ?? metadata.polymarketFinalFetchError;
    const timeoutRecoveryStatus = String(metadata.kalshiTimeoutRecoveryStatus ?? "");
    const verifiedNoKalshiOrder = result.venue === "kalshi"
      && result.status === "unknown"
      && (result.fillCount ?? 0) === 0
      && timeoutRecoveryStatus === "not_found";
    if (verifiedNoKalshiOrder) return null;
    if (openOrderCount > 0) return `${result.venue} has ${openOrderCount} open order(s)`;
    if (typeof openOrdersError === "string" && openOrdersError) return `${result.venue} open-order query failed: ${openOrdersError}`;
    if (typeof finalFetchError === "string" && finalFetchError && result.status === "unknown") return `${result.venue} final order query failed: ${finalFetchError}`;
    if (["cancel_failed", "cancel_unavailable", "skipped_no_order_id"].includes(cancelStatus) && result.status === "unknown") {
      return `${result.venue} cancel state is unverified (${cancelStatus})`;
    }
    if (result.status === "unknown" && (result.fillCount ?? 0) <= 0) return `${result.venue} exposure is unknown`;
    return null;
  }

  private riskQuarantineVenueEvidence(result: VenueOrderResult, confirmation: Record<string, unknown> | null | undefined): Record<string, unknown> {
    return {
      status: result.status,
      orderId: result.orderId,
      clientOrderId: result.clientOrderId,
      fillCount: result.fillCount ?? null,
      fillPrice: result.fillPrice ?? null,
      error: result.error,
      metadata: result.metadata ?? null,
      confirmation: confirmation ?? null,
    };
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

  private executionTimings(
    startedAt: number,
    kalshi: VenueOrderResult | null,
    polymarket: VenueOrderResult | null,
    metadata: {
      preflightStartedAt?: number;
      preflightCompletedAt?: number;
      postFillHedgeDecisionMs?: number | null;
      firstVenue?: Venue | null;
      firstVenueReason?: string | null;
      firstVenueVwap?: number | null;
      hotGateStartedAt?: number;
      hotGateCompletedAt?: number;
    } = {},
  ): ExecutionTimings {
    const timing = (result: VenueOrderResult | null): number | null => {
      if (!result) return null;
      const requestedAt = Date.parse(result.requestedAt);
      const respondedAt = Date.parse(result.respondedAt);
      if (!Number.isFinite(requestedAt) || !Number.isFinite(respondedAt)) return null;
      return Math.max(0, respondedAt - requestedAt);
    };
    const requested = (result: VenueOrderResult | null): number | null => {
      if (!result) return null;
      const parsed = Date.parse(result.requestedAt);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const kalshiRequestedAt = requested(kalshi);
    const polymarketRequestedAt = requested(polymarket);
    const firstRequestedAt = [kalshiRequestedAt, polymarketRequestedAt]
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b)[0] ?? null;
    const completedAt = [kalshi, polymarket]
      .map((result) => result == null ? null : Date.parse(result.respondedAt))
      .filter((value): value is number => value != null && Number.isFinite(value))
      .sort((a, b) => b - a)[0] ?? this.now();
    const preflightMs = metadata.preflightStartedAt != null && metadata.preflightCompletedAt != null
      ? Math.max(0, metadata.preflightCompletedAt - metadata.preflightStartedAt)
      : null;
    const hotGateMs = metadata.hotGateStartedAt != null && metadata.hotGateCompletedAt != null
      ? Math.max(0, metadata.hotGateCompletedAt - metadata.hotGateStartedAt)
      : null;
    const venueSubmitSkewMs = kalshiRequestedAt != null && polymarketRequestedAt != null
      ? Math.abs(kalshiRequestedAt - polymarketRequestedAt)
      : null;
    const kalshiOrderRttMs = timing(kalshi);
    const polymarketOrderRttMs = timing(polymarket);
    return {
      candidateToSubmitMs: Math.max(0, (firstRequestedAt ?? startedAt) - startedAt),
      hotGateMs,
      polymarketSignMs: polymarket?.signMs ?? null,
      preflightMs,
      kalshiRttMs: kalshiOrderRttMs,
      polymarketRttMs: polymarketOrderRttMs,
      kalshiOrderRttMs,
      postFillHedgeDecisionMs: metadata.postFillHedgeDecisionMs ?? null,
      polymarketOrderRttMs,
      venueSubmitSkewMs,
      totalMs: Number.isFinite(completedAt) ? Math.max(0, completedAt - startedAt) : null,
      firstVenue: metadata.firstVenue ?? null,
      firstVenueReason: metadata.firstVenueReason ?? null,
      firstVenueVwap: metadata.firstVenueVwap ?? null,
    };
  }

  private liveLockReason(
    partialFill: boolean,
    realizedGuaranteedProfit: number | null,
    kalshi: VenueOrderResult,
    polymarket: VenueOrderResult,
    riskHedge: boolean,
    hedgeFailureReason: string | null | undefined = null,
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
    if (partialFill && riskHedge && hedgeFailureReason) {
      return `live safety lock engaged: ${hedgeFailureReason}`;
    }
    if (partialFill) {
      return `live safety lock engaged: venue fill mismatch kalshi=${kalshiFillCount} polymarket=${polymarketFillCount}`;
    }
    if (realizedGuaranteedProfit == null) {
      return "live safety lock engaged: filled order missing realized fill prices";
    }
    if (riskHedge && realizedGuaranteedProfit + 1e-9 < -Math.max(0, this.config.liveHedgeMaxLossDollars)) {
      return `live safety lock engaged: risk hedge realized edge ${realizedGuaranteedProfit.toFixed(4)} below loss cap ${(-Math.max(0, this.config.liveHedgeMaxLossDollars)).toFixed(4)}`;
    }
    if (riskHedge) return null;
    return null;
  }
}
