# RUNBOOK

## Runtime Model

POK is live-only. The worker monitors Kalshi and Polymarket books, evaluates protected BTC 15-minute spreads, and records only real live execution attempts and venue evidence. To pause new entries without taking the process down, set `ARB_ENABLED=false` and restart `pok-worker`.

## Required Environment

- `DATABASE_URL`: Postgres connection string.
- `DASHBOARD_API_TOKEN`: shared bearer token used by the dashboard proxy.
- `KALSHI_API_KEY_ID`: Kalshi API key id.
- `KALSHI_PRIVATE_KEY` or `KALSHI_PRIVATE_KEY_B64`: Kalshi RSA private key.
- `POLYMARKET_PRIVATE_KEY`: dedicated low-balance bot wallet private key.
- `POLYMARKET_SIGNATURE_TYPE=3`: current deposit-wallet/API-wallet mode for the configured account.
- `POLYMARKET_FUNDER_ADDRESS`: required for proxy/safe wallets.
- `POLYMARKET_CHAIN_ID=137`.
- `POLYMARKET_CLOB_HOST=https://clob.polymarket.com`.
- `POLYMARKET_GEOBLOCK_URL=https://polymarket.com/api/geoblock`.

## Core Live Settings

- `ARB_ENABLED=true`: allow the scanner to submit qualifying live entries.
- `ARB_MIN_PROFIT_DOLLARS=0.01`: required minimum executable edge after the taker cushion.
- `ARB_REENTRY_INTERVAL_MS=60000`: pair/configuration cooldown.
- `ARB_SCAN_HEARTBEAT_MS=250`: fallback scan heartbeat; websocket book updates still trigger scans immediately.
- `ARB_EXECUTION_CONCURRENCY=1`: first production posture for live attempts.
- `LIVE_ORDER_PLACEMENT_MODE=polymarket_first_exact`: submit Polymarket FAK first, then submit Kalshi only after Polymarket confirms a fill inside the configured hedge-trigger range.
- `POLYMARKET_ORDER_TYPE=FAK`: Polymarket immediate order type used by the first leg.
- `LIVE_ORDER_SIZE=5`: venue share size.
- `LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES=4` and `LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES=6`: inclusive Polymarket fill range that triggers the fixed 5-contract Kalshi hedge; non-5 Polymarket fills remain partial/mismatch audit records.
- `LIVE_TAKER_PRICE_CUSHION_CENTS=2`: per-leg taker cushion included in the edge gate before entry.
- `LIVE_MIN_EXPIRY_MS=60000`: skip entries inside the final minute.
- `LIVE_MAX_TRADES_PER_WINDOW=3`: max real submitted live attempts per 15-minute expiry window.
- `LIVE_COLLATERAL_BUFFER_DOLLARS=0.25`: extra collateral required before entry.
- `LIVE_QUOTE_MAX_AGE_MS=750`: max individual book age.
- `LIVE_QUOTE_SYNC_MAX_SKEW_MS=250`: max cross-venue book skew.
- `LIVE_MIN_BOOK_DEPTH_SHARES=5`: minimum executable depth.
- `LIVE_ORDER_TIMEOUT_MS=2500`: REST order timeout.
- `LIVE_HOT_PATH_ENABLED=true`: keep readiness, metadata, locks, and exposure state warm in memory.
- `LIVE_LOW_LATENCY_HTTP_ENABLED=true`: enable keep-alive order transports.
- `LIVE_POLYMARKET_PRESIGN_ENABLED=true`: pre-sign fresh Polymarket market orders before the timed submit section so the Polymarket-first path mostly performs `postOrder`.
- `LIVE_KALSHI_PREARM_ENABLED=true`: prebuild and pre-sign the Kalshi hedge request during preflight, then patch only the final price after qualifying Polymarket hedge-trigger evidence.
- `LIVE_KALSHI_PREARM_MAX_AGE_MS=5000`: discard stale pre-armed Kalshi requests and fall back to live signing.
- `LIVE_KALSHI_PREARM_PRICE_POLICY=patch_after_fill`: keep Kalshi fully prepared while still using the actual Polymarket fill price for the final hedge cap.
- `LIVE_USER_STREAMS_ENABLED=true`: require authenticated order streams.
- `LIVE_USER_STREAM_CONFIRM_TIMEOUT_MS=2500`: private-stream confirmation wait after submit.
- `LIVE_RECONCILE_BEFORE_TRADE=true`: block entries when unresolved venue evidence requires operator review.
- `LIVE_AUTO_HARDLOCKS_ENABLED=true`: normal persistent-lock policy. Temporary operator overrides must be explicit and visible on the dashboard.
- `LIVE_EXACT_EXPOSURE_REQUIRED=false`: unresolved partial, mismatched, unknown, or quarantined exposure stays audited and visible by default but does not block new entries. Set this to `true` to restore strict exact-exposure blocking.
- `LIVE_EXECUTION_QUALITY_GATE_ENABLED=true`: block entries when recent Polymarket exact-fill quality is too poor or estimated executable edge turns negative after mismatch cost.
- `LIVE_FILL_QUALITY_SCORING_ENABLED=true`: score each candidate’s expected executable edge from recent fills, mismatch cost, quote quality, and latency before submit.
- `LIVE_FILL_QUALITY_GATE_ENABLED=false`: start candidate-level fill quality in shadow mode; set to `true` only after calibration proves the gate reduces bad attempts.
- `LIVE_FILL_QUALITY_MIN_EXPECTED_EDGE=0.01`: future enforcement threshold for expected executable edge after fill probability, slippage, mismatch, and timeout costs.
- `LIVE_PARTIAL_FILL_LOCK_MODE=quarantine`: verified bounded one-sided exposure can be quarantined instead of globally stopping the worker.
- `LIVE_MAX_UNRESOLVED_EXPOSURE_DOLLARS=10`: total quarantined exposure cap.

