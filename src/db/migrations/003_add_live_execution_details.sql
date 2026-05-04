ALTER TABLE cross_venue_arb_signals
  ADD COLUMN IF NOT EXISTS execution_group_id TEXT,
  ADD COLUMN IF NOT EXISTS kalshi_client_order_id TEXT,
  ADD COLUMN IF NOT EXISTS polymarket_client_order_id TEXT,
  ADD COLUMN IF NOT EXISTS kalshi_status TEXT,
  ADD COLUMN IF NOT EXISTS polymarket_status TEXT,
  ADD COLUMN IF NOT EXISTS kalshi_fill_count NUMERIC,
  ADD COLUMN IF NOT EXISTS polymarket_fill_count NUMERIC,
  ADD COLUMN IF NOT EXISTS kalshi_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kalshi_responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS polymarket_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS polymarket_responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kalshi_error TEXT,
  ADD COLUMN IF NOT EXISTS polymarket_error TEXT,
  ADD COLUMN IF NOT EXISTS partial_fill BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_execution_group
  ON cross_venue_arb_signals (execution_group_id)
  WHERE execution_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_partial_fill
  ON cross_venue_arb_signals (partial_fill, updated_at DESC)
  WHERE partial_fill = TRUE;
