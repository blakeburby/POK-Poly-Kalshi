CREATE TABLE IF NOT EXISTS cross_venue_arb_signals (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pair_key TEXT NOT NULL,
  expiry_ms BIGINT NOT NULL,
  kalshi_contract_id TEXT NOT NULL,
  polymarket_contract_id TEXT NOT NULL,
  lower_venue TEXT NOT NULL,
  lower_contract_id TEXT NOT NULL,
  lower_strike NUMERIC NOT NULL,
  lower_direction TEXT NOT NULL,
  lower_ask NUMERIC NOT NULL,
  higher_venue TEXT NOT NULL,
  higher_contract_id TEXT NOT NULL,
  higher_strike NUMERIC NOT NULL,
  higher_direction TEXT NOT NULL,
  higher_ask NUMERIC NOT NULL,
  premium NUMERIC NOT NULL,
  guaranteed_profit NUMERIC NOT NULL,
  overlap_profit NUMERIC NOT NULL,
  threshold NUMERIC NOT NULL,
  action TEXT NOT NULL,
  failure_reason TEXT,
  kalshi_fill_id TEXT,
  polymarket_fill_id TEXT,
  kalshi_fill_price NUMERIC,
  polymarket_fill_price NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_pair_created
  ON cross_venue_arb_signals (pair_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cross_venue_arb_signals_action_created
  ON cross_venue_arb_signals (action, created_at DESC);
