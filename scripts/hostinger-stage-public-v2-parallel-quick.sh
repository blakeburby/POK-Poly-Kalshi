#!/usr/bin/env bash
set -euo pipefail

if [ -z "${HOSTINGER_SSH_TARGET:-}" ]; then
  echo "HOSTINGER_SSH_TARGET is required, for example: HOSTINGER_SSH_TARGET=user@host" >&2
  exit 2
fi

APP_DIR="${HOSTINGER_APP_DIR:-/opt/pok-poly-kalshi}"
ENV_FILE="${HOSTINGER_ENV_FILE:-/etc/pok-poly-kalshi/worker.env}"

ssh "$HOSTINGER_SSH_TARGET" bash -s -- "$APP_DIR" "$ENV_FILE" <<'REMOTE'
set -euo pipefail

APP_DIR="$1"
ENV_FILE="$2"

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

verify_staged_health() {
  local health_file
  health_file="$(mktemp)"
  trap 'rm -f "$health_file"' RETURN

  curl -fsS http://127.0.0.1:8080/health > "$health_file"
  node - "$health_file" <<'NODE'
const fs = require("node:fs");
const health = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const checks = [
  ["health.ok", health.ok === true],
  ["health.arbEnabled=false", health.arbEnabled === false],
  ["health.liveTrading=true", health.liveTrading === true],
  ["health.liveOrderPlacementMode=parallel_quick", health.liveOrderPlacementMode === "parallel_quick"],
  ["health.kalshiHedgeOrderMode=public_v2", health.kalshiHedgeOrderMode === "public_v2"],
  ["health.liveKalshiHedgeTimeInForce=immediate_or_cancel", health.liveKalshiHedgeTimeInForce === "immediate_or_cancel"],
  ["health.liveOrderSize=5", Number(health.liveOrderSize) === 5],
  ["health.liveMinBookDepthShares>=10", Number(health.liveMinBookDepthShares) >= 10],
  ["health.liveKalshiMinCashDollars>=5", Number(health.liveKalshiMinCashDollars) >= 5],
];
const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({
  ok: health.ok,
  arbEnabled: health.arbEnabled,
  liveTrading: health.liveTrading,
  liveOrderPlacementMode: health.liveOrderPlacementMode,
  kalshiHedgeOrderMode: health.kalshiHedgeOrderMode ?? null,
  liveKalshiHedgeTimeInForce: health.liveKalshiHedgeTimeInForce ?? null,
  liveOrderSize: health.liveOrderSize,
  liveMinBookDepthShares: health.liveMinBookDepthShares,
  liveKalshiMinCashDollars: health.liveKalshiMinCashDollars,
  failedChecks: failed.map(([name]) => name),
}, null, 2));
if (failed.length > 0) {
  console.error(`Public V2 parallel_quick staged health failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exit(23);
}
NODE
}

cd "$APP_DIR"
echo "Hostinger public V2 parallel_quick staging target:"
echo "service=$(systemctl is-active pok-worker || true)"
echo "branch=$(run_app git -C "$APP_DIR" branch --show-current)"
echo "commit=$(run_app git -C "$APP_DIR" rev-parse --short HEAD)"

BACKUP_FILE="${ENV_FILE}.public-v2-parallel-quick-stage-backup.$(date -u +%Y%m%dT%H%M%SZ)"
"${SUDO[@]}" cp "$ENV_FILE" "$BACKUP_FILE"
"${SUDO[@]}" chmod 600 "$BACKUP_FILE"
echo "Backed up env to $BACKUP_FILE"

echo "Staging supported public V2 IOC parallel_quick mode with live entries paused."
set_env_value ARB_ENABLED false
set_env_value LIVE_ORDER_PLACEMENT_MODE parallel_quick
set_env_value LIVE_KALSHI_HEDGE_TIME_IN_FORCE immediate_or_cancel
set_env_value KALSHI_HEDGE_ORDER_MODE public_v2
set_env_value POLYMARKET_ORDER_TYPE FAK
set_env_value LIVE_ORDER_SIZE 5
set_env_value LIVE_MIN_BOOK_DEPTH_SHARES 10
set_env_value LIVE_KALSHI_MIN_CASH_DOLLARS 5
set_env_value LIVE_RECONCILE_BEFORE_TRADE true
# Auto-hardlocks + execution-quality gate OFF by default (operator choice 2026-06-24); not forced here so an
# explicit =true in worker.env persists. See hostinger-branch-deploy.sh.
set_env_value LIVE_USER_STREAMS_ENABLED true

"${SUDO[@]}" systemctl restart pok-worker
wait_for_health

echo "Public health after public V2 parallel_quick staging:"
verify_staged_health

echo "Public V2 parallel_quick mode is staged with ARB_ENABLED=false. Resume only after protected readiness is green."
REMOTE
