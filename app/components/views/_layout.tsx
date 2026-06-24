"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Panel, PanelHeader, PanelBody } from "@/components/ui/panel";
import { Label } from "@/components/ui/stat";
import type { StatusTone } from "@/lib/format";

/** Scrollable view container. */
export function ViewScroll({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("h-full overflow-y-auto p-3", className)}>
      <div className="mx-auto flex max-w-[2200px] flex-col gap-3">{children}</div>
    </div>
  );
}

/** 12-column dense grid. */
export function Grid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-12 gap-3", className)}>{children}</div>;
}

/** A panel that snaps to a column span. */
export function GridPanel({
  title,
  dot,
  accent,
  right,
  span = 12,
  rows,
  bodyClassName,
  className,
  children,
  pulse,
}: {
  title: string;
  dot?: StatusTone;
  accent?: string;
  right?: React.ReactNode;
  span?: number;
  rows?: number;
  bodyClassName?: string;
  className?: string;
  children: React.ReactNode;
  pulse?: boolean;
}) {
  return (
    <Panel className={cn(spanClass(span), className)} style={rows ? { minHeight: rows * 100 } : undefined}>
      <PanelHeader title={title} dot={dot} accent={accent} right={right} pulse={pulse} />
      <PanelBody className={bodyClassName}>{children}</PanelBody>
    </Panel>
  );
}

/** Compact scalar tile (label + big value). */
export function StatTile({
  label,
  value,
  tone,
  sub,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: "up" | "down" | "neutral" | "amber" | "cyan";
  sub?: React.ReactNode;
  className?: string;
}) {
  const toneClass =
    tone === "up"
      ? "text-up"
      : tone === "down"
        ? "text-down"
        : tone === "amber"
          ? "text-amber"
          : tone === "cyan"
            ? "text-cyan"
            : "text-fg";
  return (
    <div className={cn("flex flex-col gap-1 rounded-md border border-line bg-surface px-3 py-2.5", className)}>
      <Label>{label}</Label>
      <span className={cn("font-mono text-[17px] tabular-nums leading-none", toneClass)}>{value}</span>
      {sub != null ? <span className="font-mono text-[10px] text-fg-muted">{sub}</span> : null}
    </div>
  );
}

function spanClass(span: number): string {
  const map: Record<number, string> = {
    1: "col-span-12 sm:col-span-2 xl:col-span-1",
    2: "col-span-6 sm:col-span-4 xl:col-span-2",
    3: "col-span-12 sm:col-span-6 xl:col-span-3",
    4: "col-span-12 sm:col-span-6 xl:col-span-4",
    5: "col-span-12 lg:col-span-5",
    6: "col-span-12 lg:col-span-6",
    7: "col-span-12 lg:col-span-7",
    8: "col-span-12 lg:col-span-8",
    9: "col-span-12 lg:col-span-9",
    10: "col-span-12 lg:col-span-10",
    12: "col-span-12",
  };
  return map[span] ?? "col-span-12";
}

export { spanClass };
