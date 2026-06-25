"use client";

import * as React from "react";
import type { DashboardSnapshot, DashboardSignal, ArbLeg, DashboardLogEntry } from "@/lib/types";
import { ViewScroll, Grid, GridPanel, StatTile } from "./_layout";
import { Empty } from "@/components/ui/stat";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { fmtClock, fmtCents, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDashboardStore } from "@/store/dashboard-store";

export type Kind = "fill" | "partial" | "skip" | "fail" | "quarantine" | "warn" | "error";

export interface TapeEvent {
  key: string;
  t: number;
  kind: Kind;
  lower?: ArbLeg;
  higher?: ArbLeg;
  pairKey?: string;
  edge: number | null;
  detail: string;
}

export const KIND_META: Record<Kind, { label: string; variant: NonNullable<BadgeProps["variant"]>; accent: string }> = {
  fill: { label: "FILL", variant: "up", accent: "var(--color-up)" },
  partial: { label: "PARTIAL", variant: "cyan", accent: "var(--color-cyan)" },
  skip: { label: "SKIP", variant: "neutral", accent: "var(--color-fg-faint)" },
  fail: { label: "FAIL", variant: "down", accent: "var(--color-down)" },
  quarantine: { label: "QUAR", variant: "amber", accent: "var(--color-amber)" },
  warn: { label: "WARN", variant: "amber", accent: "var(--color-amber)" },
  error: { label: "ERR", variant: "down", accent: "var(--color-down)" },
};

type FilterKey = "all" | "fills" | "skips" | "fails" | "risk";
const FILTERS: { key: FilterKey; label: string; kinds: Kind[] | null }[] = [
  { key: "all", label: "All", kinds: null },
  { key: "fills", label: "Fills", kinds: ["fill", "partial"] },
  { key: "skips", label: "Skips", kinds: ["skip"] },
  { key: "fails", label: "Fails", kinds: ["fail"] },
  { key: "risk", label: "Risk / Logs", kinds: ["quarantine", "warn", "error"] },
];

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function abbr(venue: string): string {
  return venue === "kalshi" ? "K" : "P";
}

function signalKind(s: DashboardSignal): Kind {
  if (s.riskQuarantinedAt) return "quarantine";
  if (s.action === "failed") return "fail";
  if (s.action === "skipped") return "skip";
  if (s.partialFill) return "partial";
  return "fill";
}

function signalDetail(s: DashboardSignal, kind: Kind): string {
  if (kind === "quarantine") {
    return `${s.riskQuarantineReason ?? "quarantined"}${
      s.riskQuarantineExposureDollars != null ? ` · $${s.riskQuarantineExposureDollars.toFixed(0)} exposure` : ""
    }`;
  }
  if (kind === "fail" || kind === "skip") return s.failureReason ?? kind;
  const parts: string[] = [];
  if (s.kalshiFillPrice != null) parts.push(`K ${fmtCents(s.kalshiFillPrice)}`);
  if (s.polymarketFillPrice != null) parts.push(`P ${fmtCents(s.polymarketFillPrice)}`);
  if (s.partialFill) parts.push("leg mismatch");
  return parts.join(" · ") || "paired";
}

export function buildEvents(snap: DashboardSnapshot): TapeEvent[] {
  const out: TapeEvent[] = [];
  for (const s of snap.recentSignals ?? []) {
    const kind = signalKind(s);
    out.push({
      key: `sig-${s.id}`,
      t: ms(s.updatedAt) || ms(s.createdAt),
      kind,
      lower: s.lower,
      higher: s.higher,
      pairKey: s.pairKey,
      edge:
        s.action === "filled"
          ? (s.realizedGuaranteedProfit ?? s.guaranteedProfit)
          : (s.expectedExecutableEdge ?? s.guaranteedProfit),
      detail: signalDetail(s, kind),
    });
  }
  for (const [i, log] of (snap.logs ?? []).entries()) {
    if (log.severity !== "WARN" && log.severity !== "ERROR") continue;
    out.push({
      key: `log-${i}-${log.timestamp}`,
      t: ms(log.timestamp),
      kind: log.severity === "ERROR" ? "error" : "warn",
      edge: null,
      detail: `[${log.category}] ${log.message}`,
    });
  }
  return out.sort((a, b) => b.t - a.t).slice(0, 250);
}

