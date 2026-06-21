import test from "node:test";
import assert from "node:assert/strict";
import { CachedLiveExecutionLockStore } from "../src/execution/live-hot-path";
import type { LiveExecutionLock, LiveExecutionLockInput, LiveExecutionLockWriter } from "../src/db/live-execution-locks";

function lock(reason: string): LiveExecutionLock {
  return { id: 1, createdAt: new Date(0).toISOString(), reason, severity: "critical", sourceSignalId: null, executionGroupId: null, details: {}, clearedAt: null, clearReason: null };
}

class FakeDelegate implements LiveExecutionLockWriter {
  active: LiveExecutionLock | null = null;
  async getActiveLock(): Promise<LiveExecutionLock | null> { return this.active; }
  async engageLock(input: LiveExecutionLockInput): Promise<LiveExecutionLock> { this.active = lock(input.reason); return this.active; }
}

test("H1: within the grace window a stale cache serves last-good (no lock) instead of synthesizing a breaker", async () => {
  let now = 1000;
  const cache = new CachedLiveExecutionLockStore(new FakeDelegate(), 5000, () => now, 10000); // maxAge 5s, grace 10s
  await cache.refresh(); // hydrate at t=1000, cached = null
  now = 1000 + 5001; // age 5001 > maxAge 5000 but within maxAge + grace (15000)
  assert.equal(await cache.getActiveLock(), null);
});

test("H1: within the grace window a REAL prior lock keeps blocking (last-good)", async () => {
  let now = 1000;
  const delegate = new FakeDelegate();
  delegate.active = lock("real breaker");
  const cache = new CachedLiveExecutionLockStore(delegate, 5000, () => now, 10000);
  await cache.refresh(); // cached = the real lock
  now = 1000 + 5001;
  const r = await cache.getActiveLock();
  assert.equal(r?.reason, "real breaker");
});

test("H1: graceMs=0 (default) still synthesizes a breaker the instant the cache exceeds max age (byte-identical)", async () => {
  let now = 1000;
  const cache = new CachedLiveExecutionLockStore(new FakeDelegate(), 5000, () => now); // graceMs default 0
  await cache.refresh();
  now = 1000 + 5001;
  const r = await cache.getActiveLock();
  assert.ok(r != null && /lock cache is stale/.test(r.reason));
});

test("H1: beyond max-age + grace the cache fail-safe blocks", async () => {
  let now = 1000;
  const cache = new CachedLiveExecutionLockStore(new FakeDelegate(), 5000, () => now, 10000);
  await cache.refresh();
  now = 1000 + 5000 + 10000 + 1; // beyond the ceiling
  const r = await cache.getActiveLock();
  assert.ok(r != null && /lock cache is stale/.test(r.reason));
});

test("H1: a never-hydrated cache fail-safe blocks", async () => {
  const cache = new CachedLiveExecutionLockStore(new FakeDelegate(), 5000, () => 1000, 10000);
  const r = await cache.getActiveLock();
  assert.ok(r != null && /not been hydrated/.test(r.reason));
});

test("H1: a fresh cache serves the cached value", async () => {
  let now = 1000;
  const cache = new CachedLiveExecutionLockStore(new FakeDelegate(), 5000, () => now, 10000);
  await cache.refresh();
  now = 1000 + 100; // well within maxAge
  assert.equal(await cache.getActiveLock(), null);
});
