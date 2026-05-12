DELETE FROM cross_venue_arb_signals
WHERE execution_group_id IS NULL
  AND (
    action = 'filled'
    OR kalshi_fill_id IS NOT NULL
    OR polymarket_fill_id IS NOT NULL
    OR COALESCE(kalshi_fill_count, 0) > 0
    OR COALESCE(polymarket_fill_count, 0) > 0
    OR partial_fill = TRUE
    OR risk_quarantined_at IS NOT NULL
    OR reconciliation_resolved_at IS NOT NULL
  );
