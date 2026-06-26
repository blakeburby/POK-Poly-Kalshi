"use client";

import * as React from "react";
import type { DashboardSnapshot } from "@/lib/types";
import { ViewScroll, Grid, GridPanel, StatTile } from "./_layout";
import { EChart } from "@/components/charts/echart";
import { equityAreaOption } from "@/components/charts/options";
import { StatusDot, Empty, MiniBar } from "@/components/ui/stat";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  accountEquity,
  currentCombinedEquity,
  edgeCapture,
  equityPnlOverMs,
  equityRangeChange,
  equitySeriesForRange,
  openPositionCount,
  tradeableNow,
  type EquityRange,
} from "@/lib/selectors";
import type { Venue } from "@/lib/types";
import { fmtUsd, fmtPct, fmtCents, fmtNum, type StatusTone, fmtPctRaw } from "@/lib/format";
import { cn } from "@/lib/utils";

export function OverviewView({ snap }: { snap: DashboardSnapshot }) {
  const a = snap.analytics;
  const exec = snap.execution;
  const cap = edgeCapture(a?.daily, snap);
  const [range, setRange] = React.useState<EquityRange>("24h");

  const now = snap.generatedAt;
  const current = currentCombinedEquity(snap);
  const eq = accountEquity(snap);
  const venueLabel = (v: Venue) => (v === "kalshi" ? "Kalshi" : "Polymarket");
  const combinedSub = eq.missingVenues.length
    ? `${eq.missingVenues.map(venueLabel).join(" + ")} unavailable — partial total`
    : eq.staleVenues.length
      ? `cash + positions · ${eq.staleVenues.map(venueLabel).join(" + ")} last-known`
      : "cash + open positions · both venues";
  const hasHistory = (snap.equityCurve?.points?.length ?? 0) > 1;
  const series = equitySeriesForRange(snap, range, now);
  const change = hasHistory ? equityRangeChange(series) : { absolute: null, percent: null };
  const changeTone: "up" | "down" = (change.absolute ?? 0) >= 0 ? "up" : "down";

  // Venue-truth: change in combined account value over the last 24h (equity-curve delta).
  const day = equityPnlOverMs(snap, 24 * 60 * 60_000, now);
  // Preserve null so an UNMEASURED metric reads "–" + idle, never a fake 0 with a real halt/stale tone (a
  // 0% fill rendered red is indistinguishable from "data unavailable"). Mirrors HealthRail's RailStat.
  const fillRate = a?.daily.fillRate ?? null;
  const exactRate = exec?.executionQuality?.exactPairFillRate ?? null;
  const unhedged = exec?.reconciliation.quarantinedExposureDollars ?? null;
  const candidates = snap.scanner.lastCandidateCount;
  const estEdge = exec?.executionQuality?.estimatedExecutableEdge ?? null;

  const answers: AnswerProps[] = [
    {
      q: "Making money?",
      value: day == null ? "–" : fmtUsd(day, { sign: true }),
      tone: day == null ? "stale" : day >= 0 ? "live" : "halt",
      sub: "24h account P&L",
    },
    {
      q: "Edge working?",
      value: fmtCents(estEdge),
      tone: estEdge == null ? "idle" : estEdge > 0 ? "live" : "stale",
      sub: `${candidates} live candidates`,
    },
    {
      q: "Filling?",
      value: fmtPct(fillRate),
      tone: fillRate == null ? "idle" : fillRate >= 0.6 ? "live" : fillRate >= 0.4 ? "stale" : "halt",
      sub: "filled / opportunities",
    },
    {
      q: "Hedging?",
      value: fmtPct(exactRate),
      tone: exactRate == null ? "idle" : exactRate >= 0.6 ? "live" : exactRate >= 0.4 ? "stale" : "halt",
      sub: "exact-pair fills",
    },
    {
      q: "Capturing edge?",
      value: cap.retention != null ? fmtPctRaw(cap.retention * 100) : "–",
      tone: (cap.retention ?? 0) >= 0.8 ? "live" : "stale",
      sub: "realized / expected",
    },
    {
      q: "Managing risk?",
      value: unhedged == null ? "–" : unhedged > 0 ? fmtUsd(unhedged) : "Clean",
      tone: unhedged == null ? "idle" : unhedged > 0 ? "halt" : "live",
      sub: `risk · ${exec?.riskState ?? "?"}`,
    },
    {
      q: "Healthy to trade?",
      value: tradeableNow(snap) ? "YES" : "NO",
      tone: tradeableNow(snap) ? "live" : "halt",
      sub: exec?.liveTrading ? "armed" : "disabled",
    },
  ];

  return (
    <ViewScroll>
      {/* The 7 questions */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {answers.map((ans) => (
          <AnswerCard key={ans.q} {...ans} />
        ))}
      </div>

      {/* Unified combined-portfolio equity */}
      <div className="grid grid-cols-3 gap-3">
        <StatTile
          label="Combined Value"
          value={fmtUsd(current)}
          tone={eq.missingVenues.length ? "amber" : "cyan"}
          sub={combinedSub}
        />
        <StatTile
          label="Change ($)"
          value={change.absolute != null ? fmtUsd(change.absolute, { sign: true }) : "–"}
          tone={changeTone}
          sub={range.toUpperCase()}
        />
        <StatTile
          label="Change (%)"
          value={change.percent != null ? fmtPctRaw(change.percent * 100, 2, true) : "–"}
          tone={changeTone}
          sub={range.toUpperCase()}
        />
      </div>

      <Grid>
        <GridPanel
          title="Portfolio Equity · Combined (Kalshi + Polymarket)"
          dot="live"
          span={12}
          bodyClassName="h-[320px] flex-none p-2"
          right={
            <Tabs value={range} onValueChange={(v) => setRange(v as EquityRange)}>
              <TabsList className="rounded-md border border-line bg-surface p-0.5">
                <TabsTrigger value="24h">24H</TabsTrigger>
                <TabsTrigger value="7d">7D</TabsTrigger>
                <TabsTrigger value="30d">30D</TabsTrigger>
                <TabsTrigger value="all">All</TabsTrigger>
              </TabsList>
            </Tabs>
          }
        >
          {hasHistory ? (
            <EChart
              option={equityAreaOption(series, { positive: (change.absolute ?? 0) >= 0, fmt: (v) => fmtUsd(v) })}
            />
          ) : (
            <Empty>Equity history is warming up — samples accrue while the dashboard runs.</Empty>
          )}
        </GridPanel>
      </Grid>
      {/* TODO(v2): markPoint overlay for fills/hedges/locks */}

      <Grid>
        <GridPanel title="Open Positions" dot="live" span={7} bodyClassName="p-0">
          <PositionsTable snap={snap} />
        </GridPanel>

        <GridPanel title="Top Live Opportunities" dot={candidates > 0 ? "live" : "idle"} span={5} bodyClassName="p-0">
          <OpportunitiesMini snap={snap} />
        </GridPanel>
      </Grid>
    </ViewScroll>
  );
}

interface AnswerProps {
  q: string;
  value: string;
  tone: StatusTone;
  sub: string;
}

function AnswerCard({ q, value, tone, sub }: AnswerProps) {
  const accent =
    tone === "live" ? "text-up" : tone === "halt" ? "text-down" : tone === "stale" ? "text-amber" : "text-fg";
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border bg-surface px-3 py-2.5",
        tone === "halt" ? "border-down/30" : tone === "stale" ? "border-amber/25" : "border-line",
      )}
    >
      <div className="flex items-center gap-1.5">
        <StatusDot tone={tone} pulse={tone === "live"} className="size-1.5" />
        <span className="text-[11px] font-medium text-fg-secondary">{q}</span>
      </div>
      <span className={cn("font-mono text-[19px] tabular-nums leading-none", accent)}>{value}</span>
      <span className="font-mono text-[9.5px] uppercase tracking-wide text-fg-muted">{sub}</span>
    </div>
  );
}

