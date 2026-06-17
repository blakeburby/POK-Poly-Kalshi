import type { LiveExecutionLockWriter } from "../db/live-execution-locks";
import type { VenueOrderEventInput, VenueOrderEventListener } from "../db/venue-order-events";
import type {
  ArbCandidate,
  ArbLeg,
  ReconciliationReadiness,
  UserStreamReadiness,
  UserStreamVenueState,
  Venue,
} from "../types";
import type { VenueOrderResult } from "./live-clients";

export interface VenueOrderEventSource {
  onEvent(listener: VenueOrderEventListener): () => void;
}

export interface LiveSignalReconciliationStore {
  liveReconciliationBlockReason(candidate: ArbCandidate, now: number, maxUnresolvedExposureDollars?: number): Promise<string | null>;
  liveRiskQuarantineStatus?(): Promise<{ total: number; count: number }>;
}

export interface VenueConfirmationResult {
  venue: Venue;
  status: "confirmed" | "timeout" | "mismatch" | "failed" | "not_required";
  reason: string | null;
  clientOrderId: string | null;
  venueOrderId: string | null;
  fillCount: number | null;
  fillPrice: number | null;
  fee: number | null;
  exchangeTimestampMs: number | null;
  receivedAtMs: number | null;
  eventType: string | null;
}

export interface VenueConfirmationMonitor {
  userStreamReadiness(now?: number): UserStreamReadiness;
  reconciliationReadiness(now?: number): ReconciliationReadiness;
  preflight(candidate: ArbCandidate, now?: number): Promise<string | null>;
  waitForVenueResult(
    result: VenueOrderResult,
    options: { executionGroupId: string; expectedSize: number; leg: ArbLeg; submittedAtMs: number; timeoutMs: number },
  ): Promise<VenueConfirmationResult>;
}

interface PendingConfirmation {
  result: VenueOrderResult;
  executionGroupId: string;
  expectedSize: number;
  leg: ArbLeg;
  submittedAtMs: number;
  resolve: (confirmation: VenueConfirmationResult) => void;
  timeout: NodeJS.Timeout;
}

interface KnownOrder {
  executionGroupId: string;
  expectedSize: number;
  venue: Venue;
  // The executor's REST-confirmed fill for this order (the fill it floor-hedged + reconciled). A user-stream
  // event reporting a fill AT OR BELOW this (an intermediate partial, or a duplicate/in-tolerance overfill)
  // is consistent with what the executor accounted for and must NOT trip the breaker. A stream event
  // revealing MORE than this (a genuine surplus the executor never booked) still locks. Unset for orders the
  // executor never confirmed (e.g. a timeout/no-fill), so any surprise stream fill there is strictly locked.
  reconciledFillCount?: number;
}

function disabledVenueState(): UserStreamVenueState {
  return {
    enabled: false,
    connected: false,
    subscribed: false,
    reason: "user streams disabled",
    lastConnectedAt: null,
    lastEventAt: null,
    lastError: null,
  };
}

export function buildUserStreamReadiness(
  enabled: boolean,
  confirmTimeoutMs: number,
  kalshi: UserStreamVenueState = disabledVenueState(),
  polymarket: UserStreamVenueState = disabledVenueState(),
  now = Date.now(),
): UserStreamReadiness {
  const reason = !enabled
    ? null
    : !kalshi.connected || !kalshi.subscribed
      ? kalshi.reason ?? "Kalshi user stream is not connected/subscribed"
      : !polymarket.connected || !polymarket.subscribed
        ? polymarket.reason ?? "Polymarket user stream is not connected/subscribed"
        : null;
  const lastUserStreamEventAt = Math.max(kalshi.lastEventAt ?? 0, polymarket.lastEventAt ?? 0) || null;
  return {
    enabled,
    ready: !enabled || reason == null,
    reason,
    confirmTimeoutMs,
    kalshi,
    polymarket,
    lastUserStreamEventAt,
    confirmationLagMs: lastUserStreamEventAt == null ? null : Math.max(0, now - lastUserStreamEventAt),
  };
}