export function TapeView({ snap }: { snap: DashboardSnapshot }) {
  const reducedMotion = useDashboardStore((s) => s.reducedMotion);
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const events = React.useMemo(() => buildEvents(snap), [snap]);

  // Track the newest timestamp we've rendered so freshly-arrived rows can flash once.
  const [maxSeen, setMaxSeen] = React.useState(0);
  React.useEffect(() => {
    const m = events.reduce((acc, e) => Math.max(acc, e.t), 0);
    if (m > maxSeen) setMaxSeen(m);
  }, [events, maxSeen]);

  const counts = React.useMemo(() => {
    const c = { fill: 0, partial: 0, skip: 0, fail: 0, quarantine: 0, warn: 0, error: 0 } as Record<Kind, number>;
    for (const e of events) c[e.kind] += 1;
    return c;
  }, [events]);
  const decisions = counts.fill + counts.partial + counts.skip + counts.fail;
  const fillRate = decisions > 0 ? (counts.fill + counts.partial) / decisions : null;

  const active = FILTERS.find((f) => f.key === filter)!;
  const shown = active.kinds ? events.filter((e) => active.kinds!.includes(e.kind)) : events;

  return (
    <ViewScroll>
      <Grid>
        <StatTile
          className="col-span-6 sm:col-span-3 xl:col-span-2"
          label="Fills"
          value={String(counts.fill + counts.partial)}
          tone="up"
          sub={`${counts.partial} partial`}
        />
        <StatTile
          className="col-span-6 sm:col-span-3 xl:col-span-2"
          label="Skips"
          value={String(counts.skip)}
          tone="neutral"
        />
        <StatTile
          className="col-span-6 sm:col-span-3 xl:col-span-2"
          label="Fails"
          value={String(counts.fail)}
          tone={counts.fail > 0 ? "down" : "neutral"}
        />
        <StatTile
          className="col-span-6 sm:col-span-3 xl:col-span-2"
          label="Quarantines"
          value={String(counts.quarantine)}
          tone={counts.quarantine > 0 ? "amber" : "neutral"}
        />
        <StatTile
          className="col-span-6 sm:col-span-3 xl:col-span-2"
          label="Fill Rate"
          value={fillRate != null ? fmtPct(fillRate) : "—"}
          tone={fillRate != null && fillRate >= 0.7 ? "up" : "amber"}
        />
        <StatTile
          className="col-span-6 sm:col-span-3 xl:col-span-2"
          label="Warnings"
          value={String(counts.warn + counts.error)}
          tone={counts.error > 0 ? "down" : counts.warn > 0 ? "amber" : "neutral"}
        />
      </Grid>

      <GridPanel
        title="Live Strategy Tape"
        dot="live"
        pulse
        span={12}
        right={
          <div className="flex items-center gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "rounded-sm px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors",
                  filter === f.key ? "bg-surface-3 text-fg" : "text-fg-muted hover:text-fg-secondary",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
        bodyClassName="p-0"
      >
        {shown.length === 0 ? (
          <Empty>No events in this stream</Empty>
        ) : (
          <div className="max-h-[640px] overflow-auto">
            <table className="w-full min-w-[680px] border-collapse text-[11px]">
              <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
                <tr className="border-b border-line">
                  <Th>Time</Th>
                  <Th>Event</Th>
                  <Th>Market</Th>
                  <Th right>Edge</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {shown.map((e) => {
                  const meta = KIND_META[e.kind];
                  const fresh = !reducedMotion && maxSeen > 0 && e.t > maxSeen;
                  return (
                    <tr
                      key={e.key}
                      className={cn("border-b border-line/30 hover:bg-surface-2/40", fresh && "flash-up")}
                      style={{ boxShadow: `inset 2px 0 0 ${meta.accent}` }}
                    >
                      <td className="whitespace-nowrap px-3 py-1.5 text-fg-muted">{e.t ? fmtClock(e.t) : "—"}</td>
                      <td className="px-3 py-1.5">
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </td>
                      <td className="px-3 py-1.5 text-fg-secondary">
                        {e.lower && e.higher ? (
                          <span>
                            <span className="text-kalshi">{abbr(e.lower.venue)}</span>{" "}
                            <span className="text-fg">{e.lower.strike.toLocaleString()}</span>
                            <span className="text-fg-faint"> {e.lower.direction}</span>
                            <span className="text-fg-faint"> · </span>
                            <span className="text-poly">{abbr(e.higher.venue)}</span>{" "}
                            <span className="text-fg">{e.higher.strike.toLocaleString()}</span>
                            <span className="text-fg-faint"> {e.higher.direction}</span>
                          </span>
                        ) : (
                          <span className="text-fg-faint">{e.pairKey ?? "system"}</span>
                        )}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-1.5 text-right",
                          (e.edge ?? 0) > 0 ? "text-up" : (e.edge ?? 0) < 0 ? "text-down" : "text-fg-faint",
                        )}
                      >
                        {e.edge != null ? fmtCents(e.edge, true) : "—"}
                      </td>
                      <td className="max-w-[320px] truncate px-3 py-1.5 text-fg-muted" title={e.detail}>
                        {e.detail}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </GridPanel>
    </ViewScroll>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={cn("px-3 py-1.5 font-mono text-[9.5px] uppercase tracking-wide", right ? "text-right" : "text-left")}
    >
      {children}
    </th>
  );
}
