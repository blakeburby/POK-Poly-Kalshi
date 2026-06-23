# Repository Architecture Audit — 2026-06-23

A deep audit of the POK Poly–Kalshi repository for organization, structure, and maintainability, with the
explicit constraint that this is a **live, real-money trading system** — so "preserve all functionality"
outranks "refactor aggressively" wherever the two conflict.

**Method.** Ten parallel read-only auditors covered folder structure, the two god-files, duplication,
config/env, logging/errors, testing, docs/onboarding, dead code/debt, deps/build, and scalability/ops; a lead
synthesizer reconciled them. **77 findings**: 3 Critical, 24 High, 29 Medium, 21 Low. Crucially, **62 of 77 are
zero- or low-live-risk** — this is a strong system with *concentrated*, mostly-safe-to-fix debt, not a mess.

**Headline.** The single most important finding is structural and cheap: the **test suite was type-checked by
nothing** (both tsconfigs excluded `tests/`, and `npm test` runs through `tsx` transpile-only). On a money
system, the safety net for every change was itself unverified — and it had already silently drifted. Closing
that gap is the prerequisite that makes every subsequent refactor *provably* non-breaking. **It is fixed in this
pass.**

---

## 1. Current architecture map

```
repo root
├── src/  (worker, 77 files / ~19k LOC, run via tsx)
│   ├── index.ts            entry: boot, wire, scan loop, HTTP server, shutdown
│   ├── config.ts (530)     THE env boundary — loadConfig() reads ~153 keys into a flat ~200-field AppConfig
│   ├── types.ts (931)      ⚠ god type-module: 5 domains in one file (+ re-imports root types/trading.ts)
│   ├── discovery/ ws/ kalshi/ polymarket/ books/   feeds → in-memory books
│   ├── scanner/            candidate generation + payoff math
│   ├── execution/          ⚠ live-clients.ts (3,084)  + executor.ts (2,741) = 30% of all src
│   ├── signals/ trading/ analytics/   scoring + dashboard read-models
│   ├── db/                 pool + 21 versioned SQL migrations + per-table query modules
│   └── dashboard/          worker HTTP API (snapshots/SSE) — co-hosted in the trade process
├── app/  (Next.js dashboard, 60 files → Vercel) — reads worker API behind app/lib/types.ts facade
├── types/trading.ts        ⚠ second type home at repo root (dashboard P&L/equity contracts)
├── tests/  (34 files / ~13.5k LOC, flat)  ⚠ excluded from BOTH tsconfigs; one 6,650-LOC god test file
├── scripts/ (27)  deploy + calibration  •  docs/ (audits + design)  •  deploy/vps/ (systemd units)
├── tsconfig.json (dashboard) + tsconfig.worker.json (worker)   ⚠ neither covers tests/
└── package.json (35 deps, 27 scripts)   ⚠ no CI, no linter/formatter
```

**What is already strong** (meets a top-tier bar):

- **Config centralization** — ~153 env reads funnel through one `loadConfig`; only 5 `process.env` leaks. Most
  codebases this age sprinkle `process.env` everywhere.
- **The worker/dashboard seam** — a deliberate single facade (`app/lib/types.ts`); the two deployables don't
  bundle each other's code. Real architectural boundary.
- **Operational maturity** — feed-silence watchdogs, 401 self-heal, loss-cap hardlock, versioned migrations,
  documented "false blocker" reasoning, lockstep deploy discipline. The system demonstrably *learns* from
  incidents.
- **The "peel pure helpers, keep the orchestrator" pattern already exists** in-repo (`venue-confirmations.ts`,
  `quote-quality.ts`, `fill-quality.ts`) — the house style for de-bloating the god files is proven; it just
  hasn't been applied to them yet.

**Where the gap is widest:** the **type/test safety net under a money path**. The engineering *care* is high but
applied *reactively* (fix-after-incident) rather than *structurally* (compiler/boot-time prevention): tests
weren't type-checked, secrets fail open (empty-string defaults), and a wrong account-model default passes the
only guard. Closing Wave 0 (below) moves this dimension from below-bar to top-tier — cheaply.

## 2. Recommended architecture map

