import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { loadConfig } from "../config";
import { getKalshiHeaders } from "../kalshi/auth";
import type { ArbCandidate, ArbLeg, ExecutionResult } from "../types";

export interface ArbExecutor {
  execute(candidate: ArbCandidate): Promise<ExecutionResult>;
}

function fillPriceForVenue(candidate: ArbCandidate, venue: "kalshi" | "polymarket"): number | null {
  if (candidate.lower.venue === venue) return candidate.lower.ask;
  if (candidate.higher.venue === venue) return candidate.higher.ask;
  return null;
}

function legForVenue(candidate: ArbCandidate, venue: "kalshi" | "polymarket"): ArbLeg | null {
  if (candidate.lower.venue === venue) return candidate.lower;
  if (candidate.higher.venue === venue) return candidate.higher;
  return null;
}

export class DryRunExecutor implements ArbExecutor {
  async execute(candidate: ArbCandidate): Promise<ExecutionResult> {
    return {
      action: "filled",
      failureReason: null,
      kalshiFillId: `dry-run-kalshi-${Date.now()}`,
      polymarketFillId: `dry-run-polymarket-${Date.now()}`,
      kalshiFillPrice: fillPriceForVenue(candidate, "kalshi"),
      polymarketFillPrice: fillPriceForVenue(candidate, "polymarket"),
    };
  }
}

export class LiveExecutor implements ArbExecutor {
  constructor(private readonly config: AppConfig = loadConfig()) {}

  async execute(candidate: ArbCandidate): Promise<ExecutionResult> {
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
    return {
      action: "failed",
      failureReason: reason,
      kalshiFillId: null,
      polymarketFillId: null,
      kalshiFillPrice: null,
      polymarketFillPrice: null,
    };
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
