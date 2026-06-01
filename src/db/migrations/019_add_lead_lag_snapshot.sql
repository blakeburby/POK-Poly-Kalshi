ALTER TABLE cross_venue_arb_signals
  ADD COLUMN IF NOT EXISTS lead_lag_snapshot JSONB;

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_lead_lag_snapshot
  ON cross_venue_arb_signals (updated_at DESC)
  WHERE lead_lag_snapshot IS NOT NULL;
