import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

type JsonRecord = Record<string, unknown>;

type Args = {
  apply: boolean;
  outDir: string;
  healthUrl: string;
  snapshotUrl: string;
  minExpiredMs: number;
  recentOrderLookbackMs: number;
  reason: string;
};

type QuarantineRow = {
  id: string;
  created_at: Date | string;
  updated_at: Date | string;
  expiry_ms: string | number;
  action: string;
  failure_reason: string | null;
  execution_group_id: string | null;
  kalshi_contract_id: string | null;
  polymarket_contract_id: string | null;
  kalshi_client_order_id: string | null;
  polymarket_client_order_id: string | null;
  kalshi_fill_id: string | null;
  polymarket_fill_id: string | null;
  kalshi_status: string | null;
  polymarket_status: string | null;
  kalshi_fill_count: string | number | null;
  polymarket_fill_count: string | number | null;
  kalshi_fill_price: string | number | null;
  polymarket_fill_price: string | number | null;
  risk_quarantined_at: Date | string | null;
  risk_quarantine_exposure_dollars: string | number | null;
  risk_quarantine_reason: string | null;
};

type ActiveLocksRow = {
  count: number;
};

type FutureExposureRow = {
  count: number;
  filled_shares: string | number | null;
};

type LatestOrderEventRow = {
  venue: string | null;
  status: string | null;
  remaining_count: string | number | null;
  received_at: Date | string | null;
};

type Queryable = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
};

// Statuses whose latest event means an order can no longer be working at the venue. The
// `remaining_count > 0` check below is the AUTHORITATIVE "still open" signal; this set only suppresses
// the secondary status-string heuristic. This system places exclusively FAK (Polymarket) / FOK (Kalshi)
// orders, which fill-or-die instantly and can never rest — so its app-specific outcomes are terminal too:
//   not_submitted        — the leg was never sent to the venue (nothing exists to be open)
//   unexpected_fill_count — a FAK order that DID fill, just outside the expected band (done)
//   unknown               — confirmation was indeterminate; recovery reconciles it, and a FAK/FOK order
//                           still cannot rest, so remaining_count (0 here) governs, not the label
// Without these, routine no-fills (~dozens/day) sit inside the 24h window with a non-whitelisted status
// and structurally false-positive the open-order guard, making reconciliation permanently un-runnable.
const terminalOrderStatuses = new Set([
  "confirmed",
  "executed",
  "filled",
  "matched",
  "canceled",
  "cancelled",
  "rejected",
  "failed",
  "expired",
  "unfilled",
  "not_submitted",
  "unexpected_fill_count",
  "unknown",
]);

