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
import type { ArbLeg, LiveOrderPlacementMode, Venue, VenueExecutionReadiness } from "../types";

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
  placementMode?: LiveOrderPlacementMode;
  limitRestMs?: number;
}

export interface KalshiPreparedOrder {
  url: string;
  signPath: string;
  headers: Record<string, string>;
  bodyTemplate: Record<string, string | boolean>;
  preparedAt: number;
  buildMs: number;
  signMs: number;
  originalMaxBuyPrice: number;
  originalYesBookPrice: number;
  clientOrderId: string;
  contractId: string;
  direction: ArbLeg["direction"];
  size: number;
  placementMode?: LiveOrderPlacementMode;
}

export interface LiveOrderPreflight {
  kalshiPreparedOrder?: KalshiPreparedOrder;
  kalshiPreparedOrderFallbackReason?: string | null;
  polymarketReadiness?: VenueExecutionReadiness;
  polymarketRequiredCollateral?: number;
  polymarketOrderBook?: Pick<OrderBookSummary, "min_order_size" | "tick_size" | "neg_risk">;
  polymarketSignedOrder?: SignedOrder;
  polymarketSignedOrderCreatedAt?: number;
  polymarketSignMs?: number;
  polymarketSignedOrderTokenId?: string;
  polymarketSignedOrderPrice?: number;
  polymarketSignedOrderSpend?: number;
  polymarketSignedOrderType?: OrderType.FOK | OrderType.FAK;
  polymarketSignedOrderSalt?: string | null;
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
  recoverTimedOutOrder?(leg: ArbLeg, context: LiveOrderContext, timedOutResult: VenueOrderResult): Promise<VenueOrderResult | null>;
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
  getOrder?(orderID: string): Promise<unknown>;
  getOpenOrders?(params?: { id?: string; market?: string; asset_id?: string }, onlyFirstPage?: boolean): Promise<unknown[]>;
  getTrades?(params?: { market?: string; asset_id?: string }, onlyFirstPage?: boolean): Promise<unknown[]>;
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

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" ? value as Record<string, unknown> : null;
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

function kalshiOrderEndpoint(config: AppConfig): { url: URL; signPath: string } {
  const url = new URL(config.kalshiApiBase);
  const basePath = url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/portfolio/events/orders`;
  return { url, signPath: `${url.pathname}${url.search}` };
}

function kalshiYesBookPrice(leg: ArbLeg, context: LiveOrderContext): number {
  return roundPrice(leg.direction === "yes" ? context.maxBuyPrice : 1 - context.maxBuyPrice);
}

export function buildKalshiV2OrderBody(leg: ArbLeg, context: LiveOrderContext): Record<string, string | boolean> {
  const isYes = leg.direction === "yes";
  const yesBookPrice = kalshiYesBookPrice(leg, context);
  const body: Record<string, string | boolean> = {
    ticker: leg.contractId,
    client_order_id: context.clientOrderId,
    side: isYes ? "bid" : "ask",
    count: fixedCount(context.size),
    price: fixedDollars(yesBookPrice),
    time_in_force: isLimitRestMode(context) ? "good_till_canceled" : "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
    cancel_order_on_pause: true,
  };
  if (context.orderGroupId) body.order_group_id = context.orderGroupId;
  return body;
}

function preparedKalshiFallbackReason(
  prepared: KalshiPreparedOrder | undefined,
  leg: ArbLeg,
  context: LiveOrderContext,
  requestedAt: number,
  ttlMs: number,
): string | null {
  if (!prepared) return "missing";
  const ageMs = Math.max(0, requestedAt - prepared.preparedAt);
  if (ageMs > ttlMs) return `expired_${ageMs}ms`;
  if (prepared.clientOrderId !== context.clientOrderId) return "client_order_id_changed";
  if (prepared.contractId !== leg.contractId) return "contract_changed";
  if (prepared.direction !== leg.direction) return "direction_changed";
  if (Math.abs(prepared.size - context.size) > 0.000001) return "size_changed";
  if (prepared.placementMode !== context.placementMode) return "placement_mode_changed";
  return null;
}

function patchPreparedKalshiBody(
  prepared: KalshiPreparedOrder,
  leg: ArbLeg,
  context: LiveOrderContext,
): { body: Record<string, string | boolean>; patchMs: number; fallbackReason: string | null } {
  const startedAt = Date.now();
  const desired = buildKalshiV2OrderBody(leg, context);
  const invariantFields: Array<keyof typeof desired> = ["ticker", "client_order_id", "side", "count", "time_in_force"];
  for (const field of invariantFields) {
    if (prepared.bodyTemplate[field] !== desired[field]) {
      return {
        body: desired,
        patchMs: Math.max(0, Date.now() - startedAt),
        fallbackReason: `${field}_changed`,
      };
    }
  }
  return {
    body: { ...prepared.bodyTemplate, price: desired.price },
    patchMs: Math.max(0, Date.now() - startedAt),
    fallbackReason: null,
  };
}

function kalshiOrderRecord(payload: Record<string, unknown>): Record<string, unknown> {
  return recordOrNull(payload.order) ?? payload;
}

function kalshiOrderRecords(payload: Record<string, unknown>): Record<string, unknown>[] {
  const orders = Array.isArray(payload.orders) ? payload.orders : [];
  return orders
    .map((order) => recordOrNull(order))
    .filter((order): order is Record<string, unknown> => order != null);
}

function kalshiFillCount(record: Record<string, unknown>): number | null {
  return finiteOrNull(record.fill_count ?? record.fill_count_fp);
}

function kalshiFillPrice(record: Record<string, unknown>, leg: ArbLeg): number | null {
  const averageFillPrice = finiteOrNull(record.average_fill_price);
  if (averageFillPrice != null) return leg.direction === "yes" ? averageFillPrice : roundPrice(1 - averageFillPrice);
  const yesPrice = finiteOrNull(record.yes_price_dollars);
  const noPrice = finiteOrNull(record.no_price_dollars);
  if (leg.direction === "yes") return yesPrice;
  return noPrice ?? (yesPrice == null ? null : roundPrice(1 - yesPrice));
}

function kalshiOrderStatus(record: Record<string, unknown>, fillCount: number | null, requestedSize: number): string {
  const status = String(record.status ?? "").trim();
  if (isExactFillCount(fillCount, requestedSize)) return "filled";
  return status || "unfilled";
}

export class KalshiOrderClient implements VenueOrderClient {
  readonly venue = "kalshi" as const;

  constructor(private readonly config: AppConfig, private readonly fetchFn: typeof fetch = fetch) {}

  async readiness(now = Date.now()): Promise<VenueExecutionReadiness> {
    return requireKalshiConfigured(now);
  }

  async preflightOrder(leg: ArbLeg, context: LiveOrderContext): Promise<string | null> {
    const readiness = await this.readiness(context.requestedAt ?? Date.now());
    if (!readiness.ready) return readiness.reason ?? "Kalshi execution is not configured";
    if (!this.config.liveKalshiPrearmEnabled || context.placementMode !== "polymarket_first_exact") return null;

    const buildStartedAt = Date.now();
    try {
      const { url, signPath } = kalshiOrderEndpoint(this.config);
      const bodyTemplate = buildKalshiV2OrderBody(leg, context);
      const signStartedAt = Date.now();
      const headers = getKalshiHeaders("POST", signPath, signStartedAt.toString());
      const signedAt = Date.now();
      context.preflight = {
        ...context.preflight,
        kalshiPreparedOrder: {
          url: url.toString(),
          signPath,
          headers,
          bodyTemplate,
          preparedAt: signStartedAt,
          buildMs: Math.max(0, signedAt - buildStartedAt),
          signMs: Math.max(0, signedAt - signStartedAt),
          originalMaxBuyPrice: context.maxBuyPrice,
          originalYesBookPrice: kalshiYesBookPrice(leg, context),
          clientOrderId: context.clientOrderId,
          contractId: leg.contractId,
          direction: leg.direction,
          size: context.size,
          placementMode: context.placementMode,
        },
        kalshiPreparedOrderFallbackReason: null,
      };
    } catch (error) {
      context.preflight = {
        ...context.preflight,
        kalshiPreparedOrderFallbackReason: sanitizeError(error),
      };
    }
    return null;
  }

  async placeOrder(leg: ArbLeg, context: LiveOrderContext): Promise<VenueOrderResult> {
    const readiness = await this.readiness(context.requestedAt ?? Date.now());
    if (!readiness.ready) throw new Error(readiness.reason ?? "Kalshi execution is not configured");

    const requestedAt = context.requestedAt ?? Date.now();
    const prepared = context.preflight?.kalshiPreparedOrder;
    const preparedAgeMs = prepared == null ? null : Math.max(0, requestedAt - prepared.preparedAt);
    let preparedFallbackReason = prepared == null
      ? context.preflight?.kalshiPreparedOrderFallbackReason ?? "missing"
      : preparedKalshiFallbackReason(prepared, leg, context, requestedAt, this.config.liveKalshiPrearmMaxAgeMs);
    const preparedUsable = prepared != null && preparedFallbackReason == null;
    let endpoint = preparedUsable ? { url: new URL(prepared.url), signPath: prepared.signPath } : kalshiOrderEndpoint(this.config);
    let body: Record<string, string | boolean>;
    let headers: Record<string, string>;
    let pricePatchMs: number | null = null;
    if (preparedUsable) {
      const patched = patchPreparedKalshiBody(prepared, leg, context);
      pricePatchMs = patched.patchMs;
      if (patched.fallbackReason == null) {
        body = patched.body;
        headers = prepared.headers;
      } else {
        preparedFallbackReason = patched.fallbackReason;
        endpoint = kalshiOrderEndpoint(this.config);
        body = buildKalshiV2OrderBody(leg, context);
        headers = getKalshiHeaders("POST", endpoint.signPath);
      }
    } else {
      body = buildKalshiV2OrderBody(leg, context);
      headers = getKalshiHeaders("POST", endpoint.signPath);
    }
    const response = await this.fetchFn(endpoint.url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: context.signal,
    });
    const respondedAt = Date.now();
    const text = await response.text();
    const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok) throw new Error(`Kalshi order failed ${response.status}: ${sanitizeError(text)}`);

    const record = kalshiOrderRecord(payload);
    const fillCount = kalshiFillCount(record);
    const fee = finiteOrNull(record.average_fee_paid ?? record.taker_fees_dollars);
    const exchangeTimestampMs = finiteOrNull(record.ts_ms);
    const initialResult: VenueOrderResult = {
      venue: this.venue,
      clientOrderId: String(record.client_order_id ?? context.clientOrderId),
      orderId: record.order_id == null ? null : String(record.order_id),
      status: kalshiOrderStatus(record, fillCount, context.size),
      fillPrice: kalshiFillPrice(record, leg),
      fillCount,
      requestedAt: isoFromMs(requestedAt),
      respondedAt: isoFromMs(respondedAt),
      error: null,
      fee,
      exchangeTimestampMs,
      metadata: {
        orderPlacementMode: context.placementMode ?? "parallel_fok",
        kalshiInitialStatus: String(record.status ?? initialResultStatus(fillCount, context.size)),
        kalshiInitialFillCount: fillCount,
        limitRestMs: isLimitRestMode(context) ? limitRestMs(context) : null,
        kalshiPreparedUsed: preparedUsable && preparedFallbackReason == null,
        kalshiPreparedFallbackReason: preparedUsable && preparedFallbackReason == null ? null : preparedFallbackReason ?? "not_prepared",
        kalshiPrearmAgeMs: preparedAgeMs,
        kalshiPrearmMs: prepared?.buildMs ?? null,
        kalshiPrearmSignMs: prepared?.signMs ?? null,
        kalshiPricePatchMs: pricePatchMs,
        kalshiPrearmOriginalMaxBuyPrice: prepared?.originalMaxBuyPrice ?? null,
        kalshiPrearmOriginalYesBookPrice: prepared?.originalYesBookPrice ?? null,
        kalshiSubmittedMaxBuyPrice: context.maxBuyPrice,
        kalshiSubmittedYesBookPrice: kalshiYesBookPrice(leg, context),
      },
    };
    if (!isLimitRestMode(context)) return initialResult;
    return this.finalizeLimitRestOrder(leg, context, initialResult);
  }

  private async finalizeLimitRestOrder(
    leg: ArbLeg,
    context: LiveOrderContext,
    initialResult: VenueOrderResult,
  ): Promise<VenueOrderResult> {
    const restMs = limitRestMs(context);
    const orderId = initialResult.orderId;
    const initialStatus = initialResult.status;
    if (isExactFillCount(initialResult.fillCount, context.size)) {
      return {
        ...initialResult,
        metadata: {
          ...initialResult.metadata,
          kalshiFinalStatus: initialStatus,
          kalshiFinalFillCount: initialResult.fillCount,
          kalshiFinalFillSource: "initial_rest_response",
          kalshiCancelStatus: "not_needed",
        },
      };
    }
    if (restMs > 0) await waitMs(restMs);

    let beforeCancel: Record<string, unknown> | null = null;
    let beforeCancelError: string | null = null;
    if (orderId) {
      try {
        beforeCancel = await this.fetchOrder(orderId, context.signal);
      } catch (error) {
        beforeCancelError = sanitizeError(error);
      }
    }
    const beforeFillCount = beforeCancel ? kalshiFillCount(beforeCancel) : null;
    if (beforeCancel && isExactFillCount(beforeFillCount, context.size)) {
      return this.resultFromKalshiRecord(leg, context, beforeCancel, initialResult, {
        cancelStatus: "not_needed",
        finalFillSource: "pre_cancel_poll",
        beforeCancelError,
      });
    }

    let cancelStatus = "skipped_no_order_id";
    let cancelError: string | null = null;
    if (orderId) {
      try {
        cancelStatus = await this.cancelOrder(orderId, context.signal);
      } catch (error) {
        cancelStatus = "cancel_failed";
        cancelError = sanitizeError(error);
      }
    }

    let finalRecord: Record<string, unknown> | null = null;
    let finalFetchError: string | null = null;
    if (orderId) {
      try {
        finalRecord = await this.fetchOrder(orderId, context.signal);
      } catch (error) {
        finalFetchError = sanitizeError(error);
      }
    }
    return this.resultFromKalshiRecord(leg, context, finalRecord ?? beforeCancel, initialResult, {
      cancelStatus,
      cancelError,
      beforeCancelError,
      finalFetchError,
      finalFillSource: finalRecord ? "post_cancel_poll" : beforeCancel ? "pre_cancel_poll" : "initial_rest_response",
    });
  }

  private resultFromKalshiRecord(
    leg: ArbLeg,
    context: LiveOrderContext,
    record: Record<string, unknown> | null,
    initialResult: VenueOrderResult,
    metadata: {
      cancelStatus: string;
      cancelError?: string | null;
      beforeCancelError?: string | null;
      finalFetchError?: string | null;
      finalFillSource: string;
    },
  ): VenueOrderResult {
    const fillCount = record ? kalshiFillCount(record) : initialResult.fillCount;
    const finalStatus = record ? kalshiOrderStatus(record, fillCount, context.size) : "unknown";
    const exactFill = isExactFillCount(fillCount, context.size);
    const cancelVerified = metadata.cancelStatus === "canceled" || metadata.cancelStatus === "not_needed";
    const status = exactFill
      ? "filled"
      : cancelVerified && finalStatus !== "resting"
        ? finalStatus || "canceled"
        : "unknown";
    const error = exactFill
      ? null
      : status === "unknown"
        ? `kalshi limit_rest cancellation/final state unverified${metadata.cancelError ? `: ${metadata.cancelError}` : ""}${metadata.finalFetchError ? `; final query failed: ${metadata.finalFetchError}` : ""}`
        : `kalshi limit_rest order canceled without exact fill (${exactFillError(this.venue, fillCount, context.size) ?? "final fill did not match requested size"})`;
    return {
      ...initialResult,
      clientOrderId: record == null ? initialResult.clientOrderId : String(record.client_order_id ?? initialResult.clientOrderId),
      orderId: record?.order_id == null ? initialResult.orderId : String(record.order_id),
      status,
      fillPrice: record ? kalshiFillPrice(record, leg) : initialResult.fillPrice,
      fillCount,
      respondedAt: isoFromMs(Date.now()),
      error,
      fee: record ? finiteOrNull(record.average_fee_paid ?? record.taker_fees_dollars) : initialResult.fee,
      exchangeTimestampMs: record ? finiteOrNull(record.ts_ms) : initialResult.exchangeTimestampMs,
      metadata: {
        ...initialResult.metadata,
        kalshiFinalStatus: finalStatus,
        kalshiFinalFillCount: fillCount,
        kalshiFinalFillSource: metadata.finalFillSource,
        kalshiCancelStatus: metadata.cancelStatus,
        kalshiCancelError: metadata.cancelError ?? null,
        kalshiBeforeCancelError: metadata.beforeCancelError ?? null,
        kalshiFinalFetchError: metadata.finalFetchError ?? null,
      },
    };
  }

  async recoverTimedOutOrder(leg: ArbLeg, context: LiveOrderContext, timedOutResult: VenueOrderResult): Promise<VenueOrderResult | null> {
    const record = await this.findRecentOrderByClientOrderId(leg.contractId, context.clientOrderId);
    if (!record) {
      return {
        ...timedOutResult,
        metadata: {
          ...timedOutResult.metadata,
          kalshiTimeoutRecoveryAttempted: true,
          kalshiTimeoutRecoveryStatus: "not_found",
        },
      };
    }
    return this.resultFromKalshiRecord(leg, context, record, {
      ...timedOutResult,
      metadata: {
        ...timedOutResult.metadata,
        kalshiTimeoutRecoveryAttempted: true,
        kalshiTimeoutRecoveryStatus: "found_by_client_order_id",
      },
    }, {
      cancelStatus: "not_needed",
      finalFillSource: "timeout_recovery_query",
    });
  }

  private async findRecentOrderByClientOrderId(ticker: string, clientOrderId: string): Promise<Record<string, unknown> | null> {
    const statuses: Array<string | null> = [null, "executed", "resting", "canceled"];
    const seenUrls = new Set<string>();
    for (const status of statuses) {
      const url = new URL(this.config.kalshiApiBase);
      const basePath = url.pathname.replace(/\/$/, "");
      url.pathname = `${basePath}/portfolio/orders`;
      url.searchParams.set("ticker", ticker);
      url.searchParams.set("limit", "100");
      if (status) url.searchParams.set("status", status);
      const href = url.toString();
      if (seenUrls.has(href)) continue;
      seenUrls.add(href);
      try {
        const orders = await this.fetchOrders(url);
        const match = orders.find((order) => String(order.client_order_id ?? "") === clientOrderId);
        if (match) return match;
      } catch {
        // Try the next status form before giving up on recovery.
      }
    }
    return null;
  }

  private async fetchOrders(url: URL): Promise<Record<string, unknown>[]> {
    const signPath = `${url.pathname}${url.search}`;
    const response = await this.fetchFn(url, {
      method: "GET",
      headers: getKalshiHeaders("GET", signPath),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Kalshi orders query failed ${response.status}: ${sanitizeError(text)}`);
    const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    return kalshiOrderRecords(payload);
  }

  private async fetchOrder(orderId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const url = new URL(this.config.kalshiApiBase);
    const basePath = url.pathname.replace(/\/$/, "");
    url.pathname = `${basePath}/portfolio/orders/${encodeURIComponent(orderId)}`;
    const signPath = `${url.pathname}${url.search}`;
    const response = await this.fetchFn(url, {
      method: "GET",
      headers: getKalshiHeaders("GET", signPath),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Kalshi order query failed ${response.status}: ${sanitizeError(text)}`);
    const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    return kalshiOrderRecord(payload);
  }

  private async cancelOrder(orderId: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(this.config.kalshiApiBase);
    const basePath = url.pathname.replace(/\/$/, "");
    url.pathname = `${basePath}/portfolio/events/orders/${encodeURIComponent(orderId)}`;
    const signPath = `${url.pathname}${url.search}`;
    const response = await this.fetchFn(url, {
      method: "DELETE",
      headers: getKalshiHeaders("DELETE", signPath),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Kalshi order cancel failed ${response.status}: ${sanitizeError(text)}`);
    return "canceled";
  }
}

