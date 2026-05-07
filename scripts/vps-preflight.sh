#!/usr/bin/env bash
set -euo pipefail

GEOBLOCK_URL="${POLYMARKET_GEOBLOCK_URL:-https://polymarket.com/api/geoblock}"

echo "Checking Polymarket geoblock from this runtime..."
GEOBLOCK_JSON="$(curl -fsS "$GEOBLOCK_URL")"
echo "$GEOBLOCK_JSON"

GEOBLOCK_JSON="$GEOBLOCK_JSON" node <<'NODE'
const parsed = JSON.parse(process.env.GEOBLOCK_JSON);
if (parsed.blocked !== false) {
  console.error(`Polymarket geoblock failed: blocked=${parsed.blocked} country=${parsed.country ?? "unknown"} region=${parsed.region ?? "unknown"}`);
  process.exit(20);
}
console.log(`Polymarket geoblock passed: country=${parsed.country ?? "unknown"} region=${parsed.region ?? "unknown"}`);
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
