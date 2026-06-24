"use client";

import * as React from "react";
import type { DashboardSnapshot, AnalyticsWindow } from "@/lib/types";
import { ViewScroll, Grid, GridPanel, StatTile } from "./_layout";
import { EChart } from "@/components/charts/echart";
import {
  equityAreaOption,
  pnlBarsDrawdownOption,
  drawdownAreaOption,
  histogramOption,
  waterfallOption,
} from "@/components/charts/options";
import { Empty } from "@/components/ui/stat";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { edgeCapture, orderSize } from "@/lib/selectors";
import { fmtUsd, fmtPct, fmtCents, fmtNum, fmtPctRaw } from "@/lib/format";
import { CHART } from "@/components/charts/echart";

export function PerformanceView({ snap }: { snap: DashboardSnapshot }) {
  const [win, setWin] = React.useState<AnalyticsWindow>("daily");
  const size = orderSize(snap);
  const a = snap.analytics?.[win];
  const usd = (perShare: number) => perShare * size;
  const fmt$ = (v: number) => fmtUsd(v, { sign: true });

  if (!a) {
    return (
      <ViewScroll>
        <GridPanel title="Performance" span={12} bodyClassName="h-48">
          <Empty>Analytics unavailable</Empty>
        </GridPanel>
      </ViewScroll>
    );
  }

  const equityPts = a.buckets.map((b) => ({ t: b.startMs, v: usd(b.cumulativePnl) }));
  const ddPts = a.buckets.map((b) => ({ t: b.startMs, v: usd(b.drawdown) }));
  const bars = a.buckets.map((b) => ({ label: b.label, net: usd(b.netPnl), drawdown: usd(b.drawdown) }));
  const pnlDist = a.pnlDistribution.map((d) => ({
    label: d.label,
    count: d.count,
    color: d.label === "Loss" ? CHART.down : d.label === "Breakeven" ? CHART.fgMuted : CHART.up,
  }));

  const cap = edgeCapture(a, snap);
  const expected = cap.expected ?? 0;
  const realized = cap.realized ?? 0;
  const waterfall = [
    { label: "Expected", delta: usd(expected) },
    { label: "Slippage", delta: -usd(Math.max(0, expected - realized) * 0.6) },
    { label: "Mismatch/TO", delta: -usd(Math.max(0, expected - realized) * 0.4) },
    { label: "Realized", delta: usd(realized) },
  ];

  const net = usd(a.netPnl);

  return (
    <ViewScroll>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-muted">Window</span>
          <Tabs value={win} onValueChange={(v) => setWin(v as AnalyticsWindow)}>
            <TabsList className="rounded-md border border-line bg-surface p-0.5">
              <TabsTrigger value="hourly">24H</TabsTrigger>
              <TabsTrigger value="daily">7D</TabsTrigger>
              <TabsTrigger value="weekly">8W</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <span className="hidden truncate font-mono text-[10px] uppercase tracking-wide text-fg-faint sm:inline">
          per-share PnL × {size}-share clip · {a.filledTrades} fills
        </span>
      </div>

      {/* stat tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <StatTile label="Net PnL" value={fmt$(net)} tone={net >= 0 ? "up" : "down"} />
        <StatTile label="Win Rate" value={fmtPct(a.winRate)} tone="cyan" sub={`${a.tradesWon}W / ${a.tradesLost}L`} />
        <StatTile
          label="Profit Factor"
          value={a.profitFactor != null ? a.profitFactor.toFixed(2) : "–"}
          tone="neutral"
        />
        <StatTile
          label="Sharpe*"
          value={a.sharpeRatio != null ? a.sharpeRatio.toFixed(2) : "–"}
          tone="neutral"
          sub="per-trade"
        />
        <StatTile
          label="Avg / Trade"
          value={fmtUsd(usd(a.averagePnl ?? 0), { sign: true })}
          tone={(a.averagePnl ?? 0) >= 0 ? "up" : "down"}
        />
        <StatTile
          label="Best / Worst"
          value={`${fmtCents(a.bestTradePnl)} / ${fmtCents(a.worstTradePnl)}`}
          tone="neutral"
        />
        <StatTile label="Max Drawdown" value={fmtUsd(usd(a.maxDrawdown))} tone="amber" />
        <StatTile
          label="Opportunities"
          value={fmtNum(a.opportunityCount)}
          tone="neutral"
          sub={`fill ${fmtPct(a.fillRate)}`}
        />
      </div>

      <Grid>
        <GridPanel
          title={`Equity Curve · Cumulative PnL`}
          dot="live"
          span={8}
          bodyClassName="h-[280px] p-2"
          right={
            <span className={`font-mono text-[11px] tabular-nums ${net >= 0 ? "text-up" : "text-down"}`}>
              {fmt$(net)}
            </span>
          }
        >
          {equityPts.length > 1 ? (
            <EChart option={equityAreaOption(equityPts, { positive: net >= 0, fmt: fmt$ })} />
          ) : (
            <Empty />
          )}
        </GridPanel>
        <GridPanel
          title="Edge Capture · Expected → Realized"
          dot="info"
          span={4}
          bodyClassName="h-[280px] p-2"
          right={
            <span className="font-mono text-[11px] tabular-nums text-cyan">
              {cap.retention != null ? `${fmtPctRaw(cap.retention * 100)} ret` : "–"}
            </span>
          }
        >
          <EChart option={waterfallOption(waterfall, (v) => fmtUsd(v, { sign: true }))} />
        </GridPanel>
      </Grid>

      <Grid>
        <GridPanel title="Per-Bucket Net PnL + Drawdown" dot="live" span={7} bodyClassName="h-[240px] p-2">
          <EChart option={pnlBarsDrawdownOption(bars, fmt$)} />
        </GridPanel>
        <GridPanel
          title="Rolling Drawdown"
          dot="stale"
          span={5}
          bodyClassName="h-[240px] p-2"
          right={
            <span className="font-mono text-[11px] tabular-nums text-amber">max {fmtUsd(usd(a.maxDrawdown))}</span>
          }
        >
          <EChart option={drawdownAreaOption(ddPts, fmt$)} />
        </GridPanel>
      </Grid>

      <Grid>
        <GridPanel title="PnL Distribution" dot="info" span={4} bodyClassName="h-[220px] p-2">
          <EChart option={histogramOption(pnlDist)} />
        </GridPanel>
        <GridPanel title="PnL / Win-Rate Heatmap" dot="info" span={8} bodyClassName="h-[220px]">
          <HeatmapStrip buckets={a.heatmap} usd={usd} />
        </GridPanel>
      </Grid>
    </ViewScroll>
  );
}

interface HeatCell {
  label: string;
  netPnl: number;
  winRate: number;
  tradeCount: number;
}

function HeatmapStrip({ buckets: b, usd: u }: { buckets: HeatCell[]; usd: (v: number) => number }) {
  const maxAbs = Math.max(...b.map((x) => Math.abs(x.netPnl)), 1e-9);
  if (!b.length) return <Empty />;
  return (
    <div className="flex h-full flex-col justify-center gap-3">
      <div className="flex flex-wrap gap-1">
        {b.map((cell) => {
          const intensity = Math.min(1, Math.abs(cell.netPnl) / maxAbs);
          const color =
            cell.netPnl >= 0
              ? `rgba(38,214,124,${0.12 + intensity * 0.7})`
              : `rgba(255,92,92,${0.12 + intensity * 0.7})`;
          return (
            <div
              key={cell.label}
              className="flex min-w-[44px] flex-1 flex-col items-center gap-1 rounded-sm border border-line/60 px-1.5 py-2"
              style={{ background: color }}
              title={`${cell.label} · ${fmtUsd(u(cell.netPnl), { sign: true })} · ${cell.tradeCount} trades · ${fmtPct(cell.winRate)} win`}
            >
              <span className="font-mono text-[9px] text-fg/80">{cell.label}</span>
              <span className="font-mono text-[10px] tabular-nums text-fg">{cell.tradeCount}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-center gap-4 font-mono text-[9px] uppercase tracking-wide text-fg-muted">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-up/70" /> profit
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-down/70" /> loss
        </span>
        <span>cell = bucket · number = trades · hover for detail</span>
      </div>
    </div>
  );
}