function initialResultStatus(fillCount: number | null, requestedSize: number): string {
  return isExactFillCount(fillCount, requestedSize) ? "filled" : "unfilled";
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

function polymarketImmediateOrderType(configuredValue: string, context: LiveOrderContext): OrderType.FOK | OrderType.FAK {
  if (context.placementMode === "polymarket_first_exact") return OrderType.FAK;
  if (context.placementMode === "parallel_fak") return OrderType.FAK;
  if (context.placementMode === "parallel_fok") return OrderType.FOK;
  return polymarketOrderType(configuredValue);
}

function signedOrderRecord(order: SignedOrder | null | undefined): Record<string, unknown> | null {
  return order == null ? null : order as unknown as Record<string, unknown>;
}

function signedOrderSalt(order: SignedOrder | null | undefined): string | null {
  const salt = signedOrderRecord(order)?.salt;
  return salt == null || salt === "" ? null : String(salt);
}

function signedOrderMetadata(order: SignedOrder | null | undefined): Record<string, unknown> {
  const record = signedOrderRecord(order);
  return {
    polymarketSignedOrderSalt: record?.salt == null || record.salt === "" ? null : String(record.salt),
    polymarketSignedOrderMakerAmount: record?.makerAmount == null ? null : String(record.makerAmount),
    polymarketSignedOrderTakerAmount: record?.takerAmount == null ? null : String(record.takerAmount),
    polymarketSignedOrderTokenId: record?.tokenId == null ? null : String(record.tokenId),
    polymarketSignedOrderSide: record?.side == null ? null : String(record.side),
    polymarketSignedOrderMetadata: record?.metadata == null ? null : String(record.metadata),
  };
}

function preflightSignedOrderFallbackReason(
  preflight: LiveOrderPreflight | undefined,
  tokenId: string,
  price: number,
  spend: number,
  orderType: OrderType.FOK | OrderType.FAK,
  requestedAt: number,
  ttlMs: number,
): string | null {
  if (!preflight?.polymarketSignedOrder) return "missing";
  const ageMs = preflight.polymarketSignedOrderCreatedAt == null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, requestedAt - preflight.polymarketSignedOrderCreatedAt);
  if (ageMs > ttlMs) return `expired_${ageMs}ms`;
  if (preflight.polymarketSignedOrderTokenId !== tokenId) return "token_changed";
  if (preflight.polymarketSignedOrderType !== orderType) return "order_type_changed";
  if (Math.abs((preflight.polymarketSignedOrderPrice ?? Number.NaN) - price) > 0.000001) return "price_changed";
  if (Math.abs((preflight.polymarketSignedOrderSpend ?? Number.NaN) - spend) > 0.000001) return "spend_changed";
  return null;
}

