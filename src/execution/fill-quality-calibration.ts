import type { FillQualitySnapshot, SignalAction } from "../types";

export interface FillQualityCalibrationRow {
  id: number;
  createdAt: string | null;
  updatedAt: string | null;
  action: SignalAction;
  partialFill: boolean;
  kalshiStatus: string | null;
  polymarketStatus: string | null;
  kalshiError: string | null;
  polymarketError: string | null;
  kalshiFillCount: number | null;
  polymarketFillCount: number | null;
  executionGroupId: string | null;
  fillQualitySnapshot: FillQualitySnapshot | null;
  expectedExecutableEdge: number | null;
  realizedGuaranteedProfit: number | null;
}

export interface FillQualityCalibrationOptions {
  minExpectedEdge?: number;
  minSamples?: number;
  badAttemptReductionTarget?: number;
  maxProfitableFillEliminationRate?: number;
  minTopBottomExactFillRateSpread?: number;
}

export interface FillQualityCalibrationBucket {
  label: string;
  count: number;
  exactPairedFills: number;
  partials: number;
  unknownOrTimeouts: number;
  badAttempts: number;
  exactPairFillRate: number | null;
  badAttemptRate: number | null;
  avgExpectedExecutableEdge: number | null;
  avgRealizedEdge: number | null;
}

export interface FillQualityCalibrationReport {
  generatedAt: string;
  thresholds: {
    minExpectedEdge: number;
    minSamples: number;
    badAttemptReductionTarget: number;
    maxProfitableFillEliminationRate: number;
    minTopBottomExactFillRateSpread: number;
  };
  summary: {
    sampleCount: number;
    firstScoredAt: string | null;
    lastScoredAt: string | null;
    exactPairedFills: number;
    profitableExactPairedFills: number;
    partials: number;
    unknownOrTimeouts: number;
    failures: number;
    badAttempts: number;
  };
  pairedFillProbabilityBuckets: FillQualityCalibrationBucket[];
  expectedExecutableEdgeDeciles: FillQualityCalibrationBucket[];
  gateSimulation: {
    allowed: number;
    blocked: number;
    allowedBadAttempts: number;
    blockedBadAttempts: number;
    allowedProfitableExactFills: number;
    blockedProfitableExactFills: number;
    badAttemptReductionRate: number | null;
    profitableFillEliminationRate: number | null;
  };
  directionality: {
    bottomHalfExactFillRate: number | null;
    topHalfExactFillRate: number | null;
    spread: number | null;
    passed: boolean;
  };
  promotion: {
    passed: boolean;
    reasons: string[];
  };
}

const DEFAULT_MIN_EXPECTED_EDGE = 0.01;
const DEFAULT_MIN_SAMPLES = 200;
const DEFAULT_BAD_ATTEMPT_REDUCTION_TARGET = 0.25;
const DEFAULT_MAX_PROFITABLE_FILL_ELIMINATION_RATE = 0.5;
const DEFAULT_MIN_TOP_BOTTOM_EXACT_FILL_RATE_SPREAD = 0.1;
const EPSILON = 0.000001;

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function average(values: Array<number | null | undefined>): number | null {
  const numericValues = values.filter((value): value is number => finiteNumber(value));
  if (numericValues.length === 0) return null;
  return roundMetric(numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length);
}

function rate(count: number, total: number): number | null {
  return total === 0 ? null : roundMetric(count / total);
}

function normalizedStatus(value: string | null): string {
  return (value ?? "").toLowerCase();
}

function isUnknownOrTimeout(row: FillQualityCalibrationRow): boolean {
  const statuses = [row.kalshiStatus, row.polymarketStatus].map(normalizedStatus);
  const errors = [row.kalshiError, row.polymarketError].map(normalizedStatus);
  return (
    statuses.some((status) => status === "unknown" || status === "timeout") ||
    errors.some((error) => error.includes("timeout") || error.includes("timed out") || error.includes("unknown"))
  );
}

function orderSize(row: FillQualityCalibrationRow): number | null {
  const size = row.fillQualitySnapshot?.features.orderSize;
  return finiteNumber(size) && size > 0 ? size : null;
}

function isExactPair(row: FillQualityCalibrationRow): boolean {
  const kalshiCount = row.kalshiFillCount ?? 0;
  const polymarketCount = row.polymarketFillCount ?? 0;
  if (row.action !== "filled" || row.partialFill || kalshiCount <= 0 || polymarketCount <= 0) return false;
  const size = orderSize(row);
  if (size != null) return Math.abs(kalshiCount - size) <= EPSILON && Math.abs(polymarketCount - size) <= EPSILON;
  return Math.abs(kalshiCount - polymarketCount) <= EPSILON;
}

