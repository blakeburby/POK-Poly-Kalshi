#!/usr/bin/env bash
set -euo pipefail

if [ -z "${HOSTINGER_SSH_TARGET:-}" ]; then
  echo "HOSTINGER_SSH_TARGET is required, for example: HOSTINGER_SSH_TARGET=root@187.77.145.117" >&2
  exit 2
fi

APP_DIR="${HOSTINGER_APP_DIR:-/opt/pok-poly-kalshi}"
ENV_FILE="${HOSTINGER_ENV_FILE:-/etc/pok-poly-kalshi/worker.env}"
LOCAL_SCRIPT="scripts/resolve-live-lock-after-settlement.ts"

if [ ! -f "$LOCAL_SCRIPT" ]; then
  echo "Run this command from the repo root; $LOCAL_SCRIPT was not found." >&2
  exit 2
fi

REMOTE_SCRIPT="$(
  ssh "$HOSTINGER_SSH_TARGET" bash -s -- "$APP_DIR" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"
mkdir -p "$APP_DIR/tmp/operator"
mktemp "$APP_DIR/tmp/operator/resolve-live-lock-after-settlement.XXXXXX.ts"
REMOTE
)"

scp -q "$LOCAL_SCRIPT" "$HOSTINGER_SSH_TARGET:$REMOTE_SCRIPT"

ssh "$HOSTINGER_SSH_TARGET" bash -s -- "$APP_DIR" "$ENV_FILE" "$REMOTE_SCRIPT" "$@" <<'REMOTE'
set -euo pipefail

APP_DIR="$1"
ENV_FILE="$2"
REMOTE_SCRIPT="$3"
shift 3

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

cd "$APP_DIR"
if [ "$RUN_AS_POK" = true ]; then
  "${SUDO[@]}" chown pok:pok "$APP_DIR/tmp" "$APP_DIR/tmp/operator" "$REMOTE_SCRIPT"
  "${SUDO[@]}" chmod 700 "$APP_DIR/tmp" "$APP_DIR/tmp/operator"
  "${SUDO[@]}" chmod 600 "$REMOTE_SCRIPT"
else
  "${SUDO[@]}" chmod 700 "$APP_DIR/tmp" "$APP_DIR/tmp/operator"
  "${SUDO[@]}" chmod 600 "$REMOTE_SCRIPT"
fi

ARB_ENABLED="$(read_env_value ARB_ENABLED || true)"
DATABASE_URL="$(read_env_value DATABASE_URL || true)"
DASHBOARD_API_TOKEN="$(read_env_value DASHBOARD_API_TOKEN || true)"

echo "Hostinger live-lock settlement resolution target:"
echo "service=$(systemctl is-active pok-worker || true)"
echo "branch=$(run_app git -C "$APP_DIR" branch --show-current)"
echo "commit=$(run_app git -C "$APP_DIR" rev-parse --short HEAD)"
echo "arbEnabled=${ARB_ENABLED:-<unset>}"

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is empty in $ENV_FILE" >&2
  exit 11
fi
if [ -z "$DASHBOARD_API_TOKEN" ]; then
  echo "DASHBOARD_API_TOKEN is empty in $ENV_FILE" >&2
  exit 11
fi

run_app env \
  DATABASE_URL="$DATABASE_URL" \
  DASHBOARD_API_TOKEN="$DASHBOARD_API_TOKEN" \
  npx tsx "$REMOTE_SCRIPT" "$@"
REMOTE
