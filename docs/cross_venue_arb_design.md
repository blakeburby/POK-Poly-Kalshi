# Cross-Venue Arb Design

## Step 0 Repo Check

Working repo:

- Path: `/Users/blakeburby/Documents/New project 4`
- Intended remote: `https://github.com/blakeburby/POK-Poly-Kalshi.git`
- Local state at planning time: empty git repo, `main`, no commits, no configured `origin`, clean worktree.
- GitHub state at planning time: public and empty.

Reference repo:

- Requested repo: `https://github.com/blakeburby/PokCapital-Backend-2-25-26.git`
- Dataless local copies found at `/Users/blakeburby/Documents/PokCapital-Backend-2-25-26` and `/Users/blakeburby/Desktop/PokCapital-Backend-2-25-26`; direct git/source reads could hang there.
- Usable read-only source: `/Users/blakeburby/.codex/worktrees/729e/New project 2`
- Remote confirmed: `https://github.com/blakeburby/PokCapital-Backend-2-25-26.git`
- Worktree HEAD: detached at `181a36b`.
- Fetched remote head used for architecture reading: `origin/main` at `5d5e00c` (`Implement calibrated ten-regime Kelly sizing`).

## Reference Repo Findings

Kalshi integration:

- Runtime is a TypeScript worker using `ws`, `pg`, `zod`, and `tsx`.
- Kalshi REST signing lives in `src/lib/kalshi/auth.ts`.
- Auth signs `timestamp + method + fullPath` with RSA-PSS SHA-256 and sends `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, and `KALSHI-ACCESS-SIGNATURE`.
- WebSocket auth signs absolute path `/trade-api/ws/v2` and connects to `wss://api.elections.kalshi.com/trade-api/ws/v2`.
- The ticker stream subscribes to `ticker` for a sorted list of `market_tickers`, parses `yes_bid_dollars`, `yes_ask_dollars`, `no_bid_dollars`, and `no_ask_dollars`, and caches snapshots by ticker.
- Reconnect logic uses exponential backoff, special 429/rate-limit backoff, intentional close handling, and resubscription when desired ticker subscriptions change.
- Kalshi order-book REST is still used as a fallback in the reference worker, but this repo's live pricing requirement keeps order-book pricing WebSocket-driven for the scanner.

Polymarket integration:

- The current reference repo does not contain a production Polymarket CLOB integration.
- This repo therefore implements Polymarket discovery and WebSocket book ingestion directly, using the reference repo's WebSocket lifecycle and logging shape as the template.

Pricing model:

- The current reference repo does not implement the prompt's Modified Black-Scholes plus EWMA plus jump-diffusion model.
- It implements a GARCH(1,1)-Student-t Monte Carlo engine with Student-t and GBM fallbacks.
- The strategy was clarified to be deterministic structural arbitrage, so v1 does not use any pricing model. It computes guaranteed payoff from contract structure and actual asks only.

Postgres and Railway:

- The reference worker uses a shared `pg.Pool`, `DATABASE_URL`, Railway SSL with `rejectUnauthorized: false`, boot-time schema creation, and structured warnings for schema drift.
- This repo ports the pool shape but adds a real migration runner because the working repo starts empty and new tables need versioned SQL.

Async runtime:

- The reference worker starts DB stores first, opens shared WebSocket streams, discovers active markets on an interval, fans updates into in-memory state, and serves health/status endpoints through a small Node HTTP server.
- This repo follows that shape with a scanner-first worker: discover markets, subscribe to venue books, scan on live book updates, persist candidates before execution, and expose health/status endpoints.

## Working Repo Fit

The working repo was empty, so there was no existing structure to preserve. The scaffold intentionally mirrors the reference repo's operational style:

- TypeScript worker-only service.
- `ws` for venue streams.
- `pg` for Railway Postgres.
- `zod` for external payload validation.
- Structured in-memory logs.
- Small HTTP surface for `/health`, `/status`, and `/logs`.

## Strategy Definition

The executable v1 structure is:

- Lower strike leg: buy YES.
- Higher strike leg: buy NO.
- Premium: `lowerYesAsk + higherNoAsk`.
- Guaranteed profit: `1.00 - premium`.
- Overlap profit: `2.00 - premium`.
- Entry gate: `guaranteedProfit >= ARB_MIN_PROFIT_DOLLARS`, default `$0.05`.

The flipped configuration, buy NO on the lower strike and YES on the higher strike, is classified as non-executable because it has a dead zone between strikes.

