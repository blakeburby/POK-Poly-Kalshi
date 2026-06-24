import test from "node:test";
import assert from "node:assert/strict";
import { downsampleEquity, combineWithCarryForward } from "../src/db/portfolio-equity";
import { accountEquity, equityPnlOverMs, equityRangeChange, equitySeriesForRange } from "../app/lib/selectors";

const venueActivity = (portfolioValue: number | null, cashValue: number | null, stale = false) => ({
  platform: "polymarket",
  connectionStatus: "live",
  lastUpdatedAt: 0,
  portfolio: {
    platform: "polymarket",
    portfolioValue,
    cashValue,
    dayChangeDollars: null,
    dayChangePercent: null,
    lastUpdatedAt: 0,
    stale,
  },
  positions: [],
  openOrders: [],
  history: [],
  sparkline: [],
});

test("downsampleEquity caps point count, stays ascending, and preserves the newest point exactly", () => {
  const pts = Array.from({ length: 5000 }, (_, i) => ({ t: 1_000 + i * 1_000, v: i }));
  const out = downsampleEquity(pts, 200);
  assert.ok(out.length <= 200, `expected <= 200, got ${out.length}`);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t, "ascending by t");
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1], "newest point preserved exactly (header correctness)");
});

test("downsampleEquity passes through empty / short inputs unchanged", () => {
  assert.deepEqual(downsampleEquity([], 200), []);
  const one = [{ t: 5, v: 1 }];
  assert.deepEqual(downsampleEquity(one, 200), one);
  const few = [
    { t: 1, v: 1 },
    { t: 2, v: 2 },
  ];
  assert.deepEqual(downsampleEquity(few, 200), few);
});

test("equityRangeChange returns absolute + percent, guarding a ~0 base and short series", () => {
  assert.deepEqual(
    equityRangeChange([
      { t: 1, v: 100 },
      { t: 2, v: 110 },
    ]),
    { absolute: 10, percent: 0.1 },
  );
  const neg = equityRangeChange([
    { t: 1, v: 200 },
    { t: 2, v: 150 },
  ]);
  assert.equal(neg.absolute, -50);
  assert.ok(Math.abs((neg.percent ?? 0) - -0.25) < 1e-9);
  assert.deepEqual(
    equityRangeChange([
      { t: 1, v: 0 },
      { t: 2, v: 5 },
    ]),
    { absolute: 5, percent: null },
  ); // zero base
  assert.deepEqual(equityRangeChange([{ t: 1, v: 5 }]), { absolute: null, percent: null });
  assert.deepEqual(equityRangeChange([]), { absolute: null, percent: null });
});

test("equitySeriesForRange slices to the selected window and supports 'all'", () => {
  const day = 24 * 60 * 60_000;
  const now = 40 * day;
  const points = Array.from({ length: 40 }, (_, i) => ({ t: (i + 1) * day, v: 100 + i }));
  const snap = { equityCurve: { points }, tradingActivity: null } as never;
  const week = equitySeriesForRange(snap, "7d", now);
  assert.ok(week.length > 1 && week.every((p) => p.t >= now - 7 * day), "only the last 7 days");
  assert.equal(equitySeriesForRange(snap, "all", now).length, 40);
});

test("equitySeriesForRange falls back to a flat 2-point line at current equity when history is empty", () => {
  const snap = { equityCurve: { points: [], currentCombinedValue: 250 }, tradingActivity: null } as never;
  const out = equitySeriesForRange(snap, "24h", 1_000_000);
  assert.equal(out.length, 2);
  assert.equal(out[0].v, 250);
  assert.equal(out[1].v, 250);
});

test("equitySeriesForRange appends the live value as the latest point", () => {
  const day = 24 * 60 * 60_000;
  const now = 5 * day;
  const points = [
    { t: 1 * day, v: 100 },
    { t: 2 * day, v: 110 },
  ];
  const snap = { equityCurve: { points, currentCombinedValue: 130 }, tradingActivity: null } as never;
  const out = equitySeriesForRange(snap, "all", now);
  assert.equal(out.length, 3, "appends live now-point");
  assert.equal(out[out.length - 1].t, now);
  assert.equal(out[out.length - 1].v, 130, "right edge == live headline");
});

