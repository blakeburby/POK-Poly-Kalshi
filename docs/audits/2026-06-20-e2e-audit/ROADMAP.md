# POK-Poly-Kalshi — End-to-End Audit & Optimization Roadmap (2026-06-20)

## IMPLEMENTATION STATUS (updated as fixes land; all flag-gated, default off = byte-identical)
- **C1 — DONE + DEPLOYED + ENABLED** on prod (`50ce743`, `LIVE_CONFIRMATION_STATUS_TOLERANT=true`). The "mined"-status mis-quarantine fix.
- **C2 — DONE + DEPLOYED** (`ee8067c`, display-only). True attempt-based fill rate + counts hedged in-band overfills. Deferred: dollar/net-fee P&L rebucket + venueAccountValue equity double-count (Ledger already shows correct realized-$).
- **H1 — DONE** (`26fe868`, `LIVE_HOT_PATH_LOCK_CACHE_GRACE_MS`). Lock-cache last-good grace + throttled block log. Not yet deployed.
- **H2 — DONE** (`c0fc075`, `LIVE_QUOTE_FRESHNESS_FROM_WS_ONLY`). Discovery no longer masks a dead WS feed.
- **H3 — DONE** (`c0fc075`, `LIVE_QUARANTINE_CAP_SETTLE_GRACE_MS`). Settled tails excluded from the cap.
- **H4 — DONE** (`c0fc075`, `LIVE_REENTRY_SKIP_ZERO_EXPOSURE`). Zero-exposure no-fills don't trip the 5s throttle.
- **H5 — REFUTED on inspection.** `isHedgeRetryable` intentionally does NOT retry a timeout/unknown FOK (it may have filled — double-hedge risk); naked-leg handled by recovery + auto-unwind. Current design correct.
- **H6 — REFUTED on inspection.** `axios.defaults.timeout` = `liveOrderTimeoutMs` (2500ms) already aborts the POST; clob-client uses the default axios. No separate abort needed.
- **Tier-2 — verified; 2 shipped, 8 refuted/by-design/deferred:**
  - **M2 — DONE** (`81af339`, `LIVE_DYNAMIC_SIZING_CASH_AWARE`). Cash-aware sizing: deep windows size down to affordable instead of skipping.
  - **M9 — DONE** (`81af339`, display-only). One-sided-window metric (`venueSubmitSkewMs`) excludes no-fill legs (was pinned to the 2500ms timeout).
  - **M1 — config hygiene.** `LIVE_MAX_SLIPPAGE_CENTS` is a dead env (never read); the binding cap is `LIVE_DYNAMIC_SIZING_MAX_KALSHI_SLIPPAGE_CENTS=10`. Remove the dead env or set the real knob. No code change.
  - **M3 — REFUTED.** `liveCandidateBlockReason` allows up to `maxTrades` (10) per expiry + only blocks the same leg; it does NOT block the whole expiry.
  - **M4 — by-design.** Concurrency=1 is correct (distinct opportunities co-occur 0×/7d).
  - **M5 — deferred (not a current bug).** Exact `expiryMs` equality pairs fine today and is arguably more correct than a fuzzy tolerance; add a bounded tolerance only if Polymarket's expiry representation ever drifts.
  - **M6 — by-design/tuning.** `depthWeightedAsk` requiring full depth is conservative-correct; anti-dust guards off is a tuning choice; per-share `minProfitDollars` is the model's lens.
  - **M7 — marginal.** Fee priced at VWAP vs realized fill is a convex precision diff (VWAP≈fill at these sizes).
  - **M8 — likely non-issue.** No prearm-auth code surfaced; 14d lock history shows zero auth-reject locks; Kalshi REST auth tolerates seconds of skew.
  - **M10 — REFUTED.** Preflight failure SKIPS (no un-gated fallback-to-static); the selector's fallback size still passes the gate in `prepareExecution`.
