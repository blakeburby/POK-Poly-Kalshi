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
  $1 ~ /^(ARB_ENABLED|LIVE_ORDER_PLACEMENT_MODE|LIVE_ORDER_SIZE|LIVE_MIN_BOOK_DEPTH_SHARES|LIVE_POLYMARKET_FIRST_MIN_FILL_SHARES|LIVE_POLYMARKET_FIRST_MAX_FILL_SHARES|LIVE_RECONCILE_BEFORE_TRADE|LIVE_AUTO_HARDLOCKS_ENABLED|LIVE_EXACT_EXPOSURE_REQUIRED|LIVE_EXECUTION_QUALITY_GATE_ENABLED)$/ {
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

echo "Protected readiness with current ARB requirement:"
DASHBOARD_API_TOKEN="$DASHBOARD_API_TOKEN" WORKER_API_BASE=http://127.0.0.1:8080 bash scripts/verify-live-readiness.sh

DATABASE_URL="$(read_env_value DATABASE_URL)"
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is empty in $ENV_FILE" >&2
  exit 4
fi

echo "Completion-rate report:"
cd "$APP_DIR"
run_app env DATABASE_URL="$DATABASE_URL" npx tsx scripts/completion-rate-report.ts --limit=20
REMOTE
