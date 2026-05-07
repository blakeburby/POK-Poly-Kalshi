#!/usr/bin/env bash
set -euo pipefail

WORKER_API_BASE="${WORKER_API_BASE:-http://127.0.0.1:8080}"

if [ -z "${DASHBOARD_API_TOKEN:-}" ]; then
  echo "DASHBOARD_API_TOKEN must be set in your shell for readiness verification." >&2
  exit 2
fi

echo "Checking health at $WORKER_API_BASE/health"
HEALTH_JSON="$(curl -fsS "$WORKER_API_BASE/health")"
echo "$HEALTH_JSON"

echo "Checking protected dashboard snapshot..."
SNAPSHOT_JSON="$(curl -fsS -H "Authorization: Bearer $DASHBOARD_API_TOKEN" "$WORKER_API_BASE/dashboard/snapshot")"

HEALTH_JSON="$HEALTH_JSON" SNAPSHOT_JSON="$SNAPSHOT_JSON" node <<'NODE'
const health = JSON.parse(process.env.HEALTH_JSON);
const snapshot = JSON.parse(process.env.SNAPSHOT_JSON);
const execution = snapshot.execution ?? {};
const kalshi = execution.kalshi ?? {};
const polymarket = execution.polymarket ?? {};
const books = snapshot.books ?? {};

const checks = [
  ["health.ok", health.ok === true],
  ["health.arbEnabled", health.arbEnabled === true],
  ["health.liveTrading=false", health.liveTrading === false],
  ["execution.partialFillLocked=false", execution.partialFillLocked === false],
  ["execution.kalshi.ready=true", kalshi.ready === true],
  ["execution.polymarket.ready=true", polymarket.ready === true],
  ["execution.polymarket.reason=null", polymarket.reason == null],
  ["execution.polymarket.geoblockBlocked=false", polymarket.geoblockBlocked === false],
  ["execution.polymarket.balance>0", Number(polymarket.balance) > 0],
  ["books.kalshi.length>0", Array.isArray(books.kalshi) && books.kalshi.length > 0],
  ["books.polymarket.length>0", Array.isArray(books.polymarket) && books.polymarket.length > 0],
];

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({
  liveTrading: execution.liveTrading,
  partialFillLocked: execution.partialFillLocked,
  kalshiReady: kalshi.ready,
  polymarketReady: polymarket.ready,
  polymarketReason: polymarket.reason,
  polymarketBalance: polymarket.balance,
  geoblockBlocked: polymarket.geoblockBlocked,
  geoblockCountry: polymarket.geoblockCountry,
  geoblockRegion: polymarket.geoblockRegion,
  kalshiBooks: books.kalshi?.length ?? 0,
  polymarketBooks: books.polymarket?.length ?? 0,
}, null, 2));

if (failed.length > 0) {
  console.error(`Readiness failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exit(30);
}

console.log("Live-trading dry-run readiness is green. Do not flip ARB_LIVE_TRADING=true until you intentionally start the canary.");
NODE
