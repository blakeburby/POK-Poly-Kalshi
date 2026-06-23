#!/usr/bin/env bash
set -euo pipefail

if [ -z "${HOSTINGER_SSH_TARGET:-}" ]; then
  echo "HOSTINGER_SSH_TARGET is required, for example: HOSTINGER_SSH_TARGET=user@host" >&2
  exit 2
fi

APP_DIR="${HOSTINGER_APP_DIR:-/opt/pok-poly-kalshi}"
ENV_FILE="${HOSTINGER_ENV_FILE:-/etc/pok-poly-kalshi/worker.env}"
REQUIRE_ARB_ENABLED="${REQUIRE_ARB_ENABLED:-true}"

ssh "$HOSTINGER_SSH_TARGET" bash -s -- "$APP_DIR" "$ENV_FILE" "$REQUIRE_ARB_ENABLED" <<'REMOTE'
set -euo pipefail

APP_DIR="$1"
ENV_FILE="$2"
REQUIRE_ARB_ENABLED="$3"

SUDO=()
if [ "$(id -u)" -ne 0 ]; then
  SUDO=(sudo -n)
fi

RUN_AS_POK=false
if id pok >/dev/null 2>&1 && [ "$(id -un)" != "pok" ]; then
  RUN_AS_POK=true
fi

run_app() {
  if [ "$RUN_AS_POK" = true ]; then
    "${SUDO[@]}" runuser -u pok -- "$@"
  else
    "$@"
  fi
}

read_env_value() {
  local key="$1"
  "${SUDO[@]}" node - "$ENV_FILE" "$key" <<'NODE'
const fs = require("node:fs");
const [envFile, key] = process.argv.slice(2);
const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
for (const line of lines) {
  if (!line || line.trimStart().startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index < 0) continue;
  if (line.slice(0, index).trim() === key) {
    console.log(line.slice(index + 1).trim());
    process.exit(0);
  }
}
process.exit(1);
NODE
}

protected_readiness_check() {
  local token="$1"
  local require_arb_enabled="$2"
  local health_file
  local snapshot_file
  health_file="$(mktemp)"
  snapshot_file="$(mktemp)"
  trap 'rm -f "$health_file" "$snapshot_file"' RETURN

  curl -fsS http://127.0.0.1:8080/health > "$health_file"
  curl -fsS -H "Authorization: Bearer $token" http://127.0.0.1:8080/dashboard/snapshot > "$snapshot_file"

  REQUIRE_ARB_ENABLED="$require_arb_enabled" node - "$health_file" "$snapshot_file" <<'NODE'
const fs = require("node:fs");
const health = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const snapshot = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const requireArbEnabled = String(process.env.REQUIRE_ARB_ENABLED ?? "true") === "true";
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
  ["execution.polymarket.geoblockBlocked=false (advisory when geoblock gate disabled)", runtimeHealth.polymarketGeoblockGateEnabled === false || polymarket.geoblockBlocked === false],
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

console.log(JSON.stringify({
  liveTrading: execution.liveTrading,
  arbEnabled: health.arbEnabled,
  requireArbEnabled,
  liveOrderPlacementMode: health.liveOrderPlacementMode,
  liveOrderSize: health.liveOrderSize,
  kalshiHedgeOrderMode: health.kalshiHedgeOrderMode ?? null,
  kalshiUiQuickOrderCapValidated: health.kalshiUiQuickOrderCapValidated ?? null,
  liveKalshiHedgeTimeInForce: health.liveKalshiHedgeTimeInForce ?? null,
  kalshiFixHost: health.kalshiFixHost ?? null,
  kalshiFixPort: health.kalshiFixPort ?? null,
  kalshiFixTargetCompId: health.kalshiFixTargetCompId ?? null,
  kalshiFixUseDollars: health.kalshiFixUseDollars ?? null,
  livePolymarketFirstMinFillShares: health.livePolymarketFirstMinFillShares,
  livePolymarketFirstMaxFillShares: health.livePolymarketFirstMaxFillShares,
  liveAutoHardlocksEnabled: health.liveAutoHardlocksEnabled,
  partialFillLocked: execution.partialFillLocked,
  circuitBreakerLocked: execution.circuitBreakerLocked,
  kalshiReady: kalshi.ready,
  polymarketReady: polymarket.ready,
  polymarketReason: polymarket.reason,
  geoblockBlocked: polymarket.geoblockBlocked,
  geoblockCountry: polymarket.geoblockCountry,
  geoblockRegion: polymarket.geoblockRegion,
  userStreamsReady: userStreams.ready,
  reconciliationClean: reconciliation.clean,
  kalshiBooks: books.kalshi?.length ?? 0,
  polymarketBooks: books.polymarket?.length ?? 0,
}, null, 2));

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  console.error(`Readiness failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exit(30);
}
NODE
}

echo "Hostinger worker systemd state:"
systemctl is-active pok-worker
systemctl is-enabled pok-worker

echo "Hostinger repo state:"
run_app git -C "$APP_DIR" rev-parse --show-toplevel
run_app git -C "$APP_DIR" branch --show-current
run_app git -C "$APP_DIR" rev-parse HEAD
run_app git -C "$APP_DIR" status --short

echo "Node version:"
node --version
npm --version

echo "Sanitized worker env:"
"${SUDO[@]}" awk -F= '
  $1 ~ /^(ARB_ENABLED|LIVE_ORDER_PLACEMENT_MODE|LIVE_KALSHI_HEDGE_TIME_IN_FORCE|LIVE_ORDER_SIZE|LIVE_MIN_BOOK_DEPTH_SHARES|LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES|LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES|LIVE_RECONCILE_BEFORE_TRADE|LIVE_AUTO_HARDLOCKS_ENABLED|LIVE_EXACT_EXPOSURE_REQUIRED|LIVE_EXECUTION_QUALITY_GATE_ENABLED|KALSHI_HEDGE_ORDER_MODE|KALSHI_UI_SESSION_PATH|KALSHI_UI_QUICK_ORDER_CAP_VALIDATED)$/ {
    print $1 "=" $2
  }
' "$ENV_FILE"

echo "Public health:"
curl -fsS http://127.0.0.1:8080/health
echo

DASHBOARD_API_TOKEN="$(read_env_value DASHBOARD_API_TOKEN)"
if [ -z "$DASHBOARD_API_TOKEN" ]; then
  echo "DASHBOARD_API_TOKEN is empty in $ENV_FILE" >&2
  exit 3
fi

echo "Protected readiness with REQUIRE_ARB_ENABLED=$REQUIRE_ARB_ENABLED:"
protected_readiness_check "$DASHBOARD_API_TOKEN" "$REQUIRE_ARB_ENABLED"

DATABASE_URL="$(read_env_value DATABASE_URL)"
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is empty in $ENV_FILE" >&2
  exit 4
fi

echo "Completion-rate report:"
cd "$APP_DIR"
if [ -f scripts/completion-rate-report.ts ]; then
  run_app env DATABASE_URL="$DATABASE_URL" npx tsx scripts/completion-rate-report.ts --limit=20
else
  echo "Current checkout does not have scripts/completion-rate-report.ts; deploy branch will run it after checkout."
fi
REMOTE
