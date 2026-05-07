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
  preflightOrder?(leg: ArbLeg, context: LiveOrderContext): Promise<string | null>;
  placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult>;
  readiness(now?: number): Promise<VenueExecutionReadiness>;
}

export interface PolymarketClobLike {
  getOrderBook(tokenID: string): Promise<Pick<OrderBookSummary, "min_order_size" | "tick_size" | "neg_risk">>;
  createOrder(order: { tokenID: string; price: number; size: number; side: Side; metadata?: string }, options: { tickSize: TickSize; negRisk?: boolean }): Promise<SignedOrder>;
  postOrder(order: SignedOrder, orderType?: OrderType): Promise<unknown>;
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
  return {
    ticker: leg.contractId,
    client_order_id: context.clientOrderId,
    side: isYes ? "bid" : "ask",
    count: fixedCount(context.size),
    price: fixedDollars(yesBookPrice),
    time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
    cancel_order_on_pause: true,
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

async function defaultPolymarketClientFactory(config: AppConfig): Promise<PolymarketClobClientBundle> {
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
  const resolved = configuredCreds
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
  };
}

export class PolymarketOrderClient implements VenueOrderClient {
  readonly venue = "polymarket" as const;
  private clientPromise: Promise<PolymarketClobLike | PolymarketClobClientBundle> | null = null;
  private cachedReadiness: VenueExecutionReadiness | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly clientFactory: (config: AppConfig) => Promise<PolymarketClobLike | PolymarketClobClientBundle> = defaultPolymarketClientFactory,
    private readonly geoblockChecker: PolymarketGeoblockChecker = (now) => checkPolymarketGeoblock(config, fetch, now),
  ) {}

