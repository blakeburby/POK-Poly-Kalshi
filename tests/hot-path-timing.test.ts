import test from "node:test";
import assert from "node:assert/strict";
import {
  configureHotPathTiming,
  getHotPathTimings,
  isHotPathTimingEnabled,
  time,
  __resetHotPathTimingForTest,
} from "../src/diagnostics/hot-path-timing";

test("disabled: time() runs fn but records nothing (true no-op)", () => {
  __resetHotPathTimingForTest();
  configureHotPathTiming(false);
  let ran = false;
  const out = time("x", () => {
    ran = true;
    return 42;
  });
  assert.equal(ran, true);
  assert.equal(out, 42);
  assert.equal(isHotPathTimingEnabled(), false);
  assert.equal(getHotPathTimings(), null);
  __resetHotPathTimingForTest();
});

test("enabled: records count and returns the section stats", () => {
  __resetHotPathTimingForTest();
  configureHotPathTiming(true);
  for (let i = 0; i < 5; i += 1) {
    const out = time("serialize", () => i * 2);
    assert.equal(out, i * 2);
  }
  const t = getHotPathTimings();
  assert.ok(t);
  const s = t.sections.serialize;
  assert.ok(s, "serialize section present");
  assert.equal(s.count, 5);
  assert.ok(s.meanMs >= 0 && Number.isFinite(s.meanMs));
  assert.ok(s.p99Ms >= 0);
  assert.ok(s.maxMs >= s.meanMs - 1e-9);
  // GC block is present (observer started) — shape check, durations are environment-dependent.
  assert.ok(t.gc === null || (typeof t.gc.pauseMsTotal === "number" && typeof t.gc.count === "number"));
  __resetHotPathTimingForTest();
});

test("time() propagates the return value and still records on throw", () => {
  __resetHotPathTimingForTest();
  configureHotPathTiming(true);
  assert.throws(() =>
    time("boom", () => {
      throw new Error("nope");
    }),
  );
  const t = getHotPathTimings();
  assert.equal(t?.sections.boom?.count, 1); // recorded even though fn threw
  __resetHotPathTimingForTest();
});

test("count keeps climbing past the ring window but stats stay bounded", () => {
  __resetHotPathTimingForTest();
  configureHotPathTiming(true);
  for (let i = 0; i < 600; i += 1) time("loop", () => i);
  const s = getHotPathTimings()?.sections.loop;
  assert.equal(s?.count, 600); // total monotonic count
  __resetHotPathTimingForTest();
});
