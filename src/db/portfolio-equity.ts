import type { Queryable } from "./signals";

/** One downsampled equity-curve point: t = epoch ms, v = combined portfolio value ($). */
export interface PortfolioEquityPoint {
  t: number;
  v: number;
}

export interface PortfolioEquitySampleInput {
  sampledAtMs: number;
  kalshiValue: number | null;
  polymarketValue: number | null;
  combinedValue: number;
  kalshiCash: number | null;
  polymarketCash: number | null;
  source?: "sampled" | "reconstructed";
}

function numberFrom(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure time-span bucketed downsample (TS twin of the SQL path) — keep ≤ maxPoints points,
 * one per evenly-spaced time bucket, taking the LATEST sample in each bucket so the newest
 * point (and thus the header "current value") is always preserved exactly. Input must be
 * ascending by t. Exported for unit testing without a DB.
 */
export function downsampleEquity(points: PortfolioEquityPoint[], maxPoints: number): PortfolioEquityPoint[] {
  if (maxPoints < 1 || points.length <= maxPoints) return points;
  const lo = points[0].t;
  const hi = points[points.length - 1].t;
  if (hi <= lo) return [points[points.length - 1]];
  const span = hi - lo;
  const lastByBucket = new Map<number, PortfolioEquityPoint>();
  for (const p of points) {
    let bucket = Math.floor(((p.t - lo) / span) * maxPoints);
    if (bucket >= maxPoints) bucket = maxPoints - 1;
    lastByBucket.set(bucket, p); // ascending input → last write per bucket = latest in bucket
  }
  return [...lastByBucket.values()].sort((a, b) => a.t - b.t);
}

/**
 * Read-time combined series with per-venue last-observation carry-forward (LOCF) — the pure TS twin of
 * the SQL in listSince, exported for unit testing without a DB. Input must be ascending by t. Rows before
 * EITHER venue has ever reported are skipped; once one venue has reported, the other carries forward its
 * last non-null value so the combined sum never collapses to a single account on a momentary gap.
 */
export function combineWithCarryForward(
  rows: { t: number; kalshi: number | null; polymarket: number | null }[],
): PortfolioEquityPoint[] {
  let lastK: number | null = null;
  let lastP: number | null = null;
  const out: PortfolioEquityPoint[] = [];
  for (const row of rows) {
    if (row.kalshi != null) lastK = row.kalshi;
    if (row.polymarket != null) lastP = row.polymarket;
    if (lastK == null && lastP == null) continue;
    out.push({ t: row.t, v: roundCombined((lastK ?? 0) + (lastP ?? 0)) });
  }
  return out;
}

function roundCombined(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export class PortfolioEquityStore {
  constructor(private readonly db: Queryable) {}

  async record(input: PortfolioEquitySampleInput): Promise<void> {
    await this.db.query(
      `
      INSERT INTO portfolio_equity_snapshots (
        sampled_at_ms, kalshi_value, polymarket_value, combined_value,
        kalshi_cash, polymarket_cash, source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
      [
        Math.round(input.sampledAtMs),
        input.kalshiValue,
        input.polymarketValue,
        input.combinedValue,
        input.kalshiCash,
        input.polymarketCash,
        input.source ?? "sampled",
      ],
    );
  }

  /** Bulk insert for the optional realized-P&L backfill; idempotent for reconstructed rows. */
  async recordMany(inputs: PortfolioEquitySampleInput[]): Promise<void> {
    for (const input of inputs) {
      await this.db.query(
        `
        INSERT INTO portfolio_equity_snapshots (
          sampled_at_ms, kalshi_value, polymarket_value, combined_value,
          kalshi_cash, polymarket_cash, source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING
      `,
        [
          Math.round(input.sampledAtMs),
          input.kalshiValue,
          input.polymarketValue,
          input.combinedValue,
          input.kalshiCash,
          input.polymarketCash,
          input.source ?? "reconstructed",
        ],
      );
    }
  }

  /**
   * Return the combined-equity series since `sinceMs` (0 = all), downsampled SERVER-SIDE to
   * at most `maxPoints` points via time-span buckets, latest-per-bucket, ascending — so the
   * polled payload stays bounded no matter how much history has accrued.
   *
   * The combined value is recomputed at READ time as the per-venue SUM with last-observation
   * carry-forward (LOCF): each venue's last non-null value is carried forward across samples where
   * only the other venue reported, so a momentary single-venue gap does NOT make the curve drop to one
   * account (the cause of the wild $50<->$300 oscillation). This is non-destructive — stored
   * combined_value rows are not rewritten. Rows before EITHER venue has ever reported are skipped.
   */
  async listSince(sinceMs: number, maxPoints: number): Promise<PortfolioEquityPoint[]> {
    const cap = Math.max(1, Math.floor(maxPoints));
    const result = await this.db.query<{ sampled_at_ms: string | number; combined_value: string | number }>(
      `
      WITH ranged AS (
        SELECT sampled_at_ms, id, kalshi_value, polymarket_value, combined_value
        FROM portfolio_equity_snapshots
        WHERE sampled_at_ms >= $1
      ),
      grp AS (
        SELECT sampled_at_ms, id, kalshi_value, polymarket_value, combined_value,
               count(kalshi_value) OVER w AS k_grp,
               count(polymarket_value) OVER w AS p_grp
        FROM ranged
        WINDOW w AS (ORDER BY sampled_at_ms, id)
      ),
      locf AS (
        SELECT sampled_at_ms, combined_value,
               max(kalshi_value) OVER (PARTITION BY k_grp) AS k,
               max(polymarket_value) OVER (PARTITION BY p_grp) AS p
        FROM grp
      ),
      combined AS (
        -- Per-venue LOCF sum, but keep the stored combined_value for reconstructed/backfill rows that
        -- carry only an aggregate (no per-venue split), so enabling the backfill never blanks the curve.
        SELECT sampled_at_ms,
               CASE WHEN k IS NULL AND p IS NULL THEN combined_value
                    ELSE (COALESCE(k, 0) + COALESCE(p, 0)) END AS combined_value
        FROM locf
        WHERE k IS NOT NULL OR p IS NOT NULL OR combined_value IS NOT NULL
      ),
      bounds AS (
        SELECT MIN(sampled_at_ms) AS lo, MAX(sampled_at_ms) AS hi FROM combined
      ),
      tagged AS (
        SELECT c.sampled_at_ms, c.combined_value,
               width_bucket(c.sampled_at_ms::numeric, b.lo::numeric, (b.hi + 1)::numeric, $2) AS bucket
        FROM combined c
        CROSS JOIN bounds b
        WHERE b.hi IS NOT NULL
      ),
      ranked AS (
        SELECT sampled_at_ms, combined_value,
               ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY sampled_at_ms DESC) AS rn
        FROM tagged
      )
      SELECT sampled_at_ms, combined_value
      FROM ranked
      WHERE rn = 1
      ORDER BY sampled_at_ms ASC
    `,
      [Math.round(sinceMs), cap],
    );
    return result.rows
      .map((row) => ({ t: numberFrom(row.sampled_at_ms) ?? 0, v: numberFrom(row.combined_value) ?? 0 }))
      .filter((p) => Number.isFinite(p.t));
  }

  async earliestSampledAtMs(): Promise<number | null> {
    const result = await this.db.query<{ lo: string | number | null }>(
      `SELECT MIN(sampled_at_ms) AS lo FROM portfolio_equity_snapshots`,
    );
    return numberFrom(result.rows[0]?.lo);
  }

  async count(): Promise<number> {
    const result = await this.db.query<{ n: string | number }>(`SELECT COUNT(*) AS n FROM portfolio_equity_snapshots`);
    return numberFrom(result.rows[0]?.n) ?? 0;
  }

  /** Retention: drop live samples older than `beforeMs` (keep reconstructed history). */
  async prune(beforeMs: number): Promise<void> {
    await this.db.query(`DELETE FROM portfolio_equity_snapshots WHERE source = 'sampled' AND sampled_at_ms < $1`, [
      Math.round(beforeMs),
    ]);
  }
}
