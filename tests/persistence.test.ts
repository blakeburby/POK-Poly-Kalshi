import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LiveExecutionLockStore } from "../src/db/live-execution-locks";
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
          execution_mode: "live",
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
          execution_group_id: values?.[7] ?? null,
          kalshi_client_order_id: values?.[8] ?? null,
          polymarket_client_order_id: values?.[9] ?? null,
          kalshi_status: values?.[10] ?? null,
          polymarket_status: values?.[11] ?? null,
          kalshi_fill_count: values?.[12] ?? null,
          polymarket_fill_count: values?.[13] ?? null,
          kalshi_requested_at: values?.[14] ?? null,
          kalshi_responded_at: values?.[15] ?? null,
          polymarket_requested_at: values?.[16] ?? null,
          polymarket_responded_at: values?.[17] ?? null,
          kalshi_error: values?.[18] ?? null,
          polymarket_error: values?.[19] ?? null,
          partial_fill: values?.[20] ?? false,
          quote_snapshot: values?.[21] ?? null,
          depth_vwap: values?.[22] ?? null,
          projected_edge_after_fees: values?.[23] ?? null,
          execution_timings: values?.[24] ?? null,
          venue_confirmations: values?.[25] ?? null,
          execution_strategy: values?.[26] ?? null,
          risk_hedge: values?.[27] ?? false,
          realized_guaranteed_profit: values?.[28] ?? null,
          hedge_cap_price: values?.[29] ?? null,
          reconciliation_resolved_at: values?.[30] ?? null,
          reconciliation_resolution_reason: values?.[31] ?? null,
          reconciliation_resolution: values?.[32] ?? null,
          recovery_status: values?.[33] ?? null,
          recovery_attempts: values?.[34] ?? null,
          recovery_evidence: values?.[35] ?? null,
          finalization_ms: values?.[36] ?? null,
        } as T],
      };
    }
    if (/RETURNING id/.test(sql)) return { rows: [{ id: 42 } as T] };
    if (/GROUP BY pair_key/.test(sql)) return { rows: [{ pair_key: "pair", filled_at_ms: "123000" } as T] };
    if (/execution_group_id IS NOT NULL/.test(sql)) {
      return {
        rows: [{
          id: 99,
          pair_key: "pair",
          expiry_ms: 1_800_000_000_000,
          kalshi_contract_id: "kalshi",
          polymarket_contract_id: "poly",
          lower_venue: "polymarket",
          lower_contract_id: "poly",
          lower_direction: "yes",
          higher_venue: "kalshi",
          higher_contract_id: "kalshi",
          higher_direction: "no",
          kalshi_fill_count: 5,
          polymarket_fill_count: 5,
        } as T],
      };
    }
    if (/updated_at >= to_timestamp/.test(sql)) {
      return {
        rows: [{
          id: 7,
          created_at: "2026-04-29T20:00:00.000Z",
          updated_at: "2026-04-29T20:00:01.000Z",
          execution_mode: "live",
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
          execution_group_id: "group",
          kalshi_client_order_id: "kalshi-client",
          polymarket_client_order_id: "poly-client",
          kalshi_status: "filled",
          polymarket_status: "filled",
          kalshi_fill_count: 1,
          polymarket_fill_count: 1,
          kalshi_requested_at: "2026-04-29T20:00:00.500Z",
          kalshi_responded_at: "2026-04-29T20:00:00.800Z",
          polymarket_requested_at: "2026-04-29T20:00:00.500Z",
          polymarket_responded_at: "2026-04-29T20:00:00.900Z",
          kalshi_error: null,
          polymarket_error: null,
          partial_fill: false,
        } as T],
      };
    }
    return { rows: [] };
  }
}

class FakeLockDb implements Queryable {
  readonly calls: { sql: string; values?: unknown[] }[] = [];
  activeRows: Record<string, unknown>[] = [];