export function defaultReconciliationReadiness(enabled: boolean, checkedAt: number | null, reason: string | null): ReconciliationReadiness {
  return {
    enabled,
    clean: !enabled || reason == null,
    reason,
    checkedAt,
    lastReconciliationAt: reason == null ? checkedAt : null,
  };
}

function lowerStatus(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase();
}

function isConfirmingStatus(value: string | null | undefined): boolean {
  const status = lowerStatus(value);
  return ["confirmed", "filled", "matched", "executed"].includes(status);
}

function isFailureStatus(value: string | null | undefined): boolean {
  const status = lowerStatus(value);
  return ["failed", "rejected", "error", "canceled", "cancelled"].includes(status);
}

function resultNeedsConfirmation(result: VenueOrderResult): boolean {
  const timeoutOrUnknown = result.status === "unknown" || result.error?.toLowerCase().includes("timeout") === true;
  return timeoutOrUnknown || (result.error == null && (result.fillCount ?? 0) > 0);
}

function eventMatchesExpected(event: VenueOrderEventInput, pending: Pick<PendingConfirmation, "result" | "leg" | "submittedAtMs">): boolean {
  if (event.venue !== pending.result.venue) return false;
  if (event.eventType === "rest_response") return false;
  if (pending.result.clientOrderId && event.clientOrderId === pending.result.clientOrderId) return true;
  if (pending.result.orderId && event.venueOrderId === pending.result.orderId) return true;
  if ((event.receivedAtMs ?? 0) < pending.submittedAtMs - 1_000) return false;
  if (pending.result.venue === "polymarket" && pending.leg.tokenId && event.assetId === pending.leg.tokenId) return true;
  return Boolean(event.marketId && event.marketId === pending.leg.contractId);
}

function confirmationFromEvent(
  event: VenueOrderEventInput,
  result: VenueOrderResult,
  expectedSize: number,
): VenueConfirmationResult {
  const fillCount = event.fillCount ?? null;
  const status = event.status;
  const mismatch = fillCount != null && Math.abs(fillCount - expectedSize) > 0.000001;
  const failed = isFailureStatus(status);
  const confirmed = isConfirmingStatus(status) && !mismatch && !failed;
  return {
    venue: result.venue,
    status: failed ? "failed" : mismatch ? "mismatch" : confirmed ? "confirmed" : "mismatch",
    reason: failed
      ? `${result.venue} user stream reported ${status}`
      : mismatch
        ? `${result.venue} user stream filled ${fillCount ?? 0} shares for expected size ${expectedSize}`
        : confirmed
          ? null
          : `${result.venue} user stream status ${status} did not confirm the fill`,
    clientOrderId: event.clientOrderId ?? result.clientOrderId ?? null,
    venueOrderId: event.venueOrderId ?? result.orderId ?? null,
    fillCount,
    fillPrice: event.fillPrice ?? null,
    fee: event.fee ?? null,
    exchangeTimestampMs: event.exchangeTimestampMs ?? null,
    receivedAtMs: event.receivedAtMs ?? null,
    eventType: event.eventType ?? null,
  };
}

function timeoutConfirmation(result: VenueOrderResult, expectedSize: number, timeoutMs: number): VenueConfirmationResult {
  return {
    venue: result.venue,
    status: "timeout",
    reason: `${result.venue} user stream did not confirm ${expectedSize} shares within ${timeoutMs}ms`,
    clientOrderId: result.clientOrderId ?? null,
    venueOrderId: result.orderId ?? null,
    fillCount: null,
    fillPrice: null,
    fee: null,
    exchangeTimestampMs: null,
    receivedAtMs: null,
    eventType: null,
  };
}

export class LiveVenueConfirmationCoordinator implements VenueConfirmationMonitor {
  private readonly pending = new Set<PendingConfirmation>();
  private readonly recentEvents: VenueOrderEventInput[] = [];
  private readonly knownOrders = new Map<string, KnownOrder>();
  private lastReconciliation: ReconciliationReadiness;