```
repo root
├── src/
│   ├── index.ts  config.ts(+validateConfig)
│   ├── types/                 market.ts · execution.ts · scoring.ts · dashboard.ts · trading.ts  (+ barrel)
│   ├── errors.ts              sanitizeError + a typed failureCode taxonomy (replaces string-matching)
│   ├── ws/reconnecting-client.ts   one base class for the 4 WS lifecycle state machines
│   ├── execution/
│   │   ├── order-types.ts     shared trade-path interfaces (out of the god file)
│   │   ├── clients/           kalshi-rest · kalshi-fix · kalshi-ui · polymarket · polymarket-creds
│   │   ├── executor.ts        slimmer LiveExecutor (hedge-trigger + timings peeled into helpers)
│   │   └── live-clients.ts    → re-export barrel (preserves every existing import path)
│   └── (unchanged elsewhere)
├── tests/   mirrors src/ layout · shared makeTestConfig() (loadConfig-spread) · split god test file
├── tsconfig.json · tsconfig.worker.json · tsconfig.tests.json     ← all three checked in `npm run verify` + CI
├── .github/workflows/ci.yml   typecheck(src) + typecheck(tests) + test on every push/PR
├── docs/  ARCHITECTURE.md · ENVIRONMENT.md · (audits/)     README + CONTRIBUTING at root
└── eslint + prettier configs encoding the invariants (no process.env outside config.ts, no console.*)
```

The two deployables and the runtime entry points (`tsx src/index.ts`, `npm run migrate`) are **unchanged** — all
restructuring happens behind re-export barrels so no import path or deploy step moves.

## 3. Root-cause themes

1. **No structural enforcement of the contracts a money system relies on.** Tests unchecked, secrets default to
   `""`, control flow keyed off free-text error strings, account-model default contradicts production. The
   guardrails are operational, not compile/boot-time.
2. **Two "god" concerns** — `live-clients.ts`/`executor.ts` (behavior) and `types.ts` (contracts) — concentrate
   ~30% of src and every duplication/coupling finding.
3. **Duplication from missing base abstractions** — 4 WS clients reimplement one lifecycle; `roundPrice`/`waitMs`
   copied across both god files; the readiness/warm pattern repeats per venue.
4. **Documentation describes *what*, never *where*** — no architecture/data-flow map, no env reference, host
   naming actively misleads operators.
5. **No automated quality floor** — no CI, no linter/formatter; every gate is a developer remembering to run it.

## 4. Top 20 highest-impact improvements

| # | Improvement | Sev | Risk | Effort | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | **Type-check the tests** (`tsconfig.tests.json` + `typecheck:test`) | Critical | none | quick | ✅ **done** |
| 2 | Fix the already-drifted test config literals (missing fields) | Critical | low | med | ✅ **done** |
| 3 | **CI pipeline** (typecheck src + tests + suite on every push/PR) | High | none | quick | ✅ **done** |
| 4 | `ARCHITECTURE.md` — data-flow + module map + glossary | High | none | med | ✅ **done** |
| 5 | `ENVIRONMENT.md` — every env key, type, default, purpose | High | none | med | ✅ **done** |
| 6 | `CONTRIBUTING.md` + working local-run path | High | none | med | ✅ **done** |
| 7 | Fix RUNBOOK host naming (Hostinger → AWS Lightsail) | High | none | quick | ✅ **done** |
| 8 | **`validateConfig()` at boot** — fail fast on missing live secrets | High | med | med | proposed |
| 9 | `POLYMARKET_SIGNATURE_TYPE` required-when-live (default contradicts prod) | High | low | quick | proposed |
| 10 | Split `types.ts` into `src/types/` domain modules **behind a barrel** | High | low | med | proposed |
| 11 | Consolidate `types/trading.ts` into `src/types/` (re-export shim first) | High | low | med | proposed |
| 12 | Extract trade-path interfaces out of `live-clients.ts` → `order-types.ts` | High | none | quick | proposed |
| 13 | Split `live-clients.ts` per-venue under `clients/` **behind a barrel** | High | low | med | proposed |
| 14 | `ReconnectingWebSocketClient` base for the 4 WS clients | High | low | med | proposed |
| 15 | **Typed `failureCode`** taxonomy → stop classifying money flow by error substrings | High | med | med | proposed |
| 16 | **Graceful-shutdown drain** of in-flight executions before `pool.end()` | Critical | low | med | proposed |
| 17 | `migrate.ts`: run each migration on a **pinned client**, not the pool | High | low | quick | proposed |
| 18 | Split the 6,650-LOC god test file along source seams | High | low | major | proposed |
| 19 | Sync `pok-worker.env.example` to all ~153 keys | High | none | quick | proposed |
| 20 | Linter + formatter encoding invariants (no `process.env` outside config) | High | none | med | partial (prettier in) |

## 5. Quick wins (<30 min each)

