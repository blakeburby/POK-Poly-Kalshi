import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DashboardTerminalView,
  InlineTradePayoffGraph,
  RiskMeter,
  TradeDetailDrawer,
  buildBookMetrics,
  buildBookRowViewModel,
  buildCrossVenueBookComparisons,
  buildTradeDetailModel,
  buildTradeRiskIntelligence,
  normalizeBinaryPrice,
} from "../app/components/DashboardTerminal";
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
    executionMode: "paper",
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
  const defaultPaperSignals = input.paper?.recentSignals ?? input.recentSignals ?? [];
  const defaultLiveSignals = input.live?.recentSignals ?? [
    signal({ executionMode: "live", id: 84, updatedAt: new Date(generatedAt - 1_000).toISOString(), kalshiFillPrice: 0.51, polymarketFillPrice: 0.41 }),
  ];
  const defaultPaperAnalytics = input.paper?.analytics ?? input.analytics ?? buildDashboardAnalytics([
    signal({ updatedAt: new Date(generatedAt - 1_000).toISOString(), kalshiFillPrice: 0.51, polymarketFillPrice: 0.41 }),
  ], generatedAt);
  const defaultLiveAnalytics = input.live?.analytics ?? buildDashboardAnalytics(defaultLiveSignals, generatedAt);
  return {
    generatedAt,
    health: {
      ok: true,
      liveTrading: false,
      arbEnabled: true,
      liveAutoHardlocksEnabled: true,
      minProfitDollars: 0.05,
      reentryIntervalMs: 15_000,
      staleBookMs: 10_000,
      liveMaxTradesPerWindow: 1,
    },
    discovery: { lastDiscoveryAt: 1_800_000_009_000, lastDiscoveryError: null },
    scanner: { scanning: false, lastScanAt: 1_800_000_009_500, lastCandidateCount: 2, queuedExecutions: 1, activeExecutions: 1 },
    latency: {
      generatedAt,
      books: {
        kalshi: { latestMs: 500, p50Ms: 500, p95Ms: 500, sampleCount: 1 },
        polymarket: { latestMs: 500, p50Ms: 500, p95Ms: 500, sampleCount: 1 },
      },
      wsToBookApplyMs: {
        kalshi: { latestMs: 4, p50Ms: 4, p95Ms: 4, sampleCount: 1 },
        polymarket: { latestMs: 6, p50Ms: 6, p95Ms: 6, sampleCount: 1 },
      },
      scanner: {
        scanDurationMs: { latestMs: 8, p50Ms: 8, p95Ms: 8, sampleCount: 1 },
        queueDepth: 1,
        activeExecutions: 1,
        lastScanStartedAt: generatedAt - 500,
        lastScanCompletedAt: generatedAt - 492,
        coalescedScanCount: 2,
        duplicateCandidateSkips: 1,
      },
      persistence: {
        insertMs: { latestMs: 3, p50Ms: 3, p95Ms: 3, sampleCount: 1 },
        updateMs: { latestMs: 4, p50Ms: 4, p95Ms: 4, sampleCount: 1 },
      },
      execution: {
        durationMs: { latestMs: 11, p50Ms: 11, p95Ms: 11, sampleCount: 1 },
      },
      dashboard: {
        snapshotBuildMs: { latestMs: 5, p50Ms: 5, p95Ms: 5, sampleCount: 1 },
        streamIntervalMs: 250,
        signalRefreshMs: 1_000,
        analyticsRefreshMs: 5_000,
        snapshotAgeMs: 0,
      },
    },
    books: {
      kalshi: [{
        venue: "kalshi",
        contractId: "fast-kalshi",
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
        contractId: "fast-poly",
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
    live: {
      recentSignals: defaultLiveSignals,
      analytics: defaultLiveAnalytics,
    },
    paper: {
      recentSignals: defaultPaperSignals,
      analytics: defaultPaperAnalytics,
    },
    recentSignals: defaultPaperSignals,
    analytics: defaultPaperAnalytics,
    logs: [],
    ...input,
  };
}

function liveExecution(input: Partial<NonNullable<DashboardSnapshot["execution"]>> = {}): NonNullable<DashboardSnapshot["execution"]> {
  const now = 1_800_000_010_000;
  return {
    mode: "live",
    liveTrading: true,
    protectedOnly: true,
    orderSize: 5,
    orderType: "GTC",
    maxSlippageCents: 1,
    minExpiryMs: 120_000,
    maxTradesPerWindow: 1,
    collateralBufferDollars: 0.25,
    quoteMaxAgeMs: 750,
    quoteSyncMaxSkewMs: 250,
    minBookDepthShares: 5,
    orderPlacementMode: "parallel_limit_rest",
    aggressiveLimitRestMs: 500,
    parallelExecutionEnabled: true,
    hotPathEnabled: true,
    hotPathCacheMaxAgeMs: 1_000,
    polymarketPresignEnabled: false,
    partialFillLockMode: "quarantine",
    autoHardlocksEnabled: true,
    maxUnresolvedExposureDollars: 10,
    orderTimeoutMs: 2_500,
    kalshiOrderGroupEnabled: true,
    userStreams: {
      enabled: true,
      ready: true,
      reason: null,
      confirmTimeoutMs: 2_500,
      kalshi: { enabled: true, connected: true, subscribed: true, reason: null, lastConnectedAt: now - 1_000, lastEventAt: now - 500, lastError: null },
      polymarket: { enabled: true, connected: true, subscribed: true, reason: null, lastConnectedAt: now - 1_000, lastEventAt: now - 500, lastError: null },
      lastUserStreamEventAt: now - 500,
      confirmationLagMs: 120,
    },
    reconciliation: {
      enabled: true,
      clean: true,
      reason: null,
      checkedAt: now - 250,
      lastReconciliationAt: now - 250,
      quarantinedExposureDollars: 0,
      quarantinedSignalCount: 0,
      quarantineCapDollars: 10,
    },
    riskState: "trading",
    riskStateReason: null,
    partialFillLocked: false,
    circuitBreakerLocked: false,
    circuitBreakerReason: null,
    circuitBreaker: null,
    kalshi: { configured: true, ready: true, reason: null, balance: 100, allowance: null, lastCheckedAt: now - 250 },
    polymarket: { configured: true, ready: true, reason: null, balance: 100, allowance: null, lastCheckedAt: now - 250, requiredCollateral: 5 },
    lastAttempt: null,
    ...input,
  };
}

test("dashboard password helper rejects unauthenticated access inputs", () => {
  process.env.DASHBOARD_PASSWORD = "operator";
  assert.equal(verifyDashboardPassword("operator"), true);
  assert.equal(verifyDashboardPassword("wrong"), false);
  assert.equal(isValidDashboardSession(undefined), false);
});

test("default dashboard view renders live and current paper sections together", () => {
  const now = snapshot().generatedAt;
  const liveSignal = signal({
    id: 77,
    executionMode: "live",
    kalshiFillId: "real-kalshi-order",
    polymarketFillId: "real-poly-order",
  });
  const paperSignal = signal({
    id: 42,
    executionMode: "paper",
    kalshiFillId: "dry-run-kalshi-paper",
    polymarketFillId: "dry-run-poly-paper",
  });
  const markup = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardName="POK Terminal"
      onDashboardRouteChange={() => undefined}
      snapshot={snapshot({
        live: { recentSignals: [liveSignal], analytics: buildDashboardAnalytics([liveSignal], now) },
        paper: { recentSignals: [paperSignal], analytics: buildDashboardAnalytics([paperSignal], now) },
      })}
      streamState="live"
    />,
  );

  assert.match(markup, /Live Trading Dashboard/);
  assert.match(markup, /Current Paper Trading Dashboard/);
  assert.match(markup, /View Live Only/);
  assert.match(markup, /View Paper Only/);
  assert.match(markup, /Show Both/);
  assert.match(markup, /Selected Dashboard/);
  assert.match(markup, /BOTH/);
  assert.match(markup, /Real trades only/);
  assert.match(markup, /Dry-run fills and simulated performance only/);
  assert.doesNotMatch(markup, /Switch Dashboard/);

  const liveTapeStart = markup.indexOf("Live Signal Tape");
  const paperTapeStart = markup.indexOf("Paper Signal Tape");
  assert.ok(liveTapeStart >= 0);
  assert.ok(paperTapeStart > liveTapeStart);

  const liveTapeMarkup = markup.slice(liveTapeStart, paperTapeStart);
  const paperTapeMarkup = markup.slice(paperTapeStart);
  assert.match(liveTapeMarkup, /real-kalshi-order/);
  assert.match(liveTapeMarkup, /real-poly-order/);
  assert.doesNotMatch(liveTapeMarkup, /dry-run-kalshi-paper/);
  assert.doesNotMatch(liveTapeMarkup, /dry-run-poly-paper/);
  assert.match(paperTapeMarkup, /dry-run-kalshi-paper/);
  assert.match(paperTapeMarkup, /dry-run-poly-paper/);
  assert.doesNotMatch(paperTapeMarkup, /real-kalshi-order/);
  assert.doesNotMatch(paperTapeMarkup, /real-poly-order/);
});

test("live dashboard strict-clean panel shows fully clean live state", () => {
  const markup = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardKind="live"
      dashboardName="POK Terminal"
      snapshot={snapshot({
        health: { ...snapshot().health, liveTrading: true, arbEnabled: true },
        execution: liveExecution(),
      })}
      streamState="live"
    />,
  );

  assert.match(markup, /Strict-clean live operational status/);
  assert.match(markup, /LIVE AND CLEAN/);
  assert.match(markup, /aria-label="Can take real trades: Yes"/);
  assert.match(markup, /aria-label="Clean: Yes"/);
  assert.match(markup, /Quarantined Exposure/);
  assert.match(markup, /\$0.00 \/ \$10.00/);
});

