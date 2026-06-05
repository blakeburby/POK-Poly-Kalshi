# RUNBOOK

## Runtime Model

POK is live-only. The production worker runs on the Hostinger VPS as the systemd service `pok-worker`. It monitors Kalshi and Polymarket books, evaluates protected BTC 15-minute spreads, and records only real live execution attempts and venue evidence. To pause new entries without taking the process down, set `ARB_ENABLED=false` in `/etc/pok-poly-kalshi/worker.env` and restart `pok-worker`.

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
- `LIVE_ORDER_PLACEMENT_MODE=polymarket_first_exact`: submit Polymarket FAK first, then hedge Kalshi after an in-range Polymarket fill.
- `POLYMARKET_ORDER_TYPE=FAK`: Polymarket immediate order type used by the first leg.
- `LIVE_ORDER_PLACEMENT_MODE=parallel_market`: alternative capped market mode that submits Kalshi IOC-style and Polymarket market FAK concurrently.
- `LIVE_ORDER_PLACEMENT_MODE=parallel_limit_rest`: rollback to the preserved aggressive GTC limit-rest/cancel path with `LIVE_AGGRESSIVE_LIMIT_REST_MS`.
- `LIVE_ORDER_SIZE=5`: venue share size.
- `LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES` and `LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES`: optional exact-fill evidence bounds for `polymarket_first_exact`. Leave both unset to require the Polymarket fill count to match `LIVE_ORDER_SIZE`.
- `LIVE_TAKER_PRICE_CUSHION_CENTS=2`: per-leg taker cushion included in the edge gate before entry.
- `LIVE_MIN_EXPIRY_MS=60000`: skip entries inside the final minute.
- `LIVE_MAX_TRADES_PER_WINDOW=3`: max real submitted live attempts per 15-minute expiry window.
- `LIVE_COLLATERAL_BUFFER_DOLLARS=0.25`: extra collateral required before entry.
- `LIVE_QUOTE_MAX_AGE_MS=750`: max individual book age.
- `LIVE_QUOTE_SYNC_MAX_SKEW_MS=250`: max cross-venue book skew.
- `LIVE_MIN_BOOK_DEPTH_SHARES=10`: minimum executable depth. With `LIVE_ORDER_SIZE=5`, this requires at least 10 executable shares/contracts before entry.
- `LIVE_ORDER_TIMEOUT_MS=2500`: REST order timeout.
- `LIVE_HOT_PATH_ENABLED=true`: keep readiness, metadata, locks, and exposure state warm in memory.
- `LIVE_LOW_LATENCY_HTTP_ENABLED=true`: enable keep-alive order transports.
- `LIVE_POLYMARKET_PRESIGN_ENABLED=true`: pre-sign fresh Polymarket market orders before the timed submit section so immediate paths mostly perform `postOrder`.
- `LIVE_KALSHI_PREARM_ENABLED=true`: prebuild and pre-sign the Kalshi hedge request for the optional `polymarket_first_exact` path, then patch only the final price after qualifying Polymarket hedge-trigger evidence.
- `LIVE_KALSHI_PREARM_MAX_AGE_MS=5000`: discard stale pre-armed Kalshi requests and fall back to live signing.
- `LIVE_KALSHI_PREARM_PRICE_POLICY=patch_after_fill`: keep Kalshi fully prepared while still using the actual Polymarket fill price for the final hedge cap.
- `LIVE_USER_STREAMS_ENABLED=true`: require authenticated order streams.
- `LIVE_USER_STREAM_CONFIRM_TIMEOUT_MS=2500`: private-stream confirmation wait after submit.
- `LIVE_RECONCILE_BEFORE_TRADE=true`: block entries when unresolved venue evidence requires operator review.
- `LIVE_AUTO_HARDLOCKS_ENABLED=true`: normal persistent-lock policy. Temporary operator overrides must be explicit and visible on the dashboard.
- `LIVE_EXACT_EXPOSURE_REQUIRED=false`: unresolved partial, mismatched, unknown, or quarantined exposure stays audited and visible by default but does not block new entries. Set this to `true` to restore strict exact-exposure blocking.
- `LIVE_EXECUTION_QUALITY_GATE_ENABLED=true`: block entries when recent Polymarket exact-fill quality is too poor or estimated executable edge turns negative after mismatch cost.
- `LIVE_KALSHI_MIN_CASH_DOLLARS=30`: require a multi-trade Kalshi operating cash floor before any Polymarket-first entry can submit. Use `$100+` as the preferred funding target before resuming production volume.
- `LIVE_FILL_QUALITY_SCORING_ENABLED=true`: score each candidate’s expected executable edge from recent fills, mismatch cost, quote quality, and latency before submit.
- `LIVE_FILL_QUALITY_GATE_ENABLED=false`: start candidate-level fill quality in shadow mode; set to `true` only after calibration proves the gate reduces bad attempts.
- `LIVE_FILL_QUALITY_MIN_EXPECTED_EDGE=0.01`: future enforcement threshold for expected executable edge after fill probability, slippage, mismatch, and timeout costs.
- `LIVE_LEAD_LAG_SCORING_ENABLED=true`: score cross-venue price-discovery/staleness from recent Kalshi and Polymarket book movement.
- `LIVE_LEAD_LAG_GATE_ENABLED=false`: keep lead/lag in shadow mode until calibration proves high-adverse buckets should block entries.
- `LIVE_LEAD_LAG_WINDOWS_MS=1000,5000,15000,60000`: rolling book-history windows used for leader/lagger inference.
- `LIVE_PARTIAL_FILL_LOCK_MODE=quarantine`: verified bounded one-sided exposure can be quarantined instead of globally stopping the worker.
- `LIVE_MAX_UNRESOLVED_EXPOSURE_DOLLARS=10`: total quarantined exposure cap.

