import type { TradingActivitySnapshot } from "../../types/trading";
import type { NakedResidualRow } from "../db/signals";
import { logEvent } from "../logger";

/**
 * Async post-settlement naked-position flattener. Periodically MARKET-sells the unhedged Polymarket residuals
 * that the synchronous unwind could not flatten (e.g. the shares had not settled on-chain yet), then marks the
 * quarantine resolved. SAFE BY DESIGN: it sells ONLY the excess of a Polymarket token over its LIVE Kalshi
 * hedge, so it can never sell a hedged leg.
 *
 * - OPEN markets only (a resolved/expired position is a realized loss → redeem/reconcile, never sell).
 * - LIVE, MARKET-WIDE HEDGED FLOOR: the Polymarket buy holds BOTH the hedged and the naked shares under one
 *   (per-15-min-market) tokenId, and the hedge is the Kalshi NO leg. The flattener reads the AUTHORITATIVE,
 *   currently-held Kalshi NO contracts for the hedging ticker (the venue position is already aggregated across
 *   every sibling signal in that window) and keeps that many Polymarket shares as the floor — selling only
 *   `held_PM − liveKalshiNO`. This is re-evaluated LIVE every tick, which is the crux: the prior design froze a
 *   per-signal `min(kalshiFill, polymarketFill)` floor at record time, which was 0 whenever the deferred Kalshi
 *   hedge had not yet filled — so it dumped the entire fungible-token balance (the 2026-06-28 −$166 incident).
 * - FRESHNESS: if the Kalshi account snapshot is stale/missing (can't prove the hedge), SKIP — never sell.
 * - CONSISTENCY / RACE GATE: the genuine unhedged excess should be ≈ the recorded residual. If the observed
 *   excess is grossly larger (the Kalshi hedge is still mid-fill, or there is unexplained exposure), SKIP and
 *   wait — this bounds the blast radius to the recorded residual even if the live floor momentarily undercounts
 *   or the token→ticker join ever fails (it then fails SAFE: no sell).
 * - Never sells more than min(recorded residual, held − live hedged floor).
 * - Idempotent: a sold token is on a re-sell cooldown that outlasts the ~20s account-position cache, and the
 *   quarantine is resolved once reduced to the floor so it drops out of the work-list. Single-flight; never throws.
 */
export interface NakedResidualStore {
  listUnresolvedNakedResiduals(limit?: number): Promise<NakedResidualRow[]>;
  resolveNakedResidual(signalId: number, reason: string, evidence: Record<string, unknown>): Promise<void>;
}

export interface NakedPositionSeller {
  marketSellShares(
    tokenId: string,
    shares: number,
    options?: { clientOrderId?: string; timeoutMs?: number },
  ): Promise<{
    soldShares: number;
    sellPrice: number | null;
    orderId: string | null;
    status: string;
    error: string | null;
  }>;
}

export interface NakedFlattenActivityProvider {
  getSnapshot(options: { now?: number }): Promise<TradingActivitySnapshot>;
}

export interface NakedFlattenStatus {
  enabled: boolean;
  pendingResiduals: number;
  flattenedTotal: number;
  lastTickAtMs: number | null;
  lastError: string | null;
}

const DUST = 0.01;
const RESELL_COOLDOWN_MS = 60_000; // outlast the ~20s account-position cache so a sold token is never re-sold
// Race/consistency guard: the genuine unhedged excess (held_PM − liveKalshiNO) should be ≈ the recorded
// residual. If it exceeds residual × this factor (+ a small absolute tolerance) the Kalshi hedge is almost
// certainly still filling — skip and wait rather than sell into an incomplete hedge. 2× cleanly separates the
// normal aggregate-vs-single discrepancy (~1.1× in the −$166 incident) from a true mid-fill race (~3×+).
const MAX_EXCESS_RESIDUAL_FACTOR = 2;
const MAX_EXCESS_ABS_TOLERANCE_SHARES = 1;

export class NakedPositionFlattener {
  private running = false;
  private flattenedTotal = 0;
  private lastTickAtMs: number | null = null;
  private lastError: string | null = null;
  private pendingResiduals = 0;
  private readonly recentlySoldAt = new Map<string, number>();

