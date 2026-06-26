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
import { strikeUniverse, resolveStrike, nearestContract, type NearestContract } from "@/lib/selectors";

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

  // Kalshi and Polymarket keep INDEPENDENT strike grids, so a single shared strike often exists on only
  // one venue. Default to a both-venue strike when one exists, then resolve EACH ladder to its own nearest
  // available book — that way both DOMs stay populated at once (the whole point of the side-by-side view)
  // instead of one going blank. Non-exact matches are labelled "≈ nearest" so the approximation is honest.
  const universe = React.useMemo(() => strikeUniverse(snap), [snap]);
  const strikes = universe.strikes;
  const sel = resolveStrike(selectedStrike, universe);
  const kNear = React.useMemo(() => nearestContract(snap.books.kalshi, sel), [snap.books.kalshi, sel]);
  const pNear = React.useMemo(() => nearestContract(snap.books.polymarket, sel), [snap.books.polymarket, sel]);
  const kc = kNear.contract;
  const pc = pNear.contract;

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
            strikes.map((s) => {
              const onBoth = universe.kalshiStrikes.has(s) && universe.polyStrikes.has(s);
              const only = universe.kalshiStrikes.has(s) ? "K" : "P";
              return (
                <button
                  key={s}
                  onClick={() => setSelectedStrike(s)}
                  title={
                    onBoth
                      ? "Quoted on both venues"
                      : only === "K"
                        ? "Kalshi-only strike — Polymarket shows its nearest book"
                        : "Polymarket-only strike — Kalshi shows its nearest book"
                  }
                  className={cn(
                    "flex items-center gap-1 rounded-sm border px-2 py-1 font-mono text-[11px] tabular-nums transition-colors",
                    s === sel
                      ? "border-cyan/40 bg-cyan/10 text-fg"
                      : onBoth
                        ? "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg-secondary"
                        : "border-dashed border-line/60 bg-surface text-fg-faint hover:text-fg-muted",
                  )}
                >
                  {s.toLocaleString()}
                  {!onBoth ? <span className="text-[8px] text-fg-faint">{only}</span> : null}
                </button>
              );
            })
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
            <CandleChartPanel fill showTiles={false} lockedAsset="BTC" />
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
              <CandidateTable
                candidates={candidates}
                threshold={threshold}
                selected={selectedCand}
                onSelect={setSelectedCand}
              />
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
              right={<DomStrikeTag near={kNear} />}
              className="h-full"
              dot={kc ? ageTone(now - kc.updatedAt, staleMs) : "idle"}
              accent={VENUE_ACCENT.kalshi}
              bodyClassName="overflow-auto p-0"
            >
              {kc ? (
                <Ladder contract={kc} side={side} flashEnabled={!reducedMotion} />
              ) : (
                <Empty>No Kalshi book — no open BTC market</Empty>
              )}
            </GridPanel>
          </ResizablePane>
          <ResizeHandle />
          <ResizablePane defaultSize={26} minSize={16}>
            <GridPanel
              title="Polymarket · DOM"
              right={<DomStrikeTag near={pNear} />}
              className="h-full"
              dot={pc ? ageTone(now - pc.updatedAt, staleMs) : "idle"}
              accent={VENUE_ACCENT.polymarket}
              bodyClassName="overflow-auto p-0"
            >
              {pc ? (
                <Ladder contract={pc} side={side} flashEnabled={!reducedMotion} />
              ) : (
                <Empty>No Polymarket book — no open BTC market</Empty>
              )}
            </GridPanel>
          </ResizablePane>
          <ResizeHandle />
          <ResizablePane defaultSize={48} minSize={24}>
            <GridPanel
              title="Live Strategy Tape"
              className="h-full"
              dot={events.length ? "live" : "idle"}
              pulse={events.length > 0}
              bodyClassName="overflow-auto p-0"
            >
              <CockpitTape events={events} />
            </GridPanel>
          </ResizablePane>
        </ResizableGroup>
      </div>

      {/* Rows 1+2 stacked (no drag) on small screens where side-by-side panes don't fit. */}
      <div className="flex flex-col gap-3 lg:hidden">
        <CandleChartPanel chartHeight={280} showTiles={false} lockedAsset="BTC" />
        <GridPanel title="Edge / Opportunity" dot={candidates.length ? "live" : "idle"} span={12} bodyClassName="p-0">
          <CandidateTable
            candidates={candidates}
            threshold={threshold}
            selected={selectedCand}
            onSelect={setSelectedCand}
          />
        </GridPanel>
        <GridPanel
          title="Kalshi · DOM"
          right={<DomStrikeTag near={kNear} />}
          accent={VENUE_ACCENT.kalshi}
          span={12}
          bodyClassName="p-0"
        >
          {kc ? (
            <Ladder contract={kc} side={side} flashEnabled={!reducedMotion} />
          ) : (
            <Empty>No Kalshi book — no open BTC market</Empty>
          )}
        </GridPanel>
        <GridPanel
          title="Polymarket · DOM"
          right={<DomStrikeTag near={pNear} />}
          accent={VENUE_ACCENT.polymarket}
          span={12}
          bodyClassName="p-0"
        >
          {pc ? (
            <Ladder contract={pc} side={side} flashEnabled={!reducedMotion} />
          ) : (
            <Empty>No Polymarket book — no open BTC market</Empty>
          )}
        </GridPanel>
        <GridPanel
          title="Live Strategy Tape"
          dot={events.length ? "live" : "idle"}
          pulse={events.length > 0}
          span={12}
          bodyClassName="p-0"
        >
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
        <OrderEntryView snap={snap} embedded />
      </div>
    </ViewScroll>
  );
}

/**
 * Per-venue DOM header tag: shows the strike actually being displayed and flags it "≈ nearest" when this
 * venue has no book at the selected strike (its grid differs from the other venue's), so the operator is
 * never misled into reading two different strikes as the same one.
 */
function DomStrikeTag({ near }: { near: NearestContract }) {
  if (!near.contract) return null;
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px]">
      <span className="tabular-nums text-fg-secondary">{near.contract.strike.toLocaleString()}</span>
      {!near.exact ? (
        <span
          title={`Nearest available strike — this venue has no book at the selected strike${
            near.deltaDollars ? ` (off by $${near.deltaDollars.toLocaleString()})` : ""
          }`}
          className="rounded-sm border border-amber/40 bg-amber/10 px-1 py-px text-[8.5px] uppercase tracking-wide text-amber"
        >
          ≈ nearest
        </span>
      ) : null}
    </span>
  );
}

/** Compact live tape for the cockpit — newest events, colour-coded by kind. */
function CockpitTape({ events }: { events: TapeEvent[] }) {
  if (!events.length) return <Empty>No recent events</Empty>;
  return (
    <div className="max-h-[260px] overflow-auto">
      <table className="w-full min-w-[360px] border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
          <tr className="border-b border-line font-mono text-[9px] uppercase tracking-wide">
            <th className="px-2.5 py-1.5 text-left">Time</th>
            <th className="px-2 py-1.5 text-left">Event</th>
            <th className="px-2 py-1.5 text-left">Market</th>
            <th className="px-2.5 py-1.5 text-right">Edge</th>
          </tr>
        </thead>
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
