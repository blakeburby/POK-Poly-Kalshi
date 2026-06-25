"use client";

import * as React from "react";
import { ViewScroll, Grid, GridPanel, StatTile } from "./_layout";
import { Empty, StatusDot } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";

interface ReleaseItem {
  venue: "kalshi" | "polymarket";
  id: string;
  title: string;
  status: string;
  createdAt: number | null;
  closeTime: number | null;
  volume: number | null;
  liquidity: number | null;
  isNew: boolean;
  url: string | null;
}

type VenueFilter = "all" | "kalshi" | "polymarket";
const CRYPTO_RE = /\b(btc|bitcoin|eth|ethereum|crypto|sol\b|solana|xrp|ripple|doge)/i;

function fmtUntil(t: number | null, now: number): string {
  if (t == null) return "–";
  const d = t - now;
  if (d <= 0) return "closed";
  if (d < 60_000) return "<1m";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

function fmtCompact(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function ReleasesView() {
  const now = useNow(5000);
  const [releases, setReleases] = React.useState<ReleaseItem[]>([]);
  const [state, setState] = React.useState<"loading" | "ok" | "error">("loading");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [venue, setVenue] = React.useState<VenueFilter>("all");
  const [cryptoOnly, setCryptoOnly] = React.useState(false);
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await fetch("/api/dashboard/releases", { cache: "no-store" });
        const data = (await res.json()) as { releases?: ReleaseItem[]; errors?: Record<string, string> };
        if (cancelled) return;
        const r = data.releases ?? [];
        setReleases(r);
        setErrors(data.errors ?? {});
        setState(r.length ? "ok" : "error");
      } catch {
        if (!cancelled) setState("error");
      } finally {
        if (!cancelled) timer = setTimeout(load, 60_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return releases.filter((r) => {
      if (venue !== "all" && r.venue !== venue) return false;
      if (cryptoOnly && !CRYPTO_RE.test(r.title)) return false;
      if (q && !r.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [releases, venue, cryptoOnly, query]);

  const newCount = releases.filter((r) => r.isNew).length;
  const kCount = releases.filter((r) => r.venue === "kalshi").length;
  const pCount = releases.filter((r) => r.venue === "polymarket").length;

  return (
    <ViewScroll>
      <Grid>
        <StatTile className="col-span-6 xl:col-span-3" label="Markets Tracked" value={String(releases.length)} tone="cyan" />
        <StatTile className="col-span-6 xl:col-span-3" label="New · 24h" value={String(newCount)} tone={newCount > 0 ? "up" : "neutral"} />
        <StatTile className="col-span-6 xl:col-span-3" label="Kalshi" value={String(kCount)} sub={errors.kalshi ? "feed error" : "open markets"} tone={errors.kalshi ? "amber" : "neutral"} />
        <StatTile className="col-span-6 xl:col-span-3" label="Polymarket" value={String(pCount)} sub={errors.polymarket ? "feed error" : "active events"} tone={errors.polymarket ? "amber" : "neutral"} />
      </Grid>

      <GridPanel
        title="Market Releases · Kalshi + Polymarket"
        dot={state === "ok" ? "live" : state === "loading" ? "stale" : "halt"}
        pulse={state === "ok"}
        span={12}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter…"
              className="h-[26px] w-28 rounded-sm border border-line bg-surface px-2 font-mono text-[11px] text-fg outline-none focus:border-cyan/40"
            />
            <button
              onClick={() => setCryptoOnly((v) => !v)}
              className={cn(
                "rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors",
                cryptoOnly ? "border-cyan/40 bg-cyan/10 text-fg" : "border-line text-fg-muted hover:text-fg-secondary",
              )}
            >
              Crypto
            </button>
            <div className="flex items-center gap-1">
              {(["all", "kalshi", "polymarket"] as VenueFilter[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setVenue(v)}
                  className={cn(
                    "rounded-sm px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors",
                    venue === v ? "bg-surface-3 text-fg" : "text-fg-muted hover:text-fg-secondary",
                  )}
                >
                  {v === "all" ? "All" : v === "kalshi" ? "K" : "P"}
                </button>
              ))}
            </div>
          </div>
        }
        bodyClassName="p-0"
      >
        {state === "loading" ? (
          <Empty>Loading market releases…</Empty>
        ) : filtered.length === 0 ? (
          <div className="bg-grid flex h-40 flex-col items-center justify-center gap-2">
            <StatusDot tone={state === "error" ? "halt" : "idle"} className="size-2.5" />
            <p className="font-mono text-[11px] uppercase tracking-wide text-fg-secondary">
              {state === "error" ? "Release feeds unavailable" : "No markets match the filter"}
            </p>
          </div>
        ) : (
          <div className="max-h-[620px] overflow-auto">
            <table className="w-full min-w-[720px] border-collapse text-[11px]">
              <thead className="sticky top-0 z-10 bg-surface-2/90 text-fg-muted backdrop-blur">
                <tr className="border-b border-line">
                  <Th>Venue</Th>
                  <Th>Market</Th>
                  <Th right>Created</Th>
                  <Th right>Closes</Th>
                  <Th right>Volume</Th>
                  <Th right>Liquidity</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const closing = r.closeTime != null && r.closeTime - now < 3_600_000 && r.closeTime > now;
                  return (
                    <tr key={`${r.venue}-${r.id}`} className="border-b border-line/30 hover:bg-surface-2/40">
                      <td className="px-3 py-2">
                        <Badge variant={r.venue === "kalshi" ? "kalshi" : "poly"}>{r.venue === "kalshi" ? "K" : "P"}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="line-clamp-1 max-w-[420px] text-fg">{r.title}</span>
                          {r.isNew ? <Badge variant="up">new</Badge> : null}
                          {closing ? <Badge variant="amber">closing</Badge> : null}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-muted">
                        {r.createdAt != null ? fmtRelative(r.createdAt, now) : "–"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-muted">
                        {fmtUntil(r.closeTime, now)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-secondary">{fmtCompact(r.volume)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-secondary">{fmtCompact(r.liquidity)}</td>
                      <td className="px-3 py-2 text-right">
                        {r.url ? (
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-[11px] text-cyan hover:underline"
                          >
                            ↗
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </GridPanel>
    </ViewScroll>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th className={cn("px-3 py-1.5 font-mono text-[9.5px] uppercase tracking-wide", right ? "text-right" : "text-left")}>
      {children}
    </th>
  );
}
