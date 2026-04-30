import type { ArbLeg, DashboardSignal, LegDirection, SignalAction, SignalInsert, SignalUpdate, Venue } from "../types";
import type { FilledAttempt } from "../scanner/reentry";

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
}

interface DashboardSignalRow {
  id: string | number;
  created_at: string | Date;
  updated_at: string | Date;
  pair_key: string;
  expiry_ms: string | number;
  kalshi_contract_id: string;
  polymarket_contract_id: string;
  lower_venue: string;
  lower_contract_id: string;
  lower_strike: string | number;
  lower_direction: string;
  lower_ask: string | number;
  higher_venue: string;
  higher_contract_id: string;
  higher_strike: string | number;
  higher_direction: string;
  higher_ask: string | number;
  premium: string | number;
  guaranteed_profit: string | number;
  overlap_profit: string | number;
  threshold: string | number;
  action: string;
  failure_reason: string | null;
  kalshi_fill_id: string | null;
  polymarket_fill_id: string | null;
  kalshi_fill_price: string | number | null;
  polymarket_fill_price: string | number | null;
}

function numberFrom(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function legFromRow(row: DashboardSignalRow, side: "lower" | "higher"): ArbLeg {
  return {
    venue: row[`${side}_venue`] as Venue,
    contractId: row[`${side}_contract_id`],
    direction: row[`${side}_direction`] as LegDirection,
    strike: Number(row[`${side}_strike`]),
    ask: Number(row[`${side}_ask`]),
  };
}

function signalFromRow(row: DashboardSignalRow): DashboardSignal {
  return {
    id: Number(row.id),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
    pairKey: row.pair_key,
    expiryMs: Number(row.expiry_ms),
    kalshiContractId: row.kalshi_contract_id,
    polymarketContractId: row.polymarket_contract_id,
    lower: legFromRow(row, "lower"),
    higher: legFromRow(row, "higher"),
    premium: Number(row.premium),
    guaranteedProfit: Number(row.guaranteed_profit),
    overlapProfit: Number(row.overlap_profit),
    threshold: Number(row.threshold),
    action: row.action as SignalAction,
    failureReason: row.failure_reason,
    kalshiFillId: row.kalshi_fill_id,
    polymarketFillId: row.polymarket_fill_id,
    kalshiFillPrice: numberFrom(row.kalshi_fill_price),
    polymarketFillPrice: numberFrom(row.polymarket_fill_price),
  };
}

export class SignalStore {
  constructor(private readonly db: Queryable) {}

  async insertSignal(input: SignalInsert): Promise<number> {
    const { candidate } = input;
    const result = await this.db.query<{ id: string | number }>(`
      INSERT INTO cross_venue_arb_signals (
        pair_key, expiry_ms, kalshi_contract_id, polymarket_contract_id,
        lower_venue, lower_contract_id, lower_strike, lower_direction, lower_ask,
        higher_venue, higher_contract_id, higher_strike, higher_direction, higher_ask,
        premium, guaranteed_profit, overlap_profit, threshold, action, failure_reason
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20
      )
      RETURNING id
    `, [
      candidate.pairKey,
      candidate.expiryMs,
      candidate.kalshiContractId,
      candidate.polymarketContractId,
      candidate.lower.venue,
      candidate.lower.contractId,
      candidate.lower.strike,
      candidate.lower.direction,
      candidate.lower.ask,
      candidate.higher.venue,
      candidate.higher.contractId,
      candidate.higher.strike,
      candidate.higher.direction,
      candidate.higher.ask,
      candidate.premium,
      candidate.guaranteedProfit,
      candidate.overlapProfit,
      candidate.threshold,
      input.action,
      input.failureReason ?? null,
    ]);
    const id = Number(result.rows[0]?.id);
    if (!Number.isFinite(id)) throw new Error("Signal insert did not return an id");
    return id;
  }

  async updateSignal(id: number, update: SignalUpdate): Promise<void> {
    await this.db.query(`
      UPDATE cross_venue_arb_signals
      SET action = $2,
          failure_reason = $3,
          kalshi_fill_id = $4,
          polymarket_fill_id = $5,
          kalshi_fill_price = $6,
          polymarket_fill_price = $7,
          updated_at = NOW()
      WHERE id = $1
    `, [
      id,
      update.action,
      update.failureReason ?? null,
      update.kalshiFillId ?? null,
      update.polymarketFillId ?? null,
      update.kalshiFillPrice ?? null,
      update.polymarketFillPrice ?? null,
    ]);
  }

  async loadRecentFilledAttempts(): Promise<FilledAttempt[]> {
    const result = await this.db.query<{ pair_key: string; filled_at_ms: string | number }>(`
      SELECT pair_key, EXTRACT(EPOCH FROM MAX(updated_at)) * 1000 AS filled_at_ms
      FROM cross_venue_arb_signals
      WHERE action = 'filled'
      GROUP BY pair_key
    `);
    return result.rows
      .map((row) => ({ pairKey: row.pair_key, filledAtMs: Number(row.filled_at_ms) }))
      .filter((row) => Number.isFinite(row.filledAtMs));
  }

  async listRecentSignals(limit = 100): Promise<DashboardSignal[]> {
    const result = await this.db.query<DashboardSignalRow>(`
      SELECT
        id, created_at, updated_at, pair_key, expiry_ms,
        kalshi_contract_id, polymarket_contract_id,
        lower_venue, lower_contract_id, lower_strike, lower_direction, lower_ask,
        higher_venue, higher_contract_id, higher_strike, higher_direction, higher_ask,
        premium, guaranteed_profit, overlap_profit, threshold, action, failure_reason,
        kalshi_fill_id, polymarket_fill_id, kalshi_fill_price, polymarket_fill_price
      FROM cross_venue_arb_signals
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    return result.rows.map(signalFromRow);
  }
}
