import type { AppConfig } from "./config";
import type { ScannerStatus } from "./scanner/scanner";
import type { LiveExecutionReadiness, VenueExecutionReadiness } from "./types";

export interface PublicWorkerHealthOptions {
  config: AppConfig;
  scannerStatus: ScannerStatus;
  now: number;
  readiness?: LiveExecutionReadiness | null;
  readinessError?: unknown;
}

function lastScanAgeMs(status: ScannerStatus, now: number): number | null {
  return status.lastScanAt > 0 ? Math.max(0, now - status.lastScanAt) : null;
}

function publicVenueReadiness(venue: VenueExecutionReadiness, includeGeoblock = false): Record<string, unknown> {
  const geoblockReason = includeGeoblock && (venue.geoblockBlocked === true || venue.reason?.toLowerCase().includes("geoblock"))
    ? venue.reason ?? "geoblock_blocked"
    : venue.ready ? null : "not_ready";
  return {
    configured: venue.configured,
    ready: venue.ready,
    reason: venue.ready ? null : geoblockReason,
    lastCheckedAt: venue.lastCheckedAt,
    ...(includeGeoblock
      ? {
        geoblockBlocked: venue.geoblockBlocked ?? null,
        geoblockCountry: venue.geoblockCountry ?? null,
        geoblockRegion: venue.geoblockRegion ?? null,
        geoblockCheckedAt: venue.geoblockCheckedAt ?? null,
      }
      : {}),
  };
}

function publicExecutionReadiness(readiness: LiveExecutionReadiness | null | undefined, error: unknown): Record<string, unknown> | undefined {
  if (error != null) {
    return {
      included: true,
      safeToPlaceOrders: false,
      error: "execution_readiness_unavailable",
    };
  }
  if (!readiness) return undefined;
  const userStreamsReady = readiness.userStreams.ready;
  const reconciliationClean = readiness.reconciliation.clean;
  const safeToPlaceOrders = readiness.liveTrading
    && readiness.kalshi.ready
    && readiness.polymarket.ready
    && userStreamsReady
    && reconciliationClean
    && !readiness.partialFillLocked
    && !readiness.circuitBreakerLocked;
  return {
    included: true,
    safeToPlaceOrders,
    liveTrading: readiness.liveTrading,
    riskState: readiness.riskState,
    riskStateReason: readiness.riskStateReason ? "not_ready" : null,
    partialFillLocked: readiness.partialFillLocked,
    circuitBreakerLocked: readiness.circuitBreakerLocked,
    circuitBreakerReason: readiness.circuitBreakerReason ? "locked" : null,
    userStreamsReady,
    userStreamsReason: readiness.userStreams.reason ? "not_ready" : null,
    reconciliationClean,
    reconciliationReason: readiness.reconciliation.reason ? "not_clean" : null,
    kalshi: publicVenueReadiness(readiness.kalshi),
    polymarket: publicVenueReadiness(readiness.polymarket, true),
  };
}

export function buildPublicWorkerHealth(options: PublicWorkerHealthOptions): Record<string, unknown> {
  const { config, scannerStatus, now, readiness, readinessError } = options;
  const health: Record<string, unknown> = {
    ok: true,
    liveTrading: true,
    arbEnabled: config.arbEnabled,
    liveOrderPlacementMode: config.liveOrderPlacementMode,
    kalshiHedgeOrderMode: config.kalshiHedgeOrderMode,
    kalshiUiQuickOrderCapValidated: config.kalshiUiQuickOrderCapValidated,
    kalshiFixHost: config.kalshiFixHost,
    kalshiFixPort: config.kalshiFixPort,
    kalshiFixTargetCompId: config.kalshiFixTargetCompId,
    kalshiFixUseDollars: config.kalshiFixUseDollars,
    liveOrderSize: config.liveOrderSize,
    liveKalshiMinCashDollars: config.liveKalshiMinCashDollars,
    liveMinBookDepthShares: config.liveMinBookDepthShares,
    scanHeartbeatMs: config.arbScanHeartbeatMs,
    lastScanAgeMs: lastScanAgeMs(scannerStatus, now),
    maxTradesPerWindow: config.liveMaxTradesPerWindow,
    liveMaxTradesPerWindow: config.liveMaxTradesPerWindow,
    liveTakerPriceCushionCents: config.liveTakerPriceCushionCents,
    liveKalshiHedgeTimeInForce: config.liveKalshiHedgeTimeInForce,
    liveKalshiPrearmEnabled: config.liveKalshiPrearmEnabled,
    liveKalshiPrearmMaxAgeMs: config.liveKalshiPrearmMaxAgeMs,
    liveKalshiPrearmPricePolicy: config.liveKalshiPrearmPricePolicy,
    livePolymarketFirstMinFillShares: config.livePolymarketFirstMinFillShares,
    livePolymarketFirstMaxFillShares: config.livePolymarketFirstMaxFillShares,
    liveAutoHardlocksEnabled: config.liveAutoHardlocksEnabled,
    polymarketGeoblockGateEnabled: config.polymarketGeoblockGateEnabled,
    liveExactExposureRequired: config.liveExactExposureRequired,
    liveExecutionQualityGateEnabled: config.liveExecutionQualityGateEnabled,
    liveExecutionQualityLookbackMs: config.liveExecutionQualityLookbackMs,
    liveExecutionQualitySampleLimit: config.liveExecutionQualitySampleLimit,
    liveExecutionQualityMinSamples: config.liveExecutionQualityMinSamples,
    liveExecutionQualityMinExactFillRate: config.liveExecutionQualityMinExactFillRate,
    liveFillQualityScoringEnabled: config.liveFillQualityScoringEnabled,
    liveFillQualityGateEnabled: config.liveFillQualityGateEnabled,
    liveFillQualityMinExpectedEdge: config.liveFillQualityMinExpectedEdge,
    liveFillQualityLookbackMs: config.liveFillQualityLookbackMs,
    liveFillQualitySampleLimit: config.liveFillQualitySampleLimit,
    liveFillQualityMinSamples: config.liveFillQualityMinSamples,
    liveFillQualityModelVersion: config.liveFillQualityModelVersion,
    liveLeadLagScoringEnabled: config.liveLeadLagScoringEnabled,
    liveLeadLagGateEnabled: config.liveLeadLagGateEnabled,
    liveLeadLagModelVersion: config.liveLeadLagModelVersion,
    liveLeadLagWindowsMs: config.liveLeadLagWindowsMs,
    liveLeadLagMinConfidence: config.liveLeadLagMinConfidence,
    liveLeadLagMaxAdverseSelectionScore: config.liveLeadLagMaxAdverseSelectionScore,
  };
  const executionReadiness = publicExecutionReadiness(readiness, readinessError);
  if (executionReadiness) health.executionReadiness = executionReadiness;
  return health;
}
