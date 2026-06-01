import { createPool } from "../src/db/pool";
import { buildFillQualityCalibrationReport, type FillQualityCalibrationRow } from "../src/execution/fill-quality-calibration";
import type { FillQualitySnapshot, SignalAction } from "../src/types";
import { loadConfig } from "../src/config";

interface DbCalibrationRow {
  id: string | number;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  action: string;
  partial_fill: boolean | string | null;
  kalshi_status: string | null;
  polymarket_status: string | null;
  kalshi_error: string | null;
  polymarket_error: string | null;
  kalshi_fill_count: string | number | null;
  polymarket_fill_count: string | number | null;
  execution_group_id: string | null;
  fill_quality_snapshot: FillQualitySnapshot | string | null;
  expected_executable_edge: string | number | null;
  realized_guaranteed_profit: string | number | null;
}

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function numberArg(name: string, fallback: number): number {
  const parsed = Number(argValue(name, String(fallback)));
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a finite number`);
  return parsed;
}

function booleanFromDb(value: boolean | string | null): boolean {
  return value === true || value === "true" || value === "t";
}

function numberFromDb(value: string | number | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dateFromDb(value: string | Date | null): string | null {
  if (value instanceof Date) return value.toISOString();
  return value == null ? null : String(value);
}

function snapshotFromDb(value: FillQualitySnapshot | string | null): FillQualitySnapshot | null {
  if (value == null) return null;
  if (typeof value === "string") return JSON.parse(value) as FillQualitySnapshot;
  return value;
}

function actionFromDb(value: string): SignalAction {
  if (value === "filled" || value === "failed" || value === "skipped") return value;
  return "failed";
}

function rowFromDb(row: DbCalibrationRow): FillQualityCalibrationRow {
  return {
    id: Number(row.id),
    createdAt: dateFromDb(row.created_at),
    updatedAt: dateFromDb(row.updated_at),
    action: actionFromDb(row.action),
    partialFill: booleanFromDb(row.partial_fill),
    kalshiStatus: row.kalshi_status,
    polymarketStatus: row.polymarket_status,
    kalshiError: row.kalshi_error,
    polymarketError: row.polymarket_error,
    kalshiFillCount: numberFromDb(row.kalshi_fill_count),
    polymarketFillCount: numberFromDb(row.polymarket_fill_count),
    executionGroupId: row.execution_group_id,
    fillQualitySnapshot: snapshotFromDb(row.fill_quality_snapshot),
    expectedExecutableEdge: numberFromDb(row.expected_executable_edge),
    realizedGuaranteedProfit: numberFromDb(row.realized_guaranteed_profit),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const limit = Math.max(1, Math.floor(numberArg("limit", 2_000)));
  const minSamples = Math.max(1, Math.floor(numberArg("min-samples", 200)));
  const minExpectedEdge = numberArg("threshold", config.liveFillQualityMinExpectedEdge);
  const requirePass = process.argv.includes("--require-pass");
  const pool = createPool(config);
  try {
    const result = await pool.query<DbCalibrationRow>(`
      SELECT
        id, created_at, updated_at, action, partial_fill,
        kalshi_status, polymarket_status, kalshi_error, polymarket_error,
        kalshi_fill_count, polymarket_fill_count, execution_group_id,
        fill_quality_snapshot, expected_executable_edge, realized_guaranteed_profit
      FROM cross_venue_arb_signals
      WHERE fill_quality_snapshot IS NOT NULL
        AND execution_group_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    const report = buildFillQualityCalibrationReport(result.rows.map(rowFromDb), {
      minExpectedEdge,
      minSamples,
    });
    console.log(JSON.stringify(report, null, 2));
    if (requirePass && !report.promotion.passed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: "FILL_QUALITY_CALIBRATION_DB_ERROR",
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(2);
});
