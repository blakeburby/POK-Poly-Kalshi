"use client";

import * as React from "react";
import type { DashboardSnapshot, BinaryContract, BookLevel, Venue } from "@/lib/types";
import { ViewScroll, Grid, GridPanel } from "./_layout";
import { Empty, StatusDot, Label, MiniBar } from "@/components/ui/stat";
import { fmtCents, fmtInt, fmtMs, ageTone } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";
import { useDashboardStore } from "@/store/dashboard-store";
import { strikeUniverse, resolveStrike, nearestContract, type StrikeUniverse, type NearestContract } from "@/lib/selectors";

export type Side = "yes" | "no";

interface LadderRowData {
  price: number;
  bidSize: number | null;
  askSize: number | null;
}

const VENUE_ACCENT: Record<Venue, string> = {
  kalshi: "var(--color-kalshi)",
  polymarket: "var(--color-poly)",
};

function sideLevels(
  c: BinaryContract,
  side: Side,
): { bids: BookLevel[]; asks: BookLevel[]; bestBid: number | null; bestAsk: number | null } {
  if (side === "yes") {
    return { bids: c.yesBidLevels ?? [], asks: c.yesAskLevels ?? [], bestBid: c.yesBid, bestAsk: c.yesAsk };
  }
  return { bids: c.noBidLevels ?? [], asks: c.noAskLevels ?? [], bestBid: c.noBid, bestAsk: c.noAsk };
}

/** Merge bid + ask levels into one price-keyed ladder, highest price at the top (classic DOM). */
function buildLadder(bids: BookLevel[], asks: BookLevel[]): LadderRowData[] {
  const byPrice = new Map<number, LadderRowData>();
  const at = (price: number) => {
    const key = Math.round(price * 1000) / 1000;
    let row = byPrice.get(key);
    if (!row) {
      row = { price: key, bidSize: null, askSize: null };
      byPrice.set(key, row);
    }
    return row;
  };
  for (const l of bids) at(l.price).bidSize = (at(l.price).bidSize ?? 0) + l.size;
  for (const l of asks) at(l.price).askSize = (at(l.price).askSize ?? 0) + l.size;
  return [...byPrice.values()].sort((a, b) => b.price - a.price);
}

export function LadderView({ snap }: { snap: DashboardSnapshot }) {
  const now = useNow(1000);
  const staleMs = snap.health.staleBookMs;
  const reducedMotion = useDashboardStore((s) => s.reducedMotion);
  const selectedStrike = useDashboardStore((s) => s.selectedStrike);
  const setSelectedStrike = useDashboardStore((s) => s.setSelectedStrike);
  const [side, setSide] = React.useState<Side>("yes");

  // Kalshi and Polymarket list independent strike grids, so resolve EACH ladder to its own nearest book —
  // both venues stay visible side-by-side even when the selected strike exists on only one of them.
  const universe = React.useMemo(() => strikeUniverse(snap), [snap]);
  const strikes = universe.strikes;
  const sel = resolveStrike(selectedStrike, universe);

  const kNear = React.useMemo(() => nearestContract(snap.books.kalshi, sel), [snap.books.kalshi, sel]);
  const pNear = React.useMemo(() => nearestContract(snap.books.polymarket, sel), [snap.books.polymarket, sel]);
  const kc = kNear.contract;
  const pc = pNear.contract;

  if (!strikes.length) {
    return (
      <ViewScroll>
        <GridPanel title="Trading Ladder" span={12}>
          <Empty>No live contracts to ladder</Empty>
        </GridPanel>
      </ViewScroll>
    );
  }

  return (
    <ViewScroll>
      <ControlBar
        strikes={strikes}
        universe={universe}
        sel={sel}
        onSel={setSelectedStrike}
        side={side}
        onSide={setSide}
        kNear={kNear}
        pNear={pNear}
      />

      <Grid>
        <GridPanel
          title="Kalshi · Depth Ladder"
          dot={kc ? ageTone(now - kc.updatedAt, staleMs) : "idle"}
          accent={VENUE_ACCENT.kalshi}
          span={6}
          right={<LadderHead near={kNear} now={now} staleMs={staleMs} />}
          bodyClassName="p-0"
        >
          {kc ? (
            <Ladder contract={kc} side={side} flashEnabled={!reducedMotion} />
          ) : (
            <Empty>No Kalshi book — no open BTC market</Empty>
          )}
        </GridPanel>
        <GridPanel
          title="Polymarket · Depth Ladder"
          dot={pc ? ageTone(now - pc.updatedAt, staleMs) : "idle"}
          accent={VENUE_ACCENT.polymarket}
          span={6}
          right={<LadderHead near={pNear} now={now} staleMs={staleMs} />}
          bodyClassName="p-0"
        >
          {pc ? (
            <Ladder contract={pc} side={side} flashEnabled={!reducedMotion} />
          ) : (
            <Empty>No Polymarket book — no open BTC market</Empty>
          )}
        </GridPanel>
      </Grid>
    </ViewScroll>
  );
}

