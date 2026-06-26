"use client";

import * as React from "react";
import { useDashboardStore, type FeedSource } from "@/store/dashboard-store";
import { operationalStatus } from "@/lib/selectors";
import { fmtClock, fmtRelative, type StatusTone } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { StatusDot } from "@/components/ui/stat";
import { MobileHealthSheet } from "@/components/shell/MobileHealthSheet";
import { PriceTicker } from "@/components/shell/PriceTicker";
import { cn } from "@/lib/utils";

const sourceMeta: Record<FeedSource, { tone: StatusTone; label: string }> = {
  live: { tone: "live", label: "LIVE" },
  connecting: { tone: "idle", label: "CONNECTING" },
  degraded: { tone: "stale", label: "DEGRADED" },
  mock: { tone: "info", label: "DEMO FEED" },
};

export function TopBar() {
  const snap = useDashboardStore((s) => s.snapshot);
  const source = useDashboardStore((s) => s.source);
  const now = useNow(1000);
  const op = snap ? operationalStatus(snap) : null;
  const snapshotAge = snap ? now - snap.generatedAt : null;
  // A "live" stream that has gone silent still reports source==="live" (the browser EventSource fires no
  // onerror on a stall), so the snapshot ages while the badge keeps claiming LIVE. Treat a live feed older
  // than a freshness budget (a few stream intervals, floored at 8s) as STALE so stale data is never shown as
  // fresh. (Doesn't touch the feed state machine — purely how the badge reads the snapshot's own timestamp.)
  const staleMs = Math.max(8000, (snap?.latency?.dashboard?.streamIntervalMs ?? 1000) * 6);
  const feedStale = source === "live" && snapshotAge != null && snapshotAge > staleMs;
  const meta = feedStale ? { tone: "stale" as StatusTone, label: "STALE" } : sourceMeta[source];
  const candidates = snap?.scanner.lastCandidateCount ?? 0;

  return (
    <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:gap-4 sm:px-3.5">
      <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
        <div className="grid size-7 shrink-0 place-items-center rounded-sm bg-gradient-to-br from-cyan/30 to-violet/20 ring-1 ring-cyan/30">
          <span className="font-mono text-[12px] font-bold tracking-tighter text-fg">P</span>
        </div>
        <div className="flex min-w-0 flex-col leading-none">
          <span className="truncate text-[12px] font-semibold tracking-tight text-fg sm:text-[13px]">
            POK CAPITAL<span className="hidden text-fg-muted sm:inline"> · TERMINAL</span>
          </span>
          <span className="hidden truncate font-mono text-[9px] uppercase tracking-[0.18em] text-fg-faint sm:block">
            BTC 15m · Kalshi ⇄ Polymarket Arbitrage
          </span>
        </div>
      </div>

      <div className="ml-1 hidden items-center gap-2 rounded-sm border border-line bg-surface-2/60 px-2 py-1 md:flex">
        <StatusDot tone={meta.tone} pulse={meta.tone === "live"} />
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-fg-secondary">{meta.label}</span>
        {snapshotAge != null ? (
          <span className={cn("font-mono text-[10px]", feedStale ? "text-amber" : "text-fg-muted")}>
            · {Math.max(0, Math.round(snapshotAge / 1000))}s
          </span>
        ) : null}
      </div>

      <Triplet label="SCAN" value={snap ? `${candidates} live` : "–"} tone={candidates > 0 ? "live" : "idle"} />
      <Triplet
        label="K-FEED"
        value={snap?.execution?.userStreams.kalshi.connected ? "up" : "down"}
        tone={snap?.execution?.userStreams.kalshi.connected ? "live" : "halt"}
      />
      <Triplet
        label="P-FEED"
        value={snap?.execution?.userStreams.polymarket.connected ? "up" : "down"}
        tone={snap?.execution?.userStreams.polymarket.connected ? "live" : "halt"}
      />

      <PriceTicker />

      <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-4">
        {op ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-sm border px-2 py-1 sm:px-2.5",
              op.tone === "live"
                ? "border-up/30 bg-up/10"
                : op.tone === "halt"
                  ? "border-down/40 bg-down/10 risk-pulse"
                  : "border-amber/30 bg-amber/10",
            )}
          >
            <StatusDot tone={op.tone} pulse={op.tone === "live"} />
            <span
              className={cn(
                "truncate font-mono text-[11px] font-medium uppercase tracking-[0.08em]",
                op.tone === "live" ? "text-up" : op.tone === "halt" ? "text-down" : "text-amber",
              )}
            >
              {op.label}
            </span>
          </div>
        ) : null}
        <div className="hidden flex-col items-end leading-none md:flex">
          <span className="font-mono text-[13px] tabular-nums text-fg">{fmtClock(now)}</span>
          <span className="font-mono text-[9px] uppercase tracking-wide text-fg-muted">
            {snap ? `upd ${fmtRelative(snap.generatedAt, now)}` : "—"}
          </span>
        </div>
        <MobileHealthSheet />
      </div>
    </header>
  );
}

function Triplet({ label, value, tone }: { label: string; value: string; tone: StatusTone }) {
  return (
    <div className="hidden items-center gap-1.5 lg:flex">
      <StatusDot tone={tone} />
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-fg-muted">{label}</span>
      <span className="font-mono text-[10px] tabular-nums text-fg-secondary">{value}</span>
    </div>
  );
}
