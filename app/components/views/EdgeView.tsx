"use client";

import * as React from "react";
import type { DashboardSnapshot, ArbCandidate } from "@/lib/types";
import { ViewScroll, Grid, GridPanel, StatTile } from "./_layout";
import { EChart, CHART } from "@/components/charts/echart";
import { scatterOption } from "@/components/charts/options";
import { Empty, MiniBar, StatusDot } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { fmtCents, fmtPct, fmtNum } from "@/lib/format";
import { cn } from "@/lib/utils";

function classOf(c: ArbCandidate): "true_arbitrage" | "guaranteed_below_threshold" | "probabilistic_bet" {
  return c.risk?.classification ?? "probabilistic_bet";
}
function classColor(k: string): string {
  return k === "true_arbitrage" ? CHART.up : k === "guaranteed_below_threshold" ? CHART.amber : CHART.down;
}

export function EdgeView({ snap }: { snap: DashboardSnapshot }) {
  const threshold = snap.health.minProfitDollars;
  const live = snap.liveCandidates ?? [];
  const structures = snap.syntheticStructures ?? [];
  const a = snap.analytics?.daily;
  const [selected, setSelected] = React.useState<string | null>(null);

  const counts = {
    true_arbitrage: structures.filter((c) => classOf(c) === "true_arbitrage").length,
    guaranteed_below_threshold: structures.filter((c) => classOf(c) === "guaranteed_below_threshold").length,
    probabilistic_bet: structures.filter((c) => classOf(c) === "probabilistic_bet").length,
  };

  const scatter = structures
    .filter((c) => c.risk)
    .map((c) => ({
      x: c.premium,
      y: c.guaranteedProfit,
      color: classColor(classOf(c)),
      size: c.executable ? 9 : 6,
      name: `${Math.min(c.lower.strike, c.higher.strike).toLocaleString()}/${Math.max(c.lower.strike, c.higher.strike).toLocaleString()}`,
    }));

  const selectedCand = structures.find((c) => c.pairKey === selected) ?? live[0] ?? structures[0];

  return (
    <ViewScroll>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
        <StatTile label="Live Candidates" value={fmtNum(live.length)} tone="cyan" sub={`scan ${snap.scanner.lastCandidateCount}`} />
        <StatTile label="True Arbitrage" value={fmtNum(counts.true_arbitrage)} tone="up" />
        <StatTile label="Sub-Threshold" value={fmtNum(counts.guaranteed_below_threshold)} tone="amber" />
        <StatTile label="Probabilistic" value={fmtNum(counts.probabilistic_bet)} tone="down" />
        <StatTile label="Min Edge (Thr)" value={fmtCents(threshold)} tone="neutral" />
        <StatTile label="Opportunity / Fill" value={`${fmtNum(a?.opportunityCount ?? 0)} · ${fmtPct(a?.fillRate)}`} tone="neutral" />
      </div>

      <Grid>
        <GridPanel
          title="Edge vs Threshold · Premium → Guaranteed Edge"
          dot="info"
          span={7}
          bodyClassName="h-[300px] p-2"
          right={
            <div className="hidden items-center gap-2.5 font-mono text-[9px] uppercase tracking-wide text-fg-muted sm:flex">
              <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-up" /> arb</span>
              <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-amber" /> sub-thr</span>
              <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-down" /> prob</span>
            </div>
          }
        >
          {scatter.length ? (
            <EChart
              option={scatterOption({
                points: scatter,
                xName: "premium",
                yName: "edge",
                xFmt: (v) => fmtCents(v),
                yFmt: (v) => fmtCents(v, true),
                markLineY: threshold,
              })}
            />
          ) : (
            <Empty>No structures in current scan</Empty>
          )}
        </GridPanel>

        <GridPanel title="Payoff Profile" dot="info" span={5} bodyClassName="flex flex-col gap-3">
          {selectedCand?.risk ? <PayoffProfile cand={selectedCand} /> : <Empty />}
        </GridPanel>
      </Grid>

      <GridPanel title="Live Opportunity Blotter" dot={live.length ? "live" : "idle"} span={12} bodyClassName="p-0">
        <CandidateTable candidates={structures} threshold={threshold} selected={selectedCand?.pairKey ?? null} onSelect={setSelected} />
      </GridPanel>

      <GridPanel title="Polymarket Strike Discovery" dot="info" span={12} bodyClassName="p-0">
        <DiscoveryStrip snap={snap} />
      </GridPanel>
    </ViewScroll>
  );
}

