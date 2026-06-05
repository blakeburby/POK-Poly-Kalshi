#!/usr/bin/env bash
set -euo pipefail

WORKER_API_BASE="${WORKER_API_BASE:-http://127.0.0.1:8080}"

echo "Checking public readiness at $WORKER_API_BASE/health?readiness=1"
HEALTH_FILE="$(mktemp)"
trap 'rm -f "$HEALTH_FILE"' EXIT
curl -fsS "$WORKER_API_BASE/health?readiness=1" > "$HEALTH_FILE"

node - "$HEALTH_FILE" <<'NODE'
const fs = require("node:fs");
const health = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const execution = health.executionReadiness;

if (!execution) {
  console.error("Public readiness was not included. Confirm the worker is deployed with /health?readiness=1 support.");
  process.exit(40);
}

const summary = {
  ok: health.ok,
  liveTrading: health.liveTrading,
  arbEnabled: health.arbEnabled,
  liveOrderPlacementMode: health.liveOrderPlacementMode,
  liveOrderSize: health.liveOrderSize,
  safeToPlaceOrders: execution.safeToPlaceOrders,
  riskState: execution.riskState,
  partialFillLocked: execution.partialFillLocked,
  circuitBreakerLocked: execution.circuitBreakerLocked,
  userStreamsReady: execution.userStreamsReady,
  reconciliationClean: execution.reconciliationClean,
  kalshiReady: execution.kalshi?.ready,
  polymarketReady: execution.polymarket?.ready,
  polymarketReason: execution.polymarket?.reason,
  geoblockBlocked: execution.polymarket?.geoblockBlocked,
  geoblockCountry: execution.polymarket?.geoblockCountry,
  geoblockRegion: execution.polymarket?.geoblockRegion,
};
console.log(JSON.stringify(summary, null, 2));

if (execution.safeToPlaceOrders !== true) {
  console.error("Public readiness is not safe for live order placement.");
  process.exit(41);
}

console.log("Public readiness is safe for live order placement.");
NODE
