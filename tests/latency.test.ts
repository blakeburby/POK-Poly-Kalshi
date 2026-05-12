import test from "node:test";
import assert from "node:assert/strict";
import { BookStore } from "../src/books/book-store";
import { LatencyMonitor, summarizeBookAges, summarizeLatencySamples } from "../src/latency/metrics";
import { ReentryThrottle } from "../src/scanner/reentry";
import { CrossVenueArbScanner } from "../src/scanner/scanner";
import { CoalescedScanScheduler } from "../src/scanner/scheduler";
import type { ArbCandidate, ExecutionResult } from "../src/types";
import { contract } from "./helpers";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > 1000) throw new Error("condition timed out");
    await sleep(5);
  }
}

test("latency stats report latest, p50, p95, empty states, and current book ages", () => {
  assert.deepEqual(summarizeLatencySamples([]), { latestMs: null, p50Ms: null, p95Ms: null, sampleCount: 0 });
  assert.deepEqual(summarizeLatencySamples([1, 4, 2, 10]), { latestMs: 10, p50Ms: 2, p95Ms: 10, sampleCount: 4 });
  assert.deepEqual(summarizeLatencySamples([1, 4, 2, 10], 99), { latestMs: 99, p50Ms: 2, p95Ms: 10, sampleCount: 4 });

  const now = 10_000;
  const ages = summarizeBookAges([
    contract({ venue: "kalshi", contractId: "a", strike: 100, updatedAt: now - 100 }),
    contract({ venue: "kalshi", contractId: "b", strike: 101, updatedAt: now - 500 }),
    contract({ venue: "kalshi", contractId: "c", strike: 102, updatedAt: now - 1_000 }),
  ], now);
  assert.equal(ages.latestMs, 100);
  assert.equal(ages.p50Ms, 500);
  assert.equal(ages.p95Ms, 1000);
});

test("coalesced scan scheduler runs one immediate follow-up with the newest update", async () => {
  let releaseFirst = () => undefined;
  const firstScan = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const calls: number[] = [];
  let coalesced = 0;
  const scheduler = new CoalescedScanScheduler({
    async scan(now = 0) {
      calls.push(now);
      if (calls.length === 1) await firstScan;
    },
  }, {
    recordCoalescedScan: () => {
      coalesced += 1;
    },
  });

  scheduler.requestScan(100);
  scheduler.requestScan(101);
  scheduler.requestScan(102);
  await waitFor(() => calls.length === 1);
  assert.equal(coalesced, 2);
  releaseFirst();
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls, [100, 102]);
  assert.deepEqual(scheduler.status(), { running: false, pending: false });
});

