import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runKalshiUiCapValidation,
  selectKalshiUiCapTestLeg,
  stagedModeFailures,
  writeValidationReport,
} from "../scripts/kalshi-ui-cap-validate";
import type { DashboardSnapshot } from "../src/types";

const now = 1_800_000_000_000;

function sessionFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pok-kalshi-ui-session-"));
  const file = path.join(dir, "session.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      userId: "user-secret-123",
      csrfToken: "csrf-secret-456",
      cookie: "kalshi-session-secret=abc",
    }),
  );
  fs.chmodSync(file, 0o600);
  return file;
}

function health(input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    arbEnabled: false,
    liveOrderPlacementMode: "parallel_quick",
    kalshiHedgeOrderMode: "ui_quick_order",
    kalshiUiQuickOrderCapValidated: false,
    ...input,
  };
}

function snapshot(input: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    generatedAt: now,
    health: {
      ok: true,
      liveTrading: true,
      arbEnabled: false,
      minProfitDollars: 0.01,
      reentryIntervalMs: 15_000,
      scanHeartbeatMs: 250,
      staleBookMs: 10_000,
      liveMaxTradesPerWindow: 3,
      liveOrderSize: 5,
      liveKalshiMinCashDollars: 5,
      liveQuoteMaxAgeMs: 750,
      liveQuoteSyncMaxSkewMs: 250,
      liveMinBookDepthShares: 10,
      liveOrderTimeoutMs: 2_500,
      liveHedgeMaxLossDollars: 0.02,
      liveHedgeFeeBufferDollars: 0.01,
      liveHedgeMinCrossTicks: 2,
      liveOrderPlacementMode: "parallel_quick",
      kalshiHedgeOrderMode: "ui_quick_order",
      kalshiUiQuickOrderCapValidated: false,
      liveParallelExecutionEnabled: true,
      liveHotPathEnabled: true,
      liveHotPathCacheMaxAgeMs: 5_000,
      liveHotPathWarmIntervalMs: 1_000,
      livePolymarketPresignEnabled: false,
      livePolymarketSignedOrderTtlMs: 5_000,
      liveKalshiHedgeTimeInForce: "immediate_or_cancel",
      liveKalshiPrearmEnabled: true,
      liveKalshiPrearmMaxAgeMs: 5_000,
      liveKalshiPrearmPricePolicy: "patch_after_fill",
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
      polymarketGeoblockGateEnabled: true,
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
    },
    latency: undefined,
    discovery: { lastDiscoveryAt: now - 1000, lastDiscoveryError: null },
    scanner: { scanning: true, lastScanAt: now - 500, lastCandidateCount: 1 },
    books: {
      kalshi: [
        {
          venue: "kalshi",
          asset: "BTC",
          contractId: "KXBTC15M-26JUN140300-00",
          expiryMs: now + 60_000,
          strike: 1500,
          yesAsk: 0.61,
          noAsk: 0.42,
          yesBid: 0.6,
          noBid: 0.41,
          updatedAt: now - 100,
        },
      ],
      polymarket: [],
    },
    diagnostics: { polymarket: {} as never },
    liveCandidates: [],
    syntheticStructures: [],
    recentSignals: [],
    analytics: undefined,
    tradingActivity: {} as never,
    execution: undefined,
    logs: [],
    ...input,
  };
}

function env(file = sessionFile(), extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KALSHI_UI_API_BASE: "https://kalshi.test",
    KALSHI_UI_SESSION_PATH: file,
    DASHBOARD_API_TOKEN: "dashboard-token-secret",
    WORKER_API_BASE: "http://worker.test",
    KALSHI_UI_CAP_TEST_COUNT: "1",
    KALSHI_UI_CAP_TEST_MAX_PRICE_CENTS: "1",
    ...extra,
  };
}