function isTimeoutLikeError(message: string): boolean {
  return /timeout|timed out|abort|aborted|socket hang up|network/i.test(message);
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

function isExactFillCount(fillCount: number | null, requestedSize: number): boolean {
  return fillCount != null && Math.abs(fillCount - requestedSize) <= 0.000001;
}

function isLimitRestMode(context: LiveOrderContext): boolean {
  return context.placementMode === "parallel_limit_rest";
}

function limitRestMs(context: LiveOrderContext): number {
  return Math.max(0, Math.floor(context.limitRestMs ?? 0));
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function polymarketMarketBuySpend(context: LiveOrderContext): number {
  return roundPrice(context.size * context.maxBuyPrice);
}

function polymarketFilledStatus(status: string): boolean {
  return ["matched", "filled"].includes(status.toLowerCase());
}

function parsePolymarketTimeMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function polymarketTradeIsRecentBuyForToken(
  trade: Record<string, unknown>,
  tokenId: string,
  submittedAtMs: number,
  maxBuyPrice: number,
): boolean {
  if (String(trade.asset_id ?? trade.token_id ?? "") !== tokenId) return false;
  if (String(trade.side ?? "").toUpperCase() !== String(Side.BUY).toUpperCase()) return false;
  const matchTimeMs = parsePolymarketTimeMs(trade.match_time ?? trade.last_update ?? trade.created_at);
  if (matchTimeMs != null && matchTimeMs < submittedAtMs - 1_000) return false;
  const price = finiteOrNull(trade.price);
  if (price != null && price > maxBuyPrice + 0.000001) return false;
  const size = finiteOrNull(trade.size);
  return size != null && size > 0;
}

function polymarketTradeGroups(
  trades: Array<Record<string, unknown>>,
): Array<{ orderId: string; fillCount: number; fillPrice: number | null; tradeCount: number }> {
  const groups = new Map<string, { fillCount: number; notional: number; tradeCount: number }>();
  for (const trade of trades) {
    const orderId = stringOrNull(trade.taker_order_id)
      ?? stringOrNull(recordOrNull(Array.isArray(trade.maker_orders) ? trade.maker_orders[0] : null)?.order_id)
      ?? `trade:${stringOrNull(trade.id) ?? randomUUID()}`;
    const size = finiteOrNull(trade.size) ?? 0;
    const price = finiteOrNull(trade.price) ?? 0;
    const group = groups.get(orderId) ?? { fillCount: 0, notional: 0, tradeCount: 0 };
    group.fillCount += size;
    group.notional += size * price;
    group.tradeCount += 1;
    groups.set(orderId, group);
  }
  return [...groups.entries()].map(([orderId, group]) => ({
    orderId,
    fillCount: group.fillCount,
    fillPrice: group.fillCount > 0 ? roundPrice(group.notional / group.fillCount) : null,
    tradeCount: group.tradeCount,
  }));
}

function polymarketTradeMatchesOrder(trade: Record<string, unknown>, orderId: string): boolean {
  if (String(trade.taker_order_id ?? "") === orderId) return true;
  const makerOrders = Array.isArray(trade.maker_orders) ? trade.maker_orders : [];
  return makerOrders.some((order) => recordOrNull(order)?.order_id === orderId);
}

function polymarketTradeFill(trades: Array<Record<string, unknown>>, orderId: string): { fillCount: number | null; fillPrice: number | null; tradeCount: number } {
  const matching = trades.filter((trade) => polymarketTradeMatchesOrder(trade, orderId));
  if (matching.length === 0) return { fillCount: null, fillPrice: null, tradeCount: 0 };
  let size = 0;
  let notional = 0;
  for (const trade of matching) {
    const tradeSize = finiteOrNull(trade.size) ?? 0;
    const tradePrice = finiteOrNull(trade.price) ?? 0;
    size += tradeSize;
    notional += tradeSize * tradePrice;
  }
  return {
    fillCount: size,
    fillPrice: size > 0 ? roundPrice(notional / size) : null,
    tradeCount: matching.length,
  };
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

    if (isLimitRestMode(context)) {
      return this.placeLimitRestOrder(leg, context, client, book, requestedAt);
    }

    const orderType = polymarketImmediateOrderType(this.config.polymarketOrderType, context);
    const requestedSpend = polymarketMarketBuySpend(context);
    const worstPrice = roundPrice(context.maxBuyPrice);
    const preflight = context.preflight;
    const preflightSignedOrderAgeMs = preflight?.polymarketSignedOrderCreatedAt == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, requestedAt - preflight.polymarketSignedOrderCreatedAt);
    const preflightFallbackReason = preflightSignedOrderFallbackReason(
      preflight,
      tokenId,
      worstPrice,
      requestedSpend,
      orderType,
      requestedAt,
      this.config.livePolymarketSignedOrderTtlMs,
    );
    const preflightSignedOrder = preflightFallbackReason == null ? preflight?.polymarketSignedOrder ?? null : null;
    if (!preflightSignedOrder && !client.createMarketOrder) {
      throw new Error(`Polymarket market ${orderType} order creation is not supported by the configured CLOB client`);
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
    const postStartedAt = Date.now();
    let payload: unknown;
    try {
      payload = await withMutedPolymarketClientLogs(() => client.postOrder(signedOrder, orderType));
    } catch (error) {
      const respondedAt = Date.now();
      const message = sanitizeError(error);
      const timeoutLike = isTimeoutLikeError(message);
      this.cachedReadiness = null;
      return {
        venue: this.venue,
        clientOrderId: context.clientOrderId,
        orderId: null,
        status: timeoutLike ? "unknown" : "failed",
        fillPrice: null,
        fillCount: null,
        requestedAt: isoFromMs(requestedAt),
        respondedAt: isoFromMs(respondedAt),
        error: `polymarket ${orderType} postOrder failed: ${message}`,
        fee: null,
        exchangeTimestampMs: null,
        signMs,
        metadata: {
          orderPlacementMode: context.placementMode ?? "parallel_fok",
          polymarketOrderType: orderType,
          polymarketMarketOrderStatus: timeoutLike ? "unknown" : "failed",
          polymarketFokStatus: timeoutLike ? "unknown" : "failed",
          polymarketRequestedSpend: requestedSpend,
          polymarketWorstPrice: worstPrice,
          polymarketRequestedShares: context.size,
          polymarketPostOrderMs: Math.max(0, respondedAt - postStartedAt),
          polymarketPostOrderError: message,
          polymarketSignedOrderReused: preflightSignedOrder != null,
          polymarketSignedOrderAgeMs: Number.isFinite(preflightSignedOrderAgeMs) ? preflightSignedOrderAgeMs : null,
          polymarketSignedOrderFallbackReason: preflightSignedOrder ? null : preflightFallbackReason,
          pendingReconciliation: timeoutLike,
          ...signedOrderMetadata(signedOrder),
        },
      };
    }
    const respondedAt = Date.now();
    const postOrderMs = Math.max(0, respondedAt - postStartedAt);
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
        orderPlacementMode: context.placementMode ?? "parallel_fok",
        polymarketOrderType: orderType,
        polymarketMarketOrderStatus: status || (success ? "unknown" : "rejected"),
        polymarketFokStatus: status || (success ? "unknown" : "rejected"),
        polymarketRequestedSpend: requestedSpend,
        polymarketWorstPrice: worstPrice,
        polymarketRequestedShares: context.size,
        polymarketTakingAmount: takingAmount,
        polymarketMakingAmount: makingAmount,
        polymarketSuccess: success,
        polymarketPostOrderMs: postOrderMs,
        polymarketSignedOrderReused: preflightSignedOrder != null,
        polymarketSignedOrderAgeMs: Number.isFinite(preflightSignedOrderAgeMs) ? preflightSignedOrderAgeMs : null,
        polymarketSignedOrderFallbackReason: preflightSignedOrder ? null : preflightFallbackReason,
        ...signedOrderMetadata(signedOrder),
      },
    };
  }

  private async placeLimitRestOrder(
    leg: ArbLeg,
    context: LiveOrderContext,
    client: PolymarketClobLike,
    book: Pick<OrderBookSummary, "min_order_size" | "tick_size" | "neg_risk">,
    requestedAt: number,
  ): Promise<VenueOrderResult> {
    if (!leg.tokenId) throw new Error("Polymarket token id is required for live trading");
    const worstPrice = roundPrice(context.maxBuyPrice);
    const signStartedAt = Date.now();
    const signedOrder = await client.createOrder({
      tokenID: leg.tokenId,
      price: worstPrice,
      size: context.size,
      side: Side.BUY,
      metadata: metadataFromClientOrderId(context.clientOrderId),
    }, {
      tickSize: book.tick_size as TickSize,
      negRisk: Boolean(book.neg_risk),
    });
    const signMs = Math.max(0, Date.now() - signStartedAt);
    const payload = await withMutedPolymarketClientLogs(() => client.postOrder(signedOrder, OrderType.GTC, false));
    const response = payload as Record<string, unknown>;
    const orderId = response.orderID == null ? null : String(response.orderID);
    const initialStatus = String(response.status ?? "");
    const success = response.success !== false;
    const takingAmount = finiteOrNull(response.takingAmount);
    const makingAmount = finiteOrNull(response.makingAmount);
    const initialFillCount = success && polymarketFilledStatus(initialStatus) ? takingAmount : 0;
    const initialFillPrice = initialFillCount != null && initialFillCount > 0 && makingAmount != null
      ? roundPrice(makingAmount / initialFillCount)
      : null;
    const initialResult: VenueOrderResult = {
      venue: this.venue,
      clientOrderId: context.clientOrderId,
      orderId,
      status: success
        ? isExactFillCount(initialFillCount, context.size) ? "filled" : initialStatus || "live"
        : initialStatus || "failed",
      fillPrice: initialFillPrice,
      fillCount: initialFillCount,
      requestedAt: isoFromMs(requestedAt),
      respondedAt: isoFromMs(Date.now()),
      error: success
        ? null
        : `polymarket GTC limit order rejected: ${sanitizeError(response.errorMsg ?? response.error ?? "unknown")}`,
      fee: null,
      exchangeTimestampMs: null,
      signMs,
      metadata: {
        orderPlacementMode: "parallel_limit_rest",
        limitRestMs: limitRestMs(context),
        polymarketOrderType: OrderType.GTC,
        polymarketInitialStatus: initialStatus || (success ? "unknown" : "rejected"),
        polymarketInitialFillCount: initialFillCount,
        polymarketLimitPrice: worstPrice,
        polymarketRequestedShares: context.size,
        polymarketTakingAmount: takingAmount,
        polymarketMakingAmount: makingAmount,
        polymarketSuccess: success,
      },
    };
    if (!success || isExactFillCount(initialFillCount, context.size)) return initialResult;
    return this.finalizePolymarketLimitRestOrder(leg, context, client, initialResult);
  }

  private async finalizePolymarketLimitRestOrder(
    leg: ArbLeg,
    context: LiveOrderContext,
    client: PolymarketClobLike,
    initialResult: VenueOrderResult,
  ): Promise<VenueOrderResult> {
    const restMs = limitRestMs(context);
    const orderId = initialResult.orderId;
    if (restMs > 0) await waitMs(restMs);

    let beforeCancel: Record<string, unknown> | null = null;
    let beforeCancelError: string | null = null;
    if (orderId && client.getOrder) {
      try {
        beforeCancel = recordOrNull(await withMutedPolymarketClientLogs(() => client.getOrder!(orderId)));
      } catch (error) {
        beforeCancelError = sanitizeError(error);
      }
    }
    const beforeFillCount = finiteOrNull(beforeCancel?.size_matched);
    if (isExactFillCount(beforeFillCount, context.size)) {
      return this.resultFromPolymarketFinalState(leg, context, client, initialResult, beforeCancel, {
        cancelStatus: "not_needed",
        finalFillSource: "pre_cancel_poll",
        beforeCancelError,
      });
    }

    let cancelStatus = "skipped_no_order_id";
    let cancelError: string | null = null;
    if (orderId) {
      if (!client.cancelOrder) {
        cancelStatus = "cancel_unavailable";
      } else {
        try {
          await withMutedPolymarketClientLogs(() => client.cancelOrder!({ orderID: orderId }));
          cancelStatus = "canceled";
        } catch (error) {
          cancelStatus = "cancel_failed";
          cancelError = sanitizeError(error);
        }
      }
    }

    let finalOrder: Record<string, unknown> | null = null;
    let finalFetchError: string | null = null;
    if (orderId && client.getOrder) {
      try {
        finalOrder = recordOrNull(await withMutedPolymarketClientLogs(() => client.getOrder!(orderId)));
      } catch (error) {
        finalFetchError = sanitizeError(error);
      }
    }
    return this.resultFromPolymarketFinalState(leg, context, client, initialResult, finalOrder ?? beforeCancel, {
      cancelStatus,
      cancelError,
      beforeCancelError,
      finalFetchError,
      finalFillSource: finalOrder ? "post_cancel_poll" : beforeCancel ? "pre_cancel_poll" : "initial_rest_response",
    });
  }

  private async resultFromPolymarketFinalState(
    _leg: ArbLeg,
    context: LiveOrderContext,
    client: PolymarketClobLike,
    initialResult: VenueOrderResult,
    finalOrder: Record<string, unknown> | null,
    metadata: {
      cancelStatus: string;
      cancelError?: string | null;
      beforeCancelError?: string | null;
      finalFetchError?: string | null;
      finalFillSource: string;
    },
  ): Promise<VenueOrderResult> {
    const orderId = initialResult.orderId;
    let openOrders: Array<Record<string, unknown>> = [];
    let openOrdersError: string | null = null;
    if (orderId && client.getOpenOrders) {
      try {
        openOrders = (await withMutedPolymarketClientLogs(() => client.getOpenOrders!({ id: orderId }, true)))
          .map((order) => recordOrNull(order))
          .filter((order): order is Record<string, unknown> => order != null);
      } catch (error) {
        openOrdersError = sanitizeError(error);
      }
    }
    let trades: Array<Record<string, unknown>> = [];
    let tradesError: string | null = null;
    if (orderId && client.getTrades) {
      try {
        trades = (await withMutedPolymarketClientLogs(() => client.getTrades!({ asset_id: String(finalOrder?.asset_id ?? "") || undefined }, true)))
          .map((trade) => recordOrNull(trade))
          .filter((trade): trade is Record<string, unknown> => trade != null);
      } catch (error) {
        tradesError = sanitizeError(error);
      }
    }
    const tradeFill = orderId ? polymarketTradeFill(trades, orderId) : { fillCount: null, fillPrice: null, tradeCount: 0 };
    const orderFillCount = finiteOrNull(finalOrder?.size_matched);
    const fillCount = orderFillCount ?? tradeFill.fillCount ?? initialResult.fillCount;
    const fillPrice = tradeFill.fillPrice ?? finiteOrNull(finalOrder?.price) ?? initialResult.fillPrice;
    const finalStatus = String(finalOrder?.status ?? "").trim() || (metadata.cancelStatus === "canceled" ? "canceled" : "unknown");
    const exactFill = isExactFillCount(fillCount, context.size);
    const hasOpenOrder = openOrders.length > 0 || ["live", "open", "delayed"].includes(finalStatus.toLowerCase());
    const cancelVerified = metadata.cancelStatus === "canceled" || metadata.cancelStatus === "not_needed";
    const status = exactFill
      ? "filled"
      : !cancelVerified || hasOpenOrder || openOrdersError
        ? "unknown"
        : finalStatus;
    const error = exactFill
      ? null
      : status === "unknown"
        ? `polymarket limit_rest cancellation/final state unverified${metadata.cancelError ? `: ${metadata.cancelError}` : ""}${openOrdersError ? `; open-order query failed: ${openOrdersError}` : ""}${metadata.finalFetchError ? `; final query failed: ${metadata.finalFetchError}` : ""}`
        : `polymarket limit_rest order canceled without exact fill (${exactFillError(this.venue, fillCount, context.size) ?? "final fill did not match requested size"})`;
    return {
      ...initialResult,
      status,
      fillPrice,
      fillCount,
      respondedAt: isoFromMs(Date.now()),
      error,
      metadata: {
        ...initialResult.metadata,
        polymarketFinalStatus: finalStatus,
        polymarketFinalFillCount: fillCount,
        polymarketFinalFillSource: metadata.finalFillSource,
        polymarketCancelStatus: metadata.cancelStatus,
        polymarketCancelError: metadata.cancelError ?? null,
        polymarketBeforeCancelError: metadata.beforeCancelError ?? null,
        polymarketFinalFetchError: metadata.finalFetchError ?? null,
        polymarketOpenOrderCount: openOrders.length,
        polymarketOpenOrdersError: openOrdersError,
        polymarketTradeCount: tradeFill.tradeCount,
        polymarketTradesError: tradesError,
      },
    };
  }

  async recoverTimedOutOrder(leg: ArbLeg, context: LiveOrderContext, timedOutResult: VenueOrderResult): Promise<VenueOrderResult | null> {
    if (!leg.tokenId) return null;
    const { client } = await this.client();
    const submittedAtMs = Number.isFinite(Date.parse(timedOutResult.requestedAt))
      ? Date.parse(timedOutResult.requestedAt)
      : context.requestedAt ?? Date.now();
    const deadline = Date.now() + Math.max(0, this.config.liveFinalRecoveryTimeoutMs);
    const pollMs = Math.max(25, this.config.liveFinalRecoveryPollMs);
    let attempts = 0;
    let lastStatus = "not_found";
    let lastError: string | null = null;

    while (Date.now() <= deadline) {
      attempts += 1;
      try {
        const recovered = timedOutResult.orderId
          ? await this.recoverPolymarketOrderById(client, leg, context, timedOutResult, submittedAtMs, attempts)
          : await this.recoverPolymarketOrderByEvidence(client, leg, context, timedOutResult, submittedAtMs, attempts);
        if (recovered) return recovered;
        lastStatus = "not_found";
      } catch (error) {
        lastStatus = "query_failed";
        lastError = sanitizeError(error);
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await waitMs(Math.min(pollMs, remainingMs));
    }

    return {
      ...timedOutResult,
      respondedAt: isoFromMs(Date.now()),
      metadata: {
        ...timedOutResult.metadata,
        polymarketTimeoutRecoveryAttempted: true,
        polymarketTimeoutRecoveryStatus: lastStatus,
        polymarketTimeoutRecoveryAttempts: attempts,
        polymarketTimeoutRecoveryError: lastError,
        finalizationMs: Math.max(0, Date.now() - submittedAtMs),
      },
    };
  }

  private async recoverPolymarketOrderById(
    client: PolymarketClobLike,
    leg: ArbLeg,
    context: LiveOrderContext,
    timedOutResult: VenueOrderResult,
    submittedAtMs: number,
    attempts: number,
  ): Promise<VenueOrderResult | null> {
    const orderId = timedOutResult.orderId;
    if (!orderId) return null;
    let order: Record<string, unknown> | null = null;
    let orderError: string | null = null;
    if (client.getOrder) {
      try {
        order = recordOrNull(await withMutedPolymarketClientLogs(() => client.getOrder!(orderId)));
      } catch (error) {
        orderError = sanitizeError(error);
      }
    }

    const trades = await this.fetchPolymarketTrades(client, leg.tokenId ?? undefined);
    const openOrders = await this.fetchPolymarketOpenOrders(client, leg.tokenId ?? undefined, orderId);
    const tradeFill = polymarketTradeFill(trades.records, orderId);
    const orderFillCount = finiteOrNull(order?.size_matched ?? order?.takingAmount);
    const fillCount = orderFillCount ?? tradeFill.fillCount ?? timedOutResult.fillCount;
    const fillPrice = tradeFill.fillPrice ?? finiteOrNull(order?.price) ?? timedOutResult.fillPrice;
    const finalStatus = String(order?.status ?? "").trim()
      || (tradeFill.tradeCount > 0 ? "matched" : openOrders.records.length > 0 ? "live" : "unknown");
    if (order == null && tradeFill.tradeCount === 0 && openOrders.records.length === 0) return null;
    return this.polymarketRecoveredResult(context, timedOutResult, {
      orderId: timedOutResult.orderId,
      fillCount,
      fillPrice,
      status: finalStatus,
      submittedAtMs,
      attempts,
      recoveryStatus: tradeFill.tradeCount > 0 ? "found_by_order_trades" : order ? "found_by_order_id" : "found_open_order",
      metadata: {
        polymarketTimeoutRecoveryOrderStatus: finalStatus,
        polymarketTimeoutRecoveryOrderError: orderError,
        polymarketTimeoutRecoveryOpenOrderCount: openOrders.records.length,
        polymarketTimeoutRecoveryOpenOrdersError: openOrders.error,
        polymarketTimeoutRecoveryTradeCount: tradeFill.tradeCount,
        polymarketTimeoutRecoveryTradesError: trades.error,
      },
    });
  }

  private async recoverPolymarketOrderByEvidence(
    client: PolymarketClobLike,
    leg: ArbLeg,
    context: LiveOrderContext,
    timedOutResult: VenueOrderResult,
    submittedAtMs: number,
    attempts: number,
  ): Promise<VenueOrderResult | null> {
    if (!leg.tokenId) return null;
    const trades = await this.fetchPolymarketTrades(client, leg.tokenId);
    const matchingTrades = trades.records.filter((trade) => polymarketTradeIsRecentBuyForToken(
      trade,
      leg.tokenId!,
      submittedAtMs,
      roundPrice(context.maxBuyPrice),
    ));
    const groups = polymarketTradeGroups(matchingTrades);
    if (groups.length === 1) {
      const group = groups[0]!;
      return this.polymarketRecoveredResult(context, timedOutResult, {
        orderId: group.orderId.startsWith("trade:") ? null : group.orderId,
        fillCount: group.fillCount,
        fillPrice: group.fillPrice,
        status: "matched",
        submittedAtMs,
        attempts,
        recoveryStatus: "found_unambiguous_recent_trade",
        metadata: {
          polymarketTimeoutRecoveryTradeCount: group.tradeCount,
          polymarketTimeoutRecoveryTradesError: trades.error,
          polymarketTimeoutRecoveryMatchedTradeGroups: groups.length,
          polymarketTimeoutRecoverySignedOrderSalt: timedOutResult.metadata?.polymarketSignedOrderSalt ?? null,
          polymarketTimeoutRecoverySignedOrderMakerAmount: timedOutResult.metadata?.polymarketSignedOrderMakerAmount ?? null,
          polymarketTimeoutRecoverySignedOrderTakerAmount: timedOutResult.metadata?.polymarketSignedOrderTakerAmount ?? null,
        },
      });
    }
    if (groups.length > 1) {
      return {
        ...timedOutResult,
        status: "unknown",
        respondedAt: isoFromMs(Date.now()),
        metadata: {
          ...timedOutResult.metadata,
          polymarketTimeoutRecoveryAttempted: true,
          polymarketTimeoutRecoveryStatus: "ambiguous_recent_trades",
          polymarketTimeoutRecoveryAttempts: attempts,
          polymarketTimeoutRecoveryMatchedTradeGroups: groups.length,
          polymarketTimeoutRecoveryTradeCount: matchingTrades.length,
          polymarketTimeoutRecoveryTradesError: trades.error,
          finalizationMs: Math.max(0, Date.now() - submittedAtMs),
        },
      };
    }

    const openOrders = await this.fetchPolymarketOpenOrders(client, leg.tokenId, null);
    const matchingOpenOrders = openOrders.records.filter((order) => {
      if (String(order.asset_id ?? "") !== leg.tokenId) return false;
      if (String(order.side ?? "").toUpperCase() !== String(Side.BUY).toUpperCase()) return false;
      const createdAtMs = parsePolymarketTimeMs(order.created_at);
      return createdAtMs == null || createdAtMs >= submittedAtMs - 1_000;
    });
    if (matchingOpenOrders.length > 0) {
      return {
        ...timedOutResult,
        orderId: matchingOpenOrders.length === 1 ? String(matchingOpenOrders[0]!.id ?? "") || null : null,
        status: "unknown",
        respondedAt: isoFromMs(Date.now()),
        metadata: {
          ...timedOutResult.metadata,
          polymarketTimeoutRecoveryAttempted: true,
          polymarketTimeoutRecoveryStatus: matchingOpenOrders.length === 1 ? "found_open_order" : "ambiguous_open_orders",
          polymarketTimeoutRecoveryAttempts: attempts,
          polymarketTimeoutRecoveryOpenOrderCount: matchingOpenOrders.length,
          polymarketTimeoutRecoveryOpenOrdersError: openOrders.error,
          polymarketTimeoutRecoveryTradesError: trades.error,
          finalizationMs: Math.max(0, Date.now() - submittedAtMs),
        },
      };
    }
    return null;
  }

  private async fetchPolymarketTrades(
    client: PolymarketClobLike,
    tokenId: string | undefined,
  ): Promise<{ records: Array<Record<string, unknown>>; error: string | null }> {
    if (!client.getTrades || !tokenId) return { records: [], error: "unavailable" };
    try {
      const records = (await withMutedPolymarketClientLogs(() => client.getTrades!({ asset_id: tokenId }, true)))
        .map((trade) => recordOrNull(trade))
        .filter((trade): trade is Record<string, unknown> => trade != null);
      return { records, error: null };
    } catch (error) {
      return { records: [], error: sanitizeError(error) };
    }
  }

  private async fetchPolymarketOpenOrders(
    client: PolymarketClobLike,
    tokenId: string | undefined,
    orderId: string | null,
  ): Promise<{ records: Array<Record<string, unknown>>; error: string | null }> {
    if (!client.getOpenOrders) return { records: [], error: "unavailable" };
    try {
      const params: { id?: string; asset_id?: string } = {};
      if (orderId) params.id = orderId;
      if (tokenId) params.asset_id = tokenId;
      const records = (await withMutedPolymarketClientLogs(() => client.getOpenOrders!(params, true)))
        .map((order) => recordOrNull(order))
        .filter((order): order is Record<string, unknown> => order != null);
      return { records, error: null };
    } catch (error) {
      return { records: [], error: sanitizeError(error) };
    }
  }

  private polymarketRecoveredResult(
    context: LiveOrderContext,
    timedOutResult: VenueOrderResult,
    recovery: {
      orderId: string | null;
      fillCount: number | null;
      fillPrice: number | null;
      status: string;
      submittedAtMs: number;
      attempts: number;
      recoveryStatus: string;
      metadata?: Record<string, unknown>;
    },
  ): VenueOrderResult {
    const fillError = exactFillError(this.venue, recovery.fillCount, context.size);
    const exact = fillError == null;
    const status = exact
      ? "filled"
      : (recovery.fillCount ?? 0) > 0
        ? "unexpected_fill_count"
        : recovery.status || "unfilled";
    return {
      ...timedOutResult,
      orderId: recovery.orderId ?? timedOutResult.orderId,
      status,
      fillCount: recovery.fillCount,
      fillPrice: recovery.fillPrice,
      respondedAt: isoFromMs(Date.now()),
      error: exact ? null : `polymarket timeout recovery found non-exact fill (${fillError ?? "no exact fill evidence"})`,
      metadata: {
        ...timedOutResult.metadata,
        polymarketTimeoutRecoveryAttempted: true,
        polymarketTimeoutRecoveryStatus: recovery.recoveryStatus,
        polymarketTimeoutRecoveryAttempts: recovery.attempts,
        polymarketTimeoutRecoveryFillCount: recovery.fillCount,
        polymarketTimeoutRecoveryFillPrice: recovery.fillPrice,
        finalizationMs: Math.max(0, Date.now() - recovery.submittedAtMs),
        ...recovery.metadata,
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
    if (isLimitRestMode(context)) return null;
    if (this.config.livePolymarketPresignEnabled) {
      try {
        const signStartedAt = Date.now();
        const { client } = await this.client();
        const orderType = polymarketImmediateOrderType(this.config.polymarketOrderType, context);
        if (!client.createMarketOrder) return `Polymarket market ${orderType} order creation is not supported by the configured CLOB client`;
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
          polymarketSignedOrderTokenId: leg.tokenId,
          polymarketSignedOrderPrice: roundPrice(context.maxBuyPrice),
          polymarketSignedOrderSpend: polymarketMarketBuySpend(context),
          polymarketSignedOrderType: orderType,
          polymarketSignedOrderSalt: signedOrderSalt(signedOrder),
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
