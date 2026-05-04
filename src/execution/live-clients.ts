import { createHash, randomUUID } from "node:crypto";
import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type BalanceAllowanceResponse,
  type OrderBookSummary,
  type SignedOrder,
  type TickSize,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config";
import { getKalshiHeaders } from "../kalshi/auth";
import type { ArbLeg, Venue, VenueExecutionReadiness } from "../types";

export interface LiveOrderContext {
  executionGroupId: string;
  clientOrderId: string;
  size: number;
  maxBuyPrice: number;
  requestedAt?: number;
}

export interface VenueOrderResult {
  venue: Venue;
  clientOrderId: string;
  orderId: string | null;
  status: string;
  fillPrice: number | null;
  fillCount: number | null;
  requestedAt: string;
  respondedAt: string;
  error: string | null;
}

export interface VenueOrderClient {
  readonly venue: Venue;
  placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult>;
  readiness(now?: number): Promise<VenueExecutionReadiness>;
}

export interface PolymarketClobLike {
  getOrderBook(tokenID: string): Promise<Pick<OrderBookSummary, "min_order_size" | "tick_size" | "neg_risk">>;
  createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }, options: { tickSize: TickSize; negRisk?: boolean }): Promise<SignedOrder>;
  postOrder(order: SignedOrder, orderType?: OrderType): Promise<unknown>;
  getBalanceAllowance(params?: { asset_type: AssetType; token_id?: string }): Promise<BalanceAllowanceResponse>;
}

function isoFromMs(value: number): string {
  return new Date(value).toISOString();
}

function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fixedDollars(value: number): string {
  return Math.max(0, Math.min(1, value)).toFixed(4);
}

function fixedCount(value: number): string {
  return Math.max(0, value).toFixed(2);
}

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/0x[a-fA-F0-9]{32,}/g, "0x[redacted]").slice(0, 500);
}

function configuredReadiness(configured: boolean, reason: string | null, now: number): VenueExecutionReadiness {
  return {
    configured,
    ready: configured && reason == null,
    reason,
    balance: null,
    allowance: null,
    lastCheckedAt: now,
  };
}

function requireKalshiConfigured(now: number): VenueExecutionReadiness {
  const hasKeyId = Boolean(process.env.KALSHI_API_KEY_ID?.trim());
  const hasPrivateKey = Boolean(process.env.KALSHI_PRIVATE_KEY?.trim() || process.env.KALSHI_PRIVATE_KEY_B64?.trim());
  if (!hasKeyId || !hasPrivateKey) {
    return configuredReadiness(false, "KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY are required", now);
  }
  return configuredReadiness(true, null, now);
}

export function buildKalshiV2OrderBody(leg: ArbLeg, context: LiveOrderContext): Record<string, string | boolean> {
  const isYes = leg.direction === "yes";
  const yesBookPrice = isYes ? context.maxBuyPrice : 1 - context.maxBuyPrice;
  return {
    ticker: leg.contractId,
    client_order_id: context.clientOrderId,
    side: isYes ? "bid" : "ask",
    count: fixedCount(context.size),
    price: fixedDollars(yesBookPrice),
    time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
    cancel_order_on_pause: true,
    order_group_id: context.executionGroupId,
  };
}

export class KalshiOrderClient implements VenueOrderClient {
  readonly venue = "kalshi" as const;

  constructor(private readonly config: AppConfig, private readonly fetchFn: typeof fetch = fetch) {}

  async readiness(now = Date.now()): Promise<VenueExecutionReadiness> {
    return requireKalshiConfigured(now);
  }

  async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
    const readiness = await this.readiness(context.requestedAt ?? Date.now());
    if (!readiness.ready) throw new Error(readiness.reason ?? "Kalshi execution is not configured");

    const requestedAt = context.requestedAt ?? Date.now();
    const url = new URL(this.config.kalshiApiBase);
    const basePath = url.pathname.replace(/\/$/, "");
    url.pathname = `${basePath}/portfolio/events/orders`;
    const signPath = `${url.pathname}${url.search}`;
    const body = buildKalshiV2OrderBody(leg, context);
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { ...getKalshiHeaders("POST", signPath), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const respondedAt = Date.now();
    const text = await response.text();
    const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok) throw new Error(`Kalshi order failed ${response.status}: ${sanitizeError(text)}`);

    const yesFillPrice = finiteOrNull(payload.average_fill_price);
    const fillPrice = yesFillPrice == null ? null : leg.direction === "yes" ? yesFillPrice : roundPrice(1 - yesFillPrice);
    const fillCount = finiteOrNull(payload.fill_count);
    return {
      venue: this.venue,
      clientOrderId: String(payload.client_order_id ?? context.clientOrderId),
      orderId: payload.order_id == null ? null : String(payload.order_id),
      status: fillCount != null && fillCount >= context.size ? "filled" : "unfilled",
      fillPrice,
      fillCount,
      requestedAt: isoFromMs(requestedAt),
      respondedAt: isoFromMs(respondedAt),
      error: null,
    };
  }
}

