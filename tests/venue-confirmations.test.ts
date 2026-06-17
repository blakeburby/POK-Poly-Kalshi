import test from "node:test";
import assert from "node:assert/strict";
import { VenueOrderEventHub, type VenueOrderEventInput, type VenueOrderEventWriter } from "../src/db/venue-order-events";
import { buildUserStreamReadiness, LiveVenueConfirmationCoordinator, type LiveSignalReconciliationStore } from "../src/execution/venue-confirmations";
import type { VenueOrderResult } from "../src/execution/live-clients";
import type { ArbCandidate, ArbLeg, UserStreamVenueState } from "../src/types";
import type { LiveExecutionLock, LiveExecutionLockInput, LiveExecutionLockWriter } from "../src/db/live-execution-locks";

class MemoryEventStore implements VenueOrderEventWriter {
  events: VenueOrderEventInput[] = [];

  async recordEvent(input: VenueOrderEventInput): Promise<void> {
    this.events.push(input);
  }

  async recordVenueResult(executionGroupId: string, result: VenueOrderResult): Promise<void> {
    await this.recordEvent({
      executionGroupId,
      venue: result.venue,
      clientOrderId: result.clientOrderId,
      venueOrderId: result.orderId,
      status: result.status,
    });
  }
}

class MemoryLocks implements LiveExecutionLockWriter {
  lock: LiveExecutionLock | null = null;

  async getActiveLock(): Promise<LiveExecutionLock | null> {
    return this.lock;
  }

  async engageLock(input: LiveExecutionLockInput): Promise<LiveExecutionLock> {
    this.lock = {
      id: 1,
      createdAt: new Date(1_800_000_000_000).toISOString(),
      reason: input.reason,
      severity: input.severity ?? "critical",
      sourceSignalId: input.sourceSignalId ?? null,
      executionGroupId: input.executionGroupId ?? null,
      details: input.details ?? {},
      clearedAt: null,
      clearReason: null,
    };
    return this.lock;
  }
}

const readyState: UserStreamVenueState = {
  enabled: true,
  connected: true,
  subscribed: true,
  reason: null,
  lastConnectedAt: 1_800_000_000_000,
  lastEventAt: 1_800_000_000_100,
  lastError: null,
};

function result(venue: "kalshi" | "polymarket"): VenueOrderResult {
  return {
    venue,
    clientOrderId: `${venue}-client`,
    orderId: `${venue}-order`,
    status: "filled",
    fillPrice: venue === "kalshi" ? 0.19 : 0.91,
    fillCount: 5,
    requestedAt: new Date(1_800_000_000_000).toISOString(),
    respondedAt: new Date(1_800_000_000_100).toISOString(),
    error: null,
  };
}

const leg: ArbLeg = {
  venue: "polymarket",
  contractId: "condition",
  direction: "yes",
  strike: 80_000,
  ask: 0.91,
  tokenId: "yes-token",
};

test("confirmation coordinator resolves REST-before-stream exact fills", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    now: () => 1_800_000_000_200,
  });

  const pending = coordinator.waitForVenueResult(result("polymarket"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  await hub.recordEvent({
    venue: "polymarket",
    venueOrderId: "polymarket-order",
    eventType: "trade",
    assetId: "yes-token",
    status: "matched",
    fillCount: 5,
    fillPrice: 0.91,
  });
  const confirmation = await pending;

  assert.equal(confirmation.status, "confirmed");
  assert.equal(confirmation.fillCount, 5);
  assert.equal(confirmation.reason, null);
});

test("confirmation coordinator resolves stream-before-REST events by order id", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    now: () => 1_800_000_000_200,
  });
  await hub.recordEvent({
    venue: "kalshi",
    venueOrderId: "kalshi-order",
    eventType: "fill",
    status: "filled",
    fillCount: 5,
    fillPrice: 0.19,
    receivedAtMs: 1_800_000_000_050,
  });

  const confirmation = await coordinator.waitForVenueResult(result("kalshi"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg: { ...leg, venue: "kalshi", contractId: "kalshi", tokenId: null },
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });

  assert.equal(confirmation.status, "confirmed");
  assert.equal(confirmation.fillPrice, 0.19);
});

test("confirmation coordinator times out missing private stream fills", async () => {
  const store = new MemoryEventStore();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 5,
    reconcileBeforeTrade: false,
    eventSource: new VenueOrderEventHub(store),
    streamReadiness: (now) => buildUserStreamReadiness(true, 5, readyState, readyState, now),
    now: () => 1_800_000_000_200,
  });

  const confirmation = await coordinator.waitForVenueResult(result("polymarket"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 5,
  });

  assert.equal(confirmation.status, "timeout");
  assert.match(confirmation.reason ?? "", /did not confirm 5 shares/);
});

