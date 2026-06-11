#!/usr/bin/env bash
set -euo pipefail

if [ -z "${HOSTINGER_SSH_TARGET:-}" ]; then
  echo "HOSTINGER_SSH_TARGET is required, for example: HOSTINGER_SSH_TARGET=root@187.77.145.117" >&2
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

snapshot_guard() {
  local token="$1"
  local health_file
  local snapshot_file
  health_file="$(mktemp)"
  snapshot_file="$(mktemp)"
  trap 'rm -f "$health_file" "$snapshot_file"' RETURN

  curl -fsS http://127.0.0.1:8080/health > "$health_file"
  curl -fsS -H "Authorization: Bearer $token" http://127.0.0.1:8080/dashboard/snapshot > "$snapshot_file"

  node - "$health_file" "$snapshot_file" <<'NODE'
const fs = require("node:fs");
const health = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const snapshot = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const execution = snapshot.execution ?? {};
const reconciliation = execution.reconciliation ?? {};
const userStreams = execution.userStreams ?? {};
const riskState = execution.riskState ?? "unknown";
const quarantinedExposure = Number(reconciliation.quarantinedExposureDollars ?? 0);
const quarantinedSignalCount = Number(reconciliation.quarantinedSignalCount ?? 0);

const checks = [
  ["health.ok", health.ok === true],
  ["health.arbEnabled=false", health.arbEnabled === false],
  ["execution.partialFillLocked=false", execution.partialFillLocked === false],
  ["execution.circuitBreakerLocked=false", execution.circuitBreakerLocked === false],
  ["execution.reconciliation.clean=true", reconciliation.clean === true],
  ["execution.reconciliation.quarantinedExposureDollars=0", quarantinedExposure === 0],
  ["execution.reconciliation.quarantinedSignalCount=0", quarantinedSignalCount === 0],
  ["execution.riskState not blocked", !["blocked", "hard_locked", "auto_hardlocks_disabled", "quarantined"].includes(riskState)],
];

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({
  arbEnabled: health.arbEnabled,
  liveOrderPlacementMode: health.liveOrderPlacementMode,
  liveOrderSize: health.liveOrderSize,
  riskState,
  riskStateReason: execution.riskStateReason ?? null,
  partialFillLocked: execution.partialFillLocked,
  circuitBreakerLocked: execution.circuitBreakerLocked,
  circuitBreakerReason: execution.circuitBreakerReason ?? null,
  userStreamsReady: userStreams.ready ?? null,
  reconciliationClean: reconciliation.clean,
  reconciliationReason: reconciliation.reason ?? null,
  quarantinedExposureDollars: reconciliation.quarantinedExposureDollars ?? null,
  quarantinedSignalCount: reconciliation.quarantinedSignalCount ?? null,
  failedChecks: failed.map(([name]) => name),
}, null, 2));

if (failed.length > 0) {
  console.error(`UI capture guard failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exit(30);
}
NODE
}

database_guard() {
  local database_url
  database_url="$(read_env_value DATABASE_URL || true)"
  if [ -z "$database_url" ]; then
    echo "DATABASE_URL is empty; skipping database guard." >&2
    return 0
  fi

  cd "$APP_DIR"
  run_app env DATABASE_URL="$database_url" node <<'NODE'
const { Client } = require("pg");

const terminalStatuses = new Set([
  "filled",
  "matched",
  "canceled",
  "cancelled",
  "rejected",
  "failed",
  "expired",
  "unfilled",
]);

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const activeLocks = await client.query("SELECT COUNT(*)::INT AS count FROM live_execution_locks WHERE cleared_at IS NULL");
    const quarantined = await client.query(`
      SELECT COUNT(*)::INT AS count, COALESCE(SUM(risk_quarantine_exposure_dollars), 0)::FLOAT AS exposure
      FROM cross_venue_arb_signals
      WHERE reconciliation_resolved_at IS NULL
        AND risk_quarantined_at IS NOT NULL
    `);
    const latestEvents = await client.query(`
      WITH latest AS (
        SELECT DISTINCT ON (COALESCE(venue_order_id, client_order_id))
               COALESCE(venue_order_id, client_order_id) AS order_key,
               venue, status, remaining_count, received_at
        FROM venue_order_events
        WHERE received_at >= NOW() - INTERVAL '2 hours'
          AND COALESCE(venue_order_id, client_order_id) IS NOT NULL
        ORDER BY COALESCE(venue_order_id, client_order_id), received_at DESC
      )
      SELECT order_key, venue, status, remaining_count, received_at
      FROM latest
    `);

    const openCandidates = latestEvents.rows.filter((row) => {
      const status = String(row.status ?? "").toLowerCase();
      const remaining = Number(row.remaining_count ?? 0);
      return remaining > 0 || (status && !terminalStatuses.has(status));
    });

    const summary = {
      activeLocks: activeLocks.rows[0]?.count ?? 0,
      unresolvedQuarantineCount: quarantined.rows[0]?.count ?? 0,
      unresolvedQuarantineExposureDollars: quarantined.rows[0]?.exposure ?? 0,
      recentOpenOrderCandidates: openCandidates.length,
      recentOpenOrderCandidateStatuses: openCandidates.slice(0, 10).map((row) => ({
        venue: row.venue,
        status: row.status,
        remainingCount: row.remaining_count,
        receivedAt: row.received_at,
      })),
    };
    console.log(JSON.stringify(summary, null, 2));

    const failures = [];
    if (summary.activeLocks > 0) failures.push("active live_execution_locks");
    if (summary.unresolvedQuarantineCount > 0 || summary.unresolvedQuarantineExposureDollars > 0) failures.push("unresolved quarantined exposure");
    if (summary.recentOpenOrderCandidates > 0) failures.push("recent worker-managed open order candidates");
    if (failures.length > 0) {
      throw new Error(`database guard failed: ${failures.join(", ")}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(31);
});
NODE
}

echo "Hostinger UI Quick Order capture pause target:"
echo "service=$(systemctl is-active pok-worker || true)"
echo "branch=$(run_app git -C "$APP_DIR" branch --show-current)"
echo "commit=$(run_app git -C "$APP_DIR" rev-parse --short HEAD)"

DASHBOARD_API_TOKEN="$(read_env_value DASHBOARD_API_TOKEN)"
if [ -z "$DASHBOARD_API_TOKEN" ]; then
  echo "DASHBOARD_API_TOKEN is empty in $ENV_FILE" >&2
  exit 11
fi

BACKUP_FILE="${ENV_FILE}.ui-capture-backup.$(date -u +%Y%m%dT%H%M%SZ)"
"${SUDO[@]}" cp "$ENV_FILE" "$BACKUP_FILE"
"${SUDO[@]}" chmod 600 "$BACKUP_FILE"
echo "Backed up env to $BACKUP_FILE"

echo "Setting ARB_ENABLED=false and restarting pok-worker."
set_env_value ARB_ENABLED false
"${SUDO[@]}" systemctl restart pok-worker
wait_for_health

echo "Public health:"
curl -fsS http://127.0.0.1:8080/health
echo

echo "Protected snapshot guard:"
snapshot_guard "$DASHBOARD_API_TOKEN"

echo "Database guard:"
database_guard

echo "Worker entries are paused and capture guard is green."
echo "Do not resume automated entries until after HAR export, sanitization, and reconciliation are complete."
REMOTE