function normalizePrivateKey(privateKey: string): `0x${string}` {
  const trimmed = privateKey.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

function chainFromConfig(chainId: number): Chain {
  if (chainId === Chain.AMOY) return Chain.AMOY;
  return Chain.POLYGON;
}

function viemChainFromConfig(chainId: number) {
  return chainId === Chain.AMOY ? polygonAmoy : polygon;
}

function signatureTypeFromConfig(value: number): SignatureTypeV2 {
  if (value === SignatureTypeV2.POLY_PROXY) return SignatureTypeV2.POLY_PROXY;
  if (value === SignatureTypeV2.POLY_GNOSIS_SAFE) return SignatureTypeV2.POLY_GNOSIS_SAFE;
  if (value === SignatureTypeV2.POLY_1271) return SignatureTypeV2.POLY_1271;
  return SignatureTypeV2.EOA;
}

function polymarketOrderType(value: string): OrderType.FOK | OrderType.FAK {
  return value === "FAK" ? OrderType.FAK : OrderType.FOK;
}

function metadataFromClientOrderId(clientOrderId: string): `0x${string}` {
  return `0x${createHash("sha256").update(clientOrderId).digest("hex")}` as `0x${string}`;
}

async function defaultPolymarketClientFactory(config: AppConfig): Promise<PolymarketClobLike> {
  if (!config.polymarketPrivateKey) throw new Error("POLYMARKET_PRIVATE_KEY is required for live trading");
  const account = privateKeyToAccount(normalizePrivateKey(config.polymarketPrivateKey));
  const walletClient = createWalletClient({
    account,
    chain: viemChainFromConfig(config.polymarketChainId),
    transport: http(),
  });
  const chain = chainFromConfig(config.polymarketChainId);
  const signatureType = signatureTypeFromConfig(config.polymarketSignatureType);
  const funderAddress = config.polymarketFunderAddress || undefined;
  if (signatureType !== SignatureTypeV2.EOA && !funderAddress) {
    throw new Error("POLYMARKET_FUNDER_ADDRESS is required for proxy/safe signatures");
  }
  const l1Client = new ClobClient({
    host: config.polymarketClobHost,
    chain,
    signer: walletClient,
    signatureType,
    funderAddress,
    throwOnError: true,
  });
  const creds = await l1Client.createOrDeriveApiKey();
  return new ClobClient({
    host: config.polymarketClobHost,
    chain,
    signer: walletClient,
    creds,
    signatureType,
    funderAddress,
    throwOnError: true,
  });
}

export class PolymarketOrderClient implements VenueOrderClient {
  readonly venue = "polymarket" as const;
  private clientPromise: Promise<PolymarketClobLike> | null = null;
  private cachedReadiness: VenueExecutionReadiness | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly clientFactory: (config: AppConfig) => Promise<PolymarketClobLike> = defaultPolymarketClientFactory,
  ) {}

  async readiness(now = Date.now()): Promise<VenueExecutionReadiness> {
    if (this.cachedReadiness && now - (this.cachedReadiness.lastCheckedAt ?? 0) < 30_000) return this.cachedReadiness;
    if (!this.config.polymarketPrivateKey) {
      this.cachedReadiness = configuredReadiness(false, "POLYMARKET_PRIVATE_KEY is required", now);
      return this.cachedReadiness;
    }
    try {
      const balanceAllowance = await (await this.client()).getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const balance = finiteOrNull(balanceAllowance.balance);
      const allowance = finiteOrNull(balanceAllowance.allowance);
      this.cachedReadiness = {
        configured: true,
        ready: true,
        reason: null,
        balance,
        allowance,
        lastCheckedAt: now,
      };
    } catch (error) {
      this.cachedReadiness = {
        configured: true,
        ready: false,
        reason: sanitizeError(error),
        balance: null,
        allowance: null,
        lastCheckedAt: now,
      };
    }
    return this.cachedReadiness;
  }

  async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
    if (!leg.tokenId) throw new Error("Polymarket token id is required for live trading");
    const requestedAt = context.requestedAt ?? Date.now();
    const client = await this.client();
    const book = await client.getOrderBook(leg.tokenId);
    const minOrderSize = finiteOrNull(book.min_order_size);
    if (minOrderSize != null && minOrderSize > context.size) {
      throw new Error(`Polymarket min order size ${minOrderSize} exceeds configured live order size ${context.size}`);
    }

    const signedOrder = await client.createOrder({
      tokenID: leg.tokenId,
      price: roundPrice(context.maxBuyPrice),
      size: context.size,
      side: Side.BUY,
      metadata: metadataFromClientOrderId(context.clientOrderId),
    }, {
      tickSize: book.tick_size as TickSize,
      negRisk: Boolean(book.neg_risk),
    });
    const payload = await client.postOrder(signedOrder, polymarketOrderType(this.config.polymarketOrderType));
    const respondedAt = Date.now();
    const response = payload as Record<string, unknown>;
    if (response.success === false) throw new Error(`Polymarket order failed: ${sanitizeError(response.errorMsg ?? response.error ?? "unknown")}`);

    const fillCount = finiteOrNull(response.takingAmount) ?? context.size;
    const makingAmount = finiteOrNull(response.makingAmount);
    const fillPrice = makingAmount != null && fillCount != null && fillCount > 0 ? roundPrice(makingAmount / fillCount) : context.maxBuyPrice;
    return {
      venue: this.venue,
      clientOrderId: context.clientOrderId,
      orderId: response.orderID == null ? null : String(response.orderID),
      status: String(response.status ?? (fillCount >= context.size ? "filled" : "unfilled")),
      fillPrice,
      fillCount,
      requestedAt: isoFromMs(requestedAt),
      respondedAt: isoFromMs(respondedAt),
      error: null,
    };
  }

  private client(): Promise<PolymarketClobLike> {
    this.clientPromise ??= this.clientFactory(this.config);
    return this.clientPromise;
  }
}

export function failedVenueResult(venue: Venue, clientOrderId: string, error: unknown, requestedAt: number): VenueOrderResult {
  return {
    venue,
    clientOrderId,
    orderId: null,
    status: "failed",
    fillPrice: null,
    fillCount: null,
    requestedAt: isoFromMs(requestedAt),
    respondedAt: isoFromMs(Date.now()),
    error: sanitizeError(error),
  };
}

export function generatedClientOrderId(venue: Venue): string {
  return `${venue}-${randomUUID()}`;
}