  async query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values });
    if (/SELECT/.test(sql) && /FROM live_execution_locks/.test(sql)) return { rows: this.activeRows as T[] };
    if (/INSERT INTO live_execution_locks/.test(sql)) {
      const row = {
        id: 1,
        created_at: "2026-04-29T20:00:00.000Z",
        reason: values?.[0],
        severity: values?.[1],
        source_signal_id: values?.[2],
        execution_group_id: values?.[3],
        details: JSON.parse(String(values?.[4] ?? "{}")) as Record<string, unknown>,
        cleared_at: null,
        clear_reason: null,
      };
      this.activeRows = [row];
      return { rows: [row as T] };
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
  assert.equal(db.calls[0].values?.[18], "paper");
  assert.equal(db.calls[0].values?.[19], "skipped");

  await store.insertSignal({ candidate, executionMode: "live", action: "skipped", failureReason: "pending_execution" });
  assert.equal(db.calls[1].values?.[18], "live");

  await store.updateSignal(signalId, {
    action: "filled",
    failureReason: null,
    kalshiFillId: "kalshi-fill",
    polymarketFillId: "poly-fill",
    kalshiFillPrice: 0.5,
    polymarketFillPrice: 0.4,
    executionGroupId: "group",
    kalshiClientOrderId: "kalshi-client",
    polymarketClientOrderId: "poly-client",
    kalshiStatus: "filled",
    polymarketStatus: "filled",
    kalshiFillCount: 1,
    polymarketFillCount: 1,
    kalshiRequestedAt: "2026-04-29T20:00:00.500Z",
    kalshiRespondedAt: "2026-04-29T20:00:00.800Z",
    polymarketRequestedAt: "2026-04-29T20:00:00.500Z",
    polymarketRespondedAt: "2026-04-29T20:00:00.900Z",
    partialFill: false,
    recoveryStatus: "auto_resolved_paired_fill",
    recoveryAttempts: 1,
    recoveryEvidence: { source: "test" },
    finalizationMs: 3400,
  });
  assert.match(db.calls[2].sql, /UPDATE cross_venue_arb_signals/);
  assert.equal(db.calls[2].values?.[0], 42);
  assert.equal(db.calls[2].values?.[1], "filled");
  assert.equal(db.calls[2].values?.[7], "group");
  assert.equal(db.calls[2].values?.[20], false);
  assert.equal(db.calls[2].values?.[33], "auto_resolved_paired_fill");
  assert.equal(db.calls[2].values?.[34], 1);
  assert.equal(db.calls[2].values?.[36], 3400);
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
  assert.equal(signals[0].executionMode, "live");
  assert.equal(signals[0].executionGroupId, "group");
  assert.equal(signals[0].partialFill, false);
  assert.equal(db.calls[0].values?.[0], 1_800_000_000_000);
  assert.equal(db.calls[0].values?.[1], 50);
});

test("signal persistence filters recent and filled signals by execution mode", async () => {
  const db = new FakeDb();
  const store = new SignalStore(db);

  await store.listRecentSignals(25, "live");
  assert.match(db.calls[0].sql, /WHERE execution_mode = \$2/);
  assert.deepEqual(db.calls[0].values, [25, "live"]);

  await store.listFilledSignalsSince(1_800_000_000_000, 50, "paper");
  assert.match(db.calls[1].sql, /AND execution_mode = \$3/);
  assert.deepEqual(db.calls[1].values, [1_800_000_000_000, 50, "paper"]);
});

