# POK Poly Kalshi

Live-only worker plus read-only quant dashboard for deterministic BTC 15-minute binary options spreads between Polymarket and Kalshi.

The strategy only considers protected structures:

- Buy YES on the lower strike.
- Buy NO on the higher strike.
- Enter only when the executable, cushioned live edge clears `ARB_MIN_PROFIT_DOLLARS`.

Order-book prices are WebSocket-driven. REST is used for discovery, metadata hydration, readiness checks, order submission, and post-submit recovery.

## Commands

```bash
npm install
npm run migrate
npm run worker
npm run dev:dashboard
npm test
```

Execution is live-capable only. Use `ARB_ENABLED=false` to keep the worker online while preventing new entries.

## Processes

- Worker: `npm run migrate && npm run worker`
- Vercel dashboard: `npm run build:dashboard`
- Worker-only typecheck: `npm run build:worker`

The dashboard is read-only. It authenticates operators with `DASHBOARD_PASSWORD`, then proxies server-side to the worker with `WORKER_API_BASE` and `DASHBOARD_API_TOKEN`.
