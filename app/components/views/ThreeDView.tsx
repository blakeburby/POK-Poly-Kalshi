"use client";

import * as React from "react";
import type { DashboardSnapshot } from "@/lib/types";
import { ViewScroll, Grid, GridPanel } from "./_layout";
import { Viz3DPanel } from "@/components/three/Viz3DPanel";
import { autoAxes, type Point3 } from "@/components/three/axes";
import { CHART } from "@/components/charts/echart";
import { isExactPair, orderSize } from "@/lib/selectors";
import { fmtCents, fmtUsd, fmtMs } from "@/lib/format";

export function ThreeDView({ snap }: { snap: DashboardSnapshot }) {
  const size = orderSize(snap);
  const sigs = snap.recentSignals ?? [];
  const threshold = snap.health.minProfitDollars;

  // (1) Edge Surface: premium x guaranteed edge x realized/expected EV
  const edgePts: Point3[] = React.useMemo(() => {
    const live = (snap.syntheticStructures ?? []).filter((c) => c.risk).map((c) => ({
      x: c.premium,
      y: c.guaranteedProfit,
      z: c.risk!.worstCaseProfit,
      color:
        c.risk!.classification === "true_arbitrage"
          ? CHART.up
          : c.risk!.classification === "guaranteed_below_threshold"
            ? CHART.amber
            : CHART.down,
      size: c.executable ? 0.06 : 0.03,
    }));
    const realized = sigs
      .filter((s) => s.action === "filled")
      .map((s) => ({
        x: s.premium,
        y: s.guaranteedProfit,
        z: s.realizedGuaranteedProfit ?? s.expectedExecutableEdge ?? 0,
        color: isExactPair(s) ? CHART.cyan : s.partialFill ? CHART.amber : CHART.down,
        size: 0.045,
      }));
    return [...live, ...realized];
  }, [snap.syntheticStructures, sigs]);
  const edgeAxes = autoAxes(edgePts, {
    x: { label: "Market Premium", fmt: (v) => fmtCents(v) },
    y: { label: "Guaranteed Edge", fmt: (v) => fmtCents(v) },
    z: { label: "Realized EV", fmt: (v) => fmtCents(v, true) },
  });

  // (2) Execution-Quality Map: time x fill delay x realized profit
  const execPts: Point3[] = React.useMemo(
    () =>
      sigs
        .filter((s) => s.action === "filled" && s.executionTimings?.totalMs != null)
        .map((s) => ({
          x: new Date(s.updatedAt).getTime(),
          y: s.executionTimings!.totalMs!,
          z: (s.realizedGuaranteedProfit ?? 0) * size,
          color: isExactPair(s) ? CHART.up : s.partialFill ? CHART.amber : CHART.down,
          size: 0.045,
        })),
    [sigs, size],
  );
  const execAxes = autoAxes(execPts, {
    x: { label: "Time", fmt: (v) => new Date(v).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) },
    y: { label: "Fill Delay", fmt: (v) => fmtMs(v) },
    z: { label: "Realized Profit", fmt: (v) => fmtUsd(v, { sign: true }) },
  });

  // (3) Risk Landscape: time x exposure x drawdown
  const riskPts: Point3[] = React.useMemo(() => {
    const buckets = snap.analytics?.daily.buckets ?? [];
    return buckets.map((b) => {
      const exposure = sigs
        .filter((s) => {
          const t = new Date(s.updatedAt).getTime();
          return t >= b.startMs && t < b.endMs && s.riskQuarantineExposureDollars;
        })
        .reduce((a, s) => a + (s.riskQuarantineExposureDollars ?? 0), 0);
      const dd = b.drawdown * size;
      const sev = exposure > 0 ? CHART.down : dd > 0 ? CHART.amber : CHART.up;
      return { x: b.startMs, y: exposure, z: dd, color: sev, size: 0.06 };
    });
  }, [snap.analytics, sigs, size]);
  const riskAxes = autoAxes(riskPts, {
    x: { label: "Time", fmt: (v) => new Date(v).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" }) },
    y: { label: "Unhedged Exposure", fmt: (v) => fmtUsd(v) },
    z: { label: "Drawdown", fmt: (v) => fmtUsd(v) },
  });

  return (
    <ViewScroll>
      <Grid>
        <GridPanel
          title="Edge Surface · Premium × Guaranteed Edge × Realized EV"
          dot="live"
          span={12}
          bodyClassName="h-[320px] p-0 sm:h-[400px] lg:h-[440px]"
          right={<Legend items={[["arb", CHART.up], ["sub-thr", CHART.amber], ["realized", CHART.cyan], ["prob/fail", CHART.down]]} />}
        >
          <Viz3DPanel
            points={edgePts}
            axes={edgeAxes}
            plane={{ value: threshold, axisMin: edgeAxes.y.min, axisMax: edgeAxes.y.max, label: "threshold" }}
          />
        </GridPanel>
      </Grid>

      <Grid>
        <GridPanel
          title="Execution-Quality Map · Time × Fill Delay × Profit"
          dot="info"
          span={6}
          bodyClassName="h-[300px] p-0 sm:h-[360px] lg:h-[400px]"
          right={<Legend items={[["exact", CHART.up], ["partial", CHART.amber], ["fail", CHART.down]]} />}
        >
          <Viz3DPanel points={execPts} axes={execAxes} />
        </GridPanel>
        <GridPanel
          title="Risk Landscape · Time × Exposure × Drawdown"
          dot="info"
          span={6}
          bodyClassName="h-[300px] p-0 sm:h-[360px] lg:h-[400px]"
          right={<Legend items={[["clean", CHART.up], ["drawdown", CHART.amber], ["unhedged", CHART.down]]} />}
        >
          <Viz3DPanel points={riskPts} axes={riskAxes} />
        </GridPanel>
      </Grid>

      <div className="rounded-md border border-line bg-surface/40 px-3 py-2 font-mono text-[10px] text-fg-muted">
        Drag to orbit · scroll to zoom. Surfaces encode only deterministic, realized data — no simulated distributions.
        The amber plane on the Edge Surface marks the executable threshold ({fmtCents(threshold)} guaranteed edge).
      </div>
    </ViewScroll>
  );
}

function Legend({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="flex items-center gap-2.5 font-mono text-[9px] uppercase tracking-wide text-fg-muted">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1">
          <span className="size-1.5 rounded-full" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}
