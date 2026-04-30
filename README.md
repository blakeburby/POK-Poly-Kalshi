# POK Poly Kalshi

Worker plus read-only quant dashboard for deterministic BTC 15-minute binary options spreads between Polymarket and Kalshi.

The v1 strategy only considers guaranteed structures:

- Buy YES on the lower strike.
- Buy NO on the higher strike.
- Enter only when `1.00 - totalPremium >= ARB_MIN_PROFIT_DOLLARS`.

Live order-book prices are WebSocket-driven. REST is used only to discover active contracts and hydrate metadata.

## Commands

```bash
npm install
npm run migrate
npm run worker
npm run dev:dashboard
npm test
```

By default, execution is dry-run. Set `ARB_LIVE_TRADING=true` only after both venue execution credentials and Railway Postgres are configured.

## Processes

- Railway worker: `npm run migrate && npm run worker`
- Vercel dashboard: `npm run build:dashboard`
- Worker-only typecheck: `npm run build:worker`

The dashboard is read-only. It authenticates users with `DASHBOARD_PASSWORD`, then proxies server-side to Railway with `WORKER_API_BASE` and `DASHBOARD_API_TOKEN`.
