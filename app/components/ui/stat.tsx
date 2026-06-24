"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { clamp01, type StatusTone } from "@/lib/format";

const toneColor: Record<StatusTone, string> = {
  live: "bg-live",
  stale: "bg-stale",
  halt: "bg-halt",
  idle: "bg-idle",
  info: "bg-cyan",
};

export function StatusDot({ tone, pulse, className }: { tone: StatusTone; pulse?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        toneColor[tone],
        pulse && tone === "live" && "heartbeat",
        className,
      )}
    />
  );
}

/** Section micro-label. */
export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("font-mono text-[10px] uppercase tracking-[0.12em] text-fg-muted", className)}>{children}</span>
  );
}

/** A single labeled scalar (label over value). */
export function Metric({
  label,
  value,
  sub,
  valueClassName,
  className,
  align = "left",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueClassName?: string;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", align === "right" && "items-end text-right", className)}>
      <Label>{label}</Label>
      <span className={cn("font-mono text-[13px] tabular-nums text-fg", valueClassName)}>{value}</span>
      {sub != null ? <span className="font-mono text-[10px] text-fg-muted">{sub}</span> : null}
    </div>
  );
}

/** Horizontal utilization / bar-in-cell. value 0..1. */
export function MiniBar({
  value,
  tone = "info",
  className,
  trackClassName,
}: {
  value: number;
  tone?: StatusTone | "violet" | "kalshi" | "poly";
  className?: string;
  trackClassName?: string;
}) {
  const pct = clamp01(value) * 100;
  const fill =
    tone === "violet"
      ? "bg-violet"
      : tone === "kalshi"
        ? "bg-kalshi"
        : tone === "poly"
          ? "bg-poly"
          : toneColor[tone as StatusTone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", trackClassName, className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-300", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Utilization bullet bar with a limit marker, green->amber->red as it fills. */
export function UtilBar({
  value,
  warn = 0.7,
  crit = 0.9,
  className,
}: {
  value: number;
  warn?: number;
  crit?: number;
  className?: string;
}) {
  const v = clamp01(value);
  const tone: StatusTone = v >= crit ? "halt" : v >= warn ? "stale" : "live";
  return <MiniBar value={v} tone={tone} className={className} />;
}

/** Tiny inline sparkline from numeric series. */
export function Sparkline({
  data,
  width = 72,
  height = 22,
  stroke,
  className,
  fill = true,
}: {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  className?: string;
  fill?: boolean;
}) {
  if (!data || data.length < 2) {
    return <div style={{ width, height }} className={className} />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const stepX = width / (data.length - 1);
  const pts = data.map((d, i) => {
    const x = i * stepX;
    const y = height - ((d - min) / span) * (height - 2) - 1;
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = data[data.length - 1];
  const first = data[0];
  const color = stroke ?? (last >= first ? "var(--color-up)" : "var(--color-down)");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const gid = React.useId();
  return (
    <svg
      width={width}
      height={height}
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      {fill ? (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gid})`} />
        </>
      ) : null}
      <path d={line} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Empty({ children = "No data", className }: { children?: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-full min-h-20 w-full items-center justify-center font-mono text-[11px] text-fg-faint",
        className,
      )}
    >
      {children}
    </div>
  );
}
