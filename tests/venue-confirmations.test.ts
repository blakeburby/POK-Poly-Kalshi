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
