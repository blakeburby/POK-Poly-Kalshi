import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config";
import { buildPublicWorkerHealth } from "../src/health";
import type { ScannerStatus } from "../src/scanner/scanner";
import type { LiveExecutionReadiness, UserStreamVenueState } from "../src/types";

const now = 1_800_000_000_000;

function scannerStatus(input: Partial<ScannerStatus> = {}): ScannerStatus {
  return {
    scanning: false,
    lastScanAt: now - 125,
    lastCandidateCount: 2,
    queuedExecutions: 0,
    activeExecutions: 0,
    ...input,
  };
}

function streamVenue(input: Partial<UserStreamVenueState> = {}): UserStreamVenueState {
  return {
    enabled: true,
    connected: true,
    subscribed: true,
    reason: null,
    lastConnectedAt: now - 1_000,
    lastEventAt: now - 500,
    lastError: null,
    ...input,
  };
}

function readiness(input: Partial<LiveExecutionReadiness> = {}): LiveExecutionReadiness {
  return {
    mode: "live",
    liveTrading: true,
    protectedOnly: true,
    orderSize: 5,
    orderType: "FAK",
    takerPriceCushionCents: 2,
    minExpiryMs: 60_000,
    maxTradesPerWindow: 3,
    collateralBufferDollars: 0.25,
    quoteMaxAgeMs: 750,
    quoteSyncMaxSkewMs: 250,
    minBookDepthShares: 10,
    orderPlacementMode: "polymarket_first_exact",
    orderTimeoutMs: 2_500,
    kalshiOrderGroupEnabled: true,
    userStreams: {
      enabled: true,
      ready: true,
      reason: null,
      confirmTimeoutMs: 2_500,
      kalshi: streamVenue(),
      polymarket: streamVenue(),
      lastUserStreamEventAt: now - 500,
      confirmationLagMs: 10,
    },
    reconciliation: {
      enabled: true,
      clean: true,
      reason: null,
      checkedAt: now,
      lastReconciliationAt: now - 100,
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
    kalshi: { configured: true, ready: true, reason: null, balance: 125, allowance: null, lastCheckedAt: now },
    polymarket: {
      configured: true,
      ready: false,
      reason: "Polymarket CLOB trading blocked from worker egress",
      balance: 123,
      allowance: 456,
      lastCheckedAt: now,
      signerAddress: "0x1111222233334444555566667777888899990000",
      funderAddress: "0xaaaabbbbccccddddeeeeffff0000111122223333",
      collateralBalanceRaw: 123_000_000,
      collateralBalanceNormalized: 123,
      collateralAllowanceRaw: 456_000_000,
      collateralAllowanceNormalized: 456,
      requiredCollateral: 2.5,
      geoblockBlocked: true,
      geoblockCountry: "US",
      geoblockRegion: null,
      geoblockCheckedAt: now,
    },
    lastAttempt: null,
    ...input,
  };
}

test("public worker health preserves existing lightweight config shape without readiness", () => {
  const health = buildPublicWorkerHealth({
    config: loadConfig({ LIVE_ORDER_SIZE: "5" }),
    scannerStatus: scannerStatus(),
    now,
  });

  assert.equal(health.ok, true);
  assert.equal(health.liveOrderSize, 5);
  assert.equal(health.livePolymarketFirstMinFillShares, 5);
  assert.equal(health.lastScanAgeMs, 125);
  assert.equal(health.executionReadiness, undefined);
});

test("public worker health can expose sanitized geoblock readiness without account details", () => {
  const health = buildPublicWorkerHealth({
    config: loadConfig({ LIVE_ORDER_SIZE: "5" }),
    scannerStatus: scannerStatus(),
    now,
    readiness: readiness(),
  });
  const execution = health.executionReadiness as Record<string, unknown>;
  const polymarket = execution.polymarket as Record<string, unknown>;

  assert.equal(execution.included, true);
  assert.equal(execution.safeToPlaceOrders, false);
  assert.equal(polymarket.ready, false);
  assert.equal(polymarket.reason, "Polymarket CLOB trading blocked from worker egress");
  assert.equal(polymarket.geoblockBlocked, true);
  assert.equal(polymarket.geoblockCountry, "US");

  const serialized = JSON.stringify(health);
  assert.doesNotMatch(serialized, /0x1111|0xaaaa/);
  assert.doesNotMatch(serialized, /balance|allowance|funder|signer|collateral/i);
});

test("public worker health redacts readiness errors", () => {
  const health = buildPublicWorkerHealth({
    config: loadConfig({}),
    scannerStatus: scannerStatus({ lastScanAt: 0 }),
    now,
    readinessError: new Error("POLYMARKET_PRIVATE_KEY leaked-example"),
  });
  const execution = health.executionReadiness as Record<string, unknown>;

  assert.equal(execution.included, true);
  assert.equal(execution.safeToPlaceOrders, false);
  assert.equal(execution.error, "execution_readiness_unavailable");
  assert.equal(health.lastScanAgeMs, null);
  assert.doesNotMatch(JSON.stringify(health), /POLYMARKET_PRIVATE_KEY|leaked-example/);
});