function ControlBar({
  strikes,
  universe,
  sel,
  onSel,
  side,
  onSide,
  kNear,
  pNear,
}: {
  strikes: number[];
  universe: StrikeUniverse;
  sel: number | null;
  onSel: (s: number) => void;
  side: Side;
  onSide: (s: Side) => void;
  kNear: NearestContract;
  pNear: NearestContract;
}) {
  const kc = kNear.contract;
  const pc = pNear.contract;
  const kInside = kc ? sideLevels(kc, side) : null;
  const pInside = pc ? sideLevels(pc, side) : null;
  // A synthetic premium only makes sense when both legs are the SAME strike. The two venues quote
  // independent grids, so when the displayed books are at different strikes we suppress it rather than
  // print a cross-strike number under a same-strike label.
  const sameStrike = kc != null && pc != null && kc.strike === pc.strike;
  const synth =
    sameStrike && kc!.yesAsk != null && pc!.noAsk != null
      ? Math.min(kc!.yesAsk + pc!.noAsk, (pc!.yesAsk ?? Infinity) + (kc!.noAsk ?? Infinity))
      : null;

  return (
    <GridPanel title="Ladder Controls" dot="info" span={12} bodyClassName="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="flex flex-col gap-1.5">
        <Label>Strike · BTC</Label>
        <div className="flex flex-wrap gap-1">
          {strikes.map((s) => {
            const onBoth = universe.kalshiStrikes.has(s) && universe.polyStrikes.has(s);
            const only = universe.kalshiStrikes.has(s) ? "K" : "P";
            return (
              <button
                key={s}
                onClick={() => onSel(s)}
                title={
                  onBoth
                    ? "Quoted on both venues"
                    : `${only === "K" ? "Kalshi" : "Polymarket"}-only strike — the other venue shows its nearest book`
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
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Contract Side</Label>
        <div className="inline-flex overflow-hidden rounded-sm border border-line">
          {(["yes", "no"] as const).map((s) => (
            <button
              key={s}
              onClick={() => onSide(s)}
              className={cn(
                "px-3 py-1 font-mono text-[11px] uppercase tracking-wide transition-colors",
                side === s ? "bg-surface-3 text-fg" : "bg-surface text-fg-muted hover:text-fg-secondary",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Inside Market · {side.toUpperCase()}</Label>
        <div className="flex items-center gap-4 font-mono text-[11px] tabular-nums">
          <span className="text-kalshi">
            K{kc ? ` ${kc.strike.toLocaleString()}` : ""} {fmtCents(kInside?.bestBid ?? null)} /{" "}
            {fmtCents(kInside?.bestAsk ?? null)}
            {kNear.contract && !kNear.exact ? (
              <span className="ml-1 rounded-sm bg-amber/15 px-1 text-[8px] uppercase tracking-wide text-amber">
                nearest
              </span>
            ) : null}
          </span>
          <span className="text-poly">
            P{pc ? ` ${pc.strike.toLocaleString()}` : ""} {fmtCents(pInside?.bestBid ?? null)} /{" "}
            {fmtCents(pInside?.bestAsk ?? null)}
            {pNear.contract && !pNear.exact ? (
              <span className="ml-1 rounded-sm bg-amber/15 px-1 text-[8px] uppercase tracking-wide text-amber">
                nearest
              </span>
            ) : null}
          </span>
        </div>
      </div>

      <div className="ml-auto flex flex-col gap-1.5">
        <Label>Synthetic Premium</Label>
        <span
          className={cn(
            "font-mono text-[13px] tabular-nums",
            synth != null && synth < 1 ? "text-up" : "text-fg-secondary",
          )}
        >
          {synth != null ? fmtCents(synth) : "–"}
          {synth != null && synth < 1 ? (
            <span className="ml-1.5 rounded-sm bg-up-dim px-1 py-0.5 text-[9px] uppercase tracking-wide text-up">
              arbitrable
            </span>
          ) : null}
          {synth == null && kc && pc && !sameStrike ? (
            <span className="ml-1 text-[9px] uppercase tracking-wide text-fg-faint">strikes differ</span>
          ) : null}
        </span>
      </div>
    </GridPanel>
  );
}

export function Ladder({
  contract,
  side,
  flashEnabled,
}: {
  contract: BinaryContract;
  side: Side;
  flashEnabled: boolean;
}) {
  const { bids, asks, bestBid, bestAsk } = sideLevels(contract, side);
  const rows = React.useMemo(() => buildLadder(bids, asks), [bids, asks]);

  const maxSize = React.useMemo(() => {
    let m = 0;
    for (const r of rows) m = Math.max(m, r.bidSize ?? 0, r.askSize ?? 0);
    return m || 1;
  }, [rows]);

  // Cumulative resting depth from the inside (best price) outward, keyed by price — reveals walls.
  const cumBid = React.useMemo(() => {
    const m = new Map<number, number>();
    let run = 0;
    for (const l of [...bids].sort((a, b) => b.price - a.price)) {
      run += l.size;
      m.set(round3(l.price), run);
    }
    return m;
  }, [bids]);
  const cumAsk = React.useMemo(() => {
    const m = new Map<number, number>();
    let run = 0;
    for (const l of [...asks].sort((a, b) => a.price - b.price)) {
      run += l.size;
      m.set(round3(l.price), run);
    }
    return m;
  }, [asks]);

  const totalBid = bids.reduce((s, l) => s + l.size, 0);
  const totalAsk = asks.reduce((s, l) => s + l.size, 0);
  const bidShare = totalBid + totalAsk > 0 ? totalBid / (totalBid + totalAsk) : 0.5;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;

  if (!rows.length) return <Empty>No depth on {side.toUpperCase()} side</Empty>;

  // Rows are price-descending: asks sit on top, bids below. The first row carrying a
  // bid is the best bid — the spread divider renders just above it.
  const firstBidIdx = rows.findIndex((r) => r.bidSize != null);

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-[1fr_64px_1fr] border-b border-line/60 px-2 py-1 font-mono text-[9px] uppercase tracking-wide text-fg-faint">
        <span className="text-left">Bid Size</span>
        <span className="text-center">Price</span>
        <span className="text-right">Ask Size</span>
      </div>

      <div className="max-h-[420px] overflow-auto">
        {rows.map((r, i) => {
          const showSpread = spread != null && i === firstBidIdx && firstBidIdx > 0;
          return (
            <React.Fragment key={r.price}>
              {showSpread ? <SpreadDivider spread={spread!} mid={mid} /> : null}
              <LadderRow
                price={r.price}
                bidSize={r.bidSize}
                askSize={r.askSize}
                maxSize={maxSize}
                cumBidPct={totalBid > 0 ? ((cumBid.get(r.price) ?? 0) / totalBid) * 100 : 0}
                cumAskPct={totalAsk > 0 ? ((cumAsk.get(r.price) ?? 0) / totalAsk) * 100 : 0}
                isBestBid={bestBid != null && r.price === round3(bestBid)}
                isBestAsk={bestAsk != null && r.price === round3(bestAsk)}
                flashEnabled={flashEnabled}
              />
            </React.Fragment>
          );
        })}
      </div>

      <div className="grid grid-cols-3 items-center gap-2 border-t border-line/60 px-2 py-2 font-mono text-[10px] tabular-nums">
        <div className="flex flex-col gap-0.5">
          <span className="text-fg-faint">Σ Bid</span>
          <span className="text-up">{fmtInt(totalBid)}</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-fg-muted">
            spread {spread != null ? fmtCents(spread) : "–"} · mid {mid != null ? fmtCents(mid) : "–"}
          </span>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-down/25">
            <div className="h-full bg-up/70 transition-[width] duration-300" style={{ width: `${bidShare * 100}%` }} />
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-fg-faint">Σ Ask</span>
          <span className="text-down">{fmtInt(totalAsk)}</span>
        </div>
      </div>
    </div>
  );
}

function LadderRow({
  price,
  bidSize,
  askSize,
  maxSize,
  cumBidPct,
  cumAskPct,
  isBestBid,
  isBestAsk,
  flashEnabled,
}: {
  price: number;
  bidSize: number | null;
  askSize: number | null;
  maxSize: number;
  cumBidPct: number;
  cumAskPct: number;
  isBestBid: boolean;
  isBestAsk: boolean;
  flashEnabled: boolean;
}) {
  const bidFlash = useFlashClass(bidSize ?? 0, flashEnabled && bidSize != null);
  const askFlash = useFlashClass(askSize ?? 0, flashEnabled && askSize != null);
  const bidPct = bidSize != null ? (bidSize / maxSize) * 100 : 0;
  const askPct = askSize != null ? (askSize / maxSize) * 100 : 0;

  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_64px_1fr] items-stretch border-b border-line/25",
        isBestBid && "bg-up/[0.04]",
        isBestAsk && "bg-down/[0.04]",
      )}
    >
      {/* bid cell — bars grow from the centre price leftwards (faint cumulative depth + bright instant size) */}
      <div className={cn("relative flex items-center justify-end overflow-hidden px-2 py-[3px]", bidFlash)}>
        {bidSize != null ? (
          <span
            className="absolute inset-y-0 right-0 bg-up/[0.07] transition-[width] duration-300"
            style={{ width: `${cumBidPct}%` }}
          />
        ) : null}
        {bidSize != null ? (
          <span
            className="absolute inset-y-0 right-0 bg-up/20 transition-[width] duration-300"
            style={{ width: `${bidPct}%` }}
          />
        ) : null}
        <span
          className={cn(
            "relative z-10 font-mono text-[11px] tabular-nums",
            bidSize != null ? "text-up" : "text-fg-faint",
          )}
        >
          {bidSize != null ? fmtInt(bidSize) : ""}
        </span>
      </div>

      {/* price */}
      <div
        className={cn(
          "flex items-center justify-center border-x border-line/40 font-mono text-[11px] tabular-nums",
          isBestBid ? "text-up" : isBestAsk ? "text-down" : "text-fg-secondary",
        )}
      >
        {fmtCents(price)}
      </div>

      {/* ask cell — bars grow from the centre price rightwards (faint cumulative depth + bright instant size) */}
      <div className={cn("relative flex items-center justify-start overflow-hidden px-2 py-[3px]", askFlash)}>
        {askSize != null ? (
          <span
            className="absolute inset-y-0 left-0 bg-down/[0.07] transition-[width] duration-300"
            style={{ width: `${cumAskPct}%` }}
          />
        ) : null}
        {askSize != null ? (
          <span
            className="absolute inset-y-0 left-0 bg-down/20 transition-[width] duration-300"
            style={{ width: `${askPct}%` }}
          />
        ) : null}
        <span
          className={cn(
            "relative z-10 font-mono text-[11px] tabular-nums",
            askSize != null ? "text-down" : "text-fg-faint",
          )}
        >
          {askSize != null ? fmtInt(askSize) : ""}
        </span>
      </div>
    </div>
  );
}

function SpreadDivider({ spread, mid }: { spread: number; mid: number | null }) {
  return (
    <div className="grid grid-cols-[1fr_64px_1fr] items-center bg-surface-3/40">
      <span className="border-y border-dashed border-line-strong/50" />
      <span className="border-x border-line/40 py-[3px] text-center font-mono text-[9px] tabular-nums text-amber">
        {fmtCents(spread)}
      </span>
      <span className="border-y border-dashed border-line-strong/50 pr-2 text-right font-mono text-[9px] text-fg-faint">
        {mid != null ? `mid ${fmtCents(mid)}` : ""}
      </span>
    </div>
  );
}

/**
 * Depth-ladder header: the strike actually shown for this venue, an "≈ nearest" flag when that strike was
 * substituted because the venue has no book at the selected strike, and the book's age.
 */
function LadderHead({ near, now, staleMs }: { near: NearestContract; now: number; staleMs: number }) {
  const c = near.contract;
  if (!c) return null;
  return (
    <span className="flex items-center gap-2 font-mono text-[10px] tabular-nums">
      <span className="text-fg-secondary">{c.strike.toLocaleString()}</span>
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
      <AgeTag age={now - c.updatedAt} staleMs={staleMs} />
    </span>
  );
}

function AgeTag({ age, staleMs }: { age: number; staleMs: number }) {
  const tone = ageTone(age, staleMs);
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-fg-muted">
      <StatusDot tone={tone} className="size-1" />
      {fmtMs(age)}
    </span>
  );
}

/** Flash a cell up/down for ~0.5s when its numeric value changes (respects reduced motion via `enabled`). */
function useFlashClass(value: number, enabled: boolean): string {
  const prev = React.useRef(value);
  const [cls, setCls] = React.useState("");
  React.useEffect(() => {
    if (!enabled) {
      prev.current = value;
      return;
    }
    if (value > prev.current) setCls("flash-up");
    else if (value < prev.current) setCls("flash-down");
    prev.current = value;
    const t = setTimeout(() => setCls(""), 520);
    return () => clearTimeout(t);
  }, [value, enabled]);
  return cls;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
