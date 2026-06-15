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
  reason: string;
};

type ActiveLockRow = {
  id: string;
  created_at: Date | string;
  reason: string;
  severity: string;
  source_signal_id: string | number | null;
  execution_group_id: string | null;
};

type SignalRow = {
  id: string;
  created_at: Date | string;
  expiry_ms: string | number;
  action: string;
  execution_strategy: string | null;
  failure_reason: string | null;
  execution_group_id: string | null;
  kalshi_contract_id: string | null;
  polymarket_contract_id: string | null;
  kalshi_status: string | null;
  polymarket_status: string | null;
  kalshi_fill_count: string | number | null;
  polymarket_fill_count: string | number | null;
  reconciliation_resolved_at: Date | string | null;
};

function usage(): string {
  return [
    "Usage: tsx scripts/resolve-live-lock-after-settlement.ts [--apply]",
    "  --apply                         Clear active live locks and resolve associated signal rows after all guards pass.",
    "  --out-dir=<path>                Report output directory. Default: tmp/live-lock-resolution",
    "  --health-url=<url>              Worker health URL. Default: http://127.0.0.1:8080/health",
    "  --snapshot-url=<url>            Protected dashboard snapshot URL. Default: http://127.0.0.1:8080/dashboard/snapshot",
    "  --min-expired-ms=<ms>           Required age past expiry. Default: 300000",
    "  --reason=<text>                 Resolution reason stored on each lock and signal.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    outDir: "tmp/live-lock-resolution",
    healthUrl: "http://127.0.0.1:8080/health",
    snapshotUrl: "http://127.0.0.1:8080/dashboard/snapshot",
    minExpiredMs: 5 * 60_000,
    reason: "operator resolved live execution lock after supported API/dashboard evidence showed entries paused, no open orders, no future unresolved exposure, and no positive-value venue positions",
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

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringSet(values: Array<string | null | undefined>): Set<string> {
  return new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean));
}

function positionValue(position: JsonRecord): number {
  return numberFrom(position.value)
    ?? numberFrom(position.positionValueDollars)
    ?? numberFrom(position.currentValue)
    ?? numberFrom(position.marketValue)
    ?? 0;
}

function positionShares(position: JsonRecord): number {
  return numberFrom(position.shares)
    ?? numberFrom(position.quantity)
    ?? numberFrom(position.count)
    ?? 0;
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
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
  return candidates.some((value) => targetIds.has(value));
}

function targetPositivePositions(venue: JsonRecord, targetIds: Set<string>): JsonRecord[] | null {
  if (!Array.isArray(venue.positions)) return null;
  return asArray(venue.positions).filter((position) => (
    positionMatchesTarget(position, targetIds)
    && (positionValue(position) > 0.01 || (positionValue(position) === 0 && positionShares(position) > 0 && position.value == null))
  ));
}

function dateIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function rowExpiryMs(row: SignalRow): number {
  const parsed = Number(row.expiry_ms);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactLock(row: ActiveLockRow): JsonRecord {
  return {
    id: row.id,
    createdAt: dateIso(row.created_at),
    reason: row.reason,
    severity: row.severity,
    sourceSignalId: row.source_signal_id,
    executionGroupId: row.execution_group_id,
  };
}

function compactSignal(row: SignalRow): JsonRecord {
  const expiryMs = rowExpiryMs(row);
  return {
    id: row.id,
    createdAt: dateIso(row.created_at),
    expiryMs,
    expiryAt: expiryMs > 0 ? new Date(expiryMs).toISOString() : null,
    action: row.action,
    executionStrategy: row.execution_strategy,
    failureReason: row.failure_reason,
    executionGroupId: row.execution_group_id,
    kalshiContractId: row.kalshi_contract_id,
    polymarketContractId: row.polymarket_contract_id,
    kalshiStatus: row.kalshi_status,
    polymarketStatus: row.polymarket_status,
    kalshiFillCount: numberFrom(row.kalshi_fill_count),
    polymarketFillCount: numberFrom(row.polymarket_fill_count),
    reconciliationResolvedAt: dateIso(row.reconciliation_resolved_at),
  };
}

async function fetchJson(url: string, token?: string): Promise<JsonRecord> {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${new URL(url).pathname} failed ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) as JsonRecord : {};
}

