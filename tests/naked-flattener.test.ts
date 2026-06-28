import test from "node:test";
import assert from "node:assert/strict";
import { NakedPositionFlattener } from "../src/trading/naked-flattener";
import type { NakedResidualRow } from "../src/db/signals";
import type { TradingActivitySnapshot, TradingConnectionState, TradingPlatform } from "../types/trading";

/**
 * Build a snapshot with Polymarket holdings (by tokenId) and the LIVE, market-wide Kalshi NO held (by ticker).
 * `kalshiFresh:false` marks the Kalshi account fetch as stale/reconnecting — the flattener must then refuse to
 * sell (it cannot prove the hedge floor).
 */
function buildSnapshot(opts: {
  pm: { id: string; shares: number }[];
  kalshiNo?: { ticker: string; shares: number }[];
  kalshiFresh?: boolean;
}): TradingActivitySnapshot {
  const kalshiFresh = opts.kalshiFresh ?? true;
  const base = (platform: TradingPlatform, connectionStatus: TradingConnectionState, stale: boolean) => ({
    platform,
    connectionStatus,
    lastUpdatedAt: 1000,
    portfolio: {
      platform,
      portfolioValue: null,
      cashValue: null,
      dayChangeDollars: null,
      dayChangePercent: null,
      lastUpdatedAt: 1000,
      ...(stale ? { stale: true } : {}),
    },
    openOrders: [],
    history: [],
    sparkline: [],
  });
  return {
    kalshi: {
      ...base("kalshi", kalshiFresh ? "live" : "reconnecting", !kalshiFresh),
      positions: (opts.kalshiNo ?? []).map((k) => ({
        id: k.ticker,
        market: k.ticker,
        outcome: "NO",
        shares: k.shares,
        value: null,
        averagePrice: null,
        updatedAt: 1000,
      })),
    },
    polymarket: {
      ...base("polymarket", "live", false),
      positions: opts.pm.map((p) => ({
        id: p.id,
        market: "BTC-15m",
        outcome: "Up",
        shares: p.shares,
        value: null,
        averagePrice: null,
        updatedAt: 1000,
      })),
    },
  };
}

const residual = (over: Partial<NakedResidualRow> = {}): NakedResidualRow => ({
  id: 1,
  expiryMs: FAR,
  nakedTokenId: "tok",
  nakedResidualShares: 10,
  kalshiContractId: "KX",
  retainedShares: 0,
  ...over,
});

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
  store.residuals = [residual({ nakedResidualShares: 10 })];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(store, new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 10 }] })), seller, false);
  await f.tick(1000);
  assert.equal(seller.calls.length, 0);
  assert.equal(store.resolved.length, 0);
});

test("naked flattener market-sells a genuinely naked residual (no live hedge) and resolves", async () => {
  const store = new FakeStore();
  store.residuals = [residual({ nakedResidualShares: 10 })];
  const seller = new FakeSeller(SOLD(10));
  // Fresh Kalshi snapshot, ticker holds 0 NO -> floor 0 -> the 10 PM shares are genuinely naked.
  const f = new NakedPositionFlattener(store, new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 10 }] })), seller, true);
  await f.tick(1000);
  assert.deepEqual(seller.calls, [{ tokenId: "tok", shares: 10 }]);
  assert.equal(store.resolved.length, 1);
  assert.equal(store.resolved[0]?.id, 1);
});

test("naked flattener NEVER oversells: sells min(recorded residual, excess over the live floor)", async () => {
  const store = new FakeStore();
  store.residuals = [residual({ nakedResidualShares: 30 })];
  const seller = new FakeSeller(SOLD(7));
  const f = new NakedPositionFlattener(store, new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 7 }] })), seller, true);
  await f.tick(1000);
  assert.equal(seller.calls[0]?.shares, 7); // capped at the excess (7), not the recorded 30
});

test("naked flattener skips an expired/resolved market (no sell — it's a realized loss to redeem)", async () => {
  const store = new FakeStore();
  store.residuals = [residual({ expiryMs: 500, nakedResidualShares: 10 })];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(store, new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 10 }] })), seller, true);
  await f.tick(1000); // now 1000 > expiry 500
  assert.equal(seller.calls.length, 0);
  assert.equal(store.resolved.length, 0);
});

