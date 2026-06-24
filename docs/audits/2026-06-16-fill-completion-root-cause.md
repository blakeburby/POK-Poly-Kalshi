# Why two-sided fills are still rare — root-cause audit (2026-06-16)

Production data pulled live from `cross_venue_arb_signals` (Hostinger VPS), validated against code.

## Headline reframe

The system is **not "trying and failing to fill both legs."** It is **declining ~99.99% of
candidates and almost never attempting.**

Last 24h: **159,974 skipped · 2 attempted · 0 filled.** Last 7 days: **18,375 skipped (with timings) ·
11 real order attempts · 0 completed two-sided.**

So "two-sided completion ≈ 0%" is dominated by _non-attempts_, not by failed hedges. Any fix aimed only
at execution mechanics (sequencing, hedge cap, retry, latency) addresses <0.01% of the volume.

## The skip funnel (24h, ≈159,976 candidates)

| Stage                               |   Count |     Share | Verdict                  |
| ----------------------------------- | ------: | --------: | ------------------------ |
| **Executable edge below threshold** | 147,830 | **92.4%** | binding gate — see below |
| Too close to expiry (<30s)          |   4,864 |      3.0% | correct guard            |
| Kalshi cash below required          |   2,534 |      1.6% | **underfunding** ($19)   |
| Insufficient book depth (<10 sh)    |   2,414 |      1.5% | depth gate vs size-5     |
| Quote skew between venues           |   1,885 |      1.2% | phantom/staleness guard  |
| Stale quote (one leg)               |     445 |      0.3% | correct guard            |
| **Attempted**                       |   **2** |    0.001% | both failed              |
| **Filled both legs**                |   **0** |        0% | —                        |

## Why 92% die at the edge gate (the core finding)

`guaranteed_profit` (DB column) = `1 − (bestYesAsk_lower + bestNoAsk_higher)` at **top-of-book best ask**
(`payoff.ts:184`). The binding gate (`quote-quality.ts:192-199`) instead prices the **5-share
depth-weighted worst ask + 2¢ cushion on each leg** and requires ≥1¢:

```
kalshi.worstAsk(5) + poly.worstAsk(5)  ≤  0.95        # i.e. 5¢ gross at the worst-of-5 price
```

Of the 147,830 edge skips, **all had positive top-of-book edge**, and **95,962 (65%) showed ≥10¢
top-of-book edge.** A ≥10¢ best-ask edge in a binary whose fair premium ≈ $1.00, that collapses to a
sub-1¢ 5-share VWAP, is the **phantom signature**: a 1–2-lot dust/stale order sitting below fair value
with the real liquidity at fair value. The depth-weighting is **correctly refusing to chase it.**

Contrast: candidates that _do_ pass have **flat real books** (e.g. Kalshi `5 @ 0.39` + Poly `5 @ 0.56`
→ 0.95 → exactly +1¢ after cushion). Those are genuine, **small (~5¢)**, and **rare (~2/day)** — and
they _are_ attempted.

**Implication:** the bot is mostly idle because genuine, depth-backed, executable cross-venue edge at
size 5 is scarce — not because execution is broken. Forcing more attempts by loosening the edge/cushion
or shrinking size **re-introduces the phantom chase** → one-sided exposure (the thing we must avoid),
unless first validated that the thin top-of-book is real.

## The few real attempts also fail (concrete, fixable)

The one attempt since the live enable — signal **2599386** — Polymarket FAK filled **5.17857** shares; the
exact `[5,5]` hedge-trigger range (`isPolymarketFirstFillCountInRange`, `executor.ts:1596-1600`;
`LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES` defaults to `liveOrderSize`=5) rejected `5.17857 ≤ 5` →
status `unexpected_fill_count` → Kalshi **never submitted** → **one-sided 5.18-share Polymarket exposure.**
The A2 floor-hedge couldn't even run because the trigger gate rejected the overfill _before_ sizing.

## Prioritized fixes

### Tier 1 — complete the real attempts (no overpay, no phantom risk; do now)

1. **Admit Polymarket FAK overfill + floor-hedge.** Raise `LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES` to
   `liveOrderSize + 1` so a natural fractional overfill triggers the A2 floor-hedge (hedge `floor(fill)`,
   leave the <1-share residual to the bounded quarantine) instead of stranding the whole position
   one-sided. Directly fixes signal 2599386. Strictly reduces exposure.
2. **Fund Kalshi** to a multi-trade floor (≥$100). Removes the 2,534/day collateral skips and gives canary
   throughput. Until funded, attempts on the reliable leg can't size.
3. **Switch to `kalshi_first_exact`** (already built, flag-gated). Commit the reliable integer Kalshi leg
   (FOK) first; an underfunded/unfillable leg aborts **before** any Polymarket order → failure flips from
   "Poly filled / Kalshi missing (held)" to "Kalshi missing / Poly never sent (flat)." Enable after #2.

### Tier 2 — surface more _genuine_ attempts (needs validation; high upside, real risk)

4. **Resolve phantom-vs-steep first** (read-only). The ≥10¢-TOB skips are either dust (don't trade) or
   shallow-but-real (capture at smaller size). The 5-share `worstAsk` gate is what filters dust; reducing
   size weakens it. → Run a shadow ladder capture (persist full `levelsConsumed` for top-N rejected-on-edge
   candidates for a few hours), classify, then **only if shallow-real**: reduce `LIVE_ORDER_SIZE` (5→2) and
   re-test, keeping a real-liquidity sanity check + tighter skew/freshness so dust can't pass.
5. **Cushion review (coupled to size).** The 4¢ round-trip cushion taxes the thin real edges; at smaller
   size, slippage is lower, so a 2¢→1¢ cushion may be justified — but only after #4, and watch
   first-leg-no-fill.

### What is NOT the problem (validated against data)

Latency, sequencing, hedge cap, retry logic, partial-fill handling, stale quotes, slow execution — each
touches <2% of skips or only the ~2/day attempts. The Phase-A latency + hedge fixes were correct but are
not the lever for completion _rate_ while the bot attempts ~2/day.

## 80% target — interpretation

- **80% of _attempts_ complete both legs** → achievable with Tier 1 (overfill fix + funding + kalshi-first).
- **80% of _opportunities_ → completed pairs** → not achievable without chasing phantom edge (overpay /
  one-side). Most "opportunities" have no real depth-backed edge. More _volume_ of completed pairs requires
  validated Tier 2 (size/cushion), not looser gates.