test("live dashboard strict-clean panel shows tradable quarantine as not clean", () => {
  const execution = liveExecution();
  const markup = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardKind="live"
      dashboardName="POK Terminal"
      snapshot={snapshot({
        health: { ...snapshot().health, liveTrading: true, arbEnabled: true },
        execution: {
          ...execution,
          riskState: "quarantined",
          riskStateReason: "trading with quarantined unresolved exposure 4.20 across 1 signal(s)",
          reconciliation: {
            ...execution.reconciliation,
            quarantinedExposureDollars: 4.2,
            quarantinedSignalCount: 1,
            quarantineCapDollars: 10,
          },
        },
      })}
      streamState="live"
    />,
  );

  assert.match(markup, /LIVE WITH QUARANTINED RISK/);
  assert.match(markup, /aria-label="Can take real trades: Yes"/);
  assert.match(markup, /aria-label="Clean: No"/);
  assert.match(markup, /\$4.20 \/ \$10.00/);
  assert.match(markup, /Latest risk reason: trading with quarantined unresolved exposure 4.20 across 1 signal\(s\)/);
});

test("live dashboard shows temporary auto-hardlock disablement as tradable but not clean", () => {
  const execution = liveExecution({
    autoHardlocksEnabled: false,
    riskState: "auto_hardlocks_disabled",
    riskStateReason: "temporary operator override: automatic hardlocks are disabled",
    reconciliation: {
      ...liveExecution().reconciliation,
      clean: false,
      reason: "live reconciliation blocked: signal #7 has unresolved venue status",
      quarantinedExposureDollars: 6.35,
      quarantinedSignalCount: 2,
      quarantineCapDollars: 10,
    },
  });
  const markup = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardKind="live"
      dashboardName="POK Terminal"
      snapshot={snapshot({
        health: { ...snapshot().health, liveTrading: true, arbEnabled: true, liveAutoHardlocksEnabled: false },
        execution,
      })}
      streamState="live"
    />,
  );

  assert.match(markup, /LIVE AUTO-HARDLOCKS DISABLED/);
  assert.match(markup, /aria-label="Can take real trades: Yes"/);
  assert.match(markup, /aria-label="Clean: No"/);
  assert.match(markup, /Auto Hardlocks/);
  assert.match(markup, /Disabled/);
  assert.match(markup, /AUTO HARDLOCKS OFF/);
});