## Dashboard

The dashboard has one live surface:

- `/` renders the live dashboard.
- `/?dashboard=live` is accepted as the same live dashboard.
- Any other dashboard query is ignored by the page.

The browser never receives venue secrets or the worker bearer token. It is read-only and cannot arm, disarm, clear locks, or place orders.

## Deploy Flow

1. Back up Postgres before migrations that remove legacy rows or columns.
2. Pull the target commit on the worker host.
3. Confirm `/etc/pok-poly-kalshi/worker.env` has the live credentials and `ARB_ENABLED=true` only when entries should be allowed.
4. Run `npm install`, `npm run build:worker`, and `npm run migrate`.
5. Restart `pok-worker`.
6. Verify `/health`, `/dashboard/snapshot`, venue readiness, user streams, reconciliation state, active locks, and recent live signal tape.
7. Deploy the dashboard with `npm run build:dashboard` or the Vercel production deploy flow.

## Operational Checks

Healthy live state requires:

- `pok-worker` active.
- `health.liveTrading=true`.
- `health.arbEnabled=true`.
- `execution.kalshi.ready=true`.
- `execution.polymarket.ready=true`.
- `execution.userStreams.ready=true`.
- `execution.reconciliation.clean=true`.
- `execution.circuitBreakerLocked=false`.
- `execution.partialFillLocked=false`.
- No active rows in `live_execution_locks`.

If `ARB_ENABLED=false`, the worker remains online for discovery/readiness but will not submit new entries.

## Risk And Recovery

Persistent locks are intentional when exposure cannot be proven safe. Do not clear a lock until authoritative venue data proves one of these outcomes:

- Both venues filled exact matching size.
- Both venues have zero fill and no open order.
- One-sided exposure has been manually resolved or is explicitly quarantined under the configured cap.

After correcting the signal/audit rows and clearing a lock, restart `pok-worker` so any in-memory latch is reset.

## Rollback

Set `ARB_ENABLED=false` and restart the worker to stop new entries immediately while preserving discovery, dashboard status, and audit visibility.