function isProfitableExactPair(row: FillQualityCalibrationRow): boolean {
  return isExactPair(row) && (row.realizedGuaranteedProfit ?? 0) > 0;
}

function isBadAttempt(row: FillQualityCalibrationRow): boolean {
  return (
    row.partialFill ||
    row.action === "failed" ||
    isUnknownOrTimeout(row) ||
    !isProfitableExactPair(row) ||
    (row.realizedGuaranteedProfit != null && row.realizedGuaranteedProfit <= 0)
  );
}

function expectedEdge(row: FillQualityCalibrationRow): number | null {
  return row.expectedExecutableEdge ?? row.fillQualitySnapshot?.expectedExecutableEdge ?? null;
}

function pairedFillProbability(row: FillQualityCalibrationRow): number | null {
  return row.fillQualitySnapshot?.pairedFillProbability ?? null;
}

function isBlockedBySimulatedGate(row: FillQualityCalibrationRow, minExpectedEdge: number): boolean {
  const value = expectedEdge(row);
  return value != null && value < minExpectedEdge;
}

function bucketStats(label: string, rows: FillQualityCalibrationRow[]): FillQualityCalibrationBucket {
  const exactPairedFills = rows.filter(isExactPair).length;
  const partials = rows.filter((row) => row.partialFill).length;
  const unknownOrTimeouts = rows.filter(isUnknownOrTimeout).length;
  const badAttempts = rows.filter(isBadAttempt).length;
  return {
    label,
    count: rows.length,
    exactPairedFills,
    partials,
    unknownOrTimeouts,
    badAttempts,
    exactPairFillRate: rate(exactPairedFills, rows.length),
    badAttemptRate: rate(badAttempts, rows.length),
    avgExpectedExecutableEdge: average(rows.map(expectedEdge)),
    avgRealizedEdge: average(rows.map((row) => row.realizedGuaranteedProfit)),
  };
}

function probabilityBuckets(rows: FillQualityCalibrationRow[]): FillQualityCalibrationBucket[] {
  const buckets = new Map<number, FillQualityCalibrationRow[]>();
  for (const row of rows) {
    const probability = pairedFillProbability(row);
    if (probability == null) continue;
    const index = Math.min(9, Math.max(0, Math.floor(probability * 10)));
    buckets.set(index, [...(buckets.get(index) ?? []), row]);
  }
  return Array.from(buckets.entries())
    .sort(([left], [right]) => left - right)
    .map(([index, bucketRows]) =>
      bucketStats(`${(index / 10).toFixed(1)}-${((index + 1) / 10).toFixed(1)}`, bucketRows),
    );
}

function expectedEdgeDeciles(rows: FillQualityCalibrationRow[]): FillQualityCalibrationBucket[] {
  const sorted = rows
    .filter((row) => expectedEdge(row) != null)
    .sort((left, right) => (expectedEdge(left) ?? 0) - (expectedEdge(right) ?? 0));
  if (sorted.length === 0) return [];
  const grouped = new Map<number, FillQualityCalibrationRow[]>();
  sorted.forEach((row, index) => {
    const decile = Math.min(9, Math.floor((index * 10) / sorted.length));
    grouped.set(decile, [...(grouped.get(decile) ?? []), row]);
  });
  return Array.from(grouped.entries())
    .sort(([left], [right]) => left - right)
    .map(([index, bucketRows]) => {
      const values = bucketRows.map(expectedEdge).filter((value): value is number => value != null);
      const min = values.length === 0 ? null : Math.min(...values);
      const max = values.length === 0 ? null : Math.max(...values);
      const label = min == null || max == null ? `D${index + 1}` : `D${index + 1} ${min.toFixed(3)}..${max.toFixed(3)}`;
      return bucketStats(label, bucketRows);
    });
}

function directionality(
  rows: FillQualityCalibrationRow[],
  minSpread: number,
): FillQualityCalibrationReport["directionality"] {
  const sorted = rows
    .filter((row) => pairedFillProbability(row) != null)
    .sort((left, right) => (pairedFillProbability(left) ?? 0) - (pairedFillProbability(right) ?? 0));
  if (sorted.length < 2) {
    return { bottomHalfExactFillRate: null, topHalfExactFillRate: null, spread: null, passed: false };
  }
  const midpoint = Math.floor(sorted.length / 2);
  const bottom = sorted.slice(0, midpoint);
  const top = sorted.slice(midpoint);
  const bottomRate = rate(bottom.filter(isExactPair).length, bottom.length);
  const topRate = rate(top.filter(isExactPair).length, top.length);
  const spread = bottomRate == null || topRate == null ? null : roundMetric(topRate - bottomRate);
  return {
    bottomHalfExactFillRate: bottomRate,
    topHalfExactFillRate: topRate,
    spread,
    passed: spread != null && spread >= minSpread,
  };
}