function PayoffProfile({ cand }: { cand: ArbCandidate }) {
  const r = cand.risk!;
  const lo = Math.min(cand.lower.strike, cand.higher.strike);
  const hi = Math.max(cand.lower.strike, cand.higher.strike);
  const maxAbs = Math.max(...r.payoffProfile.map((p) => Math.abs(p.profit)), 0.01);
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] text-fg">BTC {lo.toLocaleString()} / {hi.toLocaleString()}</span>
          <Badge variant={r.classification === "true_arbitrage" ? "up" : r.classification === "guaranteed_below_threshold" ? "amber" : "down"}>
            {r.classification.replace(/_/g, " ")}
          </Badge>
        </div>
        <span className="font-mono text-[11px] tabular-nums text-fg-muted">gap ${r.strikeGap.toLocaleString()}</span>
      </div>
      <div className="flex flex-col gap-2">
        {r.payoffProfile.map((p) => {
          const pos = p.profit >= 0;
          return (
            <div key={p.region} className="flex items-center gap-3">
              <span className="w-28 shrink-0 font-mono text-[10px] text-fg-muted">{p.label}</span>
              <div className="relative h-5 flex-1 overflow-hidden rounded-sm bg-surface-3">
                <div
                  className={cn("absolute top-0 h-full", pos ? "left-1/2 bg-up/60" : "right-1/2 bg-down/60")}
                  style={{ width: `${(Math.abs(p.profit) / maxAbs) * 50}%` }}
                />
                <div className="absolute left-1/2 top-0 h-full w-px bg-line-strong" />
              </div>
              <span className={cn("w-16 shrink-0 text-right font-mono text-[11px] tabular-nums", pos ? "text-up" : "text-down")}>{fmtCents(p.profit, true)}</span>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-line/60 pt-2.5">
        <Mini label="Premium" value={fmtCents(r.premium)} />
        <Mini label="Worst Case" value={fmtCents(r.worstCaseProfit, true)} tone={r.worstCaseProfit >= 0 ? "up" : "down"} />
        <Mini label="Best Case" value={fmtCents(r.bestCaseProfit, true)} tone="up" />
      </div>
    </>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-sm border border-line/60 bg-surface-2/40 px-2 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-wide text-fg-muted">{label}</div>
      <div className={cn("font-mono text-[12px] tabular-nums", tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-fg")}>{value}</div>
    </div>
  );
}

function CandidateTable({
  candidates,
  threshold,
  selected,
  onSelect,
}: {
  candidates: ArbCandidate[];
  threshold: number;
  selected: string | null;
  onSelect: (k: string) => void;
}) {
  if (!candidates.length) return <Empty>No candidates in current scan</Empty>;
  const maxEdge = Math.max(...candidates.map((c) => c.guaranteedProfit), threshold * 2, 0.01);
  return (
    <div className="max-h-[320px] overflow-auto">
      <table className="w-full min-w-[760px] border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
          <tr className="border-b border-line">
            <th className="px-3 py-1.5 text-left font-mono text-[9.5px] uppercase tracking-wide">Strikes</th>
            <th className="px-3 py-1.5 text-left font-mono text-[9.5px] uppercase tracking-wide">Lower Leg</th>
            <th className="px-3 py-1.5 text-left font-mono text-[9.5px] uppercase tracking-wide">Higher Leg</th>
            <th className="px-3 py-1.5 text-right font-mono text-[9.5px] uppercase tracking-wide">Premium</th>
            <th className="px-3 py-1.5 text-right font-mono text-[9.5px] uppercase tracking-wide">Edge</th>
            <th className="px-3 py-1.5 text-right font-mono text-[9.5px] uppercase tracking-wide">vs Thr</th>
            <th className="px-3 py-1.5 text-left font-mono text-[9.5px] uppercase tracking-wide">Status</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {candidates.map((c) => {
            const over = c.guaranteedProfit - threshold;
            const lo = Math.min(c.lower.strike, c.higher.strike);
            const hi = Math.max(c.lower.strike, c.higher.strike);
            return (
              <tr
                key={c.pairKey}
                onClick={() => onSelect(c.pairKey)}
                className={cn(
                  "cursor-pointer border-b border-line/40 transition-colors hover:bg-surface-2/50",
                  selected === c.pairKey && "bg-cyan/5 ring-1 ring-inset ring-cyan/20",
                )}
              >
                <td className="px-3 py-1.5 text-fg">{lo.toLocaleString()}/{hi.toLocaleString()}</td>
                <td className="px-3 py-1.5">
                  <span className={cn("text-[10px]", c.lower.venue === "kalshi" ? "text-kalshi" : "text-poly")}>
                    {c.lower.venue.slice(0, 3)} {c.lower.direction.toUpperCase()} {fmtCents(c.lower.ask)}
                  </span>
                </td>
                <td className="px-3 py-1.5">
                  <span className={cn("text-[10px]", c.higher.venue === "kalshi" ? "text-kalshi" : "text-poly")}>
                    {c.higher.venue.slice(0, 3)} {c.higher.direction.toUpperCase()} {fmtCents(c.higher.ask)}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right text-fg-secondary">{fmtCents(c.premium)}</td>
                <td className="px-3 py-1.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <MiniBar value={c.guaranteedProfit / maxEdge} tone={c.executable ? "live" : "stale"} className="w-10" />
                    <span className="text-up">{fmtCents(c.guaranteedProfit)}</span>
                  </div>
                </td>
                <td className={cn("px-3 py-1.5 text-right", over >= 0 ? "text-up" : "text-down")}>{fmtCents(over, true)}</td>
                <td className="px-3 py-1.5">
                  {c.executable ? (
                    <span className="flex items-center gap-1.5"><StatusDot tone="live" className="size-1.5" /><span className="text-[10px] text-up">EXECUTABLE</span></span>
                  ) : (
                    <span className="text-[10px] text-fg-muted">{c.reason ?? "rejected"}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DiscoveryStrip({ snap }: { snap: DashboardSnapshot }) {
  const d = snap.diagnostics?.polymarket;
  if (!d) return <Empty />;
  const items: Array<[string, string, "up" | "amber" | "down" | "neutral"]> = [
    ["Markets Found", String(d.marketsFound), "neutral"],
    ["Ready Contracts", String(d.readyContracts), "up"],
    ["Pending Strike", String(d.pendingStrikeCount), d.pendingStrikeCount > 0 ? "amber" : "neutral"],
    ["Missing Strike", String(d.missingStrikeCount), d.missingStrikeCount > 0 ? "down" : "neutral"],
    ["Invalid", String(d.invalidMarketCount), d.invalidMarketCount > 0 ? "down" : "neutral"],
  ];
  return (
    <div className="flex flex-wrap items-stretch gap-px">
      {items.map(([k, v, tone]) => (
        <div key={k} className="flex min-w-[130px] flex-1 flex-col gap-1 border-r border-line/60 px-3.5 py-2.5">
          <span className="font-mono text-[9.5px] uppercase tracking-wide text-fg-muted">{k}</span>
          <span className={cn("font-mono text-[16px] tabular-nums", tone === "up" ? "text-up" : tone === "amber" ? "text-amber" : tone === "down" ? "text-down" : "text-fg")}>{v}</span>
        </div>
      ))}
      <div className="flex min-w-[160px] flex-1 flex-col gap-1 px-3.5 py-2.5">
        <span className="font-mono text-[9.5px] uppercase tracking-wide text-fg-muted">Last Chainlink Tick</span>
        <span className="font-mono text-[16px] tabular-nums text-fg">{d.lastChainlinkTickAgeMs != null ? `${Math.round(d.lastChainlinkTickAgeMs / 1000)}s` : "–"}</span>
      </div>
    </div>
  );
}
