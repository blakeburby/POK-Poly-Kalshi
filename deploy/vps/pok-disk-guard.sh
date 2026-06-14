#!/usr/bin/env bash
set -euo pipefail

ROOT_PATH="${POK_DISK_GUARD_ROOT:-/}"
WARN_PERCENT="${POK_DISK_WARN_PERCENT:-80}"
URGENT_PERCENT="${POK_DISK_URGENT_PERCENT:-90}"
CRITICAL_PERCENT="${POK_DISK_CRITICAL_PERCENT:-95}"
POK_TMP_MAX_AGE_DAYS="${POK_TMP_MAX_AGE_DAYS:-2}"
POK_AUDIT_MAX_AGE_DAYS="${POK_AUDIT_MAX_AGE_DAYS:-7}"
POK_TMP_MAX_AGE_MINUTES="$(( POK_TMP_MAX_AGE_DAYS * 1440 ))"
POK_AUDIT_MAX_AGE_MINUTES="$(( POK_AUDIT_MAX_AGE_DAYS * 1440 ))"
POK_TMP_LOG_MAX_MB="${POK_TMP_LOG_MAX_MB:-100}"
SYSLOG_ROTATE_MB="${POK_SYSLOG_ROTATE_MB:-128}"
SYSLOG_EMERGENCY_TRUNCATE_MB="${POK_SYSLOG_EMERGENCY_TRUNCATE_MB:-512}"

usage_percent() {
  df -P "$ROOT_PATH" | awk 'NR == 2 { gsub("%", "", $5); print $5 }'
}

file_size_mb() {
  local path="$1"
  if [ ! -e "$path" ]; then
    echo 0
    return
  fi
  local bytes
  bytes="$(stat -c '%s' "$path" 2>/dev/null || echo 0)"
  echo $(( (bytes + 1048575) / 1048576 ))
}

log_usage() {
  local prefix="$1"
  local usage
  usage="$(usage_percent)"
  echo "pok-disk-guard ${prefix}: root_usage=${usage}% warn=${WARN_PERCENT}% urgent=${URGENT_PERCENT}% critical=${CRITICAL_PERCENT}%"
}

log_usage "start"

find /tmp -xdev -type f \( \
  -name 'pok-*.json' -o \
  -name 'pok_*.json' -o \
  -name 'pok-*.log' -o \
  -name 'pok_*.log' \
\) -mmin +"$POK_TMP_MAX_AGE_MINUTES" -print -delete 2>/dev/null || true

find /tmp -xdev -type d -name 'pok_audit_*' -mmin +"$POK_AUDIT_MAX_AGE_MINUTES" -prune -print -exec rm -rf {} + 2>/dev/null || true

if [ -f /tmp/pok-filltest-monitor.log ]; then
  filltest_mb="$(file_size_mb /tmp/pok-filltest-monitor.log)"
  if [ "$filltest_mb" -ge "$POK_TMP_LOG_MAX_MB" ]; then
    echo "pok-disk-guard removing runaway /tmp/pok-filltest-monitor.log size_mb=${filltest_mb}"
    rm -f /tmp/pok-filltest-monitor.log
  fi
fi

syslog_mb="$(file_size_mb /var/log/syslog)"
if [ "$syslog_mb" -ge "$SYSLOG_ROTATE_MB" ] && command -v logrotate >/dev/null 2>&1 && [ -f /etc/logrotate.d/rsyslog ]; then
  echo "pok-disk-guard rotating /var/log/syslog size_mb=${syslog_mb}"
  logrotate -f /etc/logrotate.d/rsyslog || true
fi

usage="$(usage_percent)"
if [ "$usage" -ge "$WARN_PERCENT" ]; then
  echo "POK_DISK_ALERT root usage ${usage}% >= ${WARN_PERCENT}%"
fi
if [ "$usage" -ge "$URGENT_PERCENT" ]; then
  echo "POK_DISK_URGENT root usage ${usage}% >= ${URGENT_PERCENT}%"
fi
if [ "$usage" -ge "$CRITICAL_PERCENT" ]; then
  syslog_mb="$(file_size_mb /var/log/syslog)"
  if [ "$syslog_mb" -ge "$SYSLOG_EMERGENCY_TRUNCATE_MB" ]; then
    echo "pok-disk-guard emergency truncating /var/log/syslog size_mb=${syslog_mb}"
    truncate -s 0 /var/log/syslog || true
  fi
  journalctl --vacuum-size=128M >/dev/null 2>&1 || true
fi

log_usage "finish"

usage="$(usage_percent)"
if [ "$usage" -ge "$CRITICAL_PERCENT" ]; then
  echo "POK_DISK_CRITICAL root usage still ${usage}% after cleanup"
  exit 2
fi
