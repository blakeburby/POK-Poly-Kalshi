import type { Venue } from "../types";
import type { VenueOrderResult } from "../execution/live-clients";
import type { Queryable } from "./signals";

export interface VenueOrderEventInput {
  executionGroupId?: string | null;
  venue: Venue;
  clientOrderId?: string | null;
  venueOrderId?: string | null;
  eventType?: string | null;
  assetId?: string | null;
  marketId?: string | null;
  side?: string | null;
  status: string;
  fillCount?: number | null;
  remainingCount?: number | null;
  fillPrice?: number | null;
  fee?: number | null;
  exchangeTimestampMs?: number | null;
  sequence?: string | number | null;
  receivedAtMs?: number | null;
  raw?: Record<string, unknown>;
}

export interface VenueOrderEventWriter {
  recordEvent(input: VenueOrderEventInput): Promise<void>;
  recordVenueResult(executionGroupId: string, result: VenueOrderResult): Promise<void>;
}

export interface VenueOrderEventReader {
  listRecentEvents(sinceMs: number, limit: number): Promise<VenueOrderEventInput[]>;
}

export type VenueOrderEventListener = (event: VenueOrderEventInput) => void;

function isoFromMs(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

export class VenueOrderEventStore implements VenueOrderEventWriter, VenueOrderEventReader {
  constructor(private readonly db: Queryable) {}

  async recordEvent(input: VenueOrderEventInput): Promise<void> {
    await this.db.query(
      `
      INSERT INTO venue_order_events (
        execution_group_id, venue, client_order_id, venue_order_id,
        event_type, asset_id, market_id, side, status,
        fill_count, remaining_count, fill_price, fee, exchange_ts, sequence, received_at, raw
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12, $13,
        CASE WHEN $14::TEXT IS NULL THEN NULL ELSE $14::TIMESTAMPTZ END,
        $15,
        CASE WHEN $16::TEXT IS NULL THEN NOW() ELSE $16::TIMESTAMPTZ END,
        $17::JSONB
      )
    `,
      [
        input.executionGroupId ?? null,
        input.venue,
        input.clientOrderId ?? null,
        input.venueOrderId ?? null,
        input.eventType ?? null,
        input.assetId ?? null,
        input.marketId ?? null,
        input.side ?? null,
        input.status,
        input.fillCount ?? null,
        input.remainingCount ?? null,
        input.fillPrice ?? null,
        input.fee ?? null,
        isoFromMs(input.exchangeTimestampMs),
        input.sequence == null ? null : String(input.sequence),
        isoFromMs(input.receivedAtMs),
        JSON.stringify(input.raw ?? {}),
      ],
    );
  }

  async recordVenueResult(executionGroupId: string, result: VenueOrderResult): Promise<void> {
    await this.recordEvent({
      executionGroupId,
      venue: result.venue,
      clientOrderId: result.clientOrderId,
      venueOrderId: result.orderId,
      eventType: "rest_response",
      status: result.status,
      fillCount: result.fillCount,
      fillPrice: result.fillPrice,
      fee: result.fee,
      exchangeTimestampMs: result.exchangeTimestampMs,
      raw: {
        requestedAt: result.requestedAt,
        respondedAt: result.respondedAt,
        error: result.error,
        metadata: result.metadata ?? null,
      },
    });
  }

  async listRecentEvents(sinceMs: number, limit: number): Promise<VenueOrderEventInput[]> {
    const result = await this.db.query<{
      execution_group_id: string | null;
      venue: Venue;
      client_order_id: string | null;
      venue_order_id: string | null;
      event_type: string | null;
      asset_id: string | null;
      market_id: string | null;
      side: string | null;
      status: string;
      fill_count: string | number | null;
      remaining_count: string | number | null;
      fill_price: string | number | null;
      fee: string | number | null;
      exchange_ts: string | Date | null;
      sequence: string | null;
      received_at: string | Date | null;
      raw: Record<string, unknown> | string | null;
    }>(
      `
      SELECT execution_group_id, venue, client_order_id, venue_order_id,
             event_type, asset_id, market_id, side, status,
             fill_count, remaining_count, fill_price, fee, exchange_ts, sequence, received_at, raw
      FROM venue_order_events
      WHERE received_at >= $1::TIMESTAMPTZ
      ORDER BY received_at DESC
      LIMIT $2
    `,
      [isoFromMs(sinceMs), Math.max(1, Math.floor(limit))],
    );
    return result.rows.map((row) => ({
      executionGroupId: row.execution_group_id,
      venue: row.venue,
      clientOrderId: row.client_order_id,
      venueOrderId: row.venue_order_id,
      eventType: row.event_type,
      assetId: row.asset_id,
      marketId: row.market_id,
      side: row.side,
      status: row.status,
      fillCount: row.fill_count == null ? null : Number(row.fill_count),
      remainingCount: row.remaining_count == null ? null : Number(row.remaining_count),
      fillPrice: row.fill_price == null ? null : Number(row.fill_price),
      fee: row.fee == null ? null : Number(row.fee),
      exchangeTimestampMs: row.exchange_ts == null ? null : new Date(row.exchange_ts).getTime(),
      sequence: row.sequence,
      receivedAtMs: row.received_at == null ? null : new Date(row.received_at).getTime(),
      raw: typeof row.raw === "string" ? (JSON.parse(row.raw) as Record<string, unknown>) : (row.raw ?? {}),
    }));
  }
}

export class VenueOrderEventHub implements VenueOrderEventWriter, VenueOrderEventReader {
  private readonly listeners = new Set<VenueOrderEventListener>();
  private readonly recentEvents: VenueOrderEventInput[] = [];

  constructor(private readonly store: VenueOrderEventWriter) {}

  onEvent(listener: VenueOrderEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async recordEvent(input: VenueOrderEventInput): Promise<void> {
    const event = { ...input, receivedAtMs: input.receivedAtMs ?? Date.now() };
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > 500) this.recentEvents.length = 500;
    await this.store.recordEvent(event);
    for (const listener of this.listeners) listener(event);
  }

  async recordVenueResult(executionGroupId: string, result: VenueOrderResult): Promise<void> {
    await this.recordEvent({
      executionGroupId,
      venue: result.venue,
      clientOrderId: result.clientOrderId,
      venueOrderId: result.orderId,
      eventType: "rest_response",
      status: result.status,
      fillCount: result.fillCount,
      fillPrice: result.fillPrice,
      fee: result.fee,
      exchangeTimestampMs: result.exchangeTimestampMs,
      raw: {
        requestedAt: result.requestedAt,
        respondedAt: result.respondedAt,
        error: result.error,
        metadata: result.metadata ?? null,
      },
    });
  }

  async listRecentEvents(sinceMs: number, limit: number): Promise<VenueOrderEventInput[]> {
    const boundedLimit = Math.max(1, Math.floor(limit));
    const fromHub = this.recentEvents.filter((event) => (event.receivedAtMs ?? 0) >= sinceMs).slice(0, boundedLimit);
    if (fromHub.length > 0) return fromHub;
    const reader = this.store as VenueOrderEventWriter & Partial<VenueOrderEventReader>;
    if (typeof reader.listRecentEvents === "function") return reader.listRecentEvents(sinceMs, boundedLimit);
    return [];
  }
}
