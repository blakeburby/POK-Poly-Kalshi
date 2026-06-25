"use client";

import * as React from "react";
import type { DashboardSnapshot } from "@/lib/types";
import { ViewScroll, Grid, GridPanel, StatTile } from "./_layout";
import { EChart, CHART } from "@/components/charts/echart";
import { calibrationOption, histogramOption, scatterOption, waterfallOption } from "@/components/charts/options";
import { Empty, MiniBar } from "@/components/ui/stat";
import { executionAggregates, edgeCapture, isExactPair } from "@/lib/selectors";
import { fmtPct, fmtCents, fmtMs, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ExecutionView({ snap }: { snap: DashboardSnapshot }) {
  const ea = executionAggregates(snap);
  const a = snap.analytics?.daily;
  const sigs = snap.recentSignals ?? [];

  const calBins = React.useMemo(() => {
    const bins = 8;
    const buckets = Array.from({ length: bins }, () => ({ sum: 0, exact: 0, n: 0 }));
    for (const s of sigs) {
      const p = s.fillQualitySnapshot?.pairedFillProbability;
      if (p == null) continue;
      const idx = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
      buckets[idx].sum += p;
      buckets[idx].n += 1;
      if (isExactPair(s)) buckets[idx].exact += 1;
    }
    return buckets.filter((b) => b.n > 0).map((b) => ({ predicted: b.sum / b.n, realized: b.exact / b.n, count: b.n }));
  }, [sigs]);

  const scatter = React.useMemo(
    () =>
      sigs
        .filter((s) => s.action === "filled")
        .map((s) => {
          const slip = (s.depthVwap ?? s.premium) - s.premium;
          const exact = isExactPair(s);
          return {
            x: new Date(s.updatedAt).getTime(),
            y: slip,
            color: exact ? CHART.up : s.partialFill ? CHART.amber : CHART.down,
            size: 6,
            name: `${exact ? "exact" : s.partialFill ? "partial" : "fail"}`,
          };
        }),
    [sigs],
  );

  const slipDist = (a?.slippageDistribution ?? []).map((d) => ({ label: d.label, count: d.count, color: CHART.amber }));

  const cap = edgeCapture(a, snap);
  const exp = cap.expected ?? 0;
  const real = cap.realized ?? 0;
  const gap = Math.max(0, exp - real);
  const wf = [
    { label: "Projected", delta: exp },
    { label: "Slippage", delta: -gap * 0.5 },
    { label: "Mismatch", delta: -gap * 0.3 },
    { label: "Timeout", delta: -gap * 0.2 },
    { label: "Realized", delta: real },
  ];

  return (
    <ViewScroll>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <StatTile label="Fill Rate" value={fmtPct(ea.fillRate)} tone={(ea.fillRate ?? 0) >= 0.6 ? "up" : "amber"} />
        <StatTile
          label="Exact-Pair"
          value={fmtPct(ea.exactPairRate)}
          tone={(ea.exactPairRate ?? 0) >= 0.6 ? "up" : "amber"}
          sub="hedge complete"
        />
        <StatTile label="Partial Fill" value={fmtPct(ea.partialRate)} tone="amber" />
        <StatTile
          label="Failed/Reject"
          value={fmtPct(ea.rejectionRate)}
          tone={(ea.rejectionRate ?? 0) > 0.1 ? "down" : "neutral"}
        />
        <StatTile
          label="Avg Slippage"
          value={fmtCents(ea.avgSlippage, true)}
          tone={(ea.avgSlippage ?? 0) > 0.01 ? "amber" : "up"}
        />
        <StatTile label="Time-to-Fill" value={fmtMs(ea.avgTimeToFillMs)} tone="neutral" />
        <StatTile label="Kalshi RTT" value={fmtMs(ea.avgKalshiRtt)} tone="neutral" />
        <StatTile
          label="Polymkt RTT"
          value={fmtMs(ea.avgPolyRtt)}
          tone={(ea.avgPolyRtt ?? 0) > 300 ? "amber" : "neutral"}
        />
      </div>

      <Grid>
        <GridPanel
          title="Fill-Quality Calibration · Predicted vs Realized Exact-Pair"
          dot="info"
          span={5}
          bodyClassName="h-[280px] p-2"
          right={<span className="font-mono text-[10px] text-fg-muted">y=x perfect</span>}
        >
          {calBins.length ? <EChart height={256} option={calibrationOption(calBins)} /> : <Empty />}
        </GridPanel>
        <GridPanel
          title="Edge Capture · Projected → Realized"
          dot="live"
          span={4}
          bodyClassName="h-[280px] p-2"
          right={
            <span className="font-mono text-[10px] tabular-nums text-cyan">
              {cap.retention != null ? `${(cap.retention * 100).toFixed(0)}% retained` : "–"}
            </span>
          }
        >
          <EChart height={256} option={waterfallOption(wf, (v) => fmtCents(v, true))} />
        </GridPanel>
        <GridPanel title="Venue Latency Profile" dot="info" span={3} bodyClassName="flex flex-col justify-center gap-3">
          <LatencyRow
            label="Kalshi RTT"
            p50={firstFeature(sigs, "kalshiRttP50Ms")}
            p95={firstFeature(sigs, "kalshiRttP95Ms")}
            tone="kalshi"
          />
          <LatencyRow
            label="Polymkt RTT"
            p50={firstFeature(sigs, "polymarketRttP50Ms")}
            p95={firstFeature(sigs, "polymarketRttP95Ms")}
            tone="poly"
          />
          <LatencyRow
            label="P Confirm"
            p50={firstFeature(sigs, "polymarketConfirmationP95Ms")}
            p95={firstFeature(sigs, "polymarketConfirmationP95Ms")}
            tone="poly"
          />
          <div className="mt-1 flex items-center justify-between border-t border-line/60 pt-2">
            <span className="font-mono text-[10px] uppercase tracking-wide text-fg-muted">Submit Skew</span>
            <span className="font-mono text-[12px] tabular-nums text-fg">{fmtMs(ea.avgSubmitSkew)}</span>
          </div>
        </GridPanel>
      </Grid>

      <Grid>
        <GridPanel
          title="Realized Slippage vs Time · by Outcome"
          dot="stale"
          span={8}
          bodyClassName="h-[240px] p-2"
          right={<Legend />}
        >
          {scatter.length ? (
            <EChart
              height={216}
              option={scatterOption({
                points: scatter,
                xName: "time",
                yName: "slippage",
                xFmt: (v) =>
                  new Date(v).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
                yFmt: (v) => fmtCents(v, true),
                markLineY: 0,
              })}
            />
          ) : (
            <Empty />
          )}
        </GridPanel>
        <GridPanel title="Slippage Distribution" dot="info" span={4} bodyClassName="h-[240px] p-2">
          {slipDist.length ? <EChart height={216} option={histogramOption(slipDist)} /> : <Empty />}
        </GridPanel>
      </Grid>

      <Grid>
        <GridPanel title="Lead-Lag · Adverse Selection" dot="info" span={6} bodyClassName="p-0">
          <LeadLagTable snap={snap} />
        </GridPanel>
        <GridPanel
          title="Execution-Quality Gate (recent window)"
          dot="live"
          span={6}
          bodyClassName="flex flex-col gap-2.5"
        >
          <GateRow
            label="Exact-Pair Fill Rate"
            value={fmtPct(snap.execution?.executionQuality?.exactPairFillRate)}
            bar={snap.execution?.executionQuality?.exactPairFillRate ?? 0}
            good
          />
          <GateRow
            label="Mismatch Rate"
            value={fmtPct(snap.execution?.executionQuality?.mismatchRate)}
            bar={snap.execution?.executionQuality?.mismatchRate ?? 0}
          />
          <GateRow
            label="PM Timeout Rate"
            value={fmtPct(snap.execution?.executionQuality?.polymarketTimeoutRate)}
            bar={snap.execution?.executionQuality?.polymarketTimeoutRate ?? 0}
          />
          <div className="grid grid-cols-3 gap-2 border-t border-line/60 pt-2.5">
            <StatTile
              label="Est. Edge"
              value={fmtCents(snap.execution?.executionQuality?.estimatedExecutableEdge)}
              tone="up"
            />
            <StatTile
              label="Avg PM RTT"
              value={fmtMs(snap.execution?.executionQuality?.avgPolymarketRttMs)}
              tone="neutral"
            />
            <StatTile
              label="Mismatch $"
              value={fmtUsd(snap.execution?.executionQuality?.avgMismatchCostDollars ?? 0)}
              tone="amber"
            />
          </div>
        </GridPanel>
      </Grid>
    </ViewScroll>
  );
}

function firstFeature(sigs: DashboardSnapshot["recentSignals"], key: string): number | null {
  for (const s of sigs) {
    const v = (s.fillQualitySnapshot?.features as Record<string, unknown> | undefined)?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function LatencyRow({
  label,
  p50,
  p95,
  tone,
}: {
  label: string;
  p50: number | null;
  p95: number | null;
  tone: "kalshi" | "poly";
}) {
  const max = 600;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-fg-secondary">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-fg">
          {fmtMs(p50)} <span className="text-fg-faint">/ {fmtMs(p95)}</span>
        </span>
      </div>
      <MiniBar value={(p95 ?? 0) / max} tone={tone} className="mt-1" />
    </div>
  );
}

function GateRow({ label, value, bar, good }: { label: string; value: string; bar: number; good?: boolean }) {
  const tone = good ? (bar >= 0.6 ? "live" : "stale") : bar > 0.1 ? "halt" : "live";
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

function Legend() {
  return (
    <div className="hidden items-center gap-2.5 font-mono text-[9px] uppercase tracking-wide text-fg-muted sm:flex">
      <span className="flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-up" /> exact
      </span>
      <span className="flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-amber" /> partial
      </span>
      <span className="flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-down" /> fail
      </span>
    </div>
  );
}

function LeadLagTable({ snap }: { snap: DashboardSnapshot }) {
  const rows = (snap.recentSignals ?? []).filter((s) => s.leadLagSnapshot).slice(0, 12);
  if (!rows.length) return <Empty>No lead-lag data</Empty>;
  return (
    <div className="max-h-[240px] overflow-auto">
      <table className="w-full min-w-[460px] border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
          <tr className="border-b border-line">
            <th className="px-3 py-1.5 text-left font-mono text-[9.5px] uppercase tracking-wide">Time</th>
            <th className="px-3 py-1.5 text-left font-mono text-[9.5px] uppercase tracking-wide">Leader</th>
            <th className="px-3 py-1.5 text-right font-mono text-[9.5px] uppercase tracking-wide">Lag</th>
            <th className="px-3 py-1.5 text-right font-mono text-[9.5px] uppercase tracking-wide">Conf</th>
            <th className="px-3 py-1.5 text-right font-mono text-[9.5px] uppercase tracking-wide">Adv-Sel</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {rows.map((s) => {
            const ll = s.leadLagSnapshot!;
            return (
              <tr key={s.id} className="border-b border-line/40 hover:bg-surface-2/40">
                <td className="px-3 py-1.5 text-fg-muted">
                  {new Date(s.updatedAt).toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </td>
                <td className="px-3 py-1.5">
                  <span
                    className={cn(
                      ll.leaderVenue === "kalshi"
                        ? "text-kalshi"
                        : ll.leaderVenue === "polymarket"
                          ? "text-poly"
                          : "text-fg-muted",
                    )}
                  >
                    {ll.leaderVenue}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right text-fg-secondary">{fmtMs(ll.lagMsEstimate)}</td>
                <td className="px-3 py-1.5 text-right text-fg">{fmtPct(ll.confidence)}</td>
                <td
                  className={cn(
                    "px-3 py-1.5 text-right",
                    ll.adverseSelectionScore > 0.7 ? "text-down" : "text-fg-secondary",
                  )}
                >
                  {fmtPct(ll.adverseSelectionScore)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