## Fill Quality Phase Gates

Phase 1 is shadow scoring only: keep `LIVE_FILL_QUALITY_SCORING_ENABLED=true` and `LIVE_FILL_QUALITY_GATE_ENABLED=false` while the worker collects candidate-level predictions.

Phase 2 calibration is read-only:

```bash
npm run fill-quality:calibrate -- --limit=2000
```

Do not promote fill-quality enforcement unless the report passes all criteria: at least 200 submitted scored attempts, lower predicted paired-fill buckets have materially worse exact-fill rates, the simulated `expectedExecutableEdge >= 0.01` gate removes at least 25% of bad/partial/unknown attempts, and it removes no more than 50% of profitable exact paired fills.

Phase 3 dashboard warnings are operator-only. A shadow score below the configured minimum expected edge should render as a warning, but must not block entries while `LIVE_FILL_QUALITY_GATE_ENABLED=false`.

Phase 4 enforcement is a config-only promotion after calibration passes:

```bash
LIVE_FILL_QUALITY_GATE_ENABLED=true
systemctl restart pok-worker
```

Rollback is the reverse config flip back to `LIVE_FILL_QUALITY_GATE_ENABLED=false` followed by a worker restart.

## Lead/Lag Phase Gates

Phase 1 is shadow scoring only: keep `LIVE_LEAD_LAG_SCORING_ENABLED=true` and `LIVE_LEAD_LAG_GATE_ENABLED=false` while the worker collects candidate-level price-discovery snapshots.

Phase 2 calibration is read-only:

```bash
npm run lead-lag:calibrate -- --limit=2000
```

Do not promote lead/lag enforcement unless the report passes all criteria: at least 200 submitted scored attempts, high-adverse buckets have materially worse exact-fill rates or realized edge than low-adverse buckets, the simulated gate removes at least 15% of bad/partial/unknown attempts, and it removes no more than 50% of profitable exact paired fills.

Phase 3 dashboard warnings are operator-only. A shadow score that would fail the configured lead/lag gate should render as a warning, but must not block entries while `LIVE_LEAD_LAG_GATE_ENABLED=false`.

Phase 4 enforcement is a config-only promotion after calibration passes:

```bash
LIVE_LEAD_LAG_GATE_ENABLED=true
systemctl restart pok-worker
```

Rollback is the reverse config flip back to `LIVE_LEAD_LAG_GATE_ENABLED=false` followed by a worker restart.

## Dashboard

The dashboard has one live surface:

- `/` renders the live dashboard.
- `/?dashboard=live` is accepted as the same live dashboard.
- Any other dashboard query is ignored by the page.

