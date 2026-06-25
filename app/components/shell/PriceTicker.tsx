"use client";

import * as React from "react";
import { useDashboardStore } from "@/store/dashboard-store";
import { cn } from "@/lib/utils";

const TICKER_ASSETS = ["BTC", "ETH"] as const;
type Dir = "up" | "down" | "flat";

function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "–";
  const d = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 2 : 4;
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Live BTC/ETH spot ticker in the header — polls the read-only spot route and tick-flashes on change. */
export function PriceTicker() {
  const setView = useDashboardStore((s) => s.setView);
  const reducedMotion = useDashboardStore((s) => s.reducedMotion);
  const [prices, setPrices] = React.useState<Record<string, number | null>>({});
  const [dirs, setDirs] = React.useState<Record<string, Dir>>({});
  const prevRef = React.useRef<Record<string, number>>({});

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await fetch("/api/dashboard/spot", { cache: "no-store" });
        const data = (await res.json()) as { prices?: Record<string, number | null> };
        if (cancelled) return;
        const p = data.prices ?? {};
        const nd: Record<string, Dir> = {};
        for (const a of TICKER_ASSETS) {
          const nv = p[a];
          const pv = prevRef.current[a];
          if (nv != null && pv != null) nd[a] = nv > pv ? "up" : nv < pv ? "down" : "flat";
          if (nv != null) prevRef.current[a] = nv;
        }
        setPrices(p);
        setDirs(nd);
      } catch {
        /* keep last good values */
      } finally {
        if (!cancelled) timer = setTimeout(load, 8000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const hasAny = TICKER_ASSETS.some((a) => prices[a] != null);
  if (!hasAny) return null;

  return (
    <button
      onClick={() => setView("candles")}
      title="Open Price Charts"
      className="hidden items-center gap-3 rounded-sm border border-line bg-surface-2/40 px-2.5 py-1 transition-colors hover:border-line-strong lg:flex"
    >
      {TICKER_ASSETS.map((a) => {
        const v = prices[a];
        const dir = dirs[a] ?? "flat";
        const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "·";
        const tone = dir === "up" ? "text-up" : dir === "down" ? "text-down" : "text-fg-muted";
        return (
          <span key={a} className="flex items-center gap-1.5 leading-none">
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-muted">{a}</span>
            <span
              key={v ?? 0}
              className={cn(
                "rounded-sm px-1 font-mono text-[12px] tabular-nums text-fg",
                !reducedMotion && (dir === "up" ? "flash-up" : dir === "down" ? "flash-down" : ""),
              )}
            >
              {fmtPrice(v)}
            </span>
            <span className={cn("font-mono text-[9px]", tone)}>{arrow}</span>
          </span>
        );
      })}
    </button>
  );
}
