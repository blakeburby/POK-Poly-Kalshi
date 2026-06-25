# Runbook: Upgrade the Montreal Lightsail worker to a larger CPU plan

> **✅ EXECUTED 2026-06-25.** Cut over `t3.small` (2 vCPU burstable, 26.8% chronic steal, event-loop P99
> 1.0–1.6 s) → a **4-vCPU compute-optimized (non-burstable)** instance. Result verified: steal ~0%, P99 ~22 ms,
> zero "runtime health degraded" WARNs, trading resumed, DB intact. The **compute-optimized family is the
> durable fix** — being non-burstable, it has no burst credits to exhaust, so steal can't recur (a bigger
> *burstable* plan would only delay it). The static IP `StaticIp-1` (15.175.128.184) was reattached, so SSH /
> deploy / tunnel addressing is unchanged. The pre-upgrade snapshot + the old box (Stopped) are the rollback.
> This runbook is retained for reference / future re-sizing.

## Why

The worker halted trading for ~8h because the Lightsail instance **exhausted its burstable CPU credits** and AWS throttled it (~80% CPU steal), starving the Node event loop → stale market-data feeds → every candidate skipped. Code fixes `bf63fb2` (Kalshi book hygiene + cut CPU appetite + a runtime-health watchdog) reduce the worker's steady CPU demand, but the durable fix is to run it on a plan whose **sustained CPU comfortably exceeds the worker's ~1-core steady demand**.

## Key facts about the current box

- Instance: AWS Lightsail, region Montreal (ca-central-1), SSH `ubuntu@15.175.128.184`.
- App: `/opt/pok-poly-kalshi` (systemd service `pok-worker`); env+secrets: `/etc/pok-poly-kalshi/worker.env`.
- Dashboard reaches the worker over a **Cloudflare tunnel** (`api.pokstrategies.com`) run by `cloudflared` ON the box.
- Database is a **local Postgres ON the box** (`DATABASE_URL=localhost`, ~1.7 GB) — so it travels INSIDE the
  snapshot; there is no separate DB migration. (Older notes saying "remote Railway" are stale.)
- Lightsail **cannot resize an instance in place** — you snapshot it and launch a new, larger instance from the snapshot.

## ⚠️ Safety: never run two workers at once

Both boxes use the **same Kalshi/Polymarket accounts** (each box has its OWN local Postgres, so their DBs would also diverge). If both run with `ARB_ENABLED=true`, they will **double-trade** the shared accounts. The sequence below pauses the old worker before the new one trades, so only one is ever live.

## Recommended plan size

The worker wants ~1 full core continuously. Pick a plan whose baseline CPU is comfortably above that:

- Minimum: **2 vCPU / 4–8 GB** (e.g. the $40/mo Linux plan) — watch the burst-capacity graph after cutover.
- Safer for 24/7: **4 vCPU / 16 GB** (≈1 core = ~25% util, well inside the sustainable zone, won't re-throttle).
  Start at 2 vCPU; if the Lightsail "CPU burst capacity" graph still trends toward zero over a day, move to 4 vCPU.

---

## Steps

### 1. Pause the OLD worker (prevents double-trading during cutover)

```bash
HOSTINGER_SSH_TARGET=ubuntu@15.175.128.184
ssh $HOSTINGER_SSH_TARGET 'sed -i "s/^ARB_ENABLED=.*/ARB_ENABLED=false/" /etc/pok-poly-kalshi/worker.env && systemctl restart pok-worker'
# confirm arbEnabled:false
ssh $HOSTINGER_SSH_TARGET 'curl -fsS http://127.0.0.1:8080/health | head -c 200'
```

(The snapshot will then capture `ARB_ENABLED=false`, so the new box boots paused — we enable it only after verifying.)

### 2. Create a snapshot (AWS Lightsail console)

- Lightsail console → **Instances** → your instance → **Snapshots** tab → **Create snapshot**. Name it e.g. `pok-pre-cpu-upgrade-<date>`.
- Wait until status = **Available** (a few minutes).

### 3. Launch a new, larger instance from the snapshot

- Lightsail console → **Snapshots** → the snapshot → **Create new instance**.
- Region/AZ: **same as current (Montreal / ca-central-1)**.
- Choose the **larger plan** (2 or 4 vCPU per above).
- Name it e.g. `pok-worker-2vcpu`. Create. Wait until **Running**.

### 4. Move the static IP (keeps SSH/tunnel addressing stable)

- If the current box uses a Lightsail **static IP** (15.175.128.184): Lightsail → **Networking** → that static IP → **Detach** from old, then **Attach** to the new instance. SSH target stays `ubuntu@15.175.128.184`.
- If there is no static IP, note the new instance's public IP and use it as `HOSTINGER_SSH_TARGET` below. (The Cloudflare tunnel reconnects regardless — it's outbound from `cloudflared`.)

