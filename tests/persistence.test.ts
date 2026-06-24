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
        rows: [
          {
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
            lead_lag_snapshot: values?.[43] ?? null,
            fill_quality_snapshot: values?.[24] ?? null,
            expected_executable_edge: values?.[25] ?? null,
            execution_timings: values?.[26] ?? null,
            venue_confirmations: values?.[27] ?? null,
            execution_strategy: values?.[28] ?? null,
            risk_hedge: values?.[29] ?? false,
            realized_guaranteed_profit: values?.[30] ?? null,
            hedge_cap_price: values?.[31] ?? null,
            reconciliation_resolved_at: values?.[32] ?? null,
            reconciliation_resolution_reason: values?.[33] ?? null,
            reconciliation_resolution: values?.[34] ?? null,
            recovery_status: values?.[35] ?? null,
            recovery_attempts: values?.[36] ?? null,
            recovery_evidence: values?.[37] ?? null,
            finalization_ms: values?.[38] ?? null,
            risk_quarantined_at: values?.[39] ?? null,
            risk_quarantine_reason: values?.[40] ?? null,
            risk_quarantine_exposure_dollars: values?.[41] ?? null,
            risk_quarantine_evidence: values?.[42] ?? null,
          } as T,
        ],
      };
    }
    if (/RETURNING id/.test(sql)) return { rows: [{ id: 42 } as T] };
    if (/GROUP BY pair_key/.test(sql)) return { rows: [{ pair_key: "pair", filled_at_ms: "123000" } as T] };
    if (/(updated_at|created_at) >= to_timestamp/.test(sql)) {
      return {
        rows: [
          {
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
          } as T,
        ],
      };
    }
    if (/execution_group_id IS NOT NULL/.test(sql)) {
      return {
        rows: [
          {
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
          } as T,
        ],
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
  assert.equal(db.calls[0].values?.[18], "skipped");
  assert.equal(db.calls[0].values?.[19], "pending_execution");

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
    fillQualitySnapshot: {
      version: "heuristic-v1",
      scoredAt: 1_800_000_000_000,
      shadowMode: true,
      gateEnabled: false,
      gatePassed: true,
      blockReason: null,
      projectedEdgeAtLimit: 0.08,
      expectedExecutableEdge: 0.03,
      minExpectedEdge: 0.01,
      pairedFillProbability: 0.5,
      kalshiExactFillProbability: 0.9,
      polymarketExactFillProbability: 0.55,
      expectedSlippage: 0.001,
      expectedMismatchCost: 0.002,
      timeoutCost: 0.003,
      penaltyReasons: ["test penalty"],
      features: {
        sampleCount: 40,
        minSamples: 30,
        coldStart: false,
        orderSize: 5,
        placementMode: "polymarket_first_exact",
        kalshiDepth: 10,
        polymarketDepth: 10,
        kalshiDepthRatio: 2,
        polymarketDepthRatio: 2,
        kalshiSpread: 0.02,
        polymarketSpread: 0.02,
        kalshiQuoteAgeMs: 50,
        polymarketQuoteAgeMs: 50,
        quoteSkewMs: 10,
        secondsToExpiry: 600,
        sameExpiryAttemptCount: 0,
        recentExactPairFillRate: 0.5,
        recentMismatchRate: 0.25,
        recentTimeoutRate: 0.1,
        kalshiRecentExactFillRate: 0.9,
        polymarketRecentExactFillRate: 0.55,
        kalshiRttP50Ms: 100,
        kalshiRttP95Ms: 200,
        polymarketRttP50Ms: 500,
        polymarketRttP95Ms: 1200,
        kalshiConfirmationP95Ms: 150,
        polymarketConfirmationP95Ms: 1600,
        polymarketSignedOrderReuseRate: 0.8,
        polymarketSignedOrderFallbackRate: 0.05,
        recentVenueEventCount: 8,
      },
    },
    leadLagSnapshot: {
      version: "heuristic-v1",
      scoredAt: 1_800_000_000_000,
      shadowMode: true,
      gateEnabled: false,
      gatePassed: true,
      blockReason: null,
      leaderVenue: "polymarket",
      laggingVenue: "kalshi",
      lagMsEstimate: 120,
      confidence: 0.82,
      stalenessScore: 0.1,
      adverseSelectionScore: 0.7,
      cheapLegVenue: "polymarket",
      cheapLegIsLagging: false,
      windows: [],
      reasons: ["test lead lag"],
    },
    expectedExecutableEdge: 0.03,
    recoveryStatus: "auto_resolved_paired_fill",
    recoveryAttempts: 1,
    recoveryEvidence: { source: "test" },
    finalizationMs: 3400,
    riskQuarantinedAt: "2026-04-29T20:00:02.000Z",
    riskQuarantineReason: "test quarantine",
    riskQuarantineExposureDollars: 4.2,
    riskQuarantineEvidence: { cap: 10 },
  });
  assert.match(db.calls[1].sql, /UPDATE cross_venue_arb_signals/);
  assert.equal(db.calls[1].values?.[0], 42);
  assert.equal(db.calls[1].values?.[1], "filled");
  assert.equal(db.calls[1].values?.[7], "group");
  assert.equal(db.calls[1].values?.[20], false);
  assert.match(String(db.calls[1].values?.[24]), /heuristic-v1/);
  assert.equal(db.calls[1].values?.[25], 0.03);
  assert.equal(db.calls[1].values?.[35], "auto_resolved_paired_fill");
  assert.equal(db.calls[1].values?.[36], 1);
  assert.equal(db.calls[1].values?.[38], 3400);
  assert.equal(db.calls[1].values?.[39], "2026-04-29T20:00:02.000Z");
  assert.equal(db.calls[1].values?.[40], "test quarantine");
  assert.equal(db.calls[1].values?.[41], 4.2);
  assert.match(String(db.calls[1].values?.[43]), /test lead lag/);
});

