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

- Production worker: Lightsail (Montreal) systemd service `pok-worker`, `root@15.175.128.184`
- Local worker: `npm run migrate && npm run worker`
- Vercel dashboard: `npm run build:dashboard` (deploy with `vercel --prod`; aliases `pokstrategies.com`)
- Worker-only typecheck: `npm run build:worker`

The dashboard is read-only. It authenticates operators with `DASHBOARD_PASSWORD`, then proxies server-side to the worker with `WORKER_API_BASE` and `DASHBOARD_API_TOKEN`.

## Branching & deploys

> **Invariant: `main` and `hostinger-exact-share-readiness` must always point to the same commit. `main` is never behind.**

Both the production worker (`npm run hostinger:deploy`) and the Vercel dashboard deploy from `hostinger-exact-share-readiness`. `main` must mirror exactly what is live, so every push to the deploy branch must also fast-forward `main` in the same step:

```bash
git push origin hostinger-exact-share-readiness
git push origin hostinger-exact-share-readiness:main   # keep main on the same commit — always a clean fast-forward
```

The deploy branch is always a strict superset of `main`, so this never conflicts. Do not commit to `main` independently — it tracks the deploy branch exactly. After any deploy, confirm they match:

```bash
git rev-parse origin/main origin/hostinger-exact-share-readiness   # the two SHAs must be identical
```

See the `/deploy` skill (`.claude/skills/deploy/`) for the full guarded flow.
