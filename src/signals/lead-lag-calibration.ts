import type { LeadLagSnapshot, SignalAction } from "../types";

export interface LeadLagCalibrationRow {
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
  leadLagSnapshot: LeadLagSnapshot | null;
  realizedGuaranteedProfit: number | null;
}

export interface LeadLagCalibrationOptions {
  minSamples?: number;
  minConfidence?: number;
  maxAdverseSelectionScore?: number;
  badAttemptReductionTarget?: number;
  maxProfitableFillEliminationRate?: number;
  minHighLowExactFillRateSpread?: number;
  minHighLowRealizedEdgeSpread?: number;
}

export interface LeadLagCalibrationBucket {
  label: string;
  count: number;
  exactPairedFills: number;
  profitableExactPairedFills: number;
  partials: number;
  unknownOrTimeouts: number;
  failures: number;
  badAttempts: number;
  exactPairFillRate: number | null;
  badAttemptRate: number | null;
  avgConfidence: number | null;
  avgAdverseSelectionScore: number | null;
  avgStalenessScore: number | null;
  avgRealizedEdge: number | null;
}

export interface LeadLagCalibrationReport {
  generatedAt: string;
  thresholds: {
    minSamples: number;
    minConfidence: number;
    maxAdverseSelectionScore: number;
    badAttemptReductionTarget: number;
    maxProfitableFillEliminationRate: number;
    minHighLowExactFillRateSpread: number;
    minHighLowRealizedEdgeSpread: number;
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
  leaderVenueBuckets: LeadLagCalibrationBucket[];
  laggingVenueBuckets: LeadLagCalibrationBucket[];
  cheapLegLaggingBuckets: LeadLagCalibrationBucket[];
  confidenceBands: LeadLagCalibrationBucket[];
  adverseSelectionDeciles: LeadLagCalibrationBucket[];
  stalenessDeciles: LeadLagCalibrationBucket[];
  simulatedGateBuckets: LeadLagCalibrationBucket[];
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
    lowAdverseExactFillRate: number | null;
    highAdverseExactFillRate: number | null;
    exactFillRateSpread: number | null;
    lowAdverseAvgRealizedEdge: number | null;
    highAdverseAvgRealizedEdge: number | null;
    realizedEdgeSpread: number | null;
    passed: boolean;
  };
  promotion: {
    passed: boolean;
    reasons: string[];
  };
}

const DEFAULT_MIN_SAMPLES = 200;
const DEFAULT_MIN_CONFIDENCE = 0.65;
const DEFAULT_MAX_ADVERSE_SELECTION_SCORE = 0.75;
const DEFAULT_BAD_ATTEMPT_REDUCTION_TARGET = 0.15;
const DEFAULT_MAX_PROFITABLE_FILL_ELIMINATION_RATE = 0.5;
const DEFAULT_MIN_HIGH_LOW_EXACT_FILL_RATE_SPREAD = 0.1;
const DEFAULT_MIN_HIGH_LOW_REALIZED_EDGE_SPREAD = 0.05;
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

function isUnknownOrTimeout(row: LeadLagCalibrationRow): boolean {
  const statuses = [row.kalshiStatus, row.polymarketStatus].map(normalizedStatus);
  const errors = [row.kalshiError, row.polymarketError].map(normalizedStatus);
  return statuses.some((status) => status === "unknown" || status === "timeout")
    || errors.some((error) => error.includes("timeout") || error.includes("timed out") || error.includes("unknown"));
}

function isExactPair(row: LeadLagCalibrationRow): boolean {
  const kalshiCount = row.kalshiFillCount ?? 0;
  const polymarketCount = row.polymarketFillCount ?? 0;
  return row.action === "filled"
    && !row.partialFill
    && kalshiCount > 0
    && polymarketCount > 0
    && Math.abs(kalshiCount - polymarketCount) <= EPSILON;
}

function isProfitableExactPair(row: LeadLagCalibrationRow): boolean {
  return isExactPair(row) && (row.realizedGuaranteedProfit ?? 0) > 0;
}

function isBadAttempt(row: LeadLagCalibrationRow): boolean {
  return row.partialFill
    || row.action === "failed"
    || isUnknownOrTimeout(row)
    || !isProfitableExactPair(row)
    || (row.realizedGuaranteedProfit != null && row.realizedGuaranteedProfit <= 0);
}

function scoredAt(row: LeadLagCalibrationRow): string | null {
  const value = row.leadLagSnapshot?.scoredAt;
  if (finiteNumber(value)) return new Date(value).toISOString();
  return row.createdAt;
}

function confidence(row: LeadLagCalibrationRow): number | null {
  return row.leadLagSnapshot?.confidence ?? null;
}

function adverseSelectionScore(row: LeadLagCalibrationRow): number | null {
  return row.leadLagSnapshot?.adverseSelectionScore ?? null;
}

function stalenessScore(row: LeadLagCalibrationRow): number | null {
  return row.leadLagSnapshot?.stalenessScore ?? null;
}