test("signal persistence exposes recent filled attempts for restart hydration", async () => {
  const db = new FakeDb();
  const store = new SignalStore(db);
  const attempts = await store.loadRecentFilledAttempts();
  assert.deepEqual(attempts, [{ pairKey: "pair", filledAtMs: 123_000 }]);
  assert.match(db.calls[0].sql, /execution_group_id IS NOT NULL/);
});

test("signal persistence exposes filled signals for analytics windows", async () => {
  const db = new FakeDb();
  const store = new SignalStore(db);
  const signals = await store.listFilledSignalsSince(1_800_000_000_000, 50);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].action, "filled");
  assert.equal(signals[0].kalshiFillPrice, 0.51);
  assert.equal(signals[0].executionGroupId, "group");
  assert.equal(signals[0].partialFill, false);
  assert.equal(db.calls[0].values?.[0], 1_800_000_000_000);
  assert.equal(db.calls[0].values?.[1], 50);
});

test("signal persistence readers query live execution records without mode filters", async () => {
  const db = new FakeDb();
  const store = new SignalStore(db);

  await store.listRecentSignals(25);
  assert.doesNotMatch(db.calls[0].sql, /execution_mode/);
  assert.match(db.calls[0].sql, /execution_group_id IS NOT NULL/);
  assert.doesNotMatch(db.calls[0].sql, /kalshi_fill_id IS NOT NULL/);
  assert.deepEqual(db.calls[0].values, [25]);

  await store.listFilledSignalsSince(1_800_000_000_000, 50);
  assert.doesNotMatch(db.calls[1].sql, /execution_mode/);
  assert.match(db.calls[1].sql, /execution_group_id IS NOT NULL/);
  assert.deepEqual(db.calls[1].values, [1_800_000_000_000, 50]);

  await store.listLiveExecutionQualitySignals(1_800_001_800_000, 30 * 60 * 1_000, 50);
  assert.match(db.calls[2].sql, /created_at >= to_timestamp/);
  assert.doesNotMatch(db.calls[2].sql, /updated_at >= to_timestamp/);
  assert.match(db.calls[2].sql, /ORDER BY created_at DESC/);
  assert.deepEqual(db.calls[2].values, [1_800_000_000_000, 50]);
});

test("live-only cleanup migration removes legacy non-live rows and drops the mode column", () => {
  const sql = readFileSync("src/db/migrations/014_live_only_cleanup.sql", "utf8");
  assert.match(sql, /DELETE FROM cross_venue_arb_signals/);
  assert.match(sql, /DROP COLUMN IF EXISTS execution_mode/);
  assert.match(sql, /idx_cross_venue_arb_signals_live_unresolved_reconciliation/);
  assert.match(sql, /idx_cross_venue_arb_signals_risk_quarantine_active/);
});

