import test from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../src/config";
import type { PolymarketPriceBeatRecord, PolymarketPriceBeatRepository } from "../src/db/polymarket-price-beats";
import {
  discoverPolymarketBtcContractsWithDiagnostics,
  extractPolymarketPagePriceToBeat,
} from "../src/discovery/polymarket";

class MemoryPriceBeatStore implements PolymarketPriceBeatRepository {
  readonly records = new Map<string, PolymarketPriceBeatRecord>();

  async upsert(record: PolymarketPriceBeatRecord): Promise<void> {
    this.records.set(record.marketSlug, record);
  }

  async getBySlug(marketSlug: string): Promise<PolymarketPriceBeatRecord | null> {
    return this.records.get(marketSlug) ?? null;
  }

  async getBySlugs(marketSlugs: string[]): Promise<Map<string, PolymarketPriceBeatRecord>> {
    return new Map(marketSlugs.flatMap((slug) => {
      const record = this.records.get(slug);
      return record ? [[slug, record] as const] : [];
    }));
  }
}

function config(input: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8080,
    databaseUrl: "",
    arbEnabled: true,
    minProfitDollars: 0.05,
    reentryIntervalMs: 15_000,
    arbScanHeartbeatMs: 250,
    staleBookMs: 10_000,
    marketDiscoveryIntervalMs: 30_000,
    dashboardStreamIntervalMs: 250,
    dashboardSignalRefreshMs: 1_000,
    dashboardAnalyticsRefreshMs: 5_000,
    executionConcurrency: 2,
    discoveryBoundaryRefreshEnabled: true,
    kalshiApiBase: "",
    kalshiWsUrl: "",
    kalshiSeriesTicker: "KXBTC15M",
    polymarketWsUrl: "",
    polymarketDiscoveryUrl: "https://gamma-api.polymarket.com/markets?active=true",
    polymarketLiveDataWsUrl: "wss://ws-live-data.polymarket.com",
    polymarketPriceToBeatSymbol: "btc/usd",
    polymarketDiscoveryWindowOffsets: [0],
    polymarketPriceCaptureToleranceMs: 5_000,
    polymarketMissedOpenBackfill: true,
    polymarketPrivateKey: "",
    polymarketApiKey: "",
    polymarketApiSecret: "",
    polymarketApiPassphrase: "",
    polymarketSignatureType: 0,
    polymarketFunderAddress: "",
    polymarketChainId: 137,
    polymarketClobHost: "https://clob.polymarket.com",
    polymarketGeoblockUrl: "https://polymarket.com/api/geoblock",
    polymarketOrderType: "FOK",
    liveOrderSize: 1,
    liveTakerPriceCushionCents: 2,
    liveMinExpiryMs: 30_000,
    liveMaxTradesPerWindow: 3,
    liveCollateralBufferDollars: 0.25,
    liveQuoteMaxAgeMs: 750,
    liveQuoteSyncMaxSkewMs: 250,
    liveMinBookDepthShares: 1,
    liveOrderTimeoutMs: 2_500,
    liveHedgeMaxLossDollars: 0.02,
    liveHedgeFeeBufferDollars: 0.01,
    liveOrderPlacementMode: "parallel_limit_rest",
    liveAggressiveLimitRestMs: 500,
    liveParallelExecutionEnabled: false,
    liveHotPathEnabled: false,
    liveHotPathCacheMaxAgeMs: 5_000,
    liveHotPathWarmIntervalMs: 1_000,
    livePolymarketPresignEnabled: false,
    livePolymarketSignedOrderTtlMs: 5_000,
    livePolymarketFirstMinFillShares: 7,
    livePolymarketFirstMaxFillShares: 9,
    liveLowLatencyHttpEnabled: true,
    liveKalshiOrderGroupEnabled: false,
    liveKalshiOrderGroupId: "",
    liveUserStreamsEnabled: false,
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
    liveReconcileBeforeTrade: false,
    kalshiUserWsUrl: "",
    polymarketUserWsUrl: "",
    dashboardApiToken: "secret-token",
    ...input,
  };
}

