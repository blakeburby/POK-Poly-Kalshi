import test from "node:test";
import assert from "node:assert/strict";
import { NakedPositionFlattener } from "../src/trading/naked-flattener";
import type { NakedResidualRow } from "../src/db/signals";
import type { TradingActivitySnapshot, TradingPlatform } from "../types/trading";

function snapshotWithPolymarketPositions(positions: { id: string; shares: number }[]): TradingActivitySnapshot {
  const venue = (platform: TradingPlatform, pos: { id: string; shares: number }[]) => ({
    platform,
    connectionStatus: "live" as const,
    lastUpdatedAt: 1000,
    portfolio: {
      platform,
      portfolioValue: null,
      cashValue: null,
      dayChangeDollars: null,
      dayChangePercent: null,
      lastUpdatedAt: 1000,
    },
    positions: pos.map((p) => ({
      id: p.id,
      market: "BTC-15m",
      outcome: "Up",
      shares: p.shares,
      value: null,
      averagePrice: null,
      updatedAt: 1000,
    })),
    openOrders: [],
    history: [],
    sparkline: [],
  });
  return { kalshi: venue("kalshi", []), polymarket: venue("polymarket", positions) };
}

class FakeStore {
  residuals: NakedResidualRow[] = [];
  resolved: { id: number; reason: string }[] = [];
  async listUnresolvedNakedResiduals(): Promise<NakedResidualRow[]> {
    return this.residuals;
  }
  async resolveNakedResidual(id: number, reason: string): Promise<void> {
    this.resolved.push({ id, reason });
  }
}

class FakeActivity {
  constructor(public snap: TradingActivitySnapshot) {}
  async getSnapshot(): Promise<TradingActivitySnapshot> {
    return this.snap;
  }
}

class FakeSeller {
  calls: { tokenId: string; shares: number }[] = [];
  constructor(
    private readonly outcome: {
      soldShares: number;
      sellPrice: number | null;
      orderId: string | null;
      status: string;
      error: string | null;
    },
  ) {}
  async marketSellShares(tokenId: string, shares: number) {
    this.calls.push({ tokenId, shares });
    return this.outcome;
  }
}

const SOLD = (n: number) => ({ soldShares: n, sellPrice: 0.3, orderId: "o1", status: "matched", error: null });
const FAR = 9_999_999_999_999;

test("naked flattener disabled is a no-op (no sell, no resolve)", async () => {
  const store = new FakeStore();
  store.residuals = [{ id: 1, expiryMs: FAR, nakedTokenId: "tok", nakedResidualShares: 10, retainedShares: 0 }];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(snapshotWithPolymarketPositions([{ id: "tok", shares: 10 }])),
    seller,
    false,
  );
  await f.tick(1000);
  assert.equal(seller.calls.length, 0);
  assert.equal(store.resolved.length, 0);
});

test("naked flattener market-sells a held naked residual and resolves the quarantine", async () => {
  const store = new FakeStore();
  store.residuals = [{ id: 1, expiryMs: FAR, nakedTokenId: "tok", nakedResidualShares: 10, retainedShares: 0 }];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(snapshotWithPolymarketPositions([{ id: "tok", shares: 10 }])),
    seller,
    true,
  );
  await f.tick(1000);
  assert.deepEqual(seller.calls, [{ tokenId: "tok", shares: 10 }]);
  assert.equal(store.resolved.length, 1);
  assert.equal(store.resolved[0]?.id, 1);
});

test("naked flattener NEVER oversells: sells min(recorded residual, held shares)", async () => {
  const store = new FakeStore();
  store.residuals = [{ id: 1, expiryMs: FAR, nakedTokenId: "tok", nakedResidualShares: 30, retainedShares: 0 }];
  const seller = new FakeSeller(SOLD(7));
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(snapshotWithPolymarketPositions([{ id: "tok", shares: 7 }])),
    seller,
    true,
  );
  await f.tick(1000);
  assert.equal(seller.calls[0]?.shares, 7); // capped at held 7, not the recorded 30
});

test("naked flattener skips an expired/resolved market (no sell — it's a realized loss to redeem)", async () => {
  const store = new FakeStore();
  store.residuals = [{ id: 1, expiryMs: 500, nakedTokenId: "tok", nakedResidualShares: 10, retainedShares: 0 }];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(snapshotWithPolymarketPositions([{ id: "tok", shares: 10 }])),
    seller,
    true,
  );
  await f.tick(1000); // now 1000 > expiry 500
  assert.equal(seller.calls.length, 0);
  assert.equal(store.resolved.length, 0);
});