function simulatedGateBlocks(row: LeadLagCalibrationRow, minConfidence: number, maxAdverseSelectionScore: number): boolean {
  const snapshot = row.leadLagSnapshot;
  if (!snapshot) return false;
  return snapshot.confidence >= minConfidence && snapshot.adverseSelectionScore > maxAdverseSelectionScore;
}

function bucketStats(label: string, rows: LeadLagCalibrationRow[]): LeadLagCalibrationBucket {
  const exactPairedFills = rows.filter(isExactPair).length;
  const profitableExactPairedFills = rows.filter(isProfitableExactPair).length;
  const partials = rows.filter((row) => row.partialFill).length;
  const unknownOrTimeouts = rows.filter(isUnknownOrTimeout).length;
  const failures = rows.filter((row) => row.action === "failed").length;
  const badAttempts = rows.filter(isBadAttempt).length;
  return {
    label,
    count: rows.length,
    exactPairedFills,
    profitableExactPairedFills,
    partials,
    unknownOrTimeouts,
    failures,
    badAttempts,
    exactPairFillRate: rate(exactPairedFills, rows.length),
    badAttemptRate: rate(badAttempts, rows.length),
    avgConfidence: average(rows.map(confidence)),
    avgAdverseSelectionScore: average(rows.map(adverseSelectionScore)),
    avgStalenessScore: average(rows.map(stalenessScore)),
    avgRealizedEdge: average(rows.map((row) => row.realizedGuaranteedProfit)),
  };
}

function groupByLabel(rows: LeadLagCalibrationRow[], labelForRow: (row: LeadLagCalibrationRow) => string): LeadLagCalibrationBucket[] {
  const grouped = new Map<string, LeadLagCalibrationRow[]>();
  for (const row of rows) {
    const label = labelForRow(row);
    grouped.set(label, [...(grouped.get(label) ?? []), row]);
  }
  return Array.from(grouped.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, bucketRows]) => bucketStats(label, bucketRows));
}

function metricBands(
  rows: LeadLagCalibrationRow[],
  metric: (row: LeadLagCalibrationRow) => number | null,
  width: number,
): LeadLagCalibrationBucket[] {
  const grouped = new Map<number, LeadLagCalibrationRow[]>();
  for (const row of rows) {
    const value = metric(row);
    if (value == null) continue;
    const index = Math.min(Math.floor((1 - EPSILON) / width), Math.max(0, Math.floor(value / width)));
    grouped.set(index, [...(grouped.get(index) ?? []), row]);
  }
  return Array.from(grouped.entries())
    .sort(([left], [right]) => left - right)
    .map(([index, bucketRows]) => {
      const start = index * width;
      const end = Math.min(1, start + width);
      return bucketStats(`${start.toFixed(1)}-${end.toFixed(1)}`, bucketRows);
    });
}

function metricDeciles(rows: LeadLagCalibrationRow[], metric: (row: LeadLagCalibrationRow) => number | null): LeadLagCalibrationBucket[] {
  return metricBands(rows, metric, 0.1);
}

function directionality(
  rows: LeadLagCalibrationRow[],
  minExactSpread: number,
  minRealizedSpread: number,
): LeadLagCalibrationReport["directionality"] {
  const sorted = rows
    .filter((row) => adverseSelectionScore(row) != null)
    .sort((left, right) => (adverseSelectionScore(left) ?? 0) - (adverseSelectionScore(right) ?? 0));
  if (sorted.length < 2) {
    return {
      lowAdverseExactFillRate: null,
      highAdverseExactFillRate: null,
      exactFillRateSpread: null,
      lowAdverseAvgRealizedEdge: null,
      highAdverseAvgRealizedEdge: null,
      realizedEdgeSpread: null,
      passed: false,
    };
  }
  const midpoint = Math.floor(sorted.length / 2);
  const low = sorted.slice(0, midpoint);
  const high = sorted.slice(midpoint);
  const lowExact = rate(low.filter(isExactPair).length, low.length);
  const highExact = rate(high.filter(isExactPair).length, high.length);
  const lowRealized = average(low.map((row) => row.realizedGuaranteedProfit));
  const highRealized = average(high.map((row) => row.realizedGuaranteedProfit));
  const exactSpread = lowExact == null || highExact == null ? null : roundMetric(lowExact - highExact);
  const realizedSpread = lowRealized == null || highRealized == null ? null : roundMetric(lowRealized - highRealized);
  return {
    lowAdverseExactFillRate: lowExact,
    highAdverseExactFillRate: highExact,
    exactFillRateSpread: exactSpread,
    lowAdverseAvgRealizedEdge: lowRealized,
    highAdverseAvgRealizedEdge: highRealized,
    realizedEdgeSpread: realizedSpread,
    passed: (exactSpread != null && exactSpread >= minExactSpread)
      || (realizedSpread != null && realizedSpread >= minRealizedSpread),
  };
}

