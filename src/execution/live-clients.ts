import { createHash, randomUUID } from "node:crypto";
import {
  AssetType,
  type ApiKeyCreds,
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
  requiredCollateral?: number;
  requestedAt?: number;
  orderGroupId?: string;
  signal?: AbortSignal;
  preflight?: LiveOrderPreflight;
}

export interface LiveOrderPreflight {
  polymarketReadiness?: VenueExecutionReadiness;
  polymarketRequiredCollateral?: number;
  polymarketOrderBook?: Pick<OrderBookSummary, "min_order_size" | "tick_size" | "neg_risk">;
  polymarketSignedOrder?: SignedOrder;
  polymarketSignedOrderCreatedAt?: number;
  polymarketSignMs?: number;
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
  fee?: number | null;
  exchangeTimestampMs?: number | null;
  signMs?: number | null;
  metadata?: Record<string, unknown>;
}

export interface VenueOrderClient {
  readonly venue: Venue;
  preflightOrder?(leg: ArbLeg, context: LiveOrderContext): Promise<string | null>;
  placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult>;
  readiness(now?: number): Promise<VenueExecutionReadiness>;
  warm?(options?: { now?: number; tokenIds?: string[]; requiredCollateral?: number }): Promise<void>;
}

export interface PolymarketClobLike {
  getOrderBook(tokenID: string): Promise<Pick<OrderBookSummary, "min_order_size" | "tick_size" | "neg_risk">>;
  getTickSize?(tokenID: string): Promise<TickSize | string>;
  getNegRisk?(tokenID: string): Promise<boolean>;
  createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }, options: { tickSize: TickSize; negRisk?: boolean }): Promise<SignedOrder>;
  createMarketOrder?(order: { tokenID: string; price: number; amount: number; side: Side; orderType?: OrderType.FOK | OrderType.FAK; metadata?: string }, options: { tickSize: TickSize; negRisk?: boolean }): Promise<SignedOrder>;
  postOrder(order: SignedOrder, orderType?: OrderType, postOnly?: boolean, deferExec?: boolean): Promise<unknown>;
  cancelOrder?(payload: { orderID: string }): Promise<unknown>;
  getBalanceAllowance(params?: { asset_type: AssetType; token_id?: string }): Promise<BalanceAllowanceResponse>;
  updateBalanceAllowance(params?: { asset_type: AssetType; token_id?: string }): Promise<void>;
}

export type PolymarketCredentialsSource = "configured" | "derived" | "created";

export interface PolymarketGeoblockStatus {
  blocked: boolean | null;
  country: string | null;
  region: string | null;
  checkedAt: number;
  reason: string | null;
}

export type PolymarketGeoblockChecker = (now: number) => Promise<PolymarketGeoblockStatus>;

export interface PolymarketClobClientBundle {
  client: PolymarketClobLike;
  credentialsSource: PolymarketCredentialsSource;
  creds?: ApiKeyCreds;
}

export interface PolymarketApiKeyProvider {
  deriveApiKey(): Promise<ApiKeyCreds>;
  createApiKey(): Promise<ApiKeyCreds>;
}

