import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLeadLagCalibrationReport, type LeadLagCalibrationRow } from "../src/signals/lead-lag-calibration";
import type { LeadLagSnapshot, SignalAction, Venue } from "../src/types";

const startedAt = Date.UTC(2026, 4, 20, 12, 0, 0);

function snapshot(input: {
  confidence: number;
  adverse: number;
  stale: number;
  leader: LeadLagSnapshot["leaderVenue"];
  lagging: Venue | null;
  cheapLegIsLagging: boolean | null;
}): LeadLagSnapshot {
  return {
    version: "heuristic-v1",
    scoredAt: startedAt,
    shadowMode: true,
    gateEnabled: false,
    gatePassed: true,
    blockReason: null,
    leaderVenue: input.leader,
    laggingVenue: input.lagging,
    lagMsEstimate: input.leader === "none" ? null : 120,
    confidence: input.confidence,
    stalenessScore: input.stale,
    adverseSelectionScore: input.adverse,
    cheapLegVenue: input.cheapLegIsLagging == null ? null : input.cheapLegIsLagging ? input.lagging : "polymarket",
    cheapLegIsLagging: input.cheapLegIsLagging,
    windows: [],
    reasons: input.leader === "polymarket"
      ? ["Polymarket appears to lead recent book movement"]
      : input.leader === "kalshi"
        ? ["Polymarket leg looks stale/lagging"]
        : ["Book history is thin"],
  };
}

function row(input: {
  id: number;
  action?: SignalAction;
  partial?: boolean;
  status?: string;
  realized?: number | null;
  leadLagSnapshot: LeadLagSnapshot;
}): LeadLagCalibrationRow {
  const action = input.action ?? "filled";
  const partial = input.partial ?? false;
  const status = input.status ?? "filled";
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
    kalshiFillCount: exact || partial ? 8 : 0,
    polymarketFillCount: exact ? 8 : partial ? 6 : 0,
    executionGroupId: `group-${input.id}`,
    leadLagSnapshot: input.leadLagSnapshot,
    realizedGuaranteedProfit: input.realized ?? (exact ? 0.05 : -0.14),
  };
}

test("lead-lag calibration buckets adverse Polymarket-leading attempts and passes promotion when gate removes bad tails", () => {
  const rows: LeadLagCalibrationRow[] = [];
  for (let index = 0; index < 100; index += 1) {
    rows.push(row({
      id: index + 1,
      action: index < 60 ? "filled" : "failed",
      status: index < 60 ? "filled" : "failed",
      realized: index < 60 ? 0.05 : -0.05,
      leadLagSnapshot: index < 60
        ? snapshot({ confidence: 0.7, adverse: 0.2, stale: 0.8, leader: "kalshi", lagging: "polymarket", cheapLegIsLagging: true })
        : snapshot({ confidence: 0.25, adverse: 0.3, stale: 0.1, leader: "none", lagging: null, cheapLegIsLagging: null }),
    }));
  }
  for (let index = 0; index < 100; index += 1) {
    const partial = index >= 10 && index < 40;
    const timeout = index >= 70;
    rows.push(row({
      id: index + 101,
      action: index < 10 || partial ? "filled" : "failed",
      partial,
      status: index < 10 || partial ? "filled" : timeout ? "timeout" : "failed",
      realized: index < 10 ? 0.04 : -0.2,
      leadLagSnapshot: snapshot({ confidence: 0.86, adverse: 0.86, stale: 0.05, leader: "polymarket", lagging: "kalshi", cheapLegIsLagging: false }),
    }));
  }

  const report = buildLeadLagCalibrationReport(rows, undefined, new Date(startedAt));

  assert.equal(report.summary.sampleCount, 200);
  assert.equal(report.summary.exactPairedFills, 70);
  assert.equal(report.leaderVenueBuckets.some((bucket) => bucket.label === "polymarket" && bucket.count === 100), true);
  assert.equal(report.cheapLegLaggingBuckets.some((bucket) => bucket.label === "true"), true);
  assert.equal(report.simulatedGateBuckets.find((bucket) => bucket.label === "blocked")?.count, 100);
  assert.equal(report.gateSimulation.blockedBadAttempts, 90);
  assert.equal(report.gateSimulation.blockedProfitableExactFills, 10);
  assert.ok((report.gateSimulation.badAttemptReductionRate ?? 0) >= 0.15);
  assert.ok((report.gateSimulation.profitableFillEliminationRate ?? 1) < 0.5);
  assert.equal(report.directionality.passed, true);
  assert.equal(report.promotion.passed, true);
});

test("lead-lag calibration blocks promotion on insufficient samples and weak adverse directionality", () => {
  const rows = Array.from({ length: 20 }, (_, index) => row({
    id: index + 1,
    action: "filled",
    realized: 0.03,
    leadLagSnapshot: snapshot({
      confidence: index % 2 === 0 ? 0.8 : 0.2,
      adverse: index % 2 === 0 ? 0.8 : 0.2,
      stale: 0.2,
      leader: index % 2 === 0 ? "polymarket" : "none",
      lagging: index % 2 === 0 ? "kalshi" : null,
      cheapLegIsLagging: index % 2 === 0 ? false : null,
    }),
  }));

  const report = buildLeadLagCalibrationReport(rows, { minSamples: 200 }, new Date(startedAt));

  assert.equal(report.promotion.passed, false);
  assert.match(report.promotion.reasons.join(" | "), /need at least 200 submitted scored attempts/);
  assert.match(report.promotion.reasons.join(" | "), /not materially worse/);
});

test("lead-lag rollout docs keep scoring shadow-first with explicit promotion criteria", () => {
  const packageJson = readFileSync("package.json", "utf8");
  const runbook = readFileSync("RUNBOOK.md", "utf8");
  const envExample = readFileSync("deploy/vps/pok-worker.env.example", "utf8");

  assert.match(packageJson, /lead-lag:calibrate/);
  assert.match(envExample, /LIVE_LEAD_LAG_SCORING_ENABLED=true/);
  assert.match(envExample, /LIVE_LEAD_LAG_GATE_ENABLED=false/);
  assert.match(runbook, /npm run lead-lag:calibrate/);
  assert.match(runbook, /200 submitted scored attempts/);
  assert.match(runbook, /LIVE_LEAD_LAG_GATE_ENABLED=true/);
});