test("naked flattener skips when shares are not yet held (settlement lag) and retries later", async () => {
  const store = new FakeStore();
  store.residuals = [{ id: 1, expiryMs: FAR, nakedTokenId: "tok", nakedResidualShares: 10, retainedShares: 0 }];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(store, new FakeActivity(snapshotWithPolymarketPositions([])), seller, true); // nothing held
  await f.tick(1000);
  assert.equal(seller.calls.length, 0);
  assert.equal(store.resolved.length, 0);
});

test("naked flattener does NOT re-sell a token it just sold (cooldown — double-sell guard across the cache lag)", async () => {
  const store = new FakeStore();
  store.residuals = [{ id: 1, expiryMs: FAR, nakedTokenId: "tok", nakedResidualShares: 10, retainedShares: 0 }];
  const seller = new FakeSeller(SOLD(10));
  // The cached snapshot still shows the shares held even after the sell (the ~20s account-position cache lag).
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(snapshotWithPolymarketPositions([{ id: "tok", shares: 10 }])),
    seller,
    true,
  );
  await f.tick(1000); // sells + resolves
  await f.tick(1010); // within cooldown, list still shows it -> must NOT re-sell
  assert.equal(seller.calls.length, 1);
});

test("naked flattener leaves a PARTIAL sell quarantined (no resolve until flat)", async () => {
  const store = new FakeStore();
  store.residuals = [{ id: 1, expiryMs: FAR, nakedTokenId: "tok", nakedResidualShares: 10, retainedShares: 0 }];
  const seller = new FakeSeller(SOLD(4)); // held 10, sold only 4
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(snapshotWithPolymarketPositions([{ id: "tok", shares: 10 }])),
    seller,
    true,
  );
  await f.tick(1000);
  assert.equal(seller.calls.length, 1);
  assert.equal(store.resolved.length, 0); // 6 still held -> not resolved
});

test("naked flattener does not resolve (or cool down) when nothing sold; tick never throws", async () => {
  const store = new FakeStore();
  store.residuals = [{ id: 1, expiryMs: FAR, nakedTokenId: "tok", nakedResidualShares: 10, retainedShares: 0 }];
  const seller = new FakeSeller({
    soldShares: 0,
    sellPrice: null,
    orderId: null,
    status: "unmatched",
    error: "no bids",
  });
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(snapshotWithPolymarketPositions([{ id: "tok", shares: 10 }])),
    seller,
    true,
  );
  await f.tick(1000);
  assert.equal(store.resolved.length, 0);
  await f.tick(1010); // no cooldown set -> retries
  assert.equal(seller.calls.length, 2);
});

test("naked flattener HEDGED FLOOR: sells only shares above the retained floor, never the matched pair", async () => {
  const store = new FakeStore();
  // Recorded naked excess 25 (over-stated), but only 30 held with a 20-share hedged floor -> only 10 are sellable.
  store.residuals = [{ id: 1, expiryMs: FAR, nakedTokenId: "tok", nakedResidualShares: 25, retainedShares: 20 }];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(snapshotWithPolymarketPositions([{ id: "tok", shares: 30 }])),
    seller,
    true,
  );
  await f.tick(1000);
  assert.equal(seller.calls[0]?.shares, 10); // held(30) - floor(20), NOT the 25 recorded nor the 30 held
  assert.equal(store.resolved.length, 1); // reduced to the floor -> resolved
});

test("naked flattener HEDGED FLOOR: SKIPS a legacy residual with no recorded floor (never assumes floor 0)", async () => {
  const store = new FakeStore();
  // retainedShares null = recorded before floor-tracking existed; selling with an assumed 0 floor would un-hedge.
  store.residuals = [{ id: 1, expiryMs: FAR, nakedTokenId: "tok", nakedResidualShares: 10, retainedShares: null }];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(snapshotWithPolymarketPositions([{ id: "tok", shares: 30 }])),
    seller,
    true,
  );
  await f.tick(1000);
  assert.equal(seller.calls.length, 0); // skipped — no floor recorded
  assert.equal(store.resolved.length, 0);
});

test("naked flattener HEDGED FLOOR: never sells when the position is already at the hedged floor", async () => {
  const store = new FakeStore();
  // 20 held, 20-share hedged floor -> the naked excess is already gone; selling any would un-hedge the pair.
  store.residuals = [{ id: 1, expiryMs: FAR, nakedTokenId: "tok", nakedResidualShares: 10, retainedShares: 20 }];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(snapshotWithPolymarketPositions([{ id: "tok", shares: 20 }])),
    seller,
    true,
  );
  await f.tick(1000);
  assert.equal(seller.calls.length, 0); // nothing sold into the hedge
  assert.equal(store.resolved.length, 1); // resolved (already flat at the floor)
});
