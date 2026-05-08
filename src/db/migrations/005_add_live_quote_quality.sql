ALTER TABLE cross_venue_arb_signals
  ADD COLUMN IF NOT EXISTS quote_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS depth_vwap NUMERIC,
  ADD COLUMN IF NOT EXISTS projected_edge_after_fees NUMERIC,
  ADD COLUMN IF NOT EXISTS execution_timings JSONB,
  ADD COLUMN IF NOT EXISTS venue_confirmations JSONB;

CREATE TABLE IF NOT EXISTS venue_order_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execution_group_id TEXT,
  venue TEXT NOT NULL,
  client_order_id TEXT,
  venue_order_id TEXT,
  event_type TEXT,
  asset_id TEXT,
  market_id TEXT,
  side TEXT,
  status TEXT NOT NULL,
  fill_count NUMERIC,
  remaining_count NUMERIC,
  fill_price NUMERIC,
  fee NUMERIC,
  exchange_ts TIMESTAMPTZ,
  sequence TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_venue_order_events_execution_group
  ON venue_order_events (execution_group_id, created_at DESC)
  WHERE execution_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_venue_order_events_client_order_id
  ON venue_order_events (client_order_id, created_at DESC)
  WHERE client_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_venue_order_events_venue_order_id
  ON venue_order_events (venue_order_id, created_at DESC)
  WHERE venue_order_id IS NOT NULL;