test("equityPnlOverMs returns combined-equity delta over the window, null without history", () => {
  const day = 24 * 60 * 60_000;
  const now = 10 * day;
  const points = [
    { t: now - 3 * day, v: 100 },
    { t: now - 2 * day, v: 120 },
    { t: now - 1 * day, v: 90 },
    { t: now - 60_000, v: 110 },
  ];
  const snap = { equityCurve: { points, currentCombinedValue: 115 }, tradingActivity: null } as never;
  assert.equal(equityPnlOverMs(snap, day, now), 25); // live 115 − first-in-24h 90
  assert.equal(equityPnlOverMs(snap, 7 * day, now), 15); // live 115 − first-in-7d 100
  assert.equal(equityPnlOverMs({ equityCurve: { points: [] }, tradingActivity: null } as never, day, now), null);
});

test("accountEquity sums both venues and flags a missing venue as partial (never silently Kalshi-only)", () => {
  const snap = {
    tradingActivity: { kalshi: venueActivity(43.6, 43.6), polymarket: venueActivity(null, null) },
  } as never;
  const eq = accountEquity(snap);
  assert.equal(eq.kalshi, 43.6);
  assert.equal(eq.polymarket, null);
  assert.equal(eq.total, 43.6); // still sums the available venue...
  assert.deepEqual(eq.missingVenues, ["polymarket"]); // ...but flags the gap so the UI never presents it as complete
  assert.equal(eq.partial, true);
});

test("accountEquity reports a carried-forward venue as stale (not missing) and includes it in the sum", () => {
  const snap = {
    tradingActivity: { kalshi: venueActivity(43.6, 43.6), polymarket: venueActivity(12, 12, true) },
  } as never;
  const eq = accountEquity(snap);
  assert.equal(eq.total, 55.6); // Kalshi 43.6 + Polymarket 12 (last-known)
  assert.deepEqual(eq.missingVenues, []);
  assert.deepEqual(eq.staleVenues, ["polymarket"]);
  assert.equal(eq.partial, true);
});

test("accountEquity is a clean both-venue sum when both venues are live", () => {
  const snap = { tradingActivity: { kalshi: venueActivity(43.6, 43.6), polymarket: venueActivity(20, 20) } } as never;
  const eq = accountEquity(snap);
  assert.equal(eq.total, 63.6);
  assert.equal(eq.partial, false);
  assert.deepEqual(eq.missingVenues, []);
});

test("accountEquity does NOT double-count Polymarket cash when Polymarket holds open positions", () => {
  // Polymarket account source emits portfolioValue = cash (100) + position MTM (50) = 150 (the full total).
  const polyWithPositions = {
    platform: "polymarket",
    connectionStatus: "live",
    lastUpdatedAt: 0,
    portfolio: {
      platform: "polymarket",
      portfolioValue: 150,
      cashValue: 100,
      dayChangeDollars: null,
      dayChangePercent: null,
      lastUpdatedAt: 0,
    },
    positions: [{ id: "x", market: "m", outcome: "YES", shares: 100, value: 50, averagePrice: 0.5, updatedAt: 0 }],
    openOrders: [],
    history: [],
    sparkline: [],
  };
  const snap = { tradingActivity: { kalshi: venueActivity(43.6, 43.6), polymarket: polyWithPositions } } as never;
  const eq = accountEquity(snap);
  assert.equal(eq.polymarket, 150); // cash counted ONCE: 100 + 50 = 150, not 250
  assert.equal(eq.total, 193.6);
});

test("combineWithCarryForward carries each venue's last value so the combined never collapses to one account", () => {
  const out = combineWithCarryForward([
    { t: 1, kalshi: 40, polymarket: 5 }, // 45
    { t: 2, kalshi: null, polymarket: 7 }, // 40 (carried) + 7 = 47
    { t: 3, kalshi: 42, polymarket: null }, // 42 + 7 (carried) = 49
    { t: 4, kalshi: null, polymarket: null }, // 42 + 7 = 49
  ]);
  assert.deepEqual(out, [
    { t: 1, v: 45 },
    { t: 2, v: 47 },
    { t: 3, v: 49 },
    { t: 4, v: 49 },
  ]);
});

test("combineWithCarryForward skips leading rows before either venue has reported", () => {
  const out = combineWithCarryForward([
    { t: 1, kalshi: null, polymarket: null }, // skipped (no data yet)
    { t: 2, kalshi: 10, polymarket: null }, // 10 (Polymarket not yet seen -> 0)
    { t: 3, kalshi: 10, polymarket: 3 }, // 13
  ]);
  assert.deepEqual(out, [
    { t: 2, v: 10 },
    { t: 3, v: 13 },
  ]);
});
