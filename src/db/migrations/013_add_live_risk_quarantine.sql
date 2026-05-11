ALTER TABLE cross_venue_arb_signals
  ADD COLUMN IF NOT EXISTS risk_quarantined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS risk_quarantine_reason TEXT,
  ADD COLUMN IF NOT EXISTS risk_quarantine_exposure_dollars NUMERIC,
  ADD COLUMN IF NOT EXISTS risk_quarantine_evidence JSONB;

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_risk_quarantine_active
  ON cross_venue_arb_signals (risk_quarantined_at DESC)
  WHERE risk_quarantined_at IS NOT NULL
    AND reconciliation_resolved_at IS NULL;
