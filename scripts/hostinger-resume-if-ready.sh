#!/usr/bin/env bash
set -euo pipefail

if [ -z "${HOSTINGER_SSH_TARGET:-}" ]; then
  echo "HOSTINGER_SSH_TARGET is required, for example: HOSTINGER_SSH_TARGET=user@host" >&2
  exit 2
fi

APP_DIR="${HOSTINGER_APP_DIR:-/opt/pok-poly-kalshi}"
ENV_FILE="${HOSTINGER_ENV_FILE:-/etc/pok-poly-kalshi/worker.env}"
ALLOW_PARALLEL_QUICK="${HOSTINGER_RESUME_ALLOW_PARALLEL_QUICK:-false}"
ALLOW_KALSHI_FIRST_EXACT="${HOSTINGER_RESUME_ALLOW_KALSHI_FIRST_EXACT:-false}"

ssh "$HOSTINGER_SSH_TARGET" bash -s -- "$APP_DIR" "$ENV_FILE" "$ALLOW_PARALLEL_QUICK" "$ALLOW_KALSHI_FIRST_EXACT" <<'REMOTE'
set -euo pipefail

APP_DIR="$1"
ENV_FILE="$2"
ALLOW_PARALLEL_QUICK="$3"
ALLOW_KALSHI_FIRST_EXACT="$4"

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

set_env_value() {
  local key="$1"
  local value="$2"
  "${SUDO[@]}" node - "$ENV_FILE" "$key" "$value" <<'NODE'
const fs = require("node:fs");
const [envFile, key, value] = process.argv.slice(2);
const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
let changed = false;
const next = lines.map((line) => {
  if (!line || line.trimStart().startsWith("#")) return line;
  const index = line.indexOf("=");
  if (index < 0) return line;
  if (line.slice(0, index).trim() !== key) return line;
  changed = true;
  return `${key}=${value}`;
});
if (!changed) next.push(`${key}=${value}`);
fs.writeFileSync(envFile, next.join("\n"));
NODE
}

apply_safety_env_policy() {
  echo "Applying Hostinger exact-share safety env policy."
  local current_placement_mode
  local placement_mode
  current_placement_mode="$(read_env_value LIVE_ORDER_PLACEMENT_MODE || true)"
  placement_mode=polymarket_first_exact
  if [ "$ALLOW_PARALLEL_QUICK" = "true" ] && [ "$current_placement_mode" = "parallel_quick" ]; then
    placement_mode=parallel_quick
  fi
  # T1.3 canary: keep the staged kalshi_first_exact mode only when explicitly opted in. Default reverts
  # to polymarket_first_exact, so omitting the flag is the automatic rollback.
  if [ "$ALLOW_KALSHI_FIRST_EXACT" = "true" ] && [ "$current_placement_mode" = "kalshi_first_exact" ]; then
    placement_mode=kalshi_first_exact
  fi
  if [ "$current_placement_mode" = "parallel_quick" ] && [ "$placement_mode" != "parallel_quick" ]; then
    echo "Parallel quick was staged but is not resume-allowed; using polymarket_first_exact."
  fi
  if [ "$current_placement_mode" = "kalshi_first_exact" ] && [ "$placement_mode" != "kalshi_first_exact" ]; then
    echo "kalshi_first_exact was staged but is not resume-allowed; using polymarket_first_exact."
  fi
  set_env_value LIVE_ORDER_PLACEMENT_MODE "$placement_mode"
  set_env_value LIVE_KALSHI_HEDGE_TIME_IN_FORCE fill_or_kill
  set_env_value LIVE_ORDER_TIMEOUT_MS 2500
  set_env_value LIVE_HEDGE_RETRY_ATTEMPTS 2
  set_env_value LIVE_HEDGE_MAX_LOSS_DOLLARS 0.03
  set_env_value POLYMARKET_ORDER_TYPE FAK
  set_env_value LIVE_ORDER_SIZE 5
  set_env_value LIVE_MIN_BOOK_DEPTH_SHARES 10
  set_env_value LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES ""
  set_env_value LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES 15
  set_env_value LIVE_KALSHI_MIN_CASH_DOLLARS 5
  set_env_value LIVE_RECONCILE_BEFORE_TRADE true
  # Auto-hardlocks + execution-quality gate OFF by default (operator choice 2026-06-24); not forced here so an
  # explicit =true in worker.env persists. See hostinger-branch-deploy.sh.
  set_env_value LIVE_USER_STREAMS_ENABLED true
}

wait_for_health() {
  local attempts="${1:-30}"
  local delay_seconds="${2:-2}"
  local attempt

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl -fsS http://127.0.0.1:8080/health >/dev/null; then
      return 0
    fi
    sleep "$delay_seconds"
  done

  echo "Worker health did not become available after $((attempts * delay_seconds)) seconds." >&2
  "${SUDO[@]}" systemctl --no-pager --full status pok-worker >&2 || true
  exit 12
}