test("naked flattener skips when shares are not yet held (settlement lag) and retries later", async () => {
  const store = new FakeStore();
  store.residuals = [residual({ nakedResidualShares: 10 })];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(store, new FakeActivity(buildSnapshot({ pm: [] })), seller, true); // nothing held
  await f.tick(1000);
  assert.equal(seller.calls.length, 0);
  assert.equal(store.resolved.length, 0);
});

test("naked flattener does NOT re-sell a token it just sold (cooldown — double-sell guard across cache lag)", async () => {
  const store = new FakeStore();
  store.residuals = [residual({ nakedResidualShares: 10 })];
  const seller = new FakeSeller(SOLD(10));
  // The cached snapshot still shows the shares held even after the sell (the ~20s account-position cache lag).
  const f = new NakedPositionFlattener(store, new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 10 }] })), seller, true);
  await f.tick(1000); // sells + resolves
  await f.tick(1010); // within cooldown, list still shows it -> must NOT re-sell
  assert.equal(seller.calls.length, 1);
});

test("naked flattener leaves a PARTIAL sell quarantined (no resolve until flat)", async () => {
  const store = new FakeStore();
  store.residuals = [residual({ nakedResidualShares: 10 })];
  const seller = new FakeSeller(SOLD(4)); // requested excess 10, exchange filled only 4
  const f = new NakedPositionFlattener(store, new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 10 }] })), seller, true);
  await f.tick(1000);
  assert.equal(seller.calls.length, 1);
  assert.equal(store.resolved.length, 0); // 6 still held above floor -> not resolved
});

test("naked flattener does not resolve (or cool down) when nothing sold; tick never throws", async () => {
  const store = new FakeStore();
  store.residuals = [residual({ nakedResidualShares: 10 })];
  const seller = new FakeSeller({ soldShares: 0, sellPrice: null, orderId: null, status: "unmatched", error: "no bids" });
  const f = new NakedPositionFlattener(store, new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 10 }] })), seller, true);
  await f.tick(1000);
  assert.equal(store.resolved.length, 0);
  await f.tick(1010); // no cooldown set -> retries
  assert.equal(seller.calls.length, 2);
});

test("LIVE HEDGED FLOOR: sells only the excess above the live Kalshi NO, never the matched pair", async () => {
  const store = new FakeStore();
  // Recorded naked excess 25 (over-stated), but 30 PM held with a LIVE 20-share Kalshi NO hedge -> only 10 sellable.
  store.residuals = [residual({ nakedResidualShares: 25 })];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 30 }], kalshiNo: [{ ticker: "KX", shares: 20 }] })),
    seller,
    true,
  );
  await f.tick(1000);
  assert.equal(seller.calls[0]?.shares, 10); // held(30) - live floor(20), NOT 25 recorded nor 30 held
  assert.equal(store.resolved.length, 1); // reduced to the live floor -> resolved
});

test("LIVE HEDGED FLOOR: SKIPS a residual with no hedging ticker (cannot prove the hedge -> fail safe)", async () => {
  const store = new FakeStore();
  store.residuals = [residual({ nakedResidualShares: 10, kalshiContractId: null })];
  const seller = new FakeSeller(SOLD(10));
  const f = new NakedPositionFlattener(store, new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 30 }] })), seller, true);
  await f.tick(1000);
  assert.equal(seller.calls.length, 0); // skipped — no ticker to look up the live hedge
  assert.equal(store.resolved.length, 0);
});

test("LIVE HEDGED FLOOR: never sells when held is already at/below the live Kalshi hedge", async () => {
  const store = new FakeStore();
  store.residuals = [residual({ nakedResidualShares: 10 })];
  const seller = new FakeSeller(SOLD(10));
  // 20 PM held, 20 live Kalshi NO -> fully hedged, no naked excess.
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 20 }], kalshiNo: [{ ticker: "KX", shares: 20 }] })),
    seller,
    true,
  );
  await f.tick(1000);
  assert.equal(seller.calls.length, 0); // nothing sold into the hedge
  assert.equal(store.resolved.length, 1); // resolved (already flat at the live floor)
});