test("live dashboard strict-clean panel blocks hard locks and degraded readiness", () => {
  const hardLocked = liveExecution({
    riskState: "hard_locked",
    circuitBreakerLocked: true,
    circuitBreakerReason: "manual hard lock for unresolved exposure",
  });
  const hardLockMarkup = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardKind="live"
      dashboardName="POK Terminal"
      snapshot={snapshot({
        health: { ...snapshot().health, liveTrading: true, arbEnabled: true },
        execution: hardLocked,
      })}
      streamState="live"
    />,
  );

  assert.match(hardLockMarkup, /BLOCKED/);
  assert.match(hardLockMarkup, /aria-label="Can take real trades: No"/);
  assert.match(hardLockMarkup, /Active Locks/);
  assert.match(hardLockMarkup, /Circuit breaker/);

  const degraded = liveExecution();
  const degradedMarkup = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardKind="live"
      dashboardName="POK Terminal"
      snapshot={snapshot({
        health: { ...snapshot().health, liveTrading: true, arbEnabled: true },
        execution: {
          ...degraded,
          kalshi: { ...degraded.kalshi, ready: false, reason: "Kalshi balance check is stale" },
        },
      })}
      streamState="live"
    />,
  );

  assert.match(degradedMarkup, /DEGRADED/);
  assert.match(degradedMarkup, /aria-label="Can take real trades: No"/);
  assert.match(degradedMarkup, /aria-label="Clean: No"/);
  assert.match(degradedMarkup, /Live is armed, but one or more readiness checks are not currently passing/);
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

test("book metric helpers compute spreads, freshness, readiness, and same-expiry comparisons", () => {
  const liveSnapshot = snapshot();
  const kalshiMetrics = buildBookMetrics(liveSnapshot.books.kalshi, liveSnapshot);
  assert.equal(kalshiMetrics.contractCount, 1);
  assert.equal(kalshiMetrics.freshestAgeMs, 500);
  assert.equal(kalshiMetrics.stalestAgeMs, 500);
  assert.equal(kalshiMetrics.staleCount, 0);
  assert.equal(kalshiMetrics.averageYesSpread, 0.01);
  assert.equal(kalshiMetrics.averageNoSpread, 0.01);
  assert.equal(kalshiMetrics.bestYesAsk, 0.5);
  assert.equal(kalshiMetrics.bestNoAsk, 0.5);
  assert.equal(kalshiMetrics.scannerReadyCount, 1);
  assert.equal(kalshiMetrics.health, "live");

  const staleSnapshot = snapshot({
    books: {
      kalshi: [{ ...liveSnapshot.books.kalshi[0], updatedAt: liveSnapshot.generatedAt - 30_000 }],
      polymarket: liveSnapshot.books.polymarket,
    },
  });
  const staleMetrics = buildBookMetrics(staleSnapshot.books.kalshi, staleSnapshot);
  assert.equal(staleMetrics.staleCount, 1);
  assert.equal(staleMetrics.scannerReadyCount, 0);
  assert.equal(staleMetrics.health, "stale");

  const row = buildBookRowViewModel(liveSnapshot.books.polymarket[0], liveSnapshot);
  assert.equal(row.yesSpread, 0.01);
  assert.equal(row.noSpread, 0.01);
  assert.equal(row.midpointProbability, 0.395);
  assert.equal(row.scannerReady, true);
  assert.equal(row.usedForArb, true);
  assert.equal(row.statusLabel, "fresh");

  const comparisons = buildCrossVenueBookComparisons(liveSnapshot);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].strikeGap, 2);
  assert.equal(comparisons[0].protectedPremium, 0.9);
  assert.equal(comparisons[0].deadZonePremium, 1.1);
  assert.equal(comparisons[0].classification, "protected_edge");
});

