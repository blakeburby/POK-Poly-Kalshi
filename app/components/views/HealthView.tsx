"use client";

import * as React from "react";
import type { DashboardSnapshot, VenueExecutionReadiness, DashboardLogEntry } from "@/lib/types";
import { ViewScroll, Grid, GridPanel } from "./_layout";
import { Empty, StatusDot } from "@/components/ui/stat";
import { healthChecks } from "@/lib/selectors";
import { fmtUsd, fmtMs, fmtRelative, fmtClock, type StatusTone } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { cn } from "@/lib/utils";

export function HealthView({ snap }: { snap: DashboardSnapshot }) {
  const now = useNow(1000);
  const checks = healthChecks(snap, now);
  const e = snap.execution;
  const lat = snap.latency;

  return (
    <ViewScroll>
      <Grid>
        <GridPanel
          title="System Health · Live Strategy Checks"
          dot="live"
          span={5}
          bodyClassName="grid grid-cols-1 gap-1.5 sm:grid-cols-2"
          pulse
        >
          {checks.map((c) => (
            <div
              key={c.key}
              className="flex items-center gap-2 rounded-sm border border-line/60 bg-surface-2/30 px-2.5 py-2"
            >
              <StatusDot tone={c.tone} pulse={c.tone === "live"} className="size-1.5" />
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[11px] text-fg-secondary">{c.label}</span>
                <span className="truncate font-mono text-[9px] uppercase tracking-wide text-fg-muted">{c.detail}</span>
              </div>
            </div>
          ))}
        </GridPanel>

        <GridPanel title="Venue Readiness" dot="info" span={4} bodyClassName="flex flex-col gap-3">
          {e ? (
            <>
              <VenueReady label="Kalshi" v={e.kalshi} accent="kalshi" />
              <VenueReady label="Polymarket" v={e.polymarket} accent="poly" />
            </>
          ) : (
            <Empty />
          )}
        </GridPanel>

        <GridPanel
          title="User Streams"
          dot={e?.userStreams.ready ? "live" : "stale"}
          span={3}
          bodyClassName="flex flex-col gap-2.5"
        >
          {e ? (
            <>
              <StreamRow
                label="Kalshi WS"
                connected={e.userStreams.kalshi.connected}
                subscribed={e.userStreams.kalshi.subscribed}
                lastEventAt={e.userStreams.kalshi.lastEventAt}
                now={now}
              />
              <StreamRow
                label="Polymarket WS"
                connected={e.userStreams.polymarket.connected}
                subscribed={e.userStreams.polymarket.subscribed}
                lastEventAt={e.userStreams.polymarket.lastEventAt}
                now={now}
              />
              <div className="mt-1 flex items-center justify-between border-t border-line/60 pt-2.5">
                <span className="font-mono text-[10px] uppercase tracking-wide text-fg-muted">Confirm Lag</span>
                <span className="font-mono text-[12px] tabular-nums text-fg">
                  {fmtMs(e.userStreams.confirmationLagMs)}
                </span>
              </div>
            </>
          ) : (
            <Empty />
          )}
        </GridPanel>
      </Grid>

      <Grid>
        <GridPanel
          title="Scanner & Pipeline Heartbeat"
          dot={snap.scanner.scanning ? "live" : "stale"}
          span={6}
          bodyClassName="grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          <HStat
            label="Scanning"
            value={snap.scanner.scanning ? "ACTIVE" : "IDLE"}
            tone={snap.scanner.scanning ? "live" : "stale"}
          />
          <HStat label="Last Scan" value={fmtMs(snap.scanner.lastScanAgeMs ?? null)} tone="neutral" />
          <HStat label="Candidates" value={String(snap.scanner.lastCandidateCount)} tone="neutral" />
          <HStat label="Queued Exec" value={String(snap.scanner.queuedExecutions ?? 0)} tone="neutral" />
          <HStat label="Active Exec" value={String(snap.scanner.activeExecutions ?? 0)} tone="neutral" />
          <HStat label="Scan Heartbeat" value={fmtMs(snap.health.scanHeartbeatMs)} tone="neutral" />
          <HStat label="Scan Dur p50" value={fmtMs(lat?.scanner.scanDurationMs.p50Ms ?? null)} tone="neutral" />
          <HStat label="Decision p95" value={fmtMs(lat?.scanner.bookUpdateToDecisionMs.p95Ms ?? null)} tone="neutral" />
          <HStat label="Exec Dur p50" value={fmtMs(lat?.execution.durationMs.p50Ms ?? null)} tone="neutral" />
        </GridPanel>

        <GridPanel
          title="Pipeline Latency & Feed"
          dot="info"
          span={6}
          bodyClassName="grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          <HStat label="Snapshot Build" value={fmtMs(lat?.dashboard.snapshotBuildMs.latestMs ?? null)} tone="neutral" />
          <HStat label="Snapshot Age" value={fmtMs(lat?.dashboard.snapshotAgeMs ?? null)} tone="neutral" />
          <HStat label="Stream Interval" value={fmtMs(lat?.dashboard.streamIntervalMs ?? null)} tone="neutral" />
          <HStat label="DB Insert" value={fmtMs(lat?.persistence.insertMs.p50Ms ?? null)} tone="neutral" />
          <HStat label="DB Update" value={fmtMs(lat?.persistence.updateMs.p50Ms ?? null)} tone="neutral" />
          <HStat label="Hot Gate" value={fmtMs(lat?.execution.hotGateMs.p50Ms ?? null)} tone="neutral" />
          <HStat
            label="Chainlink Tick"
            value={fmtRelative(snap.diagnostics?.polymarket?.lastChainlinkTickAt ?? null, now)}
            tone="neutral"
          />
          <HStat
            label="Analytics Mode"
            value={snap.analytics?.realtime?.mode === "hot_cache" ? "HOT" : "DB"}
            tone={snap.analytics?.realtime?.stale ? "stale" : "live"}
          />
          <HStat
            label="Discovery Err"
            value={snap.discovery.lastDiscoveryError ? "ERROR" : "OK"}
            tone={snap.discovery.lastDiscoveryError ? "halt" : "live"}
          />
        </GridPanel>
      </Grid>

      <GridPanel title="Event Tape" dot="live" span={12} bodyClassName="p-0">
        <LogTape logs={snap.logs ?? []} now={now} />
      </GridPanel>
    </ViewScroll>
  );
}