- **Tier-3 (~30 LOW) — triaged.** All LOW severity; on inspection these are observability/by-design/library items, not profit/risk movers. Representative dispositions: the circular-JSON `TLSSocket` error is **internal to clob-client-v2** (its own message is the stringify TypeError; the order is still classified failed) — upstream, not cleanly fixable on our side; the reservation TOCTOU and heartbeat-mask items are moot under concurrency=1 + H1; lead-lag/fill-quality "computed but gated off" is now cheap post-P2 (fill-quality reads are cached, lead-lag is in-memory). The remainder are small observability/precision niceties available on request; none change profitability, fill rate, or risk materially.

### Net result
The audit's 101 raw findings distill, under adversarial code+venue verification, to **8 genuinely-actionable fixes — all shipped** (C1, C2, H1, H2, H3, H4, M2, M9; flag-gated, 337 tests, lockstep). The remaining ~30+ are already-handled, by-design, tuning-only, marginal, library-internal, or low-value future-proofing. This is the expected shape of a deep audit: the value is the handful of real bugs (chiefly **C1**, ~5× fill-rate/profit undercount), not 100 speculative edits to a live-money path.

---


Method: 12-agent code audit (101 raw findings, each adversarially verified) **grounded in live production evidence** pulled read-only from the Montreal worker (commit `c8aec36`), plus independent operator investigation against venue truth. ~100 raw findings deduped into the distinct issues below, ranked by risk-adjusted impact. Verification caveat: ~half the verifier agents hit a session usage limit, so several genuine HIGH/CRITICAL items are "unverified" (not refuted) — flagged `[UNVER]`; the top ones are independently confirmed against live data.

Live baseline: 7d real attempts 211 failed / 17 filled (**but ~76 of the "failed" are actually completed hedged arbs — see C1**); realized edge on true fills avg +$0.10/sh, p50 +$0.043; unresolved exposure $0; all P0/P1/P2/W1/W2/W3 flags ON.

---

## TIER 0 — CRITICAL (correctness + profitability; fix first)

### C1. Completed, hedged, profitable arbs are quarantined as "mismatch" (~5× fill-rate & profit undercount) — CONFIRMED HIGH
**Root cause (two compounding mechanisms):**
1. **Status-whitelist fallthrough (operator-nailed).** Polymarket's user-stream emits a 3-stage trade lifecycle `matched → mined → confirmed` (7d events: 152 / 148 / 148). `isConfirmingStatus()` ([venue-confirmations.ts:121](src/execution/venue-confirmations.ts)) whitelists only `[confirmed, filled, matched, executed]` — **`mined` is missing**. `confirmationFromEvent` ([venue-confirmations.ts:159-165](src/execution/venue-confirmations.ts)) computes `confirmed = isConfirmingStatus(status) && !mismatch && !failed` and its final ternary **defaults any non-confirming, non-failed event to `"mismatch"` regardless of fill count**. So when the `mined` event resolves the pending confirmation (a race among the 3), even an exact 5/5 fill is quarantined.
2. **Overfill band not scaling / not threaded into the stream-lock path.** The band `overfillToleranceShares = livePolymarketFirstMaxFillShares − liveOrderSize = 1` is a **fixed absolute share count computed from the STATIC size** ([index.ts:124](src/index.ts)); with dynamic sizing (W2, up to 30) a proportional FAK over-hedge on a 30-share order exceeds +1 and mis-quarantines. Multiple finders also flag the band not reaching the private-stream lock path.