test("trade detail model normalizes protected and dead-zone payoff geometry", () => {
  assert.equal(normalizeBinaryPrice(40), 0.4);
  assert.equal(normalizeBinaryPrice(0.4), 0.4);

  const protectedDetail = buildTradeDetailModel("opportunity", candidate("protected", 0.1, 1_800_000_900_000));
  assert.equal(protectedDetail.structureLabel, "Protected Spread");
  assert.equal(protectedDetail.classification, "True Arb");
  assert.equal(protectedDetail.lowerStrike, 1500);
  assert.equal(protectedDetail.upperStrike, 1502);
  assert.equal(protectedDetail.strikeGap, 2);
  assert.equal(protectedDetail.strikeGapPct, 2 / 1500);
  assert.equal(protectedDetail.totalAskPremium, 0.9);
  assert.equal(protectedDetail.minimumPayout, 1);
  assert.equal(protectedDetail.worstCasePnl, 0.1);
  assert.equal(protectedDetail.bestCasePnl, 1.1);
  assert.equal(protectedDetail.lossWindowWidth, 0);
  assert.equal(protectedDetail.regions.find((region) => region.key === "between_strikes")?.isDoubleWin, true);

  const deadZoneDetail = buildTradeDetailModel("opportunity", probabilisticCandidate());
  assert.equal(deadZoneDetail.structureLabel, "Flipped / Dead-Zone");
  assert.equal(deadZoneDetail.classification, "Dead-Zone Risk");
  assert.equal(deadZoneDetail.minimumPayout, 0);
  assert.equal(deadZoneDetail.worstCasePnl, -0.9);
  assert.equal(deadZoneDetail.lossWindowWidth, 2);
  assert.equal(deadZoneDetail.regions.find((region) => region.key === "between_strikes")?.isDeadZone, true);
});

test("trade detail model uses signal fills for pnl and falls back when fields are missing", () => {
  const filledDetail = buildTradeDetailModel("signal", signal());
  assert.equal(filledDetail.premiumSource, "fill");
  assert.equal(filledDetail.totalAskPremium, 0.9);
  assert.equal(filledDetail.premiumForPnl, 0.92);
  assert.equal(filledDetail.worstCasePnl, 0.08);
  assert.equal(filledDetail.legA.fillPrice, 0.41);
  assert.equal(filledDetail.legB.fillPrice, 0.51);

  const missingDetail = buildTradeDetailModel("signal", {
    ...signal(),
    lower: { ...signal().lower, strike: Number.NaN, ask: Number.NaN },
    kalshiFillPrice: null,
    polymarketFillPrice: null,
  });
  assert.equal(missingDetail.lowerStrike, null);
  assert.equal(missingDetail.totalAskPremium, null);
  assert.equal(missingDetail.premiumSource, "unknown");
  assert.equal(missingDetail.regions[0].pnl, null);
});

test("risk intelligence scores protected spreads lower than dead-zone structures", () => {
  const protectedRisk = buildTradeRiskIntelligence(buildTradeDetailModel("opportunity", candidate("risk-protected", 0.1, 1_800_000_900_000)));
  const deadZoneRisk = buildTradeRiskIntelligence(buildTradeDetailModel("opportunity", probabilisticCandidate()));

  assert.equal(protectedRisk.riskLevel, "medium");
  assert.equal(protectedRisk.liquidityDepth, "ready");
  assert.equal(protectedRisk.volatilitySensitivity, "low");
  assert.ok(protectedRisk.confidence > deadZoneRisk.confidence);
  assert.ok(deadZoneRisk.riskScore > protectedRisk.riskScore);

  const meter = renderToStaticMarkup(<RiskMeter insights={{ estimatedEdge: 0.12, activeOpportunities: 2, feedLatencyMs: 500, lastScanAgeMs: 200, riskScore: 72, riskLevel: "high", staleBooks: 0 }} />);
  assert.match(meter, /Risk Meter/);
  assert.match(meter, /HIGH/);
  assert.match(meter, /72\/100/);
});

