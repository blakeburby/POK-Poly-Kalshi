import type { EChartsOption, XAXisComponentOption, YAXisComponentOption } from "echarts";
import { CHART, axisLabel, baseGrid, baseTooltip, splitLine } from "./echart";

type Pt = { t: number; v: number };
type AxisOpt = XAXisComponentOption & YAXisComponentOption;

const timeAxis = (compact = false): XAXisComponentOption =>
  ({
    type: "time",
    axisLine: { lineStyle: { color: CHART.line } },
    axisTick: { show: false },
    axisLabel: { ...axisLabel, hideOverlap: true },
    splitLine: { show: false },
    show: !compact,
  }) as unknown as XAXisComponentOption;

const valueAxis = (fmt?: (v: number) => string, opts?: { compact?: boolean }): AxisOpt =>
  ({
    type: "value",
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { ...axisLabel, formatter: fmt },
    splitLine,
    scale: true,
    show: !opts?.compact,
  }) as unknown as AxisOpt;

export function equityAreaOption(
  points: Pt[],
  opts?: { positive?: boolean; fmt?: (v: number) => string },
): EChartsOption {
  const color = (opts?.positive ?? true) ? CHART.up : CHART.down;
  return {
    animation: false,
    grid: baseGrid,
    tooltip: {
      ...baseTooltip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: CHART.lineStrong } },
      valueFormatter: (v) => (opts?.fmt ? opts.fmt(Number(v)) : String(v)),
    },
    xAxis: timeAxis(),
    yAxis: valueAxis(opts?.fmt),
    series: [
      {
        type: "line",
        showSymbol: false,
        smooth: 0.18,
        lineStyle: { color: CHART.cyan, width: 1.6 },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(34,211,238,0.28)" },
              { offset: 1, color: "rgba(34,211,238,0)" },
            ],
          },
        },
        data: points.map((p) => [p.t, p.v]),
      },
    ],
  } satisfies EChartsOption;
}

export function pnlBarsDrawdownOption(
  buckets: Array<{ label: string; net: number; drawdown: number }>,
  fmt: (v: number) => string,
): EChartsOption {
  return {
    animation: false,
    grid: { ...baseGrid, right: 40 },
    tooltip: { ...baseTooltip, trigger: "axis", axisPointer: { type: "shadow" } },
    legend: {
      data: ["Net PnL", "Drawdown"],
      textStyle: { color: CHART.fgMuted, fontFamily: CHART.fontMono, fontSize: 10 },
      right: 4,
      top: 0,
      itemWidth: 10,
      itemHeight: 8,
    },
    xAxis: {
      type: "category",
      data: buckets.map((b) => b.label),
      axisLine: { lineStyle: { color: CHART.line } },
      axisTick: { show: false },
      axisLabel: { ...axisLabel, hideOverlap: true },
    },
    yAxis: [valueAxis(fmt), { ...valueAxis(fmt), position: "right", splitLine: { show: false } }],
    series: [
      {
        name: "Net PnL",
        type: "bar",
        data: buckets.map((b) => ({
          value: b.net,
          itemStyle: { color: b.net >= 0 ? CHART.up : CHART.down, opacity: 0.85 },
        })),
        barWidth: "55%",
      },
      {
        name: "Drawdown",
        type: "line",
        yAxisIndex: 1,
        showSymbol: false,
        lineStyle: { color: CHART.amber, width: 1.3, type: "dashed" },
        areaStyle: { color: "rgba(245,166,35,0.08)" },
        data: buckets.map((b) => -Math.abs(b.drawdown)),
      },
    ],
  } satisfies EChartsOption;
}

