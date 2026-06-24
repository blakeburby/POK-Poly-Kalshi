import type { LiveExecutionLock } from "../types";
import type { Queryable } from "./signals";

export interface LiveExecutionLockInput {
  reason: string;
  severity?: "warn" | "critical";
  sourceSignalId?: number | null;
  executionGroupId?: string | null;
  details?: Record<string, unknown>;
}

export interface LiveExecutionLockReader {
  getActiveLock(): Promise<LiveExecutionLock | null>;
}

export interface LiveExecutionLockWriter extends LiveExecutionLockReader {
  engageLock(input: LiveExecutionLockInput): Promise<LiveExecutionLock>;
}

interface LiveExecutionLockRow {
  id: string | number;
  created_at: string | Date;
  reason: string;
  severity: string;
  source_signal_id: string | number | null;
  execution_group_id: string | null;
  details: Record<string, unknown> | string | null;
  cleared_at: string | Date | null;
  clear_reason: string | null;
}

const LOCK_COLUMNS = `
  id, created_at, reason, severity, source_signal_id, execution_group_id,
  details, cleared_at, clear_reason
`;

function dateString(value: string | Date | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function detailsFromRow(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return { raw: value };
    }
  }
  return value;
}

function lockFromRow(row: LiveExecutionLockRow): LiveExecutionLock {
  return {
    id: Number(row.id),
    createdAt: dateString(row.created_at) ?? new Date(0).toISOString(),
    reason: row.reason,
    severity: row.severity === "warn" ? "warn" : "critical",
    sourceSignalId: row.source_signal_id == null ? null : Number(row.source_signal_id),
    executionGroupId: row.execution_group_id,
    details: detailsFromRow(row.details),
    clearedAt: dateString(row.cleared_at),
    clearReason: row.clear_reason,
  };
}

export class LiveExecutionLockStore implements LiveExecutionLockWriter {
  constructor(private readonly db: Queryable) {}

  async getActiveLock(): Promise<LiveExecutionLock | null> {
    const result = await this.db.query<LiveExecutionLockRow>(`
      SELECT ${LOCK_COLUMNS}
      FROM live_execution_locks
      WHERE cleared_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return result.rows[0] ? lockFromRow(result.rows[0]) : null;
  }

  async engageLock(input: LiveExecutionLockInput): Promise<LiveExecutionLock> {
    const existing = await this.getActiveLock();
    if (existing) return existing;

    const result = await this.db.query<LiveExecutionLockRow>(
      `
      INSERT INTO live_execution_locks (
        reason, severity, source_signal_id, execution_group_id, details
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb
      )
      RETURNING ${LOCK_COLUMNS}
    `,
      [
        input.reason,
        input.severity ?? "critical",
        input.sourceSignalId ?? null,
        input.executionGroupId ?? null,
        JSON.stringify(input.details ?? {}),
      ],
    );
    if (!result.rows[0]) throw new Error("live execution lock insert did not return a row");
    return lockFromRow(result.rows[0]);
  }
}