readiness_check() {
  local require_arb_enabled="$1"
  local token="$2"
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
const requireArbEnabled = String(process.env.REQUIRE_ARB_ENABLED ?? "false") === "true";
const runtimeHealth = snapshot.health ?? {};
const execution = snapshot.execution ?? {};
const kalshi = execution.kalshi ?? {};
const polymarket = execution.polymarket ?? {};
const userStreams = execution.userStreams ?? {};
const reconciliation = execution.reconciliation ?? {};
const books = snapshot.books ?? {};
const quarantinedExposure = Number(reconciliation.quarantinedExposureDollars ?? 0);
const quarantineCap = Number(reconciliation.quarantineCapDollars ?? Number.POSITIVE_INFINITY);
const riskState = execution.riskState ?? "unknown";
const liveOrderPlacementMode = health.liveOrderPlacementMode ?? null;
const kalshiHedgeOrderMode = health.kalshiHedgeOrderMode ?? runtimeHealth.kalshiHedgeOrderMode ?? null;
const liveKalshiHedgeTimeInForce = health.liveKalshiHedgeTimeInForce ?? runtimeHealth.liveKalshiHedgeTimeInForce ?? null;
const kalshiUiQuickOrderCapValidated =
  health.kalshiUiQuickOrderCapValidated ?? runtimeHealth.kalshiUiQuickOrderCapValidated ?? null;

const checks = [
  ["health.ok", health.ok === true],
  ["health.arbEnabled", !requireArbEnabled || health.arbEnabled === true],
  ["health.liveTrading=true", health.liveTrading === true],
  ["health.liveOrderPlacementMode supported", liveOrderPlacementMode === "polymarket_first_exact" || liveOrderPlacementMode === "parallel_quick" || liveOrderPlacementMode === "kalshi_first_exact"],
  ["health.liveKalshiHedgeTimeInForce=ioc-or-fok", liveKalshiHedgeTimeInForce === "immediate_or_cancel" || liveKalshiHedgeTimeInForce === "fill_or_kill"],
  [
    "health.kalshiHedgeOrderMode=ui_quick_order, fix_ioc, or public_v2 when parallel_quick",
    liveOrderPlacementMode !== "parallel_quick" || kalshiHedgeOrderMode === "ui_quick_order" || kalshiHedgeOrderMode === "fix_ioc" || kalshiHedgeOrderMode === "public_v2",
  ],
  ["health.liveOrderSize=5", Number(health.liveOrderSize) === 5],
  ["health.liveMinBookDepthShares>=10", Number(health.liveMinBookDepthShares) >= 10],
  ["health.liveKalshiMinCashDollars>=5", Number(health.liveKalshiMinCashDollars) >= 5],
  ["health.livePolymarketFirstMinFillShares=5", Number(health.livePolymarketFirstMinFillShares) === 5],
  ["health.livePolymarketFirstMaxFillShares=orderSize+1", Number(health.livePolymarketFirstMaxFillShares) === Number(health.liveOrderSize) + 1],
  ["health.liveAutoHardlocksEnabled=true", health.liveAutoHardlocksEnabled === true],
  [
    "health.kalshiUiQuickOrderCapValidated=true when ui_quick_order",
    kalshiHedgeOrderMode !== "ui_quick_order" || kalshiUiQuickOrderCapValidated === true,
  ],
  ["execution.partialFillLocked=false", execution.partialFillLocked === false],
  ["execution.circuitBreakerLocked=false", execution.circuitBreakerLocked === false],
  ["execution.riskState not blocked", !["blocked", "hard_locked", "auto_hardlocks_disabled"].includes(riskState)],
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
  ["execution.reconciliation.quarantinedExposure<=cap", quarantinedExposure <= quarantineCap],
  ["execution.userStreams.confirmTimeoutMs<=2500", runtimeHealth.liveUserStreamsEnabled !== true || Number(userStreams.confirmTimeoutMs) <= 2500],
  ["books.kalshi.length>0", Array.isArray(books.kalshi) && books.kalshi.length > 0],
  ["books.polymarket.length>0", Array.isArray(books.polymarket) && books.polymarket.length > 0],
];

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({
  arbEnabled: health.arbEnabled,
  requireArbEnabled,
  liveOrderPlacementMode,
  liveKalshiHedgeTimeInForce,
  liveOrderSize: health.liveOrderSize,
  liveMinBookDepthShares: health.liveMinBookDepthShares,
  liveKalshiMinCashDollars: health.liveKalshiMinCashDollars,
  kalshiHedgeOrderMode,
  kalshiUiQuickOrderCapValidated,
  kalshiFixHost: health.kalshiFixHost ?? runtimeHealth.kalshiFixHost ?? null,
  kalshiFixPort: health.kalshiFixPort ?? runtimeHealth.kalshiFixPort ?? null,
  kalshiFixTargetCompId: health.kalshiFixTargetCompId ?? runtimeHealth.kalshiFixTargetCompId ?? null,
  kalshiFixUseDollars: health.kalshiFixUseDollars ?? runtimeHealth.kalshiFixUseDollars ?? null,
  riskState,
  riskStateReason: execution.riskStateReason ?? null,
  partialFillLocked: execution.partialFillLocked,
  circuitBreakerLocked: execution.circuitBreakerLocked,
  kalshiReady: kalshi.ready,
  kalshiReason: kalshi.reason ?? null,
  kalshiBalance: kalshi.balance ?? null,
  kalshiRequiredCollateral: kalshi.requiredCollateral ?? null,
  polymarketReady: polymarket.ready,
  polymarketReason: polymarket.reason ?? null,
  geoblockBlocked: polymarket.geoblockBlocked,
  geoblockCountry: polymarket.geoblockCountry,
  geoblockRegion: polymarket.geoblockRegion,
  userStreamsReady: userStreams.ready,
  reconciliationClean: reconciliation.clean,
  quarantinedExposureDollars: reconciliation.quarantinedExposureDollars ?? null,
  quarantinedSignalCount: reconciliation.quarantinedSignalCount ?? null,
  quarantineCapDollars: reconciliation.quarantineCapDollars ?? null,
  kalshiBooks: books.kalshi?.length ?? 0,
  polymarketBooks: books.polymarket?.length ?? 0,
  failedChecks: failed.map(([name]) => name),
}, null, 2));

