import test from "node:test";
import assert from "node:assert/strict";
import { createIdempotentShutdown } from "../src/shutdown";

test("idempotent shutdown runs cleanup once for concurrent and later calls", async () => {
  let cleanupCalls = 0;
  const shutdown = createIdempotentShutdown(async () => {
    cleanupCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  const first = shutdown();
  const second = shutdown();
  assert.equal(first, second);
  await Promise.all([first, second]);
  await shutdown();

  assert.equal(cleanupCalls, 1);
});

test("idempotent shutdown propagates the first cleanup failure without rerunning cleanup", async () => {
  const error = new Error("cleanup failed");
  let cleanupCalls = 0;
  const shutdown = createIdempotentShutdown(async () => {
    cleanupCalls += 1;
    throw error;
  });

  const results = await Promise.allSettled([shutdown(), shutdown()]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.equal(results[0].status === "rejected" ? results[0].reason : null, error);
  assert.equal(results[1].status === "rejected" ? results[1].reason : null, error);
  await assert.rejects(() => shutdown(), error);
  assert.equal(cleanupCalls, 1);
});