function usage(): string {
  return [
    "Usage: tsx scripts/reconcile-historical-quarantines.ts [--apply]",
    "  --apply                         Update reconciliation audit fields after all guards pass.",
    "  --out-dir=<path>                Report output directory. Default: tmp/historical-quarantine-reconciliation",
    "  --health-url=<url>              Worker health URL. Default: http://127.0.0.1:8080/health",
    "  --snapshot-url=<url>            Protected dashboard snapshot URL. Default: http://127.0.0.1:8080/dashboard/snapshot",
    "  --min-expired-ms=<ms>           Required age past expiry. Default: 3600000",
    "  --recent-order-lookback-ms=<ms> Recent venue event window. Default: 86400000",
    "  --reason=<text>                 Resolution reason stored on each row.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    outDir: "tmp/historical-quarantine-reconciliation",
    healthUrl: "http://127.0.0.1:8080/health",
    snapshotUrl: "http://127.0.0.1:8080/dashboard/snapshot",
    minExpiredMs: 60 * 60_000,
    recentOrderLookbackMs: 24 * 60 * 60_000,
    reason:
      "operator reconciled historical expired quarantine after supported API evidence showed no active locks, no open orders, no future unresolved exposure, and no current positive-value venue positions",
  };

  for (const arg of argv) {
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    const [key, ...rest] = arg.split("=");
    const value = rest.join("=");
    if (!value) throw new Error(`Invalid argument ${arg}; expected --name=value`);
    if (key === "--out-dir") args.outDir = value;
    else if (key === "--health-url") args.healthUrl = value;
    else if (key === "--snapshot-url") args.snapshotUrl = value;
    else if (key === "--min-expired-ms") args.minExpiredMs = positiveNumber(value, key);
    else if (key === "--recent-order-lookback-ms") args.recentOrderLookbackMs = positiveNumber(value, key);
    else if (key === "--reason") args.reason = value;
    else throw new Error(`Unknown argument ${key}\n${usage()}`);
  }

  return args;
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative finite number`);
  return parsed;
}

function numberFrom(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringSet(values: Array<string | null | undefined>): Set<string> {
  return new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean));
}

function positionValue(position: JsonRecord): number {
  return (
    numberFrom(position.value) ??
    numberFrom(position.positionValueDollars) ??
    numberFrom(position.currentValue) ??
    numberFrom(position.marketValue) ??
    0
  );
}

function positionShares(position: JsonRecord): number {
  return numberFrom(position.shares) ?? numberFrom(position.quantity) ?? numberFrom(position.count) ?? 0;
}

function positionMatchesTarget(position: JsonRecord, targetIds: Set<string>): boolean {
  if (targetIds.size === 0) return false;
  const candidates = [
    position.id,
    position.market,
    position.marketId,
    position.market_id,
    position.ticker,
    position.contractId,
    position.contract_id,
    position.assetId,
    position.asset_id,
    position.tokenId,
    position.token_id,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return candidates.some((value) => targetIds.has(value));
}

function targetPositivePositions(venue: JsonRecord, targetIds: Set<string>): JsonRecord[] | null {
  if (!Array.isArray(venue.positions)) return null;
  return asArray(venue.positions).filter(
    (position) =>
      positionMatchesTarget(position, targetIds) &&
      (positionValue(position) > 0.01 ||
        (positionValue(position) === 0 && positionShares(position) > 0 && position.value == null)),
  );
}

function dateIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function rowExpiryMs(row: QuarantineRow): number {
  const parsed = Number(row.expiry_ms);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowExposure(row: QuarantineRow): number {
  return numberFrom(row.risk_quarantine_exposure_dollars) ?? 0;
}

function compactRow(row: QuarantineRow): JsonRecord {
  const expiryMs = rowExpiryMs(row);
  return {
    id: row.id,
    createdAt: dateIso(row.created_at),
    expiryMs,
    expiryAt: expiryMs > 0 ? new Date(expiryMs).toISOString() : null,
    action: row.action,
    executionGroupId: row.execution_group_id,
    kalshiContractId: row.kalshi_contract_id,
    polymarketContractId: row.polymarket_contract_id,
    kalshiClientOrderId: row.kalshi_client_order_id,
    polymarketClientOrderId: row.polymarket_client_order_id,
    kalshiFillId: row.kalshi_fill_id,
    polymarketFillId: row.polymarket_fill_id,
    kalshiStatus: row.kalshi_status,
    polymarketStatus: row.polymarket_status,
    kalshiFillCount: numberFrom(row.kalshi_fill_count),
    polymarketFillCount: numberFrom(row.polymarket_fill_count),
    kalshiFillPrice: numberFrom(row.kalshi_fill_price),
    polymarketFillPrice: numberFrom(row.polymarket_fill_price),
    riskQuarantinedAt: dateIso(row.risk_quarantined_at),
    riskQuarantineExposureDollars: rowExposure(row),
    riskQuarantineReason: row.risk_quarantine_reason,
    failureReason: row.failure_reason,
  };
}

function summarizeRows(rows: QuarantineRow[]): JsonRecord {
  const byReason = new Map<string, { count: number; exposure: number; newestCreatedAt: string | null }>();
  const byStatus = new Map<string, { count: number; exposure: number; newestCreatedAt: string | null }>();
  let exposure = 0;
  let oldestCreatedAt: string | null = null;
  let newestCreatedAt: string | null = null;
  let oldestExpiryMs: number | null = null;
  let newestExpiryMs: number | null = null;
  let nonzeroExposureCount = 0;

  for (const row of rows) {
    const rowCreatedAt = dateIso(row.created_at);
    const expiryMs = rowExpiryMs(row);
    const rowExposureDollars = rowExposure(row);
    exposure += rowExposureDollars;
    if (rowExposureDollars > 0) nonzeroExposureCount += 1;
    if (rowCreatedAt && (!oldestCreatedAt || rowCreatedAt < oldestCreatedAt)) oldestCreatedAt = rowCreatedAt;
    if (rowCreatedAt && (!newestCreatedAt || rowCreatedAt > newestCreatedAt)) newestCreatedAt = rowCreatedAt;
    if (expiryMs > 0 && (oldestExpiryMs == null || expiryMs < oldestExpiryMs)) oldestExpiryMs = expiryMs;
    if (expiryMs > 0 && (newestExpiryMs == null || expiryMs > newestExpiryMs)) newestExpiryMs = expiryMs;

    const reasonKey = row.risk_quarantine_reason ?? "unknown";
    const reason = byReason.get(reasonKey) ?? { count: 0, exposure: 0, newestCreatedAt: null };
    reason.count += 1;
    reason.exposure += rowExposureDollars;
    if (rowCreatedAt && (!reason.newestCreatedAt || rowCreatedAt > reason.newestCreatedAt))
      reason.newestCreatedAt = rowCreatedAt;
    byReason.set(reasonKey, reason);

    const statusKey = `${row.action}|${row.kalshi_status ?? "null"}|${row.polymarket_status ?? "null"}`;
    const status = byStatus.get(statusKey) ?? { count: 0, exposure: 0, newestCreatedAt: null };
    status.count += 1;
    status.exposure += rowExposureDollars;
    if (rowCreatedAt && (!status.newestCreatedAt || rowCreatedAt > status.newestCreatedAt))
      status.newestCreatedAt = rowCreatedAt;
    byStatus.set(statusKey, status);
  }

  return {
    count: rows.length,
    exposureDollars: round(exposure),
    nonzeroExposureCount,
    oldestCreatedAt,
    newestCreatedAt,
    oldestExpiryMs,
    oldestExpiryAt: oldestExpiryMs == null ? null : new Date(oldestExpiryMs).toISOString(),
    newestExpiryMs,
    newestExpiryAt: newestExpiryMs == null ? null : new Date(newestExpiryMs).toISOString(),
    byReason: [...byReason.entries()]
      .map(([reason, value]) => ({
        reason,
        count: value.count,
        exposureDollars: round(value.exposure),
        newestCreatedAt: value.newestCreatedAt,
      }))
      .sort((left, right) => right.count - left.count || right.exposureDollars - left.exposureDollars),
    byStatus: [...byStatus.entries()]
      .map(([key, value]) => {
        const [action, kalshiStatus, polymarketStatus] = key.split("|");
        return {
          action,
          kalshiStatus: kalshiStatus === "null" ? null : kalshiStatus,
          polymarketStatus: polymarketStatus === "null" ? null : polymarketStatus,
          count: value.count,
          exposureDollars: round(value.exposure),
          newestCreatedAt: value.newestCreatedAt,
        };
      })
      .sort((left, right) => right.count - left.count || right.exposureDollars - left.exposureDollars),
  };
}

async function fetchJson(url: string, token?: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${new URL(url).pathname} failed ${response.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as unknown) : {};
}

function summarizePosition(position: JsonRecord): JsonRecord {
  return {
    id: position.id ?? null,
    market: position.market ?? null,
    marketId: position.marketId ?? position.market_id ?? null,
    ticker: position.ticker ?? null,
    contractId: position.contractId ?? position.contract_id ?? null,
    assetId: position.assetId ?? position.asset_id ?? null,
    tokenId: position.tokenId ?? position.token_id ?? null,
    outcome: position.outcome ?? null,
    side: position.side ?? null,
    shares: numberFrom(position.shares),
    quantity: numberFrom(position.quantity),
    count: numberFrom(position.count),
    value: numberFrom(position.value),
    positionValueDollars: numberFrom(position.positionValueDollars),
    currentValue: numberFrom(position.currentValue),
    marketValue: numberFrom(position.marketValue),
  };
}

function summarizePlatform(value: unknown): JsonRecord {
  const platform = asRecord(value);
  const positions = asArray(platform.positions);
  const openOrders = asArray(platform.openOrders);
  const positionValueDollars = positions.reduce(
    (total, position) => total + Math.abs(numberFrom(position.value) ?? 0),
    0,
  );
  const unknownValuePositionCount = positions.filter(
    (position) => numberFrom(position.shares) != null && numberFrom(position.value) == null,
  ).length;
  return {
    connectionStatus: platform.connectionStatus ?? null,
    positionCount: positions.length,
    positions: positions.map(summarizePosition),
    openOrders: openOrders.length,
    positiveValuePositions: positions.filter((position) => Math.abs(numberFrom(position.value) ?? 0) > 0.01).length,
    unknownValuePositionCount,
    positionValueDollars: round(positionValueDollars),
    openOrderSample: openOrders.slice(0, 10).map((order) => ({
      id: order.id ?? null,
      market: order.market ?? null,
      outcome: order.outcome ?? null,
      side: order.side ?? null,
      shares: numberFrom(order.shares),
      status: order.status ?? null,
    })),
  };
}

function summarizeSnapshot(snapshotPayload: unknown): JsonRecord {
  const snapshot = asRecord(snapshotPayload);
  const health = asRecord(snapshot.health);
  const execution = asRecord(snapshot.execution);
  const reconciliation = asRecord(execution.reconciliation);
  const userStreams = asRecord(execution.userStreams);
  const tradingActivity = asRecord(snapshot.tradingActivity);
  return {
    generatedAt:
      numberFrom(snapshot.generatedAt) == null ? null : new Date(numberFrom(snapshot.generatedAt) ?? 0).toISOString(),
    health: {
      ok: health.ok ?? null,
      arbEnabled: health.arbEnabled ?? null,
      liveTrading: health.liveTrading ?? null,
      liveOrderPlacementMode: health.liveOrderPlacementMode ?? null,
      liveOrderSize: health.liveOrderSize ?? null,
      liveMinBookDepthShares: health.liveMinBookDepthShares ?? null,
    },
    execution: {
      riskState: execution.riskState ?? null,
      riskStateReason: execution.riskStateReason ?? null,
      partialFillLocked: execution.partialFillLocked ?? null,
      circuitBreakerLocked: execution.circuitBreakerLocked ?? null,
      circuitBreakerReason: execution.circuitBreakerReason ?? null,
      userStreams: {
        ready: userStreams.ready ?? null,
        reason: userStreams.reason ?? null,
      },
      reconciliation: {
        enabled: reconciliation.enabled ?? null,
        clean: reconciliation.clean ?? null,
        reason: reconciliation.reason ?? null,
        quarantinedExposureDollars: reconciliation.quarantinedExposureDollars ?? null,
        quarantinedSignalCount: reconciliation.quarantinedSignalCount ?? null,
        quarantineCapDollars: reconciliation.quarantineCapDollars ?? null,
      },
    },
    tradingActivity: {
      kalshi: summarizePlatform(tradingActivity.kalshi),
      polymarket: summarizePlatform(tradingActivity.polymarket),
    },
  };
}

function summarizeHealth(healthPayload: unknown): JsonRecord {
  const health = asRecord(healthPayload);
  return {
    ok: health.ok ?? null,
    liveTrading: health.liveTrading ?? null,
    arbEnabled: health.arbEnabled ?? null,
    liveOrderPlacementMode: health.liveOrderPlacementMode ?? null,
    liveOrderSize: health.liveOrderSize ?? null,
    liveMinBookDepthShares: health.liveMinBookDepthShares ?? null,
  };
}

async function loadQuarantineRows(client: Queryable): Promise<QuarantineRow[]> {
  const result = await client.query<QuarantineRow>(`
    SELECT
      id::TEXT,
      created_at,
      updated_at,
      expiry_ms,
      action,
      failure_reason,
      execution_group_id,
      kalshi_contract_id,
      polymarket_contract_id,
      kalshi_client_order_id,
      polymarket_client_order_id,
      kalshi_fill_id,
      polymarket_fill_id,
      kalshi_status,
      polymarket_status,
      kalshi_fill_count,
      polymarket_fill_count,
      kalshi_fill_price,
      polymarket_fill_price,
      risk_quarantined_at,
      risk_quarantine_exposure_dollars,
      risk_quarantine_reason
    FROM cross_venue_arb_signals
    WHERE reconciliation_resolved_at IS NULL
      AND risk_quarantined_at IS NOT NULL
    ORDER BY created_at ASC, id ASC
  `);
  return result.rows;
}

async function dbGuardEvidence(client: Queryable, now: number, recentOrderLookbackMs: number): Promise<JsonRecord> {
  const [locks, futureExposure, latestEvents] = await Promise.all([
    client.query<ActiveLocksRow>("SELECT COUNT(*)::INT AS count FROM live_execution_locks WHERE cleared_at IS NULL"),
    client.query<FutureExposureRow>(
      `
      SELECT COUNT(*)::INT AS count,
             COALESCE(SUM(COALESCE(kalshi_fill_count, 0) + COALESCE(polymarket_fill_count, 0)), 0) AS filled_shares
      FROM cross_venue_arb_signals
      WHERE execution_group_id IS NOT NULL
        AND reconciliation_resolved_at IS NULL
        AND expiry_ms > $1
        AND (
          action = $2
          OR partial_fill = TRUE
          OR COALESCE(kalshi_fill_count, 0) > 0
          OR COALESCE(polymarket_fill_count, 0) > 0
          OR kalshi_status IN ($3, $4)
          OR polymarket_status IN ($3, $4)
        )
    `,
      [now, "filled", "unknown", "unexpected_fill_count"],
    ),
    client.query<LatestOrderEventRow>(
      `
      WITH latest AS (
        SELECT DISTINCT ON (COALESCE(venue_order_id, client_order_id))
               COALESCE(venue_order_id, client_order_id) AS order_key,
               venue,
               status,
               remaining_count,
               received_at
        FROM venue_order_events
        WHERE received_at >= to_timestamp($1 / 1000.0)
          AND COALESCE(venue_order_id, client_order_id) IS NOT NULL
        ORDER BY COALESCE(venue_order_id, client_order_id), received_at DESC
      )
      SELECT venue, status, remaining_count, received_at
      FROM latest
    `,
      [now - recentOrderLookbackMs],
    ),
  ]);

  const openOrderCandidates = latestEvents.rows.filter((row) => {
    const status = String(row.status ?? "").toLowerCase();
    const remaining = numberFrom(row.remaining_count) ?? 0;
    return remaining > 0 || (status !== "" && !terminalOrderStatuses.has(status));
  });

  return {
    activeLocks: Number(locks.rows[0]?.count ?? 0),
    futureUnresolvedExposureSignals: Number(futureExposure.rows[0]?.count ?? 0),
    futureUnresolvedExposureFillShares: numberFrom(futureExposure.rows[0]?.filled_shares) ?? 0,
    recentOrderLookbackMs,
    recentOpenOrderCandidates: openOrderCandidates.length,
    recentOpenOrderCandidateSample: openOrderCandidates.slice(0, 10).map((row) => ({
      venue: row.venue,
      status: row.status,
      remainingCount: numberFrom(row.remaining_count),
      receivedAt: dateIso(row.received_at),
    })),
  };
}

function guardFailures(evidence: {
  health: JsonRecord;
  snapshot: JsonRecord;
  db: JsonRecord;
  rows: QuarantineRow[];
  now: number;
  minExpiredMs: number;
}): string[] {
  const failures: string[] = [];
  const snapshotHealth = asRecord(evidence.snapshot.health);
  const execution = asRecord(evidence.snapshot.execution);
  const reconciliation = asRecord(execution.reconciliation);
  const tradingActivity = asRecord(evidence.snapshot.tradingActivity);
  const kalshi = asRecord(tradingActivity.kalshi);
  const polymarket = asRecord(tradingActivity.polymarket);
  const kalshiTargetIds = stringSet(evidence.rows.map((row) => row.kalshi_contract_id));
  const polymarketTargetIds = stringSet(evidence.rows.map((row) => row.polymarket_contract_id));
  const kalshiTargetPositions = targetPositivePositions(kalshi, kalshiTargetIds);
  const polymarketTargetPositions = targetPositivePositions(polymarket, polymarketTargetIds);

  if (evidence.health.ok !== true) failures.push("health.ok is not true");
  if (evidence.health.arbEnabled !== false) failures.push("health.arbEnabled is not false");
  if (snapshotHealth.arbEnabled !== false) failures.push("snapshot.health.arbEnabled is not false");
  if (execution.partialFillLocked !== false) failures.push("execution.partialFillLocked is not false");
  if (execution.circuitBreakerLocked !== false) failures.push("execution.circuitBreakerLocked is not false");
  if (reconciliation.clean !== true) failures.push("execution.reconciliation.clean is not true");
  if (Number(evidence.db.activeLocks ?? 0) !== 0) failures.push("active live_execution_locks exist");
  if (Number(evidence.db.futureUnresolvedExposureSignals ?? 0) !== 0)
    failures.push("future unresolved exposure signals exist");
  if (Number(evidence.db.recentOpenOrderCandidates ?? 0) !== 0)
    failures.push("recent worker-managed open order candidates exist");
  if (kalshi.connectionStatus !== "live") failures.push("Kalshi account source is not live");
  if (polymarket.connectionStatus !== "live") failures.push("Polymarket account source is not live");
  if (Number(kalshi.openOrders ?? 0) !== 0) failures.push("Kalshi open orders are not zero");
  if (Number(polymarket.openOrders ?? 0) !== 0) failures.push("Polymarket open orders are not zero");
  if (kalshiTargetPositions == null) {
    if (Number(kalshi.positionCount ?? 0) !== 0) failures.push("Kalshi positions are not zero");
    if (Number(kalshi.positionValueDollars ?? 0) > 0.01) failures.push("Kalshi position value is positive");
  } else if (kalshiTargetPositions.length > 0) {
    failures.push("Kalshi has positive-value positions for unresolved quarantine markets");
  }
  if (polymarketTargetPositions == null) {
    if (Number(polymarket.positiveValuePositions ?? 0) !== 0) failures.push("Polymarket has positive-value positions");
    if (Number(polymarket.unknownValuePositionCount ?? 0) !== 0)
      failures.push("Polymarket has positions with unknown value");
    if (Number(polymarket.positionValueDollars ?? 0) > 0.01) failures.push("Polymarket position value is positive");
  } else if (polymarketTargetPositions.length > 0) {
    failures.push("Polymarket has positive-value positions for unresolved quarantine markets");
  }

  if (evidence.rows.length === 0) return failures;

  const tooRecent = evidence.rows.filter((row) => {
    const expiryMs = rowExpiryMs(row);
    return expiryMs <= 0 || expiryMs + evidence.minExpiredMs > evidence.now;
  });
  if (tooRecent.length > 0) failures.push(`${tooRecent.length} quarantine row(s) are not expired by minExpiredMs`);

  return failures;
}

function resolutionForRow(row: QuarantineRow, evidence: JsonRecord): JsonRecord {
  return {
    resolvedBy: "operator-script",
    resolutionType: "settlement_reconciliation",
    executionGroupId: row.execution_group_id,
    polymarketOrderId: row.polymarket_fill_id,
    kalshiClientOrderId: row.kalshi_client_order_id,
    evidence: {
      script: "scripts/reconcile-historical-quarantines.ts",
      target: compactRow(row),
      global: evidence,
    },
    notes:
      "Historical expired quarantine reconciled for readiness; original action, status, failure, fill, and risk_quarantine fields were preserved.",
  };
}

async function applyResolution(
  client: Queryable,
  rows: QuarantineRow[],
  resolvedAt: string,
  reason: string,
  evidence: JsonRecord,
): Promise<JsonRecord> {
  const updatedIds: string[] = [];
  await client.query("BEGIN");
  try {
    const lockedRows = await loadQuarantineRows(client);
    const expectedIds = new Set(rows.map((row) => row.id));
    const lockedIds = new Set(lockedRows.map((row) => row.id));
    const missing = [...expectedIds].filter((id) => !lockedIds.has(id));
    const added = [...lockedIds].filter((id) => !expectedIds.has(id));
    if (missing.length > 0 || added.length > 0) {
      throw new Error(`quarantine target set changed before apply; missing=${missing.length} added=${added.length}`);
    }

    for (const row of lockedRows) {
      const resolution = resolutionForRow(row, evidence);
      const result = await client.query<{ id: string }>(
        `
        UPDATE cross_venue_arb_signals
        SET reconciliation_resolved_at = $2::TIMESTAMPTZ,
            reconciliation_resolution_reason = $3,
            reconciliation_resolution = $4::JSONB
        WHERE id = $1
          AND reconciliation_resolved_at IS NULL
          AND risk_quarantined_at IS NOT NULL
        RETURNING id::TEXT
      `,
        [row.id, resolvedAt, reason, JSON.stringify(resolution)],
      );
      if (result.rows[0]?.id) updatedIds.push(result.rows[0].id);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }

  return {
    applied: true,
    resolvedAt,
    updatedCount: updatedIds.length,
    updatedIds,
  };
}

async function writeReport(outDir: string, report: JsonRecord): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const safeTimestamp = String(report.generatedAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const filePath = path.resolve(outDir, `historical-quarantine-reconciliation-${safeTimestamp}.json`);
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  const dashboardToken = process.env.DASHBOARD_API_TOKEN?.trim();
  if (!dashboardToken) throw new Error("DASHBOARD_API_TOKEN is required for protected snapshot evidence");

  const now = Date.now();
  const generatedAt = new Date(now).toISOString();
  const pool = new pg.Pool({ connectionString });
  let report: JsonRecord | null = null;

  try {
    const [healthPayload, snapshotPayload] = await Promise.all([
      fetchJson(args.healthUrl),
      fetchJson(args.snapshotUrl, dashboardToken),
    ]);
    const health = summarizeHealth(healthPayload);
    const snapshot = summarizeSnapshot(snapshotPayload);

    const rows = await loadQuarantineRows(pool);
    const db = await dbGuardEvidence(pool, now, args.recentOrderLookbackMs);
    const rowSummary = summarizeRows(rows);
    const failures = guardFailures({
      health,
      snapshot,
      db,
      rows,
      now,
      minExpiredMs: args.minExpiredMs,
    });

    const evidence = {
      generatedAt,
      mode: args.apply ? "apply" : "dry-run",
      health,
      snapshot,
      db,
      unresolvedQuarantineSummary: rowSummary,
      minExpiredMs: args.minExpiredMs,
      allTargetsExpiredByMinAge: rows.every((row) => {
        const expiryMs = rowExpiryMs(row);
        return expiryMs > 0 && expiryMs + args.minExpiredMs <= now;
      }),
    };

    report = {
      generatedAt,
      mode: args.apply ? "apply" : "dry-run",
      safeToApply: failures.length === 0,
      failures,
      evidence,
      unresolvedQuarantines: rows.map(compactRow),
      applyResult: null,
    };

    if (args.apply) {
      if (failures.length > 0) {
        const reportPath = await writeReport(args.outDir, report);
        console.log(
          JSON.stringify(
            {
              mode: "apply",
              safeToApply: false,
              unresolvedQuarantineCount: rows.length,
              unresolvedQuarantineExposureDollars: rowSummary.exposureDollars,
              failures,
              reportPath,
            },
            null,
            2,
          ),
        );
        throw new Error(`Refusing to apply historical quarantine reconciliation: ${failures.join("; ")}`);
      }
      report.applyResult = await applyResolution(pool, rows, generatedAt, args.reason, evidence);
      const postRows = await loadQuarantineRows(pool);
      report.postApplyUnresolvedQuarantineSummary = summarizeRows(postRows);
    }

    const reportPath = await writeReport(args.outDir, report);
    const summary = {
      mode: args.apply ? "apply" : "dry-run",
      safeToApply: failures.length === 0,
      unresolvedQuarantineCount: rows.length,
      unresolvedQuarantineExposureDollars: rowSummary.exposureDollars,
      nonzeroExposureCount: rowSummary.nonzeroExposureCount,
      oldestCreatedAt: rowSummary.oldestCreatedAt,
      newestCreatedAt: rowSummary.newestCreatedAt,
      newestExpiryAt: rowSummary.newestExpiryAt,
      failures,
      applyResult: report.applyResult,
      reportPath,
    };
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    if (report && !report.reportWriteFailed) {
      try {
        const reportPath = await writeReport(args.outDir, {
          ...report,
          fatalError: error instanceof Error ? error.message : String(error),
        });
        console.error(`Wrote failure report to ${reportPath}`);
      } catch (writeError) {
        console.error(
          `Failed to write reconciliation report: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        );
      }
    }
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
