import type { AppConfig } from "../config";
import type {
  ArbCandidate,
  DashboardSignal,
  FillQualitySnapshot,
  LiveOrderPlacementMode,
  QuoteSnapshot,
  QuoteSnapshotLeg,
  Venue,
  VenueConfirmations,
} from "../types";
import { economicFillPriceForSignalVenue } from "./economic-prices";

export interface FillQualityVenueEvent {
  venue?: Venue | null;
  type?: string | null;
  status?: string | null;
  receivedAtMs?: number | null;
  payload?: Record<string, unknown> | null;
}

export interface ScoreFillQualityInput {
  candidate: ArbCandidate;
  quoteSnapshot: QuoteSnapshot;
  recentSignals: DashboardSignal[];
  recentVenueEvents?: FillQualityVenueEvent[];
  config: AppConfig;
  nowMs: number;
  placementMode: LiveOrderPlacementMode;
}

const EPSILON = 0.000001;

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function roundMs(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value);
}

function bounded(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampProbability(value: number): number {
  return roundMetric(bounded(value, 0.01, 0.99));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numeric(value: unknown): number | null {
  if (finiteNumber(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function average(values: Array<number | null | undefined>): number | null {
  const numericValues = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (numericValues.length === 0) return null;
  return roundMetric(numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length);
}

function percentile(values: Array<number | null | undefined>, p: number): number | null {
  const numericValues = values
    .filter((value): value is number => value != null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (numericValues.length === 0) return null;
  const index = bounded(Math.ceil((p / 100) * numericValues.length) - 1, 0, numericValues.length - 1);
  return roundMs(numericValues[index]);
}

function confirmationNumber(confirmations: VenueConfirmations | null | undefined, venue: Venue, key: string): number | null {
  const value = confirmations?.[venue];
  if (!value || typeof value !== "object") return null;
  return numeric((value as Record<string, unknown>)[key]);
}

function confirmationString(confirmations: VenueConfirmations | null | undefined, venue: Venue, key: string): string | null {
  const value = confirmations?.[venue];
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function confirmationBoolean(confirmations: VenueConfirmations | null | undefined, venue: Venue, key: string): boolean | null {
  const value = confirmations?.[venue];
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "boolean" ? raw : null;
}

function isVenueExactFill(signal: DashboardSignal, venue: Venue, orderSize: number): boolean {
  const status = String(venue === "kalshi" ? signal.kalshiStatus ?? "" : signal.polymarketStatus ?? "").toLowerCase();
  const count = venue === "kalshi" ? signal.kalshiFillCount ?? 0 : signal.polymarketFillCount ?? 0;
  return count > 0
    && Math.abs(count - orderSize) <= EPSILON
    && !["failed", "unknown", "timeout", "not_submitted", "unexpected_fill_count"].includes(status);
}

function isExactPair(signal: DashboardSignal, orderSize: number): boolean {
  return signal.action === "filled"
    && signal.partialFill !== true
    && isVenueExactFill(signal, "kalshi", orderSize)
    && isVenueExactFill(signal, "polymarket", orderSize);
}

function isTimeoutOrUnknown(signal: DashboardSignal): boolean {
  const kalshiStatus = String(signal.kalshiStatus ?? "").toLowerCase();
  const polymarketStatus = String(signal.polymarketStatus ?? "").toLowerCase();
  const kalshiError = String(signal.kalshiError ?? "").toLowerCase();
  const polymarketError = String(signal.polymarketError ?? "").toLowerCase();
  const rtt = signal.executionTimings?.polymarketOrderRttMs ?? signal.executionTimings?.polymarketRttMs ?? null;
  return kalshiStatus === "unknown"
    || polymarketStatus === "unknown"
    || kalshiError.includes("timeout")
    || polymarketError.includes("timeout")
    || polymarketError.includes("timed out")
    || (rtt != null && Number.isFinite(rtt) && rtt >= 2_400);
}

function isMismatch(signal: DashboardSignal, orderSize: number): boolean {
  const kalshiCount = signal.kalshiFillCount ?? 0;
  const polymarketCount = signal.polymarketFillCount ?? 0;
  return signal.partialFill === true
    || Math.abs(kalshiCount - polymarketCount) > EPSILON
    || (kalshiCount > 0 && Math.abs(kalshiCount - orderSize) > EPSILON)
    || (polymarketCount > 0 && Math.abs(polymarketCount - orderSize) > EPSILON)
    || ["unknown", "unexpected_fill_count"].includes(String(signal.kalshiStatus ?? "").toLowerCase())
    || ["unknown", "unexpected_fill_count"].includes(String(signal.polymarketStatus ?? "").toLowerCase());
}

function mismatchCost(signal: DashboardSignal): number | null {
  const kalshiCount = signal.kalshiFillCount ?? 0;
  const polymarketCount = signal.polymarketFillCount ?? 0;
  const delta = Math.abs(kalshiCount - polymarketCount);
  if (delta <= EPSILON) return signal.riskQuarantineExposureDollars ?? null;
  const kalshiFillPrice = economicFillPriceForSignalVenue(signal, "kalshi", signal.kalshiFillPrice);
  const polymarketFillPrice = economicFillPriceForSignalVenue(signal, "polymarket", signal.polymarketFillPrice);
  if (kalshiCount > polymarketCount && kalshiFillPrice != null) return roundMetric(delta * kalshiFillPrice);
  if (polymarketCount > kalshiCount && polymarketFillPrice != null) return roundMetric(delta * polymarketFillPrice);
  return signal.riskQuarantineExposureDollars ?? null;
}

function rate(count: number, sampleCount: number): number | null {
  return sampleCount === 0 ? null : roundMetric(count / sampleCount);
}

function legDepthRatio(leg: QuoteSnapshotLeg | null): number | null {
  if (!leg || leg.depthRequired <= 0) return null;
  return roundMetric(leg.depth / leg.depthRequired);
}

function priceDelta(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return roundMetric(Math.max(0, a - b));
}

function addPenalty(
  reasons: string[],
  currentProbability: number,
  amount: number,
  reason: string,
): number {
  if (amount <= 0) return currentProbability;
  reasons.push(reason);
  return currentProbability - amount;
}

function statusLabel(shadowMode: boolean, gatePassed: boolean): "shadow" | "pass" | "fail" {
  if (shadowMode) return "shadow";
  return gatePassed ? "pass" : "fail";
}

export function fillQualityStatusLabel(snapshot: FillQualitySnapshot | null | undefined): "shadow" | "pass" | "fail" | null {
  return snapshot ? statusLabel(snapshot.shadowMode, snapshot.gatePassed) : null;
}

export function fillQualityBlockReason(snapshot: FillQualitySnapshot | null | undefined): string | null {
  return snapshot?.gateEnabled && !snapshot.gatePassed ? snapshot.blockReason : null;
}

export function scoreFillQuality(input: ScoreFillQualityInput): FillQualitySnapshot {
  const { candidate, quoteSnapshot, config, nowMs, placementMode } = input;
  const sampleLimit = Math.max(1, Math.floor(config.liveFillQualitySampleLimit));
  const samples = input.recentSignals.slice(0, sampleLimit);
  const sampleCount = samples.length;
  const minSamples = Math.max(1, Math.floor(config.liveFillQualityMinSamples));
  const coldStart = sampleCount < minSamples;
  const orderSize = config.liveOrderSize;
  const projectedEdgeAtLimit = quoteSnapshot.projectedEdgeAtLimit ?? quoteSnapshot.projectedEdgeAfterFees ?? quoteSnapshot.projectedEdge ?? candidate.guaranteedProfit ?? null;
  const recentExactPairs = samples.filter((signal) => isExactPair(signal, orderSize)).length;
  const recentMismatches = samples.filter((signal) => isMismatch(signal, orderSize)).length;
  const recentTimeouts = samples.filter(isTimeoutOrUnknown).length;
  const kalshiExactFills = samples.filter((signal) => isVenueExactFill(signal, "kalshi", orderSize)).length;
  const polymarketExactFills = samples.filter((signal) => isVenueExactFill(signal, "polymarket", orderSize)).length;
  const exactPairRate = rate(recentExactPairs, sampleCount);
  const mismatchRate = rate(recentMismatches, sampleCount);
  const timeoutRate = rate(recentTimeouts, sampleCount);
  const kalshiRecentExactFillRate = rate(kalshiExactFills, sampleCount);
  const polymarketRecentExactFillRate = rate(polymarketExactFills, sampleCount);
  const sameExpiryAttemptCount = samples.filter((signal) => signal.expiryMs === candidate.expiryMs && signal.executionGroupId != null).length;
  const avgMismatchCost = average(samples.map(mismatchCost));
  const kalshiRtts = samples.map((signal) => signal.executionTimings?.kalshiOrderRttMs ?? signal.executionTimings?.kalshiRttMs ?? null);
  const polymarketRtts = samples.map((signal) => signal.executionTimings?.polymarketOrderRttMs ?? signal.executionTimings?.polymarketRttMs ?? null);
  const kalshiConfirmationLags = samples.map((signal) => confirmationNumber(signal.venueConfirmations, "kalshi", "confirmationLagMs"));
  const polymarketConfirmationLags = samples.map((signal) => signal.executionTimings?.polymarketConfirmationMs ?? confirmationNumber(signal.venueConfirmations, "polymarket", "confirmationLagMs"));
  const signedReuseRate = rate(samples.filter((signal) => confirmationBoolean(signal.venueConfirmations, "polymarket", "polymarketSignedOrderReused") === true).length, sampleCount);
  const signedFallbackRate = rate(samples.filter((signal) => confirmationString(signal.venueConfirmations, "polymarket", "polymarketSignedOrderFallbackReason") != null).length, sampleCount);
  const kalshiRttP95 = percentile(kalshiRtts, 95);
  const polymarketRttP95 = percentile(polymarketRtts, 95);
  const penaltyReasons: string[] = [];

  let kalshiProbability = coldStart ? 0.82 : kalshiRecentExactFillRate ?? 0.82;
  let polymarketProbability = coldStart ? 0.48 : polymarketRecentExactFillRate ?? 0.48;

  const kalshiDepthRatio = legDepthRatio(quoteSnapshot.kalshi);
  const polymarketDepthRatio = legDepthRatio(quoteSnapshot.polymarket);
  if (kalshiDepthRatio != null && kalshiDepthRatio <= 1.05) kalshiProbability = addPenalty(penaltyReasons, kalshiProbability, 0.06, "Kalshi depth is exactly thin");
  if (polymarketDepthRatio != null && polymarketDepthRatio <= 1.05) polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.10, "Polymarket depth is exactly thin");
  if ((quoteSnapshot.kalshi?.quoteAgeMs ?? 0) > config.liveQuoteMaxAgeMs * 0.75) kalshiProbability = addPenalty(penaltyReasons, kalshiProbability, 0.05, "Kalshi quote is aging");
  if ((quoteSnapshot.polymarket?.quoteAgeMs ?? 0) > config.liveQuoteMaxAgeMs * 0.75) polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.08, "Polymarket quote is aging");
  if ((quoteSnapshot.quoteSkewMs ?? 0) > config.liveQuoteSyncMaxSkewMs * 0.75) {
    kalshiProbability = addPenalty(penaltyReasons, kalshiProbability, 0.04, "Cross-venue quote skew is high");
    polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.06, "Cross-venue quote skew is high");
  }
  if ((quoteSnapshot.kalshi?.spread ?? 0) >= 0.08) kalshiProbability = addPenalty(penaltyReasons, kalshiProbability, 0.04, "Kalshi spread is wide");
  if ((quoteSnapshot.polymarket?.spread ?? 0) >= 0.08) polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.07, "Polymarket spread is wide");
  if (polymarketRttP95 != null && polymarketRttP95 >= config.liveOrderTimeoutMs * 0.85) polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.12, "Polymarket p95 RTT is near timeout");
  if (kalshiRttP95 != null && kalshiRttP95 >= config.liveOrderTimeoutMs * 0.85) kalshiProbability = addPenalty(penaltyReasons, kalshiProbability, 0.08, "Kalshi p95 RTT is near timeout");
  if ((signedFallbackRate ?? 0) >= 0.2) polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.07, "Polymarket signed-order fallback rate is elevated");
  if ((mismatchRate ?? 0) >= 0.35) polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.10, "Recent mismatch rate is elevated");
  if ((timeoutRate ?? 0) >= 0.2) polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.10, "Recent timeout/unknown rate is elevated");
  const leadLag = quoteSnapshot.leadLagSnapshot ?? null;
  if (leadLag && leadLag.confidence >= config.liveLeadLagMinConfidence) {
    if (leadLag.leaderVenue === "polymarket") {
      polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.10, "Lead/lag shows Polymarket leading");
    }
    if (leadLag.adverseSelectionScore >= config.liveLeadLagMaxAdverseSelectionScore) {
      polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.08, "Lead/lag adverse selection is elevated");
    }
    if (leadLag.cheapLegIsLagging === false) {
      polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.04, "Cheap leg is not the lagging venue");
    }
  }
  if (sameExpiryAttemptCount >= config.liveMaxTradesPerWindow) polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.08, "Same-expiry attempt count is at cap");
  const secondsToExpiry = roundMetric((candidate.expiryMs - nowMs) / 1_000);
  if (secondsToExpiry < 120) {
    kalshiProbability = addPenalty(penaltyReasons, kalshiProbability, 0.06, "Expiry window is inside 120s");
    polymarketProbability = addPenalty(penaltyReasons, polymarketProbability, 0.08, "Expiry window is inside 120s");
  }

  kalshiProbability = clampProbability(kalshiProbability);
  polymarketProbability = clampProbability(polymarketProbability);
  const pairedFillProbability = clampProbability(kalshiProbability * polymarketProbability);
  const kalshiSlippage = priceDelta(quoteSnapshot.kalshi?.maxBuyPrice ?? quoteSnapshot.kalshiMaxBuyPrice, quoteSnapshot.kalshi?.vwap);
  const polymarketSlippage = priceDelta(quoteSnapshot.polymarket?.maxBuyPrice ?? quoteSnapshot.polymarketMaxBuyPrice, quoteSnapshot.polymarket?.vwap);
  const expectedSlippage = roundMetric(((kalshiSlippage ?? 0) + (polymarketSlippage ?? 0)) * (1 - pairedFillProbability));
  const expectedMismatchCost = roundMetric((mismatchRate ?? (coldStart ? 0.25 : 0)) * (avgMismatchCost ?? 0));
  const kalshiMaxBuyPrice = quoteSnapshot.kalshi?.maxBuyPrice ?? quoteSnapshot.kalshiMaxBuyPrice ?? quoteSnapshot.kalshi?.worstAsk ?? 0;
  const polymarketMaxBuyPrice = quoteSnapshot.polymarket?.maxBuyPrice ?? quoteSnapshot.polymarketMaxBuyPrice ?? quoteSnapshot.polymarket?.worstAsk ?? 0;
  const timeoutExposure = Math.max(orderSize * polymarketMaxBuyPrice, orderSize * kalshiMaxBuyPrice);
  const timeoutCost = roundMetric((timeoutRate ?? (coldStart ? 0.15 : 0)) * timeoutExposure * 0.25);
  const expectedExecutableEdge = projectedEdgeAtLimit == null
    ? null
    : roundMetric(projectedEdgeAtLimit * pairedFillProbability - expectedSlippage - expectedMismatchCost - timeoutCost);
  const gateEnabled = config.liveFillQualityGateEnabled;
  const shadowMode = !gateEnabled;
  const gatePassed = !gateEnabled || expectedExecutableEdge == null || expectedExecutableEdge >= config.liveFillQualityMinExpectedEdge;
  const blockReason = gateEnabled && !gatePassed && expectedExecutableEdge != null
    ? `fill-quality expected executable edge ${expectedExecutableEdge.toFixed(4)} below threshold ${config.liveFillQualityMinExpectedEdge.toFixed(4)}`
    : null;

  return {
    version: config.liveFillQualityModelVersion,
    scoredAt: nowMs,
    shadowMode,
    gateEnabled,
    gatePassed,
    blockReason,
    projectedEdgeAtLimit: projectedEdgeAtLimit == null ? null : roundMetric(projectedEdgeAtLimit),
    expectedExecutableEdge,
    minExpectedEdge: config.liveFillQualityMinExpectedEdge,
    pairedFillProbability,
    kalshiExactFillProbability: kalshiProbability,
    polymarketExactFillProbability: polymarketProbability,
    expectedSlippage,
    expectedMismatchCost,
    timeoutCost,
    penaltyReasons,
    features: {
      sampleCount,
      minSamples,
      coldStart,
      orderSize,
      placementMode,
      kalshiDepth: quoteSnapshot.kalshi?.depth ?? null,
      polymarketDepth: quoteSnapshot.polymarket?.depth ?? null,
      kalshiDepthRatio,
      polymarketDepthRatio,
      kalshiSpread: quoteSnapshot.kalshi?.spread ?? null,
      polymarketSpread: quoteSnapshot.polymarket?.spread ?? null,
      kalshiQuoteAgeMs: quoteSnapshot.kalshi?.quoteAgeMs ?? null,
      polymarketQuoteAgeMs: quoteSnapshot.polymarket?.quoteAgeMs ?? null,
      quoteSkewMs: quoteSnapshot.quoteSkewMs,
      secondsToExpiry,
      sameExpiryAttemptCount,
      recentExactPairFillRate: exactPairRate,
      recentMismatchRate: mismatchRate,
      recentTimeoutRate: timeoutRate,
      kalshiRecentExactFillRate,
      polymarketRecentExactFillRate,
      kalshiRttP50Ms: percentile(kalshiRtts, 50),
      kalshiRttP95Ms: kalshiRttP95,
      polymarketRttP50Ms: percentile(polymarketRtts, 50),
      polymarketRttP95Ms: polymarketRttP95,
      kalshiConfirmationP95Ms: percentile(kalshiConfirmationLags, 95),
      polymarketConfirmationP95Ms: percentile(polymarketConfirmationLags, 95),
      polymarketSignedOrderReuseRate: signedReuseRate,
      polymarketSignedOrderFallbackRate: signedFallbackRate,
      recentVenueEventCount: input.recentVenueEvents?.length ?? 0,
      leadLagLeaderVenue: leadLag?.leaderVenue ?? null,
      leadLagConfidence: leadLag?.confidence ?? null,
      leadLagStalenessScore: leadLag?.stalenessScore ?? null,
      leadLagAdverseSelectionScore: leadLag?.adverseSelectionScore ?? null,
      leadLagCheapLegIsLagging: leadLag?.cheapLegIsLagging ?? null,
    },
  };
}