test("dashboard renders loading, degraded, and live terminal states", () => {
  const loading = renderToStaticMarkup(<DashboardTerminalView dashboardName="POK Terminal" snapshot={null} streamState="connecting" />);
  assert.match(loading, /Connecting to live terminal/);

  const degraded = renderToStaticMarkup(<DashboardTerminalView dashboardName="POK Terminal" snapshot={null} streamState="degraded" />);
  assert.match(degraded, /Worker stream unavailable/);

  const live = renderToStaticMarkup(<DashboardTerminalView dashboardName="POK Terminal" snapshot={snapshot()} streamState="live" />);
  assert.match(live, /polished-shell/);
  assert.match(live, /Opportunity Blotter/);
  assert.match(live, /Estimated Edge/);
  assert.match(live, /Active Opportunities/);
  assert.match(live, /Feed Latency/);
  assert.match(live, /Kalshi Age/);
  assert.match(live, /Polymarket Age/);
  assert.match(live, /Scan p95/);
  assert.match(live, /Exec p95/);
  assert.match(live, /Risk Meter/);
  assert.match(live, /Risk View/);
  assert.match(live, /Raw View/);
  assert.match(live, /Execution View/);
  assert.match(live, /aria-label="Dashboard sections"/);
  assert.match(live, /href="#opportunities"/);
  assert.match(live, /href="#risk-intelligence"/);
  assert.match(live, /href="#market-books"/);
  assert.match(live, /href="#signals"/);
  assert.match(live, /id="opportunities"/);
  assert.match(live, /id="risk-intelligence"/);
  assert.match(live, /id="market-books"/);
  assert.match(live, /Decision Engine/);
  assert.match(live, /Is there edge\?/);
  assert.match(live, /Where is risk\?/);
  assert.match(live, /What should I do\?/);
  assert.match(live, /Vol Sensitivity/);
  assert.match(live, /Spread \/ Profit/);
  assert.match(live, /Execution Risk/);
  assert.match(live, /Liquidity Proxy/);
  assert.match(live, /Scanner p95/);
  assert.match(live, /DB Insert p95/);
  assert.match(live, /Snapshot Build p95/);
  assert.match(live, /Latency Distribution/);
  assert.match(live, /Y-axis: Latency \(s\)/);
  assert.match(live, /Structure Type/);
  assert.match(live, /Strikes Lower \/ Upper/);
  assert.match(live, /Total Premium/);
  assert.match(live, /Guaranteed Profit/);
  assert.match(live, /Max Profit/);
  assert.match(live, /Risk Score/);
  assert.match(live, /Confidence/);
  assert.match(live, /data-label="Structure Type"/);
  assert.match(live, /data-label="Guaranteed Profit"/);
  assert.match(live, /data-label="Payoff"/);
  assert.match(live, /data-label="Yes Ask"/);
  assert.match(live, /data-label="Reason"/);
  assert.match(live, /<th>Payoff<\/th>/);
  assert.match(live, /inline-payoff-table/);
  assert.match(live, /aria-label="Live Opportunity inline payoff graph"/);
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
  assert.match(live, /YES \/ UP/);
  assert.match(live, /NO \/ DOWN/);
  assert.match(live, /Combined P\/L/);
  assert.match(live, /Y-axis: Payout \/ Net P\/L \(\$\)/);
  assert.match(live, /aria-label="Long Up Below \+ Long Down Above payoff curve"/);
  assert.match(live, /aria-label="Long Up Above \+ Long Down Below payoff curve"/);
  assert.match(live, /payoff-bonus-zone/);
  assert.match(live, /payoff-loss-zone/);
  assert.match(live, /Lower strike/);
  assert.match(live, /Higher strike/);
  assert.match(live, /Below lower/);
  assert.match(live, /Between strikes/);
  assert.match(live, /Above higher/);
  assert.match(live, /Executed Fill-Audit PnL/);
  assert.match(live, /Hourly/);
  assert.match(live, /Daily/);
  assert.match(live, /Weekly/);
  assert.match(live, /Win Rate/);
  assert.match(live, /Trades Won/);
  assert.match(live, /Loss Rate/);
  assert.match(live, /Trades Lost/);
  assert.match(live, /Profit Factor/);
  assert.match(live, /Sharpe Ratio/);
  assert.match(live, /Max Drawdown/);
  assert.match(live, /Avg Premium/);
  assert.match(live, /Avg Slippage/);
  assert.match(live, /Avg Fill Latency/);
  assert.match(live, /Opportunities/);
  assert.match(live, /Fill Rate/);
  assert.match(live, /Best Trade/);
  assert.match(live, /Worst Trade/);
  assert.match(live, /Realtime analytics freshness/);
  assert.match(live, /Mode/);
  assert.match(live, /Last Fill Update/);
  assert.match(live, /DB Reconcile Age/);
  assert.match(live, /Compute Time/);
  assert.match(live, /Source Signals/);
  assert.match(live, /Estimated Guaranteed PnL Graph/);
  assert.match(live, /Bucket PnL Bars/);
  assert.match(live, /Y-axis: Bucket PnL \(\$\)/);
  assert.match(live, /Drawdown Chart/);
  assert.match(live, /Y-axis: Drawdown \(\$\)/);
  assert.match(live, /Win\/Loss Distribution/);
  assert.match(live, /Slippage Histogram/);
  assert.match(live, /Latency Sparkline/);
  assert.match(live, /Y-axis: fill latency milliseconds/);
  assert.match(live, /Hourly\/Day Heatmap/);
  assert.match(live, /Opportunity frequency and edge density/);
  assert.match(live, /aria-label="Live venue books"/);
  assert.match(live, /Venue KPIs/);
  assert.match(live, /Freshest \/ Stalest/);
  assert.match(live, /Avg YES Spread/);
  assert.match(live, /Avg NO Spread/);
  assert.match(live, /Best YES Ask/);
  assert.match(live, /Best NO Ask/);
  assert.match(live, /Book p50 \/ p95/);
  assert.match(live, /WS Apply p95/);
  assert.match(live, /Live Top-of-Book Visuals/);
  assert.match(live, /Best YES bid\/ask/);
  assert.match(live, /Best NO bid\/ask/);
  assert.match(live, /aria-label="Spread-width heat strip"/);
  assert.match(live, /aria-label="Freshness pulse indicator"/);
  assert.match(live, /Strike Ladder/);
  assert.match(live, /YES Spread/);
  assert.match(live, /NO Spread/);
  assert.match(live, /Mid Prob/);
  assert.match(live, /scanner-ready/);
  assert.match(live, /Used for arb leg/);
  assert.match(live, /YES Ask Spark/);
  assert.match(live, /NO Ask Spark/);
  assert.match(live, /Spread Spark/);
  assert.match(live, /Cross-Venue Book Compare/);
  assert.match(live, /Protected premium/);
  assert.match(live, /Dead-zone premium/);
  assert.match(live, /protected edge/);
  assert.match(live, /Price-To-Beat Diagnostics/);
  assert.match(live, /aria-label="Signal and runtime activity"/);
  assert.match(live, /Live Signal Tape/);
  assert.match(live, /Event Tape/);
  assert.match(live, /role="button"/);
  assert.match(live, /Open payoff detail for/);
  assert.match(live, /SSE LIVE/);
  assert.match(live, /12c/);
});

