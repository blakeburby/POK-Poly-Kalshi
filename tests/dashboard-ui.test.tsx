import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DashboardTerminalView,
  RiskMeter,
  buildCombinedAccountPnlCurve,
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
import type { ArbCandidate, BinaryContract, DashboardSignal, DashboardSnapshot, UserStreamVenueState } from "../src/types";
import type { TradingActivitySnapshot } from "../types/trading";

const generatedAt = 1_800_000_010_000;

function candidate(pairKey = "pair-live", guaranteedProfit = 0.1): ArbCandidate {
  const lower = { venue: "polymarket" as const, contractId: `${pairKey}-poly`, direction: "yes" as const, strike: 1500, ask: 0.4 };
  const higher = { venue: "kalshi" as const, contractId: `${pairKey}-kalshi`, direction: "no" as const, strike: 1502, ask: 0.5 };
  return {
    pairKey,
    expiryMs: generatedAt + 900_000,
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

function venueContract(input: Partial<BinaryContract> & { venue: "kalshi" | "polymarket"; contractId: string; strike: number }): BinaryContract {
  return {
    venue: input.venue,
    contractId: input.contractId,
    asset: "BTC",
    expiryMs: generatedAt + 900_000,
    strike: input.strike,
    yesAsk: input.yesAsk ?? 0.4,
    noAsk: input.noAsk ?? 0.5,
    yesBid: input.yesBid ?? 0.39,
    noBid: input.noBid ?? 0.49,
    yesAskLevels: [{ price: input.yesAsk ?? 0.4, size: 50 }],
    noAskLevels: [{ price: input.noAsk ?? 0.5, size: 50 }],
    yesBidLevels: [{ price: input.yesBid ?? 0.39, size: 50 }],
    noBidLevels: [{ price: input.noBid ?? 0.49, size: 50 }],
    sequence: input.sequence ?? 1,
    bookHash: input.bookHash ?? "hash",
    tickSize: input.tickSize ?? 0.01,
    tickSizeChangedAt: input.tickSizeChangedAt ?? null,
    yesTokenId: input.yesTokenId ?? `${input.contractId}-yes`,
    noTokenId: input.noTokenId ?? `${input.contractId}-no`,
    updatedAt: input.updatedAt ?? generatedAt - 500,
  };
}

function signal(input: Partial<DashboardSignal> = {}): DashboardSignal {
  return {
    id: 42,
    createdAt: new Date(generatedAt - 1_500).toISOString(),
    updatedAt: new Date(generatedAt - 500).toISOString(),
    pairKey: "pair-live",
    expiryMs: generatedAt + 900_000,
    kalshiContractId: "pair-live-kalshi",
    polymarketContractId: "pair-live-poly",
    lower: { venue: "polymarket", contractId: "pair-live-poly", direction: "yes", strike: 1500, ask: 0.4 },
    higher: { venue: "kalshi", contractId: "pair-live-kalshi", direction: "no", strike: 1502, ask: 0.5 },
    premium: 0.9,
    guaranteedProfit: 0.1,
    overlapProfit: 1.1,
    threshold: 0.05,
    action: "filled",
    failureReason: null,
    kalshiFillId: "real-kalshi-order",
    polymarketFillId: "real-poly-order",
    kalshiFillPrice: 0.51,
    polymarketFillPrice: 0.41,
    executionGroupId: "group-live",
    executionStrategy: "parallel_fok",
    kalshiFillCount: 5,
    polymarketFillCount: 5,
    partialFill: false,
    risk: buildSyntheticStructureRisk(
      { venue: "polymarket", contractId: "pair-live-poly", direction: "yes", strike: 1500, ask: 0.4 },
      { venue: "kalshi", contractId: "pair-live-kalshi", direction: "no", strike: 1502, ask: 0.5 },
      0.05,
    ),
    ...input,
  };
}

function streamVenue(input: Partial<UserStreamVenueState> = {}): UserStreamVenueState {
  return {
    enabled: true,
    connected: true,
    subscribed: true,
    reason: null,
    lastConnectedAt: generatedAt - 2_000,
    lastEventAt: generatedAt - 1_000,
    lastError: null,
    ...input,
  };
}

function tradingActivity(): TradingActivitySnapshot {
  return {
    kalshi: {
      platform: "kalshi",
      connectionStatus: "live",
      lastUpdatedAt: generatedAt - 30_000,
      portfolio: {
        platform: "kalshi",
        portfolioValue: 124.2,
        cashValue: 98.4,
        dayChangeDollars: 5.2,
        dayChangePercent: 0.043,
        lastUpdatedAt: generatedAt - 30_000,
      },
      positions: [{ id: "kalshi-position", market: "KXBTC15M", outcome: "NO", shares: 5, value: 2.55, averagePrice: 0.51, updatedAt: generatedAt - 1_000 }],
      openOrders: [],
      history: [{
        id: "kalshi-history",
        activity: "Buy",
        marketName: "KXBTC15M",
        outcome: "NO",
        shares: 5,
        value: -2.55,
        timeMs: generatedAt - 7 * 60_000,
        venueOrderId: "real-kalshi-order",
        clientOrderId: "kalshi-client",
        status: "filled",
      }],
      sparkline: [
        { timestamp: generatedAt - 24 * 60 * 60_000, value: 119 },
        { timestamp: generatedAt - 7 * 60_000, value: 124.2 },
      ],
    },
    polymarket: {
      platform: "polymarket",
      connectionStatus: "live",
      lastUpdatedAt: generatedAt - 20_000,
      portfolio: {
        platform: "polymarket",
        portfolioValue: 88.8,
        cashValue: 80.5,
        dayChangeDollars: -2.05,
        dayChangePercent: -0.023,
        lastUpdatedAt: generatedAt - 20_000,
      },
      positions: [{ id: "poly-position", market: "btc-updown-15m", outcome: "YES", shares: 5, value: 2.05, averagePrice: 0.41, updatedAt: generatedAt - 1_000 }],
      openOrders: [],
      history: [{
        id: "poly-history",
        activity: "Buy",
        marketName: "btc-updown-15m",
        outcome: "YES",
        shares: 5,
        value: -2.05,
        timeMs: generatedAt - 7 * 60_000,
        venueOrderId: "real-poly-order",
        clientOrderId: "poly-client",
        status: "matched",
      }],
      sparkline: [
        { timestamp: generatedAt - 24 * 60 * 60_000, value: 91 },
        { timestamp: generatedAt - 7 * 60_000, value: 88.8 },
      ],
    },
  };
}

function snapshot(input: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  const signals = input.recentSignals ?? [signal()];
  return {
    generatedAt,
    health: {
      ok: true,
      liveTrading: true,
      arbEnabled: true,
      minProfitDollars: 0.01,
      reentryIntervalMs: 15_000,
      scanHeartbeatMs: 250,
      staleBookMs: 10_000,
      liveMaxTradesPerWindow: 3,
      liveTakerPriceCushionCents: 2,
      liveQuoteMaxAgeMs: 750,
      liveQuoteSyncMaxSkewMs: 250,
      liveMinBookDepthShares: 5,
      liveOrderTimeoutMs: 2_500,
      liveHedgeMaxLossDollars: 0.02,
      liveHedgeFeeBufferDollars: 0.01,
      liveOrderPlacementMode: "parallel_fok",
      liveAggressiveLimitRestMs: 500,
      liveParallelExecutionEnabled: true,
      liveHotPathEnabled: true,
      liveHotPathCacheMaxAgeMs: 5_000,
      liveHotPathWarmIntervalMs: 1_000,
      livePolymarketPresignEnabled: false,
      livePolymarketSignedOrderTtlMs: 5_000,
      livePolymarketFirstMinFillShares: 7,
      livePolymarketFirstMaxFillShares: 9,
      liveLowLatencyHttpEnabled: true,
      liveUserStreamsEnabled: true,
      liveUserStreamPretradeGraceMs: 750,
      liveUserStreamConfirmTimeoutMs: 2_500,
      livePretradeRetryAttempts: 2,
      livePretradeRetryDelayMs: 100,
      liveFinalRecoveryTimeoutMs: 3_000,
      liveFinalRecoveryPollMs: 250,
      liveAutoResolveVerifiedIncidents: true,
      liveAutoHardlocksEnabled: true,
      liveExactExposureRequired: false,
      liveExecutionQualityGateEnabled: true,
      liveExecutionQualityLookbackMs: 30 * 60 * 1_000,
      liveExecutionQualitySampleLimit: 50,
      liveExecutionQualityMinSamples: 5,
      liveExecutionQualityMinExactFillRate: 0.4,
      liveFillQualityScoringEnabled: true,
      liveFillQualityGateEnabled: false,
      liveFillQualityMinExpectedEdge: 0.01,
      liveFillQualityLookbackMs: 30 * 60 * 1_000,
      liveFillQualitySampleLimit: 200,
      liveFillQualityMinSamples: 30,
      liveFillQualityModelVersion: "heuristic-v1",
      liveLeadLagScoringEnabled: true,
      liveLeadLagGateEnabled: false,
      liveLeadLagModelVersion: "heuristic-v1",
      liveLeadLagWindowsMs: [1_000, 5_000, 15_000, 60_000],
      liveLeadLagMinConfidence: 0.65,
      liveLeadLagMaxAdverseSelectionScore: 0.75,
      livePartialFillLockMode: "quarantine",
      liveMaxUnresolvedExposureDollars: 10,
      liveReconcileBeforeTrade: true,
      ...input.health,
    },
    latency: input.latency,
    discovery: input.discovery ?? { lastDiscoveryAt: generatedAt - 2_000, lastDiscoveryError: null },
    scanner: input.scanner ?? { scanning: false, lastScanAt: generatedAt - 1_000, lastCandidateCount: 1, queuedExecutions: 0, activeExecutions: 0 },
    books: input.books ?? {
      kalshi: [venueContract({ venue: "kalshi", contractId: "pair-live-kalshi", strike: 1502 })],
      polymarket: [venueContract({ venue: "polymarket", contractId: "pair-live-poly", strike: 1500 })],
    },
    diagnostics: input.diagnostics ?? {
      polymarket: {
        marketsFound: 1,
        readyContracts: 1,
        pendingStrikeCount: 0,
        missingStrikeCount: 0,
        invalidMarketCount: 0,
        lastChainlinkTickAt: generatedAt - 1_000,
        lastChainlinkTickAgeMs: 1_000,
        nextCaptureWindowStartMs: null,
        skippedReasons: [],
        markets: [],
      },
    },
    liveCandidates: input.liveCandidates ?? [candidate()],
    syntheticStructures: input.syntheticStructures ?? [candidate()],
    recentSignals: signals,
    analytics: input.analytics ?? buildDashboardAnalytics(signals, generatedAt),
    tradingActivity: input.tradingActivity ?? tradingActivity(),
    execution: input.execution ?? {
      mode: "live",
      liveTrading: true,
      protectedOnly: true,
      orderSize: 5,
      orderType: "FOK",
      takerPriceCushionCents: 2,
      minExpiryMs: 60_000,
      maxTradesPerWindow: 3,
      collateralBufferDollars: 0.25,
      quoteMaxAgeMs: 750,
      quoteSyncMaxSkewMs: 250,
      minBookDepthShares: 5,
      hedgeMaxLossDollars: 0.02,
      hedgeFeeBufferDollars: 0.01,
      orderPlacementMode: "parallel_fok",
      aggressiveLimitRestMs: 500,
      parallelExecutionEnabled: true,
      hotPathEnabled: true,
      hotPathCacheMaxAgeMs: 5_000,
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
        kalshi: streamVenue(),
        polymarket: streamVenue(),
        lastUserStreamEventAt: generatedAt - 1_000,
        confirmationLagMs: 120,
      },
      reconciliation: {
        enabled: true,
        clean: true,
        reason: null,
        checkedAt: generatedAt - 500,
        lastReconciliationAt: generatedAt - 500,
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
      kalshi: { configured: true, ready: true, reason: null, balance: 20, allowance: null, lastCheckedAt: generatedAt - 500 },
      polymarket: { configured: true, ready: true, reason: null, balance: 20, allowance: 20, lastCheckedAt: generatedAt - 500, collateralBalanceNormalized: 20, requiredCollateral: 5 },
      lastAttempt: null,
    },
    logs: input.logs ?? [{ timestamp: new Date(generatedAt).toISOString(), severity: "INFO", category: "SCANNER", message: "ok" }],
  };
}

function render(input: Partial<DashboardSnapshot> = {}): string {
  return renderToStaticMarkup(
    <DashboardTerminalView
      dashboardName="POK Cross-Venue Terminal"
      snapshot={snapshot(input)}
      streamState="live"
    />,
  );
}

test("password session helpers validate configured credentials", () => {
  const previousPassword = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = "secret";
  try {
    assert.equal(verifyDashboardPassword("secret"), true);
    assert.equal(verifyDashboardPassword("wrong"), false);
    const issuedAt = String(generatedAt);
    const signature = createHmac("sha256", "secret").update(issuedAt).digest("base64url");
    assert.equal(isValidDashboardSession(`${issuedAt}.${signature}`, generatedAt + 1_000), true);
    assert.equal(isValidDashboardSession(`${issuedAt}.bad`, generatedAt + 1_000), false);
  } finally {
    if (previousPassword == null) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = previousPassword;
  }
});

test("live-only dashboard renders one live command surface", () => {
  const markup = render();
  assert.match(markup, /Live Trading Dashboard/);
  assert.match(markup, /Trading Activity/);
  assert.match(markup, /Kalshi/);
  assert.match(markup, /Polymarket/);
  assert.match(markup, /Activity/);
  assert.match(markup, /Market/);
  assert.match(markup, /Value/);
  assert.match(markup, /7m ago/);
  assert.match(markup, /Live Signal Tape/);
  assert.match(markup, /LIVE ONLY/);
  assert.match(markup, /Executed Fill-Audit PnL/);
  assert.match(markup, /Exchange fills only\. \$1 floor\. Not settlement PnL\./);
  assert.match(markup, /PNL/);
  assert.match(markup, /EDGE/);
  assert.match(markup, /FILL/);
  assert.match(markup, /Details/);
  assert.doesNotMatch(markup, /Signal time/);
  assert.doesNotMatch(markup, /Finalized time/);
  assert.doesNotMatch(markup, /Pair Key/);

  const detail = buildTradeDetailModel("signal", snapshot().recentSignals[0]);
  assert.match(JSON.stringify(detail), /real-kalshi-order/);
  assert.match(JSON.stringify(detail), /real-poly-order/);

  for (const forbidden of [
    "Current " + "Pa" + "per Trading Dashboard",
    "Opportunity Blotter",
    "Synthetic Strangle Map",
    "PROBABILISTIC DEAD ZONE",
    "Long Up Above + Long Down Below",
    "Pair Monitor",
    "Cross-Venue Book Compare",
    "Polymarket Hydration",
    "Price-To-Beat Diagnostics",
    "Risk Intelligence",
    "Decision Engine",
    "Risk Meter",
    "Estimated Edge",
    "Active Opportunities",
  ]) {
    assert.doesNotMatch(markup.toLowerCase(), new RegExp(forbidden.toLowerCase()));
  }
});

test("dashboard sections are collapsible and trading rows are mobile-labeled", () => {
  const markup = render();

  for (const id of ["system-snapshot", "performance", "trading-activity", "analytics", "signals", "events"]) {
    assert.match(markup, new RegExp(`<details[^>]+id="${id}"[^>]+open=""`));
  }

  assert.match(markup, /dashboard-collapsible-summary/);
  assert.match(markup, /collapse-open/);
  assert.match(markup, /collapse-closed/);
  assert.match(markup, /trading-account-card/);
  assert.match(markup, /trading-sparkline/);
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /data-label="Activity"/);
  assert.match(markup, /data-label="Market"/);
  assert.match(markup, /data-label="Value"/);
  assert.match(markup, /data-label="Time"/);
});

test("performance analytics count only exact paired live fills", () => {
  const exactSignal = signal({ id: 1, executionGroupId: "real-group-1", kalshiFillId: "real-kalshi-1", polymarketFillId: "real-poly-1", kalshiFillCount: 5, polymarketFillCount: 5 });
  const markup = render({
    recentSignals: [
      exactSignal,
      signal({ id: 2, action: "failed", executionGroupId: "real-failed", kalshiFillId: null, polymarketFillId: null, kalshiFillCount: 0, polymarketFillCount: 0 }),
      signal({ id: 3, executionGroupId: "legacy-dry-run", kalshiFillId: "dry-run-kalshi-3", polymarketFillId: "dry-run-poly-3", kalshiFillCount: 5, polymarketFillCount: 5, kalshiFillPrice: 0.1, polymarketFillPrice: 0.1 }),
      signal({ id: 4, executionGroupId: "mismatch-group", kalshiFillId: "real-kalshi-4", polymarketFillId: "real-poly-4", kalshiFillCount: 5, polymarketFillCount: 0, partialFill: true }),
    ],
    analytics: buildDashboardAnalytics([
      signal({ id: 1, executionGroupId: "real-group-1", kalshiFillId: "real-kalshi-1", polymarketFillId: "real-poly-1", kalshiFillCount: 5, polymarketFillCount: 5 }),
      signal({ id: 3, executionGroupId: "legacy-dry-run", kalshiFillId: "dry-run-kalshi-3", polymarketFillId: "dry-run-poly-3", kalshiFillCount: 5, polymarketFillCount: 5, kalshiFillPrice: 0.1, polymarketFillPrice: 0.1 }),
    ], generatedAt),
  });

  assert.match(markup, /Real Live Fills<\/span><strong>1<\/strong>/);
  assert.match(markup, /Audited Fills<\/span><strong>1<\/strong>/);
  assert.match(markup, /#1/);
  assert.match(JSON.stringify(buildTradeDetailModel("signal", exactSignal)), /real-kalshi-1/);
  assert.match(JSON.stringify(buildTradeDetailModel("signal", exactSignal)), /real-poly-1/);
  assert.doesNotMatch(markup, /dry-run-kalshi-3/);
  assert.doesNotMatch(markup, /dry-run-poly-3/);
  assert.doesNotMatch(markup, /legacy-dry-run/);
});

test("signal details render compact fill-quality metadata", () => {
  const detail = buildTradeDetailModel("signal", signal({
    expectedExecutableEdge: 0.0142,
    fillQualitySnapshot: {
      version: "heuristic-v1",
      scoredAt: generatedAt,
      shadowMode: true,
      gateEnabled: false,
      gatePassed: true,
      blockReason: null,
      projectedEdgeAtLimit: 0.04,
      expectedExecutableEdge: 0.0142,
      minExpectedEdge: 0.01,
      pairedFillProbability: 0.61,
      kalshiExactFillProbability: 0.91,
      polymarketExactFillProbability: 0.67,
      expectedSlippage: 0.001,
      expectedMismatchCost: 0.004,
      timeoutCost: 0.002,
      penaltyReasons: ["Polymarket p95 RTT is near timeout", "Recent mismatch rate is elevated"],
      features: {
        sampleCount: 40,
        minSamples: 30,
        coldStart: false,
        orderSize: 5,
        placementMode: "polymarket_first_exact",
        kalshiDepth: 20,
        polymarketDepth: 20,
        kalshiDepthRatio: 4,
        polymarketDepthRatio: 4,
        kalshiSpread: 0.02,
        polymarketSpread: 0.02,
        kalshiQuoteAgeMs: 50,
        polymarketQuoteAgeMs: 50,
        quoteSkewMs: 20,
        secondsToExpiry: 600,
        sameExpiryAttemptCount: 1,
        recentExactPairFillRate: 0.45,
        recentMismatchRate: 0.3,
        recentTimeoutRate: 0.1,
        kalshiRecentExactFillRate: 0.91,
        polymarketRecentExactFillRate: 0.67,
        kalshiRttP50Ms: 100,
        kalshiRttP95Ms: 220,
        polymarketRttP50Ms: 900,
        polymarketRttP95Ms: 2300,
        kalshiConfirmationP95Ms: 180,
        polymarketConfirmationP95Ms: 2100,
        polymarketSignedOrderReuseRate: 0.85,
        polymarketSignedOrderFallbackRate: 0.05,
        recentVenueEventCount: 12,
      },
    },
  }));
  const rendered = JSON.stringify(detail);
  assert.match(rendered, /Fill Quality/);
  assert.match(rendered, /shadow · XEV \+1c · Pair 61\.0%/);
  assert.match(rendered, /Fill Penalty/);
  assert.match(rendered, /Polymarket p95 RTT is near timeout/);
});

test("signal details warn when shadow fill-quality expected edge is below threshold", () => {
  const detail = buildTradeDetailModel("signal", signal({
    expectedExecutableEdge: 0.004,
    fillQualitySnapshot: {
      version: "heuristic-v1",
      scoredAt: generatedAt,
      shadowMode: true,
      gateEnabled: false,
      gatePassed: true,
      blockReason: null,
      projectedEdgeAtLimit: 0.03,
      expectedExecutableEdge: 0.004,
      minExpectedEdge: 0.01,
      pairedFillProbability: 0.33,
      kalshiExactFillProbability: 0.9,
      polymarketExactFillProbability: 0.37,
      expectedSlippage: 0.001,
      expectedMismatchCost: 0.012,
      timeoutCost: 0.004,
      penaltyReasons: ["Recent mismatch rate is elevated"],
      features: {
        sampleCount: 60,
        minSamples: 30,
        coldStart: false,
        orderSize: 8,
        placementMode: "polymarket_first_exact",
        kalshiDepth: 10,
        polymarketDepth: 10,
        kalshiDepthRatio: 1.25,
        polymarketDepthRatio: 1.25,
        kalshiSpread: 0.02,
        polymarketSpread: 0.02,
        kalshiQuoteAgeMs: 50,
        polymarketQuoteAgeMs: 50,
        quoteSkewMs: 20,
        secondsToExpiry: 600,
        sameExpiryAttemptCount: 1,
        recentExactPairFillRate: 0.18,
        recentMismatchRate: 0.5,
        recentTimeoutRate: 0.2,
        kalshiRecentExactFillRate: 0.9,
        polymarketRecentExactFillRate: 0.37,
        kalshiRttP50Ms: 100,
        kalshiRttP95Ms: 220,
        polymarketRttP50Ms: 900,
        polymarketRttP95Ms: 2300,
        kalshiConfirmationP95Ms: 180,
        polymarketConfirmationP95Ms: 2100,
        polymarketSignedOrderReuseRate: 0.85,
        polymarketSignedOrderFallbackRate: 0.05,
        recentVenueEventCount: 12,
      },
    },
  }));
  const rendered = JSON.stringify(detail);
  assert.match(rendered, /Fill Quality/);
  assert.match(rendered, /warning · XEV/);
  assert.match(rendered, /Pair 33\.0%/);
});

test("signal details render compact lead-lag metadata", () => {
  const detail = buildTradeDetailModel("signal", signal({
    leadLagSnapshot: {
      version: "heuristic-v1",
      scoredAt: generatedAt,
      shadowMode: true,
      gateEnabled: false,
      gatePassed: true,
      blockReason: null,
      leaderVenue: "polymarket",
      laggingVenue: "kalshi",
      lagMsEstimate: 118,
      confidence: 0.82,
      stalenessScore: 0.12,
      adverseSelectionScore: 0.74,
      cheapLegVenue: "polymarket",
      cheapLegIsLagging: false,
      windows: [],
      reasons: ["Polymarket appears to lead recent book movement", "Both venue microprices moved against entry"],
    },
  }));
  const rendered = JSON.stringify(detail);
  assert.match(rendered, /Lead\/Lag/);
  assert.match(rendered, /shadow · leader P · conf 82\.0% · stale 12\.0% · adverse 74\.0% · cheap lag no/);
  assert.match(rendered, /Lead\/Lag Note/);
  assert.match(rendered, /Polymarket appears to lead/);
});

test("signal details warn when shadow lead-lag would fail the simulated gate", () => {
  const detail = buildTradeDetailModel("signal", signal({
    leadLagSnapshot: {
      version: "heuristic-v1",
      scoredAt: generatedAt,
      shadowMode: true,
      gateEnabled: false,
      gatePassed: true,
      blockReason: null,
      leaderVenue: "polymarket",
      laggingVenue: "kalshi",
      lagMsEstimate: 104,
      confidence: 0.86,
      stalenessScore: 0.08,
      adverseSelectionScore: 0.82,
      cheapLegVenue: "polymarket",
      cheapLegIsLagging: false,
      windows: [],
      reasons: ["Polymarket appears to lead recent book movement"],
    },
  }));
  const rendered = JSON.stringify(detail);
  assert.match(rendered, /Lead\/Lag/);
  assert.match(rendered, /warning · leader P · conf 86\.0% · stale 8\.0% · adverse 82\.0% · cheap lag no/);
});

test("cumulative pnl curve uses combined account values instead of fill-audit pnl", () => {
  const signals = [
    signal({ id: 71, kalshiFillPrice: 0.51, polymarketFillPrice: 0.41 }),
  ];
  const analytics = buildDashboardAnalytics(signals, generatedAt);
  const activity = tradingActivity();
  activity.kalshi.sparkline[0].timestamp = analytics.hourly.sinceMs;
  activity.polymarket.sparkline[0].timestamp = analytics.hourly.sinceMs;
  activity.polymarket.portfolio.dayChangeDollars = -2.2;
  const curve = buildCombinedAccountPnlCurve(activity, analytics.hourly, generatedAt);
  const markup = render({ recentSignals: signals, analytics, tradingActivity: activity });

  assert.equal(curve.netPnl, 3);
  assert.equal(curve.latestAccountValue, 213);
  assert.match(markup, /Account P\/L Curve/);
  assert.match(markup, /Kalshi \+ Polymarket/);
  assert.match(markup, /Wallet Change<\/span><strong class="profit">\+\$3\.00<\/strong>/);
  assert.match(markup, /Wallet Value<\/span><strong>\$213\.00<\/strong>/);
  assert.doesNotMatch(markup, /Cumulative estimated PnL/);
});

test("signal tape stays compact while retaining filled, failed, partial, quarantined, and resolved details", () => {
  const signals = [
    signal({ id: 11, action: "filled", executionGroupId: "group-11", kalshiFillId: "real-kalshi-11", polymarketFillId: "real-poly-11" }),
    signal({ id: 12, action: "failed", executionGroupId: "group-12", failureReason: "fok not matched", kalshiFillCount: 0, polymarketFillCount: 0, kalshiFillId: null, polymarketFillId: null }),
    signal({ id: 13, action: "failed", executionGroupId: "group-13", partialFill: true, failureReason: "one-sided fill", kalshiFillId: "real-kalshi-13", polymarketFillId: null, kalshiFillCount: 5, polymarketFillCount: 0 }),
    signal({ id: 14, action: "failed", executionGroupId: "group-14", partialFill: true, riskQuarantinedAt: new Date(generatedAt - 200).toISOString(), riskQuarantineReason: "under cap", riskQuarantineExposureDollars: 4.2, kalshiFillId: null, polymarketFillId: "real-poly-14", kalshiFillCount: 0, polymarketFillCount: 5 }),
    signal({ id: 15, action: "failed", executionGroupId: "group-15", partialFill: true, reconciliationResolvedAt: new Date(generatedAt - 100).toISOString(), reconciliationResolutionReason: "operator resolved", kalshiFillId: "real-kalshi-15", polymarketFillId: null, kalshiFillCount: 5, polymarketFillCount: 0 }),
  ];
  const markup = render({ recentSignals: signals, analytics: buildDashboardAnalytics(signals, generatedAt) });

  for (const id of [11, 12, 13, 14, 15]) {
    assert.match(markup, new RegExp(`#${id}`));
  }
  assert.match(markup, /FAILED/);
  assert.match(markup, /PARTIAL/);
  assert.match(markup, /QUAR/);
  assert.match(markup, /RESOLVED/);
  assert.doesNotMatch(markup, /Signal time/);
  assert.doesNotMatch(markup, /Loss Window/);
  assert.doesNotMatch(markup, /Inline payoff graph/);

  const detailJson = JSON.stringify(buildTradeDetailModel("signal", signals[4]));
  assert.match(detailJson, /real-kalshi-15/);
  assert.match(detailJson, /operator resolved/);
});

test("strict-clean live states distinguish clean, quarantined, and blocked", () => {
  assert.match(render(), /LIVE AND CLEAN/);
  assert.match(render(), /Can take real trades.*?Yes/s);
  assert.match(render(), /Clean.*?Yes/s);

  const quarantined = render({
    execution: {
      ...snapshot().execution!,
      riskState: "quarantined",
      reconciliation: {
        ...snapshot().execution!.reconciliation,
        quarantinedExposureDollars: 4.2,
        quarantinedSignalCount: 1,
      },
    },
  });
  assert.match(quarantined, /LIVE WITH QUARANTINED RISK/);
  assert.match(quarantined, /Can take real trades.*?Yes/s);
  assert.match(quarantined, /Clean.*?No/s);

  const blocked = render({
    execution: {
      ...snapshot().execution!,
      riskState: "hard_locked",
      circuitBreakerLocked: true,
      circuitBreakerReason: "operator lock",
    },
  });
  assert.match(blocked, /BLOCKED/);
  assert.match(blocked, /Can take real trades.*?No/s);
});

test("dashboard utility view models still normalize books and risk", () => {
  const base = snapshot();
  const [kalshi] = base.books.kalshi;
  assert.equal(normalizeBinaryPrice(40), 0.4);
  assert.equal(isContractStale({ ...kalshi, updatedAt: generatedAt - 20_000 }, base), true);
  assert.equal(sortCandidatesForBlotter([candidate("later", 0.06), candidate("best", 0.12)])[0].pairKey, "best");
  assert.equal(buildBookMetrics(base.books.kalshi, base).contractCount, 1);
  assert.equal(buildBookRowViewModel(kalshi, base).scannerReady, true);
  assert.equal(buildCrossVenueBookComparisons(base).length, 1);
  const detail = buildTradeDetailModel("signal", base.recentSignals[0]);
  const risk = buildTradeRiskIntelligence(detail, 0);
  assert.equal(detail.classification, "True Arb");
  assert.equal(risk.riskLevel, "medium");
  const meter = renderToStaticMarkup(<RiskMeter insights={{
    estimatedEdge: 0.1,
    activeOpportunities: 1,
    feedLatencyMs: 10,
    kalshiLatencyMs: 10,
    polymarketLatencyMs: 10,
    scanP95Ms: 10,
    executionP95Ms: 10,
    lastScanAgeMs: 10,
    riskScore: 10,
    riskLevel: "low",
    staleBooks: 0,
  }} />);
  assert.match(meter, /LOW/);
});
