DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'cross_venue_arb_signals'
      AND column_name = 'execution_mode'
  ) THEN
    EXECUTE 'DELETE FROM cross_venue_arb_signals WHERE COALESCE(execution_mode, ''live'') <> ''live''';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_cross_venue_arb_signals_mode_created;
DROP INDEX IF EXISTS idx_cross_venue_arb_signals_mode_filled_updated;
DROP INDEX IF EXISTS idx_cross_venue_arb_signals_live_unresolved_reconciliation;
DROP INDEX IF EXISTS idx_cross_venue_arb_signals_risk_quarantine_active;

ALTER TABLE cross_venue_arb_signals
  DROP CONSTRAINT IF EXISTS cross_venue_arb_signals_execution_mode_check,
  DROP COLUMN IF EXISTS execution_mode;

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_live_unresolved_reconciliation
  ON cross_venue_arb_signals (expiry_ms, updated_at DESC)
  WHERE execution_group_id IS NOT NULL
    AND reconciliation_resolved_at IS NULL
    AND (
      partial_fill = TRUE
      OR COALESCE(kalshi_fill_count, 0) > 0
      OR COALESCE(polymarket_fill_count, 0) > 0
      OR kalshi_status IN ('unknown', 'unexpected_fill_count')
      OR polymarket_status IN ('unknown', 'unexpected_fill_count')
    );

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_risk_quarantine_active
  ON cross_venue_arb_signals (risk_quarantined_at DESC)
  WHERE risk_quarantined_at IS NOT NULL
    AND reconciliation_resolved_at IS NULL;
