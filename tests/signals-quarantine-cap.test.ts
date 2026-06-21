import test from "node:test";
import assert from "node:assert/strict";
import { SignalStore } from "../src/db/signals";

function fakeDb(capture: { sql?: string; params?: unknown[] }) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      capture.sql = sql;
      capture.params = params ?? [];
      return { rows: [{ total: 5, count: 2 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    },
  };
}

test("H3: with a settle-grace the quarantine-cap query passes the grace param and filters by market expiry", async () => {
  const cap: { sql?: string; params?: unknown[] } = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new SignalStore(fakeDb(cap) as any, 600_000); // 10-minute settle grace
  const status = await store.liveRiskQuarantineStatus();
  assert.equal(status.total, 5);
  assert.equal(status.count, 2);
  assert.deepEqual(cap.params, [600_000]);
  assert.match(cap.sql ?? "", /expiry_ms/);
  assert.match(cap.sql ?? "", /EXTRACT\(EPOCH FROM now\(\)\)/);
});

test("H3: default grace 0 passes 0 (the expiry filter short-circuits -> byte-identical)", async () => {
  const cap: { sql?: string; params?: unknown[] } = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new SignalStore(fakeDb(cap) as any);
  await store.liveRiskQuarantineStatus();
  assert.deepEqual(cap.params, [0]);
});
