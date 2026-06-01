ALTER TABLE cross_venue_arb_signals
  DROP CONSTRAINT IF EXISTS cross_venue_arb_signals_execution_strategy_check;

ALTER TABLE cross_venue_arb_signals
  ADD CONSTRAINT cross_venue_arb_signals_execution_strategy_check
  CHECK (execution_strategy IS NULL OR execution_strategy IN ('sequential_hedge', 'parallel_canary', 'parallel_market', 'parallel_fok', 'parallel_fak', 'parallel_limit_rest', 'polymarket_first_exact'));