  constructor(
    private readonly options: {
      enabled: boolean;
      confirmTimeoutMs: number;
      reconcileBeforeTrade: boolean;
      eventSource: VenueOrderEventSource;
      streamReadiness: (now: number) => UserStreamReadiness;
      reconciliationStore?: LiveSignalReconciliationStore;
      maxUnresolvedExposureDollars?: number;
      autoHardlocksEnabled?: boolean;
      flatMissNonBlocking?: boolean;
      overfillToleranceShares?: number;
      allowUnresolvedRisk?: boolean;
      liveLocks?: LiveExecutionLockWriter;
      now?: () => number;
    },
  ) {
    this.lastReconciliation = defaultReconciliationReadiness(options.reconcileBeforeTrade, null, null);
    options.eventSource.onEvent((event) => void this.handleEvent(event));
  }

  userStreamReadiness(now = this.now()): UserStreamReadiness {
    return this.options.streamReadiness(now);
  }

  reconciliationReadiness(): ReconciliationReadiness {
    return this.lastReconciliation;
  }

  async preflight(candidate: ArbCandidate, now = this.now()): Promise<string | null> {
    if (!this.options.enabled) return null;
    const streams = this.userStreamReadiness(now);
    if (!streams.ready) return streams.reason ?? "live user streams are not ready";
    if (!this.options.reconcileBeforeTrade) {
      this.lastReconciliation = defaultReconciliationReadiness(false, now, null);
      return null;
    }
    const reason = await this.options.reconciliationStore?.liveReconciliationBlockReason(
      candidate,
      now,
      this.options.maxUnresolvedExposureDollars,
    ) ?? null;
    const quarantine = await this.options.reconciliationStore?.liveRiskQuarantineStatus?.() ?? null;
    this.lastReconciliation = {
      ...defaultReconciliationReadiness(true, now, reason),
      quarantinedExposureDollars: quarantine?.total ?? null,
      quarantinedSignalCount: quarantine?.count ?? null,
      quarantineCapDollars: this.options.maxUnresolvedExposureDollars ?? null,
    };
    if (reason && this.options.allowUnresolvedRisk) return null;
    return reason;
  }