The browser never receives venue secrets or the worker bearer token. It is read-only and cannot arm, disarm, clear locks, or place orders.

## Hostinger Deploy Flow

Railway worker deploys are not the production path. Keep Railway only as a possible Postgres provider through `DATABASE_URL`.

1. Create and push a dedicated branch, normally `hostinger-exact-share-readiness`.
2. Set `HOSTINGER_SSH_TARGET` to the Hostinger SSH target.
3. Run the read-only precheck:

```bash
HOSTINGER_SSH_TARGET=user@host npm run hostinger:precheck
```

4. Deploy the branch:

```bash
HOSTINGER_SSH_TARGET=user@host DEPLOY_BRANCH=hostinger-exact-share-readiness npm run hostinger:deploy
```

The deploy script backs up `/etc/pok-poly-kalshi/worker.env`, pauses `ARB_ENABLED` if it was true, checks out the branch in `/opt/pok-poly-kalshi`, runs `npm ci` and `npm run build:worker`, restarts `pok-worker` so systemd runs migrations with the service env, and restores `ARB_ENABLED=true` only after public and protected readiness are green. If readiness fails, leave entries paused and inspect the printed readiness summary before changing any safety setting.

Deploy the dashboard separately with `npm run build:dashboard` or the Vercel production deploy flow only if dashboard code changed.

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

When protected dashboard access is unavailable, use the public sanitized readiness probe from the Hostinger VPS or its worker endpoint:

```bash
WORKER_API_BASE=http://127.0.0.1:8080 npm run readiness:public
```

This calls `/health?readiness=1` and intentionally excludes balances, allowances, addresses, and control actions. Treat `executionReadiness.safeToPlaceOrders=false`, `executionReadiness.polymarket.geoblockBlocked=true`, or either venue `ready=false` as authoritative not-safe evidence. Do not bypass this with config overrides.

If `ARB_ENABLED=false`, the worker remains online for discovery/readiness but will not submit new entries.

## Disk Guard

The VPS should not need an upgrade unless disk growth returns after log controls are installed. Trust direct `df -h /` from the VPS over a stale provider panel.

Install or refresh the disk guard after deploys that touch `deploy/vps`:

```bash
install -o root -g root -m 0755 deploy/vps/pok-disk-guard.sh /usr/local/sbin/pok-disk-guard
install -o root -g root -m 0644 deploy/vps/pok-disk-guard.service /etc/systemd/system/pok-disk-guard.service
install -o root -g root -m 0644 deploy/vps/pok-disk-guard.timer /etc/systemd/system/pok-disk-guard.timer
mkdir -p /etc/systemd/journald.conf.d
install -o root -g root -m 0644 deploy/vps/pok-journald.conf /etc/systemd/journald.conf.d/pok-disk-guard.conf
install -o root -g root -m 0644 deploy/vps/rsyslog-logrotate.conf /etc/logrotate.d/rsyslog
systemctl daemon-reload
systemctl restart systemd-journald
systemctl enable --now pok-disk-guard.timer
systemctl start pok-disk-guard.service
```

Thresholds:

- Alert at `80%` root disk usage.
- Urgent at `90%`.
- Emergency cleanup at `95%`.

The guard removes stale `/tmp/pok-*` diagnostics, removes runaway `/tmp/pok-filltest-monitor.log` when it exceeds 100MB, rotates `/var/log/syslog` at 128MB, and caps journald near 128MB. If `/var/log/syslog` keeps growing quickly, inspect repeated messages with:

```bash
journalctl -u pok-worker -n 200 --no-pager
tail -n 200 /var/log/syslog
find /tmp /var/log -xdev -type f -printf '%s %TY-%Tm-%Td %TH:%TM %p\n' | sort -n | tail -25
```

## Risk And Recovery

Persistent locks are intentional when exposure cannot be proven safe. Do not clear a lock until authoritative venue data proves one of these outcomes:

- Both venues filled exact matching size.
- Both venues have zero fill and no open order.
- One-sided exposure has been manually resolved or is explicitly quarantined under the configured cap.

After correcting the signal/audit rows and clearing a lock, restart `pok-worker` so any in-memory latch is reset.

## Rollback

Set `ARB_ENABLED=false` and restart the worker to stop new entries immediately while preserving discovery, dashboard status, and audit visibility.
