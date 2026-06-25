import test from "node:test";
import assert from "node:assert/strict";
import { PortfolioFloorMonitor } from "../src/trading/portfolio-floor";
import type {
  TradingActivitySnapshot,
  TradingConnectionState,
  TradingPlatform,
  TradingPlatformActivity,
} from "../types/trading";

function venue(
  platform: TradingPlatform,
  opts: {
    portfolioValue?: number | null;
    cashValue?: number | null;
    connectionStatus?: TradingConnectionState;
    stale?: boolean;
    lastUpdatedAt?: number;
  },
): TradingPlatformActivity {
  const lastUpdatedAt = opts.lastUpdatedAt ?? 1000;
  return {
    platform,
    connectionStatus: opts.connectionStatus ?? "live",
    lastUpdatedAt,
    portfolio: {
      platform,
      portfolioValue: opts.portfolioValue ?? null,
      cashValue: opts.cashValue ?? null,
      dayChangeDollars: null,
      dayChangePercent: null,
      lastUpdatedAt,
      stale: opts.stale,
      valueAsOfMs: null,
    },
    positions: [],
    openOrders: [],
    history: [],
    sparkline: [],
  };
}

// Kalshi venue value = cash (portfolioValue==cash -> positionsValue 0); Polymarket value = reported total.
function snapshot(
  kalshiCash: number,
  polymarketValue: number,
  opts: {
    kalshiStatus?: TradingConnectionState;
    polymarketStatus?: TradingConnectionState;
    kalshiStale?: boolean;
    polymarketStale?: boolean;
    lastUpdatedAt?: number;
  } = {},
): TradingActivitySnapshot {
  return {
    kalshi: venue("kalshi", {
      cashValue: kalshiCash,
      portfolioValue: kalshiCash,
      connectionStatus: opts.kalshiStatus,
      stale: opts.kalshiStale,
      lastUpdatedAt: opts.lastUpdatedAt,
    }),
    polymarket: venue("polymarket", {
      portfolioValue: polymarketValue,
      cashValue: polymarketValue,
      connectionStatus: opts.polymarketStatus,
      stale: opts.polymarketStale,
      lastUpdatedAt: opts.lastUpdatedAt,
    }),
  };
}

class FakeActivity {
  snap: TradingActivitySnapshot;
  throwOnce = false;
  constructor(snap: TradingActivitySnapshot) {
    this.snap = snap;
  }
  async getSnapshot(): Promise<TradingActivitySnapshot> {
    if (this.throwOnce) {
      this.throwOnce = false;
      throw new Error("venue source down");
    }
    return this.snap;
  }
}

test("portfolio floor disabled (floor=0) is a no-op: never blocks, never latches", async () => {
  const act = new FakeActivity(snapshot(10, 10)); // total 20, below any positive floor
  const mon = new PortfolioFloorMonitor(act, 0);
  await mon.tick(1);
  await mon.tick(2);
  assert.equal(mon.blockReason(), null);
  assert.equal(mon.status().breached, false);
});

test("portfolio floor latches after N authoritative sub-floor readings and halts trading", async () => {
  const act = new FakeActivity(snapshot(20, 80, { lastUpdatedAt: 1000 })); // total 100 < 125
  const mon = new PortfolioFloorMonitor(act, 125);
  await mon.tick(1);
  assert.equal(mon.blockReason(), null, "a single reading is not yet a confirmed breach");
  act.snap = snapshot(20, 80, { lastUpdatedAt: 2000 }); // a genuinely new reading
  await mon.tick(2);
  assert.match(String(mon.blockReason()), /portfolio value floor breach/);
  assert.equal(mon.status().breached, true);
  assert.equal(mon.status().total, 100);
});

test("portfolio floor does NOT latch when the authoritative total is at/above the floor", async () => {
  const act = new FakeActivity(snapshot(77, 120, { lastUpdatedAt: 1000 })); // 197 >= 125
  const mon = new PortfolioFloorMonitor(act, 125);
  await mon.tick(1);
  act.snap = snapshot(77, 120, { lastUpdatedAt: 2000 });
  await mon.tick(2);
  assert.equal(mon.blockReason(), null);
});

test("portfolio floor FAIL-OPEN: a non-live (reconnecting) venue never latches, even on a sub-floor cash total", async () => {
  const act = new FakeActivity(snapshot(20, 80, { polymarketStatus: "reconnecting", lastUpdatedAt: 1000 }));
  const mon = new PortfolioFloorMonitor(act, 125);
  await mon.tick(1);
  act.snap = snapshot(20, 80, { polymarketStatus: "reconnecting", lastUpdatedAt: 2000 });
  await mon.tick(2);
  assert.equal(mon.blockReason(), null, "fail-open: keep trading when a venue is not authoritative");
  assert.equal(mon.status().authoritative, false);
});

test("portfolio floor FAIL-OPEN: a stale (carried-forward) venue never latches", async () => {
  const act = new FakeActivity(snapshot(20, 80, { kalshiStale: true, lastUpdatedAt: 1000 }));
  const mon = new PortfolioFloorMonitor(act, 125);
  await mon.tick(1);
  act.snap = snapshot(20, 80, { kalshiStale: true, lastUpdatedAt: 2000 });
  await mon.tick(2);
  assert.equal(mon.blockReason(), null);
});

test("portfolio floor LATCHES: stays halted after the value recovers, until clear()", async () => {
  const act = new FakeActivity(snapshot(20, 80, { lastUpdatedAt: 1000 }));
  const mon = new PortfolioFloorMonitor(act, 125);
  await mon.tick(1);
  act.snap = snapshot(20, 80, { lastUpdatedAt: 2000 });
  await mon.tick(2);
  assert.notEqual(mon.blockReason(), null, "latched on the confirmed breach");
  act.snap = snapshot(100, 100, { lastUpdatedAt: 3000 }); // recovered to 200 >= 125
  await mon.tick(3);
  assert.notEqual(mon.blockReason(), null, "still latched after recovery (it is a circuit breaker, not a soft gate)");
  mon.clear();
  assert.equal(mon.blockReason(), null, "operator clear releases the latch");
});

test("portfolio floor N-confirmation counts only DISTINCT readings (not a re-read of the same cached value)", async () => {
  const act = new FakeActivity(snapshot(20, 80, { lastUpdatedAt: 1000 }));
  const mon = new PortfolioFloorMonitor(act, 125);
  await mon.tick(1); // breach #1 (reading @1000)
  await mon.tick(2); // SAME reading @1000 -> not counted again
  await mon.tick(3); // SAME reading @1000 -> not counted again
  assert.equal(mon.blockReason(), null, "repeated same-timestamp readings do not reach the 2-confirmation latch");
  act.snap = snapshot(20, 80, { lastUpdatedAt: 2000 }); // a genuinely new reading
  await mon.tick(4);
  assert.notEqual(mon.blockReason(), null, "a second DISTINCT sub-floor reading latches");
});

test("portfolio floor tick never throws and does not latch on a read error (fail-open)", async () => {
  const act = new FakeActivity(snapshot(20, 80));
  act.throwOnce = true;
  const mon = new PortfolioFloorMonitor(act, 125);
  await mon.tick(1); // throws internally -> swallowed, no latch
  assert.equal(mon.blockReason(), null);
});
