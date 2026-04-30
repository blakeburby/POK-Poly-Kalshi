CREATE TABLE IF NOT EXISTS polymarket_price_beats (
  market_slug TEXT PRIMARY KEY,
  condition_id TEXT,
  event_start_ms BIGINT NOT NULL,
  expiry_ms BIGINT NOT NULL,
  price_to_beat NUMERIC NOT NULL,
  source TEXT NOT NULL,
  source_timestamp_ms BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_polymarket_price_beats_event_start
  ON polymarket_price_beats (event_start_ms DESC);

CREATE INDEX IF NOT EXISTS idx_polymarket_price_beats_condition_id
  ON polymarket_price_beats (condition_id);
