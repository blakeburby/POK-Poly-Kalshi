ALTER TABLE cross_venue_arb_signals
  ADD COLUMN IF NOT EXISTS recovery_status TEXT,
  ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER,
  ADD COLUMN IF NOT EXISTS recovery_evidence JSONB,
  ADD COLUMN IF NOT EXISTS finalization_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_recovery_status
  ON cross_venue_arb_signals (recovery_status, updated_at DESC)
  WHERE recovery_status IS NOT NULL;