test("STALE Kalshi snapshot: SKIPS (cannot trust the hedge floor)", async () => {
  const store = new FakeStore();
  store.residuals = [residual({ nakedResidualShares: 30.91 })];
  const seller = new FakeSeller(SOLD(30));
  // Even though the (stale) snapshot shows a 206 hedge, a reconnecting Kalshi fetch must not be trusted.
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 240.87 }], kalshiNo: [{ ticker: "KX", shares: 206 }], kalshiFresh: false })),
    seller,
    true,
  );
  await f.tick(1000);
  assert.equal(seller.calls.length, 0);
  assert.equal(store.resolved.length, 0);
});

test("RACE GATE: skips when the excess grossly exceeds the recorded residual (Kalshi hedge still mid-fill)", async () => {
  const store = new FakeStore();
  // The 2026-06-28 incident shape: residual 30.91 recorded while the Kalshi hedge was only 144 of an eventual 206.
  store.residuals = [residual({ nakedResidualShares: 30.91 })];
  const seller = new FakeSeller(SOLD(30));
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 240.87 }], kalshiNo: [{ ticker: "KX", shares: 144 }] })),
    seller,
    true,
  );
  await f.tick(1000);
  // excess = 240.87 - 144 = 96.87 >> 30.91*2+1 = 62.82 -> the hedge is incomplete, do NOT dump the leg.
  assert.equal(seller.calls.length, 0);
  assert.equal(store.resolved.length, 0);
});

test("K30/PM35: sells exactly the 5-share Polymarket overfill, keeps the 30 hedged", async () => {
  const store = new FakeStore();
  store.residuals = [residual({ nakedResidualShares: 5 })];
  const seller = new FakeSeller(SOLD(5));
  const f = new NakedPositionFlattener(
    store,
    new FakeActivity(buildSnapshot({ pm: [{ id: "tok", shares: 35 }], kalshiNo: [{ ticker: "KX", shares: 30 }] })),
    seller,
    true,
  );
  await f.tick(1000);
  assert.deepEqual(seller.calls, [{ tokenId: "tok", shares: 5 }]); // 35 - 30
  assert.equal(store.resolved.length, 1);
});

test("INCIDENT REPLAY (281600): sells only ~34.87 over ticks, NEVER reduces PM below the 206 Kalshi hedge", async () => {
  // PM holds 240.87 under one fungible token; live, market-wide Kalshi NO = 206. The recorded residual is 30.91.
  // The buggy old code dumped all 240.87 (floor frozen at 0). The fix must sell only the 34.87 excess and stop.
  const store = new FakeStore();
  store.residuals = [residual({ nakedResidualShares: 30.91 })];

  // Dynamic harness: the PM held shrinks as the flattener sells, and the seller fills exactly what is requested.
  const pmHeld = { tok: 240.87 };
  const KALSHI_NO = 206;
  let minPmHeldObserved = pmHeld.tok;
  const activity = {
    async getSnapshot(): Promise<TradingActivitySnapshot> {
      minPmHeldObserved = Math.min(minPmHeldObserved, pmHeld.tok);
      return buildSnapshot({ pm: [{ id: "tok", shares: pmHeld.tok }], kalshiNo: [{ ticker: "KX", shares: KALSHI_NO }] });
    },
  };
  const calls: { tokenId: string; shares: number }[] = [];
  const seller = {
    async marketSellShares(tokenId: string, shares: number) {
      calls.push({ tokenId, shares });
      pmHeld.tok = Math.max(0, pmHeld.tok - shares); // exchange fills the full request
      return SOLD(shares);
    },
  };
  const f = new NakedPositionFlattener(store, activity, seller, true);

  // Tick repeatedly, advancing past the 60s re-sell cooldown each time, until it resolves.
  let now = 1000;
  for (let i = 0; i < 6 && store.resolved.length === 0; i++) {
    await f.tick(now);
    now += 60_001;
  }

  const totalSold = calls.reduce((sum, c) => sum + c.shares, 0);
  assert.ok(Math.abs(totalSold - 34.87) < 0.01, `expected ~34.87 sold, got ${totalSold}`);
  assert.ok(pmHeld.tok >= KALSHI_NO - 0.01, `PM held ${pmHeld.tok} must never fall below the 206 hedge`);
  assert.ok(minPmHeldObserved >= KALSHI_NO - 0.01, `PM held dipped to ${minPmHeldObserved}, below the 206 hedge`);
  assert.equal(store.resolved.length, 1); // converged to the live floor and resolved
});
