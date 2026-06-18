-- Dashboard-only time-series of combined portfolio equity (cash + mark-to-market of
-- all open positions, both venues). Written by the dashboard equity sampler; never read
-- by the trading path. Enables a persistent unified equity curve that survives restarts.
CREATE TABLE IF NOT EXISTS portfolio_equity_snapshots (
  id               BIGSERIAL PRIMARY KEY,
  sampled_at_ms    BIGINT      NOT NULL,
  kalshi_value     NUMERIC,
  polymarket_value NUMERIC,
  combined_value   NUMERIC     NOT NULL,
  kalshi_cash      NUMERIC,
  polymarket_cash  NUMERIC,
  source           TEXT        NOT NULL DEFAULT 'sampled',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_equity_sampled_at
  ON portfolio_equity_snapshots (sampled_at_ms DESC);

-- Makes the optional one-time realized-P&L backfill idempotent without constraining live samples.
CREATE UNIQUE INDEX IF NOT EXISTS uq_portfolio_equity_reconstructed_bucket
  ON portfolio_equity_snapshots (sampled_at_ms)
  WHERE source = 'reconstructed';
