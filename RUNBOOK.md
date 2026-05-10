# RUNBOOK

## Railway Setup

Required:

- `DATABASE_URL`: Railway Postgres connection string.
- `KALSHI_API_KEY_ID`: Kalshi API key id.
- `KALSHI_PRIVATE_KEY` or `KALSHI_PRIVATE_KEY_B64`: Kalshi RSA private key.
- `DASHBOARD_API_TOKEN`: shared bearer token used by the Vercel dashboard proxy.

Recommended:

- `ARB_LIVE_TRADING=false`: keep dry-run mode until both venues are validated.
- `ARB_ENABLED=true`: scanner switch.
- `ARB_MIN_PROFIT_DOLLARS=0.05`: guaranteed-profit threshold.
- `ARB_REENTRY_INTERVAL_MS=15000`: cadence per pair/configuration.
- `MARKET_DISCOVERY_INTERVAL_MS=30000`: REST discovery cadence.
- `ARB_EXECUTION_CONCURRENCY=2`: maximum candidate executions processed at once after fast pairing.
- `DASHBOARD_STREAM_INTERVAL_MS=250`: SSE snapshot cadence for live books/scanner state.
- `DASHBOARD_SIGNAL_REFRESH_MS=1000`: minimum refresh interval for recent signal DB reads on dashboard streams.
- `DASHBOARD_ANALYTICS_REFRESH_MS=5000`: minimum refresh interval for analytics DB reads on dashboard streams.
- `DISCOVERY_BOUNDARY_REFRESH_ENABLED=true`: add extra discovery refreshes around each 15-minute market boundary.
- `KALSHI_SERIES_TICKER=KXBTC15M`: Kalshi BTC 15-minute series.
- `POLYMARKET_DISCOVERY_URL=https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&tag_slug=crypto`: Polymarket metadata discovery endpoint.
- `POLYMARKET_LIVE_DATA_WS_URL=wss://ws-live-data.polymarket.com`: Polymarket live Chainlink price feed used to capture BTC 15-minute `priceToBeat`.
- `POLYMARKET_PRICE_TO_BEAT_SYMBOL=btc/usd`: live feed symbol filter.
- `POLYMARKET_DISCOVERY_WINDOW_OFFSETS=-1,0,1,2,3,4,5,6`: 15-minute slug windows to hydrate around the current time.
- `POLYMARKET_PRICE_CAPTURE_TOLERANCE_MS=5000`: maximum accepted delay after window open for the first Chainlink tick.
- `POLYMARKET_MISSED_OPEN_BACKFILL=true`: allow exact page metadata backfill for already-open windows.
- `DRY_RUN_SLIPPAGE_ENABLED=true`: persist conservative simulated dry-run fill prices instead of exact asks.
- `DRY_RUN_KALSHI_SLIPPAGE_CENTS=1`: base Kalshi dry-run buy slippage.
- `DRY_RUN_POLYMARKET_SLIPPAGE_CENTS=1`: base Polymarket dry-run buy slippage.
- `DRY_RUN_MAX_SLIPPAGE_CENTS=3`: maximum simulated slippage per dry-run leg.
- `DRY_RUN_SLIPPAGE_JITTER_CENTS=1`: random extra dry-run slippage added on top of the venue base.

Live canary trading, still disabled unless `ARB_LIVE_TRADING=true`:

- `POLYMARKET_PRIVATE_KEY`: dedicated low-balance bot wallet private key for official Polymarket CLOB signing.
- `POLYMARKET_SIGNATURE_TYPE=3`: current Polymarket deposit-wallet / API-wallet mode for the configured account. Use `0` only for a plain EOA bot wallet.
- `POLYMARKET_FUNDER_ADDRESS`: required for Polymarket proxy/safe wallets, optional for EOA bot wallets.
- `POLYMARKET_CHAIN_ID=137`: Polygon mainnet.
- `POLYMARKET_CLOB_HOST=https://clob.polymarket.com`: official Polymarket CLOB host.
- `POLYMARKET_GEOBLOCK_URL=https://polymarket.com/api/geoblock`: official worker-egress geoblock preflight. Unknown or blocked status makes Polymarket not ready.
- `POLYMARKET_ORDER_TYPE=FOK`: retained for readiness/status; Polymarket live buys use exact-size marketable limits because CLOB FOK/FAK BUYs are notional-based.
- `LIVE_ORDER_SIZE=5`: first practical Polymarket BTC 15m live canary size because current CLOB markets commonly reject smaller orders with `min_order_size=5`.
- `LIVE_MAX_SLIPPAGE_CENTS=1`: live preflight and limit-price buffer per buy leg.
- `LIVE_MIN_EXPIRY_MS=120000`: production recommendation to skip entries too close to settlement.
- `LIVE_MAX_TRADES_PER_WINDOW=1`: hard live canary cap per 15-minute expiry window.
- `LIVE_COLLATERAL_BUFFER_DOLLARS=0.25`: extra Polymarket collateral required during fresh execution preflight.
- `LIVE_HEDGE_MAX_LOSS_DOLLARS=0.02`: maximum accepted realized loss per protected spread when hedging after the first venue fills.
- `LIVE_HEDGE_FEE_BUFFER_DOLLARS=0.01`: conservative fee allowance used when calculating post-fill hedge caps.
- `LIVE_PARALLEL_EXECUTION_ENABLED=true`: default low-latency live mode. The worker submits both venues concurrently after strict preflight, private-stream readiness, and reconciliation checks pass.
- `LIVE_USER_STREAMS_ENABLED=true`: require authenticated Kalshi/Polymarket private order streams before live orders can be considered safe.
- `LIVE_USER_STREAM_PRETRADE_GRACE_MS=750`: short retry window for transient private-stream subscription refreshes before skipping a candidate. Pre-order stream unavailability skips the trade instead of creating a persistent live lock.
- `LIVE_USER_STREAM_CONFIRM_TIMEOUT_MS=2500`: maximum wait for private-stream confirmation after REST order responses.
- `LIVE_RECONCILE_BEFORE_TRADE=true`: block live entries when recent audit rows, private-stream confirmations, or persistent locks show unresolved drift.
- `KALSHI_USER_WS_URL=wss://api.elections.kalshi.com/trade-api/ws/v2`: Kalshi authenticated user stream endpoint.
- `POLYMARKET_USER_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/user`: Polymarket authenticated CLOB user stream endpoint.

Polymarket execution note: CLOB FOK/FAK BUY orders are notional-based, so the
worker uses an exact-size marketable limit order and immediately cancels any
unfilled remainder. If Polymarket reports a fill count different from
`LIVE_ORDER_SIZE`, the worker marks the attempt failed and engages the
persistent live circuit breaker.

Private-stream safety note: in default live mode the worker keeps the Hybrid
Safe Kalshi-first canary posture. After an exact Kalshi REST fill it treats
Polymarket as a risk-reducing hedge, bypassing the normal profit gate only when
current depth can fill exact size inside the configured hedge loss cap, then
requires authenticated
user-stream confirmation for both legs. Passive user-stream disconnects make
readiness unhealthy and reconnect automatically; if they happen before any
order submission the candidate is skipped. Confirmation timeout, failed
Polymarket settlement event, fill-count mismatch, dirty reconciliation state,
or any unsafe condition after an order may have been submitted engages or keeps
the persistent live circuit breaker.

## Enable And Disable

Use `ARB_ENABLED=false` to keep the worker healthy while preventing new scans and entries.

Use `ARB_LIVE_TRADING=false` to continue discovery, WebSocket subscriptions, pairing, persistence, and dry-run fills without placing live venue orders.

## Dashboard Setup

Deploy the dashboard as a separate Vercel project from the same repo.