export function buildLeadLagCalibrationReport(
  inputRows: LeadLagCalibrationRow[],
  options: LeadLagCalibrationOptions = {},
  generatedAt = new Date(),
): LeadLagCalibrationReport {
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxAdverseSelectionScore = options.maxAdverseSelectionScore ?? DEFAULT_MAX_ADVERSE_SELECTION_SCORE;
  const badAttemptReductionTarget = options.badAttemptReductionTarget ?? DEFAULT_BAD_ATTEMPT_REDUCTION_TARGET;
  const maxProfitableFillEliminationRate = options.maxProfitableFillEliminationRate ?? DEFAULT_MAX_PROFITABLE_FILL_ELIMINATION_RATE;
  const minHighLowExactFillRateSpread = options.minHighLowExactFillRateSpread ?? DEFAULT_MIN_HIGH_LOW_EXACT_FILL_RATE_SPREAD;
  const minHighLowRealizedEdgeSpread = options.minHighLowRealizedEdgeSpread ?? DEFAULT_MIN_HIGH_LOW_REALIZED_EDGE_SPREAD;
  const rows = inputRows.filter((row) => row.executionGroupId != null && row.leadLagSnapshot != null);
  const sortedByScoreTime = rows
    .filter((row) => scoredAt(row) != null)
    .sort((left, right) => String(scoredAt(left)).localeCompare(String(scoredAt(right))));
  const blocked = rows.filter((row) => simulatedGateBlocks(row, minConfidence, maxAdverseSelectionScore));
  const allowed = rows.filter((row) => !simulatedGateBlocks(row, minConfidence, maxAdverseSelectionScore));
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
  const directional = directionality(rows, minHighLowExactFillRateSpread, minHighLowRealizedEdgeSpread);
  const firstScoredAt = sortedByScoreTime.length === 0 ? null : scoredAt(sortedByScoreTime[0]);
  const lastScoredAt = sortedByScoreTime.length === 0 ? null : scoredAt(sortedByScoreTime[sortedByScoreTime.length - 1]);
  const reasons: string[] = [];
  if (rows.length < minSamples) reasons.push(`need at least ${minSamples} submitted scored attempts; found ${rows.length}`);
  if (!directional.passed) {
    reasons.push(`high-adverse buckets are not materially worse by exact-fill spread ${minHighLowExactFillRateSpread} or realized-edge spread ${minHighLowRealizedEdgeSpread}`);
  }
  if ((gateSimulation.badAttemptReductionRate ?? 0) < badAttemptReductionTarget) {
    reasons.push(`simulated gate blocks ${(gateSimulation.badAttemptReductionRate ?? 0).toFixed(3)} of bad attempts; need ${badAttemptReductionTarget}`);
  }
  if (gateSimulation.profitableFillEliminationRate == null) {
    reasons.push("no profitable exact paired fills available for elimination check");
  } else if (gateSimulation.profitableFillEliminationRate > maxProfitableFillEliminationRate) {
    reasons.push(`simulated gate blocks ${gateSimulation.profitableFillEliminationRate.toFixed(3)} of profitable exact fills; max ${maxProfitableFillEliminationRate}`);
  }

  return {
    generatedAt: generatedAt.toISOString(),
    thresholds: {
      minSamples,
      minConfidence,
      maxAdverseSelectionScore,
      badAttemptReductionTarget,
      maxProfitableFillEliminationRate,
      minHighLowExactFillRateSpread,
      minHighLowRealizedEdgeSpread,
    },
    summary: {
      sampleCount: rows.length,
      firstScoredAt,
      lastScoredAt,
      exactPairedFills: rows.filter(isExactPair).length,
      profitableExactPairedFills: profitableExactFills.length,
      partials: rows.filter((row) => row.partialFill).length,
      unknownOrTimeouts: rows.filter(isUnknownOrTimeout).length,
      failures: rows.filter((row) => row.action === "failed").length,
      badAttempts: badAttempts.length,
    },
    leaderVenueBuckets: groupByLabel(rows, (row) => row.leadLagSnapshot?.leaderVenue ?? "none"),
    laggingVenueBuckets: groupByLabel(rows, (row) => row.leadLagSnapshot?.laggingVenue ?? "none"),
    cheapLegLaggingBuckets: groupByLabel(rows, (row) => row.leadLagSnapshot?.cheapLegIsLagging == null ? "unknown" : String(row.leadLagSnapshot.cheapLegIsLagging)),
    confidenceBands: metricBands(rows, confidence, 0.2),
    adverseSelectionDeciles: metricDeciles(rows, adverseSelectionScore),
    stalenessDeciles: metricDeciles(rows, stalenessScore),
    simulatedGateBuckets: [
      bucketStats("allowed", allowed),
      bucketStats("blocked", blocked),
    ],
    gateSimulation,
    directionality: directional,
    promotion: {
      passed: reasons.length === 0,
      reasons,
    },
  };
}
