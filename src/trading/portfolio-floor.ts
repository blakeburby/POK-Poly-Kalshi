import type { TradingActivitySnapshot, TradingPlatformActivity } from "../../types/trading";
import { venueAccountValue } from "./equity-sampler";
import { logEvent } from "../logger";

/**
 * Capital-floor circuit breaker (the single operator-enabled hardlock). Periodically reads the combined
 * Kalshi + Polymarket "Portfolio Value Total" (the SAME basis the dashboard shows, via venueAccountValue) and
 * LATCHES a halt when it falls below `floorDollars`. The latch is read by the scanner (pre-enqueue) and the
 * executor (pre-trade) in the same pre-short-circuit slot as the execution-quality gate, so it halts ALL
 * trading INDEPENDENT of LIVE_AUTO_HARDLOCKS_ENABLED.
 *
 * FAIL-OPEN (operator choice): it only latches on a CONFIRMED, AUTHORITATIVE reading below the floor — both
 * venues reporting live, non-stale, finite values. Any uncertain / partial / stale / unavailable read keeps
 * trading on last-known (never nuisance-halts), at the cost of not halting while it cannot see the balance.
 *
 * LATCHING: once tripped it stays halted regardless of the value recovering, until an operator clears it
 * (re-fund + restart, which re-derives at boot, or an explicit clear()). Disabled (floorDollars <= 0) is a
 * complete no-op: blockReason() returns null and tick() returns immediately (byte-identical to no breaker).
 */
export interface PortfolioFloorStatus {
  enabled: boolean;
  floorDollars: number;
  /** Combined total when the last reading was authoritative; null otherwise. */
  total: number | null;
  kalshiValue: number | null;
  polymarketValue: number | null;
  /** Both venues live + non-stale + finite on the last tick. */
  authoritative: boolean;
  kalshiLive: boolean;
  polymarketLive: boolean;
  breached: boolean;
  reason: string | null;
  /** Consecutive distinct sub-floor readings so far (latches at `confirmations`); lets an operator see how
   *  close a breach is to halting. ~10s/tick × confirmations, bounded by the ≤20s account cache. */
  consecutiveBreaches: number;
  confirmations: number;
  lastReadingAtMs: number | null;
}

export interface PortfolioFloorActivityProvider {
  getSnapshot(options: { now?: number }): Promise<TradingActivitySnapshot>;
}

const DEFAULT_CONFIRMATIONS = 2;

export class PortfolioFloorMonitor {
  private latched = false;
  private latchReason: string | null = null;
  private consecutiveBreaches = 0;
  /** Data timestamp of the last reading counted toward a breach, so N confirmations means N DISTINCT
   *  readings (not N re-reads of the same ≤20s-cached value). */
  private lastCountedReadingAtMs = 0;
  private lastStatus: PortfolioFloorStatus;

  constructor(
    private readonly tradingActivity: PortfolioFloorActivityProvider,
    private readonly floorDollars: number,
    private readonly confirmations: number = DEFAULT_CONFIRMATIONS,
  ) {
    this.lastStatus = {
      enabled: this.enabled,
      floorDollars,
      total: null,
      kalshiValue: null,
      polymarketValue: null,
      authoritative: false,
      kalshiLive: false,
      polymarketLive: false,
      breached: false,
      reason: null,
      consecutiveBreaches: 0,
      confirmations: this.confirmations,
      lastReadingAtMs: null,
    };
  }

  private get enabled(): boolean {
    return this.floorDollars > 0;
  }

  /** The gate read by the scanner + executor. Null when disabled or not breached. Disabled wins FIRST so a
   *  floorDollars<=0 deployment is byte-identical (never emits a block / hard_locked riskState). */
  blockReason(): string | null {
    if (!this.enabled) return null;
    return this.latched ? this.latchReason : null;
  }

