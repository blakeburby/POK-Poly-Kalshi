"use client";

import * as React from "react";
import type { DashboardSnapshot, BinaryContract, BookLevel, Venue } from "@/lib/types";
import { ViewScroll, Grid, GridPanel, StatTile } from "./_layout";
import { Empty, Label, StatusDot } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { fmtUsd, fmtCents, fmtInt } from "@/lib/format";
import { cn } from "@/lib/utils";

type Side = "yes" | "no";

function levelsFor(c: BinaryContract, side: Side): { ask: number | null; bid: number | null; askLevels: BookLevel[] } {
  if (side === "yes") return { ask: c.yesAsk, bid: c.yesBid, askLevels: c.yesAskLevels ?? [] };
  return { ask: c.noAsk, bid: c.noBid, askLevels: c.noAskLevels ?? [] };
}

/** Shares fillable by a marketable buy at `limit` — cumulative size of ask levels priced ≤ limit. */
function fillableAt(askLevels: BookLevel[], limit: number): { shares: number; vwap: number | null } {
  let shares = 0;
  let cost = 0;
  for (const l of [...askLevels].sort((a, b) => a.price - b.price)) {
    if (l.price > limit + 1e-9) break;
    shares += l.size;
    cost += l.size * l.price;
  }
  return { shares, vwap: shares > 0 ? cost / shares : null };
}

