# Architecture

> Single source of truth for how this system is shaped. Read this first; then [RUNBOOK.md](../RUNBOOK.md)
> for operations and [ENVIRONMENT.md](./ENVIRONMENT.md) for configuration.

## What it is

A **live, real-money cross-venue arbitrage worker** for **BTC 15-minute binary options**. It watches the same
economic event priced on two venues — **Kalshi** (regulated exchange) and **Polymarket** (on-chain CLOB) — and
when the two sides can be bought for a combined cost below the \$1 guaranteed payout, it executes both legs to
lock the spread. A read-only **operator dashboard** visualizes signals, fills, P&L, and health.

Execution mode is `polymarket_first_exact`: take the **Polymarket** leg first with a **FAK** (fill-and-kill,
cancelable) order, then **floor-hedge** the realized fill size on **Kalshi** with a **FOK** (fill-or-kill) order.
Polymarket is taken first precisely because it is cancelable — if it misses, no position is opened and no hedge
is needed, so a one-sided (un-hedged) exposure can only arise through an explicit, guarded path.

## Two deployables, one repo

```
                       ┌─────────────────────────────┐
   AWS Lightsail       │   Worker  (src/, tsx)        │      Vercel
   (Montreal)          │   systemd: pok-worker        │   ┌──────────────────────┐
                       │   npm run worker → index.ts  │   │  Dashboard (app/, Next)│
                       └──────────────┬──────────────┘   └───────────┬───────────┘
                                      │                              │ HTTP (read-only)
                                      │ writes                       │ + bearer token
                                      ▼                              ▼
                            ┌───────────────────┐         GET /health, /snapshot, SSE
                            │  Postgres (Railway)│◄────────  served by src/dashboard/worker-api.ts
                            └───────────────────┘            (co-hosted in the worker process)
```

- **Worker** (`src/`): the trade engine. Long-lived Node process (run via `tsx`), runs migrations on boot,
  connects venue WebSocket + REST APIs, scans, executes, persists, and serves a small HTTP API for the dashboard.
- **Dashboard** (`app/`): a Next.js app deployed to Vercel. **Read-only** — it cannot arm, disarm, clear locks,
  or place orders. It talks to the worker's HTTP API behind a bearer token.
- **The seam**: `app/lib/types.ts` re-exports the worker's data contracts so the dashboard imports from one
  app-local facade rather than reaching across the package. The worker bundles none of the dashboard, and the
  dashboard bundles none of the trade engine (it imports `import type` + one tiny transport helper).

## Data flow (one scan cycle)

```
discovery/        find the live BTC 15m markets on each venue (strike pairs, token ids)
   │
ws/ kalshi/ polymarket/   maintain live order books over WebSocket (+ feed-silence watchdogs)
   │                       books age out if a feed goes silent → that market drops from the scan set
   ▼
books/            in-memory BookStore: freshest top-of-book per contract
   │
scanner/          for each candidate strike-pair, compute the executable edge
   │               (VWAP to the needed depth, fees, cushion) → an ArbCandidate
   ▼
execution/        quote-quality gate (staleness, skew, depth, min-edge) → if it passes:
   │  quote-quality.ts   preflight readiness (balance/allowance/creds, hot-path cached)
   │  executor.ts        Polymarket FAK → on fill, size + send Kalshi FOK floor-hedge
   │  live-clients.ts    venue order clients (Kalshi REST/UI/FIX + Polymarket CLOB)
   │  venue-confirmations.ts   reconcile fills from REST + user-stream evidence
   ▼
db/ signals.ts     persist every attempt (cross_venue_arb_signals) + venue events + locks
   │
dashboard/        worker-api.ts serves snapshots/SSE; signals-notifier.ts pushes updates
```

Risk controls wrap the whole path: a per-window trade cap, an exposure cap, a **loss-cap auto-hardlock** (a
realized edge worse than `LIVE_HEDGE_MAX_LOSS_DOLLARS` halts trading), and a **fill-mismatch hardlock**. Locks
live in `live_execution_locks` and are cleared only through a guarded settlement script (see RUNBOOK).

## Module map (`src/`)

