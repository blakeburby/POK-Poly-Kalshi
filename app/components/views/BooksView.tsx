"use client";

import * as React from "react";
import type { DashboardSnapshot, BinaryContract, BookLevel, Venue } from "@/lib/types";
import { ViewScroll, Grid, GridPanel } from "./_layout";
import { EChart } from "@/components/charts/echart";
import { depthOption } from "@/components/charts/options";
import { LiquidityHeatmap } from "./LiquidityHeatmap";
import { Empty, StatusDot } from "@/components/ui/stat";
import { fmtCents, fmtMs, ageTone } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";
import { useDashboardStore } from "@/store/dashboard-store";

function cumulative(levels: BookLevel[] | undefined): Array<[number, number]> {
  if (!levels?.length) return [];
  let run = 0;
  return [...levels]
    .sort((a, b) => a.price - b.price)
    .map((l) => {
      run += l.size;
      return [l.price, run] as [number, number];
    });
}

export function BooksView({ snap }: { snap: DashboardSnapshot }) {
  const now = useNow(1000);
  const staleMs = snap.health.staleBookMs;
  const selectedStrike = useDashboardStore((s) => s.selectedStrike);
  const setSelectedStrike = useDashboardStore((s) => s.setSelectedStrike);

  const allStrikes = Array.from(
    new Set([...(snap.books.kalshi ?? []), ...(snap.books.polymarket ?? [])].map((c) => c.strike)),
  ).sort((a, b) => a - b);
  const sel =
    selectedStrike != null && allStrikes.includes(selectedStrike)
      ? selectedStrike
      : allStrikes[Math.floor(allStrikes.length / 2)] ?? null;

  const kc = snap.books.kalshi.find((c) => c.strike === sel);
  const pc = snap.books.polymarket.find((c) => c.strike === sel);
  const kDepth = cumulative(kc?.yesAskLevels);
  const pDepth = cumulative(pc?.yesAskLevels);

  return (
    <ViewScroll>
      <Grid>
        <GridPanel title="Kalshi · Order Book" dot="info" accent="var(--color-kalshi)" span={4} bodyClassName="p-0">
          <BookTable
            contracts={snap.books.kalshi}
            venue="kalshi"
            now={now}
            staleMs={staleMs}
            sel={sel}
            onSel={setSelectedStrike}
          />
        </GridPanel>
        <GridPanel title="Polymarket · Order Book" dot="info" accent="var(--color-poly)" span={4} bodyClassName="p-0">
          <BookTable
            contracts={snap.books.polymarket}
            venue="polymarket"
            now={now}
            staleMs={staleMs}
            sel={sel}
            onSel={setSelectedStrike}
          />
        </GridPanel>
        <GridPanel
          title={`Cross-Venue Depth · ${sel != null ? `BTC ${sel.toLocaleString()}` : "—"} (YES ask)`}
          dot="live"
          span={4}
          bodyClassName="h-[360px] p-2"
        >
          {kDepth.length || pDepth.length ? (
            <EChart option={depthOption(kDepth, pDepth)} />
          ) : (
            <Empty>Select a strike with depth</Empty>
          )}
        </GridPanel>
      </Grid>

      <GridPanel title="Cross-Venue Same-Expiry Comparison" dot="info" span={12} bodyClassName="p-0">
        <CompareTable snap={snap} now={now} staleMs={staleMs} />
      </GridPanel>

      <GridPanel
        title={`Liquidity Heatmap · ${sel != null ? `BTC ${sel.toLocaleString()}` : "—"} (YES book)`}
        dot="live"
        pulse
        span={12}
        bodyClassName="h-[300px] p-2"
      >
        <LiquidityHeatmap kalshi={kc ?? null} polymarket={pc ?? null} />
      </GridPanel>

      <Grid>
        <GridPanel title="Book Apply Latency" dot="info" span={6} bodyClassName="flex flex-col gap-2.5">
          <LatRow label="Kalshi book" v={snap.latency?.books.kalshi} />
          <LatRow label="Polymarket book" v={snap.latency?.books.polymarket} />
          <LatRow label="WS→apply · Kalshi" v={snap.latency?.wsToBookApplyMs.kalshi} />
          <LatRow label="WS→apply · Polymarket" v={snap.latency?.wsToBookApplyMs.polymarket} />
        </GridPanel>
        <GridPanel title="Book Freshness" dot="info" span={6} bodyClassName="flex flex-col justify-center gap-3">
          <FreshSummary contracts={snap.books.kalshi} label="Kalshi" now={now} staleMs={staleMs} accent="kalshi" />
          <FreshSummary
            contracts={snap.books.polymarket}
            label="Polymarket"
            now={now}
            staleMs={staleMs}
            accent="poly"
          />
          <div className="flex items-center justify-between border-t border-line/60 pt-2.5 font-mono text-[10px] uppercase tracking-wide text-fg-muted">
            <span>Stale threshold</span>
            <span className="tabular-nums text-fg-secondary">{fmtMs(staleMs)}</span>
          </div>
        </GridPanel>
      </Grid>
    </ViewScroll>
  );
}

