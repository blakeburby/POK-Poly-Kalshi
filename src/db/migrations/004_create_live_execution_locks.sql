CREATE TABLE IF NOT EXISTS live_execution_locks (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'critical',
  source_signal_id BIGINT REFERENCES cross_venue_arb_signals(id) ON DELETE SET NULL,
  execution_group_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  cleared_at TIMESTAMPTZ,
  clear_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_live_execution_locks_active
  ON live_execution_locks (created_at DESC)
  WHERE cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_live_execution_locks_execution_group
  ON live_execution_locks (execution_group_id)
  WHERE execution_group_id IS NOT NULL;