test("confirmation coordinator locks when a known Polymarket settlement later fails", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const locks = new MemoryLocks();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    now: () => 1_800_000_000_200,
  });
  const pending = coordinator.waitForVenueResult(result("polymarket"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5 });
  assert.equal((await pending).status, "confirmed");

  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "failed", fillCount: 5 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(locks.lock?.reason ?? "", /user stream reported failed/);
  assert.equal(locks.lock?.executionGroupId, "group");
});

test("confirmation coordinator suppresses unsafe-event locks when auto-hardlocks are disabled", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const locks = new MemoryLocks();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    autoHardlocksEnabled: false,
    now: () => 1_800_000_000_200,
  });
  const pending = coordinator.waitForVenueResult(result("polymarket"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5 });
  assert.equal((await pending).status, "confirmed");

  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "failed", fillCount: 5 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(locks.lock, null);
  assert.equal(store.events.some((event) => event.status === "failed"), true);
});

test("confirmation coordinator does NOT lock on a ZERO-fill failure when flatMissNonBlocking is on (clean flat miss)", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const locks = new MemoryLocks();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    flatMissNonBlocking: true,
    now: () => 1_800_000_000_200,
  });
  const pending = coordinator.waitForVenueResult(result("polymarket"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  // A FAK that fails to match fills zero shares -> flat, no exposure. This must NOT engage the breaker
  // (the lock-16 / lock-14 false-positive that froze the bot for hours).
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "failed", fillCount: 0 });
  assert.equal((await pending).status, "failed");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(locks.lock, null);
});

test("confirmation coordinator STILL locks on a zero-fill failure when flatMissNonBlocking is off (legacy)", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const locks = new MemoryLocks();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    now: () => 1_800_000_000_200,
  });
  const pending = coordinator.waitForVenueResult(result("polymarket"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "failed", fillCount: 0 });
  assert.equal((await pending).status, "failed");
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(locks.lock?.reason ?? "", /user stream reported failed/);
});

test("confirmation coordinator STILL locks on a failure that moved shares (exposure) even with flatMissNonBlocking on", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const locks = new MemoryLocks();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    flatMissNonBlocking: true,
    now: () => 1_800_000_000_200,
  });
  const pending = coordinator.waitForVenueResult(result("polymarket"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  // A failure that actually moved shares (fillCount 3 > 0) is genuine one-sided exposure -> must hard-lock.
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "failed", fillCount: 3 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(locks.lock?.reason ?? "", /user stream reported failed/);
  assert.equal(locks.lock?.executionGroupId, "group");
});

function overfillBandCoordinator(locks: MemoryLocks, opts: { flatMissNonBlocking?: boolean; overfillToleranceShares?: number }) {
  const hub = new VenueOrderEventHub(new MemoryEventStore());
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    flatMissNonBlocking: opts.flatMissNonBlocking,
    overfillToleranceShares: opts.overfillToleranceShares,
    now: () => 1_800_000_000_200,
  });
  const pending = coordinator.waitForVenueResult(result("polymarket"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  return { hub, pending };
}

test("confirmation coordinator does NOT lock on a fractional OVERFILL within the floor-hedge band (T1.1 5.05/5, lock-17 fix)", async () => {
  const locks = new MemoryLocks();
  const { hub, pending } = overfillBandCoordinator(locks, { flatMissNonBlocking: true, overfillToleranceShares: 1 });
  // Polymarket FAK overfilled to 5.054944 (within [5, 6]); the executor floor-hedges 5 + quarantines the
  // ~0.05 residual under the cap. This must NOT freeze the bot after a (near-)complete fill.
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.054944 });
  await pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(locks.lock, null);
});

test("confirmation coordinator STILL locks on an overfill BEYOND the floor-hedge band", async () => {
  const locks = new MemoryLocks();
  const { hub, pending } = overfillBandCoordinator(locks, { flatMissNonBlocking: true, overfillToleranceShares: 1 });
  // 6.5 > size+tolerance (6) -> excessive, unexpected -> still lock-worthy.
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 6.5 });
  await pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(locks.lock?.reason ?? "", /fill mismatch 6.5\/5/);
});