async function writeReport(outDir: string, evidence: JsonRecord): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.resolve(outDir, `live-lock-resolution-${timestamp}.json`);
  await writeFile(filePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

function guardFailures(input: {
  health: JsonRecord;
  snapshot: JsonRecord;
  activeLocks: ActiveLockRow[];
  relatedSignals: SignalRow[];
  futureExposureSignals: number;
  now: number;
  minExpiredMs: number;
}): string[] {
  const failures: string[] = [];
  const snapshotHealth = asRecord(input.snapshot.health);
  const execution = asRecord(input.snapshot.execution);
  const tradingActivity = asRecord(input.snapshot.tradingActivity);
  const kalshi = asRecord(tradingActivity.kalshi);
  const polymarket = asRecord(tradingActivity.polymarket);
  const kalshiTargetIds = stringSet(input.relatedSignals.map((row) => row.kalshi_contract_id));
  const polymarketTargetIds = stringSet(input.relatedSignals.map((row) => row.polymarket_contract_id));
  const kalshiTargetPositions = targetPositivePositions(kalshi, kalshiTargetIds);
  const polymarketTargetPositions = targetPositivePositions(polymarket, polymarketTargetIds);

  if (input.health.ok !== true) failures.push("health.ok is not true");
  if (input.health.arbEnabled !== false) failures.push("health.arbEnabled is not false");
  if (snapshotHealth.arbEnabled !== false) failures.push("snapshot.health.arbEnabled is not false");
  if (input.activeLocks.length === 0) failures.push("no active live_execution_locks found");
  if (input.relatedSignals.length === 0) failures.push("no unresolved signal rows found for active lock execution groups");
  if (Number(input.futureExposureSignals) !== 0) failures.push("future unresolved exposure signals exist");
  if (execution.partialFillLocked !== false) failures.push("execution.partialFillLocked is not false");

  if (kalshi.connectionStatus !== "live") failures.push("Kalshi account source is not live");
  if (polymarket.connectionStatus !== "live") failures.push("Polymarket account source is not live");
  if (Number(kalshi.openOrders ?? 0) !== 0) failures.push("Kalshi open orders are not zero");
  if (Number(polymarket.openOrders ?? 0) !== 0) failures.push("Polymarket open orders are not zero");
  if (kalshiTargetPositions == null) {
    if (Number(kalshi.positiveValuePositions ?? 0) !== 0) failures.push("Kalshi has positive-value positions");
    if (Number(kalshi.unknownValuePositionCount ?? 0) !== 0) failures.push("Kalshi has positions with unknown value");
    if (Number(kalshi.positionValueDollars ?? 0) > 0.01) failures.push("Kalshi position value is positive");
  } else if (kalshiTargetPositions.length > 0) {
    failures.push("Kalshi has positive-value positions for active lock markets");
  }
  if (polymarketTargetPositions == null) {
    if (Number(polymarket.positiveValuePositions ?? 0) !== 0) failures.push("Polymarket has positive-value positions");
    if (Number(polymarket.unknownValuePositionCount ?? 0) !== 0) failures.push("Polymarket has positions with unknown value");
    if (Number(polymarket.positionValueDollars ?? 0) > 0.01) failures.push("Polymarket position value is positive");
  } else if (polymarketTargetPositions.length > 0) {
    failures.push("Polymarket has positive-value positions for active lock markets");
  }

  const tooRecent = input.relatedSignals.filter((row) => {
    const expiryMs = rowExpiryMs(row);
    return expiryMs <= 0 || input.now - expiryMs < input.minExpiredMs;
  });
  if (tooRecent.length > 0) failures.push(`${tooRecent.length} related signal row(s) are not expired by minExpiredMs`);

  return failures;
}

async function applyResolution(client: pg.Client, input: {
  activeLocks: ActiveLockRow[];
  relatedSignals: SignalRow[];
  resolvedAt: string;
  reason: string;
  evidence: JsonRecord;
}): Promise<JsonRecord> {
  const lockIds = input.activeLocks.map((row) => row.id);
  const signalIds = input.relatedSignals.map((row) => row.id);
  const resolution = JSON.stringify({
    script: "scripts/resolve-live-lock-after-settlement.ts",
    resolvedAt: input.resolvedAt,
    activeLockIds: lockIds,
    relatedSignalIds: signalIds,
    evidence: input.evidence,
    note: "Original action, status, failure, fill, and risk fields are preserved; this records post-settlement operator reconciliation only.",
  });

  await client.query("BEGIN");
  try {
    const signals = await client.query(`
      UPDATE cross_venue_arb_signals
      SET reconciliation_resolved_at = $2::TIMESTAMPTZ,
          reconciliation_resolution_reason = $3,
          reconciliation_resolution = $4::JSONB
      WHERE id = ANY($1::BIGINT[])
        AND reconciliation_resolved_at IS NULL
      RETURNING id
    `, [signalIds, input.resolvedAt, input.reason, resolution]);
    const locks = await client.query(`
      UPDATE live_execution_locks
      SET cleared_at = $2::TIMESTAMPTZ,
          clear_reason = $3
      WHERE id = ANY($1::BIGINT[])
        AND cleared_at IS NULL
      RETURNING id
    `, [lockIds, input.resolvedAt, input.reason]);
    await client.query("COMMIT");
    return {
      resolvedSignalIds: signals.rows.map((row) => String(row.id)),
      clearedLockIds: locks.rows.map((row) => String(row.id)),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  const dashboardToken = process.env.DASHBOARD_API_TOKEN;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!dashboardToken) throw new Error("DASHBOARD_API_TOKEN is required");

  const now = Date.now();
  const [health, snapshot] = await Promise.all([
    fetchJson(args.healthUrl),
    fetchJson(args.snapshotUrl, dashboardToken),
  ]);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const activeLocks = await client.query<ActiveLockRow>(`
      SELECT id, created_at, reason, severity, source_signal_id, execution_group_id
      FROM live_execution_locks
      WHERE cleared_at IS NULL
      ORDER BY created_at DESC
    `);
    const executionGroupIds = activeLocks.rows
      .map((row) => row.execution_group_id)
      .filter((value): value is string => Boolean(value));
    const relatedSignals = executionGroupIds.length === 0
      ? { rows: [] as SignalRow[] }
      : await client.query<SignalRow>(`
        SELECT id, created_at, expiry_ms, action, execution_strategy, failure_reason,
               execution_group_id, kalshi_contract_id, polymarket_contract_id,
               kalshi_status, polymarket_status,
               kalshi_fill_count, polymarket_fill_count, reconciliation_resolved_at
        FROM cross_venue_arb_signals
        WHERE execution_group_id = ANY($1::TEXT[])
          AND reconciliation_resolved_at IS NULL
        ORDER BY created_at DESC
      `, [executionGroupIds]);
    const futureExposure = await client.query(`
      SELECT COUNT(*)::INT AS count
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
    `, [now, "filled", "unknown", "unexpected_fill_count"]);

    const evidence: JsonRecord = {
      generatedAt: new Date(now).toISOString(),
      mode: args.apply ? "apply" : "dry-run",
      health: {
        ok: health.ok,
        arbEnabled: health.arbEnabled,
        liveOrderPlacementMode: health.liveOrderPlacementMode,
        liveOrderSize: health.liveOrderSize,
        liveMinBookDepthShares: health.liveMinBookDepthShares,
      },
      snapshot: {
        health: {
          ok: asRecord(snapshot.health).ok,
          arbEnabled: asRecord(snapshot.health).arbEnabled,
          liveOrderPlacementMode: asRecord(snapshot.health).liveOrderPlacementMode,
        },
        execution: {
          riskState: asRecord(snapshot.execution).riskState,
          riskStateReason: asRecord(snapshot.execution).riskStateReason,
          partialFillLocked: asRecord(snapshot.execution).partialFillLocked,
          circuitBreakerLocked: asRecord(snapshot.execution).circuitBreakerLocked,
          circuitBreakerReason: asRecord(snapshot.execution).circuitBreakerReason,
        },
        tradingActivity: asRecord(snapshot.tradingActivity),
      },
      activeLocks: activeLocks.rows.map(compactLock),
      relatedSignals: relatedSignals.rows.map(compactSignal),
      futureExposureSignals: Number(futureExposure.rows[0]?.count ?? 0),
      minExpiredMs: args.minExpiredMs,
    };

    const failures = guardFailures({
      health,
      snapshot,
      activeLocks: activeLocks.rows,
      relatedSignals: relatedSignals.rows,
      futureExposureSignals: Number(futureExposure.rows[0]?.count ?? 0),
      now,
      minExpiredMs: args.minExpiredMs,
    });
    const safeToApply = failures.length === 0;
    let applyResult: JsonRecord | null = null;
    if (args.apply) {
      if (!safeToApply) throw new Error(`Refusing to resolve live lock: ${failures.join("; ")}`);
      applyResult = await applyResolution(client, {
        activeLocks: activeLocks.rows,
        relatedSignals: relatedSignals.rows,
        resolvedAt: new Date(now).toISOString(),
        reason: args.reason,
        evidence,
      });
    }

    const output = {
      mode: args.apply ? "apply" : "dry-run",
      safeToApply,
      activeLockCount: activeLocks.rows.length,
      relatedSignalCount: relatedSignals.rows.length,
      failures,
      applyResult,
      reportPath: await writeReport(args.outDir, { ...evidence, safeToApply, failures, applyResult }),
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