test("orphan execution cleanup migration removes execution-looking rows without live execution groups", () => {
  const sql = readFileSync("src/db/migrations/015_remove_orphan_execution_rows.sql", "utf8");
  assert.match(sql, /execution_group_id IS NULL/);
  assert.match(sql, /action = 'filled'/);
  assert.match(sql, /kalshi_fill_id IS NOT NULL/);
  assert.match(sql, /polymarket_fill_id IS NOT NULL/);
});

test("polymarket-first migration allows the new execution strategy", () => {
  const sql = readFileSync("src/db/migrations/017_allow_polymarket_first_exact_execution_strategy.sql", "utf8");
  assert.match(sql, /DROP CONSTRAINT IF EXISTS cross_venue_arb_signals_execution_strategy_check/);
  assert.match(sql, /polymarket_first_exact/);
});

test("parallel market migration allows the default execution strategy", () => {
  const sql = readFileSync("src/db/migrations/020_allow_parallel_market_execution_strategy.sql", "utf8");
  assert.match(sql, /DROP CONSTRAINT IF EXISTS cross_venue_arb_signals_execution_strategy_check/);
  assert.match(sql, /parallel_market/);
  assert.match(sql, /parallel_limit_rest/);
  assert.match(sql, /polymarket_first_exact/);
});

test("parallel quick migration allows synchronized UI quick execution strategy", () => {
  const sql = readFileSync("src/db/migrations/021_allow_parallel_quick_execution_strategy.sql", "utf8");
  assert.match(sql, /DROP CONSTRAINT IF EXISTS cross_venue_arb_signals_execution_strategy_check/);
  assert.match(sql, /parallel_quick/);
  assert.match(sql, /parallel_market/);
  assert.match(sql, /polymarket_first_exact/);
});

