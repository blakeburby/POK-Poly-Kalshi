"use client";

import * as React from "react";
import { useDashboardStore } from "@/store/dashboard-store";
import { SECTIONS, sectionOf } from "@/components/shell/nav-items";
import { ViewRouter } from "./ViewRouter";
import { cn } from "@/lib/utils";

/**
 * Renders the active primary section: a contextual sub-tab bar (the section's child views) above
 * the leaf content (delegated to the existing ViewRouter). This is what turns the flat 16-tab rail
 * into 5 sections each with a few sub-views — without changing how any individual view renders.
 */
export function SectionShell() {
  const view = useDashboardStore((s) => s.view);
  const setView = useDashboardStore((s) => s.setView);

  const section = SECTIONS.find((s) => s.id === sectionOf(view));
  const items = section?.items ?? [];
  const showSubTabs = items.length > 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showSubTabs ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-surface/60 px-2 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((it) => {
            const Icon = it.icon;
            const active = view === it.id;
            return (
              <button
                key={it.id}
                onClick={() => setView(it.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-sm px-2.5 py-1 font-mono text-[11px] tracking-wide transition-colors",
                  active
                    ? "bg-surface-2 text-fg ring-1 ring-cyan/25"
                    : "text-fg-muted hover:bg-surface-2/50 hover:text-fg-secondary",
                )}
              >
                <Icon className={cn("size-3.5", active && "text-cyan")} strokeWidth={1.75} />
                {it.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <ViewRouter />
      </div>
    </div>
  );
}