function market(input: Record<string, unknown> = {}): Record<string, unknown> {
  const eventStartMs = 1_800_000_000_000;
  return {
    id: "market-id",
    conditionId: "condition-id",
    slug: "btc-updown-15m-1800000000",
    question: "BTC Up or Down 15m",
    active: true,
    closed: false,
    startDate: new Date(eventStartMs - 24 * 60 * 60_000).toISOString(),
    endDate: new Date(eventStartMs + 15 * 60_000).toISOString(),
    outcomes: JSON.stringify(["Up", "Down"]),
    clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
    ...input,
  };
}

function fetchWithMarkets(pageHtml = ""): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("markets?slug=btc-updown-15m-1800000000")) return new Response(JSON.stringify([market()]));
    if (url.includes("gamma-api.polymarket.com/markets")) return new Response(JSON.stringify([]));
    if (url.includes("polymarket.com/event/")) return new Response(pageHtml || "<html></html>");
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("page metadata scraper only uses eventMetadata.priceToBeat from the matching slug", () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        event: { slug: "btc-updown-15m-1800000000", eventMetadata: { priceToBeat: "76012.34" } },
        unrelated: { slug: "btc-updown-15m-1799999100", eventMetadata: { priceToBeat: "1" } },
      },
    },
  })}</script>`;
  assert.equal(extractPolymarketPagePriceToBeat(html, "btc-updown-15m-1800000000"), 76012.34);
  assert.equal(extractPolymarketPagePriceToBeat(html, "missing-slug"), null);
  assert.equal(extractPolymarketPagePriceToBeat("<html></html>", "btc-updown-15m-1800000000"), null);
});

test("discovery keeps unhydrated Polymarket markets diagnostic-only before the capture window", async () => {
  const eventStartMs = 1_800_000_000_000;
  const result = await discoverPolymarketBtcContractsWithDiagnostics(config(), eventStartMs, {
    priceBeatStore: new MemoryPriceBeatStore(),
    fetchFn: fetchWithMarkets(),
  });
  assert.equal(result.contracts.length, 0);
  assert.equal(result.captureWindows.length, 1);
  assert.equal(result.diagnostics.pendingStrikeCount, 1);
  assert.equal(result.diagnostics.markets[0].status, "pending_strike");
});

test("discovery hydrates scanner-ready contracts from the persisted price-to-beat store after restart", async () => {
  const eventStartMs = 1_800_000_000_000;
  const store = new MemoryPriceBeatStore();
  await store.upsert({
    marketSlug: "btc-updown-15m-1800000000",
    conditionId: "condition-id",
    eventStartMs,
    expiryMs: eventStartMs + 15 * 60_000,
    priceToBeat: 76050.5,
    source: "chainlink_ws",
    sourceTimestampMs: eventStartMs,
  });

  const result = await discoverPolymarketBtcContractsWithDiagnostics(config(), eventStartMs + 10_000, {
    priceBeatStore: store,
    fetchFn: fetchWithMarkets(),
  });
  assert.equal(result.contracts.length, 1);
  assert.equal(result.contracts[0].strike, 76050.5);
  assert.equal(result.contracts[0].yesTokenId, "yes-token");
  assert.equal(result.captureWindows.length, 0);
  assert.equal(result.diagnostics.readyContracts, 1);
});

test("missed-open discovery backfills from page metadata when exact price-to-beat is present", async () => {
  const eventStartMs = 1_800_000_000_000;
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { event: { slug: "btc-updown-15m-1800000000", eventMetadata: { priceToBeat: 76099 } } } },
  })}</script>`;
  const store = new MemoryPriceBeatStore();
  const result = await discoverPolymarketBtcContractsWithDiagnostics(config(), eventStartMs + 10_000, {
    priceBeatStore: store,
    fetchFn: fetchWithMarkets(html),
  });

  assert.equal(result.contracts.length, 1);
  assert.equal(result.contracts[0].strike, 76099);
  assert.equal(store.records.get("btc-updown-15m-1800000000")?.source, "page_metadata");
});
