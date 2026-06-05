#!/usr/bin/env bash
set -euo pipefail

if [ -z "${HOSTINGER_SSH_TARGET:-}" ]; then
  echo "HOSTINGER_SSH_TARGET is required, for example: HOSTINGER_SSH_TARGET=user@host" >&2
  exit 2
fi

DEPLOY_BRANCH="${DEPLOY_BRANCH:-hostinger-exact-share-readiness}"
APP_DIR="${HOSTINGER_APP_DIR:-/opt/pok-poly-kalshi}"
ENV_FILE="${HOSTINGER_ENV_FILE:-/etc/pok-poly-kalshi/worker.env}"

ssh "$HOSTINGER_SSH_TARGET" bash -s -- "$DEPLOY_BRANCH" "$APP_DIR" "$ENV_FILE" <<'REMOTE'
set -euo pipefail

DEPLOY_BRANCH="$1"
APP_DIR="$2"
ENV_FILE="$3"

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

if [ -n "$(run_app git -C "$APP_DIR" status --porcelain)" ]; then
  echo "Remote worktree is dirty; refusing to deploy." >&2
  run_app git -C "$APP_DIR" status --short >&2
  exit 10
fi

ARB_WAS_ENABLED="$(read_env_value ARB_ENABLED || true)"
BACKUP_FILE="${ENV_FILE}.backup.$(date -u +%Y%m%dT%H%M%SZ)"
"${SUDO[@]}" cp "$ENV_FILE" "$BACKUP_FILE"
"${SUDO[@]}" chmod 600 "$BACKUP_FILE"
echo "Backed up env to $BACKUP_FILE"

if [ "$ARB_WAS_ENABLED" = "true" ]; then
  echo "Pausing live entries before deploy."
  set_env_value ARB_ENABLED false
  "${SUDO[@]}" systemctl restart pok-worker
fi

run_app git -C "$APP_DIR" fetch origin "$DEPLOY_BRANCH"
run_app git -C "$APP_DIR" checkout -B "$DEPLOY_BRANCH" FETCH_HEAD
cd "$APP_DIR"
run_app npm ci
run_app npm run build:worker

echo "Restarting worker; systemd ExecStartPre will run migrations with the service env."
"${SUDO[@]}" systemctl restart pok-worker
sleep 5

echo "Health after deploy:"
curl -fsS http://127.0.0.1:8080/health
echo

echo "Public readiness after deploy:"
WORKER_API_BASE=http://127.0.0.1:8080 npm run readiness:public

DASHBOARD_API_TOKEN="$(read_env_value DASHBOARD_API_TOKEN)"
if [ -z "$DASHBOARD_API_TOKEN" ]; then
  echo "DASHBOARD_API_TOKEN is empty in $ENV_FILE" >&2
  exit 11
fi

echo "Protected readiness while entries are paused:"
DASHBOARD_API_TOKEN="$DASHBOARD_API_TOKEN" REQUIRE_ARB_ENABLED=false WORKER_API_BASE=http://127.0.0.1:8080 bash scripts/verify-live-readiness.sh

if [ "$ARB_WAS_ENABLED" = "true" ]; then
  echo "Protected readiness is green; restoring ARB_ENABLED=true."
  set_env_value ARB_ENABLED true
  "${SUDO[@]}" systemctl restart pok-worker
  sleep 5
  DASHBOARD_API_TOKEN="$DASHBOARD_API_TOKEN" WORKER_API_BASE=http://127.0.0.1:8080 bash scripts/verify-live-readiness.sh
else
  echo "ARB_ENABLED was not true before deploy; leaving entries paused."
fi

DATABASE_URL="$(read_env_value DATABASE_URL)"
if [ -n "$DATABASE_URL" ]; then
  echo "Completion-rate report after deploy:"
  run_app env DATABASE_URL="$DATABASE_URL" npx tsx scripts/completion-rate-report.ts --limit=20
else
  echo "DATABASE_URL is empty; skipping completion-rate report." >&2
fi
REMOTE
