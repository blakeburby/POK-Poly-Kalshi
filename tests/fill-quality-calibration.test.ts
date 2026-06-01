import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFillQualityCalibrationReport, type FillQualityCalibrationRow } from "../src/execution/fill-quality-calibration";
import type { FillQualitySnapshot, SignalAction } from "../src/types";

const startedAt = Date.UTC(2026, 4, 20, 12, 0, 0);

function snapshot(pairedFillProbability: number, expectedExecutableEdge: number, orderSize = 8): FillQualitySnapshot {
  return {
    version: "heuristic-v1",
    scoredAt: startedAt,
    shadowMode: true,
    gateEnabled: false,
    gatePassed: true,
    blockReason: null,
    projectedEdgeAtLimit: 0.04,
    expectedExecutableEdge,
    minExpectedEdge: 0.01,
    pairedFillProbability,
    kalshiExactFillProbability: 0.9,
    polymarketExactFillProbability: pairedFillProbability / 0.9,
    expectedSlippage: 0.001,
    expectedMismatchCost: 0.002,
    timeoutCost: 0.003,
    penaltyReasons: [],
    features: {
      sampleCount: 40,
      minSamples: 30,
      coldStart: false,
      orderSize,
      placementMode: "polymarket_first_exact",
      kalshiDepth: 20,
      polymarketDepth: 20,
      kalshiDepthRatio: 2,
      polymarketDepthRatio: 2,
      kalshiSpread: 0.02,
      polymarketSpread: 0.02,
      kalshiQuoteAgeMs: 50,
      polymarketQuoteAgeMs: 50,
      quoteSkewMs: 20,
      secondsToExpiry: 600,
      sameExpiryAttemptCount: 1,
      recentExactPairFillRate: 0.45,
      recentMismatchRate: 0.3,
      recentTimeoutRate: 0.1,
      kalshiRecentExactFillRate: 0.9,
      polymarketRecentExactFillRate: 0.6,
      kalshiRttP50Ms: 100,
      kalshiRttP95Ms: 250,
      polymarketRttP50Ms: 900,
      polymarketRttP95Ms: 1800,
      kalshiConfirmationP95Ms: 200,
      polymarketConfirmationP95Ms: 1900,
      polymarketSignedOrderReuseRate: 0.8,
      polymarketSignedOrderFallbackRate: 0.05,
      recentVenueEventCount: 10,
    },
  };
}

function row(input: {
  id: number;
  probability: number;
  xev: number;
  action?: SignalAction;
  partial?: boolean;
  realized?: number | null;
  status?: string;
  orderSize?: number;
}): FillQualityCalibrationRow {
  const action = input.action ?? "filled";
  const partial = input.partial ?? false;
  const status = input.status ?? "filled";
  const orderSize = input.orderSize ?? 8;
  const exact = action === "filled" && !partial && status === "filled";
  return {
    id: input.id,
    createdAt: new Date(startedAt + input.id * 1000).toISOString(),
    updatedAt: new Date(startedAt + input.id * 1000 + 500).toISOString(),
    action,
    partialFill: partial,
    kalshiStatus: status,
    polymarketStatus: status,
    kalshiError: null,
    polymarketError: status === "timeout" ? "timed out" : null,
    kalshiFillCount: exact ? orderSize : partial ? orderSize : 0,
    polymarketFillCount: exact ? orderSize : partial ? orderSize - 2 : 0,
    executionGroupId: `group-${input.id}`,
    fillQualitySnapshot: snapshot(input.probability, input.xev, orderSize),
    expectedExecutableEdge: input.xev,
    realizedGuaranteedProfit: input.realized ?? (exact ? 0.04 : -0.12),
  };
}

test("fill-quality calibration buckets predictions and passes promotion when shadow gate removes bad attempts", () => {
  const rows: FillQualityCalibrationRow[] = [];
  for (let index = 0; index < 100; index += 1) {
    rows.push(row({
      id: index + 1,
      probability: 0.22,
      xev: index < 10 ? 0.02 : index < 90 ? 0.004 : 0.02,
      action: index < 10 ? "filled" : "failed",
      realized: index < 10 ? 0.03 : -0.15,
      status: index < 10 ? "filled" : "failed",
    }));
  }
  for (let index = 0; index < 100; index += 1) {
    rows.push(row({
      id: index + 101,
      probability: 0.82,
      xev: 0.025,
      action: index < 60 ? "filled" : "failed",
      realized: index < 60 ? 0.04 : -0.08,
      status: index < 60 ? "filled" : "failed",
    }));
  }

  const report = buildFillQualityCalibrationReport(rows, undefined, new Date(startedAt));

  assert.equal(report.summary.sampleCount, 200);
  assert.equal(report.summary.exactPairedFills, 70);
  assert.equal(report.pairedFillProbabilityBuckets.length, 2);
  assert.equal(report.pairedFillProbabilityBuckets[0].exactPairFillRate, 0.1);
  assert.equal(report.pairedFillProbabilityBuckets[1].exactPairFillRate, 0.6);
  assert.equal(report.gateSimulation.blockedBadAttempts, 80);
  assert.equal(report.gateSimulation.blockedProfitableExactFills, 0);
  assert.ok((report.gateSimulation.badAttemptReductionRate ?? 0) >= 0.25);
  assert.equal(report.directionality.passed, true);
  assert.equal(report.promotion.passed, true);
});

test("fill-quality calibration blocks promotion on insufficient samples and weak directionality", () => {
  const rows = Array.from({ length: 20 }, (_, index) => row({
    id: index + 1,
    probability: index % 2 === 0 ? 0.8 : 0.2,
    xev: 0.02,
    action: "filled",
    realized: 0.02,
  }));

  const report = buildFillQualityCalibrationReport(rows, { minSamples: 200 }, new Date(startedAt));

  assert.equal(report.promotion.passed, false);
  assert.match(report.promotion.reasons.join(" | "), /need at least 200 submitted scored attempts/);
  assert.match(report.promotion.reasons.join(" | "), /not directionally valid/);
});

test("fill-quality rollout docs keep scoring shadow-first with explicit promotion criteria", () => {
  const runbook = readFileSync("RUNBOOK.md", "utf8");
  const envExample = readFileSync("deploy/vps/pok-worker.env.example", "utf8");

  assert.match(envExample, /LIVE_FILL_QUALITY_SCORING_ENABLED=true/);
  assert.match(envExample, /LIVE_FILL_QUALITY_GATE_ENABLED=false/);
  assert.match(runbook, /npm run fill-quality:calibrate/);
  assert.match(runbook, /200 submitted scored attempts/);
  assert.match(runbook, /LIVE_FILL_QUALITY_GATE_ENABLED=true/);
});
