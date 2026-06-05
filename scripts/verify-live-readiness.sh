#!/usr/bin/env bash
set -euo pipefail

WORKER_API_BASE="${WORKER_API_BASE:-http://127.0.0.1:8080}"
REQUIRE_ARB_ENABLED="${REQUIRE_ARB_ENABLED:-true}"

if [ -z "${DASHBOARD_API_TOKEN:-}" ]; then
  echo "DASHBOARD_API_TOKEN must be set in your shell for readiness verification." >&2
  exit 2
fi

echo "Checking health at $WORKER_API_BASE/health"
HEALTH_FILE="$(mktemp)"
SNAPSHOT_FILE="$(mktemp)"
trap 'rm -f "$HEALTH_FILE" "$SNAPSHOT_FILE"' EXIT
curl -fsS "$WORKER_API_BASE/health" > "$HEALTH_FILE"
cat "$HEALTH_FILE"
echo

echo "Checking protected dashboard snapshot..."
curl -fsS -H "Authorization: Bearer $DASHBOARD_API_TOKEN" "$WORKER_API_BASE/dashboard/snapshot" > "$SNAPSHOT_FILE"

REQUIRE_ARB_ENABLED="$REQUIRE_ARB_ENABLED" node - "$HEALTH_FILE" "$SNAPSHOT_FILE" <<'NODE'
const fs = require("node:fs");
const health = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const snapshot = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const requireArbEnabled = !["0", "false", "no", "off"].includes(String(process.env.REQUIRE_ARB_ENABLED ?? "true").toLowerCase());
const runtimeHealth = snapshot.health ?? {};
const execution = snapshot.execution ?? {};
const kalshi = execution.kalshi ?? {};
const polymarket = execution.polymarket ?? {};
const userStreams = execution.userStreams ?? {};
const reconciliation = execution.reconciliation ?? {};
const books = snapshot.books ?? {};

const checks = [
  ["health.ok", health.ok === true],
  ["health.arbEnabled", !requireArbEnabled || health.arbEnabled === true],
  ["health.liveTrading=true", health.liveTrading === true],
  ["execution.partialFillLocked=false", execution.partialFillLocked === false],
  ["execution.circuitBreakerLocked=false", execution.circuitBreakerLocked === false],
  ["execution.kalshi.ready=true", kalshi.ready === true],
  ["execution.polymarket.ready=true", polymarket.ready === true],
  ["execution.polymarket.reason=null", polymarket.reason == null],
  ["execution.polymarket.geoblockBlocked=false", polymarket.geoblockBlocked === false],
  ["execution.polymarket.balance>0", Number(polymarket.balance) > 0],
  ["execution.quoteMaxAgeMs<=750", Number(execution.quoteMaxAgeMs) <= 750],
  ["execution.quoteSyncMaxSkewMs<=250", Number(execution.quoteSyncMaxSkewMs) <= 250],
  ["execution.minBookDepthShares>=orderSize", Number(execution.minBookDepthShares) >= Number(execution.orderSize)],
  ["execution.orderTimeoutMs<=2500", Number(execution.orderTimeoutMs) <= 2500],
  ["snapshot.health.liveHotPathEnabled=true", runtimeHealth.liveHotPathEnabled === true],
  ["snapshot.health.liveLowLatencyHttpEnabled=true", runtimeHealth.liveLowLatencyHttpEnabled === true],
  ["execution.userStreams.ready=true", runtimeHealth.liveUserStreamsEnabled !== true || userStreams.ready === true],
  ["execution.reconciliation.clean=true", runtimeHealth.liveReconcileBeforeTrade !== true || reconciliation.clean === true],
  ["execution.userStreams.confirmTimeoutMs<=2500", runtimeHealth.liveUserStreamsEnabled !== true || Number(userStreams.confirmTimeoutMs) <= 2500],
  ["books.kalshi.length>0", Array.isArray(books.kalshi) && books.kalshi.length > 0],
  ["books.polymarket.length>0", Array.isArray(books.polymarket) && books.polymarket.length > 0],
];

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({
  liveTrading: execution.liveTrading,
  arbEnabled: health.arbEnabled,
  requireArbEnabled,
  partialFillLocked: execution.partialFillLocked,
  circuitBreakerLocked: execution.circuitBreakerLocked,
  circuitBreakerReason: execution.circuitBreakerReason,
  kalshiReady: kalshi.ready,
  polymarketReady: polymarket.ready,
  polymarketReason: polymarket.reason,
  polymarketBalance: polymarket.balance,
  geoblockBlocked: polymarket.geoblockBlocked,
  geoblockCountry: polymarket.geoblockCountry,
  geoblockRegion: polymarket.geoblockRegion,
  quoteMaxAgeMs: execution.quoteMaxAgeMs,
  quoteSyncMaxSkewMs: execution.quoteSyncMaxSkewMs,
  minBookDepthShares: execution.minBookDepthShares,
  orderTimeoutMs: execution.orderTimeoutMs,
  liveHotPathEnabled: runtimeHealth.liveHotPathEnabled,
  liveHotPathCacheMaxAgeMs: runtimeHealth.liveHotPathCacheMaxAgeMs,
  liveHotPathWarmIntervalMs: runtimeHealth.liveHotPathWarmIntervalMs,
  liveLowLatencyHttpEnabled: runtimeHealth.liveLowLatencyHttpEnabled,
  livePolymarketPresignEnabled: runtimeHealth.livePolymarketPresignEnabled,
  livePolymarketSignedOrderTtlMs: runtimeHealth.livePolymarketSignedOrderTtlMs,
  userStreamsEnabled: userStreams.enabled,
  userStreamsReady: userStreams.ready,
  userStreamsReason: userStreams.reason,
  kalshiUserStream: userStreams.kalshi,
  polymarketUserStream: userStreams.polymarket,
  userStreamConfirmTimeoutMs: userStreams.confirmTimeoutMs,
  reconciliationClean: reconciliation.clean,
  reconciliationReason: reconciliation.reason,
  lastReconciliationAt: reconciliation.lastReconciliationAt,
  kalshiBooks: books.kalshi?.length ?? 0,
  polymarketBooks: books.polymarket?.length ?? 0,
}, null, 2));

if (failed.length > 0) {
  console.error(`Readiness failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exit(30);
}

console.log("Live-only readiness is green. Use ARB_ENABLED=false if you want monitoring without new entries.");
NODE
