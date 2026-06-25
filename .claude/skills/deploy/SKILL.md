---
name: deploy
description: Ship committed POK-Poly-Kalshi changes to production — the live worker (guarded Hostinger flow) and/or the Vercel dashboard, both deploying from `main`. Use when deploying to prod or releasing.
---

# Deploy to production

The live worker AND the Vercel dashboard both deploy from **`main`**. The production worker is the Montreal (ca-central-1) Lightsail box **`ubuntu@15.175.128.184`** — a **4-vCPU compute-optimized (non-burstable)** instance as of 2026-06-25, upsized from a `t3.small` to kill chronic CPU-steal event-loop stalls (see [docs/runbooks/lightsail-cpu-upgrade.md](../../../docs/runbooks/lightsail-cpu-upgrade.md)). SSH key: `~/.ssh/LightsailDefaultKey-ca-central-1.pem` (root login is disabled — use `ubuntu`). The old Kuala Lumpur `187.77.145.117` box is powered off. The **database is a local Postgres ON the box** (not remote Railway), and the dashboard tunnel (`api.pokstrategies.com`, served by `cloudflared` on the box) is unchanged across deploys. (There is no separate deploy branch — the legacy `hostinger-exact-share-readiness` branch was retired; the `hostinger:*` script names are historical.)

## 1. Pre-deploy (push first — the deploy fetches `origin`)

The guarded worker deploy checks out `origin/main`, so **unpushed commits do not ship**. Always:

```bash
git push origin main               # ship the commit to origin
npm test && npm run build:worker   # green before shipping
```

## 2. Worker (`src/` — the trading engine)

Guarded flow: pauses ARB → builds → restarts → readiness-gates the resume (leaves ARB paused if readiness fails, e.g. an active breaker lock).

```bash
HOSTINGER_SSH_TARGET=ubuntu@15.175.128.184 npm run hostinger:precheck   # read-only readiness
HOSTINGER_SSH_TARGET=ubuntu@15.175.128.184 npm run hostinger:deploy
HOSTINGER_SSH_TARGET=ubuntu@15.175.128.184 npm run hostinger:resume     # only if the deploy left ARB paused
```

If the deploy leaves ARB paused on a circuit-breaker lock, clear it **after** the deploy pauses ARB and **before** resume (the resolver requires `arbEnabled=false`):

```bash
HOSTINGER_SSH_TARGET=ubuntu@15.175.128.184 npm run hostinger:resolve-live-lock            # dry-run, verify safeToApply
HOSTINGER_SSH_TARGET=ubuntu@15.175.128.184 npm run hostinger:resolve-live-lock -- --apply --reason=<single-token>
```

`--reason` must be a single token (spaces are word-split through the SSH layer). Clearing a breaker is a production safety action — get explicit operator authorization first.

## 3. Dashboard (`app/` — the Vercel frontend)

Changes under `app/` do **not** ship with the worker deploy. Deploy the frontend separately:

```bash
vercel --prod --yes   # linked project pok-poly-kalshi-dashboard; auto-aliases pokstrategies.com + www
```

## 4. Verify

- Worker: `arbEnabled=true`, breaker clear, `reconciliationClean=true`, scanning (`lastScanAgeMs` small).
- Dashboard: `https://pokstrategies.com` serves HTTP 200 and reflects the change.
- Branch: the box checkout (`/opt/pok-poly-kalshi`) is on `main` at `origin/main`.

Production deploys, breaker clears, and prod env edits are outward-facing/irreversible — confirm with the operator before each unless already authorized in the session.