function VenueReady({ label, v, accent }: { label: string; v: VenueExecutionReadiness; accent: "kalshi" | "poly" }) {
  return (
    <div className="rounded-md border border-line bg-surface-2/40 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", accent === "kalshi" ? "bg-kalshi" : "bg-poly")} />
          <span className="text-[12px] font-medium text-fg">{label}</span>
        </div>
        <span className="flex items-center gap-1.5">
          <StatusDot tone={v.ready ? "live" : "halt"} className="size-1.5" />
          <span className={cn("font-mono text-[10px] uppercase", v.ready ? "text-up" : "text-down")}>
            {v.ready ? "READY" : "NOT READY"}
          </span>
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10.5px]">
        <KV k="Balance" v={fmtUsd(v.balance)} />
        <KV k="Allowance" v={v.allowance != null ? fmtUsd(v.allowance) : "n/a"} />
        <KV k="Configured" v={v.configured ? "yes" : "no"} />
        <KV k="Geoblock" v={v.geoblockBlocked ? "BLOCKED" : "clear"} tone={v.geoblockBlocked ? "down" : undefined} />
      </div>
      {v.reason ? <div className="mt-1.5 font-mono text-[9.5px] text-amber">{v.reason}</div> : null}
    </div>
  );
}

function StreamRow({
  label,
  connected,
  subscribed,
  lastEventAt,
  now,
}: {
  label: string;
  connected: boolean;
  subscribed: boolean;
  lastEventAt: number | null;
  now: number;
}) {
  const tone: StatusTone = connected && subscribed ? "live" : connected ? "stale" : "halt";
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <StatusDot tone={tone} pulse={tone === "live"} className="size-1.5" />
        <span className="text-[11px] text-fg-secondary">{label}</span>
      </div>
      <span className="font-mono text-[10px] tabular-nums text-fg-muted">
        {lastEventAt ? fmtRelative(lastEventAt, now) : "—"}
      </span>
    </div>
  );
}

function HStat({ label, value, tone }: { label: string; value: string; tone: StatusTone | "neutral" }) {
  const text =
    tone === "live" ? "text-up" : tone === "halt" ? "text-down" : tone === "stale" ? "text-amber" : "text-fg";
  return (
    <div className="rounded-sm border border-line/60 bg-surface-2/30 px-2.5 py-2">
      <div className="font-mono text-[9px] uppercase tracking-wide text-fg-muted">{label}</div>
      <div className={cn("font-mono text-[13px] tabular-nums", text)}>{value}</div>
    </div>
  );
}

function KV({ k, v, tone }: { k: string; v: React.ReactNode; tone?: "down" }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg-muted">{k}</span>
      <span className={cn("tabular-nums", tone === "down" ? "text-down" : "text-fg-secondary")}>{v}</span>
    </div>
  );
}

const sevTone: Record<DashboardLogEntry["severity"], StatusTone> = {
  ERROR: "halt",
  WARN: "stale",
  INFO: "info",
  DEBUG: "idle",
};

function LogTape({ logs, now }: { logs: DashboardLogEntry[]; now: number }) {
  if (!logs.length) return <Empty>No events</Empty>;
  return (
    <div className="max-h-[280px] overflow-auto font-mono text-[11px]">
      {logs.map((l, i) => {
        const t = new Date(l.timestamp).getTime();
        return (
          <div
            key={i}
            className="flex min-w-0 items-center gap-3 border-b border-line/30 px-3 py-1 hover:bg-surface-2/40 sm:min-w-[560px]"
          >
            <StatusDot tone={sevTone[l.severity]} className="size-1" />
            <span className="w-20 shrink-0 tabular-nums text-fg-faint">{fmtClock(t, true).slice(0, 12)}</span>
            <span
              className={cn(
                "w-12 shrink-0 uppercase",
                l.severity === "ERROR" ? "text-down" : l.severity === "WARN" ? "text-amber" : "text-fg-muted",
              )}
            >
              {l.severity}
            </span>
            <span className="w-24 shrink-0 truncate text-cyan/70">{l.category}</span>
            <span className="flex-1 truncate text-fg-secondary">{l.message}</span>
            <span className="shrink-0 text-fg-faint">{fmtRelative(t, now)}</span>
          </div>
        );
      })}
    </div>
  );
}
