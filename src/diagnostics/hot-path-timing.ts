import { PerformanceObserver, performance } from "node:perf_hooks";

/**
 * Per-section hot-path timing + GC attribution, to find what is actually blocking the event loop (the
 * runtime-health probe surfaces THAT the loop lags; this surfaces WHY). Mirrors the single-sampler pattern of
 * runtime-health.ts. Measures SYNCHRONOUS (event-loop-blocking) work only — `time()` wraps sync sections;
 * GC pause time comes from a PerformanceObserver. Awaited work that yields the loop is NOT lag and is not
 * timed here. Off by flag → a true no-op (every entry point short-circuits before any clock read).
 */

export interface SectionTiming {
  count: number; // total invocations since enable
  meanMs: number; // over the windowed ring buffer
  p99Ms: number; // windowed
  maxMs: number; // all-time max since enable (worst single block)
}

export interface GcTiming {
  pauseMsTotal: number;
  count: number;
  pausePercent: number | null; // % of wall-clock spent in GC since enable
  maxPauseMs: number;
}

export interface HotPathTimings {
  sections: Record<string, SectionTiming>;
  gc: GcTiming | null;
}

const RING = 512;

interface SectionBuffer {
  samples: Float64Array;
  idx: number;
  len: number;
  total: number;
  max: number;
}

let enabled = false;
const buffers = new Map<string, SectionBuffer>();
let gcObserver: PerformanceObserver | null = null;
let gcStartMs: number | null = null;
let gcPauseMsTotal = 0;
let gcCount = 0;
let gcMaxPauseMs = 0;

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/** Enable/disable timing. When enabling, start the GC observer once. Idempotent. */
export function configureHotPathTiming(on: boolean): void {
  enabled = on;
  if (!on || gcObserver) return;
  try {
    gcStartMs = performance.now();
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcPauseMsTotal += entry.duration;
        gcCount += 1;
        if (entry.duration > gcMaxPauseMs) gcMaxPauseMs = entry.duration;
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
  } catch {
    gcObserver = null;
  }
}

export function isHotPathTimingEnabled(): boolean {
  return enabled;
}

function record(section: string, ms: number): void {
  let buffer = buffers.get(section);
  if (!buffer) {
    buffer = { samples: new Float64Array(RING), idx: 0, len: 0, total: 0, max: 0 };
    buffers.set(section, buffer);
  }
  buffer.samples[buffer.idx] = ms;
  buffer.idx = (buffer.idx + 1) % RING;
  if (buffer.len < RING) buffer.len += 1;
  buffer.total += 1;
  if (ms > buffer.max) buffer.max = ms;
}

/** Time a SYNCHRONOUS section. No-op (just calls fn) when disabled. */
export function time<T>(section: string, fn: () => T): T {
  if (!enabled) return fn();
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    record(section, performance.now() - startedAt);
  }
}

export function getHotPathTimings(): HotPathTimings | null {
  if (!enabled) return null;
  const sections: Record<string, SectionTiming> = {};
  for (const [name, buffer] of buffers) {
    if (buffer.len === 0) continue;
    const sorted = Array.from(buffer.samples.subarray(0, buffer.len)).sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const p99Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
    sections[name] = {
      count: buffer.total,
      meanMs: round(sum / sorted.length),
      p99Ms: round(sorted[p99Index] ?? 0),
      maxMs: round(buffer.max),
    };
  }
  const gc: GcTiming | null =
    gcStartMs == null
      ? null
      : {
          pauseMsTotal: round(gcPauseMsTotal),
          count: gcCount,
          pausePercent: round((gcPauseMsTotal / Math.max(1, performance.now() - gcStartMs)) * 100),
          maxPauseMs: round(gcMaxPauseMs),
        };
  return { sections, gc };
}

/** Test-only: clear all state and detach the observer. */
export function __resetHotPathTimingForTest(): void {
  enabled = false;
  buffers.clear();
  gcObserver?.disconnect();
  gcObserver = null;
  gcStartMs = null;
  gcPauseMsTotal = 0;
  gcCount = 0;
  gcMaxPauseMs = 0;
}
