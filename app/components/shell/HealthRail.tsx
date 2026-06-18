"use client";

import * as React from "react";
import { useDashboardStore } from "@/store/dashboard-store";
import { accountEquity, healthChecks, operationalStatus, orderSize } from "@/lib/selectors";
import { fmtUsd, fmtPct, fmtCents } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { StatusDot, Label, MiniBar } from "@/components/ui/stat";
import { cn } from "@/lib/utils";

/** Desktop right rail — hidden on mobile (surfaced via MobileHealthSheet instead). */
export function HealthRail() {
  const snap = useDashboardStore((s) => s.snapshot);
  if (!snap) return <aside className="hidden w-[238px] shrink-0 border-l border-line bg-surface/60 lg:block" />;
  return (
    <aside className="hidden w-[238px] shrink-0 flex-col overflow-y-auto border-l border-line bg-surface/60 lg:flex">
      <HealthRailBody />
    </aside>
  );
}

/** Shared content used by both the desktop rail and the mobile bottom sheet. */
export function HealthRailBody() {
  const snap = useDashboardStore((s) => s.snapshot);
  const now = useNow(2000);
  if (!snap) return null;

  const op = operationalStatus(snap);
  const checks = healthChecks(snap, now);
  const exec = snap.execution;
  const eq = exec?.executionQuality;
  const recon = exec?.reconciliation;
  const size = orderSize(snap);
  // Account value per venue = cash + mark-to-market positions (NOT exec.balance, which is cash only).
  const acct = accountEquity(snap);

  return (
    <>
      {/* operational headline */}
      <div
        className={cn(
          "flex items-center gap-2.5 border-b border-line px-3 py-3",
          op.tone === "live" ? "bg-up/5" : op.tone === "halt" ? "bg-down/10 risk-pulse" : "bg-amber/5",
        )}
      >
        <StatusDot tone={op.tone} pulse={op.tone === "live"} className="size-2.5" />
        <div className="flex flex-col leading-tight">
          <span
            className={cn(
              "font-mono text-[13px] font-semibold uppercase tracking-[0.06em]",
              op.tone === "live" ? "text-up" : op.tone === "halt" ? "text-down" : "text-amber",
            )}
          >
            {op.label}
          </span>
          <span className="font-mono text-[9.5px] uppercase tracking-wide text-fg-muted">
            {op.reason ?? "all systems nominal"}
          </span>
        </div>
      </div>

      {/* health checks */}
      <div className="border-b border-line px-3 py-2.5">
        <Label className="mb-2 block">Live Strategy Health</Label>
        <div className="flex flex-col gap-1.5">
          {checks.map((c) => (
            <div key={c.key} className="flex items-center gap-2">
              <StatusDot tone={c.tone} pulse={c.tone === "live"} className="size-1.5" />
              <span className="flex-1 truncate text-[11px] text-fg-secondary">{c.label}</span>
              <span className="font-mono text-[9.5px] tabular-nums text-fg-muted">{c.detail}</span>
            </div>
          ))}
        </div>
      </div>

      {/* hedge integrity */}
      <div className="border-b border-line px-3 py-2.5">
        <Label className="mb-2 block">Hedge Integrity</Label>
        <RailStat label="Exact-Pair Fill" value={fmtPct(eq?.exactPairFillRate)} bar={eq?.exactPairFillRate ?? 0} tone="up" />
        <RailStat label="Mismatch Rate" value={fmtPct(eq?.mismatchRate)} bar={eq?.mismatchRate ?? 0} tone="down" invert />
        <RailStat label="PM Timeout" value={fmtPct(eq?.polymarketTimeoutRate)} bar={eq?.polymarketTimeoutRate ?? 0} tone="down" invert />
      </div>

      {/* risk exposure */}
      <div className="border-b border-line px-3 py-2.5">
        <Label className="mb-2 block">Risk Exposure</Label>
        <div className="flex items-center justify-between py-0.5">
          <span className="text-[11px] text-fg-secondary">Unhedged $</span>
          <span className={cn("font-mono text-[12px] tabular-nums", (recon?.quarantinedExposureDollars ?? 0) > 0 ? "text-down" : "text-up")}>
            {fmtUsd(recon?.quarantinedExposureDollars ?? 0)}
          </span>
        </div>
        <div className="flex items-center justify-between py-0.5">
          <span className="text-[11px] text-fg-secondary">Quarantined</span>
          <span className="font-mono text-[12px] tabular-nums text-fg">{recon?.quarantinedSignalCount ?? 0}</span>
        </div>
        <div className="flex items-center justify-between py-0.5">
          <span className="text-[11px] text-fg-secondary">Est. Edge</span>
          <span className="font-mono text-[12px] tabular-nums text-up">{fmtCents(eq?.estimatedExecutableEdge)}</span>
        </div>
      </div>

      {/* venue capital */}
      <div className="px-3 py-2.5">
        <Label className="mb-2 block">Venue Capital</Label>
        <VenueLine name="Kalshi" tone="kalshi" balance={acct.kalshi} ready={exec?.kalshi.ready} />
        <VenueLine name="Polymarket" tone="poly" balance={acct.polymarket} ready={exec?.polymarket.ready} />
        <div className="mt-2 flex items-center justify-between border-t border-line/60 pt-2">
          <span className="font-mono text-[9.5px] uppercase tracking-wide text-fg-muted">Clip Size</span>
          <span className="font-mono text-[11px] tabular-nums text-fg-secondary">{size} sh</span>
        </div>
      </div>
    </>
  );
}

function RailStat({
  label,
  value,
  bar,
  tone,
  invert,
}: {
  label: string;
  value: string;
  bar: number;
  tone: "up" | "down";
  invert?: boolean;
}) {
  const barTone = invert ? (bar > 0.1 ? "halt" : "live") : bar >= 0.6 ? "live" : "stale";
  return (
    <div className="py-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-fg-secondary">{label}</span>
        <span className={cn("font-mono text-[12px] tabular-nums", tone === "up" ? "text-fg" : "text-fg")}>{value}</span>
      </div>
      <MiniBar value={bar} tone={barTone} className="mt-1" />
    </div>
  );
}

function VenueLine({
  name,
  tone,
  balance,
  ready,
}: {
  name: string;
  tone: "kalshi" | "poly";
  balance: number | null | undefined;
  ready: boolean | undefined;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <div className="flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full", tone === "kalshi" ? "bg-kalshi" : "bg-poly")} />
        <span className="text-[11px] text-fg-secondary">{name}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[12px] tabular-nums text-fg">{fmtUsd(balance)}</span>
        <StatusDot tone={ready ? "live" : "halt"} className="size-1.5" />
      </div>
    </div>
  );
}
