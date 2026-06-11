import pg from "pg";

type AttemptRow = {
  id: string;
  created_at: string;
  updated_at: string;
  action: string;
  failure_reason: string | null;
  execution_group_id: string;
  execution_strategy: string | null;
  kalshi_status: string | null;
  polymarket_status: string | null;
  kalshi_fill_count: string | number | null;
  polymarket_fill_count: string | number | null;
  partial_fill: boolean | null;
  expected_executable_edge: string | number | null;
  realized_guaranteed_profit: string | number | null;
  finalization_ms: number | null;
  execution_timings: Record<string, unknown> | null;
  risk_quarantined_at: string | null;
  reconciliation_resolved_at: string | null;
};

type ClassifiedAttempt = {
  id: number;
  createdAt: string;
  updatedAt: string;
  action: string;
  completedTwoSided: boolean;
  firstLegFilled: boolean;
  hedgeFilled: boolean;
  failureClass: string;
  failureReason: string | null;
  kalshiStatus: string | null;
  polymarketStatus: string | null;
  kalshiFillCount: number;
  polymarketFillCount: number;
  totalMs: number | null;
  polymarketRttMs: number | null;
  kalshiRttMs: number | null;
  polyHedgeTriggerToKalshiSubmitMs: number | null;
  hedgeTriggerFillCount: number | null;
  hedgeTriggerMin: number | null;
  hedgeTriggerMax: number | null;
  hedgeTriggerExact: boolean | null;
  expectedExecutableEdge: number | null;
  realizedGuaranteedProfit: number | null;
  riskQuarantined: boolean;
  reconciled: boolean;
};