- ✅ `tsconfig.tests.json` + `typecheck:test`/`typecheck:all`/`verify` scripts.
- ✅ `.github/workflows/ci.yml`.
- ✅ RUNBOOK host-naming note; README rewrite with a doc map.
- ✅ Remove committed junk (`lead-lag-calibration.err`); untrack auto-generated `next-env.d.ts` (the "M" that
  polluted git status all session) + gitignore it.
- ✅ Prettier config + `format`/`format:check` scripts (via pinned `npx`, no dependency churn).
- **Proposed:** extract `VenueOrderResult`/`VenueOrderClient`/`LiveOrderContext` from `live-clients.ts` into
  `order-types.ts` (compile-time-erased; 6 modules stop importing the trade interface from a 3k-LOC file).
- **Proposed:** `migrate.ts` → pinned client (`pool.connect()`) so `BEGIN/DDL/COMMIT` can't split across
  connections.
- **Proposed:** `POLYMARKET_SIGNATURE_TYPE` → throw when live and unset (prod sets `=3`; the code default `0`
  silently signs against the wrong account model for any fresh setup).
- **Proposed:** regenerate `pok-worker.env.example` from `config.ts` (~50 keys, incl. `DASHBOARD_REALTIME_SECRET`
  and most `LIVE_*` toggles, are undocumented — see `ENVIRONMENT.md` for the full delta).

## 6. Medium refactors (behind a barrel; verify-gated)

- **Split `src/types.ts`** into `market.ts` / `execution.ts` / `scoring.ts` / `dashboard.ts` / `trading.ts`,
  keeping `src/types.ts` as `export *` so **zero import sites change**. De-triplicate the ~45-field
  execution-outcome block (`ExecutionResult`/`SignalUpdate`/`DashboardSignal`) via a shared base — a money-system
  correctness win (today, adding a field means editing three copies in sync).
- **Split `live-clients.ts`** into `execution/clients/{kalshi-rest,kalshi-fix,kalshi-ui,polymarket,polymarket-creds}.ts`
  behind a re-export barrel at the original path.
- **`ReconnectingWebSocketClient`** base class in `src/ws/` — collapses 4 near-identical socket/timer/heartbeat
  state machines (incl. the silence-watchdog already copy-pasted 4×). Largest single dedup.
- **Typed error taxonomy** (`src/errors.ts` + a `failureCode` union): replace the substring-matching in
  `executor.ts` (`isHedgeRetryable`, `isRetryablePreSubmitReason`, `isDefinitiveNoFill`) where a reworded venue
  error can silently flip a money-affecting retry decision. Additive, byte-identical when the code is absent.
- **`validateConfig()`** at boot: when `ARB_ENABLED`, require the live secrets (Polymarket key + funder, Kalshi
  key id + private key) to be non-empty, and assert cross-field invariants — so bad creds fail at boot, not on
  the first live order.
- **Graceful-shutdown drain**: before closing feeds/server/pool on SIGTERM, stop new scans and await
  `activeExecutions === 0` with a deadline under systemd's 30s — so a deploy can't `pool.end()` mid-two-leg trade.
- **Test hygiene**: a shared `makeTestConfig()` (loadConfig-spread, drift-immune); snapshot/restore `process.env`
  around the 3 env-mutating files (safe under `--test-isolation=none`); mirror `tests/` to `src/`.

## 7. Major structural improvements (planned branch, real risk)

- **Slim `LiveExecutor`**: peel the stateless hedge-trigger/evidence and `executionTimings` clusters into helper
  modules (the proven in-repo pattern), then add focused `executor.test.ts` coverage (today the 2.7k-LOC
  orchestrator has almost no direct unit tests).
- **Nest `AppConfig`** into a typed, schema-validated domain tree — kills the flat ~200-field bag, untyped drift,
  and the validation gap at the source. De-risk: do it **after** Wave 0; ship as a non-breaking superset
  (nested tree + flat getters), migrate consumers incrementally, drop aliases last; add a snapshot test asserting
  `loadConfig()` is byte-identical for a known env before/after.
- **Separate the dashboard read path** from the trade-path process/pool (own pool budget) so a dashboard-viewer
  surge can't contend for the executor's event loop or its `max:8` pg pool. Interim quick win: make pool size
  `DB_POOL_MAX` env-configurable.
- **`/livez` + `/readyz` + `/metrics`**: split liveness/readiness (today `/health` always returns `200 ok:true`,
  unusable as a process signal) and export the already-computed gauges (latency percentiles, queue depth, event
  loop lag, CPU steal, feed-silence ages, breaker state) in Prometheus format instead of log-scraping.

## 8. Files to move / rename / merge / split / delete