| Path                                     | Responsibility                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`                               | Process entry: boot, wire dependencies, start scanner + HTTP server, graceful shutdown.                                                                            |
| `config.ts`                              | **The only** place env is parsed (`loadConfig`). Produces the immutable `AppConfig`.                                                                               |
| `types.ts`                               | Cross-layer data contracts (books, candidates, execution results, dashboard view-model).                                                                           |
| `logger.ts`                              | Structured JSON logging sink (severity + category + context).                                                                                                      |
| `discovery/`                             | Find the live BTC 15m markets / strike pairs / token ids on each venue.                                                                                            |
| `ws/`                                    | WebSocket reconnect/backoff helpers + the feed-silence watchdog predicate.                                                                                         |
| `kalshi/`                                | Kalshi REST + WS + FIX clients, auth (RSA request signing), order-book parsing.                                                                                    |
| `polymarket/`                            | Polymarket CLOB book client, user stream, price-to-beat capture.                                                                                                   |
| `books/`                                 | `BookStore`: in-memory freshest-book cache keyed by contract.                                                                                                      |
| `scanner/`                               | Candidate generation + payoff math (executable edge, depth-weighted VWAP).                                                                                         |
| `execution/`                             | The trade engine: quote-quality gate, the `LiveExecutor` orchestrator, the venue order clients, fill confirmation/reconciliation, fill-quality + lead-lag scoring. |
| `signals/`                               | Lead-lag scoring + calibration models.                                                                                                                             |
| `trading/`                               | Read-models for the dashboard: account sources, venue P&L, activity, equity sampler.                                                                               |
| `analytics/`                             | Performance aggregation for the dashboard.                                                                                                                         |
| `db/`                                    | Postgres pool, versioned SQL migrations, and one query module per table.                                                                                           |
| `dashboard/`                             | The worker's HTTP API surface (snapshots, SSE) + signal transport/notifier.                                                                                        |
| `latency/`, `diagnostics/`               | Latency instrumentation and runtime-health diagnostics.                                                                                                            |
| `health.ts`, `shutdown.ts`, `migrate.ts` | Health endpoint, graceful shutdown, migration runner.                                                                                                              |

> **Known hotspots** (see the 2026-06-23 architecture audit): `execution/live-clients.ts` (~3.1k LOC, four
> venue clients in one file) and `execution/executor.ts` (~2.7k LOC, the `LiveExecutor`) are the two largest
> modules and the planned split targets. They are the live trade path — refactor only behind a green
> `npm run verify` and a re-export barrel that preserves the public surface.

## State

- **Durable** (Postgres): every execution attempt (`cross_venue_arb_signals`), venue order events,
  execution locks, price-beats, and portfolio equity snapshots. Schema is versioned under
  `src/db/migrations/` and applied on boot by `npm run migrate`.
- **In-memory** (process): the live order books (`BookStore`), hot-path readiness/credential caches, and the
  per-window trade counters. This state is rebuilt on restart from fresh feeds — the worker is restart-safe.

## Key invariants

- **Exact-pair hedging.** The Kalshi hedge is sized off the _actual_ Polymarket fill, never the candidate size.
- **Single executor.** Dynamic sizing requires `ARB_EXECUTION_CONCURRENCY=1` (enforced in `config.ts`); the
  hot path assumes one in-flight execution.
- **Centralized config.** Env is read only in `config.ts`; everything else takes a typed `AppConfig`.
- **Flag-gated changes.** Behavioral changes ship behind a config flag, default to byte-identical prior
  behavior, and are validated by tests + both typechecks before deploy (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- **Deploy from `main`.** The worker and dashboard both deploy from `main` (the guarded script checks out
  `origin/main`); there is no separate deploy branch or mirror step.

## Glossary

| Term                      | Meaning                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **FAK**                   | Fill-and-kill: fills whatever it can immediately, cancels the rest. Used for the first (Polymarket) leg because it is cancelable. |
| **FOK**                   | Fill-or-kill: fills the entire size or nothing. Used for the Kalshi floor-hedge so the hedge is all-or-nothing.                   |
| **Floor-hedge**           | Hedging the realized first-leg fill size on the other venue to lock the spread.                                                   |
| **Exact-pair**            | Both legs end at the same share count → fully hedged, zero directional exposure.                                                  |
| **Edge**                  | Guaranteed profit per share = `$1 − (kalshi cost + polymarket cost)`, after fees and cushion.                                     |
| **Cushion**               | A taker price offset added so a marketable order crosses the book without erasing the edge.                                       |
| **Hot path**              | The latency-critical order-submission path; uses cached readiness/book data to avoid network calls.                               |
| **Geoblock**              | Polymarket's consumer endpoint flags the worker's region; advisory only (the CLOB still fills) — see [docs/audits](./audits).     |
| **Feed-silence watchdog** | Forces a WS reconnect when a socket stays open but stops sending book deltas.                                                     |
| **Loss-cap hardlock**     | An auto-halt triggered when a trade realizes an edge worse than `LIVE_HEDGE_MAX_LOSS_DOLLARS`.                                    |
| **Price-to-beat**         | The BTC reference level used to determine which side of a strike wins at expiry.                                                  |