function PositionsTable({ snap }: { snap: DashboardSnapshot }) {
  const rows = [
    ...(snap.tradingActivity?.kalshi.positions.map((p) => ({ ...p, venue: "kalshi" as const })) ?? []),
    ...(snap.tradingActivity?.polymarket.positions.map((p) => ({ ...p, venue: "polymarket" as const })) ?? []),
  ].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  if (!rows.length) return <Empty>No open positions</Empty>;
  const maxVal = Math.max(...rows.map((r) => r.value ?? 0), 1);
  return (
    <div className="max-h-[260px] overflow-auto">
      <table className="w-full min-w-[460px] border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
          <tr className="border-b border-line">
            <Th className="text-left">Venue</Th>
            <Th className="text-left">Market</Th>
            <Th className="text-right">Shares</Th>
            <Th className="text-right">Avg ¢</Th>
            <Th className="text-right">Value</Th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {rows.map((r) => (
            <tr key={`${r.venue}-${r.id}`} className="border-b border-line/40 hover:bg-surface-2/40">
              <Td>
                <span
                  className={cn("size-1.5 rounded-full", r.venue === "kalshi" ? "bg-kalshi" : "bg-poly")}
                  style={{ display: "inline-block" }}
                />
              </Td>
              <Td className="max-w-[220px] truncate text-fg-secondary">{r.market}</Td>
              <Td className="text-right text-fg">{fmtNum(r.shares)}</Td>
              <Td className="text-right text-fg-secondary">
                {r.averagePrice != null ? (r.averagePrice * 100).toFixed(1) : "–"}
              </Td>
              <Td className="text-right text-fg">
                <div className="flex items-center justify-end gap-2">
                  <MiniBar value={(r.value ?? 0) / maxVal} tone="info" className="w-12" />
                  {fmtUsd(r.value)}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpportunitiesMini({ snap }: { snap: DashboardSnapshot }) {
  const rows = (snap.liveCandidates ?? []).slice(0, 8);
  if (!rows.length) return <Empty>No executable candidates right now</Empty>;
  const maxEdge = Math.max(...rows.map((r) => r.guaranteedProfit), snap.health.minProfitDollars * 2, 0.01);
  return (
    <div className="max-h-[260px] overflow-auto">
      <table className="w-full min-w-[460px] border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
          <tr className="border-b border-line">
            <Th className="text-left">Pair</Th>
            <Th className="text-right">Premium</Th>
            <Th className="text-right">Edge</Th>
            <Th className="text-right">vs Thr</Th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {rows.map((c) => {
            const over = c.guaranteedProfit - c.threshold;
            return (
              <tr key={c.pairKey} className="border-b border-line/40 hover:bg-surface-2/40">
                <Td className="text-fg-secondary">
                  {Math.min(c.lower.strike, c.higher.strike).toLocaleString()}/
                  {Math.max(c.lower.strike, c.higher.strike).toLocaleString()}
                </Td>
                <Td className="text-right text-fg-secondary">{fmtCents(c.premium)}</Td>
                <Td className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <MiniBar value={c.guaranteedProfit / maxEdge} tone="live" className="w-10" />
                    <span
                      className={
                        c.guaranteedProfit > 0 ? "text-up" : c.guaranteedProfit < 0 ? "text-down" : "text-fg-secondary"
                      }
                    >
                      {fmtCents(c.guaranteedProfit)}
                    </span>
                  </div>
                </Td>
                <Td className={cn("text-right", over >= 0 ? "text-up" : "text-down")}>{fmtCents(over, true)}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cn("px-3 py-1.5 font-mono text-[9.5px] font-medium uppercase tracking-wide", className)}>
      {children}
    </th>
  );
}
function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cn("px-3 py-1.5", className)}>{children}</td>;
}
