"use client";

import * as React from "react";
import { ViewScroll, Grid, GridPanel, StatTile } from "./_layout";
import { EChart } from "@/components/charts/echart";
import { candlestickOption, type Candle } from "@/components/charts/options";
import { Empty, Label, StatusDot } from "@/components/ui/stat";
import { cn } from "@/lib/utils";

const ASSETS = ["BTC", "ETH", "SOL", "XRP"] as const;
type Asset = (typeof ASSETS)[number];
const GRANS: { s: number; label: string }[] = [
  { s: 60, label: "1m" },
  { s: 300, label: "5m" },
  { s: 900, label: "15m" },
  { s: 3600, label: "1h" },
];

function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "–";
  const d = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 2 : 4;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

function fmtPctSigned(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "–";
  const p = v * 100;
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(2)}%`;
}

/**
 * Self-contained spot candlestick panel (own asset/granularity selectors + polling fetch).
 * Reused both as the full CandlesView and as a Cockpit cell. `chartHeight` sizes the chart;
 * `showTiles` toggles the Last/Change/High/Low strip (off in the compact Cockpit embed).
 */
export function CandleChartPanel({
  chartHeight = 440,
  showTiles = true,
  fill = false,
}: {
  chartHeight?: number;
  showTiles?: boolean;
  /** Fill the parent height (for a resizable pane) instead of using a fixed chart height. */
  fill?: boolean;
}) {
  const [asset, setAsset] = React.useState<Asset>("BTC");
  const [gran, setGran] = React.useState(60);
  const [candles, setCandles] = React.useState<Candle[]>([]);
  const [state, setState] = React.useState<"loading" | "ok" | "error">("loading");
  const [updatedAt, setUpdatedAt] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await fetch(`/api/dashboard/candles?asset=${asset}&granularity=${gran}`, { cache: "no-store" });
        const data = (await res.json()) as { candles?: Candle[] };
        if (cancelled) return;
        const cs = data.candles ?? [];
        setCandles(cs);
        setState(cs.length ? "ok" : "error");
        setUpdatedAt(cs.length ? Date.now() : null);
      } catch {
        if (!cancelled) setState("error");
      } finally {
        if (!cancelled) timer = setTimeout(load, gran <= 60 ? 15_000 : 30_000);
      }
    };
    setState("loading");
    setCandles([]);
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [asset, gran]);

  const last = candles.length ? candles[candles.length - 1] : null;
  const first = candles.length ? candles[0] : null;
  const changePct = last && first && first.o ? (last.c - first.o) / first.o : null;
  const hi = candles.length ? Math.max(...candles.map((c) => c.h)) : null;
  const lo = candles.length ? Math.min(...candles.map((c) => c.l)) : null;
  const granLabel = GRANS.find((g) => g.s === gran)?.label ?? "";

  return (
    <>
      <GridPanel
        title="Price · Spot Candles"
        dot={state === "ok" ? "live" : state === "loading" ? "stale" : "halt"}
        pulse={state === "ok"}
        span={12}
        className={fill ? "h-full" : undefined}
        right={
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-[10px] text-fg-faint sm:inline">
              {state === "error" ? "feed unavailable" : updatedAt ? "live · Coinbase spot" : "loading…"}
            </span>
            <div className="flex items-center gap-1">
              {GRANS.map((g) => (
                <button
                  key={g.s}
                  onClick={() => setGran(g.s)}
                  className={cn(
                    "rounded-sm px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors",
                    gran === g.s ? "bg-surface-3 text-fg" : "text-fg-muted hover:text-fg-secondary",
                  )}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        }
        bodyClassName="flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {ASSETS.map((a) => (
              <button
                key={a}
                onClick={() => setAsset(a)}
                className={cn(
                  "rounded-sm border px-2.5 py-1 font-mono text-[12px] font-medium tracking-wide transition-colors",
                  a === asset
                    ? "border-cyan/40 bg-cyan/10 text-fg"
                    : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg-secondary",
                )}
              >
                {a}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-4">
            <div className="flex flex-col">
              <Label>
                {asset}-USD · {granLabel}
              </Label>
              <span className="font-mono text-[22px] leading-none tabular-nums text-fg">{fmtPrice(last?.c)}</span>
            </div>
            <span
              className={cn(
                "font-mono text-[14px] tabular-nums",
                (changePct ?? 0) > 0 ? "text-up" : (changePct ?? 0) < 0 ? "text-down" : "text-fg-muted",
              )}
            >
              {fmtPctSigned(changePct)}
            </span>
          </div>
        </div>

        <div className={fill ? "min-h-0 flex-1" : undefined} style={fill ? undefined : { height: chartHeight }}>
          {state === "ok" && candles.length > 1 ? (
            <EChart option={candlestickOption(candles, (v) => fmtPrice(v))} />
          ) : state === "loading" ? (
            <Empty>Loading {asset} candles…</Empty>
          ) : (
            <div className="bg-grid flex h-full flex-col items-center justify-center gap-2">
              <StatusDot tone="halt" className="size-2.5" />
              <p className="font-mono text-[11px] uppercase tracking-wide text-fg-secondary">Price feed unavailable</p>
              <p className="font-mono text-[10px] text-fg-faint">Coinbase spot data could not be reached</p>
            </div>
          )}
        </div>
      </GridPanel>

      {showTiles ? (
        <Grid>
          <StatTile className="col-span-6 xl:col-span-3" label="Last" value={fmtPrice(last?.c)} tone="cyan" />
          <StatTile
            className="col-span-6 xl:col-span-3"
            label={`Change · ${granLabel} window`}
            value={fmtPctSigned(changePct)}
            tone={(changePct ?? 0) >= 0 ? "up" : "down"}
          />
          <StatTile className="col-span-6 xl:col-span-3" label="High" value={fmtPrice(hi)} tone="up" />
          <StatTile className="col-span-6 xl:col-span-3" label="Low" value={fmtPrice(lo)} tone="down" />
        </Grid>
      ) : null}
    </>
  );
}

export function CandlesView() {
  return (
    <ViewScroll>
      <CandleChartPanel />
    </ViewScroll>
  );
}
