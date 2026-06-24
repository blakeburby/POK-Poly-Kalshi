import test from "node:test";
import assert from "node:assert/strict";
import {
  enumerateCandidates,
  enumerateExecutableCandidates,
  enumerateSyntheticStructures,
} from "../src/scanner/pairing";
import { contract } from "./helpers";

test("premium at 0.95 passes the five-cent boundary", () => {
  const candidates = enumerateExecutableCandidates({
    polymarket: [contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.45 })],
    kalshi: [contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 })],
    threshold: 0.05,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].guaranteedProfit, 0.05);
});

test("premium above 0.95 fails the five-cent boundary", () => {
  const candidates = enumerateExecutableCandidates({
    polymarket: [contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.46 })],
    kalshi: [contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 })],
    threshold: 0.05,
  });
  assert.equal(candidates.length, 0);
});

test("pairing requires same expiry and is venue-order independent", () => {
  const expiry = 1_800_000_000_000;
  const later = expiry + 15 * 60_000;
  const candidates = enumerateExecutableCandidates({
    polymarket: [
      contract({ venue: "polymarket", contractId: "poly-high", strike: 1502, noAsk: 0.5, expiryMs: expiry }),
      contract({ venue: "polymarket", contractId: "poly-later", strike: 1500, yesAsk: 0.4, expiryMs: later }),
    ],
    kalshi: [contract({ venue: "kalshi", contractId: "kalshi-low", strike: 1500, yesAsk: 0.4, expiryMs: expiry })],
    threshold: 0.05,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].lower.contractId, "kalshi-low");
  assert.equal(candidates[0].higher.contractId, "poly-high");
});

test("pairing exposes both synthetic structures while preserving executable-only output", () => {
  const polymarket = [contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, noAsk: 0.4 })];
  const kalshi = [contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, yesAsk: 0.5, noAsk: 0.5 })];

  const paired = enumerateCandidates(polymarket, kalshi, 0.05);
  assert.equal(paired.executable.length, 1);
  assert.equal(paired.rejected.length, 1);
  assert.equal(paired.executable[0].risk?.structureType, "long_up_below_down_above");
  assert.equal(paired.rejected[0].risk?.structureType, "long_up_above_down_below");
  assert.equal(paired.rejected[0].risk?.classification, "probabilistic_bet");

  const synthetic = enumerateSyntheticStructures(polymarket, kalshi, 0.05);
  assert.equal(synthetic.length, 2);
  assert.equal(enumerateExecutableCandidates({ polymarket, kalshi, threshold: 0.05 }).length, 1);
});
