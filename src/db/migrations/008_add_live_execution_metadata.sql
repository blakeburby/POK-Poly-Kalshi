ALTER TABLE cross_venue_arb_signals
  ADD COLUMN IF NOT EXISTS execution_strategy TEXT,
  ADD COLUMN IF NOT EXISTS risk_hedge BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS realized_guaranteed_profit NUMERIC,
  ADD COLUMN IF NOT EXISTS hedge_cap_price NUMERIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cross_venue_arb_signals_execution_strategy_check'
  ) THEN
    ALTER TABLE cross_venue_arb_signals
      ADD CONSTRAINT cross_venue_arb_signals_execution_strategy_check
      CHECK (execution_strategy IS NULL OR execution_strategy IN ('sequential_hedge', 'parallel_canary'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_risk_hedge_updated
  ON cross_venue_arb_signals (risk_hedge, updated_at DESC)
  WHERE risk_hedge = TRUE;