Required Vercel env vars:

- `WORKER_API_BASE`: Railway worker base URL, for example `https://your-worker.up.railway.app`.
- `DASHBOARD_API_TOKEN`: same value configured on the Railway worker.
- `DASHBOARD_PASSWORD`: shared operator password for the read-only dashboard.

Recommended Vercel env vars:

- `DASHBOARD_SESSION_SECRET`: HMAC secret for the HTTP-only dashboard cookie. Defaults to `DASHBOARD_PASSWORD` if omitted.
- `NEXT_PUBLIC_DASHBOARD_NAME=POK Cross-Venue Terminal`: dashboard title.

Vercel build command:

```bash
npm run build:dashboard
```

The browser never receives `DASHBOARD_API_TOKEN`. Next.js API routes authenticate the operator session, then proxy `/dashboard/snapshot` and `/dashboard/stream` to Railway server-side.

## Deploy Flow

1. Provision Railway Postgres and set `DATABASE_URL`.
2. Set Kalshi credentials and keep `ARB_LIVE_TRADING=false`.
3. Set `DASHBOARD_API_TOKEN`.
4. Deploy with `npm run migrate && npm run worker`.
5. Check `/health` for process health and `/status` for latest discovery/scanner state.
6. Confirm `/dashboard/snapshot` returns `401` without a bearer token and returns a snapshot with `Authorization: Bearer $DASHBOARD_API_TOKEN`.
7. Deploy the Vercel dashboard and log in with `DASHBOARD_PASSWORD`.
8. Confirm `cross_venue_arb_signals` rows are being written in dry-run mode.
9. Configure a dedicated Polymarket bot wallet, fund it lightly, approve CLOB trading, and set the Polymarket live env vars above.
10. Confirm `/dashboard/snapshot` shows `execution.kalshi.ready=true`, `execution.polymarket.ready=true`, `execution.userStreams.ready=true`, `execution.reconciliation.clean=true`, `execution.polymarket.geoblockBlocked=false`, `execution.partialFillLocked=false`, and `execution.circuitBreakerLocked=false`.
11. Set `ARB_EXECUTION_CONCURRENCY=1` for the first canary, then flip `ARB_LIVE_TRADING=true` only after a small dry-run window matches manual venue quotes.
12. Watch the first live candidate. If any `partial_fill`, mismatched fill count, or unsafe realized edge appears, the worker persists a live circuit breaker in Postgres until operator review and manual DB clearance.

## VPS Worker Cutover

Use this path when Railway egress is blocked by Polymarket. Keep Railway live-off
and move only the order-submitting worker to a compliant VPS/runtime.

1. Create a small Ubuntu VPS in a jurisdiction/network where you are allowed to trade Polymarket.
2. SSH into the VPS and check the official Polymarket geoblock endpoint before installing anything:

```bash
curl -sS https://polymarket.com/api/geoblock
```

Continue only if it returns `"blocked": false`. If it returns blocked or cannot
be checked, destroy that VPS and use a different compliant host/region.

