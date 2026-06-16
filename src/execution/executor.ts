import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import type { LiveExecutionLockWriter } from "../db/live-execution-locks";
import type { VenueOrderEventReader, VenueOrderEventWriter } from "../db/venue-order-events";
import { protectedCandidateBlockReason } from "../scanner/safety";
import type { ArbCandidate, ArbLeg, BinaryContract, DashboardSignal, ExecutionResult, ExecutionStrategy, ExecutionTimings, FillQualitySnapshot, LeadLagSnapshot, LiveExecutionLastAttempt, LiveExecutionReadiness, LiveOrderPlacementMode, LiveRecoveryStatus, LiveRiskState, QuoteSnapshot, ReconciliationResolution, Venue, VenueConfirmations, VenueExecutionReadiness } from "../types";
import {
  failedVenueResult,
  generatedClientOrderId,
  createKalshiOrderClient,
  PolymarketOrderClient,
  type LiveOrderContext,
  type VenueOrderClient,
  type VenueOrderResult,
  type VenueUnwindOutcome,
} from "./live-clients";
import { economicFillPriceForLeg } from "./economic-prices";
import type { LiveExecutionQualityOptions } from "./execution-quality";
import { fillQualityBlockReason, scoreFillQuality } from "./fill-quality";
import { evaluateLiveQuoteQuality, captureShadowLadder, CUSHIONED_EDGE_REASON_PREFIX } from "./quote-quality";
import { leadLagBlockReason, scoreLeadLag, type LeadLagHistory } from "../signals/lead-lag";
import { buildUserStreamReadiness, defaultReconciliationReadiness, type VenueConfirmationMonitor, type VenueConfirmationResult } from "./venue-confirmations";

export interface ArbExecutor {
  execute(candidate: ArbCandidate): Promise<ExecutionResult>;
}

