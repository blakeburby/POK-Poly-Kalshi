# POK · Poly–Kalshi

Live-only worker + read-only quant dashboard for deterministic **BTC 15-minute binary-option spreads** between
**Polymarket** and **Kalshi**. When the same event can be bought below its \$1 guaranteed payout across both
venues, the worker executes both legs to lock the spread.

The strategy only considers protected structures:

- Buy **YES** on the lower strike, **NO** on the higher strike.
- Enter only when the executable, cushioned live edge clears `ARB_MIN_PROFIT_DOLLARS`.
- Order-book prices are WebSocket-driven; REST handles discovery, metadata, readiness, order submission, and
  post-submit recovery.

## Documentation map

| Doc                                            | Read it for                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | How the system is shaped: data flow, module map, invariants, glossary. **Start here.** |
| [CONTRIBUTING.md](./CONTRIBUTING.md)           | Local setup, the `npm run verify` gate, house conventions, deploy discipline.          |
| [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md)   | Every environment variable, its type, default, and purpose.                            |
| [RUNBOOK.md](./RUNBOOK.md)                     | Production operations: pause/resume, deploy flow, lock resolution, incident response.  |
| [docs/](./docs)                                | Design notes and dated audits (incl. the 2026-06-23 architecture audit).               |

## Quick start

```bash
npm install
cp deploy/vps/pok-worker.env.example .env   # set DATABASE_URL (+ venue secrets only if trading)
npm run migrate                             # apply DB schema
npm run worker                              # start the trade engine (ARB_ENABLED=false to run without entering)
npm run dev:dashboard                       # local dashboard
npm run verify                              # typecheck (src + tests) + full test suite
```

## Processes

- **Production worker**: AWS Lightsail (Montreal) systemd service `pok-worker` — see [RUNBOOK.md](./RUNBOOK.md).
- **Dashboard**: Next.js on Vercel (aliases `pokstrategies.com`); read-only, authenticates operators with
  `DASHBOARD_PASSWORD` and proxies server-side to the worker via `WORKER_API_BASE` + `DASHBOARD_API_TOKEN`.
  It cannot arm, disarm, clear locks, or place orders.

## Branching & deploys

> Both the worker and the dashboard deploy from `main`. Push your commit and deploy — there is no separate
> deploy branch to keep in lockstep.

```bash
git push origin main          # ship the commit to origin; the guarded deploy checks out origin/main
```

See the guarded deploy flow in [RUNBOOK.md](./RUNBOOK.md) and the
`/deploy` skill (`.claude/skills/deploy/`).
