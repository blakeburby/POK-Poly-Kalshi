import test from "node:test";
import assert from "node:assert/strict";
import { DashboardSignalsNotifier } from "../src/dashboard/signals-notifier";

test("subscribe receives notifyChanged; unsubscribe stops further delivery", () => {
  const n = new DashboardSignalsNotifier();
  let count = 0;
  const unsubscribe = n.subscribe(() => { count += 1; });
  assert.equal(n.subscriberCount, 1);

  n.notifyChanged();
  n.notifyChanged();
  assert.equal(count, 2);

  unsubscribe();
  assert.equal(n.subscriberCount, 0);
  n.notifyChanged();
  assert.equal(count, 2, "no delivery after unsubscribe");

  // Unsubscribe is idempotent — calling it again is a no-op, not a throw.
  unsubscribe();
  assert.equal(n.subscriberCount, 0);
});

test("notifyChanged fans out to every subscriber", () => {
  const n = new DashboardSignalsNotifier();
  let a = 0, b = 0;
  n.subscribe(() => { a += 1; });
  n.subscribe(() => { b += 1; });
  assert.equal(n.subscriberCount, 2);

  n.notifyChanged();
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test("a throwing subscriber cannot break delivery to the others or the caller", () => {
  const n = new DashboardSignalsNotifier();
  let reached = 0;
  n.subscribe(() => { throw new Error("one stream blew up"); });
  n.subscribe(() => { reached += 1; });

  assert.doesNotThrow(() => n.notifyChanged());
  assert.equal(reached, 1, "the healthy subscriber still fired");
});