function numberFrom(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolFrom(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function percentile(values: Array<number | null>, quantile: number): number | null {
  const sorted = values.filter((value): value is number => value != null && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function average(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function rate(values: boolean[]): number | null {
  if (values.length === 0) return null;
  return values.filter(Boolean).length / values.length;
}

function roundMetric(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10_000) / 10_000;
}

function failureClass(row: {
  action: string;
  completedTwoSided: boolean;
  firstLegFilled: boolean;
  hedgeFilled: boolean;
  failureReason: string | null;
  kalshiFillCount: number;
  polymarketFillCount: number;
  polymarketStatus: string | null;
}): string {
  if (row.completedTwoSided) return "completed_two_sided";
  if (row.firstLegFilled && !row.hedgeFilled && row.failureReason?.toLowerCase().includes("outside configured hedge range")) {
    return "first_leg_filled_hedge_skipped_range";
  }
  if (row.firstLegFilled && !row.hedgeFilled) return "first_leg_filled_no_hedge";
  if (!row.firstLegFilled && ["unknown", "unexpected_fill_count"].includes((row.polymarketStatus ?? "").toLowerCase())) {
    return "first_leg_unknown_or_mismatch";
  }
  if (!row.firstLegFilled) return "first_leg_no_fill";
  if (
    row.hedgeFilled
    && row.polymarketFillCount > 0
    && Math.abs(row.kalshiFillCount - row.polymarketFillCount) > 0.000001
  ) {
    return "two_sided_mismatched_size";
  }
  return "other_failure";
}

function classify(row: AttemptRow): ClassifiedAttempt {
  const timings = row.execution_timings ?? {};
  const kalshiFillCount = numberFrom(row.kalshi_fill_count) ?? 0;
  const polymarketFillCount = numberFrom(row.polymarket_fill_count) ?? 0;
  const completedTwoSided = row.action === "filled"
    && row.partial_fill !== true
    && kalshiFillCount > 0
    && polymarketFillCount > 0
    && Math.abs(kalshiFillCount - polymarketFillCount) <= 0.000001;
  const firstLegFilled = polymarketFillCount > 0;
  const hedgeFilled = kalshiFillCount > 0;
  const base = {
    action: row.action,
    completedTwoSided,
    firstLegFilled,
    hedgeFilled,
    failureReason: row.failure_reason,
    kalshiFillCount,
    polymarketFillCount,
    polymarketStatus: row.polymarket_status,
  };
  return {
    id: Number(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    action: row.action,
    completedTwoSided,
    firstLegFilled,
    hedgeFilled,
    failureClass: failureClass(base),
    failureReason: row.failure_reason,
    kalshiStatus: row.kalshi_status,
    polymarketStatus: row.polymarket_status,
    kalshiFillCount,
    polymarketFillCount,
    totalMs: numberFrom(timings.totalMs),
    polymarketRttMs: numberFrom(timings.polymarketOrderRttMs),
    kalshiRttMs: numberFrom(timings.kalshiOrderRttMs),
    polyHedgeTriggerToKalshiSubmitMs: numberFrom(timings.polyHedgeTriggerToKalshiSubmitMs),
    hedgeTriggerFillCount: numberFrom(timings.polymarketHedgeTriggerFillCount),
    hedgeTriggerMin: numberFrom(timings.polymarketHedgeTriggerMinFillShares),
    hedgeTriggerMax: numberFrom(timings.polymarketHedgeTriggerMaxFillShares),
    hedgeTriggerExact: boolFrom(timings.polymarketHedgeTriggerExact),
    expectedExecutableEdge: numberFrom(row.expected_executable_edge),
    realizedGuaranteedProfit: numberFrom(row.realized_guaranteed_profit),
    riskQuarantined: row.risk_quarantined_at != null,
    reconciled: row.reconciliation_resolved_at != null,
  };
}

function parseLimit(): number {
  const arg = process.argv.find((value) => value.startsWith("--limit="));
  const parsed = Number(arg?.split("=")[1] ?? 20);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");

  const limit = parseLimit();
  const pool = new pg.Pool({ connectionString });
  try {
    const result = await pool.query<AttemptRow>(`
      SELECT
        id::TEXT,
        created_at,
        updated_at,
        action,
        failure_reason,
        execution_group_id,
        execution_strategy,
        kalshi_status,
        polymarket_status,
        kalshi_fill_count,
        polymarket_fill_count,
        partial_fill,
        expected_executable_edge,
        realized_guaranteed_profit,
        finalization_ms,
        execution_timings,
        risk_quarantined_at,
        reconciliation_resolved_at
      FROM cross_venue_arb_signals
      WHERE execution_group_id IS NOT NULL
        AND execution_strategy = 'polymarket_first_exact'
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `, [Math.max(limit, 20)]);
    const attempts = result.rows.map(classify);
    const lastN = attempts.slice(0, limit);
    const firstLegFilled = lastN.filter((attempt) => attempt.firstLegFilled);
    const failureBreakdown = lastN.reduce<Record<string, number>>((counts, attempt) => {
      counts[attempt.failureClass] = (counts[attempt.failureClass] ?? 0) + 1;
      return counts;
    }, {});

    const report = {
      generatedAt: new Date().toISOString(),
      qualifiedCountSampled: lastN.length,
      last2CompletionRate: roundMetric(rate(attempts.slice(0, 2).map((attempt) => attempt.completedTwoSided))),
      completionRate: roundMetric(rate(lastN.map((attempt) => attempt.completedTwoSided))),
      firstLegFillRate: roundMetric(rate(lastN.map((attempt) => attempt.firstLegFilled))),
      hedgeFillRateAmongFirstLegFills: roundMetric(rate(firstLegFilled.map((attempt) => attempt.hedgeFilled))),
      avgTotalMs: roundMetric(average(lastN.map((attempt) => attempt.totalMs))),
      p95TotalMs: roundMetric(percentile(lastN.map((attempt) => attempt.totalMs), 0.95)),
      avgPolymarketRttMs: roundMetric(average(lastN.map((attempt) => attempt.polymarketRttMs))),
      p95PolymarketRttMs: roundMetric(percentile(lastN.map((attempt) => attempt.polymarketRttMs), 0.95)),
      avgKalshiRttMs: roundMetric(average(lastN.map((attempt) => attempt.kalshiRttMs))),
      p95KalshiRttMs: roundMetric(percentile(lastN.map((attempt) => attempt.kalshiRttMs), 0.95)),
      avgExpectedExecutableEdge: roundMetric(average(lastN.map((attempt) => attempt.expectedExecutableEdge))),
      avgRealizedGuaranteedProfit: roundMetric(average(lastN.map((attempt) => attempt.realizedGuaranteedProfit))),
      failureBreakdown,
      last2: attempts.slice(0, 2),
      recentAttempts: lastN.slice(0, Math.min(limit, 12)),
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
