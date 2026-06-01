# Trade Profitability Audit - 2026-06-01

## Executive Summary

Live entry is paused for containment: production now has `ARB_ENABLED=false`, while `ARB_LIVE_TRADING=true` and the worker remains healthy. This prevents new arbitrage submissions while the current failure mode is investigated.

The strategy is not losing primarily because the probability model is choosing the wrong side. The dominant live failure is execution and collateral: Polymarket fills first, then Kalshi frequently rejects the hedge with `insufficient_balance`, leaving unhedged Polymarket exposure. Since `2026-05-28`, there are `310` submitted attempts, `239` partials, `206` Kalshi insufficient-balance errors, and `0` exact paired fills.

The dashboard/fill-audit PnL is not a complete account-PnL truth source. Many Polymarket-only rows carry `realized_guaranteed_profit=0` because they are not completed arbitrage pairs, but the account still absorbs real Polymarket settlement/wallet PnL.

## Evidence

Artifacts in this folder:

- `normalized-ledger.csv`: `2108` submitted execution rows from `cross_venue_arb_signals`.
- `venue-order-events.csv`: `4698` captured venue events from `venue_order_events`.
- `audit-summary.tsv`: production aggregate checks.
- `fill-quality-calibration.json`: formal fill-quality calibration report.
- `lead-lag-calibration.err`: production lead/lag calibration failure.
- `account-snapshot.json`: current dashboard/account snapshot after pausing entries.

Production state after containment:

- `ARB_ENABLED=false`
- `ARB_LIVE_TRADING=true`
- `LIVE_ORDER_PLACEMENT_MODE=polymarket_first_exact`
- `LIVE_ORDER_SIZE=8`
- `LIVE_MIN_BOOK_DEPTH_SHARES=10`
- Active DB locks: `0`
- Kalshi portfolio/cash: `$0.0299`
- Polymarket portfolio/cash: about `$161.40`
- Polymarket positions shown by account snapshot: `112`
- Kalshi positions/open orders: `0`

All submitted rows by strategy:

| Strategy | Rows | Filled | Partials | Realized Sum | Avg Projected Edge | Avg Expected Executable Edge |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| null/early | 1017 | 6 | 3 | 0.0000 | 0.0500 | null |
| polymarket_first_exact | 870 | 18 | 467 | 11.9479 | 0.0242 | -1.3321 |
| parallel_fak | 113 | 3 | 103 | -3.9341 | 0.0300 | null |
| parallel_fok | 101 | 9 | 80 | -1.7018 | 0.0324 | null |
| parallel_limit_rest | 4 | 1 | 3 | 0.0600 | 0.0700 | null |
| sequential_hedge | 2 | 0 | 2 | 0.0000 | 0.1150 | null |
| parallel_canary | 1 | 0 | 0 | 0.0464 | 0.0500 | null |

Recent rows since `2026-05-28`:

| Class | Rows | Partials | Realized Sum | Avg Expected Executable Edge |
| --- | ---: | ---: | ---: | ---: |
| Polymarket-only | 226 | 226 | 0.0000 | -3.0577 |
| Zero-both | 71 | 0 | 0.0000 | -1.7999 |
| Near mismatch <= 1 | 13 | 13 | 0.6675 | -1.5447 |

Recent Polymarket-only exposure by day:

| Day UTC | Rows | Polymarket Shares | Avg Fill Price |
| --- | ---: | ---: | ---: |
| 2026-05-28 | 26 | 214.5571 | 0.6604 |
| 2026-05-29 | 31 | 259.6003 | 0.4503 |
| 2026-05-30 | 77 | 639.6845 | 0.5506 |
| 2026-05-31 | 83 | 688.4309 | 0.5783 |
| 2026-06-01 | 9 | 74.2263 | 0.7200 |

The trade cap worked mechanically at `3` attempts per expiry, but that still allowed repeated unhedged or partial attempts in the same expiry window.

## Root Cause

Primary failure mode: the live execution path can spend Polymarket collateral before confirming Kalshi hedge collateral is actually available. In the current `polymarket_first_exact` path, a qualifying Polymarket fill triggers Kalshi immediately. The fast-path timing worked: recent rows show `postFillHedgeDecisionMs` of `0-1ms`. The hedge failed because Kalshi had insufficient balance, not because the bot reacted slowly.

Example recent rows:

- Signal `649600`: Polymarket filled `8.186042`, Kalshi failed `insufficient_balance`.
- Signal `649578`: Polymarket filled `8.188233`, Kalshi failed `insufficient_balance`.
- Signal `646230`: Polymarket filled `8.216215`, Kalshi failed `insufficient_balance`.

Secondary failure modes:

- The fill-quality model was left in shadow mode. Recent average expected executable edge was about `-2.7062`, yet entries still submitted because `LIVE_FILL_QUALITY_GATE_ENABLED=false`.
- The current fill-quality calibration does not pass promotion as-is. It would block `846/852` bad attempts, but it also blocks `18/18` profitable exact historical fills, so the threshold/model needs recalibration before becoming the main gate.
- Lead/lag was not completed in production. The production DB does not have `lead_lag_snapshot`; running lead/lag calibration fails with `column "lead_lag_snapshot" does not exist`.
- Account-level PnL and fill-audit PnL disagree because DB realized edge is mostly pair-level audit math. Polymarket-only settled losses are real wallet PnL even when pair-level guaranteed-profit accounting is `0`.

## Plan Completion Check

Fill-quality plan:

- Phase 1 scoring/persistence: completed in production.
- Phase 2 calibration: implemented locally and run against production in this audit.
- Phase 3 dashboard warnings: code appears present locally, but production deployment status should be verified before relying on it.
- Phase 4 enforcement: not completed; production env has `LIVE_FILL_QUALITY_GATE_ENABLED=false`.
- Promotion result: failed under current criteria because profitable exact fills would be eliminated.

Lead/lag plan:

- Local repo has code/tests/migration artifacts.
- Production does not have the DB column or runtime evidence.
- Calibration cannot run in production.
- Phase 1-4 are not complete in production.

## Highest-Impact Fixes

1. Add a hard Kalshi hedge-collateral readiness gate before submitting Polymarket. If Kalshi cash/collateral cannot cover `LIVE_ORDER_SIZE * maxKalshiHedgePrice + buffer`, skip before any Polymarket order.

2. Treat Kalshi `insufficient_balance` as a hard live readiness failure. One occurrence should pause entries or flip a circuit-breaker until funding/readiness is restored.

3. Reconcile or flatten current Polymarket-only exposure before resuming. The account snapshot shows many Polymarket positions and almost no Kalshi cash, so the system is not in a clean arbitrage-ready state.

4. Recalibrate fill-quality before enforcement. The model is directionally useful for recent bad attempts, but the current `0.01` threshold is too blunt across the full scored sample.

5. Finish or remove lead/lag. Half-local/half-production lead-lag creates false confidence. Either deploy migration/runtime and collect snapshots, or remove it from operator expectations until it is real.

## Resume Criteria

Do not resume `ARB_ENABLED=true` until:

- Kalshi cash/collateral is funded enough for the configured hedge size.
- A pre-Polymarket Kalshi collateral gate is implemented and tested.
- Current Polymarket-only exposure is reconciled.
- `/health` and `/dashboard/snapshot` show venues and user streams ready.
- A dry run confirms the bot skips before Polymarket when Kalshi collateral is insufficient.

