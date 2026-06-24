"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { StatusTone } from "@/lib/format";

/**
 * Panel — the atomic terminal unit. 1px border, flat title bar with a left
 * status dot + mono uppercase label, tight body padding, no shadow.
 */

const toneDot: Record<StatusTone, string> = {
  live: "bg-live",
  stale: "bg-stale",
  halt: "bg-halt",
  idle: "bg-idle",
  info: "bg-cyan",
};

export function Panel({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-md border border-line bg-surface", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  dot,
  accent,
  right,
  className,
  pulse,
}: {
  title: string;
  dot?: StatusTone;
  accent?: string;
  right?: React.ReactNode;
  className?: string;
  pulse?: boolean;
}) {
  return (
    <div className={cn("flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface-2/60 px-3", className)}>
      {dot ? (
        <span className={cn("size-1.5 shrink-0 rounded-full", toneDot[dot], pulse && dot === "live" && "heartbeat")} />
      ) : null}
      <span
        className="min-w-0 truncate font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-fg-secondary"
        style={accent ? { color: accent } : undefined}
      >
        {title}
      </span>
      {right ? <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">{right}</div> : null}
    </div>
  );
}

export function PanelBody({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("min-h-0 flex-1 p-3", className)} {...props}>
      {children}
    </div>
  );
}
