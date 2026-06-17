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

test("confirmation coordinator STILL locks on an UNDERfill (not in the overfill band)", async () => {
  const locks = new MemoryLocks();
  const { hub, pending } = overfillBandCoordinator(locks, { flatMissNonBlocking: true, overfillToleranceShares: 1 });
  // 4.5 < size -> underfill, outside the overfill band -> still lock-worthy.
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 4.5 });
  await pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(locks.lock?.reason ?? "", /fill mismatch 4.5\/5/);
});

test("confirmation coordinator STILL locks on a within-band overfill when flatMissNonBlocking is off (legacy)", async () => {
  const locks = new MemoryLocks();
  const { hub, pending } = overfillBandCoordinator(locks, { overfillToleranceShares: 1 });
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.054944 });
  await pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(locks.lock?.reason ?? "", /fill mismatch 5.054944\/5/);
});

test("confirmation coordinator STILL locks on a LATE in-band overfill via the knownOrderFor path (no live pending) even with the band on", async () => {
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
  // A LATE in-band overfill arrives for the same KNOWN order with NO live pending. The executor has
  // already finalized and will not re-reconcile, so this coordinator lock is the sole detector and MUST
  // fire despite the floor-hedge band (the regression the adversarial review caught).
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.054944 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(locks.lock?.reason ?? "", /fill mismatch 5.054944\/5/);
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
  const pending = coordinator.waitForVenueResult(result("polymarket"), {
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

test("confirmation coordinator STILL locks on a LATE fill that EXCEEDS the already-reconciled in-band overfill", async () => {
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
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.1 });
  await pending;
  assert.equal(locks.lock, null);
  // A larger late fill (still within the band [5,6] but MORE than the reconciled 5.1) is a genuine surprise
  // additional fill the executor never hedged -> the ceiling is exceeded, so it MUST lock.
  await hub.recordEvent({ venue: "polymarket", venueOrderId: "polymarket-order", eventType: "trade", status: "matched", fillCount: 5.6 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(locks.lock?.reason ?? "", /fill mismatch 5.6\/5/);
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