3. Install the worker:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/blakeburby/POK-Poly-Kalshi.git /tmp/pok-poly-kalshi
cd /tmp/pok-poly-kalshi
sudo bash scripts/vps-install-ubuntu.sh
```

4. Fill `/etc/pok-poly-kalshi/worker.env` from `deploy/vps/pok-worker.env.example`.
   Keep `ARB_LIVE_TRADING=false`.
5. Run:

```bash
cd /opt/pok-poly-kalshi
sudo -u pok bash scripts/vps-preflight.sh
sudo systemctl start pok-worker
sudo systemctl status pok-worker --no-pager
```

6. Verify dry-run readiness:

```bash
export DASHBOARD_API_TOKEN="<same token used by Vercel>"
export WORKER_API_BASE="http://127.0.0.1:8080"
bash /opt/pok-poly-kalshi/scripts/verify-live-readiness.sh
```

7. Put the VPS behind HTTPS, then update Vercel `WORKER_API_BASE` to the VPS
   HTTPS URL. Keep the same `DASHBOARD_API_TOKEN` and redeploy Vercel.
8. Only after the dashboard shows `geoblockBlocked=false`, both venues ready,
   both books live, authenticated user streams ready, reconciliation clean, and
   dry-run signals matching manual quotes, flip the VPS env to
   `ARB_LIVE_TRADING=true` for the 5-share canary.

## Operational Notes

- The scanner uses REST only for market discovery. Prices come from Kalshi and Polymarket WebSockets.
- Polymarket contracts do not enter `books.polymarket` until they have token IDs, expiry, an exact persisted or page-metadata `priceToBeat`, and live CLOB quotes.
- The worker stores Polymarket opening strikes in `polymarket_price_beats`; this lets restarts resume without approximating from late spot ticks.
- If Polymarket appears empty on the dashboard, check `Price-To-Beat Diagnostics` for `pending_strike`, `missing_strike`, Chainlink tick age, and skipped/backfill reasons.
- Every attempted threshold-crossing entry is inserted before execution and then updated with `filled`, `skipped`, or `failed`.
- Scanner work is coalesced under load: if a WS update lands while a scan is active, one immediate follow-up scan runs with the newest books.
- Dashboard latency fields are worker-observed freshness/timing metrics, not exchange-internal latency unless a venue exposes reliable exchange timestamps.
- Dry-run fills simulate conservative buy-side slippage and persist the simulated fill prices into the audit row; live mode records actual venue order IDs, statuses, fill counts, and fill prices.
- Live mode rechecks current top-of-book freshness, expiry distance, capped edge, and the protected-spread-only guard immediately before order placement.
- Live mode allows only one canary spread per expiry window by default and blocks reused live legs from the audit table before placing a new order.
- Kalshi live execution uses the V2 event-order endpoint. Buying NO is mapped onto Kalshi's YES book by sending an `ask` at the complementary YES price.
- Polymarket live execution uses the official CLOB client with EIP-712 signing plus derived L2 API credentials.
- Polymarket readiness includes the worker's own geoblock preflight. If `execution.polymarket.geoblockBlocked` is `true` or `null`, live execution is blocked before any Kalshi order can be placed. Move the worker to a compliant egress region/host and verify `geoblockBlocked=false` before live canary.
- Polymarket execution preflight forces a fresh collateral check for each candidate using `LIVE_ORDER_SIZE * maxPolymarketPrice + LIVE_COLLATERAL_BUFFER_DOLLARS`; the 30-second dashboard readiness cache is never trusted before submitting Kalshi.
- Authenticated Kalshi and Polymarket user streams persist append-only order lifecycle events in `venue_order_events`; live execution requires private-stream confirmations before an attempt is considered safe.
- If a one-sided fill, private-stream timeout, failed settlement event, unexpected fill count, or realized edge below `ARB_MIN_PROFIT_DOLLARS` is detected, the executor writes the audit detail and persists a live circuit breaker in `live_execution_locks`.
- Re-entry is tracked by pair key and hydrated from filled audit rows on startup.
- The dashboard is read-only in v1: no threshold edits, manual orders, kill switch, or live/dry-run toggles.
- Rotate any private key pasted into chat or logs before enabling live mode.

## Rollback

Set `ARB_ENABLED=false` for immediate stop without redeploying.

Set `ARB_LIVE_TRADING=false` to return to dry-run mode while preserving discovery and auditing.

Persistent live circuit breakers are intentional fail-closed stops. Clear only
after reconciling venue positions and the corresponding `cross_venue_arb_signals`
row:

```sql
UPDATE live_execution_locks
SET cleared_at = NOW(), clear_reason = 'manual operator reconciliation complete'
WHERE cleared_at IS NULL;
```
