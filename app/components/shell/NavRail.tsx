"use client";

import * as React from "react";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useDashboardStore } from "@/store/dashboard-store";
import { NAV, SECTIONS, sectionOf } from "./nav-items";
import { cn } from "@/lib/utils";

export function NavRail() {
  const view = useDashboardStore((s) => s.view);
  const setView = useDashboardStore((s) => s.setView);
  const setCommandOpen = useDashboardStore((s) => s.setCommandOpen);
  const [collapsed, setCollapsed] = React.useState(false);
  const activeSection = sectionOf(view);

  // Global hotkeys: digits 1-5 select a primary section; letters jump straight to a leaf view.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const section = SECTIONS.find((s) => s.hot === e.key);
      if (section) {
        setView(section.defaultView);
        return;
      }
      const leaf = NAV.find((n) => n.hot === e.key && /[a-z]/i.test(n.hot));
      if (leaf) setView(leaf.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  return (
    <nav
      className={cn(
        "hidden shrink-0 flex-col border-r border-line bg-surface/60 p-2 transition-[width] duration-200 lg:flex",
        collapsed ? "w-[var(--rail-w-collapsed)]" : "w-[var(--rail-w)]",
      )}
    >
      <button
        onClick={() => setCommandOpen(true)}
        title="Search · ⌘K"
        className="group mb-2 flex items-center gap-2.5 rounded-sm border border-line bg-surface-2/40 px-2.5 py-2 text-left text-fg-muted transition-colors hover:border-line-strong hover:text-fg-secondary"
      >
        <Search className="size-4 shrink-0" strokeWidth={1.75} />
        {!collapsed && <span className="flex-1 truncate text-[12px] tracking-tight">Search</span>}
        {!collapsed && (
          <span className="font-mono text-[9px] tracking-wide text-fg-faint group-hover:text-fg-muted">⌘K</span>
        )}
      </button>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const active = activeSection === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setView(s.defaultView)}
              title={s.label}
              className={cn(
                "group flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors",
                active
                  ? "bg-surface-2 text-fg ring-1 ring-cyan/25"
                  : "text-fg-muted hover:bg-surface-2/50 hover:text-fg-secondary",
              )}
            >
              <Icon className={cn("size-4 shrink-0", active && "text-cyan")} strokeWidth={1.75} />
              {!collapsed && <span className="flex-1 truncate text-[12px] font-medium tracking-tight">{s.label}</span>}
              {!collapsed && (
                <span className="font-mono text-[9px] text-fg-faint group-hover:text-fg-muted">{s.hot}</span>
              )}
            </button>
          );
        })}
      </div>

      <button
        onClick={() => setCollapsed((c) => !c)}
        className="mt-1 flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-fg-faint transition-colors hover:bg-surface-2/50 hover:text-fg-muted"
        title={collapsed ? "Expand" : "Collapse"}
      >
        {collapsed ? (
          <PanelLeftOpen className="size-4" strokeWidth={1.75} />
        ) : (
          <PanelLeftClose className="size-4" strokeWidth={1.75} />
        )}
        {!collapsed && <span className="text-[11px]">Collapse</span>}
      </button>
    </nav>
  );
}
