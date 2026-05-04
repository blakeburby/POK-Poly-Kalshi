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
- `POLYMARKET_SIGNATURE_TYPE=0`: EOA signature type. Use proxy/safe types only with the matching `POLYMARKET_FUNDER_ADDRESS`.
- `POLYMARKET_FUNDER_ADDRESS`: required for Polymarket proxy/safe wallets, optional for EOA bot wallets.
- `POLYMARKET_CHAIN_ID=137`: Polygon mainnet.
- `POLYMARKET_CLOB_HOST=https://clob.polymarket.com`: official Polymarket CLOB host.
- `POLYMARKET_ORDER_TYPE=FOK`: fill-or-kill order posting for the live canary.
- `LIVE_ORDER_SIZE=1`: fixed one contract/share per leg. Do not increase until canary evidence is clean.
- `LIVE_MAX_SLIPPAGE_CENTS=1`: live preflight and limit-price buffer per buy leg.
- `LIVE_MIN_EXPIRY_MS=30000`: skip entries too close to settlement.

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
10. Confirm `/dashboard/snapshot` shows `execution.kalshi.ready=true`, `execution.polymarket.ready=true`, and `execution.partialFillLocked=false`.
11. Set `ARB_EXECUTION_CONCURRENCY=1` for the first canary, then flip `ARB_LIVE_TRADING=true` only after a small dry-run window matches manual venue quotes.
12. Watch the first live candidate. If any `partial_fill` row appears, the worker locks further live execution until operator review/restart.

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
- Kalshi live execution uses the V2 event-order endpoint. Buying NO is mapped onto Kalshi's YES book by sending an `ask` at the complementary YES price.
- Polymarket live execution uses the official CLOB client with EIP-712 signing plus derived L2 API credentials.
- If a one-sided fill is detected, the executor writes the partial-fill audit detail and locks further live execution until restart/operator acknowledgement.
- Re-entry is tracked by pair key and hydrated from filled audit rows on startup.
- The dashboard is read-only in v1: no threshold edits, manual orders, kill switch, or live/dry-run toggles.
- Rotate any private key pasted into chat or logs before enabling live mode.

## Rollback

Set `ARB_ENABLED=false` for immediate stop without redeploying.

Set `ARB_LIVE_TRADING=false` to return to dry-run mode while preserving discovery and auditing.
