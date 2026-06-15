"use client";

import * as React from "react";
import type { DashboardSnapshot, ArbCandidate } from "@/lib/types";
import { ViewScroll, Grid, GridPanel } from "./_layout";
import { EChart } from "@/components/charts/echart";
import { drawdownAreaOption } from "@/components/charts/options";
import { Empty, MiniBar, UtilBar, StatusDot } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { operationalStatus, orderSize } from "@/lib/selectors";
import { fmtUsd, fmtCents, fmtPct, fmtRelative, type StatusTone } from "@/lib/format";
import { cn } from "@/lib/utils";

export function RiskView({ snap }: { snap: DashboardSnapshot }) {
  const e = snap.execution;
  const a = snap.analytics?.daily;
  const size = orderSize(snap);
  const op = operationalStatus(snap);
  const recon = e?.reconciliation;
  const eq = e?.executionQuality;

  const ddPts = a?.buckets.map((b) => ({ t: b.startMs, v: b.drawdown * size })) ?? [];
  const exposure = recon?.quarantinedExposureDollars ?? 0;
  const cap = recon?.quarantineCapDollars ?? e?.maxUnresolvedExposureDollars ?? 250;

  const quarantined = (snap.recentSignals ?? []).filter((s) => s.riskQuarantinedAt || s.recoveryStatus === "risk_quarantined" || s.recoveryStatus === "operator_required");
  const recovering = (snap.recentSignals ?? []).filter((s) => s.recoveryStatus && s.recoveryStatus !== "none" && !s.riskQuarantinedAt);

  // structures with a genuine loss window (probabilistic) sorted by worst case
  const structures = (snap.syntheticStructures ?? [])
    .filter((c) => c.risk)
    .sort((x, y) => (x.risk!.worstCaseProfit) - (y.risk!.worstCaseProfit))
    .slice(0, 10);

  return (
    <ViewScroll>
      {/* control board */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <ControlTile label="Operational" value={op.label} tone={op.tone} />
        <ControlTile label="Risk State" value={(e?.riskState ?? "—").toUpperCase()} tone={e?.riskState === "trading" ? "live" : "stale"} />
        <ControlTile label="Circuit Breaker" value={e?.circuitBreakerLocked ? "LOCKED" : "CLEAR"} tone={e?.circuitBreakerLocked ? "halt" : "live"} />
        <ControlTile label="Partial-Fill Lock" value={e?.partialFillLocked ? "LOCKED" : "CLEAR"} tone={e?.partialFillLocked ? "halt" : "live"} />
        <ControlTile label="Reconciliation" value={recon?.clean ? "CLEAN" : "DIRTY"} tone={recon?.clean ? "live" : "halt"} />
        <ControlTile label="Auto-Hardlocks" value={snap.health.liveAutoHardlocksEnabled ? "ON" : "OFF"} tone={snap.health.liveAutoHardlocksEnabled ? "live" : "stale"} />
      </div>

      <Grid>
        <GridPanel title="Unhedged Exposure vs Cap" dot={exposure > 0 ? "halt" : "live"} span={4} bodyClassName="flex flex-col justify-center gap-3" pulse={false}>
          <div className="flex items-end justify-between">
            <span className={cn("font-mono text-[30px] tabular-nums leading-none", exposure > 0 ? "text-down" : "text-up")}>{fmtUsd(exposure)}</span>
            <span className="font-mono text-[11px] text-fg-muted">cap {fmtUsd(cap)}</span>
          </div>
          <UtilBar value={cap ? exposure / cap : 0} warn={0.5} crit={0.85} />
          <div className="grid grid-cols-2 gap-2">
            <MiniStat label="Quarantined Signals" value={String(recon?.quarantinedSignalCount ?? 0)} tone={(recon?.quarantinedSignalCount ?? 0) > 0 ? "down" : "up"} />
            <MiniStat label="Recovering" value={String(recovering.length)} tone={recovering.length > 0 ? "amber" : "up"} />
            <MiniStat label="Exact Exposure Req." value={e?.exactExposureRequired ? "yes" : "no"} tone="neutral" />
            <MiniStat label="Max Unresolved" value={fmtUsd(e?.maxUnresolvedExposureDollars ?? null)} tone="neutral" />
          </div>
        </GridPanel>

        <GridPanel title="Drawdown · Underwater" dot="stale" span={8} bodyClassName="h-[240px] p-2"
          right={<span className="font-mono text-[11px] tabular-nums text-amber">max {fmtUsd((a?.maxDrawdown ?? 0) * size)}</span>}>
          {ddPts.length > 1 ? <EChart option={drawdownAreaOption(ddPts, (v) => fmtUsd(v, { sign: true }))} /> : <Empty />}
        </GridPanel>
      </Grid>

      <Grid>
        <GridPanel title="Hedge-Risk Telemetry" dot="info" span={4} bodyClassName="flex flex-col gap-2.5">
          <TeleRow label="Mismatch Rate" value={fmtPct(eq?.mismatchRate)} bar={eq?.mismatchRate ?? 0} invert />
          <TeleRow label="PM Timeout Rate" value={fmtPct(eq?.polymarketTimeoutRate)} bar={eq?.polymarketTimeoutRate ?? 0} invert />
          <TeleRow label="Avg Mismatch Cost" value={fmtUsd(eq?.avgMismatchCostDollars ?? 0)} bar={Math.min(1, (eq?.avgMismatchCostDollars ?? 0) / 5)} invert />
          <TeleRow label="Worst Trade" value={fmtCents(a?.worstTradePnl)} bar={Math.min(1, Math.abs(a?.worstTradePnl ?? 0) / 0.1)} invert />
        </GridPanel>

        <GridPanel title="Structural Loss-Window Map · Live Synthetic Structures" dot="info" span={8} bodyClassName="p-0">
          <StructureTable structures={structures} />
        </GridPanel>
      </Grid>

      <GridPanel title="Quarantine & Recovery Queue" dot={quarantined.length ? "halt" : "live"} span={12} bodyClassName="p-0">
        <RecoveryTable rows={[...quarantined, ...recovering].slice(0, 12)} size={size} />
      </GridPanel>
    </ViewScroll>
  );
}

function ControlTile({ label, value, tone }: { label: string; value: string; tone: StatusTone }) {
  const text = tone === "live" ? "text-up" : tone === "halt" ? "text-down" : tone === "stale" ? "text-amber" : "text-fg";
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-md border bg-surface px-3 py-2.5", tone === "halt" ? "border-down/40 risk-pulse" : tone === "stale" ? "border-amber/25" : "border-line")}>
      <div className="flex items-center gap-1.5">
        <StatusDot tone={tone} pulse={tone === "live"} className="size-1.5" />
        <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-muted">{label}</span>
      </div>
      <span className={cn("font-mono text-[15px] uppercase leading-none tracking-wide", text)}>{value}</span>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: "up" | "down" | "amber" | "neutral" }) {
  const text = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "amber" ? "text-amber" : "text-fg-secondary";
  return (
    <div className="rounded-sm border border-line/60 bg-surface-2/40 px-2 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-wide text-fg-muted">{label}</div>
      <div className={cn("font-mono text-[12px] tabular-nums", text)}>{value}</div>
    </div>
  );
}

