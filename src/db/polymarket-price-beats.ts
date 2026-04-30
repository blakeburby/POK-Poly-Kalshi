import type { Queryable } from "./signals";

export type PolymarketPriceBeatSource = "chainlink_ws" | "page_metadata" | "gamma";

export interface PolymarketPriceBeatRecord {
  marketSlug: string;
  conditionId: string | null;
  eventStartMs: number;
  expiryMs: number;
  priceToBeat: number;
  source: PolymarketPriceBeatSource;
  sourceTimestampMs: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface PolymarketPriceBeatRepository {
  upsert(record: PolymarketPriceBeatRecord): Promise<void>;
  getBySlug(marketSlug: string): Promise<PolymarketPriceBeatRecord | null>;
  getBySlugs(marketSlugs: string[]): Promise<Map<string, PolymarketPriceBeatRecord>>;
}

interface PolymarketPriceBeatRow {
  market_slug: string;
  condition_id: string | null;
  event_start_ms: string | number;
  expiry_ms: string | number;
  price_to_beat: string | number;
  source: PolymarketPriceBeatSource;
  source_timestamp_ms: string | number | null;
  created_at?: string | Date;
  updated_at?: string | Date;
}

function dateString(value: string | Date | undefined): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function recordFromRow(row: PolymarketPriceBeatRow): PolymarketPriceBeatRecord {
  return {
    marketSlug: row.market_slug,
    conditionId: row.condition_id,
    eventStartMs: Number(row.event_start_ms),
    expiryMs: Number(row.expiry_ms),
    priceToBeat: Number(row.price_to_beat),
    source: row.source,
    sourceTimestampMs: row.source_timestamp_ms == null ? null : Number(row.source_timestamp_ms),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
  };
}

export class PolymarketPriceBeatStore implements PolymarketPriceBeatRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(record: PolymarketPriceBeatRecord): Promise<void> {
    await this.db.query(`
      INSERT INTO polymarket_price_beats (
        market_slug, condition_id, event_start_ms, expiry_ms, price_to_beat, source, source_timestamp_ms
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7
      )
      ON CONFLICT (market_slug) DO UPDATE
      SET condition_id = EXCLUDED.condition_id,
          event_start_ms = EXCLUDED.event_start_ms,
          expiry_ms = EXCLUDED.expiry_ms,
          price_to_beat = EXCLUDED.price_to_beat,
          source = EXCLUDED.source,
          source_timestamp_ms = EXCLUDED.source_timestamp_ms,
          updated_at = NOW()
    `, [
      record.marketSlug,
      record.conditionId,
      record.eventStartMs,
      record.expiryMs,
      record.priceToBeat,
      record.source,
      record.sourceTimestampMs,
    ]);
  }

  async getBySlug(marketSlug: string): Promise<PolymarketPriceBeatRecord | null> {
    const result = await this.db.query<PolymarketPriceBeatRow>(`
      SELECT market_slug, condition_id, event_start_ms, expiry_ms, price_to_beat, source, source_timestamp_ms, created_at, updated_at
      FROM polymarket_price_beats
      WHERE market_slug = $1
    `, [marketSlug]);
    return result.rows[0] ? recordFromRow(result.rows[0]) : null;
  }

  async getBySlugs(marketSlugs: string[]): Promise<Map<string, PolymarketPriceBeatRecord>> {
    if (marketSlugs.length === 0) return new Map();
    const result = await this.db.query<PolymarketPriceBeatRow>(`
      SELECT market_slug, condition_id, event_start_ms, expiry_ms, price_to_beat, source, source_timestamp_ms, created_at, updated_at
      FROM polymarket_price_beats
      WHERE market_slug = ANY($1::text[])
    `, [marketSlugs]);
    return new Map(result.rows.map((row) => [row.market_slug, recordFromRow(row)]));
  }
}
