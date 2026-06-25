import type { TradingActivitySnapshot } from "../../types/trading";
import type { NakedResidualRow } from "../db/signals";
import { logEvent } from "../logger";

/**
 * Async post-settlement naked-position flattener. Periodically MARKET-sells the unhedged Polymarket residuals
 * that the synchronous unwind could not flatten (e.g. the shares had not settled on-chain yet), then marks the
 * quarantine resolved. SAFE BY DESIGN: it acts ONLY on the RECORDED one-sided residual (exact tokenId + share
 * count captured at fill time, in recovery_evidence.autoUnwind), cross-checked against the ACTUALLY-held
 * shares — it never raw-scans positions, so it can never sell a hedged leg (the arb holds both hedged legs to
 * expiry; those are different tokenIds that are never recorded as naked).
 *
 * - OPEN markets only (a resolved/expired position is a realized loss → redeem/reconcile, never sell).
 * - HEDGED FLOOR: the Polymarket buy holds BOTH the hedged and the naked shares under the same tokenId (the
 *   hedge is the Kalshi leg), so the flattener only ever sells the portion ABOVE the recorded hedged-retained
 *   count and reduces the position toward — never below — that floor. This bounds the total sold to the naked
 *   excess across any number of ticks/partials and makes it structurally impossible to re-sell the matched pair.
 * - Never sells more than min(recorded residual, held − hedged floor).
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
      for (const residual of residuals) {
        try {
          await this.flattenOne(residual, heldByToken, now);
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

  private async flattenOne(residual: NakedResidualRow, heldByToken: Map<string, number>, now: number): Promise<void> {
    // OPEN markets only — a resolved/expired position is a realized loss (redeem/reconcile, never a sell).
    if (residual.expiryMs != null && now >= residual.expiryMs) return;
    // Re-sell cooldown: never re-sell a token we just sold; the ~20s position cache may still show the pre-sell
    // balance, so this is the idempotency guard against a double-sell across ticks.
    const soldAt = this.recentlySoldAt.get(residual.nakedTokenId);
    if (soldAt != null && now - soldAt < RESELL_COOLDOWN_MS) return;
    const held = heldByToken.get(residual.nakedTokenId) ?? 0;
    if (held <= DUST) return; // shares not settled yet, or already gone -> retry next tick
    // HEDGED FLOOR: the Polymarket buy holds both the hedged and the naked shares under this ONE tokenId, so we
    // may only sell the portion ABOVE the hedged retained count — reducing the position toward (never below) the
    // shares matched against the Kalshi leg. `held - floor` shrinks as we sell, so this bounds the TOTAL sold to
    // the naked excess across any number of ticks/partials and makes re-selling the matched pair impossible.
    // A null floor means the residual predates floor-recording — SKIP it (selling with an assumed 0 floor would
    // un-hedge the matched pair); reconciliation/expiry handles those legacy rows instead.
    if (residual.retainedShares == null) return;
    const floor = Math.max(0, residual.retainedShares);
    const sellable = Math.max(0, held - floor);
    if (sellable <= DUST) {
      // Position is already reduced to (or below) the hedged floor — the naked excess is gone. Resolve so it
      // drops out of the work-list; this is also the backstop that ends the loop after a full flatten.
      await this.resolve(residual, now, 0, null, null, "naked residual already flat at hedged floor");
      return;
    }
    const sellShares = Math.min(residual.nakedResidualShares, sellable);
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
        soldShares: outcome.soldShares,
        sellPrice: outcome.sellPrice,
        orderId: outcome.orderId,
        retainedFloor: floor,
      },
    });
    // Resolve the quarantine only when the position is now reduced to the hedged floor (the naked excess is
    // sold). A partial fill leaves it quarantined and the next tick (after cooldown) sells the remainder.
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
      retainedFloor: Math.max(0, residual.retainedShares ?? 0),
      flattenedAtMs: now,
    });
  }
}
