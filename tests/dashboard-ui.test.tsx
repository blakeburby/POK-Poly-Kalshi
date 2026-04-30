import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardTerminalView } from "../app/components/DashboardTerminal";
import { isValidDashboardSession, verifyDashboardPassword } from "../app/lib/dashboard-session";
import { isContractStale, sortCandidatesForBlotter } from "../app/lib/dashboard-view-model";
import type { ArbCandidate, DashboardSnapshot } from "../src/types";

function candidate(pairKey: string, guaranteedProfit: number, expiryMs: number): ArbCandidate {
  return {
    pairKey,
    expiryMs,
    lower: { venue: "polymarket", contractId: `${pairKey}-poly`, direction: "yes", strike: 1500, ask: 0.4 },
    higher: { venue: "kalshi", contractId: `${pairKey}-kalshi`, direction: "no", strike: 1502, ask: 0.5 },
    kalshiContractId: `${pairKey}-kalshi`,
    polymarketContractId: `${pairKey}-poly`,
    premium: 1 - guaranteedProfit,
    guaranteedProfit,
    overlapProfit: 1 + guaranteedProfit,
    threshold: 0.05,
    executable: true,
    reason: null,
  };
}

function snapshot(input: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    generatedAt: 1_800_000_010_000,
    health: {
      ok: true,
      liveTrading: false,
      arbEnabled: true,
      minProfitDollars: 0.05,
      reentryIntervalMs: 15_000,
      staleBookMs: 10_000,
    },
    discovery: { lastDiscoveryAt: 1_800_000_009_000, lastDiscoveryError: null },
    scanner: { scanning: false, lastScanAt: 1_800_000_009_500, lastCandidateCount: 2 },
    books: {
      kalshi: [{
        venue: "kalshi",
        contractId: "kalshi",
        asset: "BTC",
        expiryMs: 1_800_000_900_000,
        strike: 1502,
        yesAsk: 0.5,
        noAsk: 0.5,
        yesBid: 0.49,
        noBid: 0.49,
        updatedAt: 1_800_000_009_500,
      }],
      polymarket: [{
        venue: "polymarket",
        contractId: "poly",
        asset: "BTC",
        expiryMs: 1_800_000_900_000,
        strike: 1500,
        yesAsk: 0.4,
        noAsk: 0.6,
        yesBid: 0.39,
        noBid: 0.59,
        updatedAt: 1_800_000_009_500,
      }],
    },
    liveCandidates: [candidate("slow", 0.05, 1_800_000_900_000), candidate("fast", 0.12, 1_800_000_900_000)],
    recentSignals: [],
    logs: [],
    ...input,
  };
}

test("dashboard password helper rejects unauthenticated access inputs", () => {
  process.env.DASHBOARD_PASSWORD = "operator";
  assert.equal(verifyDashboardPassword("operator"), true);
  assert.equal(verifyDashboardPassword("wrong"), false);
  assert.equal(isValidDashboardSession(undefined), false);
});

test("opportunity blotter sorts by guaranteed profit and stale helper flags old books", () => {
  const sorted = sortCandidatesForBlotter([candidate("low", 0.05, 20), candidate("high", 0.12, 30)]);
  assert.equal(sorted[0].pairKey, "high");
  const stale = snapshot({
    books: {
      kalshi: [snapshot().books.kalshi[0]],
      polymarket: [{ ...snapshot().books.polymarket[0], updatedAt: 1_799_999_999_999 }],
    },
  });
  assert.equal(isContractStale(stale.books.polymarket[0], stale), true);
});

test("dashboard renders loading, degraded, and live terminal states", () => {
  const loading = renderToStaticMarkup(<DashboardTerminalView dashboardName="POK Terminal" snapshot={null} streamState="connecting" />);
  assert.match(loading, /Connecting to live terminal/);

  const degraded = renderToStaticMarkup(<DashboardTerminalView dashboardName="POK Terminal" snapshot={null} streamState="degraded" />);
  assert.match(degraded, /Worker stream unavailable/);

  const live = renderToStaticMarkup(<DashboardTerminalView dashboardName="POK Terminal" snapshot={snapshot()} streamState="live" />);
  assert.match(live, /Opportunity Blotter/);
  assert.match(live, /SSE LIVE/);
  assert.match(live, /12c/);
});
