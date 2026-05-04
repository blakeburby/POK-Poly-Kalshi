import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import { protectedCandidateBlockReason } from "../scanner/safety";
import type { ArbCandidate, ArbLeg, BinaryContract, ExecutionResult, LiveExecutionLastAttempt, LiveExecutionReadiness, Venue, VenueExecutionReadiness } from "../types";
import {
  failedVenueResult,
  generatedClientOrderId,
  KalshiOrderClient,
  PolymarketOrderClient,
  type LiveOrderContext,
  type VenueOrderClient,
  type VenueOrderResult,
} from "./live-clients";

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
    partialFillLocked: false,
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
  ) {}

  async readiness(now = this.now()): Promise<LiveExecutionReadiness> {
    const [kalshi, polymarket] = await Promise.all([
      this.kalshiClient.readiness(now),
      this.polymarketClient.readiness(now),
    ]);
    return {
      mode: "live",
      liveTrading: this.config.liveTrading,
      protectedOnly: true,
      orderSize: this.config.liveOrderSize,
      orderType: this.config.polymarketOrderType,
      maxSlippageCents: this.config.liveMaxSlippageCents,
      minExpiryMs: this.config.liveMinExpiryMs,
      partialFillLocked: this.partialFillLocked,
      kalshi,
      polymarket,
      lastAttempt: this.lastAttempt,
    };
  }

  async execute(candidate: ArbCandidate): Promise<ExecutionResult> {
    const guardFailure = protectedGuardFailure(candidate, this.config.minProfitDollars);
    if (guardFailure) return guardFailure;
    if (this.partialFillLocked) return failed("live execution locked after partial fill; restart or operator review required before trading resumes");
    const kalshiLeg = legForVenue(candidate, "kalshi");
    const polymarketLeg = legForVenue(candidate, "polymarket");
    if (!kalshiLeg || !polymarketLeg) return this.failed("candidate must contain one Kalshi leg and one Polymarket leg");

    const prepared = this.prepareExecution(candidate, kalshiLeg, polymarketLeg);
    if (typeof prepared === "string") return skipped(prepared);

    const executionGroupId = `pok-${this.now()}`;
    const requestedAt = this.now();
    const kalshiClientOrderId = generatedClientOrderId("kalshi");
    const polymarketClientOrderId = generatedClientOrderId("polymarket");
    const [kalshi, polymarket] = await Promise.all([
      this.placeVenueOrder(this.kalshiClient, prepared.kalshi.leg, {
        executionGroupId,
        clientOrderId: kalshiClientOrderId,
        size: this.config.liveOrderSize,
        maxBuyPrice: prepared.kalshi.maxBuyPrice,
        requestedAt,
      }),
      this.placeVenueOrder(this.polymarketClient, prepared.polymarket.leg, {
        executionGroupId,
        clientOrderId: polymarketClientOrderId,
        size: this.config.liveOrderSize,
        maxBuyPrice: prepared.polymarket.maxBuyPrice,
        requestedAt,
      }),
    ]);

    return this.resultFromVenueOrders(executionGroupId, kalshi, polymarket);
  }

  private failed(reason: string): ExecutionResult {
    return failed(reason);
  }

  private prepareExecution(candidate: ArbCandidate, kalshiLeg: ArbLeg, polymarketLeg: ArbLeg): PreparedExecution | string {
    const now = this.now();
    if (this.config.liveOrderSize !== 1) return "LIVE_ORDER_SIZE must remain 1 for the protected-spread canary";
    if (candidate.expiryMs - now < this.config.liveMinExpiryMs) return "candidate too close to expiry for live execution";
    const kalshi = this.prepareLeg(kalshiLeg, now);
    if (typeof kalshi === "string") return kalshi;
    const polymarket = this.prepareLeg(polymarketLeg, now);
    if (typeof polymarket === "string") return polymarket;
    const cappedGuaranteedProfit = 1 - (kalshi.maxBuyPrice + polymarket.maxBuyPrice);
    if (cappedGuaranteedProfit < this.config.minProfitDollars) {
      return `capped live edge ${cappedGuaranteedProfit.toFixed(4)} below threshold ${this.config.minProfitDollars.toFixed(4)}`;
    }
    return { kalshi, polymarket };
  }

  private prepareLeg(leg: ArbLeg, now: number): PreparedLeg | string {
    const current = this.currentAsk(leg);
    if (!current) return `${leg.venue} contract ${leg.contractId} is missing from live book preflight`;
    if (now - current.updatedAt > this.config.staleBookMs) return `${leg.venue} contract ${leg.contractId} is stale`;
    const currentAsk = leg.direction === "yes" ? current.yesAsk : current.noAsk;
    if (currentAsk == null || !Number.isFinite(currentAsk)) return `${leg.venue} ${leg.direction} ask is unavailable`;
    const maxBuyPrice = roundPrice(Math.min(1, currentAsk + this.config.liveMaxSlippageCents / 100));
    if (currentAsk > leg.ask + this.config.liveMaxSlippageCents / 100) {
      return `${leg.venue} ${leg.direction} ask moved beyond live slippage cap`;
    }
    return { leg: { ...leg, ask: currentAsk }, maxBuyPrice };
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
      return await client.placeOrder(leg, context);
    } catch (error) {
      return failedVenueResult(client.venue, context.clientOrderId, error, context.requestedAt ?? this.now());
    }
  }

  private resultFromVenueOrders(executionGroupId: string, kalshi: VenueOrderResult, polymarket: VenueOrderResult): ExecutionResult {
    const kalshiFilled = (kalshi.fillCount ?? 0) >= this.config.liveOrderSize;
    const polymarketFilled = (polymarket.fillCount ?? 0) >= this.config.liveOrderSize;
    const partialFill = kalshiFilled !== polymarketFilled || (kalshiFilled && polymarketFilled && (
      Math.abs((kalshi.fillCount ?? 0) - this.config.liveOrderSize) > 0.000001
      || Math.abs((polymarket.fillCount ?? 0) - this.config.liveOrderSize) > 0.000001
    ));
    if (partialFill) this.partialFillLocked = true;
    const failureReason = [kalshi, polymarket]
      .filter((result) => result.error || (result.fillCount ?? 0) < this.config.liveOrderSize)
      .map((result) => `${result.venue}: ${result.error ?? result.status}`)
      .join("; ") || null;
    const action = kalshiFilled && polymarketFilled && !partialFill ? "filled" : "failed";
    this.lastAttempt = {
      executionGroupId,
      action,
      partialFill,
      failureReason,
      kalshiStatus: kalshi.status,
      polymarketStatus: polymarket.status,
      completedAt: this.now(),
    };
    return {
      action,
      failureReason: partialFill ? `partial fill lock engaged${failureReason ? `; ${failureReason}` : ""}` : failureReason,
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
    };
  }
}
