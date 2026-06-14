#!/usr/bin/env bash
set -euo pipefail

if [ -z "${HOSTINGER_SSH_TARGET:-}" ]; then
  echo "HOSTINGER_SSH_TARGET is required, for example: HOSTINGER_SSH_TARGET=user@host" >&2
  exit 2
fi

if [ -n "${KALSHI_UI_SESSION_JSON:-}" ] && [ -n "${KALSHI_UI_SESSION_LOCAL_PATH:-}" ]; then
  echo "Set only one of KALSHI_UI_SESSION_JSON or KALSHI_UI_SESSION_LOCAL_PATH." >&2
  exit 2
fi

APP_DIR="${HOSTINGER_APP_DIR:-/opt/pok-poly-kalshi}"
ENV_FILE="${HOSTINGER_ENV_FILE:-/etc/pok-poly-kalshi/worker.env}"
SESSION_PATH="${KALSHI_UI_SESSION_PATH:-/etc/pok-poly-kalshi/kalshi-ui-session.json}"
STAGE_PLACEMENT_MODE="${HOSTINGER_STAGE_PLACEMENT_MODE:-polymarket_first_exact}"
SESSION_STAGED_TMP=""
LOCAL_SESSION_TMP=""

cleanup() {
  if [ -n "$LOCAL_SESSION_TMP" ]; then
    rm -f "$LOCAL_SESSION_TMP"
  fi
  if [ -n "$SESSION_STAGED_TMP" ]; then
    ssh "$HOSTINGER_SSH_TARGET" "rm -f '$SESSION_STAGED_TMP'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

stage_session_source=""
if [ -n "${KALSHI_UI_SESSION_JSON:-}" ]; then
  LOCAL_SESSION_TMP="$(mktemp)"
  chmod 600 "$LOCAL_SESSION_TMP"
  printf '%s' "$KALSHI_UI_SESSION_JSON" > "$LOCAL_SESSION_TMP"
  stage_session_source="$LOCAL_SESSION_TMP"
elif [ -n "${KALSHI_UI_SESSION_LOCAL_PATH:-}" ]; then
  if [ ! -f "$KALSHI_UI_SESSION_LOCAL_PATH" ]; then
    echo "KALSHI_UI_SESSION_LOCAL_PATH does not exist: $KALSHI_UI_SESSION_LOCAL_PATH" >&2
    exit 2
  fi
  LOCAL_SESSION_TMP="$(mktemp)"
  chmod 600 "$LOCAL_SESSION_TMP"
  cp "$KALSHI_UI_SESSION_LOCAL_PATH" "$LOCAL_SESSION_TMP"
  stage_session_source="$LOCAL_SESSION_TMP"
fi

if [ -n "$stage_session_source" ]; then
  SESSION_STAGED_TMP="$(ssh "$HOSTINGER_SSH_TARGET" 'tmp="$(mktemp /tmp/kalshi-ui-session.XXXXXX)" && chmod 600 "$tmp" && echo "$tmp"')"
  scp -q "$stage_session_source" "$HOSTINGER_SSH_TARGET:$SESSION_STAGED_TMP"
fi

SESSION_STAGED_TMP_ARG="${SESSION_STAGED_TMP:-__none__}"

ssh "$HOSTINGER_SSH_TARGET" bash -s -- "$APP_DIR" "$ENV_FILE" "$SESSION_PATH" "$SESSION_STAGED_TMP_ARG" "$STAGE_PLACEMENT_MODE" <<'REMOTE'
set -euo pipefail

APP_DIR="$1"
ENV_FILE="$2"
SESSION_PATH="$3"
SESSION_STAGED_TMP="$4"
STAGE_PLACEMENT_MODE="$5"
if [ "$SESSION_STAGED_TMP" = "__none__" ]; then
  SESSION_STAGED_TMP=""
fi

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

install_session_file() {
  if [ -z "$SESSION_STAGED_TMP" ]; then
    return 0
  fi

  echo "Installing Kalshi UI session file at $SESSION_PATH (contents redacted)."
  "${SUDO[@]}" install -d -m 755 -o root -g root "$(dirname "$SESSION_PATH")"
  "${SUDO[@]}" install -m 600 -o root -g root "$SESSION_STAGED_TMP" "$SESSION_PATH"
  rm -f "$SESSION_STAGED_TMP" || "${SUDO[@]}" rm -f "$SESSION_STAGED_TMP"
}

validate_session_file() {
  if ! "${SUDO[@]}" test -f "$SESSION_PATH"; then
    echo "Kalshi UI session file is missing: $SESSION_PATH" >&2
    echo "Provide one with KALSHI_UI_SESSION_LOCAL_PATH=/path/to/session.json or KALSHI_UI_SESSION_JSON='{\"userId\":\"...\",\"csrfToken\":\"...\",\"headers\":{\"x-aws-waf-token\":\"...\"}}'." >&2
    return 21
  fi

  "${SUDO[@]}" node - "$SESSION_PATH" <<'NODE'
const fs = require("node:fs");
const sessionPath = process.argv[2];
const stat = fs.statSync(sessionPath);
const mode = stat.mode & 0o777;
const raw = fs.readFileSync(sessionPath, "utf8");
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  console.error("Kalshi UI session JSON is not valid JSON.");
  process.exit(22);
}

const requiredKeys = ["userId", "csrfToken"];
const missing = requiredKeys.filter((key) => String(parsed[key] ?? "").trim().length === 0);
const headers = parsed && typeof parsed.headers === "object" && !Array.isArray(parsed.headers) ? parsed.headers : {};
const hasCookie = String(parsed.cookie ?? "").trim().length > 0;
const hasWafToken =
  String(headers["x-aws-waf-token"] ?? headers["X-AWS-WAF-Token"] ?? "").trim().length > 0;
const failures = [];
if ((mode & 0o077) !== 0) failures.push(`mode ${mode.toString(8)} is not root-only`);
if (stat.uid !== 0) failures.push("owner is not root");
if (missing.length > 0) failures.push(`missing required keys: ${missing.join(", ")}`);
if (!hasCookie && !hasWafToken) failures.push("missing cookie or x-aws-waf-token header");

console.log(JSON.stringify({
  kalshiUiSessionPath: sessionPath,
  mode: mode.toString(8).padStart(4, "0"),
  rootOwned: stat.uid === 0,
  userIdPresent: String(parsed.userId ?? "").trim().length > 0,
  cookiePresent: hasCookie,
  wafTokenPresent: hasWafToken,
  csrfTokenPresent: String(parsed.csrfToken ?? "").trim().length > 0,
  userAgentPresent: String(parsed.userAgent ?? "").trim().length > 0,
}, null, 2));

if (failures.length > 0) {
  console.error(`Kalshi UI session guard failed: ${failures.join(", ")}`);
  process.exit(22);
}
NODE
}

