import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardTerminalView } from "../app/components/DashboardTerminal";
import { isValidDashboardSession, verifyDashboardPassword } from "../app/lib/dashboard-session";
import { isContractStale, sortCandidatesForBlotter } from "../app/lib/dashboard-view-model";
import { buildDashboardAnalytics } from "../src/analytics/performance";
import { buildSyntheticStructureRisk } from "../src/scanner/payoff";
import type { ArbCandidate, DashboardSignal, DashboardSnapshot } from "../src/types";

function candidate(pairKey: string, guaranteedProfit: number, expiryMs: number): ArbCandidate {
  const lower = { venue: "polymarket" as const, contractId: `${pairKey}-poly`, direction: "yes" as const, strike: 1500, ask: 0.4 };
  const higher = { venue: "kalshi" as const, contractId: `${pairKey}-kalshi`, direction: "no" as const, strike: 1502, ask: 0.5 };
  return {
    pairKey,
    expiryMs,
    lower,
    higher,
    kalshiContractId: `${pairKey}-kalshi`,
    polymarketContractId: `${pairKey}-poly`,
    premium: 1 - guaranteedProfit,
    guaranteedProfit,
    overlapProfit: 1 + guaranteedProfit,
    threshold: 0.05,
    executable: true,
    reason: null,
    risk: buildSyntheticStructureRisk(lower, higher, 0.05),
  };
}

function probabilisticCandidate(): ArbCandidate {
  const lower = { venue: "polymarket" as const, contractId: "dead-poly", direction: "no" as const, strike: 1500, ask: 0.4 };
  const higher = { venue: "kalshi" as const, contractId: "dead-kalshi", direction: "yes" as const, strike: 1502, ask: 0.5 };
  return {
    pairKey: "dead-zone",
    expiryMs: 1_800_000_900_000,
    lower,
    higher,
    kalshiContractId: "dead-kalshi",
    polymarketContractId: "dead-poly",
    premium: 0.9,
    guaranteedProfit: -0.9,
    overlapProfit: -0.9,
    threshold: 0.05,
    executable: false,
    reason: "dead_zone_configuration",
    risk: buildSyntheticStructureRisk(lower, higher, 0.05),
  };
}

function signal(input: Partial<DashboardSignal> = {}): DashboardSignal {
  return {
    id: 42,
    createdAt: "2026-04-29T20:00:00.000Z",
    updatedAt: "2026-04-29T20:00:01.250Z",
    pairKey: "polymarket-poly-1500::kalshi-kalshi-1502",
    expiryMs: 1_800_000_900_000,
    kalshiContractId: "kalshi-kxbtc-1502",
    polymarketContractId: "polymarket-condition-1500",
    lower: { venue: "polymarket", contractId: "polymarket-condition-1500", direction: "yes", strike: 1500, ask: 0.4 },
    higher: { venue: "kalshi", contractId: "kalshi-kxbtc-1502", direction: "no", strike: 1502, ask: 0.5 },
    premium: 0.9,
    guaranteedProfit: 0.1,
    overlapProfit: 1.1,
    threshold: 0.05,
    action: "filled",
    failureReason: null,
    kalshiFillId: "kalshi-fill-abc",
    polymarketFillId: "poly-fill-def",
    kalshiFillPrice: 0.51,
    polymarketFillPrice: 0.41,
    risk: buildSyntheticStructureRisk(
      { venue: "polymarket", contractId: "polymarket-condition-1500", direction: "yes", strike: 1500, ask: 0.4 },
      { venue: "kalshi", contractId: "kalshi-kxbtc-1502", direction: "no", strike: 1502, ask: 0.5 },
      0.05,
    ),
    ...input,
  };
}

