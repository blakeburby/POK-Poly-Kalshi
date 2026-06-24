# Execution Latency Audit + Phase A/B Roadmap — 2026-06-15

## Summary

Submit-path latency averages ~3.0–3.6 s (p95 ~7 s). It is **not** bottlenecked by software that was already
made fast — DB writes, logging, prearm, and the hedge-decision are all ~0–1 ms. It is bottlenecked by:

1. **A ~2.2 s sequential leg-to-leg one-sided window** (`venueSubmitSkewMs` avg 2219 / p95 5501) — in
   `polymarket_first_exact` the Kalshi hedge can't fire until the Polymarket fill is confirmed.
2. **A trans-Pacific RTT floor** — the worker VPS is in Kuala Lumpur; both exchange origins are ~US-East.
   Kalshi ~147 ms TCP RTT (no CDN, direct to US); Polymarket origin ~190 ms (behind Cloudflare anycast).
3. **A ~398 ms local pre-submit `hotGate`** that ran the scoring+preflight stack twice and forced a fresh
   Kalshi balance RTT every order.

### Measured component breakdown (submitted attempts, n≈1108; window 2026-05-08..06-15)

| Component                              |  avg | p50 |  p95 |  p99 |   max |
| -------------------------------------- | ---: | --: | ---: | ---: | ----: |
| `venueSubmitSkewMs` (one-sided window) | 2219 | 601 | 5501 | 5777 |  5920 |
| `polymarketOrderRttMs`                 |  989 | 637 | 2263 | 5848 |  5920 |
| `polymarketPostOrderMs`                |  793 | 541 | 1915 | 2301 |  2472 |
| `polymarketConfirmationMs`             |  702 | 509 | 1632 | 2072 |  2566 |
| `kalshiOrderRttMs`                     |  545 | 600 | 1163 | 2508 |  5523 |
| `hotGateMs`                            |  398 | 306 |  867 | 1555 | 26976 |
| `preflightMs` (Kalshi balance RTT)     |  164 | 115 |  374 |  782 |  7929 |
| `polymarketSignMs`                     |   81 |   3 |  389 |  448 |   695 |
| DB write / hedge-decision / prearm     | ~0–1 |   — |    — |    — |     — |

## Phase A — shipped (commit `c80a615`, build + 254 tests green, on branch `hostinger-exact-share-readiness`)

In-place software wins; no relocation; every change preserves hedge integrity and the safety gates.

- **LA1** — `preflightOrder` reuses the warm Kalshi readiness cache (only when fresh AND balance clears
  required collateral by a margin; otherwise forces) and naturally de-dupes the second preflight. ~250–300 ms.
- **LA2** — `LiveExposureCache` serves last-good + background refresh in a soft window; blocks only past a
  hard ceiling (3× maxAge). Eliminates the multi-second / 27 s submit stalls.
- **LA3** — re-presign Polymarket at the _refreshed_ capped price so the submit reuses the EIP-712 signature
  (~3 ms) instead of re-signing inline (avg 81 / p95 389 ms).
- **LA4** — first-leg confirmation drops the +3000 ms recovery extension (stays 2500 ms > p99 2072) → cuts the
  ~5500 ms no-in-range-fill tail; plus `LIVE_HEDGE_RETRY_BUDGET_MS=1500` wall-clock bound on hedge retries.
- **LA6** — keep-alive idle timeout 2 s→30 s + TLS session cache so warmed order sockets don't go cold.

Expected: submit avg ~3.0–3.6 s → **~1.9–2.3 s**, p95 ~7 s → **~4.5 s**, 27 s outlier eliminated.

**LA5 (score lead-lag/fill-quality once)** — deferred. Feasible and behavior-preserving for trading (both
gates are in shadow), but the clean version drops shadow scores from skip-path telemetry, and this item needs
a golden-output parity harness. Smallest win (~110–190 ms), zero trading-behavior impact today.

## Phase B — geographic + transport (the structural levers)

### The constraint

Kalshi is US-regulated (rewards US proximity); **Polymarket geoblocks US IPs** (`/api/geoblock`, fail-closed
in the readiness gate at `live-clients.ts`). So a naive `us-east-1` move would sever the Polymarket leg. The
target must be **a non-US, geoblock-clear region with minimal RTT to AWS `us-east-1`** (evaluate Canada /
Toronto, ~15–30 ms to Ashburn).

### #7 — Region probe (do this first)

`scripts/latency-region-probe.sh` measures TCP/TLS/TTFB to both exchanges + the Kalshi FIX port and checks the
Polymarket geoblock, **from whatever host it runs on**. Run it on the current KL VPS (baseline) and on each
candidate-region host:

```bash
bash scripts/latency-region-probe.sh                 # KL baseline
# on a Toronto/Frankfurt/Tokyo/us-east-1 VPS:
bash scripts/latency-region-probe.sh
```

**Decision rule:** pick the region with the lowest `(Kalshi RTT + Polymarket RTT)` whose geoblock returns
`blocked:false` and whose Kalshi FIX TCP connect succeeds. Run `us-east-1` as the control — it should report
`blocked:true`, proving the probe detects the block. Re-run immediately before cutover.

### #8 — Relocate (infra; execute after #7 picks a region)

1. Provision a worker host in the chosen geoblock-clear region; **co-locate Postgres in the same region/AZ**
   (avoid adding a new long DB hop — the gate-reads and readiness-cache refresh must stay sub-ms).
2. Stand it up in parallel with `ARB_ENABLED=false`; run one readiness cycle and confirm **both** venues
   ready (Polymarket `geoblockBlocked:false`, Kalshi balance reachable, FIX session connects).
3. Migrate Postgres via dump/restore during a brief `ARB_ENABLED=false` window so
   reconciliation/quarantine/lock rows survive (a lossy move would weaken reconciliation). Keep `pool.ts`
   SSL handling correct.
4. Keep the KL host as instant rollback. Compare full latency distributions before flipping `ARB_ENABLED=true`
   via the guarded `hostinger:resume`.

Expected: Kalshi 147 ms→~20 ms, Polymarket origin ~190 ms→~20 ms; submit avg → ~700–1000 ms, p95 → ~1800 ms;
one-sided window → ~250–450 ms.

### #9 — Kalshi FIX-first staged hedge (after relocation)

- **#9a shipped (prerequisite):** `KalshiFixOrderClient.supportsPlacementMode` now accepts `kalshi_first_exact`
  (`live-clients.ts`), so the staged Kalshi-first leg can run over the persistent FIX session. Inert until
  `KALSHI_HEDGE_ORDER_MODE=fix_ioc` + `LIVE_ORDER_PLACEMENT_MODE=kalshi_first_exact`.
- **#9b/c (follow-up):** use the FIX ExecutionReport as the first-leg confirmation (removes the ~702 ms
  confirmation wait), validate FIX session connect/heartbeat/reconnect stability from the new region, then
  canary `kalshi_first_exact` + `fix_ioc` on the funded account before promoting to default. Committing the
  reliable integer leg first also _improves_ hedge integrity on a thin account (an unfundable Kalshi leg
  aborts flat before any Polymarket order).

## Low-value / rejected (given the data)

DB/logging micro-opts (already ~0 ms); prearm/hedge-decision (~1 ms); HTTP/2 (moot at concurrency 1); TLS 0-RTT
for order POSTs (replay-unsafe); raising `executionConcurrency` (would double-spend the thin Kalshi
collateral); parallel-IOC as default (opens a real two-sided exposure window — opt-in fast-lane only, behind
mandatory auto-unwind); VPN/proxy to spoof Polymarket geo (ToS/compliance + adds a hop).