  status(): PortfolioFloorStatus {
    return {
      ...this.lastStatus,
      enabled: this.enabled,
      breached: this.latched,
      reason: this.latchReason,
      consecutiveBreaches: this.consecutiveBreaches,
      confirmations: this.confirmations,
    };
  }

  /** Operator clear (after re-funding above the floor). Resets the latch + breach counter. */
  clear(): void {
    this.latched = false;
    this.latchReason = null;
    this.consecutiveBreaches = 0;
    this.lastCountedReadingAtMs = 0;
  }

  /** Periodic check. NEVER throws (fail-open: an internal error does not latch). */
  async tick(now: number): Promise<void> {
    if (!this.enabled) return;
    try {
      const snapshot = await this.tradingActivity.getSnapshot({ now });
      const kalshiValue = venueAccountValue(snapshot.kalshi);
      const polymarketValue = venueAccountValue(snapshot.polymarket);
      const kalshiLive = isAuthoritative(snapshot.kalshi, kalshiValue);
      const polymarketLive = isAuthoritative(snapshot.polymarket, polymarketValue);
      const authoritative = kalshiLive && polymarketLive;
      const total = authoritative ? (kalshiValue ?? 0) + (polymarketValue ?? 0) : null;
      this.lastStatus = {
        enabled: true,
        floorDollars: this.floorDollars,
        total,
        kalshiValue,
        polymarketValue,
        authoritative,
        kalshiLive,
        polymarketLive,
        breached: this.latched,
        reason: this.latchReason,
        consecutiveBreaches: this.consecutiveBreaches,
        confirmations: this.confirmations,
        lastReadingAtMs: now,
      };

      if (this.latched) return; // latching: stays halted until clear()
      if (!authoritative || total == null) {
        // FAIL-OPEN: cannot confirm the total -> keep trading on last-known, reset the breach streak.
        this.consecutiveBreaches = 0;
        return;
      }
      if (total >= this.floorDollars) {
        this.consecutiveBreaches = 0;
        return;
      }
      // Authoritative reading below the floor. Count only DISTINCT readings toward the confirmation streak (so
      // N confirmations means N real fetches, not re-reads of the ≤20s account cache). Fall back to the tick
      // clock `now` when the venue data timestamps are missing/0, so a stuck null timestamp can never freeze
      // the streak and silently prevent a latch.
      const readingAt = Math.max(snapshot.kalshi.lastUpdatedAt ?? 0, snapshot.polymarket.lastUpdatedAt ?? 0) || now;
      if (readingAt > this.lastCountedReadingAtMs || this.consecutiveBreaches === 0) {
        this.consecutiveBreaches += 1;
        this.lastCountedReadingAtMs = readingAt;
      }
      if (this.consecutiveBreaches >= this.confirmations) {
        this.latched = true;
        this.latchReason =
          `portfolio value floor breach: combined portfolio value $${total.toFixed(2)} below floor ` +
          `$${this.floorDollars.toFixed(2)} — trading halted (re-fund above the floor + restart/clear to resume)`;
        this.lastStatus = { ...this.lastStatus, breached: true, reason: this.latchReason };
        logEvent({
          severity: "ERROR",
          category: "EXECUTION",
          message: "portfolio value floor breach — trading halted",
          context: { total, floorDollars: this.floorDollars, kalshiValue, polymarketValue },
        });
      }
    } catch (error) {
      logEvent({
        severity: "WARN",
        category: "EXECUTION",
        message: "portfolio floor monitor tick failed (fail-open: not halting)",
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

/** A venue reading is authoritative for a breach decision only when its account source is live (not
 *  reconnecting), the value is not a carried-forward stale figure, and the value is finite. */
function isAuthoritative(activity: TradingPlatformActivity | null | undefined, value: number | null): boolean {
  if (!activity) return false;
  if (activity.connectionStatus !== "live") return false;
  if (activity.portfolio?.stale === true) return false;
  return value != null && Number.isFinite(value);
}