test("fill quality migration adds candidate-level scoring columns", () => {
  const sql = readFileSync("src/db/migrations/018_add_fill_quality_snapshot.sql", "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS fill_quality_snapshot JSONB/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS expected_executable_edge NUMERIC/);
  assert.match(sql, /idx_cross_venue_arb_signals_expected_executable_edge/);
});

test("lead/lag migration adds candidate-level price-discovery snapshot", () => {
  const sql = readFileSync("src/db/migrations/019_add_lead_lag_snapshot.sql", "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS lead_lag_snapshot JSONB/);
  assert.match(sql, /idx_cross_venue_arb_signals_lead_lag_snapshot/);
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

test("risk quarantine migration adds partial-fill quarantine audit columns", () => {
  const sql = readFileSync("src/db/migrations/013_add_live_risk_quarantine.sql", "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS risk_quarantined_at TIMESTAMPTZ/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS risk_quarantine_reason TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS risk_quarantine_exposure_dollars NUMERIC/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS risk_quarantine_evidence JSONB/);
  assert.match(sql, /idx_cross_venue_arb_signals_risk_quarantine_active/);
});

test("historical quarantine reconciliation treats confirmed and executed venue events as terminal", () => {
  const script = readFileSync("scripts/reconcile-historical-quarantines.ts", "utf8");
  assert.match(script, /const terminalOrderStatuses = new Set\(\[[\s\S]*"confirmed"/);
  assert.match(script, /const terminalOrderStatuses = new Set\(\[[\s\S]*"executed"/);
});

test("live-lock settlement resolver requires paused entries and zero positive-value positions before apply", () => {
  const script = readFileSync("scripts/resolve-live-lock-after-settlement.ts", "utf8");
  assert.match(script, /health\.arbEnabled !== false/);
  assert.match(script, /snapshotHealth\.arbEnabled !== false/);
  assert.match(script, /Kalshi has positive-value positions/);
  assert.match(script, /Polymarket has positive-value positions/);
  assert.match(script, /positive-value positions for active lock markets/);
  assert.match(script, /UPDATE live_execution_locks/);
  assert.match(script, /UPDATE cross_venue_arb_signals/);
  assert.match(script, /Refusing to resolve live lock/);
});

test("historical quarantine reconciliation ignores unrelated positive positions only when target positions are clean", () => {
  const script = readFileSync("scripts/reconcile-historical-quarantines.ts", "utf8");
  assert.match(script, /targetPositivePositions/);
  assert.match(script, /positive-value positions for unresolved quarantine markets/);
  assert.match(script, /positions: positions\.map\(summarizePosition\)/);
  assert.match(script, /Number\(kalshi\.positionCount/);
  assert.match(script, /Number\(kalshi\.positionValueDollars/);
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

test("signal persistence blocks submitted attempts per expiry without counting pre-submit skips", async () => {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);
  const calls: { sql: string; values?: unknown[] }[] = [];
  const db: Queryable = {
    async query<T = Record<string, unknown>>(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [{ attempt_count: 3 } as T] };
    },
  };

  const reason = await new SignalStore(db).liveSubmittedAttemptBlockReason(candidate, 1_799_999_999_000, 3);

  assert.match(reason ?? "", /submitted attempt limit reached/);
  assert.match(calls[0]?.sql ?? "", /execution_group_id IS NOT NULL/);
  assert.match(calls[0]?.sql ?? "", /action IN \('filled', 'failed'\)/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /skipped/);
  assert.deepEqual(calls[0]?.values, [candidate.expiryMs, 1_799_999_999_000]);
});

test("signal persistence allows new entries below the submitted attempt cap", async () => {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);
  const db: Queryable = {
    async query<T = Record<string, unknown>>() {
      return { rows: [{ attempt_count: 2 } as T] };
    },
  };

  assert.equal(await new SignalStore(db).liveSubmittedAttemptBlockReason(candidate, 1_799_999_999_000, 3), null);
});

test("live reconciliation blocks unresolved partial fills but ignores operator-resolved incidents", async () => {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);

  const unresolvedDb: Queryable = {
    async query<T = Record<string, unknown>>(): Promise<{ rows: T[] }> {
      return {
        rows: [
          {
            id: 14741,
            action: "failed",
            partial_fill: true,
            kalshi_status: "no_order",
            polymarket_status: "filled",
            kalshi_fill_count: 0,
            polymarket_fill_count: 5,
            venue_confirmations: null,
            reconciliation_resolved_at: null,
          } as T,
        ],
      };
    },
  };
  const unresolved = await new SignalStore(unresolvedDb).liveReconciliationBlockReason(candidate, 1_799_999_999_000);
  assert.match(unresolved ?? "", /signal #14741 is marked partial_fill/);

  const resolvedDb: Queryable = {
    async query<T = Record<string, unknown>>(): Promise<{ rows: T[] }> {
      return {
        rows: [
          {
            id: 14741,
            action: "failed",
            partial_fill: true,
            kalshi_status: "no_order",
            polymarket_status: "filled",
            kalshi_fill_count: 0,
            polymarket_fill_count: 5,
            venue_confirmations: null,
            reconciliation_resolved_at: "2026-05-11T03:10:00.000Z",
          } as T,
        ],
      };
    },
  };
  assert.equal(await new SignalStore(resolvedDb).liveReconciliationBlockReason(candidate, 1_799_999_999_000), null);
});

test("live reconciliation ignores quarantined partials under cap but blocks over cap", async () => {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);

  const db: Queryable = {
    async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
      if (/SUM\(risk_quarantine_exposure_dollars\)/.test(sql)) return { rows: [{ total: 4.2, count: 1 } as T] };
      return { rows: [] };
    },
  };
  const store = new SignalStore(db);
  assert.equal(await store.liveReconciliationBlockReason(candidate, 1_799_999_999_000, 10), null);
  assert.match(
    (await store.liveReconciliationBlockReason(candidate, 1_799_999_999_000, 3)) ?? "",
    /quarantined exposure 4.20 exceeds cap 3.00/,
  );
  assert.equal(await store.liveExposureBlockReason(candidate, 1_799_999_999_000, 1, 10), null);
  assert.match(
    (await store.liveExposureBlockReason(candidate, 1_799_999_999_000, 1, 3)) ?? "",
    /quarantined exposure 4.20 exceeds cap 3.00/,
  );
});

test("live reconciliation keeps unknown venue statuses blocking until resolved", async () => {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);

  const db: Queryable = {
    async query<T = Record<string, unknown>>(): Promise<{ rows: T[] }> {
      return {
        rows: [
          {
            id: 14742,
            action: "failed",
            partial_fill: false,
            kalshi_status: "unknown",
            polymarket_status: "filled",
            kalshi_fill_count: 0,
            polymarket_fill_count: 0,
            venue_confirmations: null,
            reconciliation_resolved_at: null,
          } as T,
        ],
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
