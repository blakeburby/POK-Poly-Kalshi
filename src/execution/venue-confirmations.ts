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
  // The largest in-band fill the executor has already reconciled for this order on the live pending-
  // confirmation path (floor-hedge of the matched pair + cap-governed quarantine of the residual + persisted
  // partial_fill row). A LATER duplicate/follow-up stream event reporting a fill at or below this amount is
  // already governed and must NOT re-trip the breaker. A late event reporting MORE than this (a genuine
  // surprise additional fill) still locks. Unset for orders the executor never reconciled (e.g. finalized as
  // a clean no-fill), so any surprise late fill there is strictly locked — that lock is the sole detector.
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

    this.rememberKnownOrder(result, options.executionGroupId, options.expectedSize);
    const existing = this.recentEvents.find((event) => eventMatchesExpected(event, { result, leg: options.leg, submittedAtMs: options.submittedAtMs }));
    if (existing) {
      // Same reconciliation marker as the pending path: if the executor is reconciling an in-band fill via
      // this already-arrived event, record its magnitude so a later duplicate at or below it does not re-lock.
      if (this.withinOverfillBand(existing.fillCount ?? 0, options.expectedSize)) {
        this.rememberKnownOrder(result, options.executionGroupId, options.expectedSize, existing.fillCount ?? 0);
      }
      return confirmationFromEvent(existing, result, options.expectedSize);
    }

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
      // If this fill is in-band, the executor reconciles it now (floor-hedge + cap-quarantine + partial_fill
      // row). Record the reconciled fill magnitude on the known order so a LATER duplicate/follow-up stream
      // event AT OR BELOW it is recognized as already-governed; a later event reporting MORE still locks.
      const reconciledFillCount = this.withinOverfillBand(event.fillCount ?? 0, pending.expectedSize) ? (event.fillCount ?? 0) : undefined;
      this.rememberKnownOrder({
        ...pending.result,
        orderId: confirmation.venueOrderId,
        clientOrderId: confirmation.clientOrderId ?? pending.result.clientOrderId,
      }, pending.executionGroupId, pending.expectedSize, reconciledFillCount);
      pending.resolve(confirmation);
      // Live pending path: the executor reconciles this event's fill right now, so an in-band fill is
      // suppressed (ceiling = +Infinity: no prior-reconciled constraint, the band alone governs).
      await this.lockOnUnsafeEvent(event, pending.executionGroupId, pending.expectedSize, Number.POSITIVE_INFINITY);
    }

    // Only treat the event via the knownOrderFor path when it did NOT just match a live pending in this
    // call. An event that resolved a pending is authoritatively handled by the executor (pending path);
    // the knownOrderFor path exists for LATER events on the same order, where the executor has finalized
    // and will not re-reconcile. There this lock is the sole detector for a genuine surprise fill, so it
    // stays strict UNLESS the executor already reconciled an in-band fill for this order (reconciledFillCount
    // is set) and this event is at/below it — a duplicate/follow-up report of that governed fill must not re-lock.
    if (!matchedPending) {
      const known = this.knownOrderFor(event);
      if (known) {
        // Suppress only a late in-band fill AT OR BELOW the already-reconciled magnitude; a surprise larger
        // fill (or any fill on a never-reconciled order) exceeds the ceiling and still locks.
        await this.lockOnUnsafeEvent(event, known.executionGroupId, known.expectedSize, known.reconciledFillCount ?? Number.NEGATIVE_INFINITY);
      }
    }
  }

  private rememberKnownOrder(result: VenueOrderResult, executionGroupId: string, expectedSize: number, reconciledFillCount?: number): void {
    const clientKey = result.clientOrderId ? `${result.venue}:client:${result.clientOrderId}` : null;
    const orderKey = result.orderId ? `${result.venue}:order:${result.orderId}` : null;
    // Inherit a prior reconciled-fill ceiling ONLY from an entry that belongs to the SAME order (matching
    // executionGroupId). A key reused by a DIFFERENT order starts fresh, so a stale ceiling can never
    // cross-contaminate and suppress a genuine mismatch on a different order (defends against any venue
    // client/order id reuse). Within one order the ceiling is monotonic — it never shrinks across re-remembers.
    const priorFor = (key: string | null): number => {
      if (!key) return Number.NEGATIVE_INFINITY;
      const prior = this.knownOrders.get(key);
      return prior && prior.executionGroupId === executionGroupId
        ? (prior.reconciledFillCount ?? Number.NEGATIVE_INFINITY)
        : Number.NEGATIVE_INFINITY;
    };
    const merged = Math.max(reconciledFillCount ?? Number.NEGATIVE_INFINITY, priorFor(clientKey), priorFor(orderKey));
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

  // The floor-hedge band: a fractional fill within [expectedSize, expectedSize + overfillToleranceShares].
  // Gated by flatMissNonBlocking. This is the designed T1.1 Polymarket-FAK-overfill case (the executor
  // hedges floor(fill) and quarantines the sub-tolerance residual under the unresolved-exposure cap), not a
  // circuit-breaker event. Underfills (fillCount < expectedSize) and overfills BEYOND the band are excluded.
  private withinOverfillBand(fillCount: number, expectedSize: number): boolean {
    if (this.options.flatMissNonBlocking !== true) return false;
    const overfillTolerance = Math.max(0, this.options.overfillToleranceShares ?? 0);
    return fillCount >= expectedSize - 0.000001 && fillCount <= expectedSize + overfillTolerance + 0.000001;
  }

  private async lockOnUnsafeEvent(event: VenueOrderEventInput, executionGroupId: string, expectedSize: number, reconciledCeiling: number): Promise<void> {
    const fillCount = event.fillCount ?? 0;
    const rawMismatch = fillCount > 0 && Math.abs(fillCount - expectedSize) > 0.000001;
    // A failure/cancel/reject that filled ZERO shares is a clean flat miss (no shares moved -> no
    // exposure), not a circuit-breaker event. Only a failure that actually moved shares (fillCount > 0)
    // or a genuine size mismatch is lock-worthy. Gated by flatMissNonBlocking (default on); when off, the
    // legacy behavior (lock on any failure status) is preserved. A later event that DOES report a fill
    // (fillCount > 0) still locks, so a delayed/real fill is never missed.
    const failure = isFailureStatus(event.status);
    const lockWorthyFailure = this.options.flatMissNonBlocking === true ? (failure && fillCount > 0) : failure;
    // Polymarket FAK fills are essentially always fractional OVERFILLS (e.g. 5.05 on a size-5 order). An
    // in-band fill is the designed T1.1 case: the executor hedges floor(fill) (a matched pair) and
    // quarantines the sub-tolerance residual under the unresolved-exposure cap. That is a bounded,
    // cap-governed residual, NOT a circuit-breaker event, so it must not freeze the bot after every filling
    // trade. Underfills and overfills BEYOND the band still lock, and the executor's exposure-cap
    // quarantine/hard-lock plus reconciliation still govern any genuine one-sided exposure.
    //
    // CRITICAL: reconciledCeiling is the largest in-band fill the executor has ALREADY reconciled for this
    // order. The pending-confirmation path passes +Infinity (the executor floor-hedges + cap-quarantines +
    // persists a partial_fill row for THIS fill right now, so the band alone governs). The knownOrderFor
    // LATE-event path passes the order's stored reconciledFillCount (or -Infinity if the executor never
    // reconciled it, e.g. finalized as a clean no-fill). So a late event is suppressed only when it is BOTH
    // in-band AND at/below what was already governed — a genuine surprise larger late fill exceeds the
    // ceiling and still locks (the coordinator remains the sole detector there; venue_order_events is never
    // reconciled against signals).
    const withinFloorHedgeBand = this.withinOverfillBand(fillCount, expectedSize) && fillCount <= reconciledCeiling + 0.000001;
    const mismatch = rawMismatch && !withinFloorHedgeBand;
    if (!lockWorthyFailure && !mismatch) return;
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
