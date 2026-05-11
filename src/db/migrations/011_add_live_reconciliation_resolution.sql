ALTER TABLE cross_venue_arb_signals
  ADD COLUMN IF NOT EXISTS reconciliation_resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciliation_resolution_reason TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_resolution JSONB;

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_live_unresolved_reconciliation
  ON cross_venue_arb_signals (expiry_ms, updated_at DESC)
  WHERE execution_mode = 'live'
    AND execution_group_id IS NOT NULL
    AND reconciliation_resolved_at IS NULL
    AND (
      partial_fill = TRUE
      OR COALESCE(kalshi_fill_count, 0) > 0
      OR COALESCE(polymarket_fill_count, 0) > 0
      OR kalshi_status IN ('unknown', 'unexpected_fill_count')
      OR polymarket_status IN ('unknown', 'unexpected_fill_count')
    );

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_reconciliation_resolved
  ON cross_venue_arb_signals (reconciliation_resolved_at DESC)
  WHERE reconciliation_resolved_at IS NOT NULL;