export function drawdownAreaOption(points: Pt[], fmt: (v: number) => string): EChartsOption {
  return {
    animation: false,
    grid: baseGrid,
    tooltip: { ...baseTooltip, trigger: "axis", valueFormatter: (v) => fmt(Number(v)) },
    xAxis: timeAxis(),
    yAxis: { ...valueAxis(fmt), max: 0 },
    series: [
      {
        type: "line",
        showSymbol: false,
        smooth: 0.1,
        lineStyle: { color: CHART.down, width: 1.2 },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(255,92,92,0)" },
              { offset: 1, color: "rgba(255,92,92,0.32)" },
            ],
          },
        },
        data: points.map((p) => [p.t, -Math.abs(p.v)]),
      },
    ],
  } satisfies EChartsOption;
}

export function histogramOption(bars: Array<{ label: string; count: number; color?: string }>): EChartsOption {
  return {
    animation: false,
    grid: { ...baseGrid, bottom: 4 },
    tooltip: { ...baseTooltip, trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: {
      type: "category",
      data: bars.map((b) => b.label),
      axisLine: { lineStyle: { color: CHART.line } },
      axisTick: { show: false },
      axisLabel: axisLabel,
    },
    yAxis: valueAxis(),
    series: [
      {
        type: "bar",
        data: bars.map((b) => ({
          value: b.count,
          itemStyle: { color: b.color ?? CHART.cyan, opacity: 0.85, borderRadius: [2, 2, 0, 0] },
        })),
        barWidth: "62%",
      },
    ],
  } satisfies EChartsOption;
}

export function scatterOption(opts: {
  points: Array<{ x: number; y: number; color: string; size?: number; name?: string }>;
  xName: string;
  yName: string;
  xFmt?: (v: number) => string;
  yFmt?: (v: number) => string;
  markLineX?: number;
  markLineY?: number;
  refLine?: boolean;
}): EChartsOption {
  return {
    animation: false,
    grid: { ...baseGrid, top: 22 },
    tooltip: {
      ...baseTooltip,
      trigger: "item",
      formatter: (p: any) =>
        `${p.data.name ?? ""}<br/>${opts.xName}: ${opts.xFmt ? opts.xFmt(p.data.value[0]) : p.data.value[0]}<br/>${opts.yName}: ${opts.yFmt ? opts.yFmt(p.data.value[1]) : p.data.value[1]}`,
    },
    xAxis: {
      ...valueAxis(opts.xFmt),
      name: opts.xName,
      nameTextStyle: { ...axisLabel },
      nameGap: 18,
      nameLocation: "middle",
    },
    yAxis: {
      ...valueAxis(opts.yFmt),
      name: opts.yName,
      nameTextStyle: { ...axisLabel },
      nameGap: 28,
      nameLocation: "middle",
    },
    series: [
      {
        type: "scatter",
        symbolSize: (val: any, p: any) => p.data.size ?? 7,
        data: opts.points.map((pt) => ({
          value: [pt.x, pt.y],
          name: pt.name,
          itemStyle: { color: pt.color, opacity: 0.78 },
        })),
        markLine:
          opts.markLineX != null || opts.markLineY != null || opts.refLine
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { color: CHART.lineStrong, type: "dashed" },
                data: [
                  ...(opts.markLineX != null ? [{ xAxis: opts.markLineX, lineStyle: { color: CHART.amber } }] : []),
                  ...(opts.markLineY != null ? [{ yAxis: opts.markLineY, lineStyle: { color: CHART.amber } }] : []),
                ],
              }
            : undefined,
      },
    ],
  } satisfies EChartsOption;
}