export function OrderEntryView({ snap }: { snap: DashboardSnapshot }) {
  const [venue, setVenue] = React.useState<Venue>("kalshi");
  const [side, setSide] = React.useState<Side>("yes");
  const [strike, setStrike] = React.useState<number | null>(null);
  const [size, setSize] = React.useState(100);
  const [limitCents, setLimitCents] = React.useState<number | null>(null);

  const contracts = venue === "kalshi" ? snap.books.kalshi : snap.books.polymarket;
  const strikes = [...new Set(contracts.map((c) => c.strike))].sort((a, b) => a - b);
  const sel = strike != null && strikes.includes(strike) ? strike : (strikes[Math.floor(strikes.length / 2)] ?? null);
  const contract = contracts.find((c) => c.strike === sel) ?? null;
  const book = contract ? levelsFor(contract, side) : null;

  // Default the limit to the live best ask whenever the selected market/side changes.
  const bestAsk = book?.ask ?? null;
  React.useEffect(() => {
    setLimitCents(bestAsk != null ? Math.round(bestAsk * 1000) / 10 : null);
  }, [bestAsk, venue, side, sel]);

  const limit = limitCents != null ? limitCents / 100 : null;
  const fill = book && limit != null ? fillableAt(book.askLevels, limit) : null;
  const cost = limit != null ? size * limit : null;
  const maxProfit = limit != null ? size * (1 - limit) : null;
  const maxLoss = cost;
  const marketable = bestAsk != null && limit != null && limit >= bestAsk - 1e-9;
  const fullyFillable = fill != null && fill.shares >= size;

  if (!strikes.length) {
    return (
      <ViewScroll>
        <GridPanel title="Order Entry" span={12}>
          <Empty>No live markets to build a ticket</Empty>
        </GridPanel>
      </ViewScroll>
    );
  }

  return (
    <ViewScroll>
      <div className="flex items-center gap-2 rounded-md border border-amber/30 bg-amber/10 px-3 py-2">
        <StatusDot tone="stale" className="size-2" />
        <span className="font-mono text-[11px] uppercase tracking-wide text-amber">
          Preview only — this ticket is not connected to execution. No orders are placed.
        </span>
      </div>

      <Grid>
        <GridPanel title="Order Ticket" dot="info" span={5} bodyClassName="flex flex-col gap-4">
          <Field label="Venue">
            <Segmented
              options={[
                { v: "kalshi", label: "Kalshi" },
                { v: "polymarket", label: "Polymarket" },
              ]}
              value={venue}
              onChange={(v) => setVenue(v as Venue)}
            />
          </Field>

          <Field label="Strike · BTC">
            <div className="flex flex-wrap gap-1">
              {strikes.map((s) => (
                <button
                  key={s}
                  onClick={() => setStrike(s)}
                  className={cn(
                    "rounded-sm border px-2 py-1 font-mono text-[11px] tabular-nums transition-colors",
                    s === sel
                      ? "border-cyan/40 bg-cyan/10 text-fg"
                      : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg-secondary",
                  )}
                >
                  {s.toLocaleString()}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Side (Buy)">
              <Segmented
                options={[
                  { v: "yes", label: "YES" },
                  { v: "no", label: "NO" },
                ]}
                value={side}
                onChange={(v) => setSide(v as Side)}
              />
            </Field>
            <Field label="Size (shares)">
              <NumberInput value={size} min={1} step={10} onChange={(n) => setSize(Math.max(1, Math.round(n)))} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Limit (¢)">
              <NumberInput
                value={limitCents ?? 0}
                min={1}
                max={99}
                step={0.5}
                onChange={(n) => setLimitCents(Math.min(99, Math.max(1, n)))}
              />
            </Field>
            <Field label="Inside (bid / ask)">
              <div className="flex h-[34px] items-center gap-2 font-mono text-[12px] tabular-nums">
                <span className="text-up">{fmtCents(book?.bid ?? null)}</span>
                <span className="text-fg-faint">/</span>
                <span className="text-down">{fmtCents(book?.ask ?? null)}</span>
              </div>
            </Field>
          </div>

          <button
            disabled
            aria-disabled
            className="mt-1 w-full cursor-not-allowed rounded-md border border-line-strong bg-surface-2 px-3 py-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-fg-faint"
            title="Execution is intentionally disabled in this dashboard"
          >
            ⨯ Submit disabled · preview only
          </button>
        </GridPanel>

        <div className="col-span-12 flex flex-col gap-3 lg:col-span-7">
          <Grid>
            <StatTile className="col-span-6 xl:col-span-3" label="Notional Cost" value={fmtUsd(cost)} tone="cyan" />
            <StatTile
              className="col-span-6 xl:col-span-3"
              label="Max Profit"
              value={fmtUsd(maxProfit)}
              tone="up"
              sub="if resolves in-the-money"
            />
            <StatTile
              className="col-span-6 xl:col-span-3"
              label="Max Loss"
              value={fmtUsd(maxLoss)}
              tone="down"
              sub="if resolves worthless"
            />
            <StatTile
              className="col-span-6 xl:col-span-3"
              label="Marketability"
              value={marketable ? "Marketable" : "Resting"}
              tone={marketable ? "up" : "amber"}
              sub={marketable ? "crosses the ask" : "below best ask"}
            />
          </Grid>

          <GridPanel
            title="Fill Simulation · against live book"
            dot="info"
            span={12}
            right={
              <Badge variant={fullyFillable ? "up" : "amber"}>
                {fullyFillable ? "fully fillable" : "partial at limit"}
              </Badge>
            }
            bodyClassName="flex flex-col gap-3"
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Fillable now" value={fill ? fmtInt(fill.shares) : "—"} sub={`of ${fmtInt(size)} req`} />
              <Metric label="Est. VWAP" value={fill?.vwap != null ? fmtCents(fill.vwap) : "—"} />
              <Metric label="Best Ask" value={fmtCents(bestAsk)} />
              <Metric
                label="Slippage vs inside"
                value={fill?.vwap != null && bestAsk != null ? fmtCents(fill.vwap - bestAsk, true) : "—"}
              />
            </div>
            <BookPreview askLevels={book?.askLevels ?? []} limit={limit} side={side} />
          </GridPanel>
        </div>
      </Grid>
    </ViewScroll>
  );
}

function BookPreview({ askLevels, limit, side }: { askLevels: BookLevel[]; limit: number | null; side: Side }) {
  const rows = [...askLevels].sort((a, b) => a.price - b.price).slice(0, 8);
  if (!rows.length) return <Empty>No ask depth for this market</Empty>;
  const maxSize = Math.max(1, ...rows.map((l) => l.size));
  let cum = 0;
  return (
    <div className="overflow-hidden rounded-sm border border-line/60">
      <div className="grid grid-cols-[1fr_1fr_1fr] border-b border-line/60 bg-surface-2/60 px-2 py-1 font-mono text-[9px] uppercase tracking-wide text-fg-faint">
        <span>{side.toUpperCase()} Ask</span>
        <span className="text-right">Size</span>
        <span className="text-right">Cumulative</span>
      </div>
      {rows.map((l, i) => {
        cum += l.size;
        const within = limit != null && l.price <= limit + 1e-9;
        return (
          <div
            key={`${l.price}-${i}`}
            className={cn(
              "relative grid grid-cols-[1fr_1fr_1fr] items-center px-2 py-1 font-mono text-[11px] tabular-nums",
              within ? "text-fg" : "text-fg-muted",
            )}
          >
            <span
              className={cn("absolute inset-y-0 left-0 -z-0", within ? "bg-cyan/10" : "bg-surface-3/40")}
              style={{ width: `${(l.size / maxSize) * 100}%` }}
            />
            <span className={cn("relative z-10", within ? "text-down" : "")}>{fmtCents(l.price)}</span>
            <span className="relative z-10 text-right">{fmtInt(l.size)}</span>
            <span className="relative z-10 text-right text-fg-secondary">{fmtInt(cum)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-sm border border-line bg-surface px-2.5 py-2">
      <Label>{label}</Label>
      <span className="font-mono text-[14px] tabular-nums text-fg">{value}</span>
      {sub != null ? <span className="font-mono text-[10px] text-fg-muted">{sub}</span> : null}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { v: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex h-[34px] overflow-hidden rounded-sm border border-line">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={cn(
            "px-3 font-mono text-[11px] uppercase tracking-wide transition-colors",
            value === o.v ? "bg-surface-3 text-fg" : "bg-surface text-fg-muted hover:text-fg-secondary",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : ""}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      className="h-[34px] w-full rounded-sm border border-line bg-surface px-2.5 font-mono text-[13px] tabular-nums text-fg outline-none focus:border-cyan/40"
    />
  );
}