function isoFromMs(value: number): string {
  return new Date(value).toISOString();
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedCollateralAmount(value: number | null): number | null {
  if (value == null) return null;
  return value > 10_000 ? value / 1_000_000 : value;
}

function maskAddress(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function checkPolymarketGeoblock(
  config: AppConfig,
  fetchFn: typeof fetch = fetch,
  now = Date.now(),
): Promise<PolymarketGeoblockStatus> {
  if (!config.polymarketGeoblockUrl) {
    return {
      blocked: null,
      country: null,
      region: null,
      checkedAt: now,
      reason: "POLYMARKET_GEOBLOCK_URL is required for live Polymarket readiness",
    };
  }

  try {
    const response = await fetchFn(config.polymarketGeoblockUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        blocked: null,
        country: null,
        region: null,
        checkedAt: now,
        reason: `Polymarket geoblock check failed ${response.status}: ${sanitizeError(text)}`,
      };
    }

    const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    const blocked = payload.blocked;
    const country = stringOrNull(payload.country);
    const region = stringOrNull(payload.region);
    if (typeof blocked !== "boolean") {
      return {
        blocked: null,
        country,
        region,
        checkedAt: now,
        reason: "Polymarket geoblock check did not return a boolean blocked field",
      };
    }

    return {
      blocked,
      country,
      region,
      checkedAt: now,
      reason: blocked ? "Polymarket CLOB trading blocked from worker egress" : null,
    };
  } catch (error) {
    return {
      blocked: null,
      country: null,
      region: null,
      checkedAt: now,
      reason: `Polymarket geoblock check failed: ${sanitizeError(error)}`,
    };
  }
}

function geoblockReadinessFields(status: PolymarketGeoblockStatus | null): Pick<
  VenueExecutionReadiness,
  "geoblockBlocked" | "geoblockCountry" | "geoblockRegion" | "geoblockCheckedAt"
> {
  return {
    geoblockBlocked: status?.blocked ?? null,
    geoblockCountry: status?.country ?? null,
    geoblockRegion: status?.region ?? null,
    geoblockCheckedAt: status?.checkedAt ?? null,
  };
}

async function withMutedPolymarketClientLogs<T>(operation: () => Promise<T>): Promise<T> {
  const originalError = console.error;
  const originalWarn = console.warn;
  const shouldMute = (args: unknown[]): boolean => String(args[0] ?? "").startsWith("[CLOB Client]");
  console.error = (...args: unknown[]) => {
    if (shouldMute(args)) return;
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (shouldMute(args)) return;
    originalWarn(...args);
  };
  try {
    return await operation();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
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
  const body: Record<string, string | boolean> = {
    ticker: leg.contractId,
    client_order_id: context.clientOrderId,
    side: isYes ? "bid" : "ask",
    count: fixedCount(context.size),
    price: fixedDollars(yesBookPrice),
    time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
    cancel_order_on_pause: true,
  };
  if (context.orderGroupId) body.order_group_id = context.orderGroupId;
  return body;
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
      signal: context.signal,
    });
    const respondedAt = Date.now();
    const text = await response.text();
    const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok) throw new Error(`Kalshi order failed ${response.status}: ${sanitizeError(text)}`);

    const yesFillPrice = finiteOrNull(payload.average_fill_price);
    const fillPrice = yesFillPrice == null ? null : leg.direction === "yes" ? yesFillPrice : roundPrice(1 - yesFillPrice);
    const fillCount = finiteOrNull(payload.fill_count);
    const fee = finiteOrNull(payload.average_fee_paid);
    const exchangeTimestampMs = finiteOrNull(payload.ts_ms);
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
      fee,
      exchangeTimestampMs,
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

export function polymarketApiCredsFromConfig(config: AppConfig): ApiKeyCreds | null {
  if (!config.polymarketApiKey || !config.polymarketApiSecret || !config.polymarketApiPassphrase) return null;
  return {
    key: config.polymarketApiKey,
    secret: config.polymarketApiSecret,
    passphrase: config.polymarketApiPassphrase,
  };
}

export async function deriveOrCreatePolymarketApiCreds(client: PolymarketApiKeyProvider): Promise<{ creds: ApiKeyCreds; source: "derived" | "created" }> {
  try {
    return { creds: await client.deriveApiKey(), source: "derived" };
  } catch (deriveError) {
    try {
      return { creds: await client.createApiKey(), source: "created" };
    } catch (createError) {
      throw new Error(`Could not derive or create api key: derive failed: ${sanitizeError(deriveError)}; create failed: ${sanitizeError(createError)}`);
    }
  }
}

function polymarketSignerAddress(config: AppConfig): string | null {
  if (!config.polymarketPrivateKey) return null;
  try {
    return privateKeyToAccount(normalizePrivateKey(config.polymarketPrivateKey)).address;
  } catch {
    return null;
  }
}

function polymarketOrderType(value: string): OrderType.FOK | OrderType.FAK {
  return value === "FAK" ? OrderType.FAK : OrderType.FOK;
}