function TeleRow({ label, value, bar, invert }: { label: string; value: string; bar: number; invert?: boolean }) {
  const tone = invert ? (bar > 0.15 ? "halt" : bar > 0.05 ? "stale" : "live") : "live";
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-fg-secondary">{label}</span>
        <span className="font-mono text-[12px] tabular-nums text-fg">{value}</span>
      </div>
      <MiniBar value={bar} tone={tone} className="mt-1" />
    </div>
  );
}

function classBadge(c: ArbCandidate): { variant: "up" | "amber" | "down"; label: string } {
  const k = c.risk?.classification;
  if (k === "true_arbitrage") return { variant: "up", label: "TRUE ARB" };
  if (k === "guaranteed_below_threshold") return { variant: "amber", label: "SUB-THR" };
  return { variant: "down", label: "PROB BET" };
}

function StructureTable({ structures }: { structures: ArbCandidate[] }) {
  if (!structures.length) return <Empty>No synthetic structures</Empty>;
  return (
    <div className="max-h-[240px] overflow-y-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
          <tr className="border-b border-line">
            <Th>Strikes</Th>
            <Th>Class</Th>
            <Th right>Premium</Th>
            <Th right>Worst</Th>
            <Th right>Best</Th>
            <Th right>Loss Win</Th>
            <Th right>Gap</Th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {structures.map((c) => {
            const r = c.risk!;
            const b = classBadge(c);
            return (
              <tr key={c.pairKey} className="border-b border-line/40 hover:bg-surface-2/40">
                <Td className="text-fg">{Math.min(c.lower.strike, c.higher.strike).toLocaleString()}/{Math.max(c.lower.strike, c.higher.strike).toLocaleString()}</Td>
                <Td><Badge variant={b.variant}>{b.label}</Badge></Td>
                <Td right className="text-fg-secondary">{fmtCents(r.premium)}</Td>
                <Td right className={r.worstCaseProfit >= 0 ? "text-up" : "text-down"}>{fmtCents(r.worstCaseProfit, true)}</Td>
                <Td right className="text-up">{fmtCents(r.bestCaseProfit, true)}</Td>
                <Td right className={r.lossWindowWidth > 0 ? "text-down" : "text-fg-faint"}>{r.lossWindowWidth > 0 ? `$${r.lossWindowWidth.toLocaleString()}` : "none"}</Td>
                <Td right className="text-fg-secondary">${r.strikeGap.toLocaleString()}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecoveryTable({ rows, size }: { rows: DashboardSnapshot["recentSignals"]; size: number }) {
  if (!rows.length) return <Empty>No open quarantines or recoveries — exposure clean</Empty>;
  return (
    <div className="max-h-[280px] overflow-y-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
          <tr className="border-b border-line">
            <Th>Time</Th>
            <Th>Market</Th>
            <Th>Status</Th>
            <Th>Reason</Th>
            <Th right>Exposure</Th>
            <Th right>K-Fill</Th>
            <Th right>P-Fill</Th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {rows.map((s) => {
            const lo = Math.min(s.lower.strike, s.higher.strike);
            const hi = Math.max(s.lower.strike, s.higher.strike);
            const isQ = !!s.riskQuarantinedAt || s.recoveryStatus === "risk_quarantined";
            return (
              <tr key={s.id} className={cn("border-b border-line/40 hover:bg-surface-2/40", isQ && "border-l-2 border-l-down")}>
                <Td className="text-fg-muted">{fmtRelative(new Date(s.updatedAt).getTime())}</Td>
                <Td className="text-fg-secondary">BTC {lo.toLocaleString()}/{hi.toLocaleString()}</Td>
                <Td><Badge variant={isQ ? "down" : "amber"}>{(s.recoveryStatus ?? "—").replace(/_/g, " ")}</Badge></Td>
                <Td className="max-w-[180px] truncate text-fg-muted">{s.riskQuarantineReason ?? s.failureReason ?? "—"}</Td>
                <Td right className={isQ ? "text-down" : "text-fg-secondary"}>{s.riskQuarantineExposureDollars != null ? fmtUsd(s.riskQuarantineExposureDollars) : "–"}</Td>
                <Td right className="text-fg-secondary">{s.kalshiFillCount ?? 0}/{size}</Td>
                <Td right className="text-fg-secondary">{s.polymarketFillCount ?? 0}/{size}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={cn("px-3 py-1.5 font-mono text-[9.5px] uppercase tracking-wide", right ? "text-right" : "text-left")}>{children}</th>;
}
function Td({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cn("px-3 py-1.5", right && "text-right", className)}>{children}</td>;
}