### 5. Verify the new box came up clean

```bash
# (use the new IP if you didn't move a static IP)
ssh ubuntu@15.175.128.184 'systemctl is-active pok-worker cloudflared; cat /proc/loadavg'
# CPU steal should now be ~0 (not ~80):
ssh ubuntu@15.175.128.184 'vmstat 1 3'
# health should respond fast (<1s, not 8s); arbEnabled should be false (paused):
ssh ubuntu@15.175.128.184 'time curl -fsS "http://127.0.0.1:8080/health" -o /dev/null -w "%{http_code} %{time_total}s\n"; curl -fsS http://127.0.0.1:8080/health | grep -o "arbEnabled[^,]*"'
# tunnel: dashboard API reachable externally
curl -sS -m 8 -o /dev/null -w "api.pokstrategies.com/health: %{http_code}\n" https://api.pokstrategies.com/health
```

Confirm: `vmstat st` ≈ 0, `/health` fast, `cloudflared` active, tunnel returns 200.

### 6. Deploy the latest code (ships fixes #1 + #2 `bf63fb2`) on the new box

The snapshot has the old code; deploy current `main`/deploy-branch (now fast on the un-throttled box):

```bash
cd <local repo>
HOSTINGER_SSH_TARGET=ubuntu@15.175.128.184 npm run hostinger:precheck   # read-only
HOSTINGER_SSH_TARGET=ubuntu@15.175.128.184 npm run hostinger:deploy     # pause→build→restart→readiness; leaves ARB paused on failure
```

(The guarded deploy keeps `ARB_ENABLED=false` until readiness is green, then restores it — see step 7.)

### 7. Re-enable trading on the new box + verify it's live

The deploy restores `ARB_ENABLED=true` when readiness is green. Confirm:

```bash
ssh ubuntu@15.175.128.184 'curl -fsS http://127.0.0.1:8080/health | grep -oE "arbEnabled[^,]*|lastScanAgeMs[^,]*"'
# new: runtimeHealth should show low event-loop lag + low CPU steal:
ssh ubuntu@15.175.128.184 'curl -fsS http://127.0.0.1:8080/health | python3 -c "import sys,json;print(json.load(sys.stdin).get(\"runtimeHealth\"))"'
# verify protected readiness green + feeds fresh:
HOSTINGER_SSH_TARGET=ubuntu@15.175.128.184 npm run hostinger:precheck
# confirm the staleness/skew skips have collapsed (feeds keeping up now):
ssh ubuntu@15.175.128.184 'journalctl -u pok-worker --since "5 min ago" -o cat | grep -oE "\"failureReason\":\"[^\"]{0,40}" | sort | uniq -c | sort -rn | head'
```

Success = `arbEnabled:true`, breaker clear, `lastScanAgeMs` consistently <750ms, `runtimeHealth.cpuStealPercent` near 0, `eventLoopLagP99Ms` low, and skips are only legitimate negative-edge/expiry (not staleness/skew floods).

### 8. Decommission the old box

Once the new box is confirmed live and trading:

- Lightsail console → old instance → **Stop** (keep it a day in case of rollback), then **Delete** when satisfied.
- Keep the pre-upgrade snapshot for a while as a rollback point.

### Rollback (if the new box misbehaves)

Re-attach the static IP to the old instance, `ssh ... 'sed -i "s/^ARB_ENABLED=.*/ARB_ENABLED=true/" /etc/pok-poly-kalshi/worker.env && systemctl restart pok-worker'`, and investigate. (Old box still throttled, but functional once credits recover.)

## After upgrade — confirm the fixes worked

- `runtimeHealth` on `/health` should report `cpuStealPercent` ~0 and low `eventLoopLagP99Ms`. If steal climbs again over a day, the plan is still too small → go up one tier.
- Kalshi book level count per contract should be ≤~99 (the dust/level-explosion fix); dashboard snapshot JSON should be far smaller than the old ~630 KB.
- A trade should attempt whenever a genuinely post-cost-profitable candidate appears (api-key path already verified in `04d7fd1`/`93e6881`).