function metadataFromClientOrderId(clientOrderId: string): `0x${string}` {
  return `0x${createHash("sha256").update(clientOrderId).digest("hex")}` as `0x${string}`;
}

function exactFillError(venue: Venue, fillCount: number | null, requestedSize: number): string | null {
  if (fillCount == null) return `${venue} fill count was not returned`;
  return Math.abs(fillCount - requestedSize) <= 0.000001
    ? null
    : `${venue} filled ${fillCount} shares for requested exact size ${requestedSize}`;
}

function polymarketMarketBuySpend(context: LiveOrderContext): number {
  return roundPrice(context.size * context.maxBuyPrice);
}

export async function resolvePolymarketApiCreds(config: AppConfig): Promise<{ creds: ApiKeyCreds; source: PolymarketCredentialsSource }> {
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
  const configuredCreds = polymarketApiCredsFromConfig(config);
  return configuredCreds
    ? { creds: configuredCreds, source: "configured" as const }
    : await withMutedPolymarketClientLogs(async () => {
      const l1Client = new ClobClient({
        host: config.polymarketClobHost,
        chain,
        signer: walletClient,
        signatureType,
        funderAddress,
        throwOnError: true,
      });
      return deriveOrCreatePolymarketApiCreds(l1Client);
    });
}

export async function defaultPolymarketClientFactory(config: AppConfig): Promise<PolymarketClobClientBundle> {
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
  const resolved = await resolvePolymarketApiCreds(config);
  return {
    client: new ClobClient({
      host: config.polymarketClobHost,
      chain,
      signer: walletClient,
      creds: resolved.creds,
      signatureType,
      funderAddress,
      throwOnError: true,
    }),
    credentialsSource: resolved.source,
    creds: resolved.creds,
  };
}

export class PolymarketOrderClient implements VenueOrderClient {
  readonly venue = "polymarket" as const;
  private clientPromise: Promise<PolymarketClobLike | PolymarketClobClientBundle> | null = null;
  private cachedReadiness: VenueExecutionReadiness | null = null;
  private readonly orderBookCache = new Map<string, { checkedAt: number; book: Pick<OrderBookSummary, "min_order_size" | "tick_size" | "neg_risk"> }>();

  constructor(
    private readonly config: AppConfig,
    private readonly clientFactory: (config: AppConfig) => Promise<PolymarketClobLike | PolymarketClobClientBundle> = defaultPolymarketClientFactory,
    private readonly geoblockChecker: PolymarketGeoblockChecker = (now) => checkPolymarketGeoblock(config, fetch, now),
  ) {}

  async readiness(now = Date.now()): Promise<VenueExecutionReadiness> {
    return this.checkReadiness(now);
  }

  async warm(options: { now?: number; tokenIds?: string[]; requiredCollateral?: number } = {}): Promise<void> {
    const now = options.now ?? Date.now();
    const requiredCollateral = options.requiredCollateral ?? roundPrice(this.config.liveOrderSize + this.config.liveCollateralBufferDollars);
    const ageMs = this.cachedReadiness?.lastCheckedAt == null ? Number.POSITIVE_INFINITY : now - this.cachedReadiness.lastCheckedAt;
    const readiness = await this.checkReadiness(now, {
      force: this.config.liveHotPathEnabled && this.cachedReadiness != null && ageMs > Math.max(250, this.config.liveHotPathCacheMaxAgeMs / 2),
      requiredCollateral,
    });
    if (this.config.liveHotPathEnabled) this.cachedReadiness = readiness;
    if (!readiness.ready) return;
    const bundle = await this.client();
    await (bundle.client as unknown as { resolveVersion?: (forceUpdate?: boolean) => Promise<number> }).resolveVersion?.();
    await Promise.all((options.tokenIds ?? []).map((tokenId) => this.warmTokenMetadata(bundle.client, tokenId, now)));
  }

  private async warmTokenMetadata(client: PolymarketClobLike, tokenId: string, now: number): Promise<void> {
    if (!tokenId) return;
    await Promise.allSettled([
      this.getOrderBook(tokenId, now),
      client.getTickSize?.(tokenId),
      client.getNegRisk?.(tokenId),
    ]);
  }

