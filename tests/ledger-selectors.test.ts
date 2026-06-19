import test from "node:test";
import assert from "node:assert/strict";
import { ledgerRow } from "../app/lib/selectors";
import { trimSnapshot } from "../app/lib/trim-snapshot";
import type { DashboardSignal, DashboardSnapshot } from "../src/types";

function sig(over: Partial<DashboardSignal>): DashboardSignal {
  return {
    id: 1,
    createdAt: new Date(1_800_000_000_000).toISOString(),
    updatedAt: new Date(1_800_000_002_000).toISOString(),
    pairKey: "pair",
    expiryMs: 1_800_000_900_000,
    kalshiContractId: "k", polymarketContractId: "p",
    lower: { venue: "polymarket", contractId: "p", direction: "yes", strike: 1500, ask: 0.4 },
    higher: { venue: "kalshi", contractId: "k", direction: "no", strike: 1502, ask: 0.5 },
    action: "filled",
    partialFill: false,
    failureReason: null,
    premium: 0.95,
    threshold: 0.01,
    guaranteedProfit: 0.05,
    overlapProfit: 0.05,
    realizedGuaranteedProfit: 0.04,
    kalshiFillId: "kf", polymarketFillId: "pf",
    kalshiFillPrice: 0.5, kalshiStatus: "filled", kalshiFillCount: 5,
    polymarketFillPrice: 0.45, polymarketStatus: "filled", polymarketFillCount: 5,
    ...over,
  } as DashboardSignal;
}

test("W2 fix: ledgerRow realizedDollars uses the trade's actual paired fill size, not the static config size", () => {
  // Config order size 5, but this trade dynamically sized + filled 20/20 -> realized $ = 0.04 * 20 = 0.80.
  const scaled = ledgerRow(sig({ kalshiFillCount: 20, polymarketFillCount: 20, realizedGuaranteedProfit: 0.04 }), 5);
  assert.equal(scaled.fillSize, 20);
  assert.ok(Math.abs((scaled.realizedDollars ?? 0) - 0.8) < 1e-9, `expected 0.80 got ${scaled.realizedDollars}`);

  // A legacy size-5 trade is unchanged (0.04 * 5 = 0.20).
  const legacy = ledgerRow(sig({ kalshiFillCount: 5, polymarketFillCount: 5, realizedGuaranteedProfit: 0.04 }), 5);
  assert.equal(legacy.fillSize, 5);
  assert.ok(Math.abs((legacy.realizedDollars ?? 0) - 0.2) < 1e-9);

  // Paired size = min of the two legs (Kalshi floor-hedged 20 vs Polymarket 20.16 overfill -> 20).
  const overfill = ledgerRow(sig({ kalshiFillCount: 20, polymarketFillCount: 20.16, realizedGuaranteedProfit: 0.03 }), 5);
  assert.equal(overfill.fillSize, 20);

  // No fill counts -> fall back to the config size (realized is usually null anyway -> realizedDollars null).
  const noFill = ledgerRow(sig({ kalshiFillCount: null, polymarketFillCount: null, realizedGuaranteedProfit: null }), 5);
  assert.equal(noFill.fillSize, 5);
  assert.equal(noFill.realizedDollars, null);
});

test("latency: trim-snapshot keeps only UI-read scalars (executionTimings/features) + empties leadLag windows", () => {
  const s = sig({
    executionTimings: {
      totalMs: 100, kalshiRttMs: 20, polymarketRttMs: 30, polymarketConfirmationMs: 40, venueSubmitSkewMs: 5,
      candidateToSubmitMs: 9, hotGateMs: 1, polymarketSignMs: 7, polymarketPostOrderMs: 8, // unused instrumentation
    } as DashboardSignal["executionTimings"],
    fillQualitySnapshot: {
      pairedFillProbability: 0.9, expectedExecutableEdge: 0.02,
      pairedFillConfidence: { lower: 0.8, upper: 1 },
      features: { kalshiRttP50Ms: 10, kalshiRttP95Ms: 20, junkA: 1, junkB: 2, junkC: 3 },
    } as unknown as DashboardSignal["fillQualitySnapshot"],
    leadLagSnapshot: { leaderVenue: "kalshi", adverseSelectionScore: 0.3, windows: [{ ms: 1 }, { ms: 2 }] } as unknown as DashboardSignal["leadLagSnapshot"],
  });
  const trimmed = trimSnapshot({ recentSignals: [s] } as unknown as DashboardSnapshot);
  const t = trimmed.recentSignals![0];

  assert.deepEqual(Object.keys(t.executionTimings!).sort(),
    ["kalshiRttMs", "polymarketConfirmationMs", "polymarketRttMs", "totalMs", "venueSubmitSkewMs"]);
  assert.deepEqual(Object.keys(t.fillQualitySnapshot!.features as Record<string, unknown>).sort(),
    ["kalshiRttP50Ms", "kalshiRttP95Ms"]);
  // scalars the views read are preserved; the big sub-objects are dropped
  assert.equal(t.fillQualitySnapshot!.pairedFillProbability, 0.9);
  assert.equal((t.fillQualitySnapshot as Record<string, unknown>).pairedFillConfidence, undefined);
  assert.equal(t.leadLagSnapshot!.leaderVenue, "kalshi");
  assert.equal(t.leadLagSnapshot!.windows.length, 0);
});
