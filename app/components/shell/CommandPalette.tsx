"use client";

import * as React from "react";
import { Search, CornerDownLeft, Crosshair } from "lucide-react";
import { Dialog, CenterContent } from "@/components/ui/dialog";
import { useDashboardStore, type ViewId } from "@/store/dashboard-store";
import { NAV } from "./nav-items";
import { cn } from "@/lib/utils";

interface Command {
  id: string;
  label: string;
  hint?: string;
  keywords: string;
  run: (s: ReturnType<typeof actions>) => void;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}

function actions() {
  const { setView, setReducedMotion, reducedMotion, setSelectedStrike } = useDashboardStore.getState();
  return { setView, setReducedMotion, reducedMotion, setSelectedStrike };
}

export function CommandPalette() {
  const open = useDashboardStore((s) => s.commandOpen);
  const setOpen = useDashboardStore((s) => s.setCommandOpen);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  // Global ⌘K / Ctrl+K to toggle the palette.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen(!useDashboardStore.getState().commandOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const commands: Command[] = React.useMemo(() => {
    const nav: Command[] = NAV.map((n) => ({
      id: `view:${n.id}`,
      label: n.label,
      hint: `view · ${n.hot}`,
      keywords: `${n.label} ${n.short} ${n.id}`,
      icon: n.icon,
      run: (a) => a.setView(n.id as ViewId),
    }));
    const extra: Command[] = [
      {
        id: "toggle-motion",
        label: "Toggle reduced motion",
        hint: "setting",
        keywords: "reduced motion animation accessibility flash",
        icon: Search,
        run: (a) => a.setReducedMotion(!a.reducedMotion),
      },
    ];
    return [...nav, ...extra];
  }, []);

  // Strike-jump commands: when the query is a number, offer to jump straight to that market.
  const snapshot = useDashboardStore((s) => s.snapshot);
  const strikes = React.useMemo(() => {
    if (!snapshot) return [] as number[];
    return Array.from(
      new Set([...(snapshot.books.kalshi ?? []), ...(snapshot.books.polymarket ?? [])].map((c) => c.strike)),
    ).sort((a, b) => a - b);
  }, [snapshot]);

  const strikeCommands: Command[] = React.useMemo(() => {
    const q = query.trim().replace(/[,\s]/g, "");
    if (!/^\d{2,}$/.test(q)) return [];
    const matches = strikes.filter((s) => String(s).startsWith(q)).slice(0, 4);
    return matches.flatMap((s) => [
      {
        id: `ladder:${s}`,
        label: `Trading Ladder · BTC ${s.toLocaleString()}`,
        hint: "strike",
        keywords: String(s),
        icon: Crosshair,
        run: (a) => {
          a.setSelectedStrike(s);
          a.setView("ladder");
        },
      },
      {
        id: `books:${s}`,
        label: `Order Books · BTC ${s.toLocaleString()}`,
        hint: "strike",
        keywords: String(s),
        icon: Crosshair,
        run: (a) => {
          a.setSelectedStrike(s);
          a.setView("books");
        },
      },
    ]);
  }, [query, strikes]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const nav = !q ? commands : commands.filter((c) => c.keywords.toLowerCase().includes(q));
    return [...strikeCommands, ...nav];
  }, [commands, query, strikeCommands]);

  React.useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered.length, active]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    c.run(actions());
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(filtered[active]);
    }
  };

  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <CenterContent title="Command palette">
        <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
          <Search className="size-4 shrink-0 text-fg-muted" strokeWidth={1.75} />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a view or strike…"
            className="h-6 w-full bg-transparent font-mono text-[13px] text-fg outline-none placeholder:text-fg-faint"
          />
          <span className="hidden shrink-0 rounded-sm border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-fg-muted sm:block">
            esc
          </span>
        </div>

        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <div className="px-3.5 py-6 text-center font-mono text-[11px] text-fg-faint">No matches</div>
          ) : (
            filtered.map((c, i) => {
              const Icon = c.icon;
              return (
                <button
                  key={c.id}
                  data-idx={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(c)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3.5 py-2 text-left transition-colors",
                    i === active ? "bg-surface-2" : "hover:bg-surface-2/50",
                  )}
                >
                  <Icon
                    className={cn("size-4 shrink-0", i === active ? "text-cyan" : "text-fg-muted")}
                    strokeWidth={1.75}
                  />
                  <span className={cn("flex-1 text-[12px]", i === active ? "text-fg" : "text-fg-secondary")}>
                    {c.label}
                  </span>
                  {c.hint ? (
                    <span className="font-mono text-[9px] uppercase tracking-wide text-fg-faint">{c.hint}</span>
                  ) : null}
                  {i === active ? <CornerDownLeft className="size-3 text-fg-muted" /> : null}
                </button>
              );
            })
          )}
        </div>
      </CenterContent>
    </Dialog>
  );
}
