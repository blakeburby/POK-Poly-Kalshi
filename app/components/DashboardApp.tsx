"use client";

import * as React from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDashboardStore, useDashboardStream } from "@/store/dashboard-store";
import { TopBar } from "@/components/shell/TopBar";
import { KpiStrip } from "@/components/shell/KpiStrip";
import { NavRail } from "@/components/shell/NavRail";
import { HealthRail } from "@/components/shell/HealthRail";
import { StatusBar } from "@/components/shell/StatusBar";
import { MobileNav } from "@/components/shell/MobileNav";
import { ViewRouter } from "@/components/views/ViewRouter";
import { StatusDot } from "@/components/ui/stat";

export default function DashboardApp({ dashboardName }: { dashboardName?: string }) {
  useDashboardStream();
  const snap = useDashboardStore((s) => s.snapshot);

  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={300}>
      <div className="flex h-dvh flex-col overflow-hidden bg-base text-fg">
        <TopBar />
        <KpiStrip />
        <div className="flex min-h-0 flex-1">
          <NavRail />
          <main className="min-w-0 flex-1 overflow-hidden bg-base">
            {snap ? <ViewRouter /> : <FeedDown name={dashboardName} />}
          </main>
          <HealthRail />
        </div>
        <StatusBar />
        <MobileNav />
      </div>
    </TooltipProvider>
  );
}

function FeedDown({ name }: { name?: string }) {
  const source = useDashboardStore((s) => s.source);
  return (
    <div className="bg-grid flex h-full flex-col items-center justify-center gap-3">
      <StatusDot tone={source === "degraded" ? "halt" : "idle"} pulse className="size-3" />
      <div className="text-center">
        <p className="font-mono text-[13px] uppercase tracking-[0.12em] text-fg-secondary">
          {source === "degraded" ? "Worker feed unreachable" : "Connecting to worker…"}
        </p>
        <p className="mt-1 font-mono text-[11px] text-fg-muted">
          {name ?? "POK Capital Terminal"} · awaiting snapshot stream
        </p>
        <p className="mt-3 font-mono text-[10px] text-fg-faint">append <span className="text-cyan">?demo=1</span> to load the demo feed</p>
      </div>
    </div>
  );
}