function snapshot(input: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  const generatedAt = 1_800_000_010_000;
  return {
    generatedAt,
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
    diagnostics: {
      polymarket: {
        marketsFound: 1,
        readyContracts: 1,
        pendingStrikeCount: 0,
        missingStrikeCount: 0,
        invalidMarketCount: 0,
        lastChainlinkTickAt: 1_800_000_009_900,
        lastChainlinkTickAgeMs: 100,
        nextCaptureWindowStartMs: null,
        skippedReasons: [],
        markets: [{
          marketSlug: "btc-updown-15m-1800000000",
          conditionId: "poly",
          eventStartMs: 1_800_000_000_000,
          expiryMs: 1_800_000_900_000,
          priceToBeat: 1500,
          strikeSource: "chainlink_ws",
          status: "ready",
          reason: "strike hydrated",
        }],
      },
    },
    liveCandidates: [candidate("slow", 0.05, 1_800_000_900_000), candidate("fast", 0.12, 1_800_000_900_000)],
    syntheticStructures: [candidate("fast", 0.12, 1_800_000_900_000), probabilisticCandidate()],
    recentSignals: [],
    analytics: buildDashboardAnalytics([
      signal({ updatedAt: new Date(generatedAt - 1_000).toISOString(), kalshiFillPrice: 0.51, polymarketFillPrice: 0.41 }),
    ], generatedAt),
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
  assert.match(live, /Synthetic Strangle Map/);
  assert.match(live, /Long Up Below \+ Long Down Above/);
  assert.match(live, /Long Up Above \+ Long Down Below/);
  assert.match(live, /TRUE ARB/);
  assert.match(live, /PROBABILISTIC DEAD ZONE/);
  assert.match(live, /Gap % Mid/);
  assert.match(live, /Loss % Gap/);
  assert.match(live, /100.0%/);
  assert.match(live, /Max loss window/);
  assert.match(live, /Payoff Curve/);
  assert.match(live, /aria-label="Long Up Below \+ Long Down Above payoff curve"/);
  assert.match(live, /aria-label="Long Up Above \+ Long Down Below payoff curve"/);
  assert.match(live, /payoff-bonus-zone/);
  assert.match(live, /payoff-loss-zone/);
  assert.match(live, /Lower strike/);
  assert.match(live, /Higher strike/);
  assert.match(live, /Below lower/);
  assert.match(live, /Between strikes/);
  assert.match(live, /Above higher/);
  assert.match(live, /Estimated Guaranteed PnL/);
  assert.match(live, /Hourly/);
  assert.match(live, /Daily/);
  assert.match(live, /Weekly/);
  assert.match(live, /Win Rate/);
  assert.match(live, /Trades Won/);
  assert.match(live, /Loss Rate/);
  assert.match(live, /Trades Lost/);
  assert.match(live, /Profit Factor/);
  assert.match(live, /Sharpe Ratio/);
  assert.match(live, /Estimated Guaranteed PnL Graph/);
  assert.match(live, /aria-label="Live venue books"/);
  assert.match(live, /Price-To-Beat Diagnostics/);
  assert.match(live, /aria-label="Signal and runtime activity"/);
  assert.match(live, /Signal Tape/);
  assert.match(live, /Event Tape/);
  assert.match(live, /SSE LIVE/);
  assert.match(live, /12c/);
});

test("analytics panel renders empty worker and no-trade states", () => {
  const noWorkerAnalytics = renderToStaticMarkup(
    <DashboardTerminalView dashboardName="POK Terminal" snapshot={{ ...snapshot(), analytics: undefined }} streamState="live" />,
  );
  assert.match(noWorkerAnalytics, /The worker has not published analytics yet/);

  const noTrades = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardName="POK Terminal"
      snapshot={snapshot({ analytics: buildDashboardAnalytics([], snapshot().generatedAt) })}
      streamState="live"
    />,
  );
  assert.match(noTrades, /No filled trades in the selected hourly window yet/);
});

test("signal tape renders detailed venue fills, timestamps, and failures", () => {
  const failed = signal({
    id: 43,
    action: "failed",
    failureReason: "kalshi order rejected",
    kalshiFillId: null,
    polymarketFillId: null,
    kalshiFillPrice: null,
    polymarketFillPrice: null,
  });
  const markup = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardName="POK Terminal"
      snapshot={snapshot({ recentSignals: [signal(), failed] })}
      streamState="live"
    />,
  );

  assert.match(markup, /Signal #42/);
  assert.match(markup, /Signal time/);
  assert.match(markup, /Finalized time/);
  assert.match(markup, /dateTime="2026-04-29T20:00:00.000Z"/);
  assert.match(markup, /Latency/);
  assert.match(markup, /1.3s/);
  assert.match(markup, /KALSHI/);
  assert.match(markup, /POLYMARKET/);
  assert.match(markup, /\$1,502.00/);
  assert.match(markup, /\$1,500.00/);
  assert.match(markup, /51c/);
  assert.match(markup, /41c/);
  assert.match(markup, /1c/);
  assert.match(markup, /kalshi-fill-abc/);
  assert.match(markup, /poly-fill-def/);
  assert.match(markup, /90c/);
  assert.match(markup, /110c/);
  assert.match(markup, /Structure/);
  assert.match(markup, /Strike Gap/);
  assert.match(markup, /0.13%/);
  assert.match(markup, /Loss Window/);
  assert.match(markup, /payoff-curve-compact/);
  assert.match(markup, /Net P\/L by settlement zone/);
  assert.match(markup, /payoff-segment-profit/);
  assert.match(markup, /Failure: kalshi order rejected/);
});
