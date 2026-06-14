# Hostinger Two-Sided Completion Rate Recovery Report

Generated at: 2026-06-05T10:04:34-07:00

## Goal

Increase the Kalshi/Polymarket worker rolling two-sided completion rate to 50%+, while preserving readiness checks, collateral validation, exposure controls, circuit breakers, audit accounting, fill-quality protections, and all live safety gates.

Hostinger VPS is the production worker source of truth. Railway worker health and Railway region geoblock results are legacy/stale compute evidence and must not be used to decide whether Hostinger production is safe or blocked. Railway may still provide Postgres through `DATABASE_URL`.

## Last Protected Metrics Snapshot

Source: read-only `scripts/completion-rate-report.ts` run against production DB before this Hostinger-first handoff.

- Qualified sample: 20 submitted attempts
- Last-2 completion rate: 0%
- Completion rate: 0%
- First-leg fill rate: 60%
- Hedge fill rate among first-leg fills: 25%
- Avg/P95 total latency: 3911.65ms / 7068.95ms
- Avg/P95 Polymarket RTT: 732.65ms / 1269.45ms
- Avg/P95 Kalshi RTT: 461ms / 1066.1ms
- Failure breakdown: 9 first-leg-filled/no-hedge, 8 first-leg-no-fill, 3 two-sided-size-mismatch

The last two measured failures were both Polymarket fractional overfills versus an exact Kalshi hedge size:

- Signal `666348`: Polymarket filled 8.533332 shares for expected size 8; Kalshi filled 8.
- Signal `666347`: Polymarket filled 8.301885 shares for expected size 8; Kalshi filled 8.

## Implemented Safe Fix

The largest measured worker-controlled failure was spend-based Polymarket market FAK behavior in `polymarket_first_exact`: a buy order spent a USDC amount, so price improvement could fill fractional share counts above the intended hedge size. That created exact-size mismatches and one-sided audit failures.

Implemented changes:

- `polymarket_first_exact` signs a share-sized Polymarket FAK limit order instead of a spend-based market order.
- Polymarket first-leg fill evidence defaults to exact `LIVE_ORDER_SIZE` when min/max fill env vars are unset.
- Production config documentation and env examples match `LIVE_ORDER_SIZE=5`.
- Public sanitized readiness instrumentation is available at `/health?readiness=1` after this branch is deployed.
- Hostinger precheck and branch-deploy scripts use local worker health, protected dashboard readiness, and DB metrics from the VPS.
- Hostinger branch deploy applies the exact-share safety env policy before restart: `LIVE_ORDER_SIZE=5`, exact Polymarket evidence bounds, `LIVE_KALSHI_MIN_CASH_DOLLARS=5`, hardlocks on, reconciliation on.
- Hostinger resume is guarded by `npm run hostinger:resume`; it pauses first, reapplies the same safety env policy, and restores `ARB_ENABLED=true` only after protected readiness verifies venue readiness, geoblock, streams, reconciliation, locks, exposure cap, and collateral from the VPS.
- Root Railway worker deploy config has been removed so Hostinger remains the only worker deploy path.

Verification before Hostinger deploy:

- `node --import tsx --test --test-isolation=none tests/health.test.ts tests/live-execution.test.ts`
- `npm run build:worker`
- `npm test`

## Hostinger Production Verification Required

Run from the local workstation after setting the real SSH target:

```bash
HOSTINGER_SSH_TARGET=user@host npm run hostinger:precheck
```

This read-only check must confirm:

- `pok-worker` is active under systemd.
- `/opt/pok-poly-kalshi` is the worker checkout.
- `/health` reports `liveOrderPlacementMode=polymarket_first_exact`, `liveOrderSize=5`, `liveMinBookDepthShares=10`, and exact `5/5` Polymarket first-fill bounds.
- Protected readiness passes with no active locks, both venues ready, Polymarket geoblock false, user streams ready, reconciliation clean, and sufficient collateral.
- `scripts/completion-rate-report.ts --limit=20` captures current last-2 completion rate, first-leg fill rate, hedge fill rate, latency, edge, and failure breakdown.

## Remaining Bottlenecks Ranked

1. Hostinger protected readiness and egress eligibility

Impact: critical. Hostinger readiness has not yet been remeasured in this branch. Recommended action: deploy the branch to Hostinger only through `npm run hostinger:deploy`, then verify `safeToPlaceOrders=true`, `execution.polymarket.geoblockBlocked=false`, and protected readiness green before enabling new entries.

2. Post-fix exact-share FAK first-leg fill quality

Impact: high but unmeasured after the fix. Recommended action: after Hostinger readiness is green and qualified attempts occur, rerun the completion report after each opportunity and compare exact first-leg fills, Kalshi hedge fills, and final two-sided completion.

3. Kalshi hedge rejects after exact Polymarket fills

Impact: unknown under the exact-size path. Recommended action: if exact Polymarket fills occur but Kalshi misses, inspect Kalshi acknowledgements, private-stream events, collateral, order-group state, and hedge timing before changing routing.

4. External venue/liquidity limitations

Impact: only proven if Hostinger readiness is green and failures persist with exchange evidence. Recommended action: classify as external only after production venue events show rejects, queue loss, no executable depth, or geoblock/liquidity limits that code cannot safely overcome.

## Stop Condition Status

The 50% rolling last-2 success criterion is not met. The exact-share fix is implemented and locally verified, but production success remains unproven until:

- this branch is deployed to Hostinger,
- Hostinger readiness is green,
- at least one of the last two qualified Hostinger production opportunities completes both legs,
- and production DB/order/venue evidence confirms the two-sided fill.
