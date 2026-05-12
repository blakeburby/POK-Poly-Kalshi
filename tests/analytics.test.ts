import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalyticsWindow, buildDashboardAnalytics, estimatedGuaranteedPnl } from "../src/analytics/performance";
import { AnalyticsStore } from "../src/analytics/store";
import type { DashboardSignal } from "../src/types";

function signal(input: Partial<DashboardSignal> = {}): DashboardSignal {
  return {
    id: 1,
    createdAt: "2026-04-29T20:00:00.000Z",
    updatedAt: "2026-04-29T20:00:00.000Z",
    pairKey: "pair",
    expiryMs: Date.UTC(2026, 3, 29, 20, 15),
    kalshiContractId: "kalshi",
    polymarketContractId: "poly",
    lower: { venue: "polymarket", contractId: "poly", direction: "yes", strike: 1500, ask: 0.4 },
    higher: { venue: "kalshi", contractId: "kalshi", direction: "no", strike: 1502, ask: 0.5 },
    premium: 0.9,
    guaranteedProfit: 0.1,
    overlapProfit: 1.1,
    threshold: 0.05,
    action: "filled",
    failureReason: null,
    kalshiFillId: "kalshi-fill",
    polymarketFillId: "poly-fill",
    kalshiFillPrice: 0.5,
    polymarketFillPrice: 0.4,
    executionGroupId: "live-group",
    kalshiFillCount: 5,
    polymarketFillCount: 5,
    ...input,
  };
}

function at(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

test("analytics estimates guaranteed PnL from fill prices and falls back to premium", () => {
  assert.equal(estimatedGuaranteedPnl(signal({ kalshiFillPrice: 0.51, polymarketFillPrice: 0.41 })), 0.08);
  assert.equal(estimatedGuaranteedPnl(signal({ kalshiFillPrice: null, polymarketFillPrice: null, premium: 0.95 })), 0.05);
  assert.equal(estimatedGuaranteedPnl(signal({ action: "failed" })), null);
  assert.equal(estimatedGuaranteedPnl(signal({ executionGroupId: null })), null);
  assert.equal(estimatedGuaranteedPnl(signal({ kalshiFillId: "dry-run-kalshi-1" })), null);
  assert.equal(estimatedGuaranteedPnl(signal({ kalshiFillCount: 5, polymarketFillCount: 0 })), null);
});

test("analytics computes win loss rates, profit factor, and cumulative buckets", () => {
  const now = Date.UTC(2026, 3, 29, 20, 30);
  const analytics = buildAnalyticsWindow([
    signal({ id: 1, updatedAt: at(now - 30 * 60 * 1000), kalshiFillPrice: 0.51, polymarketFillPrice: 0.4 }),
    signal({ id: 2, updatedAt: at(now - 70 * 60 * 1000), kalshiFillPrice: 0.55, polymarketFillPrice: 0.47 }),
    signal({ id: 3, updatedAt: at(now - 2 * 60 * 60 * 1000), kalshiFillPrice: null, polymarketFillPrice: null, premium: 0.95 }),
    signal({ id: 4, updatedAt: at(now - 3 * 60 * 60 * 1000), kalshiFillPrice: 0.5, polymarketFillPrice: 0.5 }),
    signal({ id: 5, updatedAt: at(now - 30 * 60 * 60 * 1000), kalshiFillPrice: 0.4, polymarketFillPrice: 0.4 }),
  ], "hourly", now);

  assert.equal(analytics.filledTrades, 4);
  assert.equal(analytics.tradesWon, 2);
  assert.equal(analytics.tradesLost, 1);
  assert.equal(analytics.breakevenTrades, 1);
  assert.equal(analytics.winRate, 0.5);
  assert.equal(analytics.lossRate, 0.25);
  assert.equal(analytics.grossProfit, 0.14);
  assert.equal(analytics.grossLoss, -0.02);
  assert.equal(analytics.netPnl, 0.12);
  assert.equal(analytics.profitFactor, 7);
  assert.ok(analytics.sharpeRatio != null && analytics.sharpeRatio > 0);
  assert.equal(analytics.maxDrawdown, 0.02);
  assert.equal(analytics.avgPremium, 0.97);
  assert.equal(analytics.avgSlippage, 0.07);
  assert.equal(analytics.avgFillLatencyMs, 0);
  assert.equal(analytics.opportunityCount, 4);
  assert.equal(analytics.fillRate, 1);
  assert.equal(analytics.pnlDistribution.find((bucket) => bucket.label === "Loss")?.count, 1);
  assert.equal(analytics.slippageDistribution.find((bucket) => bucket.label === "3c+")?.count, 3);
  assert.equal(analytics.buckets.at(-1)?.netPnl, 0.09);
  assert.equal(analytics.buckets.at(-1)?.cumulativePnl, 0.12);
  assert.equal(analytics.buckets.at(-1)?.wins, 1);
  assert.equal(analytics.buckets.at(-1)?.avgPnl, 0.09);
  assert.equal(analytics.heatmap.at(-1)?.tradeCount, 1);
});

test("analytics exposes no-loss profit factor state and insufficient sharpe as null", () => {
  const now = Date.UTC(2026, 3, 29, 20, 30);
  const analytics = buildAnalyticsWindow([
    signal({ updatedAt: at(now - 1_000), kalshiFillPrice: 0.45, polymarketFillPrice: 0.45 }),
  ], "hourly", now);

  assert.equal(analytics.tradesWon, 1);
  assert.equal(analytics.tradesLost, 0);
  assert.equal(analytics.grossProfit, 0.1);
  assert.equal(analytics.grossLoss, 0);
  assert.equal(analytics.profitFactor, null);
  assert.equal(analytics.sharpeRatio, null);
});

test("dashboard analytics returns hourly daily and weekly windows", () => {
  const now = Date.UTC(2026, 3, 29, 20, 30);
  const analytics = buildDashboardAnalytics([signal({ updatedAt: at(now - 1_000) })], now);
  assert.equal(analytics.hourly.window, "hourly");
  assert.equal(analytics.daily.window, "daily");
  assert.equal(analytics.weekly.window, "weekly");
});

test("analytics store serves hot snapshots and matches full calculator", () => {
  const now = Date.UTC(2026, 3, 29, 20, 30);
  const signals = [
    signal({ id: 1, updatedAt: at(now - 1_000), kalshiFillPrice: 0.51, polymarketFillPrice: 0.41 }),
    signal({ id: 2, action: "failed", updatedAt: at(now - 500), kalshiFillPrice: null, polymarketFillPrice: null }),
  ];
  const store = new AnalyticsStore();
  store.reconcileFilledSignals([signals[0]], now - 250);
  store.recordSignal(signals[1], now);

  const hot = store.snapshot(now, { staleAfterMs: 5_000 });
  const full = buildDashboardAnalytics(signals, now);
  assert.equal(hot.hourly.netPnl, full.hourly.netPnl);
  assert.equal(hot.hourly.opportunityCount, 1);
  assert.equal(hot.hourly.fillRate, 1);
  assert.equal(hot.realtime?.mode, "hot_cache");
  assert.equal(hot.realtime?.lastDbReconciledAt, now - 250);
  assert.equal(hot.realtime?.sourceSignalCount, 2);
  assert.equal(hot.realtime?.stale, false);
});
