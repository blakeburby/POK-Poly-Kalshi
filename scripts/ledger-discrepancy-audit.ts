import pg from "pg";

/**
 * Read-only diagnostic for "the trade ledger isn't showing trades we actually took."
 *
 * The dashboard ledger renders `listRecentSignals()`, whose SQL is
 *   ... FROM cross_venue_arb_signals WHERE execution_group_id IS NOT NULL ...
 * i.e. it shows ONLY signals that reached order submission (a group id is assigned
 * at executor.ts:456, just before placement). A real fill normally co-occurs with a
 * group id, so a *missing* real trade means a row that has fill/exposure evidence but
 * NO persisted execution_group_id — or a venue fill with no signal row at all.
 *
 * This script surfaces exactly those rows so we can see whether the ledger filter is
 * hiding real trades, and if so, by which code path. It writes nothing.
 *
 * Run:  DATABASE_PUBLIC_URL=postgres://... npx tsx scripts/ledger-discrepancy-audit.ts
 *   (or DATABASE_URL). Optional first arg = lookback hours (default 168 = 7d).
 */

const LOOKBACK_HOURS = Number(process.argv[2] ?? 168);

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  // Railway's public TCP proxy serves Postgres over TLS with a non-validating cert chain.
  const needsSsl = /proxy\.rlwy\.net|\.railway\.app|sslmode=require/.test(connectionString);
  const pool = new pg.Pool({ connectionString, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
  const since = `NOW() - INTERVAL '${Math.max(1, LOOKBACK_HOURS)} hours'`;

  try {
    // 1) Top-line: how the window breaks down, and how much the ledger filter shows.
    const summary = await pool.query(`
      SELECT
        COUNT(*)                                                                   AS total_signals,
        COUNT(*) FILTER (WHERE execution_group_id IS NOT NULL)                     AS ledger_visible,
        COUNT(*) FILTER (WHERE action = 'filled')                                  AS action_filled,
        COUNT(*) FILTER (WHERE action = 'failed')                                  AS action_failed,
        COUNT(*) FILTER (WHERE action = 'skipped')                                 AS action_skipped,
        COUNT(*) FILTER (WHERE partial_fill = TRUE)                                AS partial_fills,
        COUNT(*) FILTER (WHERE risk_quarantined_at IS NOT NULL)                    AS quarantined
      FROM cross_venue_arb_signals
      WHERE created_at >= ${since}
    `);

    // 2) THE SMOKING GUN: rows with real fill/exposure evidence but NO group id.
    //    These are real trades the ledger silently drops.
    const hiddenFills = await pool.query(`
      SELECT id, created_at, updated_at, action, failure_reason,
             kalshi_status, polymarket_status,
             kalshi_fill_count, polymarket_fill_count,
             kalshi_fill_id, polymarket_fill_id, partial_fill,
             risk_quarantined_at, reconciliation_resolved_at,
             kalshi_error, polymarket_error
      FROM cross_venue_arb_signals
      WHERE created_at >= ${since}
        AND execution_group_id IS NULL
        AND (
              kalshi_fill_id IS NOT NULL
           OR polymarket_fill_id IS NOT NULL
           OR COALESCE(kalshi_fill_count, 0) > 0
           OR COALESCE(polymarket_fill_count, 0) > 0
           OR partial_fill = TRUE
           OR risk_quarantined_at IS NOT NULL
           OR reconciliation_resolved_at IS NOT NULL
        )
      ORDER BY created_at DESC
      LIMIT 50
    `);

    // 3) Failed rows with NO group id (candidate "execute() threw after placement" path —
    //    a real order may have been placed even though the row shows no fills).
    const failedNoGroup = await pool.query(`
      SELECT id, created_at, action, failure_reason, kalshi_error, polymarket_error
      FROM cross_venue_arb_signals
      WHERE created_at >= ${since}
        AND execution_group_id IS NULL
        AND action = 'failed'
        AND failure_reason IS DISTINCT FROM 'pending_execution'
      ORDER BY created_at DESC
      LIMIT 30
    `);

    // 4) What the ledger DOES show — most recent group-id rows, to compare against the
    //    venue trade history by timestamp.
    const ledgerRows = await pool.query(`
      SELECT id, created_at, updated_at, action, execution_strategy,
             kalshi_status, polymarket_status,
             kalshi_fill_count, polymarket_fill_count, partial_fill,
             realized_guaranteed_profit
      FROM cross_venue_arb_signals
      WHERE created_at >= ${since}
        AND execution_group_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 30
    `);

    console.log(JSON.stringify({
      lookbackHours: LOOKBACK_HOURS,
      summary: summary.rows[0],
      hiddenRealTrades_fillsButNoGroupId: {
        count: hiddenFills.rowCount,
        note: "If >0, the ledger is hiding real trades. These have fills/exposure but no execution_group_id.",
        rows: hiddenFills.rows,
      },
      failedNoGroupId: {
        count: failedNoGroup.rowCount,
        note: "Failed rows with no group id; check whether any correspond to an order that actually placed on the venue.",
        rows: failedNoGroup.rows,
      },
      ledgerVisible_recent: {
        count: ledgerRows.rowCount,
        rows: ledgerRows.rows,
      },
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