function legForVenue(candidate: ArbCandidate, venue: "kalshi" | "polymarket"): ArbLeg | null {
  if (candidate.lower.venue === venue) return candidate.lower;
  if (candidate.higher.venue === venue) return candidate.higher;
  return null;
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

// A venue result that DEFINITIVELY did not fill: zero fill count and a terminal rejection/no-order status.
// Keyed on status (not error text), because a stream-confirmation-timeout reason can bleed into the result
// error even when the REST response was a clean rejection. "unknown" (an ambiguous order timeout, where the
// order could still have been placed/filled) is deliberately excluded so it stays locked for reconciliation.
function isDefinitiveNoFill(result: VenueOrderResult): boolean {
  if ((result.fillCount ?? 0) > 0) return false;
  const status = String(result.status ?? "").toLowerCase();
  return ["failed", "rejected", "canceled", "cancelled", "unfilled", "not_submitted", "skipped"].includes(status);
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

export interface LiveExecutionBookReader {
  snapshot(): { kalshi: BinaryContract[]; polymarket: BinaryContract[] };
  leadLagHistoryForQuoteSnapshot?(snapshot: QuoteSnapshot, nowMs: number, lookbackMs: number): LeadLagHistory;
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

// prepareExecution returns this on a reject instead of a bare string, so the below-threshold-edge skip
// can carry the (optional) shadow-ladder snapshot for persistence (T2.4). rejectedSnapshot is null
// unless LIVE_SHADOW_LADDER_CAPTURE_ENABLED captured one — keeping the default path byte-identical.
interface PrepareSkip {
  skipReason: string;
  rejectedSnapshot: QuoteSnapshot | null;
}

function isPrepareSkip(prepared: PreparedExecution | PrepareSkip): prepared is PrepareSkip {
  return "skipReason" in prepared;
}

interface PreparedHedge {
  leg: ArbLeg;
  maxBuyPrice: number;
  requiredCollateral: number;
  hedgeCapPrice: number;
  hedgeShares: number;
  quoteSnapshot: QuoteSnapshot;
}

interface PolymarketHedgeTriggerEvidence {
  result: VenueOrderResult;
  restResult: VenueOrderResult;
  confirmation: Record<string, unknown> | null;
  source: "rest_response" | "private_stream";
  receivedAtMs: number;
  fillCount: number;
  isExact: boolean;
}

interface VenueExecutionPlan {
  venue: Venue;
  client: VenueOrderClient;
  prepared: PreparedLeg;
  context: LiveOrderContext;
  clientOrderId: string;
}

interface SynchronizedVenueOrderResults {
  kalshi: VenueOrderResult;
  polymarket: VenueOrderResult;
  dispatchAtMs: number;
  settledAtMs: number;
  dispatchCallSkewMs: number;
}

interface ExecutionMetadata {
  quoteSnapshot?: QuoteSnapshot | null;
  leadLagSnapshot?: LeadLagSnapshot | null;
  fillQualitySnapshot?: FillQualitySnapshot | null;
  expectedExecutableEdge?: number | null;
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
  // C1: legs for the bounded auto-unwind backstop. Present only on paths that can produce a one-sided
  // fill; absent elsewhere. The unwind is additionally gated by liveAutoUnwindEnabled (default off).
  unwindLegs?: { kalshi: ArbLeg; polymarket: ArbLeg } | null;
}

export interface RiskQuarantineExposureReader {
  unresolvedRiskQuarantineExposureDollars(): Promise<number>;
  liveRiskQuarantineStatus?(): Promise<{ total: number; count: number }>;
  liveExactExposureBlockReason?(now: number): Promise<string | null>;
  liveExecutionQualityStatus?(now: number, options: LiveExecutionQualityOptions): Promise<LiveExecutionReadiness["executionQuality"]>;
  listLiveExecutionQualitySignals?(now: number, lookbackMs: number, limit?: number): Promise<DashboardSignal[]>;
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

export class LiveExecutor implements ArbExecutor {
  private partialFillLocked = false;
  private lastAttempt: LiveExecutionLastAttempt | null = null;

  constructor(
    private readonly config: AppConfig = loadConfig(),
    private readonly books?: LiveExecutionBookReader,
    private readonly kalshiClient: VenueOrderClient = createKalshiOrderClient(config),
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
    const qualityOptions = this.executionQualityOptions();
    const defaultExecutionQuality: LiveExecutionReadiness["executionQuality"] = {
      enabled: qualityOptions.enabled,
      ok: true,
      reason: null,
      sampleCount: 0,
      lookbackMs: qualityOptions.lookbackMs,
      sampleLimit: qualityOptions.sampleLimit,
      minSamples: qualityOptions.minSamples,
      minExactFillRate: qualityOptions.minExactFillRate,
      exactPairFillRate: null,
      polymarketTimeoutRate: null,
      mismatchRate: null,
      avgPolymarketRttMs: null,
      avgMismatchCostDollars: null,
      estimatedExecutableEdge: null,
    };
    const [kalshi, polymarket, activeLock, quarantineStatus, exactExposureReason, executionQuality] = await Promise.all([
      this.kalshiClient.readiness(now),
      this.polymarketClient.readiness(now),
      this.liveLocks?.getActiveLock() ?? Promise.resolve(null),
      this.quarantineExposureReader?.liveRiskQuarantineStatus?.()
        ?? this.quarantineExposureReader?.unresolvedRiskQuarantineExposureDollars().then((total) => ({ total, count: total > 0 ? 1 : 0 }))
        ?? Promise.resolve(null),
      this.config.liveExactExposureRequired
        ? this.quarantineExposureReader?.liveExactExposureBlockReason?.(now) ?? Promise.resolve(null)
        : Promise.resolve(null),
      this.quarantineExposureReader?.liveExecutionQualityStatus?.(now, qualityOptions) ?? Promise.resolve(defaultExecutionQuality),
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
    const effectiveActiveLock = this.config.liveAutoHardlocksEnabled ? activeLock : null;
    const effectivePartialFillLocked = this.config.liveAutoHardlocksEnabled ? this.partialFillLocked : false;
    const riskState = this.liveRiskState(
      effectiveActiveLock?.reason ?? null,
      reconciliation,
      userStreams.reason,
      effectivePartialFillLocked,
      exactExposureReason,
      executionQuality?.reason ?? null,
    );
    return {
      mode: "live",
      liveTrading: true,
      protectedOnly: true,
      orderSize: this.config.liveOrderSize,
      orderType: this.config.polymarketOrderType,
      takerPriceCushionCents: this.config.liveTakerPriceCushionCents,
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
      polymarketFirstMinFillShares: this.config.livePolymarketFirstMinFillShares,
      polymarketFirstMaxFillShares: this.config.livePolymarketFirstMaxFillShares,
      kalshiHedgeTimeInForce: this.config.liveKalshiHedgeTimeInForce,
      kalshiPrearmEnabled: this.config.liveKalshiPrearmEnabled,
      kalshiPrearmMaxAgeMs: this.config.liveKalshiPrearmMaxAgeMs,
      kalshiPrearmPricePolicy: this.config.liveKalshiPrearmPricePolicy,
      partialFillLockMode: this.config.livePartialFillLockMode,
      autoHardlocksEnabled: this.config.liveAutoHardlocksEnabled,
      maxUnresolvedExposureDollars: this.config.liveMaxUnresolvedExposureDollars,
      exactExposureRequired: this.config.liveExactExposureRequired,
      executionQualityGateEnabled: this.config.liveExecutionQualityGateEnabled,
      executionQuality,
      orderTimeoutMs: this.config.liveOrderTimeoutMs,
      kalshiOrderGroupEnabled: this.config.liveKalshiOrderGroupEnabled && Boolean(this.config.liveKalshiOrderGroupId),
      userStreams,
      reconciliation,
      riskState: riskState.state,
      riskStateReason: riskState.reason,
      partialFillLocked: effectivePartialFillLocked,
      circuitBreakerLocked: Boolean(effectiveActiveLock),
      circuitBreakerReason: effectiveActiveLock?.reason ?? null,
      circuitBreaker: effectiveActiveLock ?? null,
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
    const activeLock = this.config.liveAutoHardlocksEnabled ? await this.liveLocks?.getActiveLock() : null;
    if (activeLock) return failed(`live circuit breaker locked: ${activeLock.reason}`);
    if (this.config.liveAutoHardlocksEnabled && this.partialFillLocked) {
      return liveLocked("live execution locked after unsafe fill; manual operator review required before trading resumes");
    }
    const monitorFailure = await this.confirmationPreflight(candidate);
    if (monitorFailure) return monitorFailure;
    const kalshiLeg = legForVenue(candidate, "kalshi");
    const polymarketLeg = legForVenue(candidate, "polymarket");
    if (!kalshiLeg || !polymarketLeg) return this.failed("candidate must contain one Kalshi leg and one Polymarket leg");

    // The extra first-leg cross offset (P1-5) applies only when Polymarket is the leading/cancelable
    // leg (polymarket_first_exact). Default 0 = no change. The cushioned-edge gate still binds.
    const polymarketFirstCrossCents = this.config.liveOrderPlacementMode === "polymarket_first_exact"
      ? this.config.livePolymarketFirstCrossCents
      : 0;
    const preparedOrSkip = this.prepareExecution(candidate, kalshiLeg, polymarketLeg, polymarketFirstCrossCents);
    if (isPrepareSkip(preparedOrSkip)) {
      return preparedOrSkip.rejectedSnapshot
        ? this.skippedWithShadowLadder(preparedOrSkip.skipReason, preparedOrSkip.rejectedSnapshot)
        : skipped(preparedOrSkip.skipReason);
    }
    let prepared: PreparedExecution = preparedOrSkip;

    const executionGroupId = randomUUID();
    const kalshiClientOrderId = generatedClientOrderId("kalshi");
    const polymarketClientOrderId = generatedClientOrderId("polymarket");
    const placementMode = this.config.liveOrderPlacementMode === "polymarket_first_exact"
      || this.config.liveOrderPlacementMode === "kalshi_first_exact"
      || this.config.liveOrderPlacementMode === "parallel_market"
      || this.config.liveOrderPlacementMode === "parallel_quick"
      ? this.config.liveOrderPlacementMode
      : this.config.liveParallelExecutionEnabled ? this.config.liveOrderPlacementMode : "parallel_fok";
    if (
      placementMode === "parallel_quick"
      && this.config.kalshiHedgeOrderMode !== "ui_quick_order"
      && this.config.kalshiHedgeOrderMode !== "fix_ioc"
      && this.config.kalshiHedgeOrderMode !== "public_v2"
    ) {
      return skipped("parallel_quick requires KALSHI_HEDGE_ORDER_MODE=ui_quick_order, fix_ioc, or public_v2");
    }
    if (
      placementMode === "parallel_quick"
      && this.config.kalshiHedgeOrderMode === "ui_quick_order"
      && !this.config.kalshiUiQuickOrderCapValidated
    ) {
      return skipped("parallel_quick requires KALSHI_UI_QUICK_ORDER_CAP_VALIDATED=true");
    }
    const limitRestMs = placementMode === "parallel_limit_rest" ? Math.max(0, this.config.liveAggressiveLimitRestMs) : undefined;
    let kalshiContext: LiveOrderContext = {
      executionGroupId,
      clientOrderId: kalshiClientOrderId,
      size: this.config.liveOrderSize,
      maxBuyPrice: prepared.kalshi.maxBuyPrice,
      requiredCollateral: this.kalshiPreflightCollateral(prepared, placementMode),
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
    let leadLagSnapshot = this.leadLagSnapshot(candidate, prepared.quoteSnapshot);
    const initialLeadLagBlock = leadLagBlockReason(leadLagSnapshot);
    if (initialLeadLagBlock) {
      const blockedAt = this.now();
      return this.skippedWithQuoteQuality(
        initialLeadLagBlock,
        prepared.quoteSnapshot,
        this.executionTimings(executeStartedAt, null, null, { preflightStartedAt: blockedAt, preflightCompletedAt: blockedAt, hotGateStartedAt, hotGateCompletedAt: blockedAt }),
        null,
      );
    }
    let fillQualitySnapshot = await this.fillQualitySnapshot(candidate, prepared.quoteSnapshot, placementMode);
    const initialFillQualityBlock = fillQualityBlockReason(fillQualitySnapshot);
    if (initialFillQualityBlock) {
      const blockedAt = this.now();
      return this.skippedWithQuoteQuality(
        initialFillQualityBlock,
        prepared.quoteSnapshot,
        this.executionTimings(executeStartedAt, null, null, { preflightStartedAt: blockedAt, preflightCompletedAt: blockedAt, hotGateStartedAt, hotGateCompletedAt: blockedAt }),
        fillQualitySnapshot,
      );
    }
    const preflightStartedAt = this.now();
    const preflightFailure = await this.preflightVenueOrders([
      { client: this.kalshiClient, leg: prepared.kalshi.leg, context: kalshiContext },
      { client: this.polymarketClient, leg: prepared.polymarket.leg, context: polymarketContext },
    ]);
    const preflightCompletedAt = this.now();
    if (preflightFailure) {
      return this.skippedWithQuoteQuality(
        preflightFailure,
        prepared.quoteSnapshot,
        this.executionTimings(executeStartedAt, null, null, { preflightStartedAt, preflightCompletedAt, hotGateStartedAt, hotGateCompletedAt: preflightCompletedAt }),
        fillQualitySnapshot,
      );
    }
    if (preflightCompletedAt - preflightStartedAt > this.config.liveQuoteMaxAgeMs) {
      return this.skippedWithQuoteQuality(
        `live preflight took ${preflightCompletedAt - preflightStartedAt}ms, exceeding quote freshness window ${this.config.liveQuoteMaxAgeMs}ms`,
        prepared.quoteSnapshot,
        this.executionTimings(executeStartedAt, null, null, { preflightStartedAt, preflightCompletedAt, hotGateStartedAt, hotGateCompletedAt: preflightCompletedAt }),
        fillQualitySnapshot,
      );
    }
    const refreshed = this.prepareExecution(candidate, kalshiLeg, polymarketLeg, polymarketFirstCrossCents);
    if (isPrepareSkip(refreshed)) {
      return this.skippedWithQuoteQuality(
        `live quote revalidation after preflight failed: ${refreshed.skipReason}`,
        refreshed.rejectedSnapshot ?? prepared.quoteSnapshot,
        this.executionTimings(executeStartedAt, null, null, { preflightStartedAt, preflightCompletedAt, hotGateStartedAt, hotGateCompletedAt: this.now() }),
        fillQualitySnapshot,
      );
    }
    prepared = refreshed;
    // LA5: the lead-lag and fill-quality snapshots are SHADOW telemetry unless their gate is enabled
    // (leadLagBlockReason / fillQualityBlockReason return null when the gate is off). Only RECOMPUTE them
    // on the post-preflight refresh when the gate is ON — it must re-decide on the refreshed quote. When
    // OFF (the default), keep the initial snapshot for telemetry and skip the redundant second
    // computation on the submit critical path. Trading behavior is unchanged: a disabled gate never
    // blocks on either snapshot, so the accept/reject outcome is identical either way.
    // Recompute lead-lag on the refresh when its own gate is on OR the fill-quality gate is on: the
    // fill-quality score reads the refreshed lead-lag via quoteSnapshot.leadLagSnapshot (set as a side
    // effect of leadLagSnapshot()), so a fill-quality-gate-on / lead-lag-gate-off config must still see
    // the refreshed lead-lag to score identically to the pre-LA5 behavior. Only the lead-lag GATE blocks.
    if (this.config.liveLeadLagGateEnabled || this.config.liveFillQualityGateEnabled) {
      leadLagSnapshot = this.leadLagSnapshot(candidate, prepared.quoteSnapshot);
    }
    if (this.config.liveLeadLagGateEnabled) {
      const refreshedLeadLagBlock = leadLagBlockReason(leadLagSnapshot);
      if (refreshedLeadLagBlock) {
        return this.skippedWithQuoteQuality(
          refreshedLeadLagBlock,
          prepared.quoteSnapshot,
          this.executionTimings(executeStartedAt, null, null, { preflightStartedAt, preflightCompletedAt, hotGateStartedAt, hotGateCompletedAt: this.now() }),
          null,
        );
      }
    }
    if (this.config.liveFillQualityGateEnabled) {
      fillQualitySnapshot = await this.fillQualitySnapshot(candidate, prepared.quoteSnapshot, placementMode);
      const refreshedFillQualityBlock = fillQualityBlockReason(fillQualitySnapshot);
      if (refreshedFillQualityBlock) {
        return this.skippedWithQuoteQuality(
          refreshedFillQualityBlock,
          prepared.quoteSnapshot,
          this.executionTimings(executeStartedAt, null, null, { preflightStartedAt, preflightCompletedAt, hotGateStartedAt, hotGateCompletedAt: this.now() }),
          fillQualitySnapshot,
        );
      }
    }
    kalshiContext = {
      ...kalshiContext,
      maxBuyPrice: prepared.kalshi.maxBuyPrice,
      requiredCollateral: this.kalshiPreflightCollateral(prepared, placementMode),
    };
    polymarketContext = {
      ...polymarketContext,
      maxBuyPrice: prepared.polymarket.maxBuyPrice,
      requiredCollateral: roundPrice(this.config.liveOrderSize * prepared.polymarket.maxBuyPrice + this.config.liveCollateralBufferDollars),
    };
    // LA3: re-preflight Polymarket too in the share-limit presign modes so it RE-PRESIGNS at the refreshed
    // capped price. Otherwise the order is presigned once at the initial price, the post-preflight quote
    // refresh moves the cap, and the submit finds the cached signature stale (price_changed) and re-signs
    // inline on the first-leg critical path (polymarketSignMs avg 81 / p95 389). Re-presign is local-only
    // (cached hot readiness + cached order book; just the EIP-712 sign) and runs in parallel with the
    // now-cached Kalshi preflight, so the submit reuses the signature (~3ms) instead of re-signing.
    const refreshesPolymarket = placementMode === "parallel_quick" || placementMode === "polymarket_first_exact";
    const refreshedPreflightOrders = refreshesPolymarket
      ? [
        { client: this.kalshiClient, leg: prepared.kalshi.leg, context: kalshiContext },
        { client: this.polymarketClient, leg: prepared.polymarket.leg, context: polymarketContext },
      ]
      : [
        { client: this.kalshiClient, leg: prepared.kalshi.leg, context: kalshiContext },
      ];
    const refreshedKalshiPreflight = await this.preflightVenueOrders(refreshedPreflightOrders);
    if (refreshedKalshiPreflight) {
      const blockedAt = this.now();
      return this.skippedWithQuoteQuality(
        refreshesPolymarket
          ? `live refreshed preflight failed: ${refreshedKalshiPreflight}`
          : `live Kalshi hedge collateral revalidation failed: ${refreshedKalshiPreflight}`,
        prepared.quoteSnapshot,
        this.executionTimings(executeStartedAt, null, null, { preflightStartedAt, preflightCompletedAt: blockedAt, hotGateStartedAt, hotGateCompletedAt: blockedAt }),
        fillQualitySnapshot,
      );
    }
    const hotGateCompletedAt = this.now();
    const fillQualityMetadata = {
      leadLagSnapshot,
      fillQualitySnapshot,
      expectedExecutableEdge: fillQualitySnapshot?.expectedExecutableEdge ?? null,
      // C1: carried into every result path so a one-sided fill can be auto-unwound (when enabled).
      unwindLegs: { kalshi: prepared.kalshi.leg, polymarket: prepared.polymarket.leg },
    };

    if (placementMode === "polymarket_first_exact") {
      return await this.executePolymarketFirstExact(candidate, executionGroupId, prepared, kalshiContext, polymarketContext, {
        executeStartedAt,
        preflightStartedAt,
        preflightCompletedAt,
        hotGateStartedAt,
        hotGateCompletedAt,
      }, fillQualityMetadata);
    }

    if (placementMode === "parallel_quick") {
      return await this.executeParallelQuick(executionGroupId, prepared, kalshiContext, polymarketContext, {
        executeStartedAt,
        preflightStartedAt,
        preflightCompletedAt,
        hotGateStartedAt,
        hotGateCompletedAt,
      }, fillQualityMetadata);
    }

    if (placementMode === "kalshi_first_exact") {
      // Structural sequencing fix (P2-8): commit the RELIABLE, INTEGER, collateral-constrained venue
      // (Kalshi, FOK) FIRST, and submit the Polymarket hedge only after an exact Kalshi fill. The
      // pre-Polymarket collateral gate means an underfunded/unfillable Kalshi leg aborts BEFORE any
      // Polymarket order, so the residual failure flips from "Polymarket filled / Kalshi missing"
      // (held fractional one-sided) to "Kalshi missing / Polymarket never sent" (flat). A true passive
      // resting variant (kalshi_rest_then_cross) is a future refinement requiring resting-order client
      // support and double-fill protection.
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
      const firstDecision: SequentialFirstVenueDecision = {
        firstVenue: "kalshi",
        firstVenueReason: "kalshi_first_exact: commit the reliable integer Kalshi leg (FOK) first, then hedge Polymarket after an exact Kalshi fill",
        firstVenueVwap: prepared.quoteSnapshot.kalshi?.vwap ?? prepared.kalshi.maxBuyPrice,
      };
      return await this.executeFirstThenHedge(candidate, executionGroupId, prepared, kalshiPlan, polymarketPlan, firstDecision, {
        executeStartedAt,
        preflightStartedAt,
        preflightCompletedAt,
        hotGateStartedAt,
        hotGateCompletedAt,
      }, fillQualityMetadata, "kalshi_first_exact");
    }

    if (this.config.liveParallelExecutionEnabled || placementMode === "parallel_market") {
      const executionStrategy = placementMode === "parallel_limit_rest"
        ? "parallel_limit_rest"
        : placementMode === "parallel_market"
          ? "parallel_market"
          : placementMode === "parallel_fak"
            ? "parallel_fak"
            : "parallel_fok";
      const firstVenueReason = placementMode === "parallel_limit_rest"
        ? `parallel aggressive limit orders submitted concurrently with ${limitRestMs ?? 0}ms rest`
        : placementMode === "parallel_market"
          ? "parallel capped market orders submitted concurrently"
          : placementMode === "parallel_fak"
            ? "parallel Kalshi FOK and Polymarket FAK orders submitted concurrently"
            : "parallel FOK orders submitted concurrently";
      const [kalshi, polymarket] = await Promise.all([
        this.placeVenueOrder(this.kalshiClient, prepared.kalshi.leg, kalshiContext),
        this.placeVenueOrder(this.polymarketClient, prepared.polymarket.leg, polymarketContext),
      ]);
      const venueConfirmations = await this.confirmVenueOrders(executionGroupId, [
        { result: kalshi, leg: prepared.kalshi.leg, submittedAtMs: Date.parse(kalshi.requestedAt) },
        { result: polymarket, leg: prepared.polymarket.leg, submittedAtMs: Date.parse(polymarket.requestedAt) },
      ]);
      const confirmed = this.applyVenueConfirmations(kalshi, polymarket, venueConfirmations, prepared.kalshi.leg, prepared.polymarket.leg);
      return await this.resultFromVenueOrders(executionGroupId, confirmed.kalshi, confirmed.polymarket, {
        quoteSnapshot: prepared.quoteSnapshot,
        ...fillQualityMetadata,
        executionTimings: this.executionTimings(executeStartedAt, confirmed.kalshi, confirmed.polymarket, {
          preflightStartedAt,
          preflightCompletedAt,
          firstVenue: null,
          firstVenueReason,
          firstVenueVwap: null,
          hotGateStartedAt,
          hotGateCompletedAt,
          venueConfirmations,
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
    return await this.executeFirstThenHedge(candidate, executionGroupId, prepared, firstPlan, hedgePlan, firstDecision, {
      executeStartedAt,
      preflightStartedAt,
      preflightCompletedAt,
      hotGateStartedAt,
      hotGateCompletedAt,
    }, fillQualityMetadata, "sequential_hedge");
  }

  // Shared "place the first leg, then hedge the other after an exact first-leg fill" machinery used by
  // both the legacy sequential_hedge path (which picks the cheaper leg) and kalshi_first_exact (which
  // forces Kalshi first). The first leg is submitted whole; only an exact fill triggers the hedge, so a
  // first-leg miss never sends the second order (flat). The hedge is sized to the actual first-leg fill
  // (P0-1) and retried on a clean miss (P0-3). A hedge cap/preflight failure declines the hedge and
  // routes any one-sided residual to the existing lock/quarantine path unchanged.
  private async executeFirstThenHedge(
    candidate: ArbCandidate,
    executionGroupId: string,
    prepared: PreparedExecution,
    firstPlan: VenueExecutionPlan,
    hedgePlan: VenueExecutionPlan,
    firstDecision: SequentialFirstVenueDecision,
    timings: {
      executeStartedAt: number;
      preflightStartedAt: number;
      preflightCompletedAt: number;
      hotGateStartedAt: number;
      hotGateCompletedAt: number;
    },
    fillQualityMetadata: Pick<ExecutionMetadata, "leadLagSnapshot" | "fillQualitySnapshot" | "expectedExecutableEdge" | "unwindLegs">,
    executionStrategy: ExecutionStrategy,
  ): Promise<ExecutionResult> {
    const results: Partial<Record<Venue, VenueOrderResult>> = {};

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
        ...fillQualityMetadata,
        executionTimings: this.executionTimings(timings.executeStartedAt, results.kalshi ?? null, results.polymarket ?? null, {
          preflightStartedAt: timings.preflightStartedAt,
          preflightCompletedAt: timings.preflightCompletedAt,
          hotGateStartedAt: timings.hotGateStartedAt,
          hotGateCompletedAt: timings.hotGateCompletedAt,
          ...firstDecision,
        }),
        executionStrategy,
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
        ...fillQualityMetadata,
        executionTimings: this.executionTimings(timings.executeStartedAt, results.kalshi ?? null, results.polymarket ?? null, {
          preflightStartedAt: timings.preflightStartedAt,
          preflightCompletedAt: timings.preflightCompletedAt,
          hotGateStartedAt: timings.hotGateStartedAt,
          hotGateCompletedAt: timings.hotGateCompletedAt,
          postFillHedgeDecisionMs,
          ...firstDecision,
        }),
        executionStrategy,
        riskHedge: true,
        hedgeCapPrice: null,
        hedgeFailureReason,
      });
    }

    const hedgeContext: LiveOrderContext = {
      ...hedgePlan.context,
      size: hedge.hedgeShares,
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
        ...fillQualityMetadata,
        executionTimings: this.executionTimings(timings.executeStartedAt, results.kalshi ?? null, results.polymarket ?? null, {
          preflightStartedAt: timings.preflightStartedAt,
          preflightCompletedAt: timings.preflightCompletedAt,
          hotGateStartedAt: timings.hotGateStartedAt,
          hotGateCompletedAt: timings.hotGateCompletedAt,
          postFillHedgeDecisionMs,
          ...firstDecision,
        }),
        executionStrategy,
        riskHedge: true,
        hedgeCapPrice: hedge.hedgeCapPrice,
        hedgeFailureReason,
      });
    }

    const hedgeResult = await this.placeHedgeWithRetry(
      hedgePlan.client,
      candidate,
      firstPlan.prepared.leg,
      hedgePlan.prepared.leg,
      firstResult,
      hedge,
      hedgeContext,
    );
    results[hedgePlan.venue] = hedgeResult;
    const venueConfirmations = await this.confirmVenueOrders(executionGroupId, [
      { result: firstResult, leg: firstPlan.prepared.leg, submittedAtMs: Date.parse(firstResult.requestedAt) },
      { result: hedgeResult, leg: hedge.leg, submittedAtMs: Date.parse(hedgeResult.requestedAt) },
    ]);
    const kalshiConfirmationLeg = firstPlan.venue === "kalshi" ? firstPlan.prepared.leg : hedge.leg;
    const polymarketConfirmationLeg = firstPlan.venue === "polymarket" ? firstPlan.prepared.leg : hedge.leg;
    const confirmed = this.applyVenueConfirmations(results.kalshi!, results.polymarket!, venueConfirmations, kalshiConfirmationLeg, polymarketConfirmationLeg);

    return await this.resultFromVenueOrders(executionGroupId, confirmed.kalshi, confirmed.polymarket, {
      quoteSnapshot: hedge.quoteSnapshot,
      ...fillQualityMetadata,
      executionTimings: this.executionTimings(timings.executeStartedAt, confirmed.kalshi, confirmed.polymarket, {
        preflightStartedAt: timings.preflightStartedAt,
        preflightCompletedAt: timings.preflightCompletedAt,
        hotGateStartedAt: timings.hotGateStartedAt,
        hotGateCompletedAt: timings.hotGateCompletedAt,
        postFillHedgeDecisionMs,
        ...firstDecision,
        venueConfirmations,
      }),
      venueConfirmations,
      executionStrategy,
      riskHedge: true,
      hedgeCapPrice: hedge.hedgeCapPrice,
    });
  }

  private async executeParallelQuick(
    executionGroupId: string,
    prepared: PreparedExecution,
    kalshiContext: LiveOrderContext,
    polymarketContext: LiveOrderContext,
    timings: {
      executeStartedAt: number;
      preflightStartedAt: number;
      preflightCompletedAt: number;
      hotGateStartedAt: number;
      hotGateCompletedAt: number;
    },
    fillQualityMetadata: Pick<ExecutionMetadata, "leadLagSnapshot" | "fillQualitySnapshot" | "expectedExecutableEdge" | "unwindLegs">,
  ): Promise<ExecutionResult> {
    const submitted = await this.submitSynchronizedVenueOrders(prepared, kalshiContext, polymarketContext);
    const venueConfirmations = await this.confirmVenueOrders(executionGroupId, [
      { result: submitted.kalshi, leg: prepared.kalshi.leg, submittedAtMs: Date.parse(submitted.kalshi.requestedAt) },
      { result: submitted.polymarket, leg: prepared.polymarket.leg, submittedAtMs: Date.parse(submitted.polymarket.requestedAt) },
    ]);
    const confirmed = this.applyVenueConfirmations(
      submitted.kalshi,
      submitted.polymarket,
      venueConfirmations,
      prepared.kalshi.leg,
      prepared.polymarket.leg,
    );
    return await this.resultFromVenueOrders(executionGroupId, confirmed.kalshi, confirmed.polymarket, {
      quoteSnapshot: prepared.quoteSnapshot,
      ...fillQualityMetadata,
      executionTimings: this.executionTimings(timings.executeStartedAt, confirmed.kalshi, confirmed.polymarket, {
        preflightStartedAt: timings.preflightStartedAt,
        preflightCompletedAt: timings.preflightCompletedAt,
        firstVenue: null,
        firstVenueReason: this.config.kalshiHedgeOrderMode === "fix_ioc"
          ? "parallel Kalshi FIX IOC and Polymarket exact-share FAK submitted concurrently"
          : this.config.kalshiHedgeOrderMode === "public_v2"
            ? "parallel Kalshi public V2 IOC and Polymarket exact-share FAK submitted concurrently"
            : "parallel Kalshi UI Quick Order and Polymarket exact-share FAK submitted concurrently",
        firstVenueVwap: null,
        hotGateStartedAt: timings.hotGateStartedAt,
        hotGateCompletedAt: timings.hotGateCompletedAt,
        venueConfirmations,
        parallelDispatchAtMs: submitted.dispatchAtMs,
        parallelDispatchCallSkewMs: submitted.dispatchCallSkewMs,
        parallelSettledAtMs: submitted.settledAtMs,
      }),
      venueConfirmations,
      executionStrategy: "parallel_quick",
      riskHedge: false,
    });
  }

  private async executePolymarketFirstExact(
    candidate: ArbCandidate,
    executionGroupId: string,
    prepared: PreparedExecution,
    kalshiContext: LiveOrderContext,
    polymarketContext: LiveOrderContext,
    timings: {
      executeStartedAt: number;
      preflightStartedAt: number;
      preflightCompletedAt: number;
      hotGateStartedAt: number;
      hotGateCompletedAt: number;
    },
    fillQualityMetadata: Pick<ExecutionMetadata, "leadLagSnapshot" | "fillQualitySnapshot" | "expectedExecutableEdge" | "unwindLegs">,
  ): Promise<ExecutionResult> {
    const firstVenueReason = `Polymarket FAK submitted first; Kalshi submits after Polymarket fill count is within ${this.polymarketFirstFillRangeLabel()}`;
    const firstVenueVwap = prepared.quoteSnapshot.polymarket?.vwap ?? prepared.polymarket.maxBuyPrice;
    const polymarketSubmittedAt = this.now();
    const pendingPolymarket = this.pendingVenueResult("polymarket", polymarketContext.clientOrderId, polymarketSubmittedAt);
    const polymarketConfirmationPromise = this.config.liveUserStreamsEnabled && this.confirmationMonitor
      ? this.confirmVenueOrder(executionGroupId, pendingPolymarket, prepared.polymarket.leg, polymarketSubmittedAt, { firstLegTrigger: true })
      : Promise.resolve(null);
    const polymarketRestPromise = this.placeVenueOrder(this.polymarketClient, prepared.polymarket.leg, {
      ...polymarketContext,
      requestedAt: polymarketSubmittedAt,
    });
    const polymarketEvidence = await this.firstPolymarketHedgeTriggerEvidence(
      prepared.polymarket.leg,
      polymarketRestPromise,
      polymarketConfirmationPromise,
      pendingPolymarket,
    );

    if (!polymarketEvidence.trigger) {
      const polymarket = polymarketEvidence.restResult ?? await polymarketRestPromise;
      const polymarketConfirmation = polymarketEvidence.confirmation ?? await polymarketConfirmationPromise;
      const confirmedPolymarket = this.applyVenueConfirmation(polymarket, polymarketConfirmation, prepared.polymarket.leg);
      const polymarketConfirmations = polymarketConfirmation ? { polymarket: polymarketConfirmation } : null;
      const hedgeSkipReason = this.polymarketHedgeTriggerSkipReason(confirmedPolymarket);
      const kalshi = this.notSubmittedResult(
        "kalshi",
        kalshiContext.clientOrderId,
        hedgeSkipReason,
      );
      return await this.resultFromVenueOrders(executionGroupId, kalshi, confirmedPolymarket, {
        quoteSnapshot: prepared.quoteSnapshot,
        ...fillQualityMetadata,
        executionTimings: this.executionTimings(timings.executeStartedAt, kalshi, confirmedPolymarket, {
          preflightStartedAt: timings.preflightStartedAt,
          preflightCompletedAt: timings.preflightCompletedAt,
          hotGateStartedAt: timings.hotGateStartedAt,
          hotGateCompletedAt: timings.hotGateCompletedAt,
          firstVenue: "polymarket",
          firstVenueReason,
          firstVenueVwap,
          venueConfirmations: polymarketConfirmations ?? undefined,
        }),
        venueConfirmations: polymarketConfirmations,
        executionStrategy: "polymarket_first_exact",
        riskHedge: false,
      });
    }

    const evidence = polymarketEvidence.trigger;
    const confirmedPolymarket = evidence.result;
    const hedgeDecisionStartedAt = this.now();
    const hedge = this.prepareVenueHedge(candidate, prepared.polymarket.leg, prepared.kalshi.leg, confirmedPolymarket);
    const postFillHedgeDecisionMs = Math.max(0, this.now() - hedgeDecisionStartedAt);
    if (typeof hedge === "string") {
      const hedgeFailureReason = `Kalshi hedge cap preflight failed: ${hedge}`;
      const kalshi = this.notSubmittedResult(
        "kalshi",
        kalshiContext.clientOrderId,
        `not submitted because ${hedgeFailureReason}`,
      );
      return await this.resultFromVenueOrders(executionGroupId, kalshi, confirmedPolymarket, {
        quoteSnapshot: prepared.quoteSnapshot,
        ...fillQualityMetadata,
        executionTimings: this.executionTimings(timings.executeStartedAt, kalshi, confirmedPolymarket, {
          preflightStartedAt: timings.preflightStartedAt,
          preflightCompletedAt: timings.preflightCompletedAt,
          hotGateStartedAt: timings.hotGateStartedAt,
          hotGateCompletedAt: timings.hotGateCompletedAt,
          postFillHedgeDecisionMs,
          ...this.polymarketHedgeTriggerTimingMetadata(evidence),
          firstVenue: "polymarket",
          firstVenueReason,
          firstVenueVwap,
          venueConfirmations: evidence.confirmation ? { polymarket: evidence.confirmation } : undefined,
        }),
        venueConfirmations: evidence.confirmation ? { polymarket: evidence.confirmation } : null,
        executionStrategy: "polymarket_first_exact",
        riskHedge: true,
        hedgeFailureReason,
      });
    }

    const hedgeContext: LiveOrderContext = {
      ...kalshiContext,
      size: hedge.hedgeShares,
      maxBuyPrice: hedge.maxBuyPrice,
      requiredCollateral: hedge.requiredCollateral,
    };
    const kalshi = await this.placeHedgeWithRetry(
      this.kalshiClient,
      candidate,
      prepared.polymarket.leg,
      prepared.kalshi.leg,
      confirmedPolymarket,
      hedge,
      hedgeContext,
    );
    const finalPolymarketRest = polymarketEvidence.restResult ?? await polymarketRestPromise;
    const finalPolymarketConfirmation = polymarketEvidence.confirmation ?? await polymarketConfirmationPromise;
    const finalPolymarket = this.applyVenueConfirmation(
      this.mergePolymarketHedgeTriggerEvidence(evidence, finalPolymarketRest),
      finalPolymarketConfirmation,
      prepared.polymarket.leg,
    );
    const kalshiConfirmations = await this.confirmVenueOrders(executionGroupId, [
      { result: kalshi, leg: hedge.leg, submittedAtMs: Date.parse(kalshi.requestedAt) },
    ]);
    const venueConfirmations = {
      ...(finalPolymarketConfirmation ? { polymarket: finalPolymarketConfirmation } : {}),
      ...(kalshiConfirmations ?? {}),
    };
    const confirmedKalshi = this.applyVenueConfirmation(kalshi, venueConfirmations.kalshi, hedge.leg);
    return await this.resultFromVenueOrders(executionGroupId, confirmedKalshi, finalPolymarket, {
      quoteSnapshot: hedge.quoteSnapshot,
      ...fillQualityMetadata,
      executionTimings: this.executionTimings(timings.executeStartedAt, confirmedKalshi, finalPolymarket, {
        preflightStartedAt: timings.preflightStartedAt,
        preflightCompletedAt: timings.preflightCompletedAt,
        hotGateStartedAt: timings.hotGateStartedAt,
        hotGateCompletedAt: timings.hotGateCompletedAt,
        postFillHedgeDecisionMs,
        ...this.polymarketHedgeTriggerTimingMetadata(evidence),
        firstVenue: "polymarket",
        firstVenueReason,
        firstVenueVwap,
        venueConfirmations,
      }),
      venueConfirmations,
      executionStrategy: "polymarket_first_exact",
      riskHedge: true,
      hedgeCapPrice: hedge.hedgeCapPrice,
    });
  }

  private failed(reason: string): ExecutionResult {
    return failed(reason);
  }

  private executionQualityOptions(): LiveExecutionQualityOptions {
    return {
      enabled: this.config.liveExecutionQualityGateEnabled,
      lookbackMs: this.config.liveExecutionQualityLookbackMs,
      sampleLimit: this.config.liveExecutionQualitySampleLimit,
      minSamples: this.config.liveExecutionQualityMinSamples,
      minExactFillRate: this.config.liveExecutionQualityMinExactFillRate,
    };
  }

  private async fillQualitySnapshot(
    candidate: ArbCandidate,
    quoteSnapshot: QuoteSnapshot,
    placementMode: LiveOrderPlacementMode,
  ): Promise<FillQualitySnapshot | null> {
    if (!this.config.liveFillQualityScoringEnabled) return null;
    const now = this.now();
    const recentSignals = await (this.quarantineExposureReader?.listLiveExecutionQualitySignals?.(
      now,
      this.config.liveFillQualityLookbackMs,
      this.config.liveFillQualitySampleLimit,
    ) ?? Promise.resolve([]));
    const eventReader = this.orderEvents as (VenueOrderEventWriter & Partial<VenueOrderEventReader>) | undefined;
    const recentVenueEvents = await (eventReader?.listRecentEvents?.(
      now - Math.max(0, this.config.liveFillQualityLookbackMs),
      this.config.liveFillQualitySampleLimit,
    ) ?? Promise.resolve([]));
    return scoreFillQuality({
      candidate,
      quoteSnapshot,
      recentSignals,
      recentVenueEvents,
      config: this.config,
      nowMs: now,
      placementMode,
    });
  }

  private leadLagSnapshot(candidate: ArbCandidate, quoteSnapshot: QuoteSnapshot): LeadLagSnapshot | null {
    if (!this.config.liveLeadLagScoringEnabled) return null;
    const now = this.now();
    const maxWindowMs = Math.max(1, ...this.config.liveLeadLagWindowsMs);
    const history = this.books?.leadLagHistoryForQuoteSnapshot?.(quoteSnapshot, now, maxWindowMs) ?? { kalshi: [], polymarket: [] };
    const snapshot = scoreLeadLag({
      candidate,
      quoteSnapshot,
      history,
      config: this.config,
      nowMs: now,
    });
    quoteSnapshot.leadLagSnapshot = snapshot;
    return snapshot;
  }

  private skippedWithQuoteQuality(
    reason: string,
    quoteSnapshot: QuoteSnapshot,
    executionTimings: ExecutionTimings,
    fillQualitySnapshot: FillQualitySnapshot | null,
  ): ExecutionResult {
    return {
      ...skipped(reason),
      quoteSnapshot,
      depthVwap: quoteSnapshot.projectedPremium,
      projectedEdgeAfterFees: quoteSnapshot.projectedEdgeAfterFees,
      leadLagSnapshot: quoteSnapshot.leadLagSnapshot ?? null,
      fillQualitySnapshot,
      expectedExecutableEdge: fillQualitySnapshot?.expectedExecutableEdge ?? null,
      executionTimings,
    };
  }

  // Early below-threshold-edge skip that carries the captured shadow-ladder snapshot (T2.4) for
  // persistence, without the full timings/fill-quality context (not yet computed at this pre-dispatch
  // point). No executionGroupId is assigned, so no exposure/lock/reconciliation logic is engaged.
  private skippedWithShadowLadder(reason: string, quoteSnapshot: QuoteSnapshot): ExecutionResult {
    return {
      ...skipped(reason),
      quoteSnapshot,
      depthVwap: quoteSnapshot.projectedPremium,
      projectedEdgeAfterFees: quoteSnapshot.projectedEdgeAfterFees,
    };
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
    partialFillLocked = this.partialFillLocked,
    exactExposureReason: string | null = null,
    executionQualityReason: string | null = null,
  ): { state: LiveRiskState; reason: string | null } {
    if (this.config.liveExactExposureRequired && exactExposureReason) return { state: "blocked", reason: exactExposureReason };
    if (this.config.liveExecutionQualityGateEnabled && executionQualityReason) return { state: "blocked", reason: executionQualityReason };
    if (!this.config.liveAutoHardlocksEnabled) {
      return {
        state: "auto_hardlocks_disabled",
        reason: "temporary operator override: automatic hardlocks are disabled; unresolved risk will be audited but will not stop new candidates",
      };
    }
    if (circuitBreakerReason) return { state: "hard_locked", reason: circuitBreakerReason };
    if (partialFillLocked) return { state: "hard_locked", reason: "in-memory partial-fill latch is set" };
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

  // Collateral to reserve for the Kalshi leg during the pre-Polymarket preflight. For
  // polymarket_first_exact, Kalshi is the DEFERRED hedge whose limit can rise to the tick-aware,
  // loss-capped hedge cap (P0-2) — which is highest when Polymarket fills at its cheapest (top ask).
  // Reserve for that worst case BEFORE dispatching Polymarket so a qualifying fill can always be hedged
  // and never strands one-sided. Other modes reserve at the standard order-size * maxBuyPrice.
  private kalshiPreflightCollateral(prepared: PreparedExecution, placementMode: LiveOrderPlacementMode): number {
    const standard = roundPrice(this.config.liveOrderSize * prepared.kalshi.maxBuyPrice + this.config.liveCollateralBufferDollars);
    if (placementMode !== "polymarket_first_exact") return standard;
    const polyTopAsk = prepared.quoteSnapshot.polymarket?.topAsk
      ?? prepared.quoteSnapshot.polymarket?.vwap
      ?? prepared.polymarket.maxBuyPrice;
    const worstCaseHedgePrice = Math.min(1, Math.max(
      prepared.kalshi.maxBuyPrice,
      1 - polyTopAsk - this.config.liveHedgeFeeBufferDollars + this.config.liveHedgeMaxLossDollars,
    ));
    return roundPrice(this.config.liveOrderSize * worstCaseHedgePrice + this.config.liveCollateralBufferDollars);
  }

  private prepareExecution(candidate: ArbCandidate, kalshiLeg: ArbLeg, polymarketLeg: ArbLeg, polymarketFirstCrossCents = 0): PreparedExecution | PrepareSkip {
    const now = this.now();
    if (!Number.isFinite(this.config.liveOrderSize) || this.config.liveOrderSize <= 0) {
      return { skipReason: "LIVE_ORDER_SIZE must be greater than 0", rejectedSnapshot: null };
    }
    if (candidate.expiryMs - now < this.config.liveMinExpiryMs) {
      return { skipReason: "candidate too close to expiry for live execution", rejectedSnapshot: null };
    }
    const books = this.liveBooksForPreflight(kalshiLeg, polymarketLeg);
    const evaluation = evaluateLiveQuoteQuality(candidate, books, this.config, now, polymarketFirstCrossCents);
    if (!evaluation.ok) {
      const skipReason = evaluation.reason ?? "live quote quality preflight failed";
      // T2.4 read-only diagnostic: only on the dominant below-threshold-edge skip, and only when
      // explicitly enabled. Attaches the multi-size ladder snapshot so the scanner persists it; the
      // gate outcome is already decided (evaluation.ok === false) so this can never flip a reject.
      let rejectedSnapshot: QuoteSnapshot | null = null;
      if (this.config.liveShadowLadderCaptureEnabled && skipReason.startsWith(CUSHIONED_EDGE_REASON_PREFIX)) {
        rejectedSnapshot = { ...evaluation.snapshot, shadowLadder: captureShadowLadder(candidate, books, this.config, now) };
      }
      return { skipReason, rejectedSnapshot };
    }
    if (!evaluation.kalshiLeg || !evaluation.polymarketLeg || evaluation.kalshiMaxBuyPrice == null || evaluation.polymarketMaxBuyPrice == null) {
      return { skipReason: "live quote quality preflight missing executable legs", rejectedSnapshot: null };
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
    // Size the hedge to the ACTUAL first-leg fill (integer floor), not the static configured order
    // size. For an integer first-leg fill the two executed sizes match exactly (a clean two-sided
    // fill). For a fractional first-leg fill (e.g. Polymarket 8.13) the integer Kalshi hedge takes the
    // floor (8), so only the small fractional remainder (0.13) stays one-sided and routes to the
    // existing partial/quarantine path (bounded by liveMaxUnresolvedExposureDollars). This strictly
    // minimizes residual exposure: declining the hedge would strand the whole fill, and hedging the
    // static size could over-hedge when fill < size and create opposite-side exposure.
    const filledFillCount = filled.fillCount;
    if (filledFillCount == null || !Number.isFinite(filledFillCount) || filledFillCount <= 0) {
      return `${venueLabel(filledLeg.venue)} fill count unavailable; cannot size ${hedgeVenue} hedge`;
    }
    const hedgeShares = Math.floor(filledFillCount + 0.000001);
    if (hedgeShares <= 0) {
      return `${venueLabel(filledLeg.venue)} fill ${filledFillCount} below one share; cannot size ${hedgeVenue} hedge`;
    }
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
      requiredCollateral: roundPrice(hedgeShares * hedgeCapPrice + this.config.liveCollateralBufferDollars),
      hedgeCapPrice,
      hedgeShares,
      quoteSnapshot: evaluation.snapshot,
    };
  }

  // A FOK hedge either fills the exact requested integer size or fills 0 (it can never strand a
  // partial). A clean 0-fill is retryable: the book may simply have moved a tick during the leg1->leg2
  // window. We do NOT retry on any fill, on insufficient collateral, or on an ambiguous/timeout/unknown
  // result (which may have filled and must not be double-submitted — reconciliation handles those).
  private isHedgeRetryable(result: VenueOrderResult): boolean {
    if ((result.fillCount ?? 0) > 0) return false;
    if (String(result.status ?? "").toLowerCase() === "filled") return false;
    if (isTimeoutOrUnknownResult(result)) return false;
    const error = String(result.error ?? "").toLowerCase();
    if (error.includes("insufficient_balance")
      || error.includes("below required")
      || error.includes("collateral")) {
      return false;
    }
    return true;
  }

  // Submit the hedge and, on a clean FOK miss, re-fetch the book, recompute the cap from the SAME
  // first-leg fill, and resubmit up to liveHedgeRetryAttempts times. Each retry is bounded by the
  // candidate not having expired, and re-preparation returns a skip string if the book moved out of the
  // (loss-capped) hedge cap, in which case we stop with the clean 0-fill rather than chase the book.
  private async placeHedgeWithRetry(
    client: VenueOrderClient,
    candidate: ArbCandidate,
    filledLeg: ArbLeg,
    hedgeLeg: ArbLeg,
    filled: VenueOrderResult,
    hedge: PreparedHedge,
    baseContext: LiveOrderContext,
  ): Promise<VenueOrderResult> {
    const hedgeStartedAt = this.now();
    let result = await this.placeVenueOrder(client, hedge.leg, baseContext);
    const maxAttempts = Math.max(0, this.config.liveHedgeRetryAttempts);
    const retryBudgetMs = Math.max(0, this.config.liveHedgeRetryBudgetMs);
    let attempt = 0;
    // Retries are bounded by attempt count, candidate expiry, AND a wall-clock budget since the first hedge
    // submit, so a string of slow Kalshi round-trips cannot stretch the one-sided window unboundedly. FOK
    // keeps every attempt atomic (no partial), so stopping early never strands a Kalshi partial.
    while (
      attempt < maxAttempts
      && this.isHedgeRetryable(result)
      && candidate.expiryMs > this.now()
      && this.now() - hedgeStartedAt < retryBudgetMs
    ) {
      attempt += 1;
      const reprepared = this.prepareVenueHedge(candidate, filledLeg, hedgeLeg, filled);
      if (typeof reprepared === "string") break;
      const retryContext: LiveOrderContext = {
        ...baseContext,
        clientOrderId: `${baseContext.clientOrderId}-r${attempt}`,
        size: reprepared.hedgeShares,
        maxBuyPrice: reprepared.maxBuyPrice,
        requiredCollateral: reprepared.requiredCollateral,
        requestedAt: this.now(),
      };
      result = await this.placeVenueOrder(client, reprepared.leg, retryContext);
    }
    return result;
  }

  // C1: bounded same-window auto-unwind of a one-sided fill. Reduces the FILLED leg toward flat via the
  // venue client's loss-bounded opposing order. Only ever shrinks an existing position; never opens a new
  // one. Returns flattened=false (fall through to quarantine/hardlock) when no client adapter exists, the
  // adapter declines, or it errors. Caller gates this behind liveAutoUnwindEnabled.
  private async attemptAutoUnwind(
    kalshi: VenueOrderResult,
    polymarket: VenueOrderResult,
    legs: { kalshi: ArbLeg; polymarket: ArbLeg },
  ): Promise<VenueUnwindOutcome | null> {
    const kalshiFill = kalshi.fillCount ?? 0;
    const polymarketFill = polymarket.fillCount ?? 0;
    const filled = kalshiFill > 0
      ? { client: this.kalshiClient, leg: legs.kalshi, fillCount: kalshiFill, fillPrice: kalshi.fillPrice }
      : { client: this.polymarketClient, leg: legs.polymarket, fillCount: polymarketFill, fillPrice: polymarket.fillPrice };
    if (!filled.client.unwindPosition || filled.fillCount <= 0) return { flattened: false, reason: "no unwind adapter" };
    try {
      return await filled.client.unwindPosition({
        leg: filled.leg,
        fillCount: filled.fillCount,
        fillPrice: filled.fillPrice ?? null,
        maxLossDollars: Math.max(0, this.config.liveAutoUnwindMaxLossDollars),
        timeoutMs: Math.max(1, this.config.liveAutoUnwindTimeoutMs),
      });
    } catch (error) {
      return { flattened: false, reason: error instanceof Error ? error.message : String(error) };
    }
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
    const submittedAt = context.requestedAt ?? this.now();
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

  private async submitSynchronizedVenueOrders(
    prepared: PreparedExecution,
    kalshiContext: LiveOrderContext,
    polymarketContext: LiveOrderContext,
  ): Promise<SynchronizedVenueOrderResults> {
    const dispatchAtMs = this.now();
    const kalshiCallStartedAt = this.now();
    const kalshiPromise = this.placeVenueOrder(this.kalshiClient, prepared.kalshi.leg, {
      ...kalshiContext,
      requestedAt: dispatchAtMs,
    });
    const polymarketCallStartedAt = this.now();
    const polymarketPromise = this.placeVenueOrder(this.polymarketClient, prepared.polymarket.leg, {
      ...polymarketContext,
      requestedAt: dispatchAtMs,
    });
    const [kalshiSettled, polymarketSettled] = await Promise.allSettled([kalshiPromise, polymarketPromise]);
    const settledAtMs = this.now();
    const resultFromSettled = (
      venue: Venue,
      clientOrderId: string,
      settled: PromiseSettledResult<VenueOrderResult>,
    ): VenueOrderResult => settled.status === "fulfilled"
      ? settled.value
      : failedVenueResult(venue, clientOrderId, settled.reason, dispatchAtMs);
    return {
      kalshi: resultFromSettled("kalshi", kalshiContext.clientOrderId, kalshiSettled),
      polymarket: resultFromSettled("polymarket", polymarketContext.clientOrderId, polymarketSettled),
      dispatchAtMs,
      settledAtMs,
      dispatchCallSkewMs: Math.abs(polymarketCallStartedAt - kalshiCallStartedAt),
    };
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

  private polymarketFirstFillRangeLabel(): string {
    return `${this.config.livePolymarketFirstMinFillShares}-${this.config.livePolymarketFirstMaxFillShares} shares`;
  }

  private isPolymarketFirstFillCountInRange(fillCount: unknown): fillCount is number {
    return typeof fillCount === "number"
      && Number.isFinite(fillCount)
      && fillCount + 0.000001 >= this.config.livePolymarketFirstMinFillShares
      && fillCount - 0.000001 <= this.config.livePolymarketFirstMaxFillShares;
  }

  private isPolymarketFirstHedgeTriggerResult(result: VenueOrderResult): boolean {
    return this.isPolymarketFirstFillCountInRange(result.fillCount)
      && result.fillPrice != null
      && Number.isFinite(result.fillPrice);
  }

  private isPolymarketFirstHedgeTriggerConfirmation(record: Record<string, unknown> | null | undefined): boolean {
    const status = String(record?.status ?? "");
    const fillPrice = typeof record?.fillPrice === "number" ? record.fillPrice : null;
    return ["confirmed", "mismatch"].includes(status)
      && this.isPolymarketFirstFillCountInRange(record?.fillCount)
      && fillPrice != null
      && Number.isFinite(fillPrice);
  }

  private polymarketHedgeTriggerMetadata(
    source: PolymarketHedgeTriggerEvidence["source"],
    fillCount: number,
  ): Record<string, unknown> {
    const isExact = Math.abs(fillCount - this.config.liveOrderSize) <= 0.000001;
    return {
      polymarketHedgeTriggerSource: source,
      polymarketHedgeTriggerFillCount: fillCount,
      polymarketHedgeTriggerMinFillShares: this.config.livePolymarketFirstMinFillShares,
      polymarketHedgeTriggerMaxFillShares: this.config.livePolymarketFirstMaxFillShares,
      polymarketHedgeTriggerExact: isExact,
      ...(isExact ? { polymarketExactEvidenceSource: source } : {}),
    };
  }

  private polymarketHedgeTriggerTimingMetadata(evidence: PolymarketHedgeTriggerEvidence): {
    polymarketExactEvidenceSource?: string | null;
    polymarketExactEvidenceAtMs?: number | null;
    polymarketHedgeTriggerSource: string;
    polymarketHedgeTriggerAtMs: number;
    polymarketHedgeTriggerFillCount: number;
    polymarketHedgeTriggerMinFillShares: number;
    polymarketHedgeTriggerMaxFillShares: number;
    polymarketHedgeTriggerExact: boolean;
  } {
    return {
      ...(evidence.isExact ? {
        polymarketExactEvidenceSource: evidence.source,
        polymarketExactEvidenceAtMs: evidence.receivedAtMs,
      } : {}),
      polymarketHedgeTriggerSource: evidence.source,
      polymarketHedgeTriggerAtMs: evidence.receivedAtMs,
      polymarketHedgeTriggerFillCount: evidence.fillCount,
      polymarketHedgeTriggerMinFillShares: this.config.livePolymarketFirstMinFillShares,
      polymarketHedgeTriggerMaxFillShares: this.config.livePolymarketFirstMaxFillShares,
      polymarketHedgeTriggerExact: evidence.isExact,
    };
  }

  private polymarketHedgeTriggerSkipReason(result: VenueOrderResult): string {
    if (result.fillCount == null || !Number.isFinite(result.fillCount)) {
      return `not submitted because Polymarket fill count was not available inside configured hedge range ${this.polymarketFirstFillRangeLabel()}`;
    }
    if (!this.isPolymarketFirstFillCountInRange(result.fillCount)) {
      return `not submitted because Polymarket fill count ${result.fillCount} was outside configured hedge range ${this.polymarketFirstFillRangeLabel()}`;
    }
    return `not submitted because Polymarket fill price was unavailable for configured hedge range ${this.polymarketFirstFillRangeLabel()}`;
  }

  private polymarketResultFromHedgeTriggerConfirmation(
    pendingResult: VenueOrderResult,
    confirmation: Record<string, unknown>,
    leg: ArbLeg,
  ): VenueOrderResult {
    const fillCount = typeof confirmation.fillCount === "number" ? confirmation.fillCount : null;
    const fillPrice = typeof confirmation.fillPrice === "number"
      ? economicFillPriceForLeg(pendingResult.venue, leg.direction, confirmation.fillPrice, leg.ask)
      : null;
    const receivedAtMs = typeof confirmation.receivedAtMs === "number" && Number.isFinite(confirmation.receivedAtMs)
      ? confirmation.receivedAtMs
      : null;
    const confirmed = confirmation.status === "confirmed";
    return {
      ...pendingResult,
      clientOrderId: typeof confirmation.clientOrderId === "string" && confirmation.clientOrderId
        ? confirmation.clientOrderId
        : pendingResult.clientOrderId,
      orderId: typeof confirmation.venueOrderId === "string" && confirmation.venueOrderId
        ? confirmation.venueOrderId
        : pendingResult.orderId,
      status: confirmed ? "filled" : "unexpected_fill_count",
      fillCount,
      fillPrice,
      fee: typeof confirmation.fee === "number" ? confirmation.fee : pendingResult.fee ?? null,
      exchangeTimestampMs: typeof confirmation.exchangeTimestampMs === "number" ? confirmation.exchangeTimestampMs : pendingResult.exchangeTimestampMs ?? null,
      respondedAt: receivedAtMs == null ? pendingResult.respondedAt : new Date(receivedAtMs).toISOString(),
      error: confirmed ? null : typeof confirmation.reason === "string" ? confirmation.reason : "Polymarket private stream reported fill mismatch",
      metadata: {
        ...(pendingResult.metadata ?? {}),
        resolvedFromPrivateStreamConfirmation: true,
        privateStreamEventType: confirmation.eventType ?? null,
      },
    };
  }

  private pendingVenueResult(venue: Venue, clientOrderId: string, submittedAtMs: number): VenueOrderResult {
    return {
      venue,
      clientOrderId,
      orderId: null,
      status: "unknown",
      fillPrice: null,
      fillCount: null,
      requestedAt: new Date(submittedAtMs).toISOString(),
      respondedAt: new Date(submittedAtMs).toISOString(),
      error: null,
      metadata: {
        pendingFirstHedgeTriggerEvidence: true,
      },
    };
  }

  private async confirmVenueOrder(
    executionGroupId: string,
    result: VenueOrderResult,
    leg: ArbLeg,
    submittedAtMs: number,
    options: { firstLegTrigger?: boolean } = {},
  ): Promise<Record<string, unknown> | null> {
    if (!this.config.liveUserStreamsEnabled || !this.confirmationMonitor) return null;
    const confirmation = await this.confirmationMonitor.waitForVenueResult(result, {
      executionGroupId,
      expectedSize: this.config.liveOrderSize,
      leg,
      submittedAtMs,
      timeoutMs: this.confirmationTimeoutMs(result, options),
    });
    return this.confirmationRecord(confirmation, submittedAtMs);
  }

  private shouldWaitForPolymarketStreamAfterRest(result: VenueOrderResult): boolean {
    if (!this.config.liveUserStreamsEnabled || !this.confirmationMonitor) return false;
    if (this.isPolymarketFirstHedgeTriggerResult(result)) return false;
    if (result.fillCount != null) return false;
    const status = String(result.status ?? "").toLowerCase();
    if (["failed", "rejected", "canceled", "cancelled", "unfilled", "unexpected_fill_count"].includes(status)) return false;
    if (result.error && !isTimeoutOrUnknownResult(result)) return false;
    return true;
  }

  private async firstPolymarketHedgeTriggerEvidence(
    leg: ArbLeg,
    restPromise: Promise<VenueOrderResult>,
    confirmationPromise: Promise<Record<string, unknown> | null> | null,
    pendingResult: VenueOrderResult,
  ): Promise<{ trigger: PolymarketHedgeTriggerEvidence | null; restResult?: VenueOrderResult; confirmation?: Record<string, unknown> | null }> {
    let restResult: VenueOrderResult | undefined;
    let confirmation: Record<string, unknown> | null | undefined;
    let restRace: Promise<{ kind: "rest"; result: VenueOrderResult }> | null = restPromise.then((result) => ({ kind: "rest" as const, result }));
    let confirmationRace: Promise<{ kind: "confirmation"; record: Record<string, unknown> | null }> | null = confirmationPromise
      ? confirmationPromise.then((record) => ({ kind: "confirmation" as const, record }))
      : null;

    while (restRace || confirmationRace) {
      const raced = [restRace, confirmationRace].filter((promise): promise is NonNullable<typeof promise> => promise != null);
      const next = await Promise.race(raced);
      if (next.kind === "rest") {
        restRace = null;
        restResult = next.result;
        if (this.isPolymarketFirstHedgeTriggerResult(restResult)) {
          const respondedAtMs = Date.parse(restResult.respondedAt);
          const fillCount = restResult.fillCount ?? this.config.liveOrderSize;
          const isExact = Math.abs(fillCount - this.config.liveOrderSize) <= 0.000001;
          return {
            trigger: {
              result: {
                ...restResult,
                metadata: {
                  ...(restResult.metadata ?? {}),
                  ...this.polymarketHedgeTriggerMetadata("rest_response", fillCount),
                },
              },
              restResult,
              confirmation: confirmation ?? null,
              source: "rest_response",
              receivedAtMs: Number.isFinite(respondedAtMs) ? respondedAtMs : this.now(),
              fillCount,
              isExact,
            },
            restResult,
            confirmation: confirmation ?? null,
          };
        }
        if (!this.shouldWaitForPolymarketStreamAfterRest(restResult)) {
          return { trigger: null, restResult, confirmation: confirmation ?? null };
        }
        continue;
      }

      confirmationRace = null;
      confirmation = next.record;
      if (confirmation && this.isPolymarketFirstHedgeTriggerConfirmation(confirmation)) {
        const confirmed = this.polymarketResultFromHedgeTriggerConfirmation(pendingResult, confirmation, leg);
        const parsedRespondedAt = Date.parse(confirmed.respondedAt);
        const receivedAtMs = typeof confirmation?.receivedAtMs === "number" && Number.isFinite(confirmation.receivedAtMs)
          ? confirmation.receivedAtMs
          : Number.isFinite(parsedRespondedAt) ? parsedRespondedAt : this.now();
        const fillCount = confirmed.fillCount ?? this.config.liveOrderSize;
        const isExact = Math.abs(fillCount - this.config.liveOrderSize) <= 0.000001;
        return {
          trigger: {
            result: {
              ...confirmed,
              metadata: {
                ...(confirmed.metadata ?? {}),
                ...this.polymarketHedgeTriggerMetadata("private_stream", fillCount),
              },
            },
            restResult: restResult ?? pendingResult,
            confirmation,
            source: "private_stream",
            receivedAtMs,
            fillCount,
            isExact,
          },
          restResult,
          confirmation,
        };
      }
      if (confirmation && ["failed", "mismatch"].includes(String(confirmation.status))) {
        return { trigger: null, restResult, confirmation };
      }
      if (confirmation && confirmation.status !== "not_required" && restResult) {
        return { trigger: null, restResult, confirmation };
      }
    }

    return { trigger: null, restResult, confirmation: confirmation ?? null };
  }

  private mergePolymarketHedgeTriggerEvidence(evidence: PolymarketHedgeTriggerEvidence, restResult: VenueOrderResult): VenueOrderResult {
    if (evidence.source === "rest_response") return evidence.result;
    return {
      ...restResult,
      clientOrderId: evidence.result.clientOrderId || restResult.clientOrderId,
      orderId: evidence.result.orderId ?? restResult.orderId,
      status: evidence.result.status,
      fillPrice: evidence.result.fillPrice,
      fillCount: evidence.result.fillCount,
      respondedAt: evidence.result.respondedAt,
      error: evidence.result.error,
      fee: evidence.result.fee ?? restResult.fee ?? null,
      exchangeTimestampMs: evidence.result.exchangeTimestampMs ?? restResult.exchangeTimestampMs ?? null,
      metadata: {
        ...(restResult.metadata ?? {}),
        ...(evidence.result.metadata ?? {}),
        polymarketRestStatusAfterStreamTrigger: restResult.status,
        polymarketRestErrorAfterStreamTrigger: restResult.error,
      },
    };
  }

  private async confirmVenueOrders(
    executionGroupId: string,
    orders: Array<{ result: VenueOrderResult; leg: ArbLeg; submittedAtMs: number }>,
  ): Promise<VenueConfirmations | null> {
    if (!this.config.liveUserStreamsEnabled || !this.confirmationMonitor) return null;
    const entries = await Promise.all(orders.map(async ({ result, leg, submittedAtMs }) => {
      const confirmation = await this.confirmVenueOrder(executionGroupId, result, leg, submittedAtMs);
      return [result.venue, confirmation] as const;
    }));
    return Object.fromEntries(entries);
  }

  private confirmationTimeoutMs(result: VenueOrderResult, options: { firstLegTrigger?: boolean } = {}): number {
    const base = Math.max(1, this.config.liveUserStreamConfirmTimeoutMs);
    // The first-leg hedge-trigger confirmation waits on a still-pending ("unknown") result by construction,
    // so it must NOT inherit the final-recovery extension — that turned the leg1->leg2 one-sided window into
    // a ~5500ms stall on the no-in-range-fill branch. base (2500) stays above the measured confirmation p99
    // (2072ms), so no real in-range fill is cut; a genuinely late/ambiguous fill is still reconciled by the
    // final post-submit confirmation (which keeps the recovery extension below).
    if (options.firstLegTrigger) return base;
    if (isTimeoutOrUnknownResult(result)) return base + Math.max(0, this.config.liveFinalRecoveryTimeoutMs);
    return base;
  }

  private confirmationRecord(confirmation: VenueConfirmationResult, submittedAtMs: number): Record<string, unknown> {
    const receivedAtMs = confirmation.receivedAtMs;
    const confirmationMs = receivedAtMs != null && Number.isFinite(receivedAtMs) && Number.isFinite(submittedAtMs)
      ? Math.max(0, receivedAtMs - submittedAtMs)
      : null;
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
      confirmationMs,
      eventType: confirmation.eventType,
    };
  }

  private applyVenueConfirmations(
    kalshi: VenueOrderResult,
    polymarket: VenueOrderResult,
    confirmations: VenueConfirmations | null,
    kalshiLeg: ArbLeg,
    polymarketLeg: ArbLeg,
  ): { kalshi: VenueOrderResult; polymarket: VenueOrderResult } {
    return {
      kalshi: this.applyVenueConfirmation(kalshi, confirmations?.kalshi, kalshiLeg),
      polymarket: this.applyVenueConfirmation(polymarket, confirmations?.polymarket, polymarketLeg),
    };
  }

  private applyVenueConfirmation(result: VenueOrderResult, confirmation: Record<string, unknown> | null | undefined, leg: ArbLeg): VenueOrderResult {
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
      fillPrice: typeof confirmation.fillPrice === "number"
        ? economicFillPriceForLeg(result.venue, leg.direction, confirmation.fillPrice, leg.ask)
        : result.fillPrice,
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

  private postTradeFailureClassification(
    kalshi: VenueOrderResult,
    polymarket: VenueOrderResult,
    partialFill: boolean,
    realizedGuaranteedProfit: number | null,
    metadata: ExecutionMetadata,
  ): Record<string, unknown> | null {
    const combined = `${kalshi.status} ${kalshi.error ?? ""} ${polymarket.status} ${polymarket.error ?? ""}`.toLowerCase();
    const kalshiFillCount = kalshi.fillCount ?? 0;
    const polymarketFillCount = polymarket.fillCount ?? 0;
    const quoteFailure = metadata.quoteSnapshot?.failureReason ?? null;
    let category: string | null = null;
    if (combined.includes("insufficient_balance") || combined.includes("below required operating cash") || combined.includes("below required hedge collateral")) {
      category = "insufficient_balance";
    } else if (combined.includes("timeout") || kalshi.status === "unknown" || polymarket.status === "unknown") {
      category = "timeout_or_unknown";
    } else if (partialFill || kalshiFillCount !== polymarketFillCount) {
      category = "liquidity_or_partial_fill";
    } else if (realizedGuaranteedProfit != null && realizedGuaranteedProfit + 1e-9 < this.config.minProfitDollars) {
      category = "negative_or_below_threshold_realized_edge";
    } else if (quoteFailure || combined.includes("stale") || combined.includes("quote")) {
      category = "stale_quote_or_edge_gate";
    } else if (combined.includes("failed") || combined.includes("rejected")) {
      category = "exchange_reject";
    }
    if (!category) return null;
    return {
      category,
      kalshiStatus: kalshi.status,
      polymarketStatus: polymarket.status,
      kalshiFillCount,
      polymarketFillCount,
      kalshiError: kalshi.error ?? null,
      polymarketError: polymarket.error ?? null,
      quoteFailure,
      classifiedAt: new Date(this.now()).toISOString(),
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
    // C1 (default-off): before committing to quarantine/hardlock, try to flatten a one-sided fill with a
    // loss-bounded opposing order. Guarded by liveAutoUnwindEnabled so the default path below is unchanged.
    const oneSidedFill = kalshiHasFill !== polymarketHasFill;
    let autoUnwind: VenueUnwindOutcome | null = null;
    if (this.config.liveAutoUnwindEnabled && oneSidedFill && metadata.unwindLegs) {
      autoUnwind = await this.attemptAutoUnwind(kalshi, polymarket, metadata.unwindLegs);
    }
    const autoUnwindFlattened = autoUnwind?.flattened === true;
    // A stream-confirmation timeout/failed is only a SAFETY event if a fill could be left unconfirmed. When
    // BOTH legs ended in a definitive terminal no-fill status there is no exposure to protect, so a transient
    // Polymarket WS drop must NOT engage a critical circuit breaker — downgrade it to a clean zero-exposure
    // miss. Any fill, size mismatch, or ambiguous (unknown/order-timeout) result is NOT provably flat and
    // still locks for reconciliation. Reversible via LIVE_CONFIRMATION_FLAT_MISS_NONBLOCKING.
    const provablyNoExposure = this.config.liveConfirmationFlatMissNonBlocking
      && isDefinitiveNoFill(kalshi)
      && isDefinitiveNoFill(polymarket);
    const initialLiveLockReason = autoUnwindFlattened || provablyNoExposure
      ? null
      : this.confirmationLockReason(metadata.venueConfirmations)
        ?? this.liveLockReason(partialFill, realizedGuaranteedProfit, kalshi, polymarket, Boolean(metadata.riskHedge), metadata.hedgeFailureReason);
    const riskQuarantine = autoUnwindFlattened || provablyNoExposure
      ? null
      : await this.riskQuarantineDecision(initialLiveLockReason, kalshi, polymarket, metadata.venueConfirmations);
    const liveLockReason = riskQuarantine ? null : initialLiveLockReason;
    const recoveryEvidencePresent = this.hasRecoveryEvidence(kalshi, venueConfirmations.kalshi)
      || this.hasRecoveryEvidence(polymarket, venueConfirmations.polymarket)
      || metadata.recoveryStatus === "pretrade_retry";
    const recoveryStatus = metadata.recoveryStatus
      ?? (riskQuarantine ? "risk_quarantined" : this.recoveryStatusForResult(liveLockReason, exactPairFilled, hasAnyFill, recoveryEvidencePresent));
    const failureClassification = this.postTradeFailureClassification(kalshi, polymarket, partialFill, realizedGuaranteedProfit, metadata);
    const baseRecoveryEvidence = metadata.recoveryEvidence
      ?? (recoveryEvidencePresent ? this.recoveryEvidenceFor(kalshi, polymarket, venueConfirmations) : null);
    const autoUnwindEvidence = autoUnwind
      ? {
        autoUnwind: {
          attempted: true,
          flattened: autoUnwind.flattened,
          lossDollars: autoUnwind.lossDollars ?? null,
          reason: autoUnwind.reason ?? null,
        },
      }
      : null;
    const recoveryEvidence = (failureClassification || autoUnwindEvidence)
      ? { ...(baseRecoveryEvidence ?? {}), ...(autoUnwindEvidence ?? {}), ...(failureClassification ? { failureClassification } : {}) }
      : baseRecoveryEvidence;
    const finalizationMs = metadata.finalizationMs ?? metadata.executionTimings?.totalMs ?? null;
    const autoResolution = this.autoResolution(recoveryStatus, executionGroupId, recoveryEvidence);
    if (liveLockReason && this.config.liveAutoHardlocksEnabled) this.partialFillLocked = true;
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
      leadLagSnapshot: metadata.leadLagSnapshot ?? metadata.quoteSnapshot?.leadLagSnapshot ?? null,
      fillQualitySnapshot: metadata.fillQualitySnapshot ?? null,
      expectedExecutableEdge: metadata.expectedExecutableEdge ?? metadata.fillQualitySnapshot?.expectedExecutableEdge ?? null,
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
    if (liveLockReason && this.config.liveAutoHardlocksEnabled) {
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
          leadLagSnapshot: metadata.leadLagSnapshot ?? metadata.quoteSnapshot?.leadLagSnapshot ?? null,
          fillQualitySnapshot: metadata.fillQualitySnapshot ?? null,
          expectedExecutableEdge: metadata.expectedExecutableEdge ?? metadata.fillQualitySnapshot?.expectedExecutableEdge ?? null,
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
      polymarketExactEvidenceSource?: string | null;
      polymarketExactEvidenceAtMs?: number | null;
      polymarketHedgeTriggerSource?: string | null;
      polymarketHedgeTriggerAtMs?: number | null;
      polymarketHedgeTriggerFillCount?: number | null;
      polymarketHedgeTriggerMinFillShares?: number | null;
      polymarketHedgeTriggerMaxFillShares?: number | null;
      polymarketHedgeTriggerExact?: boolean | null;
      firstVenue?: Venue | null;
      firstVenueReason?: string | null;
      firstVenueVwap?: number | null;
      hotGateStartedAt?: number;
      hotGateCompletedAt?: number;
      venueConfirmations?: VenueConfirmations | null;
      parallelDispatchAtMs?: number | null;
      parallelDispatchCallSkewMs?: number | null;
      parallelSettledAtMs?: number | null;
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
    const metadataNumber = (value: unknown): number | null => (
      typeof value === "number" && Number.isFinite(value) ? value : null
    );
    const polymarketPostOrderMs = metadataNumber(polymarket?.metadata?.polymarketPostOrderMs);
    const polymarketConfirmationMs = metadataNumber(metadata.venueConfirmations?.polymarket?.confirmationMs);
    const kalshiPrearmAgeMs = metadataNumber(kalshi?.metadata?.kalshiPrearmAgeMs);
    const kalshiPrearmMs = metadataNumber(kalshi?.metadata?.kalshiPrearmMs);
    const kalshiPricePatchMs = metadataNumber(kalshi?.metadata?.kalshiPricePatchMs);
    const polymarketExactEvidenceAtMs = metadata.polymarketExactEvidenceAtMs ?? null;
    const polyExactToKalshiSubmitMs = polymarketExactEvidenceAtMs != null && kalshiRequestedAt != null
      ? Math.max(0, kalshiRequestedAt - polymarketExactEvidenceAtMs)
      : null;
    const polymarketHedgeTriggerAtMs = metadata.polymarketHedgeTriggerAtMs ?? polymarketExactEvidenceAtMs;
    const polyHedgeTriggerToKalshiSubmitMs = polymarketHedgeTriggerAtMs != null && kalshiRequestedAt != null
      ? Math.max(0, kalshiRequestedAt - polymarketHedgeTriggerAtMs)
      : null;
    return {
      candidateToSubmitMs: Math.max(0, (firstRequestedAt ?? startedAt) - startedAt),
      hotGateMs,
      kalshiPrearmMs,
      kalshiPrearmAgeMs,
      kalshiPricePatchMs,
      polyExactToKalshiSubmitMs,
      polymarketExactEvidenceSource: metadata.polymarketExactEvidenceSource ?? null,
      polymarketExactEvidenceAtMs,
      polyHedgeTriggerToKalshiSubmitMs,
      polymarketHedgeTriggerSource: metadata.polymarketHedgeTriggerSource ?? metadata.polymarketExactEvidenceSource ?? null,
      polymarketHedgeTriggerAtMs,
      polymarketHedgeTriggerFillCount: metadata.polymarketHedgeTriggerFillCount ?? null,
      polymarketHedgeTriggerMinFillShares: metadata.polymarketHedgeTriggerMinFillShares ?? null,
      polymarketHedgeTriggerMaxFillShares: metadata.polymarketHedgeTriggerMaxFillShares ?? null,
      polymarketHedgeTriggerExact: metadata.polymarketHedgeTriggerExact ?? null,
      polymarketSignMs: polymarket?.signMs ?? null,
      polymarketPostOrderMs,
      polymarketConfirmationMs,
      preflightMs,
      kalshiRttMs: kalshiOrderRttMs,
      polymarketRttMs: polymarketOrderRttMs,
      kalshiOrderRttMs,
      postFillHedgeDecisionMs: metadata.postFillHedgeDecisionMs ?? null,
      polymarketOrderRttMs,
      venueSubmitSkewMs,
      parallelDispatchAtMs: metadata.parallelDispatchAtMs ?? null,
      parallelDispatchCallSkewMs: metadata.parallelDispatchCallSkewMs ?? null,
      parallelSettledAtMs: metadata.parallelSettledAtMs ?? null,
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
