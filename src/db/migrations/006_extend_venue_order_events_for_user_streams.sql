ALTER TABLE venue_order_events
  ADD COLUMN IF NOT EXISTS event_type TEXT,
  ADD COLUMN IF NOT EXISTS asset_id TEXT,
  ADD COLUMN IF NOT EXISTS market_id TEXT,
  ADD COLUMN IF NOT EXISTS side TEXT,
  ADD COLUMN IF NOT EXISTS remaining_count NUMERIC,
  ADD COLUMN IF NOT EXISTS sequence TEXT,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_venue_order_events_venue_order_id
  ON venue_order_events (venue_order_id, created_at DESC)
  WHERE venue_order_id IS NOT NULL;
