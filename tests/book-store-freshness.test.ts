import test from "node:test";
import assert from "node:assert/strict";
import { BookStore } from "../src/books/book-store";
import type { BinaryContract } from "../src/types";

function k(contractId: string, updatedAt: number): BinaryContract {
  return {
    venue: "kalshi", contractId, asset: "BTC", expiryMs: 1_800_000_900_000, strike: 80_000,
    yesAsk: null, noAsk: null, yesBid: null, noBid: null, updatedAt,
  };
}

test("H2: with freshnessFromWsOnly, a periodic discovery refresh does NOT advance a contract's updatedAt", () => {
  const store = new BookStore(5, true);
  store.setKalshiContracts([k("m1", 1000)]);
  store.setKalshiContracts([k("m1", 5000)]); // later discovery refresh, carries no live quote
  // updatedAt stays at the original (no WS snapshot has arrived), so a dead WS feed correctly ages out.
  assert.equal(store.getKalshiContracts(1e12, 6000)[0]?.updatedAt, 1000);
});

test("H2: default (flag off) a discovery refresh still bumps freshness via Math.max (byte-identical)", () => {
  const store = new BookStore(5, false);
  store.setKalshiContracts([k("m1", 1000)]);
  store.setKalshiContracts([k("m1", 5000)]);
  assert.equal(store.getKalshiContracts(1e12, 6000)[0]?.updatedAt, 5000);
});
