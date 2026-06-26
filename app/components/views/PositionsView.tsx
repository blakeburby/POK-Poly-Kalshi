"use client";

import * as React from "react";
import type { DashboardSnapshot, TradingPosition, TradingPlatform, TradingOpenOrder } from "@/lib/types";
import { ViewScroll, Grid, GridPanel, StatTile } from "./_layout";
import { Empty, StatusDot, Label } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { fmtUsd, fmtInt, fmtCents, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";

/** Positions older than this are flagged stale on the dashboard (observational only). */
const POSITION_STALE_MS = 120_000;

type Side = "YES" | "NO";

export interface EnrichedPos extends TradingPosition {
  venue: TradingPlatform;
  strike: number | null;
  side: Side | null;
}

export interface StrikePairing {
  strike: number;
  kShares: number;
  pShares: number;
  kVal: number;
  pVal: number;
  matched: number;
  residual: number;
  residualVenue: TradingPlatform | null;
}

function parseStrike(market: string): number | null {
  const m = market.match(/(\d[\d,]{3,})/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function sideOf(p: TradingPosition): Side | null {
  const o = (p.outcome || "").toLowerCase();
  if (o.startsWith("y")) return "YES";
  if (o.startsWith("n")) return "NO";
  if (/\byes\b/i.test(p.market)) return "YES";
  if (/\bno\b/i.test(p.market)) return "NO";
  return null;
}

export function enrich(positions: TradingPosition[] | undefined, venue: TradingPlatform): EnrichedPos[] {
  return (positions ?? []).map((p) => ({ ...p, venue, strike: parseStrike(p.market), side: sideOf(p) }));
}

/** Observed cross-venue hedge pairing, by strike. The matched leg (min of the two venues' share
 *  counts at a strike) is treated as hedged; the excess on the heavier venue is the naked residual.
 *  This is a dashboard inference for visibility — not the engine's authoritative hedge state. */
export function pairByStrike(all: EnrichedPos[]): StrikePairing[] {
  const map = new Map<number, StrikePairing>();
  for (const pos of all) {
    if (pos.strike == null) continue;
    let row = map.get(pos.strike);
    if (!row) {
      row = {
        strike: pos.strike,
        kShares: 0,
        pShares: 0,
        kVal: 0,
        pVal: 0,
        matched: 0,
        residual: 0,
        residualVenue: null,
      };
      map.set(pos.strike, row);
    }
    if (pos.venue === "kalshi") {
      row.kShares += pos.shares;
      row.kVal += pos.value ?? 0;
    } else {
      row.pShares += pos.shares;
      row.pVal += pos.value ?? 0;
    }
  }
  for (const row of map.values()) {
    row.matched = Math.min(row.kShares, row.pShares);
    row.residual = Math.abs(row.kShares - row.pShares);
    row.residualVenue = row.residual === 0 ? null : row.kShares > row.pShares ? "kalshi" : "polymarket";
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike);
}

export function PositionsView({ snap }: { snap: DashboardSnapshot }) {
  const now = useNow(1000);
  const kPos = React.useMemo(
    () => enrich(snap.tradingActivity?.kalshi.positions, "kalshi"),
    [snap.tradingActivity?.kalshi.positions],
  );
  const pPos = React.useMemo(
    () => enrich(snap.tradingActivity?.polymarket.positions, "polymarket"),
    [snap.tradingActivity?.polymarket.positions],
  );
  const all = React.useMemo(() => [...kPos, ...pPos], [kPos, pPos]);
  const pairs = React.useMemo(() => pairByStrike(all), [all]);

  const grossValue = all.reduce((s, p) => s + (p.value ?? 0), 0);
  const hedgedStrikes = pairs.filter((r) => r.matched > 0).length;
  const nakedStrikes = pairs.filter((r) => r.residual > 0);
  const nakedShares = nakedStrikes.reduce((s, r) => s + r.residual, 0);
  const residualByStrike = React.useMemo(() => new Map(pairs.map((r) => [r.strike, r] as const)), [pairs]);

  if (!all.length) {
    return (
      <ViewScroll>
        <GridPanel title="Open Positions" span={12}>
          <Empty>No open positions</Empty>
        </GridPanel>
      </ViewScroll>
    );
  }

  return (
    <ViewScroll>
      <Grid>
        <StatTile
          className="col-span-6 sm:col-span-3 xl:col-span-2"
          label="Open Positions"
          value={fmtInt(all.length)}
          sub={`${kPos.length} K · ${pPos.length} P`}
        />
        <StatTile
          className="col-span-6 sm:col-span-3 xl:col-span-2"
          label="Gross Value"
          value={fmtUsd(grossValue)}
          tone="cyan"
        />
        <StatTile
          className="col-span-6 sm:col-span-3 xl:col-span-2"
          label="Hedged Strikes"
          value={`${hedgedStrikes}/${pairs.length}`}
          tone={hedgedStrikes === pairs.length ? "up" : "neutral"}
          sub="cross-venue matched"
        />
        <StatTile
          className="col-span-6 sm:col-span-3 xl:col-span-2"
          label="Naked Residual"
          value={nakedShares > 0 ? fmtInt(nakedShares) : "Clean"}
          tone={nakedShares > 0 ? "amber" : "up"}
          sub={
            nakedShares > 0 ? `${nakedStrikes.length} strike${nakedStrikes.length === 1 ? "" : "s"}` : "fully paired"
          }
        />
      </Grid>

      <GridPanel
        title="Cross-Venue Hedge Map · by strike"
        dot="info"
        span={12}
        right={
          <span className="hidden font-mono text-[10px] text-fg-faint sm:inline">
            observed pairing — min(K,P) hedged · excess = naked
          </span>
        }
        bodyClassName="p-0"
      >
        <HedgeMap pairs={pairs} />
      </GridPanel>

      <Grid>
        <GridPanel title="Kalshi · Positions" dot="info" accent="var(--color-kalshi)" span={6} bodyClassName="p-0">
          <PositionTable positions={kPos} now={now} residualByStrike={residualByStrike} />
        </GridPanel>
        <GridPanel title="Polymarket · Positions" dot="info" accent="var(--color-poly)" span={6} bodyClassName="p-0">
          <PositionTable positions={pPos} now={now} residualByStrike={residualByStrike} />
        </GridPanel>
      </Grid>

      <OpenOrdersPanel snap={snap} now={now} />
    </ViewScroll>
  );
}

export function HedgeMap({ pairs }: { pairs: StrikePairing[] }) {
  if (!pairs.length) return <Empty>No strikes to pair</Empty>;
  const maxShares = Math.max(1, ...pairs.map((r) => Math.max(r.kShares, r.pShares)));
  return (
    <div className="max-h-[280px] overflow-auto">
      <table className="w-full min-w-[640px] border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
          <tr className="border-b border-line">
            <Th>Strike</Th>
            <Th right>Kalshi sh</Th>
            <Th right>Poly sh</Th>
            <Th>Balance</Th>
            <Th right>Matched</Th>
            <Th right>Residual</Th>
            <Th right>Status</Th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {pairs.map((r) => {
            const kPct = (r.kShares / maxShares) * 100;
            const pPct = (r.pShares / maxShares) * 100;
            return (
              <tr key={r.strike} className="border-b border-line/40 hover:bg-surface-2/40">
                <td className="px-3 py-1.5 text-fg">{r.strike.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right text-kalshi">{fmtInt(r.kShares)}</td>
                <td className="px-3 py-1.5 text-right text-poly">{fmtInt(r.pShares)}</td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-1">
                    <div className="flex h-1.5 flex-1 justify-end overflow-hidden rounded-l-full bg-surface-3">
                      <div className="h-full rounded-l-full bg-kalshi/70" style={{ width: `${kPct}%` }} />
                    </div>
                    <div className="flex h-1.5 flex-1 overflow-hidden rounded-r-full bg-surface-3">
                      <div className="h-full rounded-r-full bg-poly/70" style={{ width: `${pPct}%` }} />
                    </div>
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right text-fg">{fmtInt(r.matched)}</td>
                <td className={cn("px-3 py-1.5 text-right", r.residual > 0 ? "text-amber" : "text-fg-faint")}>
                  {r.residual > 0 ? fmtInt(r.residual) : "0"}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {r.residual > 0 ? (
                    <Badge variant="amber">naked {r.residualVenue === "kalshi" ? "K" : "P"}</Badge>
                  ) : (
                    <Badge variant="up">hedged</Badge>
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

function PositionTable({
  positions,
  now,
  residualByStrike,
}: {
  positions: EnrichedPos[];
  now: number;
  residualByStrike: Map<number, StrikePairing>;
}) {
  if (!positions.length) return <Empty>No positions</Empty>;
  const rows = [...positions].sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0));
  return (
    <div className="max-h-[320px] overflow-auto">
      <table className="w-full min-w-[420px] border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
          <tr className="border-b border-line">
            <Th>Market</Th>
            <Th>Side</Th>
            <Th right>Shares</Th>
            <Th right>Avg</Th>
            <Th right>Value</Th>
            <Th right>Flags</Th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {rows.map((p) => {
            const age = p.updatedAt != null ? now - p.updatedAt : null;
            const stale = age != null && age > POSITION_STALE_MS;
            const noTime = age == null; // unknown timestamp — must never render as a fresh "live" dot
            const pairing = p.strike != null ? residualByStrike.get(p.strike) : undefined;
            const naked = !!pairing && pairing.residual > 0 && pairing.residualVenue === p.venue;
            return (
              <tr key={p.id} className="border-b border-line/40 hover:bg-surface-2/40">
                <td className="px-3 py-1.5 text-fg-secondary">
                  <span className="text-fg">{p.strike != null ? p.strike.toLocaleString() : p.market}</span>
                </td>
                <td className="px-3 py-1.5">
                  {p.side ? (
                    <Badge variant={p.side === "YES" ? "up" : "down"}>{p.side}</Badge>
                  ) : (
                    <span className="text-fg-faint">{p.outcome || "—"}</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right text-fg">{fmtInt(p.shares)}</td>
                <td className="px-3 py-1.5 text-right text-fg-muted">{fmtCents(p.averagePrice)}</td>
                <td className="px-3 py-1.5 text-right text-fg">{fmtUsd(p.value)}</td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center justify-end gap-1">
                    {naked ? <Badge variant="amber">naked</Badge> : null}
                    {stale ? <Badge variant="neutral">stale</Badge> : null}
                    {noTime ? <Badge variant="neutral">no time</Badge> : null}
                    {p.value == null ? <Badge variant="neutral">no mark</Badge> : null}
                    {!naked && !stale && !noTime && p.value != null ? (
                      <span className="inline-flex items-center gap-1 text-fg-faint">
                        <StatusDot tone="live" className="size-1" />
                        {fmtRelative(p.updatedAt ?? undefined, now)}
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OpenOrdersPanel({ snap, now }: { snap: DashboardSnapshot; now: number }) {
  const orders: Array<TradingOpenOrder & { venue: TradingPlatform }> = [
    ...(snap.tradingActivity?.kalshi.openOrders ?? []).map((o) => ({ ...o, venue: "kalshi" as const })),
    ...(snap.tradingActivity?.polymarket.openOrders ?? []).map((o) => ({ ...o, venue: "polymarket" as const })),
  ];
  return (
    <GridPanel title="Resting Open Orders" dot={orders.length ? "live" : "idle"} span={12} bodyClassName="p-0">
      {orders.length === 0 ? (
        <Empty>No resting orders</Empty>
      ) : (
        <div className="max-h-[220px] overflow-auto">
          <table className="w-full min-w-[560px] border-collapse text-[11px]">
            <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
              <tr className="border-b border-line">
                <Th>Venue</Th>
                <Th>Market</Th>
                <Th>Side</Th>
                <Th right>Shares</Th>
                <Th right>Price</Th>
                <Th right>Value</Th>
                <Th right>Age</Th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {orders.map((o) => (
                <tr key={`${o.venue}-${o.id}`} className="border-b border-line/40 hover:bg-surface-2/40">
                  <td className="px-3 py-1.5">
                    <Badge variant={o.venue === "kalshi" ? "kalshi" : "poly"}>{o.venue === "kalshi" ? "K" : "P"}</Badge>
                  </td>
                  <td className="px-3 py-1.5 text-fg">{o.market}</td>
                  <td className="px-3 py-1.5">
                    <Badge variant={o.side === "Buy" ? "up" : "down"}>{o.side}</Badge>
                  </td>
                  <td className="px-3 py-1.5 text-right text-fg">{fmtInt(o.shares)}</td>
                  <td className="px-3 py-1.5 text-right text-fg-muted">{fmtCents(o.price)}</td>
                  <td className="px-3 py-1.5 text-right text-fg">{fmtUsd(o.value)}</td>
                  <td className="px-3 py-1.5 text-right text-fg-faint">
                    {o.updatedAt != null ? fmtRelative(o.updatedAt, now) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </GridPanel>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={cn("px-3 py-1.5 font-mono text-[9.5px] uppercase tracking-wide", right ? "text-right" : "text-left")}
    >
      {children}
    </th>
  );
}
