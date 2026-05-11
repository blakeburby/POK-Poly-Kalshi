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

export type VenueOrderEventListener = (event: VenueOrderEventInput) => void;

function isoFromMs(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

export class VenueOrderEventStore implements VenueOrderEventWriter {
  constructor(private readonly db: Queryable) {}

  async recordEvent(input: VenueOrderEventInput): Promise<void> {
    await this.db.query(`
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
    `, [
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
    ]);
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
}

export class VenueOrderEventHub implements VenueOrderEventWriter {
  private readonly listeners = new Set<VenueOrderEventListener>();

  constructor(private readonly store: VenueOrderEventWriter) {}

  onEvent(listener: VenueOrderEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async recordEvent(input: VenueOrderEventInput): Promise<void> {
    const event = { ...input, receivedAtMs: input.receivedAtMs ?? Date.now() };
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
}
