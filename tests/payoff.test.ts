import test from "node:test";
import assert from "node:assert/strict";
import { buildDeadZoneCandidate, buildGuaranteedCandidate, buildSyntheticStructureRisk } from "../src/scanner/payoff";
import { contract } from "./helpers";

test("YES-lower plus NO-higher is guaranteed when premium is below one dollar", () => {
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 });
  const candidate = buildGuaranteedCandidate(poly, kalshi, 0.05);
  assert.ok(candidate);
  assert.equal(candidate.premium, 0.9);
  assert.equal(candidate.guaranteedProfit, 0.1);
  assert.equal(candidate.overlapProfit, 1.1);
  assert.equal(candidate.executable, true);
  assert.equal(candidate.lower.direction, "yes");
  assert.equal(candidate.higher.direction, "no");
  assert.equal(candidate.risk?.structureType, "long_up_below_down_above");
  assert.equal(candidate.risk?.classification, "true_arbitrage");
  assert.equal(candidate.risk?.strikeGap, 2);
  assert.equal(candidate.risk?.strikeGapPctOfMid, 0.1332);
  assert.equal(candidate.risk?.lossWindowWidth, 0);
  assert.equal(candidate.risk?.lossWindowPctOfStrikeGap, 0);
  assert.equal(candidate.risk?.overlapWindowWidth, 2);
  assert.equal(candidate.risk?.overlapWindowPctOfStrikeGap, 100);
  assert.equal(candidate.risk?.worstCaseProfit, 0.1);
  assert.equal(candidate.risk?.bestCaseProfit, 1.1);
  assert.equal(candidate.risk?.maxLossRegion, null);
  assert.deepEqual(
    candidate.risk?.payoffProfile.map((region) => region.payoff),
    [1, 2, 1],
  );
});

test("flipped NO-lower plus YES-higher is classified as dead-zone and non-executable", () => {
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, noAsk: 0.4 });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, yesAsk: 0.5 });
  const candidate = buildDeadZoneCandidate(poly, kalshi, 0.05);
  assert.ok(candidate);
  assert.equal(candidate.executable, false);
  assert.equal(candidate.reason, "dead_zone_configuration");
  assert.equal(candidate.guaranteedProfit, -0.9);
  assert.equal(candidate.risk?.structureType, "long_up_above_down_below");
  assert.equal(candidate.risk?.classification, "probabilistic_bet");
  assert.equal(candidate.risk?.strikeGap, 2);
  assert.equal(candidate.risk?.lossWindowWidth, 2);
  assert.equal(candidate.risk?.lossWindowPctOfStrikeGap, 100);
  assert.equal(candidate.risk?.lossWindowPctOfMid, 0.1332);
  assert.equal(candidate.risk?.overlapWindowWidth, 0);
  assert.equal(candidate.risk?.worstCaseProfit, -0.9);
  assert.equal(candidate.risk?.bestCaseProfit, 0.1);
  assert.equal(candidate.risk?.guaranteedEdge, null);
  assert.equal(candidate.risk?.conditionalEdge, 0.1);
  assert.equal(candidate.risk?.maxLossRegion?.region, "between_strikes");
  assert.deepEqual(
    candidate.risk?.payoffProfile.map((region) => region.payoff),
    [1, 0, 1],
  );
});

test("risk mapper classifies protected spreads below threshold separately from executable arbs", () => {
  const lower = {
    venue: "polymarket" as const,
    contractId: "poly",
    direction: "yes" as const,
    strike: 1500,
    ask: 0.49,
  };
  const higher = { venue: "kalshi" as const, contractId: "kalshi", direction: "no" as const, strike: 1502, ask: 0.5 };
  const risk = buildSyntheticStructureRisk(lower, higher, 0.05);
  assert.equal(risk.classification, "guaranteed_below_threshold");
  assert.equal(risk.guaranteedEdge, 0.01);
  assert.equal(risk.lossWindowPctOfStrikeGap, 0);
});
