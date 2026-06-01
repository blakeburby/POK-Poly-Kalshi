# Recovery Actions - 2026-06-01

## Containment

Production entries are paused with `ARB_ENABLED=false`. The worker remains healthy and live-connected, but it should not submit new arbitrage entries until the fixes below are deployed and the Kalshi hedge account is funded.

## Kalshi Hedge-Collateral Gate

The primary loss driver was Polymarket-first fills followed by Kalshi hedge rejection with `insufficient_balance`. The executor now carries a required Kalshi hedge-collateral amount before any Polymarket order can be submitted.

New behavior:

- Kalshi preflight queries `/portfolio/balance` and blocks if cash is below `size * kalshiMaxBuyPrice + LIVE_COLLATERAL_BUFFER_DOLLARS`.
- The executor revalidates Kalshi collateral again after quote refresh and before Polymarket submit.
- Kalshi placement also rechecks collateral unless a fresh preflight already covers the required amount.
- Skipped candidates preserve the exact blocker reason, for example `Kalshi cash balance 0.03 is below required hedge collateral 4.41`.

This is intended to make `insufficient_balance` a pre-submit readiness failure instead of a post-Polymarket hedge failure.

## Polymarket Exposure Reconciliation

Read-only dashboard reconciliation after the pause showed:

- Kalshi portfolio value: `$0.0299`
- Kalshi positions: `0`
- Kalshi open orders: `0`
- Polymarket portfolio value/cash: `$21.396399`
- Polymarket open orders: `0`
- Polymarket historical positions shown: `112`
- Current nonzero Polymarket position value: about `$0.89`, from an old May 16 market

Conclusion: there was no current open order or live 15-minute exposure to flatten automatically. The remaining Polymarket rows are historical/resolved token records plus one tiny stale-valued old position, so no live flattening order was sent.

## Fill-Quality Recalibration

Fresh production recalibration was run against submitted scored attempts.

Results:

- Scored samples: `870`
- First scored row: `2026-05-13T20:45:58.698Z`
- Last scored row: `2026-06-01T03:25:43.519Z`
- Exact paired fills: `18`
- Profitable exact paired fills: `18`
- Partials: `467`
- Failures: `852`
- Bad attempts: `852`
- Simulated gate allowed: `6`
- Simulated gate blocked: `864`
- Blocked bad attempts: `846`
- Blocked profitable exact fills: `18`

Promotion failed. The gate would remove nearly all bad attempts, but it would also remove all profitable exact paired fills, so `LIVE_FILL_QUALITY_GATE_ENABLED` must remain `false`.

## Lead/Lag Plan Alignment

The repo now contains the lead/lag scorer, calibration script, migration, dashboard warning surface, and tests. Production must not be considered lead/lag-complete until the deployed DB has `lead_lag_snapshot` and new submitted/scored rows are collecting that snapshot.

Operational rule:

- If lead/lag code is deployed, keep `LIVE_LEAD_LAG_GATE_ENABLED=false` until calibration passes.
- If production is not deployed with the migration, operator docs must not claim lead/lag production enforcement is active.

## Resume Conditions

Do not resume entries until all are true:

- Kalshi hedge account is funded enough for the configured hedge size plus buffer.
- The deployed worker includes the Kalshi collateral gate.
- `/health` and `/dashboard/snapshot` show `ARB_ENABLED=false` during verification, then only flip back to true intentionally.
- `LIVE_FILL_QUALITY_GATE_ENABLED=false` remains in place until a future recalibration passes.
- Lead/lag is either fully deployed in shadow mode with `lead_lag_snapshot` being collected, or explicitly documented as not production-active.
