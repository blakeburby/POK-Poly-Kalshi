import test from "node:test";
import assert from "node:assert/strict";
import { ReentryThrottle } from "../src/scanner/reentry";

test("re-entry throttle allows first fill, blocks before interval, and allows at boundary", () => {
  const throttle = new ReentryThrottle(15_000);
  assert.equal(throttle.canEnter("pair", 100_000), true);
  throttle.recordFill("pair", 100_000);
  assert.equal(throttle.canEnter("pair", 114_999), false);
  assert.equal(throttle.canEnter("pair", 115_000), true);
});

test("re-entry throttle hydrates filled attempts from persistence", () => {
  const throttle = new ReentryThrottle(15_000);
  throttle.hydrate([{ pairKey: "pair", filledAtMs: 200_000 }]);
  assert.equal(throttle.nextAllowedAt("pair"), 215_000);
  assert.equal(throttle.canEnter("pair", 214_999), false);
  assert.equal(throttle.canEnter("pair", 215_000), true);
});