if (failed.length > 0) {
  console.error(`Readiness failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exit(30);
}
NODE
}

completion_report() {
  local database_url
  database_url="$(read_env_value DATABASE_URL || true)"
  if [ -z "$database_url" ]; then
    echo "DATABASE_URL is empty; skipping completion-rate report." >&2
    return 0
  fi
  run_app env DATABASE_URL="$database_url" npx tsx scripts/completion-rate-report.ts --limit=20
}

cd "$APP_DIR"
echo "Hostinger resume target:"
echo "service=$(systemctl is-active pok-worker || true)"
echo "branch=$(run_app git -C "$APP_DIR" branch --show-current)"
echo "commit=$(run_app git -C "$APP_DIR" rev-parse --short HEAD)"

DASHBOARD_API_TOKEN="$(read_env_value DASHBOARD_API_TOKEN)"
if [ -z "$DASHBOARD_API_TOKEN" ]; then
  echo "DASHBOARD_API_TOKEN is empty in $ENV_FILE" >&2
  exit 11
fi

BACKUP_FILE="${ENV_FILE}.resume-backup.$(date -u +%Y%m%dT%H%M%SZ)"
"${SUDO[@]}" cp "$ENV_FILE" "$BACKUP_FILE"
"${SUDO[@]}" chmod 600 "$BACKUP_FILE"
echo "Backed up env to $BACKUP_FILE"

echo "Pausing entries while resume readiness is verified."
set_env_value ARB_ENABLED false
apply_safety_env_policy
"${SUDO[@]}" systemctl restart pok-worker
wait_for_health

# The worker answers /health before order books finish subscribing after a restart, so the
# books.*.length>0 gates can fail transiently for a few seconds. Poll until green or a bounded
# timeout before treating it as a real readiness failure.
set +e
READINESS_STATUS=30
for ((readiness_attempt = 1; readiness_attempt <= 12; readiness_attempt += 1)); do
  readiness_check false "$DASHBOARD_API_TOKEN"
  READINESS_STATUS=$?
  if [ "$READINESS_STATUS" -eq 0 ]; then
    break
  fi
  echo "Resume readiness not green yet (attempt ${readiness_attempt}/12); waiting for order books / scan warmup..."
  sleep 5
done
set -e

if [ "$READINESS_STATUS" -ne 0 ]; then
  echo "Readiness is not green after the warmup window; leaving ARB_ENABLED=false."
  echo "Completion-rate report while paused:"
  completion_report || true
  exit "$READINESS_STATUS"
fi

echo "Readiness is green with entries paused; restoring ARB_ENABLED=true."
set_env_value ARB_ENABLED true
"${SUDO[@]}" systemctl restart pok-worker
wait_for_health

# Post-enable confirmation, with the same warmup tolerance. ARB is already enabled at this point,
# so a transient miss is a warning, not a failure.
set +e
FINAL_READINESS_STATUS=30
for ((readiness_attempt = 1; readiness_attempt <= 12; readiness_attempt += 1)); do
  readiness_check true "$DASHBOARD_API_TOKEN"
  FINAL_READINESS_STATUS=$?
  if [ "$FINAL_READINESS_STATUS" -eq 0 ]; then
    break
  fi
  echo "Post-enable readiness not green yet (attempt ${readiness_attempt}/12); waiting for warmup..."
  sleep 5
done
set -e
if [ "$FINAL_READINESS_STATUS" -ne 0 ]; then
  echo "WARNING: ARB_ENABLED=true but post-enable readiness did not confirm green within the warmup window; inspect before relying on it." >&2
fi

echo "Completion-rate report after resume:"
completion_report
REMOTE