  async readiness(now = Date.now()): Promise<VenueExecutionReadiness> {
    if (this.cachedReadiness && now - (this.cachedReadiness.lastCheckedAt ?? 0) < 30_000) return this.cachedReadiness;
    if (!this.config.polymarketPrivateKey) {
      this.cachedReadiness = configuredReadiness(false, "POLYMARKET_PRIVATE_KEY is required for signing live Polymarket orders", now);
      return this.cachedReadiness;
    }
    const signatureType = signatureTypeFromConfig(this.config.polymarketSignatureType);
    const signerAddress = polymarketSignerAddress(this.config);
    const funderAddress = this.config.polymarketFunderAddress || null;
    if (signatureType !== SignatureTypeV2.EOA && !funderAddress) {
      this.cachedReadiness = {
        configured: true,
        ready: false,
        reason: "POLYMARKET_FUNDER_ADDRESS is required for proxy/safe signatures",
        balance: null,
        allowance: null,
        lastCheckedAt: now,
        signerAddress: maskAddress(signerAddress),
        funderAddress: null,
        signatureType: this.config.polymarketSignatureType,
        requiredCollateral: this.config.liveOrderSize,
      };
      return this.cachedReadiness;
    }

    const geoblock = await this.geoblockChecker(now);
    if (geoblock.blocked !== false) {
      this.cachedReadiness = {
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
        requiredCollateral: this.config.liveOrderSize,
        ...geoblockReadinessFields(geoblock),
      };
      return this.cachedReadiness;
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
      const requiredCollateral = this.config.liveOrderSize;
      const insufficientBalance = balance == null || balance <= 0 || balance + 1e-9 < requiredCollateral;
      const insufficientAllowance = allowance != null && allowance + 1e-9 < requiredCollateral;
      const reason = insufficientBalance
        ? `Polymarket collateral balance ${balance ?? 0} is below required canary collateral ${requiredCollateral}; verify POLYMARKET_FUNDER_ADDRESS points to the funded Polymarket proxy wallet`
        : insufficientAllowance
          ? `Polymarket collateral allowance ${allowance ?? 0} is below required canary collateral ${requiredCollateral}`
          : null;
      this.cachedReadiness = {
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
    } catch (error) {
      this.cachedReadiness = {
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
        requiredCollateral: this.config.liveOrderSize,
        ...geoblockReadinessFields(geoblock),
      };
    }
    return this.cachedReadiness;
  }

  async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
    if (!leg.tokenId) throw new Error("Polymarket token id is required for live trading");
    const readiness = await this.readiness(context.requestedAt ?? Date.now());
    if (!readiness.ready) throw new Error(readiness.reason ?? "Polymarket live readiness failed");
    const tokenId = leg.tokenId;
    const requestedAt = context.requestedAt ?? Date.now();
    const { client } = await this.client();
    const book = await withMutedPolymarketClientLogs(() => client.getOrderBook(tokenId));
    const minOrderSize = finiteOrNull(book.min_order_size);
    if (minOrderSize != null && minOrderSize > context.size) {
      throw new Error(`Polymarket min order size ${minOrderSize} exceeds configured live order size ${context.size}`);
    }

    const signedOrder = await client.createOrder({
      tokenID: tokenId,
      price: roundPrice(context.maxBuyPrice),
      size: context.size,
      side: Side.BUY,
      metadata: metadataFromClientOrderId(context.clientOrderId),
    }, {
      tickSize: book.tick_size as TickSize,
      negRisk: Boolean(book.neg_risk),
    });
    // Polymarket FOK/FAK BUY orders are notional-based: if the market improves,
    // a "5 share" canary can spend the whole max notional and receive many more
    // shares. Use a marketable GTC limit order to cap the token amount, then
    // cancel any unfilled remainder immediately.
    const payload = await withMutedPolymarketClientLogs(() => client.postOrder(signedOrder, OrderType.GTC));
    const respondedAt = Date.now();
    const response = payload as Record<string, unknown>;
    if (response.success === false) throw new Error(`Polymarket order failed: ${sanitizeError(response.errorMsg ?? response.error ?? "unknown")}`);

    const orderId = response.orderID == null ? null : String(response.orderID);
    const status = String(response.status ?? "");
    if (orderId && !["matched", "filled"].includes(status.toLowerCase())) {
      await withMutedPolymarketClientLogs(async () => {
        try {
          await client.cancelOrder?.({ orderID: orderId });
        } catch {
          // The executor will lock on non-exact fills; cancellation errors are
          // less useful than preserving the actual fill response.
        }
      });
    }

    const fillCount = finiteOrNull(response.takingAmount) ?? context.size;
    const makingAmount = finiteOrNull(response.makingAmount);
    const fillPrice = makingAmount != null && fillCount != null && fillCount > 0 ? roundPrice(makingAmount / fillCount) : context.maxBuyPrice;
    const fillError = exactFillError(this.venue, fillCount, context.size);
    return {
      venue: this.venue,
      clientOrderId: context.clientOrderId,
      orderId,
      status: fillError ? "unexpected_fill_count" : String(response.status ?? (fillCount >= context.size ? "filled" : "unfilled")),
      fillPrice,
      fillCount,
      requestedAt: isoFromMs(requestedAt),
      respondedAt: isoFromMs(respondedAt),
      error: fillError,
    };
  }

  async preflightOrder(leg: ArbLeg, context: LiveOrderContext): Promise<string | null> {
    if (!leg.tokenId) return "Polymarket token id is required for live trading";
    const readiness = await this.readiness(context.requestedAt ?? Date.now());
    if (!readiness.ready) return readiness.reason ?? "Polymarket live readiness failed";
    const { client } = await this.client();
    const book = await withMutedPolymarketClientLogs(() => client.getOrderBook(leg.tokenId as string));
    const minOrderSize = finiteOrNull(book.min_order_size);
    if (minOrderSize != null && minOrderSize > context.size) {
      return `Polymarket min order size ${minOrderSize} exceeds configured live order size ${context.size}`;
    }
    return null;
  }

  private async client(): Promise<PolymarketClobClientBundle> {
    this.clientPromise ??= this.clientFactory(this.config);
    return asPolymarketClientBundle(await this.clientPromise);
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
  };
}

export function generatedClientOrderId(venue: Venue): string {
  return `${venue}-${randomUUID()}`;
}
