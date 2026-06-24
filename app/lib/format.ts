/**
 * Formatting + shared display primitives for the terminal.
 * Numerics are tabular-mono; PnL/edge always carry an explicit sign.
 */

export type StatusTone = "live" | "stale" | "halt" | "idle" | "info";
export type Sign = "up" | "down" | "flat";

const FINITE = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

export function signOf(v: number | null | undefined, eps = 1e-9): Sign {
  if (!FINITE(v)) return "flat";
  if (v > eps) return "up";
  if (v < -eps) return "down";
  return "flat";
}

export function signClass(v: number | null | undefined): string {
  const s = signOf(v);
  return s === "up" ? "text-up" : s === "down" ? "text-down" : "text-fg-secondary";
}

export function dash(): string {
  return "–";
}

/** Whole-dollar / large currency. */
export function fmtUsd(v: number | null | undefined, opts?: { decimals?: number; sign?: boolean }): string {
  if (!FINITE(v)) return dash();
  const decimals = opts?.decimals ?? (Math.abs(v) >= 1000 ? 0 : 2);
  const body = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sign = opts?.sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : v < 0 ? "−" : "";
  return `${sign}$${body}`;
}

/** Per-share contract dollars (0..1 range) shown with cent precision. */
export function fmtContractUsd(v: number | null | undefined, sign = false): string {
  if (!FINITE(v)) return dash();
  const s = sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : v < 0 ? "−" : "";
  return `${s}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
}

/** Price/premium as cents (0..1 -> "64.2¢"). */
export function fmtCents(v: number | null | undefined, sign = false): string {
  if (!FINITE(v)) return dash();
  const c = v * 100;
  const s = sign ? (c > 0 ? "+" : c < 0 ? "−" : "") : c < 0 ? "−" : "";
  return `${s}${Math.abs(c).toFixed(1)}¢`;
}

/** Fraction 0..1 -> percent. */
export function fmtPct(v: number | null | undefined, decimals = 1, sign = false): string {
  if (!FINITE(v)) return dash();
  const p = v * 100;
  const s = sign ? (p > 0 ? "+" : p < 0 ? "−" : "") : p < 0 ? "−" : "";
  return `${s}${Math.abs(p).toFixed(decimals)}%`;
}

/** Already-percent value -> percent. */
export function fmtPctRaw(v: number | null | undefined, decimals = 1, sign = false): string {
  if (!FINITE(v)) return dash();
  const s = sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : v < 0 ? "−" : "";
  return `${s}${Math.abs(v).toFixed(decimals)}%`;
}

export function fmtNum(v: number | null | undefined, decimals = 0): string {
  if (!FINITE(v)) return dash();
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtMs(v: number | null | undefined): string {
  if (!FINITE(v)) return dash();
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${Math.round(v)}ms`;
}

export function fmtInt(v: number | null | undefined): string {
  if (!FINITE(v)) return dash();
  return Math.round(v).toLocaleString("en-US");
}

export function fmtClock(ms: number | null | undefined, withMs = false): string {
  if (!FINITE(ms)) return dash();
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return withMs ? `${hh}:${mm}:${ss}.${String(d.getMilliseconds()).padStart(3, "0")}` : `${hh}:${mm}:${ss}`;
}

export function fmtRelative(ms: number | null | undefined, now = Date.now()): string {
  if (!FINITE(ms)) return dash();
  const delta = Math.max(0, now - ms);
  if (delta < 1000) return "now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!FINITE(ms)) return dash();
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

export function ageTone(ageMs: number | null | undefined, staleMs: number): StatusTone {
  if (!FINITE(ageMs)) return "idle";
  if (ageMs > staleMs * 2) return "halt";
  if (ageMs > staleMs) return "stale";
  return "live";
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
