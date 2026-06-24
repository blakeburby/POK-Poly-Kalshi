// Read-only calibration for the W1 fee-aware entry gate (LIVE_FEE_AWARE_GATE_ENABLED) and the follow-on
// taker-cushion cut. Two questions:
//   (1) Does the fee-aware gate OVER-PROMISE? On completed fills, the fee-aware predicted edge
//       (projectedEdgeAtLimit - expectedKalshiFee(fillPrice)) must be <= realized + tolerance, else the
//       gate would admit trades that lose. This is the safety-critical, PRECISE check (completed rows carry
//       projected_edge_after_fees, realized_guaranteed_profit, and the Kalshi fill price for the fee).
//   (2) How much profitable volume does a cushion cut UNLOCK? Skipped scans only carry the cushioned edge in
//       failure_reason text (no per-row Kalshi VWAP), so the newly-admitted count at a target cushion is an
//       APPROXIMATION using the mean Kalshi fee from completed fills. Reported, not gated.
// Usage: DATABASE_URL=... npx tsx scripts/fee-aware-gate-calibrate.ts [--days=14] [--cushion-cut-cents=2] [--require-pass]
import { createPool } from "../src/db/pool";
import { expectedKalshiFeePerShare } from "../src/execution/quote-quality";
import { loadConfig } from "../src/config";

function argValue(name: string, fallback: string): string {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}
function numberArg(name: string, fallback: number): number {
  const parsed = Number(argValue(name, String(fallback)));
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a finite number`);
  return parsed;
}
function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : value == null ? NaN : Number(value);
  return Number.isFinite(n) ? n : null;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

interface CompletedRow {
  gate_edge: string | number | null;
  realized: string | number | null;
  kalshi_fill_price: string | number | null;
}
interface SkipRow {
  edge: string | number | null;
  n: string | number;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const days = Math.max(1, Math.floor(numberArg("days", 14)));
  const cushionCutCents = Math.max(0, numberArg("cushion-cut-cents", 2)); // total cents added back to the edge
  const requirePass = process.argv.includes("--require-pass");
  const minProfit = config.minProfitDollars;
  const pool = createPool(config);
  try {
    // (1) completed fills — precise over-promise check
    const completed = (
      await pool.query<CompletedRow>(`
      SELECT projected_edge_after_fees AS gate_edge, realized_guaranteed_profit AS realized, kalshi_fill_price
      FROM cross_venue_arb_signals
      WHERE action = 'filled'
        AND projected_edge_after_fees IS NOT NULL AND realized_guaranteed_profit IS NOT NULL
        AND created_at > now() - make_interval(days => ${days})
    `)
    ).rows;
    const residuals: number[] = [];
    const fees: number[] = [];
    for (const r of completed) {
      const gate = num(r.gate_edge),
        realized = num(r.realized),
        price = num(r.kalshi_fill_price);
      if (gate == null || realized == null) continue;
      const fee = expectedKalshiFeePerShare(price); // 0 if price unknown
      fees.push(fee);
      residuals.push(realized - (gate - fee)); // realized - feeAwarePredicted; >= 0 means no over-promise
    }
    const meanFee = mean(fees);
    const meanResidual = mean(residuals);
    const realizedMean = mean(completed.map((r) => num(r.realized) ?? 0));

    // (2) skipped cushioned-edge scans — approximate unlock at the cushion cut (mean fee applied)
    const skipRows = (
      await pool.query<SkipRow>(`
      SELECT (regexp_match(failure_reason, 'edge (-?[0-9.]+) below'))[1]::numeric AS edge, count(*) AS n
      FROM cross_venue_arb_signals
      WHERE action = 'skipped' AND failure_reason LIKE 'cushioned executable edge%'
        AND created_at > now() - make_interval(days => 1)
      GROUP BY 1
    `)
    ).rows;
    let totalSkips = 0,
      newlyAdmitted = 0;
    for (const s of skipRows) {
      const edge = num(s.edge),
        n = num(s.n) ?? 0;
      if (edge == null) continue;
      totalSkips += n;
      // cushion cut raises the cushioned edge by cushionCutCents; fee-aware subtracts the mean fee.
      if (edge + cushionCutCents / 100 - meanFee >= minProfit) newlyAdmitted += n;
    }

    // promotion: the fee-aware gate must NOT systematically over-promise on completed fills.
    const overPromiseOk = completed.length >= 5 && meanResidual >= -0.005 && percentile(residuals, 0.1) >= -0.02;

    const report = {
      params: { days, cushionCutCents, minProfit, meanKalshiFeePerShare: Number(meanFee.toFixed(4)) },
      completedFills: {
        n: completed.length,
        gateEdgeMean: Number(mean(completed.map((r) => num(r.gate_edge) ?? 0)).toFixed(4)),
        realizedMean: Number(realizedMean.toFixed(4)),
        feeAwarePredictedVsRealized: {
          meanResidual: Number(meanResidual.toFixed(4)),
          p10Residual: Number(percentile(residuals, 0.1).toFixed(4)),
        },
      },
      cushionCutUnlock_per24h: { totalCushionedSkips: totalSkips, newlyAdmittedEstimate: newlyAdmitted },
      promotion: {
        passed: overPromiseOk,
        criterion:
          "completed fills >=5 AND mean(realized - feeAwarePredicted) >= -0.005 AND p10 >= -0.02 (no systematic over-promise)",
      },
    };
    console.log(JSON.stringify(report, null, 2));
    if (requirePass && !report.promotion.passed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      { error: "FEE_AWARE_GATE_CALIBRATION_DB_ERROR", message: error instanceof Error ? error.message : String(error) },
      null,
      2,
    ),
  );
  process.exit(2);
});
