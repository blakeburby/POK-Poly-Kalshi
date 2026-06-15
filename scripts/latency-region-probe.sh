#!/usr/bin/env bash
# Latency region probe (Phase B #7) — pick the relocation target with real numbers.
#
# The worker is in Kuala Lumpur (~147ms to Kalshi, ~190ms to the Polymarket origin). Co-locating near the
# US-East exchange origins is the #1 latency lever, BUT Polymarket geoblocks US IPs (fail-closed in the
# readiness gate) while Kalshi is US-regulated. So the target must be a low-RTT-to-us-east-1 region that is
# NOT Polymarket-geoblocked. This script measures, FROM whatever host it runs on, the network RTT + TLS + TTFB
# to both exchanges and the Kalshi FIX endpoint, and checks the Polymarket geoblock for this host's IP.
#
# Run it ON each candidate worker host and on the current KL VPS as the baseline:
#   bash scripts/latency-region-probe.sh
# Suggested candidates: Canada (Toronto/Montreal), London, Frankfurt, Tokyo/Singapore, and us-east-1 as the
# CONTROL that should report geoblock blocked:true (proving the probe detects the block).
#
# DECISION RULE: choose the region with the lowest (Kalshi connect RTT + Polymarket connect/origin RTT) whose
# Polymarket geoblock returns blocked:false AND whose Kalshi FIX TCP connect succeeds. Re-run immediately
# before cutover.
set -uo pipefail

SAMPLES="${SAMPLES:-7}"
KALSHI_API="${KALSHI_API:-https://api.elections.kalshi.com}"
KALSHI_FIX_HOST="${KALSHI_FIX_HOST:-mm.fix.elections.kalshi.com}"
KALSHI_FIX_PORT="${KALSHI_FIX_PORT:-8228}"
POLY_CLOB="${POLY_CLOB:-https://clob.polymarket.com}"
POLY_GAMMA="${POLY_GAMMA:-https://gamma-api.polymarket.com}"
POLY_GEOBLOCK="${POLY_GEOBLOCK:-https://polymarket.com/api/geoblock}"

ms() { awk "BEGIN{printf \"%.0f\", $1*1000}"; }

echo "=== latency-region-probe @ $(date -u +%FT%TZ) (samples=$SAMPLES) ==="
echo -n "host=$(hostname)  geo="
curl -s --max-time 8 https://ipinfo.io/json 2>/dev/null \
  | tr -d '{}"' | tr ',' '\n' | awk -F: '/city|region|country|org/{print $2}' | paste -sd' ' - 2>/dev/null \
  || echo "(ipinfo unavailable)"
echo

# Best-of-N connect / TLS / TTFB for an HTTPS endpoint (best = lowest = least noisy RTT estimate).
probe_https() {
  local name="$1" url="$2" bc=99 bt=99 bf=99
  for _ in $(seq 1 "$SAMPLES"); do
    local out c t f
    out=$(curl -o /dev/null -s -w '%{time_connect} %{time_appconnect} %{time_starttransfer}' --max-time 12 "$url" 2>/dev/null) || continue
    read -r c t f <<<"$out"
    awk "BEGIN{exit !($c>0 && $c<$bc)}" && bc=$c
    awk "BEGIN{exit !($t>0 && $t<$bt)}" && bt=$t
    awk "BEGIN{exit !($f>0 && $f<$bf)}" && bf=$f
  done
  printf '  %-30s connect(TCP RTT)=%sms  tls=%sms  ttfb=%sms\n' "$name" "$(ms "$bc")" "$(ms "$bt")" "$(ms "$bf")"
  KALSHI_RTT="${KALSHI_RTT:-}"; POLY_RTT="${POLY_RTT:-}"
}

# Best-of-N raw TCP connect to a host:port (for the Kalshi FIX session endpoint, which is not HTTP).
# Uses a bash /dev/tcp connect wrapped in `timeout` so it measures the connect RTT and returns immediately —
# curl telnet:// would block reading after connecting (FIX sends nothing before logon).
probe_tcp() {
  local name="$1" host="$2" port="$3" bc=99 ok=0
  for _ in $(seq 1 "$SAMPLES"); do
    local t0 t1 c
    t0=$(date +%s.%N)
    if timeout 8 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then
      t1=$(date +%s.%N)
      c=$(awk "BEGIN{print $t1-$t0}")
      ok=1; awk "BEGIN{exit !($c<$bc)}" && bc=$c
    fi
  done
  if [ "$ok" = 1 ]; then
    printf '  %-30s connect(TCP RTT)=%sms\n' "$name" "$(ms "$bc")"
  else
    printf '  %-30s UNREACHABLE (FIX port blocked/closed from this host)\n' "$name"
  fi
}

echo "Kalshi:"
probe_https "kalshi API ($KALSHI_API)" "$KALSHI_API"
probe_tcp   "kalshi FIX ($KALSHI_FIX_HOST:$KALSHI_FIX_PORT)" "$KALSHI_FIX_HOST" "$KALSHI_FIX_PORT"
echo "Polymarket:"
probe_https "polymarket CLOB ($POLY_CLOB)" "$POLY_CLOB"
probe_https "polymarket gamma ($POLY_GAMMA)" "$POLY_GAMMA"

echo "Polymarket geoblock (MUST be blocked:false for a usable region):"
geo=$(curl -s --max-time 8 "$POLY_GEOBLOCK" 2>/dev/null)
echo "  $geo"
if echo "$geo" | grep -q '"blocked":false'; then
  echo "  => geoblock OK (region is usable for Polymarket)"
else
  echo "  => GEOBLOCK ACTIVE or unknown — this region would SEVER the Polymarket leg. Do NOT relocate here."
fi
echo "=== done ==="