  private async checkReadiness(
    now = Date.now(),
    options: { force?: boolean; requiredCollateral?: number } = {},
  ): Promise<VenueExecutionReadiness> {
    const requiredCollateral = options.requiredCollateral ?? this.config.liveOrderSize;
    const useCache = !options.force;
    const cachedRequiredCollateral = this.cachedReadiness?.requiredCollateral ?? 0;
    if (
      useCache
      && this.cachedReadiness?.ready
      && cachedRequiredCollateral + 1e-9 >= requiredCollateral
      && now - (this.cachedReadiness.lastCheckedAt ?? 0) < 30_000
    ) {
      return this.cachedReadiness;
    }
    if (!this.config.polymarketPrivateKey) {
      const readiness = configuredReadiness(false, "POLYMARKET_PRIVATE_KEY is required for signing live Polymarket orders", now);
      if (useCache) this.cachedReadiness = readiness;
      return readiness;
    }
    const signatureType = signatureTypeFromConfig(this.config.polymarketSignatureType);
    const signerAddress = polymarketSignerAddress(this.config);
    const funderAddress = this.config.polymarketFunderAddress || null;
    if (signatureType !== SignatureTypeV2.EOA && !funderAddress) {
      const readiness = {
        configured: true,
        ready: false,
        reason: "POLYMARKET_FUNDER_ADDRESS is required for proxy/safe signatures",
        balance: null,
        allowance: null,
        lastCheckedAt: now,
        signerAddress: maskAddress(signerAddress),
        funderAddress: null,
        signatureType: this.config.polymarketSignatureType,
        requiredCollateral,
      };
      if (useCache) this.cachedReadiness = readiness;
      return readiness;
    }

    const geoblock = await this.geoblockChecker(now);
    if (geoblock.blocked !== false) {
      const readiness = {
        configured: true,
        ready: false,
        reason: geoblock.reason ?? "Polymarket geoblock status is unknown from worker egress",
        balance: null,
        allowance: null,
        lastCheckedAt: now,
        signerAddress: maskAddress(signerAddress),
        funderAddress: maskAddress(funderAddress),
        signatureType: this.config.polymarketSignatureType,
        clobCredentialsSource: null,
        clobCredentialsDerived: null,
        clobBalanceSynced: null,
        requiredCollateral,
        ...geoblockReadinessFields(geoblock),
      };
      if (useCache) this.cachedReadiness = readiness;
      return readiness;
    }

    try {
      const bundle = await this.client();
      let clobBalanceSynced: boolean | null = null;
      let balanceAllowance = await withMutedPolymarketClientLogs(async () => bundle.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }));
      const rawBalance = finiteOrNull(balanceAllowance.balance);
      const firstRawAllowance = finiteOrNull(balanceAllowance.allowance);
      let balance = normalizedCollateralAmount(rawBalance);
      let allowance = normalizedCollateralAmount(firstRawAllowance);
      if (balance == null || balance <= 0 || allowance == null) {
        try {
          await withMutedPolymarketClientLogs(async () => bundle.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }));
          clobBalanceSynced = true;
          balanceAllowance = await withMutedPolymarketClientLogs(async () => bundle.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }));
          balance = normalizedCollateralAmount(finiteOrNull(balanceAllowance.balance));
          allowance = normalizedCollateralAmount(finiteOrNull(balanceAllowance.allowance));
        } catch {
          clobBalanceSynced = false;
        }
      }
      const finalRawBalance = finiteOrNull(balanceAllowance.balance);
      const finalRawAllowance = finiteOrNull(balanceAllowance.allowance);
      const insufficientBalance = balance == null || balance <= 0 || balance + 1e-9 < requiredCollateral;
      const insufficientAllowance = allowance != null && allowance + 1e-9 < requiredCollateral;
      const reason = insufficientBalance
        ? `Polymarket collateral balance ${balance ?? 0} is below required live collateral ${requiredCollateral}; verify POLYMARKET_FUNDER_ADDRESS points to the funded Polymarket proxy wallet`
        : insufficientAllowance
          ? `Polymarket collateral allowance ${allowance ?? 0} is below required live collateral ${requiredCollateral}`
          : null;
      const readiness = {
        configured: true,
        ready: reason == null,
        reason,
        balance,
        allowance,
        lastCheckedAt: now,
        signerAddress: maskAddress(signerAddress),
        funderAddress: maskAddress(funderAddress),
        signatureType: this.config.polymarketSignatureType,
        collateralBalanceRaw: finalRawBalance,
        collateralBalanceNormalized: balance,
        collateralAllowanceRaw: finalRawAllowance,
        collateralAllowanceNormalized: allowance,
        clobCredentialsSource: bundle.credentialsSource,
        clobCredentialsDerived: bundle.credentialsSource !== "configured",
        clobBalanceSynced,
        requiredCollateral,
        ...geoblockReadinessFields(geoblock),
      };
      if (useCache) this.cachedReadiness = readiness;
      return readiness;
    } catch (error) {
      const readiness = {
        configured: true,
        ready: false,
        reason: sanitizeError(error),
        balance: null,
        allowance: null,
        lastCheckedAt: now,
        signerAddress: maskAddress(signerAddress),
        funderAddress: maskAddress(funderAddress),
        signatureType: this.config.polymarketSignatureType,
        clobCredentialsSource: null,
        clobCredentialsDerived: null,
        clobBalanceSynced: null,
        requiredCollateral,
        ...geoblockReadinessFields(geoblock),
      };
      if (useCache) this.cachedReadiness = readiness;
      return readiness;
    }
  }

  async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
    if (!leg.tokenId) throw new Error("Polymarket token id is required for live trading");
    const readiness = context.preflight?.polymarketReadiness
      && context.preflight.polymarketRequiredCollateral != null
      && context.requiredCollateral != null
      && context.preflight.polymarketRequiredCollateral + 1e-9 >= context.requiredCollateral
      ? context.preflight.polymarketReadiness
      : await this.checkReadiness(context.requestedAt ?? Date.now(), {
        force: true,
        requiredCollateral: context.requiredCollateral,
      });
    if (!readiness.ready) throw new Error(readiness.reason ?? "Polymarket live readiness failed");
    const tokenId = leg.tokenId;
    const requestedAt = context.requestedAt ?? Date.now();
    const { client } = await this.client();
    const book = context.preflight?.polymarketOrderBook ?? await this.getOrderBook(tokenId, context.requestedAt ?? Date.now());
    const minOrderSize = finiteOrNull(book.min_order_size);
    if (minOrderSize != null && minOrderSize > context.size) {
      throw new Error(`Polymarket min order size ${minOrderSize} exceeds configured live order size ${context.size}`);
    }

    const orderType = polymarketOrderType(this.config.polymarketOrderType);
    const requestedSpend = polymarketMarketBuySpend(context);
    const worstPrice = roundPrice(context.maxBuyPrice);
    const preflight = context.preflight;
    const preflightSignedOrderAgeMs = preflight?.polymarketSignedOrderCreatedAt == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, requestedAt - preflight.polymarketSignedOrderCreatedAt);
    const preflightSignedOrder = preflight?.polymarketSignedOrder
      && preflightSignedOrderAgeMs <= this.config.livePolymarketSignedOrderTtlMs
      ? preflight.polymarketSignedOrder
      : null;
    if (!preflightSignedOrder && !client.createMarketOrder) {
      throw new Error("Polymarket market FOK order creation is not supported by the configured CLOB client");
    }
    const signStartedAt = Date.now();
    const signedOrder = preflightSignedOrder ?? await client.createMarketOrder!({
      tokenID: tokenId,
      price: worstPrice,
      amount: requestedSpend,
      side: Side.BUY,
      orderType,
      metadata: metadataFromClientOrderId(context.clientOrderId),
    }, {
      tickSize: book.tick_size as TickSize,
      negRisk: Boolean(book.neg_risk),
    });
    const signMs = preflightSignedOrder
      ? preflight?.polymarketSignMs ?? 0
      : Math.max(0, Date.now() - signStartedAt);
    const payload = await withMutedPolymarketClientLogs(() => client.postOrder(signedOrder, orderType));
    const respondedAt = Date.now();
    const response = payload as Record<string, unknown>;

    const orderId = response.orderID == null ? null : String(response.orderID);
    const status = String(response.status ?? "");
    const success = response.success !== false;
    const filledStatus = ["matched", "filled"].includes(status.toLowerCase());
    let canceledOpenRemainder = false;
    if (orderId && !filledStatus) {
      await withMutedPolymarketClientLogs(async () => {
        try {
          await client.cancelOrder?.({ orderID: orderId });
          canceledOpenRemainder = true;
        } catch {
          // The executor will lock on non-exact fills; cancellation errors are
          // less useful than preserving the actual fill response.
        }
      });
    }

    const takingAmount = finiteOrNull(response.takingAmount);
    const makingAmount = finiteOrNull(response.makingAmount);
    const fillCount = success && filledStatus ? takingAmount : 0;
    const filledMakingAmount = success && filledStatus ? makingAmount : null;
    const fillPrice = filledMakingAmount != null && fillCount != null && fillCount > 0 ? roundPrice(filledMakingAmount / fillCount) : null;
    const responseError = sanitizeError(response.errorMsg ?? response.error ?? "unknown");
    const fillError = !success
      ? `polymarket ${orderType} order rejected: ${responseError}`
      : filledStatus
        ? exactFillError(this.venue, fillCount, context.size)
        : `polymarket ${orderType} order status ${status || "unknown"} did not immediately fill expected ${context.size} shares${canceledOpenRemainder ? "; canceled open order/remainder" : ""}`;
    const resultStatus = !success
      ? status || "failed"
      : !filledStatus
        ? status || "unfilled"
        : fillError ? "unexpected_fill_count" : String(response.status ?? ((fillCount ?? 0) >= context.size ? "filled" : "unfilled"));
    this.cachedReadiness = null;
    return {
      venue: this.venue,
      clientOrderId: context.clientOrderId,
      orderId,
      status: resultStatus,
      fillPrice,
      fillCount,
      requestedAt: isoFromMs(requestedAt),
      respondedAt: isoFromMs(respondedAt),
      error: fillError,
      fee: null,
      exchangeTimestampMs: null,
      signMs,
      metadata: {
        polymarketOrderType: orderType,
        polymarketFokStatus: status || (success ? "unknown" : "rejected"),
        polymarketRequestedSpend: requestedSpend,
        polymarketWorstPrice: worstPrice,
        polymarketRequestedShares: context.size,
        polymarketTakingAmount: takingAmount,
        polymarketMakingAmount: makingAmount,
        polymarketSuccess: success,
      },
    };
  }

  async preflightOrder(leg: ArbLeg, context: LiveOrderContext): Promise<string | null> {
    if (!leg.tokenId) return "Polymarket token id is required for live trading";
    const requiredCollateral = context.requiredCollateral ?? roundPrice(context.size * context.maxBuyPrice + this.config.liveCollateralBufferDollars);
    const now = context.requestedAt ?? Date.now();
    const readiness = this.config.liveHotPathEnabled
      ? this.cachedHotReadiness(now, requiredCollateral)
      : await this.checkReadiness(now, { requiredCollateral });
    if (!readiness.ready) return readiness.reason ?? "Polymarket live readiness failed";
    const book = this.config.liveHotPathEnabled
      ? this.cachedHotOrderBook(leg.tokenId, now)
      : await this.getOrderBook(leg.tokenId, now);
    if (!book) return `Polymarket hot order metadata cache is stale for token ${leg.tokenId}`;
    const minOrderSize = finiteOrNull(book.min_order_size);
    if (minOrderSize != null && minOrderSize > context.size) {
      return `Polymarket min order size ${minOrderSize} exceeds configured live order size ${context.size}`;
    }
    context.preflight = {
      ...context.preflight,
      polymarketReadiness: readiness,
      polymarketRequiredCollateral: requiredCollateral,
      polymarketOrderBook: book,
    };
    if (this.config.livePolymarketPresignEnabled) {
      try {
        const signStartedAt = Date.now();
        const { client } = await this.client();
        if (!client.createMarketOrder) return "Polymarket market FOK order creation is not supported by the configured CLOB client";
        const orderType = polymarketOrderType(this.config.polymarketOrderType);
        const signedOrder = await client.createMarketOrder({
          tokenID: leg.tokenId,
          price: roundPrice(context.maxBuyPrice),
          amount: polymarketMarketBuySpend(context),
          side: Side.BUY,
          orderType,
          metadata: metadataFromClientOrderId(context.clientOrderId),
        }, {
          tickSize: book.tick_size as TickSize,
          negRisk: Boolean(book.neg_risk),
        });
        const signMs = Math.max(0, Date.now() - signStartedAt);
        context.preflight = {
          ...context.preflight,
          polymarketSignedOrder: signedOrder,
          polymarketSignedOrderCreatedAt: now,
          polymarketSignMs: signMs,
        };
      } catch (error) {
        return `Polymarket signed-order warmup failed: ${sanitizeError(error)}`;
      }
    }
    return null;
  }

  private cachedHotReadiness(now: number, requiredCollateral: number): VenueExecutionReadiness {
    const cached = this.cachedReadiness;
    const ageMs = cached?.lastCheckedAt == null ? Number.POSITIVE_INFINITY : now - cached.lastCheckedAt;
    if (!cached || ageMs > this.config.liveHotPathCacheMaxAgeMs) {
      return {
        configured: Boolean(this.config.polymarketPrivateKey),
        ready: false,
        reason: `Polymarket hot readiness cache is stale: age ${Number.isFinite(ageMs) ? ageMs : "unknown"}ms exceeds ${this.config.liveHotPathCacheMaxAgeMs}ms`,
        balance: cached?.balance ?? null,
        allowance: cached?.allowance ?? null,
        lastCheckedAt: cached?.lastCheckedAt ?? null,
      };
    }
    if ((cached.requiredCollateral ?? 0) + 1e-9 < requiredCollateral) {
      return {
        ...cached,
        ready: false,
        reason: `Polymarket hot readiness cache covers ${cached.requiredCollateral ?? 0} collateral but ${requiredCollateral} is required`,
      };
    }
    return cached;
  }

  private cachedHotOrderBook(tokenId: string, now: number): Pick<OrderBookSummary, "min_order_size" | "tick_size" | "neg_risk"> | null {
    const cached = this.orderBookCache.get(tokenId);
    if (!cached) return null;
    const maxAgeMs = Math.max(30_000, this.config.liveHotPathCacheMaxAgeMs);
    return now - cached.checkedAt <= maxAgeMs ? cached.book : null;
  }

  private async client(): Promise<PolymarketClobClientBundle> {
    this.clientPromise ??= this.clientFactory(this.config);
    return asPolymarketClientBundle(await this.clientPromise);
  }

  private async getOrderBook(tokenId: string, now = Date.now()): Promise<Pick<OrderBookSummary, "min_order_size" | "tick_size" | "neg_risk">> {
    const cached = this.orderBookCache.get(tokenId);
    if (cached && now - cached.checkedAt < 30_000) return cached.book;
    const { client } = await this.client();
    const book = await withMutedPolymarketClientLogs(() => client.getOrderBook(tokenId));
    this.orderBookCache.set(tokenId, { checkedAt: now, book });
    return book;
  }
}

function asPolymarketClientBundle(value: PolymarketClobLike | PolymarketClobClientBundle): PolymarketClobClientBundle {
  if ("client" in value && "credentialsSource" in value) return value;
  return { client: value, credentialsSource: "configured" };
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
    fee: null,
    exchangeTimestampMs: null,
  };
}

export function generatedClientOrderId(venue: Venue): string {
  return `${venue}-${randomUUID()}`;
}
