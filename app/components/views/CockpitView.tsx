"use client";

import * as React from "react";
import type { DashboardSnapshot } from "@/lib/types";
import { ViewScroll, Grid, GridPanel } from "./_layout";
import { ResizableGroup, ResizablePane, ResizeHandle } from "@/components/ui/resizable";
import { Empty } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { fmtCents, fmtClock, ageTone } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";
import { useDashboardStore } from "@/store/dashboard-store";

import { Ladder, type Side } from "./LadderView";
import { HedgeMap, pairByStrike, enrich } from "./PositionsView";
import { CandidateTable } from "./EdgeView";
import { buildEvents, KIND_META, type TapeEvent } from "./TapeView";
import { CandleChartPanel } from "./CandlesView";
import { OrderEntryView } from "./OrderEntryView";

const VENUE_ACCENT = { kalshi: "var(--color-kalshi)", polymarket: "var(--color-poly)" } as const;

/**
 * The unified live trading cockpit — a composed multi-panel workspace that reuses the existing
 * view panels (chart, DOM ladders, edge blotter, live tape, hedge map, order ticket) so the
 * trader sees price, book, flow, positions, opportunity, and the preview ticket without tab-hopping.
 * Pure composition of read-only panels; no trading logic.
 */
export function CockpitView({ snap }: { snap: DashboardSnapshot }) {
  const now = useNow(1000);
  const staleMs = snap.health.staleBookMs;
  const reducedMotion = useDashboardStore((s) => s.reducedMotion);
  const selectedStrike = useDashboardStore((s) => s.selectedStrike);
  const setSelectedStrike = useDashboardStore((s) => s.setSelectedStrike);
  const [side, setSide] = React.useState<Side>("yes");
  const [selectedCand, setSelectedCand] = React.useState<string | null>(null);

  const strikes = React.useMemo(
    () =>
      Array.from(
        new Set([...(snap.books.kalshi ?? []), ...(snap.books.polymarket ?? [])].map((c) => c.strike)),
      ).sort((a, b) => a - b),
    [snap.books.kalshi, snap.books.polymarket],
  );
  const sel =
    selectedStrike != null && strikes.includes(selectedStrike)
      ? selectedStrike
      : strikes[Math.floor(strikes.length / 2)] ?? null;
  const kc = snap.books.kalshi.find((c) => c.strike === sel) ?? null;
  const pc = snap.books.polymarket.find((c) => c.strike === sel) ?? null;

  const pairs = React.useMemo(
    () =>
      pairByStrike([
        ...enrich(snap.tradingActivity?.kalshi.positions, "kalshi"),
        ...enrich(snap.tradingActivity?.polymarket.positions, "polymarket"),
      ]),
    [snap.tradingActivity],
  );

  const candidates = snap.syntheticStructures ?? [];
  const threshold = snap.health.minProfitDollars;
  const events = React.useMemo(() => buildEvents(snap).slice(0, 16), [snap]);

  return (
    <ViewScroll>
      {/* Strike + side context bar — drives the DOM ladders (shared selectedStrike). */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-muted">BTC Strike</span>
        <div className="flex flex-wrap gap-1">
          {strikes.length ? (
            strikes.map((s) => (
              <button
                key={s}
                onClick={() => setSelectedStrike(s)}
                className={cn(
                  "rounded-sm border px-2 py-1 font-mono text-[11px] tabular-nums transition-colors",
                  s === sel
                    ? "border-cyan/40 bg-cyan/10 text-fg"
                    : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg-secondary",
                )}
              >
                {s.toLocaleString()}
              </button>
            ))
          ) : (
            <span className="font-mono text-[11px] text-fg-faint">no live strikes</span>
          )}
        </div>
        <div className="ml-auto inline-flex h-[28px] overflow-hidden rounded-sm border border-line">
          {(["yes", "no"] as Side[]).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={cn(
                "px-3 font-mono text-[11px] uppercase tracking-wide transition-colors",
                side === s ? "bg-surface-3 text-fg" : "bg-surface text-fg-muted hover:text-fg-secondary",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Row 1 — price chart + opportunity blotter (drag the divider to resize) */}
      <div className="hidden h-[400px] lg:block">
        <ResizableGroup direction="horizontal" autoSaveId="cockpit-row1">
          <ResizablePane defaultSize={64} minSize={38}>
            <CandleChartPanel fill showTiles={false} />
          </ResizablePane>
          <ResizeHandle />
          <ResizablePane defaultSize={36} minSize={22}>
            <GridPanel
              title="Edge / Opportunity"
              className="h-full"
              dot={candidates.length ? "live" : "idle"}
              right={<span className="font-mono text-[10px] text-fg-faint">{candidates.length} structures</span>}
              bodyClassName="overflow-auto p-0"
            >
              <CandidateTable candidates={candidates} threshold={threshold} selected={selectedCand} onSelect={setSelectedCand} />
            </GridPanel>
          </ResizablePane>
        </ResizableGroup>
      </div>

      {/* Row 2 — cross-venue DOM ladders + live tape (resizable) */}
      <div className="hidden h-[420px] lg:block">
        <ResizableGroup direction="horizontal" autoSaveId="cockpit-row2">
          <ResizablePane defaultSize={26} minSize={16}>
            <GridPanel
              title="Kalshi · DOM"
              className="h-full"
              dot={kc ? ageTone(now - kc.updatedAt, staleMs) : "idle"}
              accent={VENUE_ACCENT.kalshi}
              bodyClassName="overflow-auto p-0"
            >
              {kc ? <Ladder contract={kc} side={side} flashEnabled={!reducedMotion} /> : <Empty>No Kalshi book</Empty>}
            </GridPanel>
          </ResizablePane>
          <ResizeHandle />
          <ResizablePane defaultSize={26} minSize={16}>
            <GridPanel
              title="Polymarket · DOM"
              className="h-full"
              dot={pc ? ageTone(now - pc.updatedAt, staleMs) : "idle"}
              accent={VENUE_ACCENT.polymarket}
              bodyClassName="overflow-auto p-0"
            >
              {pc ? <Ladder contract={pc} side={side} flashEnabled={!reducedMotion} /> : <Empty>No Polymarket book</Empty>}
            </GridPanel>
          </ResizablePane>
          <ResizeHandle />
          <ResizablePane defaultSize={48} minSize={24}>
            <GridPanel title="Live Strategy Tape" className="h-full" dot="live" pulse bodyClassName="overflow-auto p-0">
              <CockpitTape events={events} />
            </GridPanel>
          </ResizablePane>
        </ResizableGroup>
      </div>

      {/* Rows 1+2 stacked (no drag) on small screens where side-by-side panes don't fit. */}
      <div className="flex flex-col gap-3 lg:hidden">
        <CandleChartPanel chartHeight={280} showTiles={false} />
        <GridPanel title="Edge / Opportunity" dot={candidates.length ? "live" : "idle"} span={12} bodyClassName="p-0">
          <CandidateTable candidates={candidates} threshold={threshold} selected={selectedCand} onSelect={setSelectedCand} />
        </GridPanel>
        <GridPanel title="Kalshi · DOM" accent={VENUE_ACCENT.kalshi} span={12} bodyClassName="p-0">
          {kc ? <Ladder contract={kc} side={side} flashEnabled={!reducedMotion} /> : <Empty>No Kalshi book</Empty>}
        </GridPanel>
        <GridPanel title="Polymarket · DOM" accent={VENUE_ACCENT.polymarket} span={12} bodyClassName="p-0">
          {pc ? <Ladder contract={pc} side={side} flashEnabled={!reducedMotion} /> : <Empty>No Polymarket book</Empty>}
        </GridPanel>
        <GridPanel title="Live Strategy Tape" dot="live" pulse span={12} bodyClassName="p-0">
          <CockpitTape events={events} />
        </GridPanel>
      </div>

      {/* Row 3 — positions / hedge map */}
      <Grid>
        <GridPanel
          title="Positions · Cross-Venue Hedge Map"
          dot="info"
          span={12}
          right={<span className="font-mono text-[10px] text-fg-faint">observed pairing · dashboard inference</span>}
          bodyClassName="p-0"
        >
          {pairs.length ? <HedgeMap pairs={pairs} /> : <Empty>No open positions</Empty>}
        </GridPanel>
      </Grid>

      {/* Row 4 — preview order ticket (full width so its two-column layout renders cleanly) */}
      <div className="h-[440px] overflow-hidden rounded-md border border-line">
        <OrderEntryView snap={snap} />
      </div>
    </ViewScroll>
  );
}

/** Compact live tape for the cockpit — newest events, colour-coded by kind. */
function CockpitTape({ events }: { events: TapeEvent[] }) {
  if (!events.length) return <Empty>No recent events</Empty>;
  return (
    <div className="max-h-[260px] overflow-auto">
      <table className="w-full min-w-[360px] border-collapse text-[11px]">
        <tbody className="font-mono tabular-nums">
          {events.map((e) => {
            const meta = KIND_META[e.kind];
            return (
              <tr
                key={e.key}
                className="border-b border-line/30 hover:bg-surface-2/40"
                style={{ boxShadow: `inset 2px 0 0 ${meta.accent}` }}
              >
                <td className="whitespace-nowrap px-2.5 py-1.5 text-fg-muted">{e.t ? fmtClock(e.t) : "—"}</td>
                <td className="px-2 py-1.5">
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                </td>
                <td className="px-2 py-1.5 text-fg-secondary">
                  {e.lower && e.higher ? (
                    <span>
                      <span className="text-fg">{e.lower.strike.toLocaleString()}</span>
                      <span className="text-fg-faint"> · </span>
                      <span className="text-fg">{e.higher.strike.toLocaleString()}</span>
                    </span>
                  ) : (
                    <span className="text-fg-faint">{e.pairKey ?? "system"}</span>
                  )}
                </td>
                <td
                  className={cn(
                    "px-2.5 py-1.5 text-right",
                    (e.edge ?? 0) > 0 ? "text-up" : (e.edge ?? 0) < 0 ? "text-down" : "text-fg-faint",
                  )}
                >
                  {e.edge != null ? fmtCents(e.edge, true) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
