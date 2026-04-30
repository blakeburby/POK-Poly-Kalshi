import test from "node:test";
import assert from "node:assert/strict";
import { buildDeadZoneCandidate, buildGuaranteedCandidate } from "../src/scanner/payoff";
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
});

test("flipped NO-lower plus YES-higher is classified as dead-zone and non-executable", () => {
  const poly = contract({ venue: "polymarket", contractId: "poly", strike: 1500, noAsk: 0.4 });
  const kalshi = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, yesAsk: 0.5 });
  const candidate = buildDeadZoneCandidate(poly, kalshi, 0.05);
  assert.ok(candidate);
  assert.equal(candidate.executable, false);
  assert.equal(candidate.reason, "dead_zone_configuration");
  assert.equal(candidate.guaranteedProfit, -0.9);
});

