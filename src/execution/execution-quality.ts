import type { ArbCandidate, DashboardSignal, LiveExecutionQualityStatus } from "../types";
import { economicFillPriceForSignalVenue } from "./economic-prices";

export interface LiveExecutionQualityOptions {
  enabled: boolean;
  lookbackMs: number;
  sampleLimit: number;
  minSamples: number;
  minExactFillRate: number;
}

const EPSILON = 0.000001;

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function isExactPair(signal: DashboardSignal): boolean {
  const kalshiCount = signal.kalshiFillCount ?? 0;
  const polymarketCount = signal.polymarketFillCount ?? 0;
  return signal.action === "filled"
    && signal.partialFill !== true
    && kalshiCount > 0
    && polymarketCount > 0
    && Math.abs(kalshiCount - polymarketCount) <= EPSILON;
}

function isPolymarketTimeoutOrUnknown(signal: DashboardSignal): boolean {
  const status = String(signal.polymarketStatus ?? "").toLowerCase();
  const error = String(signal.polymarketError ?? "").toLowerCase();
  return status === "unknown" || error.includes("timeout") || error.includes("timed out");
}

function isMismatch(signal: DashboardSignal): boolean {
  const kalshiCount = signal.kalshiFillCount ?? 0;
  const polymarketCount = signal.polymarketFillCount ?? 0;
  return signal.partialFill === true
    || Math.abs(kalshiCount - polymarketCount) > EPSILON
    || ["unknown", "unexpected_fill_count"].includes(String(signal.kalshiStatus ?? "").toLowerCase())
    || ["unknown", "unexpected_fill_count"].includes(String(signal.polymarketStatus ?? "").toLowerCase());
}

function average(values: number[]): number | null {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (numeric.length === 0) return null;
  return roundMetric(numeric.reduce((sum, value) => sum + value, 0) / numeric.length);
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

export function buildLiveExecutionQualityStatus(
  signals: DashboardSignal[],
  candidate: ArbCandidate | null,
  options: LiveExecutionQualityOptions,
): LiveExecutionQualityStatus {
  const sampleLimit = Math.max(1, Math.floor(options.sampleLimit));
  const samples = signals.slice(0, sampleLimit);
  const sampleCount = samples.length;
  const exactPairs = samples.filter(isExactPair).length;
  const exactPairFillRate = sampleCount === 0 ? null : roundMetric(exactPairs / sampleCount);
  const polymarketTimeoutRate = sampleCount === 0 ? null : roundMetric(samples.filter(isPolymarketTimeoutOrUnknown).length / sampleCount);
  const mismatchRate = sampleCount === 0 ? null : roundMetric(samples.filter(isMismatch).length / sampleCount);
  const avgPolymarketRttMs = average(samples
    .map((signal) => signal.executionTimings?.polymarketOrderRttMs ?? signal.executionTimings?.polymarketRttMs ?? null)
    .filter((value): value is number => value != null && Number.isFinite(value)));
  const avgMismatchCostDollars = average(samples
    .map(mismatchCost)
    .filter((value): value is number => value != null && Number.isFinite(value)));
  const projectedEdge = candidate?.guaranteedProfit ?? null;
  const estimatedExecutableEdge = projectedEdge == null || exactPairFillRate == null
    ? null
    : roundMetric(projectedEdge * exactPairFillRate - (avgMismatchCostDollars ?? 0));

  let reason: string | null = null;
  if (!options.enabled) {
    reason = null;
  } else if (sampleCount >= options.minSamples && exactPairFillRate != null && exactPairFillRate < options.minExactFillRate) {
    reason = `live execution quality blocked: Polymarket exact paired fill rate ${(exactPairFillRate * 100).toFixed(1)}% below ${(options.minExactFillRate * 100).toFixed(1)}% over ${sampleCount} samples`;
  } else if (sampleCount >= options.minSamples && estimatedExecutableEdge != null && estimatedExecutableEdge < 0) {
    reason = `live execution quality blocked: estimated executable edge ${estimatedExecutableEdge.toFixed(4)} below 0 after recent fill/mismatch costs`;
  }

  return {
    enabled: options.enabled,
    ok: reason == null,
    reason,
    sampleCount,
    lookbackMs: options.lookbackMs,
    sampleLimit,
    minSamples: options.minSamples,
    minExactFillRate: options.minExactFillRate,
    exactPairFillRate,
    polymarketTimeoutRate,
    mismatchRate,
    avgPolymarketRttMs,
    avgMismatchCostDollars,
    estimatedExecutableEdge,
  };
}

export function liveExecutionQualityBlockReason(status: LiveExecutionQualityStatus): string | null {
  return status.enabled && !status.ok ? status.reason : null;
}
