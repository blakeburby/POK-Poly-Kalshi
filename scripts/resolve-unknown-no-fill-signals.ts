import pg from "pg";

/**
 * Resolve NON-quarantined signals stuck with an "unknown"/"unexpected_fill_count" venue status
 * but ZERO recorded fills (Polymarket confirmation-timeouts where nothing actually filled).
 * These block `reconcileBeforeTrade` yet carry NO venue exposure, and the quarantine reconciler
 * (reconcile-historical-quarantines.ts) skips them because risk_quarantined_at IS NULL.
 *
 * STRICT guard: only rows with zero fills on BOTH legs are touched, so this can never mask a real
 * position. Defaults to DRY-RUN; --apply writes. Refuses to apply unless arb is paused.
 *
 *   set -a; . /etc/pok-poly-kalshi/worker.env; set +a
 *   npx tsx scripts/resolve-unknown-no-fill-signals.ts            # dry-run: prints the exact IDs
 *   npx tsx scripts/resolve-unknown-no-fill-signals.ts --apply    # resolve them (arb must be off)
 */

const WHERE = `
  reconciliation_resolved_at IS NULL
  AND risk_quarantined_at IS NULL
  AND (kalshi_status IN ('unknown','unexpected_fill_count') OR polymarket_status IN ('unknown','unexpected_fill_count'))
  AND COALESCE(kalshi_fill_count, 0) = 0
  AND COALESCE(polymarket_fill_count, 0) = 0
`;

const REASON =
  "operator: polymarket confirmation timeout / unknown status with no recorded fill on either leg — no venue exposure (post-settlement)";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const healthUrl = process.env.RESOLVE_HEALTH_URL ?? "http://127.0.0.1:8080/health";
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  const ssl = /proxy\.rlwy\.net|\.railway\.app|sslmode=require/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined;
  const pool = new pg.Pool({ connectionString, ssl });

  try {
    const preview = await pool.query<{
      id: string;
      kalshi_status: string | null;
      polymarket_status: string | null;
      expiry_ms: string | number;
    }>(
      `SELECT id::TEXT, kalshi_status, polymarket_status, expiry_ms FROM cross_venue_arb_signals WHERE ${WHERE} ORDER BY id ASC`,
    );
    const targets = preview.rows;

    if (apply) {
      // Guard: never resolve while the engine could be opening trades.
      let arbEnabled: unknown = "unknown";
      try {
        const res = await fetch(healthUrl);
        arbEnabled = res.ok ? ((await res.json()) as { arbEnabled?: boolean }).arbEnabled : "health_not_ok";
      } catch (error) {
        arbEnabled = `health_unreachable: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (arbEnabled !== false) {
        console.log(
          JSON.stringify(
            {
              mode: "apply-aborted",
              reason: "arb is not paused (health.arbEnabled !== false)",
              arbEnabled,
              targetCount: targets.length,
            },
            null,
            2,
          ),
        );
        return;
      }
      const updated = await pool.query<{ id: string }>(
        `UPDATE cross_venue_arb_signals SET reconciliation_resolved_at = NOW(), reconciliation_resolution_reason = $1 WHERE ${WHERE} RETURNING id::TEXT`,
        [REASON],
      );
      console.log(
        JSON.stringify(
          { mode: "applied", resolvedCount: updated.rowCount, resolvedIds: updated.rows.map((r) => r.id) },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          targetCount: targets.length,
          targets: targets.map((t) => ({
            id: t.id,
            kalshi_status: t.kalshi_status,
            polymarket_status: t.polymarket_status,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
