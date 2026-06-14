#!/usr/bin/env bash
set -euo pipefail

if [ -z "${HOSTINGER_SSH_TARGET:-}" ]; then
  echo "HOSTINGER_SSH_TARGET is required, for example: HOSTINGER_SSH_TARGET=user@host" >&2
  exit 2
fi

APP_DIR="${HOSTINGER_APP_DIR:-/opt/pok-poly-kalshi}"
ENV_FILE="${HOSTINGER_ENV_FILE:-/etc/pok-poly-kalshi/worker.env}"
CAP_TEST_COUNT="${KALSHI_UI_CAP_TEST_COUNT:-1}"
CAP_TEST_MAX_PRICE_CENTS="${KALSHI_UI_CAP_TEST_MAX_PRICE_CENTS:-1}"
CAP_TEST_TICKER="${KALSHI_UI_CAP_TEST_TICKER:-}"
CAP_TEST_SIDE="${KALSHI_UI_CAP_TEST_SIDE:-}"
CAP_TEST_REPORT_DIR="${KALSHI_UI_CAP_TEST_REPORT_DIR:-/opt/pok-poly-kalshi/tmp/kalshi-ui-cap-validation}"
CAP_TEST_TICKER_ARG="${CAP_TEST_TICKER:-__empty__}"
CAP_TEST_SIDE_ARG="${CAP_TEST_SIDE:-__empty__}"

ssh "$HOSTINGER_SSH_TARGET" bash -s -- \
  "$APP_DIR" \
  "$ENV_FILE" \
  "$CAP_TEST_COUNT" \
  "$CAP_TEST_MAX_PRICE_CENTS" \
  "$CAP_TEST_TICKER_ARG" \
  "$CAP_TEST_SIDE_ARG" \
  "$CAP_TEST_REPORT_DIR" <<'REMOTE'
set -euo pipefail

APP_DIR="$1"
ENV_FILE="$2"
CAP_TEST_COUNT="$3"
CAP_TEST_MAX_PRICE_CENTS="$4"
CAP_TEST_TICKER="$5"
CAP_TEST_SIDE="$6"
CAP_TEST_REPORT_DIR="$7"
if [ "$CAP_TEST_TICKER" = "__empty__" ]; then
  CAP_TEST_TICKER=""
fi
if [ "$CAP_TEST_SIDE" = "__empty__" ]; then
  CAP_TEST_SIDE=""
fi

SUDO=()
if [ "$(id -u)" -ne 0 ]; then
  SUDO=(sudo -n)
fi

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

fail() {
  echo "$1" >&2
  exit "${2:-20}"
}

require_env_value() {
  local key="$1"
  local value
  value="$(read_env_value "$key" || true)"
  if [ -z "$value" ]; then
    fail "$key is empty in $ENV_FILE" 21
  fi
  printf '%s' "$value"
}

validate_session_file() {
  local session_path="$1"
  "${SUDO[@]}" node - "$session_path" <<'NODE'
const fs = require("node:fs");
const sessionPath = process.argv[2];
if (!fs.existsSync(sessionPath)) {
  console.error(`Kalshi UI session file is missing: ${sessionPath}`);
  process.exit(22);
}
const stat = fs.statSync(sessionPath);
const mode = stat.mode & 0o777;
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
} catch {
  console.error("Kalshi UI session JSON is not valid JSON.");
  process.exit(22);
}
const headers = parsed && typeof parsed.headers === "object" && !Array.isArray(parsed.headers) ? parsed.headers : {};
const hasCookie = String(parsed.cookie ?? "").trim().length > 0;
const hasWafToken = String(headers["x-aws-waf-token"] ?? headers["X-AWS-WAF-Token"] ?? "").trim().length > 0;
const failures = [];
if ((mode & 0o077) !== 0) failures.push(`mode ${mode.toString(8)} is not root-only`);
if (stat.uid !== 0) failures.push("owner is not root");
if (String(parsed.userId ?? "").trim().length === 0) failures.push("missing userId");
if (String(parsed.csrfToken ?? parsed.csrf_token ?? parsed["x-csrf-token"] ?? "").trim().length === 0) failures.push("missing csrfToken");
if (!hasCookie && !hasWafToken) failures.push("missing cookie or x-aws-waf-token header");
console.log(JSON.stringify({
  kalshiUiSessionPath: sessionPath,
  mode: mode.toString(8).padStart(4, "0"),
  rootOwned: stat.uid === 0,
  userIdPresent: String(parsed.userId ?? "").trim().length > 0,
  cookiePresent: hasCookie,
  wafTokenPresent: hasWafToken,
  csrfTokenPresent: String(parsed.csrfToken ?? parsed.csrf_token ?? parsed["x-csrf-token"] ?? "").trim().length > 0,
}, null, 2));
if (failures.length > 0) {
  console.error(`Kalshi UI session guard failed: ${failures.join(", ")}`);
  process.exit(22);
}
NODE
}

