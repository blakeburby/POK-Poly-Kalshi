ALTER TABLE cross_venue_arb_signals
  ADD COLUMN IF NOT EXISTS fill_quality_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS expected_executable_edge NUMERIC;

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_expected_executable_edge
  ON cross_venue_arb_signals (expected_executable_edge, updated_at DESC)
  WHERE expected_executable_edge IS NOT NULL;