| Action | Target | Risk | Note |
| --- | --- | --- | --- |
| ✅ delete | `docs/audits/.../lead-lag-calibration.err` | none | Committed error dump, not docs. **Done.** |
| ✅ untrack | `next-env.d.ts` | low | Next.js-generated; churns lockstep diffs. **Done** (gitignored). |
| split | `src/types.ts` → `src/types/{market,execution,scoring,dashboard}.ts` + barrel | low | Zero import churn. |
| move | `types/trading.ts` → `src/types/trading.ts` (re-export shim first) | low | Eliminate the second type home. |
| move | trade interfaces in `live-clients.ts:25-176` → `src/execution/order-types.ts` | none | Type-only, erased at compile. |
| split | `live-clients.ts` → `execution/clients/*` + barrel | low | Four venue clients in one file. |
| split | `src/ws/` add `reconnecting-client.ts` base | low | Dedup 4 WS lifecycles. |
| merge | `roundPrice`/`waitMs` (dup in both god files) → `execution/num-utils.ts` | low | Money-rounding primitive must not diverge. |
| split | `live-execution.test.ts` (6,650 LOC) → per-source test files | low | Unreviewable; mirror source seams. |
| rename | `tests/dashboard-ui.test.tsx` → `.test.ts` under `tests/dashboard/` | low | `.tsx` but tests only pure fns. |
| consider | `src/dashboard` → `src/api`, `src/trading` → `src/reporting` | low | Names mislead vs contents (defer; churns many imports). |
| keep | `Dockerfile.worker` / `.dockerignore` | — | Audit flagged as orphaned, but **do not delete** unverified on a live repo; confirm no fallback deploy uses it first. |
| n/a | `account-snapshot.json` | — | Audit thought it was committed; it is **already gitignored** (local-only). No action. |

## 9. Corrections to the raw audit

Two raw findings were over-stated and are noted for accuracy: (a) `account-snapshot.json` is **already
local-only** (gitignored), not committed; (b) the "7 raw `console.*` in src" are **all legitimate** — the
logger's own sink (`logger.ts:26`) and an intentional CLOB-log-muting helper (`live-clients.ts:332-347`) — not
style drift. The linter recommendation still stands (to *prevent* future `console.*`/`process.env` leaks), but
there is nothing to clean up today.

## 10. Implemented in this pass (all zero/low live-risk)

- **Wave 0 safety net** — `tsconfig.tests.json`; `typecheck:test` / `typecheck:all` / `verify` scripts; fixed all
  32 surfaced type errors in the test suite (config-literal drift completed to match real defaults, e.g.
  `equityBackfillOnBoot: false`, `liveHedgeMinCrossTicks: 2`; outdated import fixed; loose mocks typed). Suite
  stays **365 green**; tests now type-check clean.
- **CI** — `.github/workflows/ci.yml` (worker typecheck + tests typecheck + suite, blocking; prettier advisory).
- **Docs** — `docs/ARCHITECTURE.md`, `docs/ENVIRONMENT.md`, `CONTRIBUTING.md`, rewritten `README.md`, RUNBOOK
  host-naming fix.
- **Tooling** — Prettier config + `.prettierignore` + `format` scripts (no dependency churn).
- **Cleanup** — removed the committed `.err` dump; untracked + gitignored `next-env.d.ts`.

No `src/` runtime code changed, so the running worker is unaffected; these ride along on the next functional
deploy. The production worker remains on `2707bf6` (P1.4), healthy.

## 11. Sequenced roadmap

- **Wave 0 — the gate (DONE).** Test type-checking + CI. Nothing below is provably safe without it.
- **Wave 1 — pure-additive dedup (low risk).** `num-utils.ts`, `order-types.ts`, `ReconnectingWebSocketClient`,
  `validateConfig()`, `migrate.ts` pinned client. New files / additive guards; no import paths move.
- **Wave 2 — barrel splits (low risk, verify-gated).** Split `types.ts` and `live-clients.ts` into folders,
  each leaving a re-export barrel at the original path. Depends on Wave 0 (tests now catch a dropped re-export)
  and Wave 1 (`order-types.ts` extracted first).
- **Wave 3 — planned branch (real risk).** Nested `AppConfig`, `LiveExecutor` helper-peel + tests, dashboard
  process/pool separation, `/livez`+`/readyz`+`/metrics`, typed error taxonomy in the hot path. One cluster per
  PR, full `npm run verify` green, adversarial review, guarded deploy.

Each wave is independently shippable and leaves the system more maintainable without ever moving the runtime
entry points or the deploy contract.
