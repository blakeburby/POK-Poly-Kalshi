import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { isValidDashboardSession, verifyDashboardPassword } from "../app/lib/dashboard-session";
import { isContractStale, sortCandidatesForBlotter } from "../app/lib/dashboard-view-model";
import { buildDashboardAnalytics } from "../src/analytics/performance";
import { buildSyntheticStructureRisk } from "../src/scanner/payoff";
import type { ArbCandidate, ArbLeg, BinaryContract, DashboardSignal, DashboardSnapshot } from "../src/types";

// The dashboard UI was rebuilt (app/components/DashboardApp.tsx). These tests cover
// the still-present pure functions the old UI test exercised — analytics, payoff/risk
// classification, session auth, and book/view-model helpers.

const generatedAt = 1_800_000_010_000;

const leg = (over: Partial<ArbLeg> & Pick<ArbLeg, "venue" | "direction" | "strike" | "ask">): ArbLeg => ({
  contractId: `${over.venue}-${over.strike}`,
  ...over,
});

function candidate(pairKey = "pair-live", guaranteedProfit = 0.1): ArbCandidate {
  const lower = leg({ venue: "polymarket", contractId: `${pairKey}-poly`, direction: "yes", strike: 1500, ask: 0.4 });
  const higher = leg({ venue: "kalshi", contractId: `${pairKey}-kalshi`, direction: "no", strike: 1502, ask: 0.5 });
  return {
    pairKey,
    expiryMs: generatedAt + 900_000,
    lower,
    higher,
    kalshiContractId: `${pairKey}-kalshi`,
    polymarketContractId: `${pairKey}-poly`,
    premium: 1 - guaranteedProfit,
    guaranteedProfit,
    overlapProfit: 1 + guaranteedProfit,
    threshold: 0.05,
    executable: true,
    reason: null,
    risk: buildSyntheticStructureRisk(lower, higher, 0.05),
  };
}

function signal(input: Partial<DashboardSignal> = {}): DashboardSignal {
  const lower = leg({ venue: "polymarket", contractId: "pair-live-poly", direction: "yes", strike: 1500, ask: 0.4 });
  const higher = leg({ venue: "kalshi", contractId: "pair-live-kalshi", direction: "no", strike: 1502, ask: 0.5 });
  return {
    id: 42,
    createdAt: new Date(generatedAt - 1_500).toISOString(),
    updatedAt: new Date(generatedAt - 500).toISOString(),
    pairKey: "pair-live",
    expiryMs: generatedAt + 900_000,
    kalshiContractId: "pair-live-kalshi",
    polymarketContractId: "pair-live-poly",
    lower,
    higher,
    premium: 0.9,
    guaranteedProfit: 0.1,
    overlapProfit: 1.1,
    threshold: 0.05,
    action: "filled",
    failureReason: null,
    kalshiFillId: "real-kalshi-order",
    polymarketFillId: "real-poly-order",
    kalshiFillPrice: 0.51,
    polymarketFillPrice: 0.41,
    executionGroupId: "group-live",
    executionStrategy: "parallel_fok",
    kalshiFillCount: 5,
    polymarketFillCount: 5,
    partialFill: false,
    risk: buildSyntheticStructureRisk(lower, higher, 0.05),
    ...input,
  };
}

function staleSnapshot(staleBookMs = 10_000): DashboardSnapshot {
  return { generatedAt, health: { staleBookMs } } as unknown as DashboardSnapshot;
}

function contract(updatedAt: number): BinaryContract {
  return {
    venue: "kalshi",
    contractId: "pair-live-kalshi",
    asset: "BTC",
    expiryMs: generatedAt + 900_000,
    strike: 1502,
    yesAsk: 0.4,
    noAsk: 0.5,
    yesBid: 0.39,
    noBid: 0.49,
    updatedAt,
  };
}

test("password session helpers validate configured credentials", () => {
  const previousPassword = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = "secret";
  try {
    assert.equal(verifyDashboardPassword("secret"), true);
    assert.equal(verifyDashboardPassword("wrong"), false);
    const issuedAt = String(generatedAt);
    const signature = createHmac("sha256", "secret").update(issuedAt).digest("base64url");
    assert.equal(isValidDashboardSession(`${issuedAt}.${signature}`, generatedAt + 1_000), true);
    assert.equal(isValidDashboardSession(`${issuedAt}.bad`, generatedAt + 1_000), false);
  } finally {
    if (previousPassword == null) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = previousPassword;
  }
});

test("protected spread risk classification and guaranteed edge", () => {
  const lower = leg({ venue: "polymarket", contractId: "p", direction: "yes", strike: 1500, ask: 0.4 });
  const higher = leg({ venue: "kalshi", contractId: "k", direction: "no", strike: 1502, ask: 0.5 });
  const risk = buildSyntheticStructureRisk(lower, higher, 0.05);
  assert.equal(risk.premium, 0.9);
  assert.equal(risk.classification, "true_arbitrage");
  assert.equal(risk.worstCaseProfit, 0.1); // 1 - premium, guaranteed everywhere
  assert.equal(risk.bestCaseProfit, 1.1); // overlap region pays 2
  assert.equal(risk.guaranteedEdge, 0.1);
  assert.equal(risk.payoffProfile.length, 3);

  // Below threshold but still non-negative -> guaranteed_below_threshold.
  const thin = buildSyntheticStructureRisk(
    leg({ venue: "polymarket", contractId: "p", direction: "yes", strike: 1500, ask: 0.48 }),
    leg({ venue: "kalshi", contractId: "k", direction: "no", strike: 1502, ask: 0.5 }),
    0.05,
  );
  assert.equal(thin.classification, "guaranteed_below_threshold");
});

test("performance analytics count only exact paired live fills", () => {
  const signals = [
    signal({
      id: 1,
      executionGroupId: "real-group-1",
      kalshiFillId: "real-kalshi-1",
      polymarketFillId: "real-poly-1",
      kalshiFillCount: 5,
      polymarketFillCount: 5,
    }),
    signal({
      id: 2,
      action: "failed",
      executionGroupId: "real-failed",
      kalshiFillId: null,
      polymarketFillId: null,
      kalshiFillCount: 0,
      polymarketFillCount: 0,
    }),
    signal({
      id: 3,
      executionGroupId: "legacy-dry-run",
      kalshiFillId: "dry-run-kalshi-3",
      polymarketFillId: "dry-run-poly-3",
      kalshiFillCount: 5,
      polymarketFillCount: 5,
      kalshiFillPrice: 0.1,
      polymarketFillPrice: 0.1,
    }),
    signal({
      id: 4,
      executionGroupId: "mismatch",
      kalshiFillId: "real-kalshi-4",
      polymarketFillId: "real-poly-4",
      kalshiFillCount: 5,
      polymarketFillCount: 0,
      partialFill: true,
    }),
  ];
  const analytics = buildDashboardAnalytics(signals, generatedAt);
  // Only the exact paired live fill (id 1) is counted; dry-run + partial + failed excluded.
  assert.equal(analytics.daily.filledTrades, 1);
  assert.equal(analytics.daily.tradesWon, 1);
  assert.ok(analytics.daily.netPnl > 0);
});

test("dashboard view-model helpers normalize books and rank candidates", () => {
  const base = staleSnapshot(10_000);
  assert.equal(isContractStale(contract(generatedAt - 20_000), base), true);
  assert.equal(isContractStale(contract(generatedAt - 500), base), false);
  const ranked = sortCandidatesForBlotter([candidate("later", 0.06), candidate("best", 0.12)]);
  assert.equal(ranked[0].pairKey, "best");
});