verify_staged_health() {
  local health_file
  health_file="$(mktemp)"
  trap 'rm -f "$health_file"' RETURN

  curl -fsS http://127.0.0.1:8080/health > "$health_file"
  node - "$health_file" <<'NODE'
const fs = require("node:fs");
const health = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expectedPlacementMode = process.env.EXPECTED_PLACEMENT_MODE ?? "polymarket_first_exact";
const checks = [
  ["health.ok", health.ok === true],
  ["health.arbEnabled=false", health.arbEnabled === false],
  ["health.liveTrading=true", health.liveTrading === true],
  [`health.liveOrderPlacementMode=${expectedPlacementMode}`, health.liveOrderPlacementMode === expectedPlacementMode],
  ["health.kalshiHedgeOrderMode=ui_quick_order", health.kalshiHedgeOrderMode === "ui_quick_order"],
  ["health.kalshiUiQuickOrderCapValidated=false", health.kalshiUiQuickOrderCapValidated === false],
  ["health.liveOrderSize=5", Number(health.liveOrderSize) === 5],
  ["health.liveMinBookDepthShares>=10", Number(health.liveMinBookDepthShares) >= 10],
];
const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({
  ok: health.ok,
  arbEnabled: health.arbEnabled,
  liveTrading: health.liveTrading,
  liveOrderPlacementMode: health.liveOrderPlacementMode,
  liveOrderSize: health.liveOrderSize,
  liveMinBookDepthShares: health.liveMinBookDepthShares,
  kalshiHedgeOrderMode: health.kalshiHedgeOrderMode ?? null,
  kalshiUiQuickOrderCapValidated: health.kalshiUiQuickOrderCapValidated ?? null,
  failedChecks: failed.map(([name]) => name),
}, null, 2));
if (failed.length > 0) {
  console.error(`Staged health failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exit(23);
}
NODE
}

cd "$APP_DIR"
echo "Hostinger UI Quick Order staging target:"
echo "service=$(systemctl is-active pok-worker || true)"
echo "branch=$(run_app git -C "$APP_DIR" branch --show-current)"
echo "commit=$(run_app git -C "$APP_DIR" rev-parse --short HEAD)"

BACKUP_FILE="${ENV_FILE}.ui-quick-order-stage-backup.$(date -u +%Y%m%dT%H%M%SZ)"
"${SUDO[@]}" cp "$ENV_FILE" "$BACKUP_FILE"
"${SUDO[@]}" chmod 600 "$BACKUP_FILE"
echo "Backed up env to $BACKUP_FILE"

install_session_file
validate_session_file

echo "Staging Kalshi UI Quick Order mode with live entries paused."
set_env_value ARB_ENABLED false
set_env_value LIVE_ORDER_PLACEMENT_MODE "$STAGE_PLACEMENT_MODE"
set_env_value LIVE_ORDER_SIZE 5
set_env_value LIVE_MIN_BOOK_DEPTH_SHARES 10
set_env_value KALSHI_HEDGE_ORDER_MODE ui_quick_order
set_env_value KALSHI_UI_SESSION_PATH "$SESSION_PATH"
set_env_value KALSHI_UI_QUICK_ORDER_CAP_VALIDATED false

"${SUDO[@]}" systemctl restart pok-worker
wait_for_health

echo "Public health after UI Quick Order staging:"
EXPECTED_PLACEMENT_MODE="$STAGE_PLACEMENT_MODE" verify_staged_health

echo "UI Quick Order mode is staged with ARB_ENABLED=false. Do not resume until cap validation is proven."
REMOTE
