import test from "node:test";
import assert from "node:assert/strict";
import type { ArbCandidate } from "../src/types";
import { buildDeadZoneCandidate, buildGuaranteedCandidate } from "../src/scanner/payoff";
import { isProtectedExecutableCandidate, protectedCandidateBlockReason } from "../src/scanner/safety";
import { contract } from "./helpers";

function protectedCandidate(): ArbCandidate {
  const candidate = buildGuaranteedCandidate(
    contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 }),
    contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 }),
    0.05,
  );
  assert.ok(candidate);
  return candidate;
}

test("protected trading guard allows only long up below plus long down above", () => {
  const candidate = protectedCandidate();
  assert.equal(isProtectedExecutableCandidate(candidate, 0.05), true);
  assert.equal(protectedCandidateBlockReason(candidate, 0.05), null);

  const deadZone = buildDeadZoneCandidate(
    contract({ venue: "polymarket", contractId: "poly-dead", strike: 1500, noAsk: 0.4 }),
    contract({ venue: "kalshi", contractId: "kalshi-dead", strike: 1502, yesAsk: 0.5 }),
    0.05,
  );
  assert.ok(deadZone);
  assert.equal(isProtectedExecutableCandidate(deadZone, 0.05), false);
  assert.equal(protectedCandidateBlockReason(deadZone, 0.05), "non_protected_structure");
});

test("protected trading guard rejects malformed or below-threshold candidates", () => {
  const candidate = protectedCandidate();

  assert.equal(protectedCandidateBlockReason({ ...candidate, risk: undefined }, 0.05), "non_protected_structure");
  assert.equal(
    protectedCandidateBlockReason({ ...candidate, lower: { ...candidate.lower, direction: "no" } }, 0.05),
    "lower_leg_not_yes",
  );
  assert.equal(
    protectedCandidateBlockReason({ ...candidate, higher: { ...candidate.higher, direction: "yes" } }, 0.05),
    "higher_leg_not_no",
  );
  assert.equal(
    protectedCandidateBlockReason(
      { ...candidate, higher: { ...candidate.higher, strike: candidate.lower.strike } },
      0.05,
    ),
    "lower_strike_not_below_higher",
  );
  assert.equal(protectedCandidateBlockReason({ ...candidate, executable: false }, 0.05), "candidate_not_executable");
  assert.equal(
    protectedCandidateBlockReason({ ...candidate, guaranteedProfit: 0.0499 }, 0.05),
    "guaranteed_profit_below_threshold",
  );
});
