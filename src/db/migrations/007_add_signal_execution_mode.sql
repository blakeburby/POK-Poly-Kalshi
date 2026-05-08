ALTER TABLE cross_venue_arb_signals
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'paper';

UPDATE cross_venue_arb_signals
SET execution_mode = 'live'
WHERE execution_mode <> 'live'
  AND (
    execution_group_id IS NOT NULL
    OR kalshi_client_order_id IS NOT NULL
    OR polymarket_client_order_id IS NOT NULL
    OR kalshi_status IS NOT NULL
    OR polymarket_status IS NOT NULL
    OR venue_confirmations IS NOT NULL
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cross_venue_arb_signals_execution_mode_check'
  ) THEN
    ALTER TABLE cross_venue_arb_signals
      ADD CONSTRAINT cross_venue_arb_signals_execution_mode_check
      CHECK (execution_mode IN ('paper', 'live'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_mode_created
  ON cross_venue_arb_signals (execution_mode, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_mode_filled_updated
  ON cross_venue_arb_signals (execution_mode, updated_at ASC)
  WHERE action = 'filled';