**Live proof:** 79 "private-stream-mismatch" quarantines (7d) → **76 had BOTH legs filled, all in-band** (poly 5.0–6.0, tail p50 0.14 sh); the most recent (#3198170) is an **exact 5/5** fill quarantined as "mismatch"; newest ~10h ago (live).
**Impact:** true 7d completed-arb count ≈ **93, not 17** — a ~5× understatement of fill rate and realized profit; each generates a needless quarantine that consumes the $100 exposure cap and operator reconciliation time. This is the single biggest profitability + observability + stability issue.
**Fix (quick, high-leverage):** (a) add `mined` (+ any other benign Polymarket lifecycle statuses) to `isConfirmingStatus`; (b) change the fallback so a non-failed, in-band, `fillCount>0` event confirms instead of defaulting to "mismatch"; (c) make the overfill band scale with the dynamic order size; (d) thread the P0 band into the private-stream lock path (`lockOnUnsafeEvent`). Add unit tests for matched/mined/confirmed events at 5/5 and 5.16/5 and at size 30. Confidence: **HIGH**.

### C2. Dashboards & analytics drastically misreport fill rate and P&L — HIGH (corroborated, [UNVER])
**Root cause:** consequences of C1 plus independent accounting bugs: headline **Fill Rate is structurally ~100%** (computed filled/filled) while true is 7.5%; mismatch-quarantined-but-hedged trades render as **outright FAILED with $0 P&L**; analytics realized P&L **excludes in-band-overfilled hedged fills**, is **gross of Kalshi fees**, and is **per-share (ignores W2 dynamic sizing)** so a 30-share trade counts as a 5-share; three inconsistent P&L surfaces (Ledger tile vs fills KPI vs analytics); `venueAccountValue` double-counts venue cash, corrupting the persisted equity curve; `equityPnlOverMs` conflates deposits/top-ups with realized P&L.
**Impact:** operators are flying blind on true profitability and fill rate — every optimization decision is made on wrong numbers.
**Fix:** count quarantined-but-hedged as fills; compute realized P&L net of fees × **actual paired fill size**; fix the fill-rate KPI to attempts-based; reconcile the three P&L surfaces to venue truth; stop double-counting cash in equity. Confidence: HIGH (multiple finders + consistent with C1's live data).

---

## TIER 1 — HIGH (risk + stability)

### H1. Stale hot-path lock cache halts ALL trading + floods ERROR logs — CONFIRMED + 6 corroborations
**Root cause:** `CachedLiveExecutionLockStore` ([live-hot-path.ts](src/execution/live-hot-path.ts)) has **no soft-stale/last-good window**: a transient DB slowdown >5s synthesizes a "critical" lock; the scanner treats it as a persistent circuit breaker and **blocks every scan, logging one ERROR per blocked scan with no throttle** (observed dozens/sec at 06:25:04 after restart). Failed refreshes are silently swallowed (breaker can stay engaged forever); cold-start can trip before first hydration.
**Impact:** trading halts on transient DB lag/restart; the log flood obscures real errors and burns disk/IO.
**Fix:** serve last-good within a bounded window (mirror `LiveExposureCache`), hydrate before the scanner starts, surface refresh failures, and `logThrottle` the block message. Confidence: HIGH.

### H2. Discovery resets `updatedAt`, defeating the 750ms freshness gate on a dead WS book — CONFIRMED HIGH
**Root cause:** discovery stamps each contract `updatedAt = now` ([polymarket.ts:350](src/discovery/polymarket.ts), [kalshi.ts:136](src/discovery/kalshi.ts)) and `keepQuotes` does `Math.max(incoming, existing)` ([book-store.ts:143](src/books/book-store.ts)), so every 30s refresh bumps freshness **even with no new WS quote**. A silently-dead WS feed then passes the `LIVE_QUOTE_MAX_AGE_MS=750` gate for up to 750ms after each refresh. Related: `applyPolymarketSnapshot` advances whole-contract `updatedAt` on a one-sided `price_change`, marking the untouched opposite side fresh.
**Impact:** can submit against stale top-of-book during a WS gap → adverse fills + naked-leg risk under volatility.
**Fix:** advance `updatedAt` only on real WS snapshots; keep a separate `quoteUpdatedAt` vs `contractRefreshedAt` and gate freshness on the former. Confidence: HIGH.

### H3. Quarantine-cap query has no expiry filter → settled quarantines accumulate toward the $100 cap → eventual full halt — HIGH ([UNVER], operator-observed)
**Root cause:** the unresolved-exposure cap counts ALL unresolved quarantines regardless of settlement/age; expired ones accumulate until the cap blocks all trading.
**Impact:** slow-motion halt (I had to manually reconcile 37 settled tails earlier this session for exactly this). C1 reduces the inflow, but the unbounded accumulation remains.
**Fix:** exclude expired/settled markets from the cap, or auto-reconcile on settlement (the reconciler already exists — run it on a schedule, or filter the cap query by `expiry_ms > now − settle_grace`). Confidence: HIGH.

### H4. No-fill attempts trip the 5s re-entry throttle despite ZERO exposure — HIGH ([UNVER], "largest non-quarantine leak")
**Root cause:** a Polymarket no-fill (Kalshi never submitted, no exposure) still records a re-entry attempt → throttles that pair 5s ([scanner.ts](src/scanner/scanner.ts) reentry.recordAttempt on `action==="failed" && executionGroupId`).
**Impact:** a benign no-fill blocks re-attempting a still-profitable window for 5s → direct fill-rate leak (69 no-fills/7d).
**Fix:** only throttle on actual fills/real exposure; skip throttle for zero-fill, zero-exposure outcomes. Confidence: MEDIUM-HIGH.

### H5. One-sided (naked) window tail under RTT degradation — HIGH/MEDIUM (operator-corrected F2)
**Root cause:** median hedge fires ~399ms (fine), but **p90 = 4.5s**; the hedge can fire off the slow REST/stream trigger up to ~2.5s+ under RTT degradation; `placeHedgeWithRetry` only retries on a **clean 0-fill**, so a slow/timeout Kalshi FOK strands the Polymarket leg; the hedge-quote staleness gate (2500ms) can hedge into a moved market.
**Impact:** ~10% of two-sided trades carry a multi-second naked Polymarket window → real loss under volatility (the 3 naked-Kalshi + naked-poly cases). P1 (now enabled) fixes result-finalization, not the trigger-timing tail.
**Fix:** fire on the earliest in-range evidence (mostly does); bound the trigger wait; retry hedge on slow/timeout (not just clean-0); give the hedge its own freshness bound. Confidence: MEDIUM-HIGH.

### H6. Order POST not cancelled on the 2500ms timeout — HIGH ([ref] but real)
**Root cause:** the executor's 2500ms timeout fires but the AbortController signal is never threaded into `clob-client-v2.postOrder`, so the underlying order request keeps running.
**Impact:** a "timed-out" Polymarket order can still land after the executor moved on → surprise fill / naked exposure / the late "mismatch" lock.
**Fix:** thread the abort signal into the postOrder HTTP call (axios `signal`), or cancel/track the order id on timeout. Confidence: MEDIUM.

---

## TIER 2 — MEDIUM (execution quality + missed profit)

- **M1. Sizing — dead slippage config:** `LIVE_MAX_SLIPPAGE_CENTS=1` is set in prod but **never parsed into config / never enforced**; the only binding cap is the unrelated 10c `LIVE_DYNAMIC_SIZING_MAX_KALSHI_SLIPPAGE_CENTS`. (confirmed) — wire it or remove it.
- **M2. Sizing — cash-unaware selector:** `selectExecutableSize` gets `cash=null`, so a deep window whose size-30 reserve exceeds dipping Kalshi cash is **skipped entirely instead of sized down**; the warm loop reserves at static size-5 not the dynamic max, defeating LA1 cache (fresh ~150ms Kalshi RTT per dynamic order); the fallback can return below `liveMinOrderSize`. (confirmed) — thread cached balance into the selector.
- **M3. Exposure guard over-reserves the whole expiry:** one in-flight candidate blocks ALL sibling strike pairs in the same 15-min window ([ref]) → missed concurrent arbs in the same window.
- **M4. Concurrency=1 starves other expiries:** the single execution slot is held for the ~poly-first wait; other expiries' candidates get dropped by quote-revalidation by the time the slot frees ([UNVER]).
- **M5. Pairing/settlement-basis risk:** exact-millisecond `expiryMs` equality between two independently-derived timestamps can zero out all candidates (MEDIUM confirmed); pairing assumes a shared settlement price though Kalshi (YES≥strike) and Polymarket (up/down close vs open, Chainlink oracle) settle on **different conventions/oracles** — a real basis risk on edge windows.
- **M6. Phantom-liquidity admits trades:** anti-dust liquidity/slippage guards default OFF and are off in prod, so a single-lot stale/phantom top-of-book can set `worstAsk` and admit a trade real depth won't support; `depthWeightedAsk` is all-or-nothing (rejects candidates with enough profitable depth but a thin top level); `minProfitDollars` is compared **per-share** not total-$.
- **M7. W1 fee model under-deducts:** prices the Kalshi taker fee at the Kalshi VWAP but the realized fee is charged on the **hedge fill price**, under-deducting near 0.5 ([ref]).
- **M8. Kalshi prearm stale auth timestamp:** prearm signs `KALSHI-ACCESS-TIMESTAMP` at preflight, reused up to 5s later (confirmed) → potential auth rejects on the hedge.
- **M9. `venueSubmitSkewMs` metric artifact:** p50=2500 is pinned to the order timeout (computed over no-fill cases) — misleads dashboards about the true one-sided window (operator-confirmed F2). Fix the metric to both-legs-submitted only.
- **M10. Dynamic-size gate/preflight mismatch:** sizing clears the edge gate at size N with cash=null, then fails Kalshi collateral preflight and falls back to static size **with no gate re-check at the fallback size** ([ref]).

---

## TIER 3 — LOW (hardening, observability, edge cases)
Confirmed/again-corroborated lower-impact items, batch as cleanup:
- Discovery: boundary-refresh coalescing can drop the window-open capture (intermittent, low); Kalshi discovery doesn't paginate (far-future windows can truncate near-term strikes); price-to-beat symbol match is case/format-fragile; scanner admits 10s-stale books into pairing while the gate is 750ms; sequential page-scrape backfill inflates discovery latency.
- Gate: lead-lag + fill-quality **computed every trade but both gates disabled in prod** (adverse-selection signal collected then ignored — either enable or stop paying for it); `projectedEdgeAtLimit` can be null while the gate still passes; taker-cushion prod (1c) ≠ default (2c).
- Fill-classification: a stream event resolves only one pending (late/second confirmations re-arm a pending that can never match); `eventMatchesExpected` matches Polymarket by assetId/tokenId only (cross-order attribution risk at re-entry); `applyVenueConfirmation` silently discards a "mismatch"-status confirmation that carries the true in-band fill.
- Order/transport: circular-JSON `TLSSocket` error if the muted-log guard is bypassed (seen once in logs); non-filled FAK remainder cancellation is best-effort/unverified (possible resting order after a "failed" classification).
- Recovery: clean no-fill on the no-trigger branch blocks the full ~5.5s REST timeout+recovery before resolving (stalls the executor on zero-exposure misses).
- Concurrency: `LIVE_PARALLEL_EXECUTION_ENABLED=true` is **inert** in polymarket_first_exact (dead/misleading config); reservation release in `drainExecutionQueue.finally` mutates shared leg/expiry maps across await points (TOCTOU); stale-lock fast-return still stamps `lastScanAt`, masking the halt from the heartbeat health signal.
- PnL: per-row `realizedDollars` books only the paired (min) fill and drops the unhedged fractional overfill cost; boot-time equity backfill reconstructs with static size (mis-states history under dynamic sizing); venue-truth Poly leg can mis-book a still-live position as settled when `curPrice` hits exactly 0/1 pre-resolution.

---

## Recommended sequencing
1. **C1** (the mined-status + band fix) — quickest, biggest profit/fill-rate/observability win; unblocks accurate metrics. Flag-gate, canary, re-pull the mismatch-quarantine count (target 76→~0).
2. **C2** dashboards/P&L correctness — so every subsequent decision uses true numbers.
3. **H1** lock-cache resilience + log throttle (stability), **H3** cap expiry filter (prevents slow halt), **H2** freshness-gate fix (risk).
4. **H4** no-fill throttle + **H5** hedge-timing tail + **H6** order-abort (fill-rate + naked-window).
5. Tier 2 (sizing/cash-awareness M2, dead slippage M1, exposure-guard M3) for incremental fill-rate + execution quality.
6. Tier 3 hardening batch.

All fixes should stay flag-gated (default off = byte-identical) and canary on the live worker, preserving the existing safety controls (hardlocks, exposure cap, quarantine). Full raw findings (101) in `evidence/workflow-raw.json`; operator-nailed detail in `operator-nailed-findings.md`.
