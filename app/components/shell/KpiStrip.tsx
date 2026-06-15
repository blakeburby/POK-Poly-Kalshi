"use client";

import * as React from "react";
import { useDashboardStore } from "@/store/dashboard-store";
import { accountEquity, openPositionCount, orderSize, tradeableNow } from "@/lib/selectors";
import { fmtUsd, fmtPct, fmtCents, fmtNum, type StatusTone } from "@/lib/format";
import { Sparkline } from "@/components/ui/stat";
import { cn } from "@/lib/utils";

interface Kpi {
  label: string;
  value: string;
  tone?: "up" | "down" | "neutral" | StatusTone;
  emphasis?: boolean;
  spark?: number[];
}

const toneClass = (tone?: Kpi["tone"]): string => {
  switch (tone) {
    case "up":
    case "live":
      return "text-up";
    case "down":
    case "halt":
      return "text-down";
    case "stale":
      return "text-amber";
    default:
      return "text-fg";
  }
};

export function KpiStrip() {
  const snap = useDashboardStore((s) => s.snapshot);
  if (!snap) {
    return <div className="h-[var(--kpi-h)] shrink-0 border-b border-line bg-surface/50" />;
  }
  const size = orderSize(snap);
  const a = snap.analytics;
  const eq = accountEquity(snap);
  const exec = snap.execution;
  const equitySpark = snap.tradingActivity
    ? [
        ...(snap.tradingActivity.kalshi.sparkline ?? []),
        ...(snap.tradingActivity.polymarket.sparkline ?? []),
      ]
        .sort((x, y) => x.timestamp - y.timestamp)
        .slice(-40)
        .map((p) => p.value)
    : [];
  const pnlSpark = a?.hourly.buckets.map((b) => b.cumulativePnl * size) ?? [];

  const day = (a?.daily.netPnl ?? 0) * size;
  const hour = (a?.hourly.netPnl ?? 0) * size;
  const week = (a?.weekly.netPnl ?? 0) * size;
  const unhedged = exec?.reconciliation.quarantinedExposureDollars ?? 0;

  // Key metrics first so the most important are visible before any horizontal scroll on mobile.
  const kpis: Kpi[] = [
    { label: "Net PnL · Today", value: fmtUsd(day, { sign: true }), tone: day >= 0 ? "up" : "down", emphasis: true, spark: pnlSpark },
    { label: "Account Equity", value: fmtUsd(eq.total), tone: "neutral", emphasis: true, spark: equitySpark },
    { label: "Open Positions", value: fmtNum(openPositionCount(snap)), tone: "neutral" },
    { label: "Unhedged Exposure", value: fmtUsd(unhedged), tone: unhedged > 0 ? "down" : "up" },
    { label: "Fill Success", value: fmtPct(a?.daily.fillRate), tone: (a?.daily.fillRate ?? 0) >= 0.6 ? "up" : "stale" },
    { label: "Hedge / Exact-Pair", value: fmtPct(exec?.executionQuality?.exactPairFillRate), tone: (exec?.executionQuality?.exactPairFillRate ?? 0) >= 0.6 ? "up" : "stale" },
    { label: "Avg Edge Captured", value: fmtCents(exec?.executionQuality?.estimatedExecutableEdge), tone: "up" },
    { label: "Net PnL · 1H", value: fmtUsd(hour, { sign: true }), tone: hour >= 0 ? "up" : "down" },
    { label: "Net PnL · 7D", value: fmtUsd(week, { sign: true }), tone: week >= 0 ? "up" : "down" },
    { label: "Win Rate", value: fmtPct(a?.daily.winRate), tone: "neutral" },
    { label: "Per-Trade Sharpe", value: a?.daily.sharpeRatio != null ? a.daily.sharpeRatio.toFixed(2) : "–", tone: "neutral" },
  ];

  return (
    <div className="flex h-[var(--kpi-h)] shrink-0 snap-x snap-mandatory items-stretch gap-px overflow-x-auto scroll-px-3 border-b border-line bg-surface/40">
      {kpis.map((k) => (
        <div
          key={k.label}
          className={cn(
            "flex min-w-[44vw] snap-start flex-col justify-center gap-1 border-r border-line/60 px-3.5 sm:min-w-[118px] sm:flex-1",
            k.emphasis && "sm:min-w-[150px]",
          )}
        >
          <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-muted">{k.label}</span>
          <div className="flex items-end justify-between gap-2">
            <span
              className={cn(
                "font-mono tabular-nums leading-none",
                k.emphasis ? "text-[20px]" : "text-[15px]",
                toneClass(k.tone),
              )}
            >
              {k.value}
            </span>
            {k.spark && k.spark.length > 1 ? (
              <Sparkline data={k.spark} width={56} height={20} className="opacity-80" />
            ) : null}
          </div>
        </div>
      ))}
      <TradeableTile ok={tradeableNow(snap)} riskState={exec?.riskState ?? "unknown"} />
    </div>
  );
}

function TradeableTile({ ok, riskState }: { ok: boolean; riskState: string }) {
  return (
    <div className="flex min-w-[44vw] snap-start flex-col justify-center gap-1 bg-surface-2/40 px-3.5 sm:min-w-[150px]">
      <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-muted">System</span>
      <div className="flex items-center gap-2">
        <span className={cn("size-2.5 rounded-full", ok ? "bg-live heartbeat" : "bg-halt")} />
        <span className={cn("font-mono text-[15px] uppercase leading-none", ok ? "text-up" : "text-down")}>
          {ok ? "TRADEABLE" : "HALTED"}
        </span>
      </div>
      <span className="font-mono text-[9.5px] uppercase tracking-wide text-fg-muted">risk · {riskState}</span>
    </div>
  );
}
