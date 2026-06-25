"use client";

import * as React from "react";
import type { BinaryContract, Venue } from "@/lib/types";
import { EChart } from "@/components/charts/echart";
import { liquidityHeatmapOption } from "@/components/charts/options";
import { Empty } from "@/components/ui/stat";
import { fmtClock } from "@/lib/format";
import { cn } from "@/lib/utils";

const COLS = 48; // time samples retained (rolling window)
const SAMPLE_MS = 1000; // sampling cadence
const RANGE_CENTS = 9; // price window ± around mid

interface Sample {
  t: number;
  /** price (integer cents) -> signed resting size (ask positive, bid negative). */
  book: Map<number, number>;
  midC: number | null;
}

function sampleBook(c: BinaryContract | null): Sample | null {
  if (!c) return null;
  const book = new Map<number, number>();
  const add = (levels: BinaryContract["yesAskLevels"], sign: number) => {
    for (const l of levels ?? []) {
      const k = Math.round(l.price * 100);
      book.set(k, (book.get(k) ?? 0) + sign * l.size);
    }
  };
  add(c.yesBidLevels, -1);
  add(c.yesAskLevels, 1);
  const midC =
    c.yesBid != null && c.yesAsk != null ? Math.round(((c.yesBid + c.yesAsk) / 2) * 100) : null;
  return book.size ? { t: Date.now(), book, midC } : null;
}

export function LiquidityHeatmap({
  kalshi,
  polymarket,
}: {
  kalshi: BinaryContract | null;
  polymarket: BinaryContract | null;
}) {
  const [venue, setVenue] = React.useState<Venue>("kalshi");
  const contract = venue === "kalshi" ? kalshi : polymarket;
  const latestRef = React.useRef(contract);
  latestRef.current = contract;
  const [buffer, setBuffer] = React.useState<Sample[]>([]);

  // Sample the currently-selected book once per second into a rolling window. We deliberately
  // keep accumulating across strike re-selection (the price window re-centres on the latest mid),
  // resetting only when the venue changes — so the heatmap stays continuous as the ATM strike drifts.
  React.useEffect(() => {
    setBuffer([]);
    const id = setInterval(() => {
      const s = sampleBook(latestRef.current);
      if (!s) return;
      setBuffer((prev) => [...prev, s].slice(-COLS));
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [venue]);

  const chart = React.useMemo(() => {
    if (buffer.length < 2) return null;
    const lastMid = [...buffer].reverse().find((s) => s.midC != null)?.midC ?? null;
    if (lastMid == null) return null;
    const loC = lastMid - RANGE_CENTS;
    const hiC = lastMid + RANGE_CENTS;
    const rowsC: number[] = [];
    for (let p = loC; p <= hiC; p++) rowsC.push(p);
    const rows = rowsC.map((c) => `${(c / 100).toFixed(2)}`);
    const cols = buffer.map((s) => fmtClock(s.t));
    const cells: Array<[number, number, number]> = [];
    let maxAbs = 1;
    buffer.forEach((s, xi) => {
      for (const [k, size] of s.book) {
        if (k < loC || k > hiC) continue;
        const yi = k - loC;
        if (size !== 0) {
          cells.push([xi, yi, size]);
          maxAbs = Math.max(maxAbs, Math.abs(size));
        }
      }
    });
    return { cols, rows, cells, maxAbs };
  }, [buffer]);

  return (
    <div>
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-fg-faint">
          bid walls <span className="text-up">green</span> · ask walls <span className="text-down">red</span> · y=price ¢ · x=time
        </span>
        <div className="inline-flex overflow-hidden rounded-sm border border-line">
          {(["kalshi", "polymarket"] as Venue[]).map((v) => (
            <button
              key={v}
              onClick={() => setVenue(v)}
              className={cn(
                "px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors",
                venue === v ? "bg-surface-3 text-fg" : "bg-surface text-fg-muted hover:text-fg-secondary",
              )}
            >
              {v === "kalshi" ? "Kalshi" : "Poly"}
            </button>
          ))}
        </div>
      </div>
      <div className="h-[250px]">
        {chart ? (
          <EChart option={liquidityHeatmapOption(chart.cols, chart.rows, chart.cells, chart.maxAbs)} />
        ) : (
          <Empty>Accumulating liquidity… (sampling the book each second)</Empty>
        )}
      </div>
    </div>
  );
}
