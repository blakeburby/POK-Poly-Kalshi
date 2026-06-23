#!/usr/bin/env bash
set -euo pipefail

GEOBLOCK_URL="${POLYMARKET_GEOBLOCK_URL:-https://polymarket.com/api/geoblock}"

echo "Checking Polymarket geoblock from this runtime..."
GEOBLOCK_JSON="$(curl -fsS "$GEOBLOCK_URL")"
echo "$GEOBLOCK_JSON"

GEOBLOCK_JSON="$GEOBLOCK_JSON" POLYMARKET_GEOBLOCK_GATE_ENABLED="${POLYMARKET_GEOBLOCK_GATE_ENABLED:-true}" node <<'NODE'
const parsed = JSON.parse(process.env.GEOBLOCK_JSON);
const gateEnabled = !["0", "false", "no", "off"].includes(String(process.env.POLYMARKET_GEOBLOCK_GATE_ENABLED ?? "true").toLowerCase());
const where = `country=${parsed.country ?? "unknown"} region=${parsed.region ?? "unknown"}`;
if (parsed.blocked !== false) {
  if (gateEnabled) {
    console.error(`Polymarket geoblock failed: blocked=${parsed.blocked} ${where}`);
    process.exit(20);
  }
  console.warn(`Polymarket geoblock is blocked (blocked=${parsed.blocked} ${where}) but POLYMARKET_GEOBLOCK_GATE_ENABLED=false; treating as advisory and continuing.`);
} else {
  console.log(`Polymarket geoblock passed: ${where}`);
}
NODE

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "Node 22+ is required; found $(node -v)" >&2
    exit 21
  fi
  echo "Node version OK: $(node -v)"
else
  echo "Node is not installed yet. Install Node 22+ before running the worker." >&2
  exit 22
fi

echo "VPS preflight passed."