test("live dashboard surfaces circuit breaker state and lock reason", () => {
  const base = snapshot();
  const lockReason = "live safety lock engaged: realized edge -0.1000 below threshold 0.0500";
  const liveLocked = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardKind="live"
      dashboardName="POK Terminal"
      snapshot={snapshot({
        health: { ...base.health, liveTrading: true, liveMaxTradesPerWindow: 1 },
        execution: {
          mode: "live",
          liveTrading: true,
          protectedOnly: true,
          orderSize: 5,
          orderType: "FOK",
          maxSlippageCents: 1,
          minExpiryMs: 30_000,
          maxTradesPerWindow: 1,
          collateralBufferDollars: 0.25,
          partialFillLocked: false,
          circuitBreakerLocked: true,
          circuitBreakerReason: lockReason,
          circuitBreaker: {
            id: 1,
            createdAt: "2026-04-29T20:00:00.000Z",
            reason: lockReason,
            severity: "critical",
            sourceSignalId: 42,
            executionGroupId: "group",
            details: {},
            clearedAt: null,
            clearReason: null,
          },
          kalshi: { configured: true, ready: true, reason: null, balance: null, allowance: null, lastCheckedAt: base.generatedAt },
          polymarket: { configured: true, ready: true, reason: null, balance: 7.45, allowance: null, lastCheckedAt: base.generatedAt, requiredCollateral: 4.8 },
          lastAttempt: {
            executionGroupId: "group",
            action: "failed",
            partialFill: false,
            failureReason: lockReason,
            liveLockReason: lockReason,
            kalshiStatus: "filled",
            polymarketStatus: "filled",
            completedAt: base.generatedAt,
          },
        },
      })}
      streamState="live"
    />,
  );

  assert.match(liveLocked, /CIRCUIT LOCK/);
  assert.match(liveLocked, /LOCK REASON/);
  assert.match(liveLocked, /realized edge -0.1000 below threshold 0.0500/);
  assert.match(liveLocked, /Read-Only Live Audit/);
  assert.match(liveLocked, /STREAM/);
});

test("analytics panel renders empty worker and no-trade states", () => {
  const base = snapshot();
  const noWorkerAnalytics = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardKind="paper"
      dashboardName="POK Terminal"
      snapshot={{ ...base, analytics: undefined, paper: { ...base.paper, analytics: undefined } }}
      streamState="live"
    />,
  );
  assert.match(noWorkerAnalytics, /The worker has not published paper analytics yet/);

  const noTrades = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardKind="paper"
      dashboardName="POK Terminal"
      snapshot={snapshot({ analytics: buildDashboardAnalytics([], snapshot().generatedAt), paper: { recentSignals: [], analytics: buildDashboardAnalytics([], snapshot().generatedAt) } })}
      streamState="live"
    />,
  );
  assert.match(noTrades, /No filled trades in the selected hourly window yet/);
});