function BookTable({
  contracts,
  venue,
  now,
  staleMs,
  sel,
  onSel,
}: {
  contracts: BinaryContract[];
  venue: Venue;
  now: number;
  staleMs: number;
  sel: number | null;
  onSel: (s: number) => void;
}) {
  const rows = [...contracts].sort((a, b) => a.strike - b.strike);
  if (!rows.length) return <Empty>No {venue} contracts</Empty>;
  return (
    <div className="max-h-[330px] overflow-auto">
      <table className="w-full min-w-[360px] border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
          <tr className="border-b border-line">
            <Th>Strike</Th>
            <Th right>Y-Bid</Th>
            <Th right>Y-Ask</Th>
            <Th right>N-Bid</Th>
            <Th right>N-Ask</Th>
            <Th right>Age</Th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {rows.map((c) => {
            const age = now - c.updatedAt;
            const tone = ageTone(age, staleMs);
            return (
              <tr
                key={c.contractId}
                onClick={() => onSel(c.strike)}
                className={cn(
                  "cursor-pointer border-b border-line/40 transition-colors hover:bg-surface-2/50",
                  sel === c.strike && "bg-cyan/5 ring-1 ring-inset ring-cyan/20",
                  tone !== "live" && "opacity-70",
                )}
              >
                <td className="px-2.5 py-1.5 text-fg">{c.strike.toLocaleString()}</td>
                <td className="px-2.5 py-1.5 text-right text-fg-muted">{fmtCents(c.yesBid)}</td>
                <td className="px-2.5 py-1.5 text-right text-fg">{fmtCents(c.yesAsk)}</td>
                <td className="px-2.5 py-1.5 text-right text-fg-muted">{fmtCents(c.noBid)}</td>
                <td className="px-2.5 py-1.5 text-right text-fg">{fmtCents(c.noAsk)}</td>
                <td className="px-2.5 py-1.5 text-right">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone={tone} className="size-1" />
                    <span className="text-fg-muted">{fmtMs(age)}</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CompareTable({ snap, now, staleMs }: { snap: DashboardSnapshot; now: number; staleMs: number }) {
  const strikes = Array.from(
    new Set([...(snap.books.kalshi ?? []), ...(snap.books.polymarket ?? [])].map((c) => c.strike)),
  ).sort((a, b) => a - b);
  if (!strikes.length) return <Empty />;
  return (
    <div className="max-h-[300px] overflow-auto">
      <table className="w-full min-w-[680px] border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
          <tr className="border-b border-line">
            <Th>Strike</Th>
            <Th right>K · YES Ask</Th>
            <Th right>P · YES Ask</Th>
            <Th right>Δ YES</Th>
            <Th right>K · NO Ask</Th>
            <Th right>P · NO Ask</Th>
            <Th right>Synth Premium</Th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {strikes.map((s) => {
            const k = snap.books.kalshi.find((c) => c.strike === s);
            const p = snap.books.polymarket.find((c) => c.strike === s);
            const dy = k?.yesAsk != null && p?.yesAsk != null ? k.yesAsk - p.yesAsk : null;
            // illustrative synthetic premium: cheapest YES + cheapest cross NO
            const synth = k?.yesAsk != null && p?.noAsk != null ? k.yesAsk + p.noAsk : null;
            return (
              <tr key={s} className="border-b border-line/40 hover:bg-surface-2/40">
                <td className="px-3 py-1.5 text-fg">{s.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right text-kalshi">{fmtCents(k?.yesAsk ?? null)}</td>
                <td className="px-3 py-1.5 text-right text-poly">{fmtCents(p?.yesAsk ?? null)}</td>
                <td
                  className={cn(
                    "px-3 py-1.5 text-right",
                    (dy ?? 0) > 0 ? "text-down" : (dy ?? 0) < 0 ? "text-up" : "text-fg-muted",
                  )}
                >
                  {dy != null ? fmtCents(dy, true) : "–"}
                </td>
                <td className="px-3 py-1.5 text-right text-kalshi">{fmtCents(k?.noAsk ?? null)}</td>
                <td className="px-3 py-1.5 text-right text-poly">{fmtCents(p?.noAsk ?? null)}</td>
                <td className={cn("px-3 py-1.5 text-right", (synth ?? 1) < 1 ? "text-up" : "text-fg-secondary")}>
                  {synth != null ? fmtCents(synth) : "–"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FreshSummary({
  contracts,
  label,
  now,
  staleMs,
  accent,
}: {
  contracts: BinaryContract[];
  label: string;
  now: number;
  staleMs: number;
  accent: "kalshi" | "poly";
}) {
  const total = contracts.length;
  const live = contracts.filter((c) => now - c.updatedAt <= staleMs).length;
  const pct = total ? live / total : 0;
  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", accent === "kalshi" ? "bg-kalshi" : "bg-poly")} />
          <span className="text-[11px] text-fg-secondary">{label}</span>
        </div>
        <span className="font-mono text-[11px] tabular-nums text-fg">
          {live}/{total} fresh
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className={cn("h-full rounded-full", pct >= 0.8 ? "bg-up" : pct >= 0.5 ? "bg-amber" : "bg-down")}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

function LatRow({
  label,
  v,
}: {
  label: string;
  v?: { p50Ms: number | null; p95Ms: number | null; latestMs: number | null };
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-fg-secondary">{label}</span>
      <span className="font-mono text-[11px] tabular-nums text-fg">
        {fmtMs(v?.latestMs ?? null)}{" "}
        <span className="text-fg-faint">
          p50 {fmtMs(v?.p50Ms ?? null)} · p95 {fmtMs(v?.p95Ms ?? null)}
        </span>
      </span>
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={cn("px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-wide", right ? "text-right" : "text-left")}
    >
      {children}
    </th>
  );
}
