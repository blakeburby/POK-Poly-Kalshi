"use client";

import * as React from "react";
import { Activity } from "lucide-react";
import { Dialog, DialogTrigger, BottomSheetContent } from "@/components/ui/dialog";
import { HealthRailBody } from "./HealthRail";
import { useDashboardStore } from "@/store/dashboard-store";
import { operationalStatus } from "@/lib/selectors";
import { StatusDot } from "@/components/ui/stat";
import { cn } from "@/lib/utils";

/** Mobile-only button in the TopBar that opens the strategy-health rail as a bottom sheet. */
export function MobileHealthSheet() {
  const snap = useDashboardStore((s) => s.snapshot);
  const op = snap ? operationalStatus(snap) : null;
  const tone = op?.tone ?? "idle";

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          aria-label="Strategy health"
          className={cn(
            "flex min-h-9 min-w-9 items-center justify-center gap-1.5 rounded-sm border px-2 lg:hidden",
            tone === "live" ? "border-up/30 bg-up/5" : tone === "halt" ? "border-down/40 bg-down/10" : "border-amber/30 bg-amber/5",
          )}
        >
          <Activity className="size-3.5 text-fg-secondary" strokeWidth={1.75} />
          <StatusDot tone={tone} pulse={tone === "live"} className="size-1.5" />
        </button>
      </DialogTrigger>
      <BottomSheetContent title="Strategy Health" className="lg:hidden">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Activity className="size-4 text-cyan" strokeWidth={1.75} />
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-secondary">Strategy Health</span>
        </div>
        <HealthRailBody />
      </BottomSheetContent>
    </Dialog>
  );
}
