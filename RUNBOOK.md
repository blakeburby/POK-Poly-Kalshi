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
- `KALSHI_SERIES_TICKER=KXBTC15M`: Kalshi BTC 15-minute series.
- `POLYMARKET_DISCOVERY_URL=https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&tag_slug=crypto`: Polymarket metadata discovery endpoint.
- `POLYMARKET_LIVE_DATA_WS_URL=wss://ws-live-data.polymarket.com`: Polymarket live Chainlink price feed used to capture BTC 15-minute `priceToBeat`.
- `POLYMARKET_PRICE_TO_BEAT_SYMBOL=btc/usd`: live feed symbol filter.
- `POLYMARKET_DISCOVERY_WINDOW_OFFSETS=-1,0,1,2,3,4,5,6`: 15-minute slug windows to hydrate around the current time.
- `POLYMARKET_PRICE_CAPTURE_TOLERANCE_MS=5000`: maximum accepted delay after window open for the first Chainlink tick.
- `POLYMARKET_MISSED_OPEN_BACKFILL=true`: allow exact page metadata backfill for already-open windows.

Optional live Polymarket adapter:

- `POLYMARKET_ORDER_ENDPOINT`: internal order-placement service endpoint.
- `POLYMARKET_API_KEY`: bearer token for that endpoint.

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
9. Configure the Polymarket order endpoint.
10. Flip `ARB_LIVE_TRADING=true` only after a small dry-run window matches manual venue quotes.

## Operational Notes

- The scanner uses REST only for market discovery. Prices come from Kalshi and Polymarket WebSockets.
- Polymarket contracts do not enter `books.polymarket` until they have token IDs, expiry, an exact persisted or page-metadata `priceToBeat`, and live CLOB quotes.
- The worker stores Polymarket opening strikes in `polymarket_price_beats`; this lets restarts resume without approximating from late spot ticks.
- If Polymarket appears empty on the dashboard, check `Price-To-Beat Diagnostics` for `pending_strike`, `missing_strike`, Chainlink tick age, and skipped/backfill reasons.
- Every attempted threshold-crossing entry is inserted before execution and then updated with `filled`, `skipped`, or `failed`.
- If one venue execution adapter is missing in live mode, the executor fails before placing either leg.
- Re-entry is tracked by pair key and hydrated from filled audit rows on startup.
- The dashboard is read-only in v1: no threshold edits, manual orders, kill switch, or live/dry-run toggles.

## Rollback

Set `ARB_ENABLED=false` for immediate stop without redeploying.

Set `ARB_LIVE_TRADING=false` to return to dry-run mode while preserving discovery and auditing.
