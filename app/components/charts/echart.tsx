"use client";

import * as React from "react";
import * as echarts from "echarts";
import { cn } from "@/lib/utils";

/** Token hex values for ECharts (cannot read CSS vars). Keep in sync with globals.css. */
export const CHART = {
  base: "#07090c",
  surface: "#0c0f14",
  line: "#1b212b",
  lineStrong: "#2a323f",
  fg: "#e8eaed",
  fgSecondary: "#a8b0bd",
  fgMuted: "#6b7280",
  up: "#26d67c",
  down: "#ff5c5c",
  cyan: "#22d3ee",
  blue: "#3b82f6",
  amber: "#f5a623",
  violet: "#a855f7",
  kalshi: "#00c2a8",
  poly: "#a855f7",
  heatLow: "#0c2a3a",
  heatHigh: "#22d3ee",
  fontMono: "var(--font-geist-mono), ui-monospace, monospace",
};

export const axisLabel = { color: CHART.fgMuted, fontFamily: CHART.fontMono, fontSize: 10 } as const;
export const splitLine = { lineStyle: { color: CHART.line, type: "dashed" as const } };

export const baseTooltip = {
  backgroundColor: "#161b24",
  borderColor: CHART.lineStrong,
  borderWidth: 1,
  textStyle: { color: CHART.fgSecondary, fontFamily: CHART.fontMono, fontSize: 11 },
  padding: [6, 9] as [number, number],
  confine: true,
};

export const baseGrid = { left: 8, right: 12, top: 12, bottom: 8, containLabel: true };

export interface EChartProps {
  option: echarts.EChartsOption;
  className?: string;
  /** Disable animations (default true for live data). */
  notMerge?: boolean;
  onReady?: (chart: echarts.ECharts) => void;
  height?: number | string;
}

export function EChart({ option, className, notMerge, onReady, height }: EChartProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);

  React.useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "canvas", useDirtyRect: true });
    chartRef.current = chart;
    onReady?.(chart);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: notMerge ?? true, lazyUpdate: true });
  }, [option, notMerge]);

  return <div ref={ref} className={cn("h-full w-full", className)} style={height != null ? { height } : undefined} />;
}
