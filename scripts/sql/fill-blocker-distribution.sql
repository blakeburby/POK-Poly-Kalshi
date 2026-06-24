-- Fill-blocker distribution — validation query for the 2026-06-23 fill-blocker fixes
-- (P0.1 api-key-error legibility, P1.3 quote-skew both-fresh, P1.4 hot-readiness balance-coverage).
--
-- Run during ACTIVE order flow (the signal is meaningless in a quiet market). On the prod box:
--   psql "$DATABASE_URL" -v hours=6 -f scripts/sql/fill-blocker-distribution.sql
-- (or paste inline). Adjust :hours as needed. Expectations after the fixes deployed (d9d2d8f / 2707bf6):
--   * apikey_derive failures  -> ~0   (P0.1 + the throttle fix removed the masked synchronous-derive failures)
--   * quote_skew / cache_coverage skips DOWN   (P1.3 / P1.4 stopped dropping fillable candidates)
--   * NO rise in one-sided fills or new locks  (the safety check — second query below)

\if :{?hours}
\else
  \set hours 6
\endif

-- 1) Attempt outcomes + failure-reason classes over the window.
SELECT
  action,
  CASE
    WHEN failure_reason ILIKE '%could not derive or create api key%'                       THEN 'apikey_derive (P0.1)'
    WHEN failure_reason ILIKE '%quote skew%'                                                THEN 'quote_skew (P1.3)'
    WHEN failure_reason ILIKE '%hot readiness cache covers%'                                THEN 'cache_coverage (P1.4)'
    WHEN failure_reason ILIKE '%below required collateral%'                                 THEN 'funding_shortfall'
    WHEN failure_reason ILIKE '%no orders found to match%' OR failure_reason ILIKE '%FAK%'  THEN 'fak_no_match'
    WHEN failure_reason ILIKE '%stream%timeout%' OR failure_reason ILIKE '%confirmation%'   THEN 'confirmation/stream'
    WHEN failure_reason IS NULL                                                             THEN '(no reason)'
    ELSE left(failure_reason, 48)
  END AS reason_class,
  count(*) AS n
FROM cross_venue_arb_signals
WHERE created_at > now() - (:'hours' || ' hours')::interval
GROUP BY 1, 2
ORDER BY action, n DESC;

-- 2) Safety check: of the attempts that filled at least one leg, how many were exact-pair vs one-sided?
--    A rise in one_sided_or_mismatch after the fixes would be a regression.
SELECT
  count(*) FILTER (WHERE kalshi_fill_count > 0 AND polymarket_fill_count > 0
                     AND abs(kalshi_fill_count - polymarket_fill_count) < 1)            AS exact_pair,
  count(*) FILTER (WHERE (kalshi_fill_count > 0) <> (polymarket_fill_count > 0))         AS one_sided,
  count(*) FILTER (WHERE kalshi_fill_count > 0 AND polymarket_fill_count > 0
                     AND abs(kalshi_fill_count - polymarket_fill_count) >= 1)            AS size_mismatch
FROM cross_venue_arb_signals
WHERE created_at > now() - (:'hours' || ' hours')::interval
  AND (kalshi_fill_count > 0 OR polymarket_fill_count > 0);