test("confirmation coordinator does NOT lock on a PARTIAL stream fill at/below the executor's REST fill (lock-19 fix)", async () => {
  const locks = new MemoryLocks();
  // result("polymarket") carries the executor's REST-confirmed fill of 5. A user-stream event reporting 4.5
  // is an intermediate PARTIAL of that already-reconciled 5, not a real underfill -> must NOT trip the
  // breaker. A genuine underfill (the REST fill itself short) is caught by the executor's own
  // resultFromVenueOrders venue-fill-mismatch lock + exposure-cap quarantine, not by this coordinator.
  const { hub, pending } = overfillBandCoordinator(locks, { flatMissNonBlocking: true, overfillToleranceShares: 1 });
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 4.5 });
  await pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(locks.lock, null);
});

test("confirmation coordinator does NOT lock on a Kalshi intermediate partial-fill stream event (lock-19: stream 1, REST-confirmed 5)", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const locks = new MemoryLocks();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    flatMissNonBlocking: true,
    overfillToleranceShares: 1,
    now: () => 1_800_000_000_200,
  });
  // The Kalshi FOK hedge filled 5 (REST authoritative), but the user stream emits the fill as an
  // intermediate "1 share" partial. 1 <= REST 5 -> consistent -> must NOT lock. This is the lock-19 prod
  // freeze that hard-locked Montreal on its first trade ("kalshi user stream fill mismatch 1/5").
  const pending = coordinator.waitForVenueResult(result("kalshi"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  await hub.recordEvent({ venue: "kalshi", venueOrderId: "kalshi-order", eventType: "user_order", status: "matched", fillCount: 1 });
  await pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(locks.lock, null);
});

test("confirmation coordinator LOCKS on a stream fill after a timeout/no-fill REST (accountedFill 0 -> tolerance must NOT apply)", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const locks = new MemoryLocks();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    flatMissNonBlocking: true,
    overfillToleranceShares: 1,
    now: () => 1_800_000_000_200,
  });
  // REST timed out (status unknown, no fill) -> the executor accounted for 0. A real partial fill (0.05)
  // then arrives on the user stream. Because accountedFill is 0 (not a positive reconciled fill), the
  // overfill tolerance must NOT apply, so this surprise fill on a timed-out order LOCKS -> it cannot escape
  // both the coordinator and the executor (which only saw the undefined REST). (lock-19 review hardening.)
  const pending = coordinator.waitForVenueResult({ ...result("kalshi"), status: "unknown", fillCount: 0, error: null }, {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  await hub.recordEvent({ venue: "kalshi", venueOrderId: "kalshi-order", eventType: "user_order", status: "matched", fillCount: 0.05 });
  await pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(locks.lock?.reason ?? "", /fill mismatch 0.05\/5/);
});

test("confirmation coordinator STILL locks on a within-band overfill when flatMissNonBlocking is off (legacy)", async () => {
  const locks = new MemoryLocks();
  const { hub, pending } = overfillBandCoordinator(locks, { overfillToleranceShares: 1 });
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.054944 });
  await pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(locks.lock?.reason ?? "", /fill mismatch 5.054944\/5/);
});

test("confirmation coordinator does NOT lock on a LATE in-band overfill via the knownOrderFor path (no live pending) — band applies regardless of arrival timing", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const locks = new MemoryLocks();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    flatMissNonBlocking: true,
    overfillToleranceShares: 1,
    now: () => 1_800_000_000_200,
  });
  const pending = coordinator.waitForVenueResult(result("polymarket"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  // First event resolves + remembers the order (exact 5, no lock, handled via the pending path only).
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5 });
  assert.equal((await pending).status, "confirmed");
  assert.equal(locks.lock, null);
  // A LATE in-band overfill (5.054944, within reconciled 5 + tolerance 1) arrives for the same KNOWN order
  // with NO live pending. This is the same benign sub-share FAK over-hedge the floor-hedge band exists to
  // absorb — it is a property of the FILL, not of when the "trade" event arrives — so it must NOT lock.
  // (lock-21 production freeze: a 5.256/5 overfill surfacing only via a late stream event hard-locked the
  // bot for hours despite overfillToleranceShares=1.)
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.054944 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(locks.lock, null);
});

test("confirmation coordinator does NOT re-lock on a LATE DUPLICATE of an already-reconciled in-band overfill (lock-18 fix)", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const locks = new MemoryLocks();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    flatMissNonBlocking: true,
    overfillToleranceShares: 1,
    now: () => 1_800_000_000_200,
  });
  // The REST order-response reported the FAK overfill (5.116278) — that is the executor's accounted fill.
  const pending = coordinator.waitForVenueResult({ ...result("polymarket"), fillCount: 5.116278 }, {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  // First event is the in-band fractional OVERFILL the executor reconciles now (floor-hedge + cap-quarantine
  // of the residual). No lock on the pending path, and the reconciled magnitude (5.116278) is remembered.
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.116278 });
  await pending;
  assert.equal(locks.lock, null);
  // A LATE DUPLICATE of that SAME governed fill (Polymarket user streams re-emit trade events) arrives with
  // no live pending. It is at/below the reconciled ceiling, so it must NOT re-trip the breaker. This is the
  // lock-18 production freeze: a benign 5.116278/5 overfill re-reported late hard-locked the bot for hours.
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.116278 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(locks.lock, null);
});

