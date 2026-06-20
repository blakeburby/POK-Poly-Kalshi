---
name: deploy
description: Ship committed POK-Poly-Kalshi changes to production — the live worker (guarded Hostinger flow) and/or the Vercel dashboard — while keeping `main` in lockstep with the deploy branch. Use when deploying to prod, releasing, or syncing branches.
---

# Deploy to production

The live worker AND the Vercel dashboard both deploy from the **`hostinger-exact-share-readiness`** branch. The production worker is the Montreal Lightsail box **`root@15.175.128.184`** (the old Kuala Lumpur `187.77.145.117` box is powered off). The database (Railway) and dashboard tunnel (`api.pokstrategies.com`) are shared/unchanged across deploys.

## ⚠️ Invariant — `main` is never behind

**`main` and `hostinger-exact-share-readiness` MUST always point to the same commit.** `main` must mirror exactly what is live. After ANY push to the deploy branch, immediately fast-forward `main`:

```bash
git push origin hostinger-exact-share-readiness
git push origin hostinger-exact-share-readiness:main   # always a clean fast-forward (branch ⊇ main)
```

Never commit to `main` independently. Confirm they match after every deploy:

```bash
git rev-parse origin/main origin/hostinger-exact-share-readiness   # the two SHAs must be identical
```

## 1. Pre-deploy (push first — the deploy fetches `origin`)

The guarded worker deploy checks out `origin/hostinger-exact-share-readiness`, so **unpushed commits do not ship**. Always:

```bash
git push origin hostinger-exact-share-readiness          # ship the commit to origin
git push origin hostinger-exact-share-readiness:main     # keep main in lockstep (the invariant)
npm test && npm run build:worker                          # green before shipping
```

## 2. Worker (`src/` — the trading engine)

Guarded flow: pauses ARB → builds → restarts → readiness-gates the resume (leaves ARB paused if readiness fails, e.g. an active breaker lock).

```bash
HOSTINGER_SSH_TARGET=root@15.175.128.184 npm run hostinger:precheck   # read-only readiness
HOSTINGER_SSH_TARGET=root@15.175.128.184 npm run hostinger:deploy
HOSTINGER_SSH_TARGET=root@15.175.128.184 npm run hostinger:resume     # only if the deploy left ARB paused
```

If the deploy leaves ARB paused on a circuit-breaker lock, clear it **after** the deploy pauses ARB and **before** resume (the resolver requires `arbEnabled=false`):

```bash
HOSTINGER_SSH_TARGET=root@15.175.128.184 npm run hostinger:resolve-live-lock            # dry-run, verify safeToApply
HOSTINGER_SSH_TARGET=root@15.175.128.184 npm run hostinger:resolve-live-lock -- --apply --reason=<single-token>
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
- Branches: `origin/main == origin/hostinger-exact-share-readiness`.

Production deploys, breaker clears, and prod env edits are outward-facing/irreversible — confirm with the operator before each unless already authorized in the session.
