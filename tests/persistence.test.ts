import test from "node:test";
import assert from "node:assert/strict";
import { SignalStore, type Queryable } from "../src/db/signals";
import { buildGuaranteedCandidate } from "../src/scanner/payoff";
import { contract } from "./helpers";

class FakeDb implements Queryable {
  readonly calls: { sql: string; values?: unknown[] }[] = [];

  async query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values });
    if (/RETURNING id/.test(sql)) return { rows: [{ id: 42 } as T] };
    if (/GROUP BY pair_key/.test(sql)) return { rows: [{ pair_key: "pair", filled_at_ms: "123000" } as T] };
    return { rows: [] };
  }
}

test("signal persistence inserts threshold-crossing candidate before execution update", async () => {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);

  const db = new FakeDb();
  const store = new SignalStore(db);
  const signalId = await store.insertSignal({ candidate, action: "skipped", failureReason: "pending_execution" });
  assert.equal(signalId, 42);
  assert.match(db.calls[0].sql, /INSERT INTO cross_venue_arb_signals/);
  assert.equal(db.calls[0].values?.[0], candidate.pairKey);
  assert.equal(db.calls[0].values?.[18], "skipped");

  await store.updateSignal(signalId, {
    action: "filled",
    failureReason: null,
    kalshiFillId: "kalshi-fill",
    polymarketFillId: "poly-fill",
    kalshiFillPrice: 0.5,
    polymarketFillPrice: 0.4,
  });
  assert.match(db.calls[1].sql, /UPDATE cross_venue_arb_signals/);
  assert.equal(db.calls[1].values?.[0], 42);
  assert.equal(db.calls[1].values?.[1], "filled");
});

test("signal persistence exposes recent filled attempts for restart hydration", async () => {
  const store = new SignalStore(new FakeDb());
  const attempts = await store.loadRecentFilledAttempts();
  assert.deepEqual(attempts, [{ pairKey: "pair", filledAtMs: 123_000 }]);
});