function mockFetch(
  input: {
    health?: Record<string, unknown>;
    snapshot?: DashboardSnapshot;
    postStatus?: number;
    postBody?: Record<string, unknown>;
    finalBody?: Record<string, unknown>;
    rejectText?: string;
    calls?: Array<{ method: string; path: string; body: Record<string, unknown> | null }>;
  } = {},
): typeof fetch {
  const healthBody = input.health ?? health();
  const snapshotBody = input.snapshot ?? snapshot();
  const calls = input.calls;
  return (async (urlInput: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(urlInput));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls?.push({ method, path: url.pathname, body });
    if (url.hostname === "worker.test" && url.pathname === "/health") {
      return new Response(JSON.stringify(healthBody), { status: 200 });
    }
    if (url.hostname === "worker.test" && url.pathname === "/dashboard/snapshot") {
      return new Response(JSON.stringify(snapshotBody), { status: 200 });
    }
    if (url.pathname.endsWith("/event_positions/KXBTC15M-26JUN140300")) {
      return new Response(
        JSON.stringify({
          event_position: {
            market_positions: [{ market_ticker: "KXBTC15M-26JUN140300-00", market_id: "private-market-id" }],
          },
        }),
        { status: 200 },
      );
    }
    if (method === "POST" && url.pathname.endsWith("/orders")) {
      if (input.postStatus && input.postStatus >= 400) {
        return new Response(input.rejectText ?? "insufficient liquidity below max_cost", { status: input.postStatus });
      }
      return new Response(
        JSON.stringify(
          input.postBody ?? {
            order: { order_id: "private-order-id", status: "accepted", fill_count_fp: "0" },
          },
        ),
        { status: 200 },
      );
    }
    if (method === "GET" && url.pathname.endsWith("/orders/private-order-id")) {
      return new Response(
        JSON.stringify(
          input.finalBody ?? {
            order: {
              order_id: "private-order-id",
              status: "canceled",
              fill_count_fp: "0",
              remaining_count_fp: "0",
              order_type: "market",
            },
          },
        ),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch ${method} ${url.toString()}`);
  }) as typeof fetch;
}

test("Kalshi UI cap validation staged guard refuses enabled entries and wrong mode", () => {
  assert.deepEqual(stagedModeFailures(health()), []);
  assert.ok(stagedModeFailures(health({ arbEnabled: true })).includes("health.arbEnabled=false"));
  assert.ok(
    stagedModeFailures(health({ liveOrderPlacementMode: "polymarket_first_exact" })).includes(
      "health.liveOrderPlacementMode=parallel_quick",
    ),
  );
});

test("Kalshi UI cap validation selects the nearest BTC15M side above the one-cent cap", () => {
  const selected = selectKalshiUiCapTestLeg({ snapshot: snapshot(), maxPriceCents: 1 });
  assert.equal(selected.leg.contractId, "KXBTC15M-26JUN140300-00");
  assert.equal(selected.leg.direction, "yes");
  assert.equal(selected.displayedAsk, 0.61);
});

test("Kalshi UI cap validation refuses when worker entries are enabled", async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const report = await runKalshiUiCapValidation({
    env: env(),
    fetchFn: mockFetch({ health: health({ arbEnabled: true }), calls }),
    now,
  });
  assert.equal(report.passed, false);
  assert.match(report.reason, /health\.arbEnabled=false/);
  assert.equal(
    calls.some((call) => call.method === "POST"),
    false,
  );
});

test("Kalshi UI cap validation refuses when UI session is missing", async () => {
  const report = await runKalshiUiCapValidation({
    env: env("/tmp/pok-missing-kalshi-ui-session.json"),
    fetchFn: mockFetch(),
    now,
  });
  assert.equal(report.passed, false);
  assert.match(report.reason, /session file not found/);
});

test("Kalshi UI cap validation submits a one-contract one-cent Quick Order body and passes on zero-fill cancel", async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const report = await runKalshiUiCapValidation({ env: env(), fetchFn: mockFetch({ calls }), now });
  const post = calls.find((call) => call.method === "POST");
  assert.equal(report.passed, true);
  assert.equal(report.reason, "zero_fill_or_rejected_under_cap");
  assert.equal(post?.body?.order_type, "market");
  assert.equal(post?.body?.time_in_force, "immediate_or_cancel");
  assert.equal(post?.body?.count_fp, "1.00");
  assert.equal(post?.body?.price_dollars, "0.0100");
  assert.equal(post?.body?.max_cost_cents, 1);
});

test("Kalshi UI cap validation passes on explicit cap/liquidity rejection", async () => {
  const report = await runKalshiUiCapValidation({
    env: env(),
    fetchFn: mockFetch({ postStatus: 400, rejectText: "insufficient liquidity below max_cost" }),
    now,
  });
  assert.equal(report.passed, true);
  assert.equal(report.reason, "rejected_under_cap");
});

test("Kalshi UI cap validation fails closed when fill price exceeds the cap", async () => {
  const report = await runKalshiUiCapValidation({
    env: env(),
    fetchFn: mockFetch({
      finalBody: {
        order: {
          order_id: "private-order-id",
          status: "executed",
          fill_count_fp: "1",
          taker_fill_cost_dollars: "0.02",
          order_type: "market",
        },
      },
    }),
    now,
  });
  assert.equal(report.passed, false);
  assert.match(report.reason, /exceeded_cap/);
  assert.equal(report.response.fillPrice, 0.02);
});

test("Kalshi UI cap validation report redacts session and order identifiers", async () => {
  const report = await runKalshiUiCapValidation({ env: env(), fetchFn: mockFetch(), now });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pok-kalshi-ui-cap-report-"));
  const written = writeValidationReport(report, { KALSHI_UI_CAP_TEST_REPORT_DIR: dir } as NodeJS.ProcessEnv);
  assert.ok(written.reportPaths?.json);
  const json = fs.readFileSync(written.reportPaths!.json, "utf8");
  assert.doesNotMatch(json, /user-secret|csrf-secret|kalshi-session-secret|private-order-id|private-market-id/);
  assert.match(json, /orderIdHash/);
  assert.match(json, /marketIdHash/);
});
