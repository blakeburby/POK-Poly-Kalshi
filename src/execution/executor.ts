import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import { getKalshiHeaders } from "../kalshi/auth";
import { protectedCandidateBlockReason } from "../scanner/safety";
import type { ArbCandidate, ArbLeg, ExecutionResult } from "../types";

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

export class LiveExecutor implements ArbExecutor {
  constructor(private readonly config: AppConfig = loadConfig()) {}

  async execute(candidate: ArbCandidate): Promise<ExecutionResult> {
    const guardFailure = protectedGuardFailure(candidate, this.config.minProfitDollars);
    if (guardFailure) return guardFailure;
    const kalshiLeg = legForVenue(candidate, "kalshi");
    const polymarketLeg = legForVenue(candidate, "polymarket");
    if (!kalshiLeg || !polymarketLeg) return this.failed("candidate must contain one Kalshi leg and one Polymarket leg");
    if (!this.config.polymarketOrderEndpoint) return this.failed("POLYMARKET_ORDER_ENDPOINT is required for live trading");

    const [kalshi, polymarket] = await Promise.allSettled([
      this.placeKalshiOrder(kalshiLeg),
      this.placePolymarketOrder(polymarketLeg),
    ]);

    const kalshiFillId = kalshi.status === "fulfilled" ? kalshi.value.fillId : null;
    const kalshiFillPrice = kalshi.status === "fulfilled" ? kalshi.value.fillPrice : null;
    const polymarketFillId = polymarket.status === "fulfilled" ? polymarket.value.fillId : null;
    const polymarketFillPrice = polymarket.status === "fulfilled" ? polymarket.value.fillPrice : null;
    if (kalshi.status === "fulfilled" && polymarket.status === "fulfilled") {
      return { action: "filled", failureReason: null, kalshiFillId, polymarketFillId, kalshiFillPrice, polymarketFillPrice };
    }

    const reasons = [kalshi, polymarket]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    return {
      action: "failed",
      failureReason: reasons.join("; "),
      kalshiFillId,
      polymarketFillId,
      kalshiFillPrice,
      polymarketFillPrice,
    };
  }

  private failed(reason: string): ExecutionResult {
    return failed(reason);
  }

  private async placeKalshiOrder(leg: ArbLeg): Promise<{ fillId: string; fillPrice: number }> {
    const url = new URL(this.config.kalshiApiBase);
    const basePath = url.pathname.replace(/\/$/, "");
    url.pathname = `${basePath}/portfolio/orders`;
    const signPath = `${url.pathname}${url.search}`;
    const clientOrderId = randomUUID();
    const body = {
      ticker: leg.contractId,
      action: "buy",
      side: leg.direction,
      count: 1,
      type: "market",
      client_order_id: clientOrderId,
    };
    const response = await fetch(url, {
      method: "POST",
      headers: { ...getKalshiHeaders("POST", signPath), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Kalshi order failed ${response.status}: ${await response.text()}`);
    const payload = await response.json() as { order?: { order_id?: string; id?: string; yes_price?: number; no_price?: number } };
    const order = payload.order ?? {};
    return {
      fillId: order.order_id ?? order.id ?? clientOrderId,
      fillPrice: leg.direction === "yes" ? Number(order.yes_price ?? leg.ask) : Number(order.no_price ?? leg.ask),
    };
  }

  private async placePolymarketOrder(leg: ArbLeg): Promise<{ fillId: string; fillPrice: number }> {
    if (!leg.tokenId) throw new Error("Polymarket token id is required for live trading");
    const response = await fetch(this.config.polymarketOrderEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.polymarketApiKey ? { Authorization: `Bearer ${this.config.polymarketApiKey}` } : {}),
      },
      body: JSON.stringify({
        tokenId: leg.tokenId,
        contractId: leg.contractId,
        outcome: leg.direction,
        side: "BUY",
        price: leg.ask,
        size: 1,
      }),
    });
    if (!response.ok) throw new Error(`Polymarket order failed ${response.status}: ${await response.text()}`);
    const payload = await response.json() as { fillId?: string; orderId?: string; price?: number };
    return {
      fillId: payload.fillId ?? payload.orderId ?? randomUUID(),
      fillPrice: Number(payload.price ?? leg.ask),
    };
  }
}