service_state="$(systemctl is-active pok-worker || true)"
if [ "$service_state" != "active" ]; then
  fail "pok-worker must be active before cap validation; current state: $service_state" 23
fi

if [ ! -d "$APP_DIR/.git" ]; then
  fail "Hostinger app checkout is missing or not a git repo: $APP_DIR" 24
fi

ARB_ENABLED="$(read_env_value ARB_ENABLED || true)"
PLACEMENT_MODE="$(read_env_value LIVE_ORDER_PLACEMENT_MODE || true)"
HEDGE_MODE="$(read_env_value KALSHI_HEDGE_ORDER_MODE || true)"
CAP_VALIDATED="$(read_env_value KALSHI_UI_QUICK_ORDER_CAP_VALIDATED || true)"
SESSION_PATH="$(read_env_value KALSHI_UI_SESSION_PATH || true)"
if [ -z "$SESSION_PATH" ]; then
  SESSION_PATH="/etc/pok-poly-kalshi/kalshi-ui-session.json"
fi

echo "Hostinger Kalshi UI cap-validation target:"
echo "service=$service_state"
echo "branch=$(git -C "$APP_DIR" branch --show-current)"
echo "commit=$(git -C "$APP_DIR" rev-parse --short HEAD)"
echo "arbEnabled=$ARB_ENABLED"
echo "liveOrderPlacementMode=$PLACEMENT_MODE"
echo "kalshiHedgeOrderMode=$HEDGE_MODE"
echo "kalshiUiQuickOrderCapValidated=$CAP_VALIDATED"
echo "kalshiUiSessionPath=$SESSION_PATH"
echo "capTestCount=$CAP_TEST_COUNT"
echo "capTestMaxPriceCents=$CAP_TEST_MAX_PRICE_CENTS"
if [ -n "$CAP_TEST_TICKER" ]; then echo "capTestTicker=$CAP_TEST_TICKER"; fi
if [ -n "$CAP_TEST_SIDE" ]; then echo "capTestSide=$CAP_TEST_SIDE"; fi

[ "$ARB_ENABLED" = "false" ] || fail "Refusing cap validation unless ARB_ENABLED=false." 25
[ "$PLACEMENT_MODE" = "parallel_quick" ] || fail "Refusing cap validation unless LIVE_ORDER_PLACEMENT_MODE=parallel_quick." 26
[ "$HEDGE_MODE" = "ui_quick_order" ] || fail "Refusing cap validation unless KALSHI_HEDGE_ORDER_MODE=ui_quick_order." 27
[ "$CAP_VALIDATED" != "true" ] || fail "Refusing tiny cap validation because KALSHI_UI_QUICK_ORDER_CAP_VALIDATED is already true." 28
[ "$CAP_TEST_COUNT" = "1" ] || fail "KALSHI_UI_CAP_TEST_COUNT must be exactly 1." 29
[ "$CAP_TEST_MAX_PRICE_CENTS" = "1" ] || fail "KALSHI_UI_CAP_TEST_MAX_PRICE_CENTS must be exactly 1." 30

validate_session_file "$SESSION_PATH"

DASHBOARD_API_TOKEN="$(require_env_value DASHBOARD_API_TOKEN)"
mkdir -p "$CAP_TEST_REPORT_DIR"
chmod 700 "$CAP_TEST_REPORT_DIR"

cd "$APP_DIR"
"${SUDO[@]}" env \
  WORKER_API_BASE=http://127.0.0.1:8080 \
  DASHBOARD_API_TOKEN="$DASHBOARD_API_TOKEN" \
  KALSHI_UI_SESSION_PATH="$SESSION_PATH" \
  KALSHI_UI_CAP_TEST_COUNT="$CAP_TEST_COUNT" \
  KALSHI_UI_CAP_TEST_MAX_PRICE_CENTS="$CAP_TEST_MAX_PRICE_CENTS" \
  KALSHI_UI_CAP_TEST_TICKER="$CAP_TEST_TICKER" \
  KALSHI_UI_CAP_TEST_SIDE="$CAP_TEST_SIDE" \
  KALSHI_UI_CAP_TEST_REPORT_DIR="$CAP_TEST_REPORT_DIR" \
  npx tsx scripts/kalshi-ui-cap-validate.ts

echo "Kalshi UI cap-validation completed. ARB_ENABLED was not changed."
REMOTE
