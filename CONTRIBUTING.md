# Contributing

This repo runs a **live, real-money** trading worker. The bar is: every change must be type-checked, tested,
and reversible. Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) before your first change.

## Prerequisites

- Node 20+, npm.
- A Postgres database (set `DATABASE_URL`). Railway is the production provider; any Postgres works locally.
- Venue credentials are only needed to actually trade — most code and the full test suite run without them.

## Local setup

```bash
npm install
cp deploy/vps/pok-worker.env.example .env        # then fill in DATABASE_URL (+ secrets only if trading)
npm run migrate                                  # apply DB schema (needs DATABASE_URL)
```

The full configuration surface is documented in [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md). Configuration is
parsed in exactly one place — `src/config.ts` (`loadConfig`). **Never read `process.env` outside `config.ts`.**

## The verify gate (run before every commit)

```bash
npm run verify     # = build:worker (typecheck src) + typecheck:test + npm test
```

Individually:

| Command                   | Checks                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build:worker`    | Typecheck the worker (`src/`, `tsconfig.worker.json`).                                                                                                               |
| `npm run typecheck:test`  | Typecheck the **tests** (`tsconfig.tests.json`). Tests were historically unchecked, which let test config literals drift from `AppConfig` — this gate prevents that. |
| `npm test`                | The full suite (`node --test` via `tsx`).                                                                                                                            |
| `npm run build:dashboard` | `next build` for the dashboard (`app/`).                                                                                                                             |
| `npm run format:check`    | Prettier — the tree is fully formatted and CI enforces it; run `npm run format` to fix.                                                                              |

CI (`.github/workflows/ci.yml`) runs the same `build:worker` + `typecheck:test` + `npm test` on every push/PR.

## House conventions

- **Flag-gated, byte-identical-by-default.** Any behavioral change is gated by a config flag whose default
  reproduces the prior behavior exactly. This makes every change a one-line env rollback. Add the flag to
  `AppConfig` + `loadConfig` (with a default), document it in `docs/ENVIRONMENT.md`, and cover both flag states
  with a test.
- **Test config via the real loader.** Build test `AppConfig` objects by spreading `loadConfig({...})` and
  overriding what the test needs (see `tests/fill-quality.test.ts`) rather than hand-writing a literal — the
  literal drifts and `typecheck:test` will now reject it.
- **Money paths get adversarial review.** Live-execution changes get an independent correctness/safety review
  (one-sided-fill risk, flag-off equivalence, edge cases) before deploy.
- **Errors stay legible.** Don't mask error causes; surface the underlying code/status. See `sanitizeError`.
- **Commit messages** end with a `Co-Authored-By:` trailer when pair-authored. Keep the subject imperative and
  scoped (`fix(execution): ...`, `docs: ...`, `chore(ci): ...`).

## Branch & deploy discipline

- **Lockstep invariant:** `main` and the deploy branch `hostinger-exact-share-readiness` always point at the
  same commit. After pushing the deploy branch, mirror it:
  `git push origin hostinger-exact-share-readiness:main`.
- **Deploy** is a guarded script that pauses entries, builds, restarts, checks readiness, and re-arms — see
  [RUNBOOK.md](./RUNBOOK.md). Never restructure the worker entry points (`tsx src/index.ts`, `npm run migrate`)
  or move modules the deploy depends on without updating the deploy path and re-verifying.
- **Never** execute trades, move funds, clear a safety lock, or edit production env without explicit
  authorization for that specific action.
