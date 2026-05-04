import test from "node:test";
import assert from "node:assert/strict";
import { SignalStore, type Queryable } from "../src/db/signals";
import { buildGuaranteedCandidate } from "../src/scanner/payoff";
import { contract } from "./helpers";

class FakeDb implements Queryable {
  readonly calls: { sql: string; values?: unknown[] }[] = [];

  async query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values });
    if (/UPDATE cross_venue_arb_signals/.test(sql)) {
      return {
        rows: [{
          id: values?.[0] ?? 42,
          created_at: "2026-04-29T20:00:00.000Z",
          updated_at: "2026-04-29T20:00:01.000Z",
          pair_key: "pair",
          expiry_ms: 1_800_000_000_000,
          kalshi_contract_id: "kalshi",
          polymarket_contract_id: "poly",
          lower_venue: "polymarket",
          lower_contract_id: "poly",
          lower_strike: 1500,
          lower_direction: "yes",
          lower_ask: 0.4,
          higher_venue: "kalshi",
          higher_contract_id: "kalshi",
          higher_strike: 1502,
          higher_direction: "no",
          higher_ask: 0.5,
          premium: 0.9,
          guaranteed_profit: 0.1,
          overlap_profit: 1.1,
          threshold: 0.05,
          action: values?.[1] ?? "filled",
          failure_reason: values?.[2] ?? null,
          kalshi_fill_id: values?.[3] ?? null,
          polymarket_fill_id: values?.[4] ?? null,
          kalshi_fill_price: values?.[5] ?? null,
          polymarket_fill_price: values?.[6] ?? null,
        } as T],
      };
    }
    if (/RETURNING id/.test(sql)) return { rows: [{ id: 42 } as T] };
    if (/GROUP BY pair_key/.test(sql)) return { rows: [{ pair_key: "pair", filled_at_ms: "123000" } as T] };
    if (/updated_at >= to_timestamp/.test(sql)) {
      return {
        rows: [{
          id: 7,
          created_at: "2026-04-29T20:00:00.000Z",
          updated_at: "2026-04-29T20:00:01.000Z",
          pair_key: "pair",
          expiry_ms: 1_800_000_000_000,
          kalshi_contract_id: "kalshi",
          polymarket_contract_id: "poly",
          lower_venue: "polymarket",
          lower_contract_id: "poly",
          lower_strike: 1500,
          lower_direction: "yes",
          lower_ask: 0.4,
          higher_venue: "kalshi",
          higher_contract_id: "kalshi",
          higher_strike: 1502,
          higher_direction: "no",
          higher_ask: 0.5,
          premium: 0.9,
          guaranteed_profit: 0.1,
          overlap_profit: 1.1,
          threshold: 0.05,
          action: "filled",
          failure_reason: null,
          kalshi_fill_id: "kalshi-fill",
          polymarket_fill_id: "poly-fill",
          kalshi_fill_price: 0.51,
          polymarket_fill_price: 0.41,
        } as T],
      };
    }
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

test("signal persistence exposes filled signals for analytics windows", async () => {
  const db = new FakeDb();
  const store = new SignalStore(db);
  const signals = await store.listFilledSignalsSince(1_800_000_000_000, 50);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].action, "filled");
  assert.equal(signals[0].kalshiFillPrice, 0.51);
  assert.equal(db.calls[0].values?.[0], 1_800_000_000_000);
  assert.equal(db.calls[0].values?.[1], 50);
});