  async waitForVenueResult(
    result: VenueOrderResult,
    options: { executionGroupId: string; expectedSize: number; leg: ArbLeg; submittedAtMs: number; timeoutMs: number },
  ): Promise<VenueConfirmationResult> {
    if (!this.options.enabled || !resultNeedsConfirmation(result)) {
      return {
        venue: result.venue,
        status: "not_required",
        reason: null,
        clientOrderId: result.clientOrderId ?? null,
        venueOrderId: result.orderId ?? null,
        fillCount: result.fillCount ?? null,
        fillPrice: result.fillPrice ?? null,
        fee: result.fee ?? null,
        exchangeTimestampMs: result.exchangeTimestampMs ?? null,
        receivedAtMs: null,
        eventType: "rest_response",
      };
    }

    // Records the order with reconciledFillCount = this REST result's fillCount (the executor's accounted
    // fill), so any later stream event for the order is judged against what the executor actually reconciled.
    this.rememberKnownOrder(result, options.executionGroupId, options.expectedSize);
    const existing = this.recentEvents.find((event) => eventMatchesExpected(event, { result, leg: options.leg, submittedAtMs: options.submittedAtMs }));
    if (existing) return confirmationFromEvent(existing, result, options.expectedSize);

    return await new Promise<VenueConfirmationResult>((resolve) => {
      const pending: PendingConfirmation = {
        result,
        executionGroupId: options.executionGroupId,
        expectedSize: options.expectedSize,
        leg: options.leg,
        submittedAtMs: options.submittedAtMs,
        resolve,
        timeout: setTimeout(() => {
          this.pending.delete(pending);
          resolve(timeoutConfirmation(result, options.expectedSize, options.timeoutMs));
        }, options.timeoutMs),
      };
      this.pending.add(pending);
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async handleEvent(event: VenueOrderEventInput): Promise<void> {
    this.recentEvents.push(event);
    while (this.recentEvents.length > 500) this.recentEvents.shift();

    let matchedPending = false;
    for (const pending of [...this.pending]) {
      if (!eventMatchesExpected(event, pending)) continue;
      matchedPending = true;
      clearTimeout(pending.timeout);
      this.pending.delete(pending);
      const confirmation = confirmationFromEvent(event, pending.result, pending.expectedSize);
      // Record the executor's REST-confirmed fill (pending.result.fillCount) as the order's reconciled fill,
      // so LATER stream events for the same order (partials or duplicates AT OR BELOW it) are recognized as
      // already-accounted and do not re-lock; a later event revealing MORE still locks.
      this.rememberKnownOrder({
        ...pending.result,
        orderId: confirmation.venueOrderId,
        clientOrderId: confirmation.clientOrderId ?? pending.result.clientOrderId,
      }, pending.executionGroupId, pending.expectedSize);
      pending.resolve(confirmation);
      // Live pending path: the executor is reconciling its REST fill right now (floor-hedge + cap-quarantine
      // of any in-tolerance residual), so accountedFill = the REST fill and the overfill tolerance applies.
      await this.lockOnUnsafeEvent(event, pending.executionGroupId, pending.expectedSize, pending.result.fillCount ?? 0, true);
    }

    // Only treat the event via the knownOrderFor path when it did NOT just match a live pending in this
    // call. An event that resolved a pending is authoritatively handled by the executor (pending path);
    // the knownOrderFor path exists for LATER events on the same order, where the executor has finalized
    // and will not re-reconcile. There the lock is STRICT (no overfill tolerance): a stream fill AT OR BELOW
    // the order's reconciled (REST) fill is a consistent partial/duplicate -> no lock; a fill ABOVE it is a
    // surprise the finalized executor never booked -> lock (the coordinator is the sole detector here). An
    // order never reconciled (reconciledFillCount unset -> 0) locks on any surprise fill.
    if (!matchedPending) {
      const known = this.knownOrderFor(event);
      if (known) {
        await this.lockOnUnsafeEvent(event, known.executionGroupId, known.expectedSize, known.reconciledFillCount ?? 0, false);
      }
    }
  }

  private rememberKnownOrder(result: VenueOrderResult, executionGroupId: string, expectedSize: number): void {
    const clientKey = result.clientOrderId ? `${result.venue}:client:${result.clientOrderId}` : null;
    const orderKey = result.orderId ? `${result.venue}:order:${result.orderId}` : null;
    // reconciledFillCount = the executor's REST-confirmed fill for this order (result.fillCount). Inherit a
    // prior value ONLY from an entry that belongs to the SAME order (matching executionGroupId), and keep
    // the LARGEST across re-remembers — so a key reused by a DIFFERENT order starts fresh (no cross-order
    // contamination) and the accounted fill never shrinks within one order.
    const restFill = typeof result.fillCount === "number" ? result.fillCount : Number.NEGATIVE_INFINITY;
    const priorFor = (key: string | null): number => {
      if (!key) return Number.NEGATIVE_INFINITY;
      const prior = this.knownOrders.get(key);
      return prior && prior.executionGroupId === executionGroupId
        ? (prior.reconciledFillCount ?? Number.NEGATIVE_INFINITY)
        : Number.NEGATIVE_INFINITY;
    };
    const merged = Math.max(restFill, priorFor(clientKey), priorFor(orderKey));
    const known: KnownOrder = {
      executionGroupId,
      expectedSize,
      venue: result.venue,
      reconciledFillCount: Number.isFinite(merged) ? merged : undefined,
    };
    if (clientKey) this.knownOrders.set(clientKey, known);
    if (orderKey) this.knownOrders.set(orderKey, known);
  }

  private knownOrderFor(event: VenueOrderEventInput): KnownOrder | null {
    if (event.clientOrderId) {
      const known = this.knownOrders.get(`${event.venue}:client:${event.clientOrderId}`);
      if (known) return known;
    }
    if (event.venueOrderId) {
      const known = this.knownOrders.get(`${event.venue}:order:${event.venueOrderId}`);
      if (known) return known;
    }
    return null;
  }

  private async lockOnUnsafeEvent(event: VenueOrderEventInput, executionGroupId: string, expectedSize: number, accountedFill: number, allowTolerance: boolean): Promise<void> {
    const fillCount = event.fillCount ?? 0;
    // A failure/cancel/reject that filled ZERO shares is a clean flat miss (no shares moved -> no
    // exposure), not a circuit-breaker event. Only a failure that actually moved shares (fillCount > 0)
    // or a genuine size mismatch is lock-worthy. Gated by flatMissNonBlocking (default on); when off, the
    // legacy behavior (lock on any failure status / any size mismatch) is preserved.
    const failure = isFailureStatus(event.status);
    const lockWorthyFailure = this.options.flatMissNonBlocking === true ? (failure && fillCount > 0) : failure;
    // Defer to the EXECUTOR's authoritative reconciliation. `accountedFill` is the fill the executor has
    // accounted for on this order — its REST order-response fill on the live pending path, or the order's
    // recorded reconciled fill on the knownOrderFor LATE path. A user-stream fill event is CONSISTENT (not
    // lock-worthy) when it does not reveal more shares than the executor already accounted for:
    //  - INTERMEDIATE PARTIALS (e.g. Kalshi streams a 5-share fill as "1": 1 <= REST 5) — lock-19 fix.
    //  - in-tolerance fractional OVERFILLS the executor floor-hedges + cap-quarantines (Polymarket FAK
    //    5.05 on a size-5 REST 5, within +overfillToleranceShares) — lock-17 case. Tolerance applies only
    //    on the pending path (allowTolerance), where the executor books the residual into the cap quarantine
    //    right now; on the LATE path it is strict (any fill ABOVE the reconciled amount is a surprise the
    //    finalized executor will not re-book, so the coordinator stays the sole detector and locks).
    // Only a fill that EXCEEDS what the executor accounted for is a surplus/surprise -> lock. Genuine
    // UNDERFILLS (the order really only partially filled) are caught by the executor's own
    // resultFromVenueOrders venue-fill-mismatch lock + the exposure-cap quarantine; they are not the
    // coordinator's job and a partial stream report of them must not pre-emptively freeze the bot.
    // Apply the floor-hedge overfill tolerance ONLY when the executor actually accounted for a positive
    // fill. When accountedFill is 0 (a timeout/unknown/no-fill REST coerced from undefined, or an order the
    // executor never reconciled), there is no booked residual for the tolerance to cover — so use a STRICT
    // ceiling (any stream fill > 0 locks), or a tiny real fill in (0, tolerance] on a timed-out order would
    // escape both the coordinator and the executor (which only saw the undefined/no-fill REST).
    const tolerance = (allowTolerance && accountedFill > 0) ? Math.max(0, this.options.overfillToleranceShares ?? 0) : 0;
    const consistentCeiling = accountedFill + tolerance;
    const revealsSurplus = this.options.flatMissNonBlocking === true
      ? fillCount > consistentCeiling + 0.000001
      : fillCount > 0 && Math.abs(fillCount - expectedSize) > 0.000001;
    if (!lockWorthyFailure && !revealsSurplus) return;
    const reason = failure
      ? `live safety lock engaged: ${event.venue} user stream reported ${event.status}`
      : `live safety lock engaged: ${event.venue} user stream fill mismatch ${fillCount}/${expectedSize}`;
    if (this.options.autoHardlocksEnabled === false) return;
    await this.options.liveLocks?.engageLock({
      reason,
      executionGroupId,
      details: {
        venue: event.venue,
        clientOrderId: event.clientOrderId ?? null,
        venueOrderId: event.venueOrderId ?? null,
        eventType: event.eventType ?? null,
        status: event.status,
        fillCount: event.fillCount ?? null,
        expectedSize,
      },
    });
  }
}
