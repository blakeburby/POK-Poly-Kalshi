import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { readFileSync } from "node:fs";

/**
 * Lightweight runtime-health probes so a CPU throttle / event-loop stall is IMMEDIATELY visible (in logs and
 * on the /health endpoint) instead of silently halting trading. This exists because a Lightsail burst-credit
 * exhaustion (~80% CPU steal) once starved the event loop for hours with no surfaced signal.
 *
 * A single caller (the worker's watchdog timer) calls sampleRuntimeHealth() on a fixed cadence so the
 * /proc/stat steal delta is consistent; everything else reads the cached value via getRuntimeHealth().
 */

export interface RuntimeHealth {
  eventLoopLagMeanMs: number;
  eventLoopLagP99Ms: number;
  /** CPU steal % over the last sample interval (Linux only; null elsewhere / first sample). */
  cpuStealPercent: number | null;
}

let histogram: IntervalHistogram | null = null;
let latest: RuntimeHealth | null = null;
let lastStat: { steal: number; total: number } | null = null;

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/** Start sampling event-loop delay. Idempotent. */
export function startRuntimeHealthMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
}

function readCpuStealPercent(): number | null {
  try {
    const firstLine = readFileSync("/proc/stat", "utf8").split("\n", 1)[0] ?? "";
    // "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
    const fields = firstLine.trim().split(/\s+/);
    if (fields[0] !== "cpu") return null;
    const nums = fields.slice(1).map((v) => Number(v)).filter((n) => Number.isFinite(n));
    if (nums.length < 8) return null;
    const steal = nums[7] ?? 0;
    const total = nums.reduce((a, b) => a + b, 0);
    const prev = lastStat;
    lastStat = { steal, total };
    if (!prev) return null; // need a baseline first
    const dSteal = steal - prev.steal;
    const dTotal = total - prev.total;
    return dTotal > 0 ? round((dSteal / dTotal) * 100) : null;
  } catch {
    return null;
  }
}

/** Sample event-loop lag + CPU steal over the interval since the last sample, cache it, and reset the
 *  histogram window. Call from ONE periodic timer only. */
export function sampleRuntimeHealth(): RuntimeHealth {
  const meanMs = histogram ? round(histogram.mean / 1e6) : 0;
  const p99Ms = histogram ? round(histogram.percentile(99) / 1e6) : 0;
  histogram?.reset();
  latest = { eventLoopLagMeanMs: meanMs, eventLoopLagP99Ms: p99Ms, cpuStealPercent: readCpuStealPercent() };
  return latest;
}

/** Last sampled runtime health (for the /health endpoint); null until the first sample. */
export function getRuntimeHealth(): RuntimeHealth | null {
  return latest;
}
