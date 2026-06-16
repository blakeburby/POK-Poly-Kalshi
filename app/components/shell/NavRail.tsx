"use client";

import * as React from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useDashboardStore } from "@/store/dashboard-store";
import { NAV } from "./nav-items";
import { cn } from "@/lib/utils";

export function NavRail() {
  const view = useDashboardStore((s) => s.view);
  const setView = useDashboardStore((s) => s.setView);
  const [collapsed, setCollapsed] = React.useState(false);

  // keyboard shortcuts 1-9 (desktop)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const hit = NAV.find((n) => n.hot === e.key);
      if (hit) setView(hit.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  return (
    <nav
      className={cn(
        "hidden shrink-0 flex-col gap-1 border-r border-line bg-surface/60 p-2 transition-[width] duration-200 lg:flex",
        collapsed ? "w-[var(--rail-w-collapsed)]" : "w-[var(--rail-w)]",
      )}
    >
      {NAV.map((n) => {
        const Icon = n.icon;
        const active = view === n.id;
        return (
          <button
            key={n.id}
            onClick={() => setView(n.id)}
            title={n.label}
            className={cn(
              "group flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors",
              active ? "bg-surface-2 text-fg ring-1 ring-cyan/25" : "text-fg-muted hover:bg-surface-2/50 hover:text-fg-secondary",
            )}
          >
            <Icon className={cn("size-4 shrink-0", active && "text-cyan")} strokeWidth={1.75} />
            {!collapsed && <span className="flex-1 truncate text-[12px] font-medium tracking-tight">{n.label}</span>}
            {!collapsed && <span className="font-mono text-[9px] text-fg-faint group-hover:text-fg-muted">{n.hot}</span>}
          </button>
        );
      })}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="mt-auto flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-fg-faint transition-colors hover:bg-surface-2/50 hover:text-fg-muted"
        title={collapsed ? "Expand" : "Collapse"}
      >
        {collapsed ? <PanelLeftOpen className="size-4" strokeWidth={1.75} /> : <PanelLeftClose className="size-4" strokeWidth={1.75} />}
        {!collapsed && <span className="text-[11px]">Collapse</span>}
      </button>
    </nav>
  );
}
