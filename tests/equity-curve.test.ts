import test from "node:test";
import assert from "node:assert/strict";
import { downsampleEquity } from "../src/db/portfolio-equity";
import { equityRangeChange, equitySeriesForRange } from "../app/lib/selectors";

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
  const few = [{ t: 1, v: 1 }, { t: 2, v: 2 }];
  assert.deepEqual(downsampleEquity(few, 200), few);
});

test("equityRangeChange returns absolute + percent, guarding a ~0 base and short series", () => {
  assert.deepEqual(equityRangeChange([{ t: 1, v: 100 }, { t: 2, v: 110 }]), { absolute: 10, percent: 0.1 });
  const neg = equityRangeChange([{ t: 1, v: 200 }, { t: 2, v: 150 }]);
  assert.equal(neg.absolute, -50);
  assert.ok(Math.abs((neg.percent ?? 0) - -0.25) < 1e-9);
  assert.deepEqual(equityRangeChange([{ t: 1, v: 0 }, { t: 2, v: 5 }]), { absolute: 5, percent: null }); // zero base
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
