import test from "node:test";
import assert from "node:assert/strict";
import { enumerateExecutableCandidates } from "../src/scanner/pairing";
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
    kalshi: [
      contract({ venue: "kalshi", contractId: "kalshi-low", strike: 1500, yesAsk: 0.4, expiryMs: expiry }),
    ],
    threshold: 0.05,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].lower.contractId, "kalshi-low");
  assert.equal(candidates[0].higher.contractId, "poly-high");
});

