# Operator-nailed findings (independent live-data investigation, 2026-06-20)

These were nailed directly against venue truth + code while the multi-agent code audit runs in parallel. They are the highest-confidence, highest-impact items; the workflow adds breadth.

## F1 — CRITICAL: Polymarket `"mined"` lifecycle status → completed hedged arbs quarantined as "mismatch"

**Root cause:** `isConfirmingStatus()` (`src/execution/venue-confirmations.ts:121-124`) whitelists only `[confirmed, filled, matched, executed]`. Polymarket's user-stream emits a 3-stage trade lifecycle **`matched → mined → confirmed`** (venue_order_events 7d: matched=152, **mined=148**, confirmed=148). `confirmationFromEvent` (`venue-confirmations.ts:159-165`) sets `confirmed = isConfirmingStatus(status) && !mismatch && !failed` and the final ternary defaults **any non-confirming, non-failed event to `"mismatch"`** — so when the `mined` event is the one that resolves the pending confirmation (a timing race among the 3 events), an otherwise-perfect fill is classified `"mismatch"` → executor quarantines it. P0 (`LIVE_CONFIRMATION_OVERFILL_TOLERANT`) does NOT help because this is a STATUS-whitelist fallthrough, not a fill-count band issue.
**Live evidence:** 79 "private stream confirmation mismatch" quarantines (7d); **76 had BOTH legs filled and all 76 are in-band** (poly 5.0–6.0, tail p50=0.14 sh). The most-recent case **#3198170 is an EXACT 5/5 fill** quarantined as "mismatch". Newest ~10h ago — live + ongoing.
**Impact:** ~76 completed, hedged, profitable arbs/7d booked as "failed"/quarantined → the real 7d completed-arb count is ~93 not 17 (**~5× fill-rate + realized-profit undercount**), needless quarantine + exposure-cap churn, and dashboards/headline drastically understate performance. CRITICAL for profitability + fill-rate + stability + observability.
**Fix (quick, high-impact):** add `"mined"` (and any other benign Polymarket lifecycle status) to `isConfirmingStatus`; BETTER/robuster — make the fallback confirm a non-failed, in-band, fillCount>0 event instead of defaulting to "mismatch" (`status = failed ? "failed" : mismatch ? "mismatch" : "confirmed"`). Add unit tests for matched/mined/confirmed events at 5/5 and 5.16/5. Optionally flag-gate, but this is a correctness fix. **Confidence: HIGH.**

## F2 — Hedge one-sided window: median fine, tail real; `venueSubmitSkewMs` metric is misleading

**Finding:** On actual two-sided (kalshi-filled) trades, `venueSubmitSkewMs` p50=**399ms** (104/128 fire early at the fill trigger), NOT 2500ms — the earlier "p50=2500" was a **no-fill metric artifact** (the metric is computed over all attempts incl. no-fills where the 2nd leg never fires, inflating the percentile). So the real one-sided window is ~400ms median (acceptable), but **p90=4497ms** — ~10% of two-sided trades carry a 4.5s+ naked window (real tail execution risk, e.g. hedge-quote staleness / slow trigger).
**Impact:** the headline `venueSubmitSkewMs` p50=2500 in dashboards/telemetry is misleading (observability bug); the genuine issue is the ~10% multi-second one-sided tail (execution risk under volatility). MEDIUM.
**Fix:** compute `venueSubmitSkewMs` only when both legs actually submitted (exclude no-fill/not-submitted); investigate the p90 4.5s tail (hedge-trigger lag / quote staleness) and bound it. **Confidence: HIGH (metric); MEDIUM (tail cause).**

## F3 — HIGH: "live hot-path lock cache is stale" halts ALL scanning + log-floods

**Finding:** logs show a flood of ERROR "live scan blocked by persistent circuit breaker" reason "live hot-path lock cache is stale" — dozens within one second (06:25:04, shortly after a restart). The scanner treats a stale hot-path lock cache as a circuit-breaker block → halts every scan + logs an ERROR per blocked scan (no throttle).
**Impact:** when the `CachedLiveExecutionLockStore` refresh lags/fails, the worker stops trading AND floods logs (obscures real errors, disk/IO). Availability + observability risk. HIGH.
**Fix:** investigate the staleness bound vs refresh cadence in `src/execution/live-hot-path.ts`; serve last-good within a bounded window (like LiveExposureCache) instead of hard-blocking on transient staleness; throttle the block log (it already has logThrottle elsewhere). Workflow risk-filters finder to pinpoint. **Confidence: HIGH (symptom); fix pending code trace.**

## Context for synthesis

- 7d: 211 failed / 17 filled (but ~76 of the "failed" are actually completed arbs per F1).
- Profitability (real fills 14d): avg +0.10/sh, p50 +0.043, 1 negative (-0.035, below loss cap).
- All P0/P1/P2/W1/W2/W3 flags ON; unresolved exposure $0; commit c8aec36.