test("confirmation coordinator STILL locks on a LATE fill BEYOND accountedFill + the floor-hedge band", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const locks = new MemoryLocks();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    flatMissNonBlocking: true,
    overfillToleranceShares: 1,
    now: () => 1_800_000_000_200,
  });
  // REST reported the 5.1 fill — the executor's reconciled amount for this order.
  const pending = coordinator.waitForVenueResult({ ...result("polymarket"), fillCount: 5.1 }, {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.1 });
  await pending;
  assert.equal(locks.lock, null);
  // A late fill within the band (e.g. 5.6 <= reconciled 5.1 + 1) is a benign over-hedge and is tolerated.
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.6 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(locks.lock, null);
  // But a late fill BEYOND accountedFill + band (6.5 > 5.1 + 1) is a materially-too-large surprise the
  // finalized executor never booked -> it MUST lock (the coordinator is the sole detector on the late path).
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 6.5 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(locks.lock?.reason ?? "", /fill mismatch 6.5\/5/);
});

test("confirmation coordinator does NOT lock on the lock-21 production overfill (5.256409/5) arriving late after a REST-5 reconcile", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const locks = new MemoryLocks();
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: false,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    liveLocks: locks,
    flatMissNonBlocking: true,
    overfillToleranceShares: 1,
    now: () => 1_800_000_000_200,
  });
  // Exact lock-21 production sequence: the Polymarket hedge REST-confirmed an integer 5 (the executor
  // floor-hedged 5), the pending path resolved clean, then Polymarket re-emitted the order on the user
  // stream as a "matched" trade reporting the TRUE FAK fill of 5.256409 — within the operator's
  // overfillToleranceShares=1 band over the size-5 order. The pre-fix code hard-locked here ("polymarket
  // user stream fill mismatch 5.256409/5", lockId 21) and halted live trading on Montreal until an operator
  // cleared it. With the band applied on the late path, this benign sub-share over-hedge must NOT lock.
  const pending = coordinator.waitForVenueResult(result("polymarket"), {
    executionGroupId: "group",
    expectedSize: 5,
    leg,
    submittedAtMs: 1_800_000_000_000,
    timeoutMs: 500,
  });
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5 });
  assert.equal((await pending).status, "confirmed");
  assert.equal(locks.lock, null);
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.256409 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(locks.lock, null);
});

test("confirmation coordinator blocks preflight when reconciliation is dirty", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const reconciliationStore: LiveSignalReconciliationStore = {
    async liveReconciliationBlockReason(): Promise<string | null> {
      return "live reconciliation blocked: signal #7 has venue fills without private-stream confirmations";
    },
  };
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: true,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    reconciliationStore,
    now: () => 1_800_000_000_200,
  });

  const reason = await coordinator.preflight({ expiryMs: 1_800_000_100_000 } as ArbCandidate, 1_800_000_000_200);

  assert.match(reason ?? "", /private-stream confirmations/);
  assert.equal(coordinator.reconciliationReadiness().clean, false);
});

test("confirmation coordinator audits dirty reconciliation but allows preflight when unresolved risk is allowed", async () => {
  const store = new MemoryEventStore();
  const hub = new VenueOrderEventHub(store);
  const reconciliationStore: LiveSignalReconciliationStore = {
    async liveReconciliationBlockReason(): Promise<string | null> {
      return "live reconciliation blocked: signal #7 has venue fills without private-stream confirmations";
    },
  };
  const coordinator = new LiveVenueConfirmationCoordinator({
    enabled: true,
    confirmTimeoutMs: 500,
    reconcileBeforeTrade: true,
    allowUnresolvedRisk: true,
    eventSource: hub,
    streamReadiness: (now) => buildUserStreamReadiness(true, 500, readyState, readyState, now),
    reconciliationStore,
    now: () => 1_800_000_000_200,
  });

  const reason = await coordinator.preflight({ expiryMs: 1_800_000_100_000 } as ArbCandidate, 1_800_000_000_200);

  assert.equal(reason, null);
  assert.equal(coordinator.reconciliationReadiness().clean, false);
  assert.match(coordinator.reconciliationReadiness().reason ?? "", /private-stream confirmations/);
});