export function buildFillQualityCalibrationReport(
  inputRows: FillQualityCalibrationRow[],
  options: FillQualityCalibrationOptions = {},
  generatedAt = new Date(),
): FillQualityCalibrationReport {
  const minExpectedEdge = options.minExpectedEdge ?? DEFAULT_MIN_EXPECTED_EDGE;
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const badAttemptReductionTarget = options.badAttemptReductionTarget ?? DEFAULT_BAD_ATTEMPT_REDUCTION_TARGET;
  const maxProfitableFillEliminationRate =
    options.maxProfitableFillEliminationRate ?? DEFAULT_MAX_PROFITABLE_FILL_ELIMINATION_RATE;
  const minTopBottomExactFillRateSpread =
    options.minTopBottomExactFillRateSpread ?? DEFAULT_MIN_TOP_BOTTOM_EXACT_FILL_RATE_SPREAD;
  const rows = inputRows.filter((row) => row.executionGroupId != null && row.fillQualitySnapshot != null);
  const sortedByTime = rows
    .filter((row) => row.createdAt != null)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const blocked = rows.filter((row) => isBlockedBySimulatedGate(row, minExpectedEdge));
  const allowed = rows.filter((row) => !isBlockedBySimulatedGate(row, minExpectedEdge));
  const badAttempts = rows.filter(isBadAttempt);
  const profitableExactFills = rows.filter(isProfitableExactPair);
  const gateSimulation = {
    allowed: allowed.length,
    blocked: blocked.length,
    allowedBadAttempts: allowed.filter(isBadAttempt).length,
    blockedBadAttempts: blocked.filter(isBadAttempt).length,
    allowedProfitableExactFills: allowed.filter(isProfitableExactPair).length,
    blockedProfitableExactFills: blocked.filter(isProfitableExactPair).length,
    badAttemptReductionRate: rate(blocked.filter(isBadAttempt).length, badAttempts.length),
    profitableFillEliminationRate: rate(blocked.filter(isProfitableExactPair).length, profitableExactFills.length),
  };
  const dir = directionality(rows, minTopBottomExactFillRateSpread);
  const reasons: string[] = [];
  if (rows.length < minSamples)
    reasons.push(`need at least ${minSamples} submitted scored attempts; found ${rows.length}`);
  if (!dir.passed)
    reasons.push(`predicted paired-fill buckets are not directionally valid by ${minTopBottomExactFillRateSpread}`);
  if ((gateSimulation.badAttemptReductionRate ?? 0) < badAttemptReductionTarget) {
    reasons.push(
      `simulated gate blocks ${(gateSimulation.badAttemptReductionRate ?? 0).toFixed(3)} of bad attempts; need ${badAttemptReductionTarget}`,
    );
  }
  if (gateSimulation.profitableFillEliminationRate == null) {
    reasons.push("no profitable exact paired fills available for elimination check");
  } else if (gateSimulation.profitableFillEliminationRate > maxProfitableFillEliminationRate) {
    reasons.push(
      `simulated gate blocks ${gateSimulation.profitableFillEliminationRate.toFixed(3)} of profitable exact fills; max ${maxProfitableFillEliminationRate}`,
    );
  }

  return {
    generatedAt: generatedAt.toISOString(),
    thresholds: {
      minExpectedEdge,
      minSamples,
      badAttemptReductionTarget,
      maxProfitableFillEliminationRate,
      minTopBottomExactFillRateSpread,
    },
    summary: {
      sampleCount: rows.length,
      firstScoredAt: sortedByTime[0]?.createdAt ?? null,
      lastScoredAt: sortedByTime.at(-1)?.createdAt ?? null,
      exactPairedFills: rows.filter(isExactPair).length,
      profitableExactPairedFills: profitableExactFills.length,
      partials: rows.filter((row) => row.partialFill).length,
      unknownOrTimeouts: rows.filter(isUnknownOrTimeout).length,
      failures: rows.filter((row) => row.action === "failed").length,
      badAttempts: badAttempts.length,
    },
    pairedFillProbabilityBuckets: probabilityBuckets(rows),
    expectedExecutableEdgeDeciles: expectedEdgeDeciles(rows),
    gateSimulation,
    directionality: dir,
    promotion: {
      passed: reasons.length === 0,
      reasons,
    },
  };
}
