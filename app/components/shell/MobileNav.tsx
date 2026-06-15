"use client";

import * as React from "react";
import { useDashboardStore } from "@/store/dashboard-store";
import { NAV } from "./nav-items";
import { cn } from "@/lib/utils";

/** Bottom tab bar for mobile/tablet (<lg). Horizontally scrollable across all 9 views. */
export function MobileNav() {
  const view = useDashboardStore((s) => s.view);
  const setView = useDashboardStore((s) => s.setView);
  const ref = React.useRef<HTMLDivElement>(null);

  // keep the active tab scrolled into view (also on first mount, so off-screen tabs are discoverable)
  React.useEffect(() => {
    const el = ref.current?.querySelector<HTMLButtonElement>('[data-active="true"]');
    el?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [view]);

  return (
    <nav className="shrink-0 border-t border-line bg-surface/95 backdrop-blur lg:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div
        ref={ref}
        className="flex items-stretch gap-1 overflow-x-auto px-1.5 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,transparent,black_3%,black_92%,transparent)]"
      >
        {NAV.map((n) => {
          const Icon = n.icon;
          const active = view === n.id;
          return (
            <button
              key={n.id}
              data-active={active}
              onClick={() => setView(n.id)}
              className={cn(
                "flex min-w-[58px] shrink-0 flex-col items-center gap-1 rounded-md px-2 py-1.5 transition-colors",
                active ? "bg-surface-2 text-fg ring-1 ring-cyan/25" : "text-fg-muted active:bg-surface-2/60",
              )}
            >
              <Icon className={cn("size-[18px]", active && "text-cyan")} strokeWidth={1.75} />
              <span className={cn("text-[9.5px] font-medium tracking-tight", active ? "text-fg" : "text-fg-muted")}>{n.short}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
