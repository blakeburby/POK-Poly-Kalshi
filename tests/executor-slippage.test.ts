import test from "node:test";
import assert from "node:assert/strict";
import { DryRunExecutor, DryRunSlippageModel, type DryRunSlippageOptions } from "../src/execution/executor";
import { buildDeadZoneCandidate, buildGuaranteedCandidate } from "../src/scanner/payoff";
import { contract } from "./helpers";

function options(input: Partial<DryRunSlippageOptions> = {}): DryRunSlippageOptions {
  return {
    enabled: true,
    kalshiSlippageCents: 1,
    polymarketSlippageCents: 2,
    maxSlippageCents: 3,
    jitterCents: 1,
    ...input,
  };
}

test("dry-run slippage worsens buy fills with venue-specific base and deterministic jitter", () => {
  const model = new DryRunSlippageModel(options(), () => 0.5);

  assert.equal(model.fillPrice({
    venue: "kalshi",
    contractId: "kalshi",
    direction: "no",
    strike: 1502,
    ask: 0.5,
  }), 0.515);
  assert.equal(model.fillPrice({
    venue: "polymarket",
    contractId: "poly",
    direction: "yes",
    strike: 1500,
    ask: 0.4,
  }), 0.425);
});

test("dry-run slippage can be disabled and caps fills at binary payout value", () => {
  const disabled = new DryRunSlippageModel(options({ enabled: false }), () => 1);
  assert.equal(disabled.fillPrice({
    venue: "kalshi",
    contractId: "kalshi",
    direction: "yes",
    strike: 1502,
    ask: 0.54321,
  }), 0.5432);

  const capped = new DryRunSlippageModel(options({ kalshiSlippageCents: 10, maxSlippageCents: 3, jitterCents: 10 }), () => 1);
  assert.equal(capped.fillPrice({
    venue: "kalshi",
    contractId: "kalshi",
    direction: "yes",
    strike: 1502,
    ask: 0.99,
  }), 1);
});

test("dry-run executor persists simulated fill prices without changing action or fill ids", async () => {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4 });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5 });
  const candidate = buildGuaranteedCandidate(lower, higher, 0.05);
  assert.ok(candidate);

  const executor = new DryRunExecutor(new DryRunSlippageModel(options({ jitterCents: 0 }), () => 0), 0.05);
  const result = await executor.execute(candidate);

  assert.equal(result.action, "filled");
  assert.equal(result.failureReason, null);
  assert.match(result.kalshiFillId ?? "", /^dry-run-kalshi-/);
  assert.match(result.polymarketFillId ?? "", /^dry-run-polymarket-/);
  assert.equal(result.kalshiFillPrice, 0.51);
  assert.equal(result.polymarketFillPrice, 0.42);
});

test("dry-run executor refuses flipped dead-zone candidates before simulated fills", async () => {
  const lower = contract({ venue: "polymarket", contractId: "poly", strike: 1500, noAsk: 0.4 });
  const higher = contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, yesAsk: 0.5 });
  const candidate = buildDeadZoneCandidate(lower, higher, 0.05);
  assert.ok(candidate);

  const executor = new DryRunExecutor(new DryRunSlippageModel(options({ jitterCents: 0 }), () => 0), 0.05);
  const result = await executor.execute(candidate);

  assert.equal(result.action, "failed");
  assert.match(result.failureReason ?? "", /protected-spread-only guard: non_protected_structure/);
  assert.equal(result.kalshiFillId, null);
  assert.equal(result.polymarketFillId, null);
  assert.equal(result.kalshiFillPrice, null);
  assert.equal(result.polymarketFillPrice, null);
});