test("signal tape renders detailed venue fills, timestamps, and failures", () => {
  const parallel = signal({
    executionStrategy: "parallel_canary",
    executionTimings: {
      firstVenue: null,
      firstVenueReason: "parallel orders submitted concurrently",
      firstVenueVwap: null,
      kalshiRttMs: 12,
      polymarketRttMs: 14,
    },
  });
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
      dashboardKind="paper"
      dashboardName="POK Terminal"
      snapshot={snapshot({ recentSignals: [parallel, failed] })}
      streamState="live"
    />,
  );

  assert.match(markup, /Signal #42/);
  assert.match(markup, /Open payoff detail for Signal #42/);
  assert.match(markup, /Inline payoff graph for Signal #42/);
  assert.match(markup, /Signal #42 inline payoff graph/);
  assert.match(markup, /inline-payoff-card/);
  assert.match(markup, /role="button"/);
  assert.match(markup, /Signal time/);
  assert.match(markup, /Finalized time/);
  assert.match(markup, /dateTime="2026-04-29T20:00:00.000Z"/);
  assert.match(markup, /Latency/);
  assert.match(markup, /1.3s/);
  assert.match(markup, /parallel canary/);
  assert.match(markup, /First Venue/);
  assert.match(markup, /BOTH/);
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
  assert.match(markup, /inline-double-win-zone/);
  assert.match(markup, /Lower \$1,500.00/);
  assert.match(markup, /Upper \$1,502.00/);
  assert.match(markup, /Combined P\/L/);
  assert.match(markup, /payoff-segment-profit/);
  assert.match(markup, /Failure: kalshi order rejected/);
});

test("live dashboard signal tape excludes paper simulated fills", () => {
  const liveSignal = signal({
    id: 88,
    executionMode: "live",
    kalshiFillId: "real-kalshi-order",
    polymarketFillId: "real-poly-order",
  });
  const paperSignal = signal({
    id: 42,
    executionMode: "paper",
    kalshiFillId: "dry-run-kalshi-paper",
    polymarketFillId: "dry-run-poly-paper",
  });
  const markup = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardKind="live"
      dashboardName="POK Terminal"
      snapshot={snapshot({
        live: { recentSignals: [liveSignal], analytics: buildDashboardAnalytics([liveSignal], snapshot().generatedAt) },
        paper: { recentSignals: [paperSignal], analytics: buildDashboardAnalytics([paperSignal], snapshot().generatedAt) },
      })}
      streamState="live"
    />,
  );

  assert.match(markup, /Live Signal Tape/);
  assert.match(markup, /real-kalshi-order/);
  assert.match(markup, /real-poly-order/);
  assert.doesNotMatch(markup, /dry-run-kalshi-paper/);
  assert.doesNotMatch(markup, /dry-run-poly-paper/);
});

test("live dashboard shows operator-resolved one-sided partials without labeling them as paired fills", () => {
  const resolvedPartial = signal({
    id: 14741,
    action: "failed",
    executionMode: "live",
    failureReason: "kalshi private stream confirmation timeout",
    partialFill: true,
    kalshiFillId: null,
    kalshiFillPrice: null,
    kalshiFillCount: 0,
    kalshiStatus: "no_order",
    polymarketFillId: "0x0d72905edc4468f43cb3b3faa59af7211ca0175368f65f57c499adb08284bf6f",
    polymarketFillPrice: 0.39,
    polymarketFillCount: 5,
    polymarketStatus: "filled",
    reconciliationResolvedAt: "2026-05-11T03:10:00.000Z",
    reconciliationResolutionReason: "manual recovery: verified Polymarket-only fill; Kalshi no-order/no-fill; market finalized",
    reconciliationResolution: {
      resolutionType: "settlement_reconciliation",
      executionGroupId: "6d105c10-ec31-47f2-8a32-cc169c7f94ed",
      polymarketOrderId: "0x0d72905edc4468f43cb3b3faa59af7211ca0175368f65f57c499adb08284bf6f",
      kalshiClientOrderId: "kalshi-dca90cf2-7618-44c4-a169-512cb644644c",
    },
  });
  const markup = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardKind="live"
      dashboardName="POK Terminal"
      snapshot={snapshot({
        live: { recentSignals: [resolvedPartial], analytics: buildDashboardAnalytics([], snapshot().generatedAt) },
      })}
      streamState="live"
    />,
  );

  assert.match(markup, /Signal #14741/);
  assert.match(markup, /resolved partial/);
  assert.match(markup, /Manual reconciliation:/);
  assert.match(markup, /verified Polymarket-only fill/);
  assert.match(markup, /39c/);
  assert.match(markup, /0x0d7290/);
  assert.doesNotMatch(markup, /action action-filled/);
});

test("paper dashboard signal tape excludes real live fills", () => {
  const liveSignal = signal({
    id: 88,
    executionMode: "live",
    kalshiFillId: "real-kalshi-order",
    polymarketFillId: "real-poly-order",
  });
  const paperSignal = signal({
    id: 42,
    executionMode: "paper",
    kalshiFillId: "dry-run-kalshi-paper",
    polymarketFillId: "dry-run-poly-paper",
  });
  const markup = renderToStaticMarkup(
    <DashboardTerminalView
      dashboardKind="paper"
      dashboardName="POK Terminal"
      snapshot={snapshot({
        live: { recentSignals: [liveSignal], analytics: buildDashboardAnalytics([liveSignal], snapshot().generatedAt) },
        paper: { recentSignals: [paperSignal], analytics: buildDashboardAnalytics([paperSignal], snapshot().generatedAt) },
      })}
      streamState="live"
    />,
  );

  assert.match(markup, /Paper Signal Tape/);
  assert.match(markup, /dry-run-kalshi-paper/);
  assert.match(markup, /dry-run-poly-paper/);
  assert.doesNotMatch(markup, /real-kalshi-order/);
  assert.doesNotMatch(markup, /real-poly-order/);
});

test("trade detail drawer renders detailed payoff diagram with protected and dead-zone shading", () => {
  const protectedMarkup = renderToStaticMarkup(
    <TradeDetailDrawer
      now={1_800_000_010_000}
      onClose={() => undefined}
      trade={buildTradeDetailModel("signal", signal())}
    />,
  );

  assert.match(protectedMarkup, /Selected trade payoff detail/);
  assert.match(protectedMarkup, /id="trade-detail"/);
  assert.match(protectedMarkup, /Signal #42/);
  assert.match(protectedMarkup, /Trade Snapshot/);
  assert.match(protectedMarkup, /Venue Legs/);
  assert.match(protectedMarkup, /2D Payoff Diagram/);
  assert.match(protectedMarkup, /Protected Spread/);
  assert.match(protectedMarkup, /True Arb/);
  assert.match(protectedMarkup, /trade-detail-snapshot-section/);
  assert.match(protectedMarkup, /trade-detail-legs-section/);
  assert.match(protectedMarkup, /trade-detail-payoff-section/);
  assert.match(protectedMarkup, /trade-detail-risk-section/);
  assert.match(protectedMarkup, /Contract A/);
  assert.match(protectedMarkup, /YES \/ UP/);
  assert.match(protectedMarkup, /NO \/ DOWN/);
  assert.match(protectedMarkup, /Gap % Lower/);
  assert.match(protectedMarkup, /P\/L Premium/);
  assert.match(protectedMarkup, /Minimum Payout/);
  assert.match(protectedMarkup, /Worst-case P\/L/);
  assert.match(protectedMarkup, /Guaranteed Edge/);
  assert.match(protectedMarkup, /Risk Score/);
  assert.match(protectedMarkup, /Confidence/);
  assert.match(protectedMarkup, /Spread \/ Profit/);
  assert.match(protectedMarkup, /Vol Sensitivity/);
  assert.match(protectedMarkup, /3D Risk Mapping/);
  assert.match(protectedMarkup, /X: price · Y: time · Z: P&amp;L/);
  assert.match(protectedMarkup, /3D risk surface/);
  assert.match(protectedMarkup, /Y-axis: time to expiry/);
  assert.match(protectedMarkup, /Z-axis: P&amp;L/);
  assert.match(protectedMarkup, /detail-leg-yes/);
  assert.match(protectedMarkup, /detail-leg-no/);
  assert.match(protectedMarkup, /detail-combined-line/);
  assert.match(protectedMarkup, /detail-strike-marker/);
  assert.match(protectedMarkup, /detail-double-win-zone/);
  assert.match(protectedMarkup, /detail-y-axis-label/);
  assert.match(protectedMarkup, /Y-axis: Payout \/ Net P\/L \(\$\)/);
  assert.doesNotMatch(protectedMarkup, /detail-dead-zone/);
  assert.match(protectedMarkup, /Below lower/);
  assert.match(protectedMarkup, /Between strikes/);
  assert.match(protectedMarkup, /Above upper/);

  const deadZoneMarkup = renderToStaticMarkup(
    <TradeDetailDrawer
      now={1_800_000_010_000}
      onClose={() => undefined}
      trade={buildTradeDetailModel("opportunity", probabilisticCandidate())}
    />,
  );

  assert.match(deadZoneMarkup, /Flipped \/ Dead-Zone/);
  assert.match(deadZoneMarkup, /Dead-Zone Risk/);
  assert.match(deadZoneMarkup, /detail-dead-zone/);
  assert.match(deadZoneMarkup, /Dead-zone loss window/);
});

test("inline trade payoff graph labels protected and dead-zone structures", () => {
  const protectedMarkup = renderToStaticMarkup(
    <InlineTradePayoffGraph trade={buildTradeDetailModel("opportunity", candidate("inline-protected", 0.1, 1_800_000_900_000))} variant="table" />,
  );
  assert.match(protectedMarkup, /inline-payoff-table/);
  assert.match(protectedMarkup, /Live Opportunity inline payoff graph/);
  assert.match(protectedMarkup, /Protected Spread/);
  assert.match(protectedMarkup, /True Arb/);
  assert.match(protectedMarkup, /YES \/ UP/);
  assert.match(protectedMarkup, /NO \/ DOWN/);
  assert.match(protectedMarkup, /Combined P\/L/);
  assert.match(protectedMarkup, /inline-y-axis-label/);
  assert.match(protectedMarkup, /Y-axis: Payout \/ Net P\/L \(\$\)/);
  assert.match(protectedMarkup, /Below lower/);
  assert.match(protectedMarkup, /Between strikes/);
  assert.match(protectedMarkup, /Above upper/);
  assert.match(protectedMarkup, /Lower \$1,500.00/);
  assert.match(protectedMarkup, /Upper \$1,502.00/);
  assert.match(protectedMarkup, /inline-double-win-zone/);
  assert.doesNotMatch(protectedMarkup, /inline-dead-zone/);

  const deadZoneMarkup = renderToStaticMarkup(
    <InlineTradePayoffGraph trade={buildTradeDetailModel("opportunity", probabilisticCandidate())} variant="card" />,
  );
  assert.match(deadZoneMarkup, /inline-payoff-card/);
  assert.match(deadZoneMarkup, /Flipped \/ Dead-Zone/);
  assert.match(deadZoneMarkup, /Dead-Zone Risk/);
  assert.match(deadZoneMarkup, /Dead-zone/);
  assert.match(deadZoneMarkup, /inline-dead-zone/);
});