test("execution mode migration backfills live rows from real execution metadata", () => {
  const sql = readFileSync("src/db/migrations/007_add_signal_execution_mode.sql", "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'paper'/);
  assert.match(sql, /SET execution_mode = 'live'/);
  assert.match(sql, /execution_group_id IS NOT NULL/);
  assert.match(sql, /venue_confirmations IS NOT NULL/);
  assert.match(sql, /CHECK \(execution_mode IN \('paper', 'live'\)\)/);
});

test("reconciliation resolution migration adds operator-resolved incident markers", () => {
  const sql = readFileSync("src/db/migrations/011_add_live_reconciliation_resolution.sql", "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reconciliation_resolved_at TIMESTAMPTZ/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reconciliation_resolution_reason TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reconciliation_resolution JSONB/);
  assert.match(sql, /reconciliation_resolved_at IS NULL/);
});

test("recovery metadata migration adds verified recovery audit columns", () => {
  const sql = readFileSync("src/db/migrations/012_add_live_recovery_metadata.sql", "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS recovery_status TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS recovery_evidence JSONB/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS finalization_ms INTEGER/);
});

test("signal persistence blocks live candidates with same-window exposure", async () => {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);

  const store = new SignalStore(new FakeDb());
  const maxTradeReason = await store.liveExposureBlockReason(candidate, 1_799_999_999_000, 1);
  assert.match(maxTradeReason ?? "", /max trades per window/);
  const legReason = await store.liveExposureBlockReason(candidate, 1_799_999_999_000, 2);
  assert.match(legReason ?? "", /Kalshi leg kalshi already has exposure/);
});

test("live reconciliation blocks unresolved partial fills but ignores operator-resolved incidents", async () => {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);

  const unresolvedDb: Queryable = {
    async query() {
      return {
        rows: [{
          id: 14741,
          action: "failed",
          partial_fill: true,
          kalshi_status: "no_order",
          polymarket_status: "filled",
          kalshi_fill_count: 0,
          polymarket_fill_count: 5,
          venue_confirmations: null,
          reconciliation_resolved_at: null,
        }],
      };
    },
  };
  const unresolved = await new SignalStore(unresolvedDb).liveReconciliationBlockReason(candidate, 1_799_999_999_000);
  assert.match(unresolved ?? "", /signal #14741 is marked partial_fill/);

  const resolvedDb: Queryable = {
    async query() {
      return {
        rows: [{
          id: 14741,
          action: "failed",
          partial_fill: true,
          kalshi_status: "no_order",
          polymarket_status: "filled",
          kalshi_fill_count: 0,
          polymarket_fill_count: 5,
          venue_confirmations: null,
          reconciliation_resolved_at: "2026-05-11T03:10:00.000Z",
        }],
      };
    },
  };
  assert.equal(await new SignalStore(resolvedDb).liveReconciliationBlockReason(candidate, 1_799_999_999_000), null);
});

test("live reconciliation keeps unknown venue statuses blocking until resolved", async () => {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);

  const db: Queryable = {
    async query() {
      return {
        rows: [{
          id: 14742,
          action: "failed",
          partial_fill: false,
          kalshi_status: "unknown",
          polymarket_status: "filled",
          kalshi_fill_count: 0,
          polymarket_fill_count: 0,
          venue_confirmations: null,
          reconciliation_resolved_at: null,
        }],
      };
    },
  };
  const reason = await new SignalStore(db).liveReconciliationBlockReason(candidate, 1_799_999_999_000);
  assert.match(reason ?? "", /signal #14742 has unresolved venue status/);
});

test("live execution lock store persists a restart-safe active lock", async () => {
  const db = new FakeLockDb();
  const store = new LiveExecutionLockStore(db);

  assert.equal(await store.getActiveLock(), null);
  const lock = await store.engageLock({
    reason: "live safety lock engaged: realized edge below threshold",
    sourceSignalId: 42,
    executionGroupId: "group",
    details: { kalshiFillCount: 30, polymarketFillCount: 5 },
  });
  const duplicate = await store.engageLock({ reason: "second reason should not replace active lock" });

  assert.equal(lock.reason, "live safety lock engaged: realized edge below threshold");
  assert.equal(lock.sourceSignalId, 42);
  assert.equal(lock.executionGroupId, "group");
  assert.deepEqual(lock.details, { kalshiFillCount: 30, polymarketFillCount: 5 });
  assert.equal(duplicate.reason, lock.reason);
  assert.equal(db.calls.filter((call) => /INSERT INTO live_execution_locks/.test(call.sql)).length, 1);
});
