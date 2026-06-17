import test from "node:test";
import assert from "node:assert/strict";
import { kalshiLegFromRows, polymarketLegFromRows } from "../src/trading/venue-pnl";

const NOW = 1_781_700_000_000;

test("kalshiLegFromRows computes realized take-home net of fees from BTC settlements only", () => {
  const settlements = [
    // BTC winner: 10 NO contracts settle to $10 (revenue is cents), cost $5.20, fee $0.1745.
    { ticker: "KXBTC15M-26JUN171300-00", revenue: 1000, no_total_cost_dollars: "5.200000", yes_total_cost_dollars: "0", fee_cost: "0.174500" },
    // BTC loser: 10 YES settle to $0, cost $4.80, fee $0.10.
    { ticker: "KXBTC15M-26JUN171315-00", revenue: 0, yes_total_cost_dollars: "4.800000", no_total_cost_dollars: "0", fee_cost: "0.100000" },
    // Non-arb World Cup settlement must be excluded entirely.
    { ticker: "KXMENWORLDCUP-26-US", revenue: 5000, yes_total_cost_dollars: "1.000000", no_total_cost_dollars: "0", fee_cost: "0.500000" },
  ];
  const positions = [
    // Open BTC leg (counts toward open exposure).
    { ticker: "KXBTC15M-26JUN171330-00", position_fp: "10.00", market_exposure_dollars: "5.000000" },
    // Flat BTC position (settled out) is excluded from open exposure.
    { ticker: "KXBTC15M-26JUN171300-00", position_fp: "0", market_exposure_dollars: "0" },
    // Non-arb open position excluded.
    { ticker: "KXMENWORLDCUP-26-AU", position_fp: "1087.46", market_exposure_dollars: "3.262380" },
  ];

  const leg = kalshiLegFromRows(positions, settlements, NOW);
  assert.equal(leg.settledCount, 2, "only BTC settlements counted");
  assert.equal(leg.grossRevenue, 10, "revenue cents -> dollars, BTC only");
  assert.equal(leg.cost, 10, "5.20 + 4.80 cost");
  assert.equal(leg.feesPaid, 0.2745, "0.1745 + 0.10 fees");
  // 10 - 10 - 0.2745 = -0.2745 net.
  assert.equal(leg.realizedTakeHome, -0.2745);
  assert.equal(leg.openCount, 1, "only the open BTC leg");
  assert.equal(leg.openExposure, 5);
  assert.equal(leg.unredeemedCount, 0);
  assert.equal(leg.connectionStatus, "live");
});

test("polymarketLegFromRows uses cashPnl for ended positions and currentValue for open, BTC only", () => {
  const positions = [
    // Ended (resolved, redeemable) BTC loser — realized via cashPnl.
    { title: "Bitcoin Up or Down - June 17, 12:45PM-1:00PM ET", redeemable: true, curPrice: 0, size: 15.5658, cashPnl: -6.8999, initialValue: 6.8999 },
    // Ended BTC winner.
    { title: "Bitcoin Up or Down - June 17, 1:00PM-1:15PM ET", redeemable: true, curPrice: 1, size: 10, cashPnl: 4.5, initialValue: 5.5 },
    // Still-open BTC position — counts as open exposure, not realized.
    { title: "Bitcoin Up or Down - June 17, 1:15PM-1:30PM ET", redeemable: false, curPrice: 0.46, size: 10, currentValue: 4.6, cashPnl: -0.4, initialValue: 5.0 },
    // Non-arb market excluded.
    { title: "Will it rain tomorrow?", redeemable: true, curPrice: 0, size: 3, cashPnl: -3, initialValue: 3 },
  ];

  const leg = polymarketLegFromRows(positions, NOW);
  assert.equal(leg.settledCount, 2, "two ended BTC positions");
  assert.equal(leg.openCount, 1);
  assert.equal(leg.unredeemedCount, 2, "both ended BTC positions are redeemable/unredeemed");
  // -6.8999 + 4.5 = -2.3999 realized from ended positions only.
  assert.equal(leg.realizedTakeHome, -2.3999);
  assert.equal(leg.openExposure, 4.6, "open position marked at currentValue");
  assert.equal(leg.feesPaid, 0, "Polymarket trading fee ~0");
});

test("empty inputs yield a zeroed live leg", () => {
  const k = kalshiLegFromRows([], [], NOW);
  assert.equal(k.realizedTakeHome, 0);
  assert.equal(k.settledCount, 0);
  const p = polymarketLegFromRows([], NOW);
  assert.equal(p.realizedTakeHome, 0);
  assert.equal(p.openExposure, 0);
});
