import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DashboardTerminalView,
  RiskMeter,
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
      minProfitDollars: 0.05,
      reentryIntervalMs: 15_000,
      staleBookMs: 10_000,
      liveMaxTradesPerWindow: 1,
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
      maxTradesPerWindow: 1,
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
  assert.match(markup, /LIVE-ONLY DASHBOARD/);
  assert.match(markup, /real-kalshi-order/);
  assert.match(markup, /real-poly-order/);

  for (const forbidden of ["Current " + "Pa" + "per Trading Dashboard"]) {
    assert.doesNotMatch(markup.toLowerCase(), new RegExp(forbidden.toLowerCase()));
  }
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