  constructor(
    private readonly store: NakedResidualStore,
    private readonly activity: NakedFlattenActivityProvider,
    private readonly seller: NakedPositionSeller,
    private readonly enabled: boolean,
  ) {}

  status(): NakedFlattenStatus {
    return {
      enabled: this.enabled,
      pendingResiduals: this.pendingResiduals,
      flattenedTotal: this.flattenedTotal,
      lastTickAtMs: this.lastTickAtMs,
      lastError: this.lastError,
    };
  }

  /** Periodic sweep. Single-flight; NEVER throws. No-op when disabled. */
  async tick(now: number): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.lastTickAtMs = now;
    try {
      const residuals = await this.store.listUnresolvedNakedResiduals(50);
      this.pendingResiduals = residuals.length;
      if (residuals.length === 0) return;
      const snapshot = await this.activity.getSnapshot({ now });
      const heldByToken = new Map<string, number>();
      for (const pos of snapshot.polymarket?.positions ?? []) {
        if (pos.id) heldByToken.set(pos.id, (heldByToken.get(pos.id) ?? 0) + (pos.shares ?? 0));
      }
      // LIVE, market-wide hedged floor: authoritative Kalshi NO contracts held per ticker (the venue position
      // is already netted across every sibling signal in the window). Only trust it when the Kalshi account
      // snapshot is fresh — a stale/reconnecting fetch could undercount the hedge and un-hedge a live leg.
      const kalshi = snapshot.kalshi;
      const kalshiFresh = kalshi?.connectionStatus === "live" && kalshi?.portfolio?.stale !== true;
      const kalshiNoHeldByTicker = new Map<string, number>();
      for (const pos of kalshi?.positions ?? []) {
        if (pos.market && (pos.outcome ?? "").toUpperCase() === "NO") {
          kalshiNoHeldByTicker.set(pos.market, (kalshiNoHeldByTicker.get(pos.market) ?? 0) + (pos.shares ?? 0));
        }
      }
      for (const residual of residuals) {
        try {
          await this.flattenOne(residual, heldByToken, kalshiNoHeldByTicker, kalshiFresh, now);
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logEvent({
        severity: "WARN",
        category: "EXECUTION",
        message: "naked flattener tick failed",
        context: { error: this.lastError },
      });
    } finally {
      this.running = false;
    }
  }

  private async flattenOne(
    residual: NakedResidualRow,
    heldByToken: Map<string, number>,
    kalshiNoHeldByTicker: Map<string, number>,
    kalshiFresh: boolean,
    now: number,
  ): Promise<void> {
    // OPEN markets only — a resolved/expired position is a realized loss (redeem/reconcile, never a sell).
    if (residual.expiryMs != null && now >= residual.expiryMs) return;
    // Re-sell cooldown: never re-sell a token we just sold; the ~20s position cache may still show the pre-sell
    // balance, so this is the idempotency guard against a double-sell across ticks.
    const soldAt = this.recentlySoldAt.get(residual.nakedTokenId);
    if (soldAt != null && now - soldAt < RESELL_COOLDOWN_MS) return;
    const held = heldByToken.get(residual.nakedTokenId) ?? 0;
    if (held <= DUST) return; // shares not settled yet, or already gone -> retry next tick
    // FRESHNESS: the floor is the LIVE Kalshi NO held; if the Kalshi snapshot is stale/reconnecting we cannot
    // prove the hedge — SKIP rather than risk un-hedging on an undercounted floor. Retry next tick.
    if (!kalshiFresh) return;
    // The hedging Kalshi ticker must be known to look up the live NO floor. Unmapped (legacy/missing) -> SKIP.
    if (!residual.kalshiContractId) return;
    // LIVE, MARKET-WIDE HEDGED FLOOR: the authoritative Kalshi NO contracts held for the hedging ticker (already
    // netted across every sibling signal). The Polymarket buy holds both the hedged and the naked shares under
    // this ONE tokenId, so we may only sell the portion ABOVE this floor — keeping the shares matched to the
    // live Kalshi leg. Re-read every tick: a deferred hedge that fills later raises the floor and stops the sell.
    const floor = Math.max(0, kalshiNoHeldByTicker.get(residual.kalshiContractId) ?? 0);
    const excess = Math.max(0, held - floor);
    if (excess <= DUST) {
      // Held is at/below the live Kalshi hedge — fully hedged, no naked excess. Resolve so it drops out of the
      // work-list; this is also the backstop that ends the loop after a full flatten.
      await this.resolve(residual, now, 0, null, null, "naked residual already flat at live hedged floor");
      return;
    }
    // CONSISTENCY / RACE GATE: the genuine unhedged excess should be ≈ the recorded residual. A much larger
    // excess means the Kalshi hedge is still mid-fill (the residual was captured before the deferred leg filled)
    // or there is unexplained exposure — either way, selling now could un-hedge a leg that is about to fill, so
    // wait. This bounds the total ever sold to ~the recorded residual even if the live floor momentarily
    // undercounts or the token→ticker join fails (it then fails SAFE: no sell).
    const maxExcess = residual.nakedResidualShares * MAX_EXCESS_RESIDUAL_FACTOR + MAX_EXCESS_ABS_TOLERANCE_SHARES;
    if (excess > maxExcess) {
      this.lastError = `naked excess ${excess.toFixed(2)} > ${maxExcess.toFixed(2)} (residual ${residual.nakedResidualShares.toFixed(2)}, live Kalshi NO floor ${floor.toFixed(2)}) — hedge likely incomplete, skipping`;
      logEvent({
        severity: "WARN",
        category: "EXECUTION",
        message: "naked flatten skipped: excess exceeds recorded residual (hedge likely still filling)",
        context: {
          signalId: residual.id,
          tokenId: residual.nakedTokenId,
          kalshiTicker: residual.kalshiContractId,
          heldPolymarket: held,
          liveKalshiNoFloor: floor,
          excess,
          recordedResidual: residual.nakedResidualShares,
        },
      });
      return;
    }
    const sellShares = Math.min(residual.nakedResidualShares, excess);
    if (sellShares <= DUST) return;

    const outcome = await this.seller.marketSellShares(residual.nakedTokenId, sellShares, {
      clientOrderId: `flatten-${residual.id}`,
    });
    if (outcome.soldShares <= DUST) {
      this.lastError = outcome.error ?? "naked flatten sold 0";
      return; // nothing moved -> no cooldown, retry next tick (no double-sell risk)
    }
    this.recentlySoldAt.set(residual.nakedTokenId, now);
    // Reduce the local held tally so a second residual on the same token this tick cannot oversell.
    const remainingHeld = Math.max(0, held - outcome.soldShares);
    heldByToken.set(residual.nakedTokenId, remainingHeld);
    this.flattenedTotal += 1;
    logEvent({
      severity: "INFO",
      category: "EXECUTION",
      message: "naked position flattened at market",
      context: {
        signalId: residual.id,
        tokenId: residual.nakedTokenId,
        kalshiTicker: residual.kalshiContractId,
        soldShares: outcome.soldShares,
        sellPrice: outcome.sellPrice,
        orderId: outcome.orderId,
        // The live, market-wide Kalshi NO held — the hedged floor the Polymarket position is kept at or above.
        liveKalshiNoFloor: floor,
      },
    });
    // Resolve the quarantine only when the position is now reduced to the live hedged floor (the naked excess
    // is sold). A partial fill leaves it quarantined and the next tick (after cooldown) sells the remainder.
    if (remainingHeld - floor <= DUST) {
      await this.resolve(residual, now, outcome.soldShares, outcome.sellPrice, outcome.orderId, null);
    }
  }

  private async resolve(
    residual: NakedResidualRow,
    now: number,
    soldShares: number,
    sellPrice: number | null,
    orderId: string | null,
    note: string | null,
  ): Promise<void> {
    const reason = note ?? `naked residual flattened at market: sold ${soldShares} @ ${sellPrice ?? "?"}`;
    await this.store.resolveNakedResidual(residual.id, reason, {
      soldShares,
      sellPrice,
      orderId,
      tokenId: residual.nakedTokenId,
      kalshiTicker: residual.kalshiContractId,
      flattenedAtMs: now,
    });
  }
}