export function depthOption(kalshi: Array<[number, number]>, poly: Array<[number, number]>): EChartsOption {
  return {
    animation: false,
    grid: baseGrid,
    tooltip: { ...baseTooltip, trigger: "axis" },
    legend: {
      data: ["Kalshi", "Polymarket"],
      textStyle: { color: CHART.fgMuted, fontFamily: CHART.fontMono, fontSize: 10 },
      top: 0,
      right: 4,
      itemWidth: 10,
      itemHeight: 8,
    },
    xAxis: { ...valueAxis((v) => `${(v * 100).toFixed(0)}¢`), name: "price" },
    yAxis: valueAxis((v) => `${v}`),
    series: [
      {
        name: "Kalshi",
        type: "line",
        step: "end",
        showSymbol: false,
        lineStyle: { color: CHART.kalshi, width: 1.4 },
        areaStyle: { color: "rgba(0,194,168,0.12)" },
        data: kalshi,
      },
      {
        name: "Polymarket",
        type: "line",
        step: "end",
        showSymbol: false,
        lineStyle: { color: CHART.poly, width: 1.4 },
        areaStyle: { color: "rgba(168,85,247,0.12)" },
        data: poly,
      },
    ],
  } satisfies EChartsOption;
}

export function calibrationOption(bins: Array<{ predicted: number; realized: number; count: number }>): EChartsOption {
  return {
    animation: false,
    grid: { ...baseGrid, top: 20 },
    tooltip: {
      ...baseTooltip,
      trigger: "item",
      formatter: (p: any) =>
        Array.isArray(p.data.value)
          ? `pred ${(p.data.value[0] * 100).toFixed(0)}% · real ${(p.data.value[1] * 100).toFixed(0)}%<br/>n=${p.data.count ?? ""}`
          : "",
    },
    xAxis: { ...valueAxis((v) => `${(v * 100).toFixed(0)}%`), min: 0, max: 1, name: "predicted" },
    yAxis: { ...valueAxis((v) => `${(v * 100).toFixed(0)}%`), min: 0, max: 1, name: "realized" },
    series: [
      {
        type: "line",
        showSymbol: false,
        silent: true,
        lineStyle: { color: CHART.lineStrong, type: "dashed", width: 1 },
        data: [
          [0, 0],
          [1, 1],
        ],
      },
      {
        type: "scatter",
        data: bins.map((b) => ({ value: [b.predicted, b.realized], count: b.count })),
        symbolSize: (val: any, p: any) => 8 + Math.min(22, p.data.count ?? 0),
        itemStyle: { color: CHART.cyan, opacity: 0.8, borderColor: CHART.base, borderWidth: 1 },
      },
    ],
  } satisfies EChartsOption;
}

export function waterfallOption(
  steps: Array<{ label: string; delta: number }>,
  fmt: (v: number) => string,
): EChartsOption {
  let running = 0;
  const base: number[] = [];
  const pos: Array<number | string> = [];
  const neg: Array<number | string> = [];
  const totalIdx = steps.length - 1;
  steps.forEach((s, i) => {
    if (i === 0 || i === totalIdx) {
      base.push(0);
      pos.push(i === totalIdx ? s.delta : s.delta >= 0 ? s.delta : 0);
      neg.push(i === totalIdx ? 0 : s.delta < 0 ? -s.delta : 0);
      if (i === 0) running = s.delta;
    } else {
      if (s.delta >= 0) {
        base.push(running);
        pos.push(s.delta);
        neg.push("-");
      } else {
        base.push(running + s.delta);
        pos.push("-");
        neg.push(-s.delta);
      }
      running += s.delta;
    }
  });
  return {
    animation: false,
    grid: { ...baseGrid, bottom: 4 },
    tooltip: { ...baseTooltip, trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: {
      type: "category",
      data: steps.map((s) => s.label),
      axisLine: { lineStyle: { color: CHART.line } },
      axisTick: { show: false },
      axisLabel: { ...axisLabel, interval: 0, hideOverlap: true },
    },
    yAxis: valueAxis(fmt),
    series: [
      { type: "bar", stack: "wf", itemStyle: { color: "transparent" }, data: base, silent: true },
      { type: "bar", stack: "wf", itemStyle: { color: CHART.up, opacity: 0.85 }, data: pos, barWidth: "55%" },
      { type: "bar", stack: "wf", itemStyle: { color: CHART.down, opacity: 0.85 }, data: neg, barWidth: "55%" },
    ],
  } satisfies EChartsOption;
}
