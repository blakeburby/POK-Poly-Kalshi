import test from "node:test";
import assert from "node:assert/strict";
import { startRuntimeHealthMonitor, sampleRuntimeHealth, getRuntimeHealth } from "../src/diagnostics/runtime-health";

test("runtime-health monitor samples event-loop lag and caches the latest reading", () => {
  startRuntimeHealthMonitor();
  const h = sampleRuntimeHealth();
  assert.ok(typeof h.eventLoopLagMeanMs === "number" && h.eventLoopLagMeanMs >= 0, "mean lag is a non-negative number");
  assert.ok(typeof h.eventLoopLagP99Ms === "number" && h.eventLoopLagP99Ms >= 0, "p99 lag is a non-negative number");
  // CPU steal is Linux-only (/proc/stat) and null on the first sample / non-Linux hosts.
  assert.ok(h.cpuStealPercent === null || typeof h.cpuStealPercent === "number", "steal is null or a number");
  assert.deepEqual(getRuntimeHealth(), h, "getRuntimeHealth returns the last sample");
});