test("scanner processes live candidate executions through a bounded queue without leg overfire", async () => {
  const books = new BookStore();
  const now = 1_800_000_000_000;
  books.setPolymarketContracts([
    contract({ venue: "polymarket", contractId: "poly-a", strike: 1500, yesAsk: 0.4, noAsk: 0.6, updatedAt: now }),
    contract({ venue: "polymarket", contractId: "poly-b", strike: 1501, yesAsk: 0.4, noAsk: 0.6, updatedAt: now }),
  ]);
  books.setKalshiContracts([
    contract({ venue: "kalshi", contractId: "kalshi-a", strike: 1502, yesAsk: 0.5, noAsk: 0.5, updatedAt: now }),
    contract({ venue: "kalshi", contractId: "kalshi-b", strike: 1503, yesAsk: 0.5, noAsk: 0.5, updatedAt: now }),
  ]);

  const order: string[] = [];
  const signals = {
    async insertSignal({ candidate }: { candidate: ArbCandidate }) {
      order.push(`insert:${candidate.pairKey}`);
      return order.length;
    },
    async updateSignal(_id: number, result: ExecutionResult) {
      order.push(`update:${result.action}`);
    },
  };
  let active = 0;
  let maxActive = 0;
  let executed = 0;
  const executor = {
    async execute(candidate: ArbCandidate): Promise<ExecutionResult> {
      order.push(`execute:${candidate.pairKey}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active -= 1;
      executed += 1;
      return {
        action: "filled",
        failureReason: null,
        kalshiFillId: `kalshi-${executed}`,
        polymarketFillId: `poly-${executed}`,
        kalshiFillPrice: 0.5,
        polymarketFillPrice: 0.4,
      };
    },
  };
  let duplicateSkips = 0;
  const scanner = new CrossVenueArbScanner(books, signals, executor, new ReentryThrottle(15_000), {
    enabled: true,
    minProfitDollars: 0.05,
    staleBookMs: 10_000,
    executionConcurrency: 2,
    maxLiveTradesPerWindow: 4,
    latency: {
      recordScanStarted: () => undefined,
      recordScanDuration: () => undefined,
      recordDbInsert: () => undefined,
      recordDbUpdate: () => undefined,
      recordExecution: () => undefined,
      recordQueueState: () => undefined,
      recordDuplicateCandidateSkip: () => {
        duplicateSkips += 1;
      },
    },
  });

  const first = await scanner.scan(now);
  const second = await scanner.scan(now + 1);
  assert.equal(first.length, 2);
  assert.equal(second.length, 0);
  assert.equal(duplicateSkips, 0);
  await waitFor(() => executed === 2);
  assert.equal(maxActive, 2);
  const insertedPairs = order.filter((entry) => entry.startsWith("insert:")).map((entry) => entry.replace("insert:", ""));
  const executedPairs = order.filter((entry) => entry.startsWith("execute:")).map((entry) => entry.replace("execute:", ""));
  assert.deepEqual(executedPairs.sort(), insertedPairs.sort());
  for (const pairKey of executedPairs) {
    assert.ok(order.indexOf(`insert:${pairKey}`) < order.indexOf(`execute:${pairKey}`));
  }
  assert.equal(scanner.status().queuedExecutions, 0);
  assert.equal(scanner.status().activeExecutions, 0);
});

test("live hot-path scanner submits before live signal persistence", async () => {
  const books = new BookStore();
  const now = 1_800_000_000_000;
  books.setPolymarketContracts([
    contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesTokenId: "yes-token", updatedAt: now }),
  ]);
  books.setKalshiContracts([
    contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, updatedAt: now }),
  ]);

  const order: string[] = [];
  const scanner = new CrossVenueArbScanner(
    books,
    {
      async insertSignal() {
        order.push("insert");
        return 1;
      },
      async updateSignal() {
        order.push("update");
        return undefined;
      },
    },
    {
      async execute(): Promise<ExecutionResult> {
        order.push("execute");
        return {
          action: "filled",
          failureReason: null,
          kalshiFillId: "kalshi-fill",
          polymarketFillId: "poly-fill",
          kalshiFillPrice: 0.5,
          polymarketFillPrice: 0.4,
        };
      },
    },
    new ReentryThrottle(15_000),
    {
      enabled: true,
      minProfitDollars: 0.05,
      staleBookMs: 10_000,
      executionConcurrency: 1,
      deferLivePersistence: true,
      liveExposure: {
        async liveExposureBlockReason() {
          return null;
        },
      },
    },
  );

  const accepted = await scanner.scan(now);
  assert.equal(accepted.length, 1);
  await waitFor(() => order.includes("update"));
  assert.deepEqual(order, ["execute", "insert", "update"]);
});

test("live hot-path scanner suppresses automatic lock writes when disabled", async () => {
  const books = new BookStore();
  const now = 1_800_000_000_000;
  books.setPolymarketContracts([
    contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, yesTokenId: "yes-token", updatedAt: now }),
  ]);
  books.setKalshiContracts([
    contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, updatedAt: now }),
  ]);

  let lockCalls = 0;
  let updated: ExecutionResult | null = null;
  const scanner = new CrossVenueArbScanner(
    books,
    {
      async insertSignal() {
        return 1;
      },
      async updateSignal(_id, update) {
        updated = update as ExecutionResult;
        return undefined;
      },
    },
    {
      async execute(): Promise<ExecutionResult> {
        return {
          action: "failed",
          failureReason: "live safety lock engaged: venue fill mismatch kalshi=5 polymarket=0",
          kalshiFillId: "kalshi-order",
          polymarketFillId: null,
          kalshiFillPrice: 0.5,
          polymarketFillPrice: null,
          executionGroupId: "group",
          partialFill: true,
          liveLockReason: "live safety lock engaged: venue fill mismatch kalshi=5 polymarket=0",
        };
      },
    },
    new ReentryThrottle(15_000),
    {
      enabled: true,
      minProfitDollars: 0.05,
      staleBookMs: 10_000,
      executionConcurrency: 1,
      deferLivePersistence: true,
      liveAutoHardlocksEnabled: false,
      liveLocks: {
        async getActiveLock() {
          return null;
        },
        async engageLock() {
          lockCalls += 1;
          throw new Error("should not engage lock");
        },
      },
      liveExposure: {
        async liveExposureBlockReason() {
          throw new Error("should not check persisted exposure when auto-hardlocks are disabled");
        },
      },
    },
  );

  const accepted = await scanner.scan(now);

  assert.equal(accepted.length, 1);
  await waitFor(() => updated != null);
  assert.equal(updated?.liveLockReason, "live safety lock engaged: venue fill mismatch kalshi=5 polymarket=0");
  assert.equal(lockCalls, 0);
});

test("live scanner enforces submitted attempt cap even when auto-hardlocks are disabled", async () => {
  const books = new BookStore();
  const now = 1_800_000_000_000;
  books.setPolymarketContracts([
    contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, updatedAt: now }),
  ]);
  books.setKalshiContracts([
    contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, updatedAt: now }),
  ]);

  let inserted = 0;
  let executed = 0;
  let capChecks = 0;
  const scanner = new CrossVenueArbScanner(
    books,
    {
      async insertSignal() {
        inserted += 1;
        return inserted;
      },
      async updateSignal() {
        return undefined;
      },
    },
    {
      async execute(): Promise<ExecutionResult> {
        executed += 1;
        return {
          action: "filled",
          failureReason: null,
          kalshiFillId: "kalshi",
          polymarketFillId: "poly",
          kalshiFillPrice: 0.5,
          polymarketFillPrice: 0.4,
        };
      },
    },
    new ReentryThrottle(15_000),
    {
      enabled: true,
      minProfitDollars: 0.05,
      staleBookMs: 10_000,
      maxLiveTradesPerWindow: 3,
      liveAutoHardlocksEnabled: false,
      liveExposure: {
        async liveSubmittedAttemptBlockReason(_candidate, _now, maxTradesPerWindow) {
          capChecks += 1;
          return `live submitted attempt limit reached for expiry ${now}: ${maxTradesPerWindow}/${maxTradesPerWindow}`;
        },
        async liveExposureBlockReason() {
          throw new Error("unresolved exposure checks should stay bypassed when auto-hardlocks are disabled");
        },
      },
    },
  );

  const accepted = await scanner.scan(now);

  assert.equal(accepted.length, 0);
  assert.equal(inserted, 0);
  assert.equal(executed, 0);
  assert.equal(capChecks, 1);
});

test("live scanner limits canary execution to one candidate per expiry window", async () => {
  const books = new BookStore();
  const now = 1_800_000_000_000;
  books.setPolymarketContracts([
    contract({ venue: "polymarket", contractId: "poly-a", strike: 1500, yesAsk: 0.4, noAsk: 0.6, updatedAt: now }),
  ]);
  books.setKalshiContracts([
    contract({ venue: "kalshi", contractId: "kalshi-a", strike: 1502, yesAsk: 0.5, noAsk: 0.5, updatedAt: now }),
    contract({ venue: "kalshi", contractId: "kalshi-b", strike: 1503, yesAsk: 0.49, noAsk: 0.49, updatedAt: now }),
  ]);

  let inserted = 0;
  let executed = 0;
  const scanner = new CrossVenueArbScanner(
    books,
    {
      async insertSignal() {
        inserted += 1;
        return inserted;
      },
      async updateSignal() {
        return undefined;
      },
    },
    {
      async execute(candidate: ArbCandidate): Promise<ExecutionResult> {
        executed += 1;
        return {
          action: "filled",
          failureReason: null,
          kalshiFillId: `kalshi-${candidate.kalshiContractId}`,
          polymarketFillId: `poly-${candidate.polymarketContractId}`,
          kalshiFillPrice: candidate.higher.venue === "kalshi" ? candidate.higher.ask : candidate.lower.ask,
          polymarketFillPrice: candidate.higher.venue === "polymarket" ? candidate.higher.ask : candidate.lower.ask,
        };
      },
    },
    new ReentryThrottle(15_000),
    {
      enabled: true,
      minProfitDollars: 0.05,
      staleBookMs: 10_000,
      executionConcurrency: 2,
      maxLiveTradesPerWindow: 1,
      liveExposure: {
        async liveExposureBlockReason() {
          return null;
        },
      },
    },
  );

  const accepted = await scanner.scan(now);

  assert.equal(accepted.length, 1);
  await waitFor(() => executed === 1);
  await waitFor(() => scanner.status().activeExecutions === 0);
  assert.equal(inserted, 1);
  assert.equal(scanner.status().queuedExecutions, 0);
  assert.equal(scanner.status().activeExecutions, 0);
});

test("scanner blocks equal-strike candidates before persistence or execution", async () => {
  const books = new BookStore();
  const now = 1_800_000_000_000;
  books.setPolymarketContracts([
    contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, updatedAt: now }),
  ]);
  books.setKalshiContracts([
    contract({ venue: "kalshi", contractId: "kalshi", strike: 1500, noAsk: 0.5, updatedAt: now }),
  ]);

  let inserted = 0;
  let executed = 0;
  const scanner = new CrossVenueArbScanner(
    books,
    {
      async insertSignal() {
        inserted += 1;
        return inserted;
      },
      async updateSignal() {
        return undefined;
      },
    },
    {
      async execute(): Promise<ExecutionResult> {
        executed += 1;
        return {
          action: "filled",
          failureReason: null,
          kalshiFillId: "kalshi",
          polymarketFillId: "poly",
          kalshiFillPrice: 0.5,
          polymarketFillPrice: 0.4,
        };
      },
    },
    new ReentryThrottle(15_000),
    {
      enabled: true,
      minProfitDollars: 0.05,
      staleBookMs: 30_000,
      executionConcurrency: 1,
    },
  );

  const candidates = await scanner.scan(now);
  assert.equal(candidates.length, 0);
  assert.equal(inserted, 0);
  assert.equal(executed, 0);
  assert.equal(scanner.status().lastCandidateCount, 0);
});

test("scanner throttles failed live execution attempts for the same pair", async () => {
  const books = new BookStore();
  const now = 1_800_000_000_000;
  books.setPolymarketContracts([
    contract({ venue: "polymarket", contractId: "poly", strike: 1500, yesAsk: 0.4, updatedAt: now }),
  ]);
  books.setKalshiContracts([
    contract({ venue: "kalshi", contractId: "kalshi", strike: 1502, noAsk: 0.5, updatedAt: now }),
  ]);

  let inserted = 0;
  let executed = 0;
  const scanner = new CrossVenueArbScanner(
    books,
    {
      async insertSignal() {
        inserted += 1;
        return inserted;
      },
      async updateSignal() {
        return undefined;
      },
    },
    {
      async execute(): Promise<ExecutionResult> {
        executed += 1;
        return {
          action: "failed",
          failureReason: "exchange rejected",
          kalshiFillId: null,
          polymarketFillId: null,
          kalshiFillPrice: null,
          polymarketFillPrice: null,
          executionGroupId: "00000000-0000-4000-8000-000000000000",
        };
      },
    },
    new ReentryThrottle(15_000),
    {
      enabled: true,
      minProfitDollars: 0.05,
      staleBookMs: 30_000,
      executionConcurrency: 1,
    },
  );

  await scanner.scan(now);
  await waitFor(() => executed === 1);
  await scanner.scan(now + 1_000);
  await sleep(10);
  assert.equal(inserted, 1);
  assert.equal(executed, 1);

  await scanner.scan(now + 15_000);
  await waitFor(() => executed === 2);
  assert.equal(inserted, 2);
});

test("latency monitor snapshots phase timing and queue state", () => {
  const monitor = new LatencyMonitor();
  monitor.recordWsToBookApply("kalshi", 100, 112);
  monitor.recordWsToBookApply("polymarket", 100, 130);
  monitor.recordScanStarted(200);
  monitor.recordScanDuration(7, 207);
  monitor.recordDbInsert(3);
  monitor.recordDbUpdate(4);
  monitor.recordExecution(11);
  monitor.recordQueueState(2, 1);
  monitor.recordCoalescedScan();
  monitor.recordDuplicateCandidateSkip();

  const snapshot = monitor.snapshot({
    kalshi: [contract({ venue: "kalshi", contractId: "kalshi", strike: 100, updatedAt: 900 })],
    polymarket: [contract({ venue: "polymarket", contractId: "poly", strike: 99, updatedAt: 800 })],
  }, 1000, {
    dashboardStreamIntervalMs: 250,
    dashboardSignalRefreshMs: 1000,
    dashboardAnalyticsRefreshMs: 5000,
  }, 5);

  assert.equal(snapshot.books.kalshi.latestMs, 100);
  assert.equal(snapshot.books.polymarket.latestMs, 200);
  assert.equal(snapshot.wsToBookApplyMs.kalshi.latestMs, 12);
  assert.equal(snapshot.scanner.scanDurationMs.latestMs, 7);
  assert.equal(snapshot.scanner.queueDepth, 2);
  assert.equal(snapshot.scanner.activeExecutions, 1);
  assert.equal(snapshot.scanner.coalescedScanCount, 1);
  assert.equal(snapshot.scanner.duplicateCandidateSkips, 1);
  assert.equal(snapshot.persistence.insertMs.latestMs, 3);
  assert.equal(snapshot.persistence.updateMs.latestMs, 4);
  assert.equal(snapshot.execution.durationMs.latestMs, 11);
  assert.equal(snapshot.dashboard.snapshotBuildMs.latestMs, 5);
});
