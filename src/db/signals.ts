import type {
  ArbCandidate,
  ArbLeg,
  DashboardSignal,
  ExecutionTimings,
  FillQualitySnapshot,
  LeadLagSnapshot,
  LegDirection,
  QuoteSnapshot,
  ReconciliationResolution,
  LiveRecoveryStatus,
  SignalAction,
  SignalInsert,
  SignalUpdate,
  Venue,
  VenueConfirmations,
} from "../types";
import type { FilledAttempt } from "../scanner/reentry";
import { buildSyntheticStructureRisk } from "../scanner/payoff";
import { buildLiveExecutionQualityStatus, liveExecutionQualityBlockReason, type LiveExecutionQualityOptions } from "../execution/execution-quality";

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
}

interface DashboardSignalRow {
  id: string | number;
  created_at: string | Date;
  updated_at: string | Date;
  pair_key: string;
  expiry_ms: string | number;
  kalshi_contract_id: string;
  polymarket_contract_id: string;
  lower_venue: string;
  lower_contract_id: string;
  lower_strike: string | number;
  lower_direction: string;
  lower_ask: string | number;
  higher_venue: string;
  higher_contract_id: string;
  higher_strike: string | number;
  higher_direction: string;
  higher_ask: string | number;
  premium: string | number;
  guaranteed_profit: string | number;
  overlap_profit: string | number;
  threshold: string | number;
  action: string;
  failure_reason: string | null;
  kalshi_fill_id: string | null;
  polymarket_fill_id: string | null;
  kalshi_fill_price: string | number | null;
  polymarket_fill_price: string | number | null;
  execution_group_id: string | null;
  kalshi_client_order_id: string | null;
  polymarket_client_order_id: string | null;
  kalshi_status: string | null;
  polymarket_status: string | null;
  kalshi_fill_count: string | number | null;
  polymarket_fill_count: string | number | null;
  kalshi_requested_at: string | Date | null;
  kalshi_responded_at: string | Date | null;
  polymarket_requested_at: string | Date | null;
  polymarket_responded_at: string | Date | null;
  kalshi_error: string | null;
  polymarket_error: string | null;
  partial_fill: boolean | string | null;
  quote_snapshot: QuoteSnapshot | string | null;
  depth_vwap: string | number | null;
  projected_edge_after_fees: string | number | null;
  lead_lag_snapshot: LeadLagSnapshot | string | null;
  fill_quality_snapshot: FillQualitySnapshot | string | null;
  expected_executable_edge: string | number | null;
  execution_timings: ExecutionTimings | string | null;
  venue_confirmations: VenueConfirmations | string | null;
  execution_strategy: string | null;
  risk_hedge: boolean | string | null;
  realized_guaranteed_profit: string | number | null;
  hedge_cap_price: string | number | null;
  reconciliation_resolved_at: string | Date | null;
  reconciliation_resolution_reason: string | null;
  reconciliation_resolution: ReconciliationResolution | string | null;
  recovery_status: string | null;
  recovery_attempts: string | number | null;
  recovery_evidence: Record<string, unknown> | string | null;
  finalization_ms: string | number | null;
  risk_quarantined_at: string | Date | null;
  risk_quarantine_reason: string | null;
  risk_quarantine_exposure_dollars: string | number | null;
  risk_quarantine_evidence: Record<string, unknown> | string | null;
}

interface LiveExposureRow {
  id: string | number;
  pair_key: string;
  expiry_ms: string | number;
  kalshi_contract_id: string;
  polymarket_contract_id: string;
  lower_venue: string;
  lower_contract_id: string;
  lower_direction: string;
  higher_venue: string;
  higher_contract_id: string;
  higher_direction: string;
  kalshi_fill_count: string | number | null;
  polymarket_fill_count: string | number | null;
  reconciliation_resolved_at: string | Date | null;
  risk_quarantined_at?: string | Date | null;
  risk_quarantine_exposure_dollars?: string | number | null;
}

interface LiveReconciliationRow {
  id: string | number;
  action: string;
  partial_fill: boolean | string | null;
  kalshi_status: string | null;
  polymarket_status: string | null;
  kalshi_fill_count: string | number | null;
  polymarket_fill_count: string | number | null;
  venue_confirmations: VenueConfirmations | string | null;
  reconciliation_resolved_at: string | Date | null;
  risk_quarantined_at: string | Date | null;
}

interface QuarantineExposureRow {
  total: string | number | null;
  count: string | number | null;
}

interface LiveSubmittedAttemptCountRow {
  attempt_count: string | number | null;
}

const SIGNAL_COLUMNS = `
  id, created_at, updated_at, pair_key, expiry_ms,
  kalshi_contract_id, polymarket_contract_id,
  lower_venue, lower_contract_id, lower_strike, lower_direction, lower_ask,
  higher_venue, higher_contract_id, higher_strike, higher_direction, higher_ask,
  premium, guaranteed_profit, overlap_profit, threshold, action, failure_reason,
  kalshi_fill_id, polymarket_fill_id, kalshi_fill_price, polymarket_fill_price,
  execution_group_id, kalshi_client_order_id, polymarket_client_order_id,
  kalshi_status, polymarket_status, kalshi_fill_count, polymarket_fill_count,
  kalshi_requested_at, kalshi_responded_at, polymarket_requested_at, polymarket_responded_at,
  kalshi_error, polymarket_error, partial_fill,
  quote_snapshot, depth_vwap, projected_edge_after_fees, lead_lag_snapshot, fill_quality_snapshot, expected_executable_edge,
  execution_timings, venue_confirmations,
  execution_strategy, risk_hedge, realized_guaranteed_profit, hedge_cap_price,
  reconciliation_resolved_at, reconciliation_resolution_reason, reconciliation_resolution,
  recovery_status, recovery_attempts, recovery_evidence, finalization_ms,
  risk_quarantined_at, risk_quarantine_reason, risk_quarantine_exposure_dollars, risk_quarantine_evidence
`;

const LIVE_SIGNAL_COLUMNS = `
  id, created_at, updated_at, pair_key, expiry_ms,
  kalshi_contract_id, polymarket_contract_id,
  lower_venue, lower_contract_id, lower_strike, lower_direction, lower_ask,
  higher_venue, higher_contract_id, higher_strike, higher_direction, higher_ask,
  premium, guaranteed_profit, overlap_profit, threshold, action, failure_reason,
  kalshi_fill_id, polymarket_fill_id, kalshi_fill_price, polymarket_fill_price,
  execution_group_id, kalshi_client_order_id, polymarket_client_order_id,
  kalshi_status, polymarket_status, kalshi_fill_count, polymarket_fill_count,
  kalshi_requested_at, kalshi_responded_at, polymarket_requested_at, polymarket_responded_at,
  kalshi_error, polymarket_error, partial_fill,
  NULL::JSONB AS quote_snapshot,
  depth_vwap, projected_edge_after_fees,
  NULL::JSONB AS lead_lag_snapshot,
  NULL::JSONB AS fill_quality_snapshot,
  expected_executable_edge,
  execution_timings,
  NULL::JSONB AS venue_confirmations,
  execution_strategy, risk_hedge, realized_guaranteed_profit, hedge_cap_price,
  reconciliation_resolved_at, reconciliation_resolution_reason,
  NULL::JSONB AS reconciliation_resolution,
  recovery_status, recovery_attempts,
  NULL::JSONB AS recovery_evidence,
  finalization_ms,
  risk_quarantined_at, risk_quarantine_reason, risk_quarantine_exposure_dollars,
  NULL::JSONB AS risk_quarantine_evidence
`;

function numberFrom(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function optionalDateString(value: string | Date | null): string | null {
  if (value == null) return null;
  return dateString(value);
}

function booleanFrom(value: boolean | string | null): boolean {
  if (typeof value === "boolean") return value;
  return value === "true" || value === "t" || value === "1";
}

function recoveryStatusFrom(value: string | null | undefined): LiveRecoveryStatus | null {
  if (
    value === "none"
    || value === "pretrade_retry"
    || value === "finalizing"
    || value === "auto_resolved_no_exposure"
    || value === "auto_resolved_paired_fill"
    || value === "risk_quarantined"
    || value === "operator_required"
  ) return value;
  return null;
}

function confirmationStatus(confirmations: VenueConfirmations | null, venue: Venue): string | null {
  const value = confirmations?.[venue];
  if (!value || typeof value !== "object") return null;
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}

function confirmedByUserStream(confirmations: VenueConfirmations | null, venue: Venue): boolean {
  const status = confirmationStatus(confirmations, venue)?.toLowerCase() ?? "";
  return ["confirmed", "matched", "filled"].includes(status);
}

function jsonFromRow<T>(value: T | string | null): T | null {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function legFromRow(row: DashboardSignalRow, side: "lower" | "higher"): ArbLeg {
  return {
    venue: row[`${side}_venue`] as Venue,
    contractId: row[`${side}_contract_id`],
    direction: row[`${side}_direction`] as LegDirection,
    strike: Number(row[`${side}_strike`]),
    ask: Number(row[`${side}_ask`]),
  };
}

function signalFromRow(row: DashboardSignalRow): DashboardSignal {
  const lower = legFromRow(row, "lower");
  const higher = legFromRow(row, "higher");
  const threshold = Number(row.threshold);
  return {
    id: Number(row.id),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
    pairKey: row.pair_key,
    expiryMs: Number(row.expiry_ms),
    kalshiContractId: row.kalshi_contract_id,
    polymarketContractId: row.polymarket_contract_id,
    lower,
    higher,
    premium: Number(row.premium),
    guaranteedProfit: Number(row.guaranteed_profit),
    overlapProfit: Number(row.overlap_profit),
    threshold,
    action: row.action as SignalAction,
    failureReason: row.failure_reason,
    kalshiFillId: row.kalshi_fill_id,
    polymarketFillId: row.polymarket_fill_id,
    kalshiFillPrice: numberFrom(row.kalshi_fill_price),
    polymarketFillPrice: numberFrom(row.polymarket_fill_price),
    executionGroupId: row.execution_group_id,
    kalshiClientOrderId: row.kalshi_client_order_id,
    polymarketClientOrderId: row.polymarket_client_order_id,
    kalshiStatus: row.kalshi_status,
    polymarketStatus: row.polymarket_status,
    kalshiFillCount: numberFrom(row.kalshi_fill_count),
    polymarketFillCount: numberFrom(row.polymarket_fill_count),
    kalshiRequestedAt: optionalDateString(row.kalshi_requested_at),
    kalshiRespondedAt: optionalDateString(row.kalshi_responded_at),
    polymarketRequestedAt: optionalDateString(row.polymarket_requested_at),
    polymarketRespondedAt: optionalDateString(row.polymarket_responded_at),
    kalshiError: row.kalshi_error,
    polymarketError: row.polymarket_error,
    partialFill: booleanFrom(row.partial_fill),
    quoteSnapshot: jsonFromRow<QuoteSnapshot>(row.quote_snapshot),
    depthVwap: numberFrom(row.depth_vwap),
    projectedEdgeAfterFees: numberFrom(row.projected_edge_after_fees),
    leadLagSnapshot: jsonFromRow<LeadLagSnapshot>(row.lead_lag_snapshot),
    fillQualitySnapshot: jsonFromRow<FillQualitySnapshot>(row.fill_quality_snapshot),
    expectedExecutableEdge: numberFrom(row.expected_executable_edge),
    executionTimings: jsonFromRow<ExecutionTimings>(row.execution_timings),
    venueConfirmations: jsonFromRow<VenueConfirmations>(row.venue_confirmations),
    executionStrategy: row.execution_strategy === "polymarket_first_exact" ? "polymarket_first_exact"
      : row.execution_strategy === "parallel_limit_rest" ? "parallel_limit_rest"
      : row.execution_strategy === "parallel_fak" ? "parallel_fak"
      : row.execution_strategy === "parallel_fok" ? "parallel_fok"
      : row.execution_strategy === "parallel_market" ? "parallel_market"
      : row.execution_strategy === "parallel_canary" ? "parallel_canary"
      : row.execution_strategy === "sequential_hedge" ? "sequential_hedge"
      : null,
    riskHedge: booleanFrom(row.risk_hedge),
    realizedGuaranteedProfit: numberFrom(row.realized_guaranteed_profit),
    hedgeCapPrice: numberFrom(row.hedge_cap_price),
    reconciliationResolvedAt: optionalDateString(row.reconciliation_resolved_at),
    reconciliationResolutionReason: row.reconciliation_resolution_reason,
    reconciliationResolution: jsonFromRow<ReconciliationResolution>(row.reconciliation_resolution),
    recoveryStatus: recoveryStatusFrom(row.recovery_status),
    recoveryAttempts: numberFrom(row.recovery_attempts),
    recoveryEvidence: jsonFromRow<Record<string, unknown>>(row.recovery_evidence),
    finalizationMs: numberFrom(row.finalization_ms),
    riskQuarantinedAt: optionalDateString(row.risk_quarantined_at),
    riskQuarantineReason: row.risk_quarantine_reason,
    riskQuarantineExposureDollars: numberFrom(row.risk_quarantine_exposure_dollars),
    riskQuarantineEvidence: jsonFromRow<Record<string, unknown>>(row.risk_quarantine_evidence),
    risk: buildSyntheticStructureRisk(lower, higher, threshold),
  };
}

export class SignalStore {
  constructor(private readonly db: Queryable) {}

  async insertSignal(input: SignalInsert): Promise<number> {
    const { candidate } = input;
    const result = await this.db.query<{ id: string | number }>(`
      INSERT INTO cross_venue_arb_signals (
        pair_key, expiry_ms, kalshi_contract_id, polymarket_contract_id,
        lower_venue, lower_contract_id, lower_strike, lower_direction, lower_ask,
        higher_venue, higher_contract_id, higher_strike, higher_direction, higher_ask,
        premium, guaranteed_profit, overlap_profit, threshold, action, failure_reason
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20
      )
      RETURNING id
    `, [
      candidate.pairKey,
      candidate.expiryMs,
      candidate.kalshiContractId,
      candidate.polymarketContractId,
      candidate.lower.venue,
      candidate.lower.contractId,
      candidate.lower.strike,
      candidate.lower.direction,
      candidate.lower.ask,
      candidate.higher.venue,
      candidate.higher.contractId,
      candidate.higher.strike,
      candidate.higher.direction,
      candidate.higher.ask,
      candidate.premium,
      candidate.guaranteedProfit,
      candidate.overlapProfit,
      candidate.threshold,
      input.action,
      input.failureReason ?? null,
    ]);
    const id = Number(result.rows[0]?.id);
    if (!Number.isFinite(id)) throw new Error("Signal insert did not return an id");
    return id;
  }

  async updateSignal(id: number, update: SignalUpdate): Promise<DashboardSignal | null> {
    const result = await this.db.query<DashboardSignalRow>(`
      UPDATE cross_venue_arb_signals
      SET action = $2,
          failure_reason = $3,
          kalshi_fill_id = $4,
          polymarket_fill_id = $5,
          kalshi_fill_price = $6,
          polymarket_fill_price = $7,
          execution_group_id = $8,
          kalshi_client_order_id = $9,
          polymarket_client_order_id = $10,
          kalshi_status = $11,
          polymarket_status = $12,
          kalshi_fill_count = $13,
          polymarket_fill_count = $14,
          kalshi_requested_at = CASE WHEN $15::TEXT IS NULL THEN NULL ELSE $15::TIMESTAMPTZ END,
          kalshi_responded_at = CASE WHEN $16::TEXT IS NULL THEN NULL ELSE $16::TIMESTAMPTZ END,
          polymarket_requested_at = CASE WHEN $17::TEXT IS NULL THEN NULL ELSE $17::TIMESTAMPTZ END,
          polymarket_responded_at = CASE WHEN $18::TEXT IS NULL THEN NULL ELSE $18::TIMESTAMPTZ END,
          kalshi_error = $19,
          polymarket_error = $20,
          partial_fill = $21,
          quote_snapshot = CASE WHEN $22::TEXT IS NULL THEN NULL ELSE $22::JSONB END,
          depth_vwap = $23,
          projected_edge_after_fees = $24,
          fill_quality_snapshot = CASE WHEN $25::TEXT IS NULL THEN NULL ELSE $25::JSONB END,
          expected_executable_edge = $26,
          execution_timings = CASE WHEN $27::TEXT IS NULL THEN NULL ELSE $27::JSONB END,
          venue_confirmations = CASE WHEN $28::TEXT IS NULL THEN NULL ELSE $28::JSONB END,
          execution_strategy = $29,
          risk_hedge = $30,
          realized_guaranteed_profit = $31,
          hedge_cap_price = $32,
          reconciliation_resolved_at = CASE WHEN $33::TEXT IS NULL THEN NULL ELSE $33::TIMESTAMPTZ END,
          reconciliation_resolution_reason = $34,
          reconciliation_resolution = CASE WHEN $35::TEXT IS NULL THEN NULL ELSE $35::JSONB END,
          recovery_status = $36,
          recovery_attempts = $37,
          recovery_evidence = CASE WHEN $38::TEXT IS NULL THEN NULL ELSE $38::JSONB END,
          finalization_ms = $39,
          risk_quarantined_at = CASE WHEN $40::TEXT IS NULL THEN NULL ELSE $40::TIMESTAMPTZ END,
          risk_quarantine_reason = $41,
          risk_quarantine_exposure_dollars = $42,
          risk_quarantine_evidence = CASE WHEN $43::TEXT IS NULL THEN NULL ELSE $43::JSONB END,
          lead_lag_snapshot = CASE WHEN $44::TEXT IS NULL THEN NULL ELSE $44::JSONB END,
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${SIGNAL_COLUMNS}
    `, [
      id,
      update.action,
      update.failureReason ?? null,
      update.kalshiFillId ?? null,
      update.polymarketFillId ?? null,
      update.kalshiFillPrice ?? null,
      update.polymarketFillPrice ?? null,
      update.executionGroupId ?? null,
      update.kalshiClientOrderId ?? null,
      update.polymarketClientOrderId ?? null,
      update.kalshiStatus ?? null,
      update.polymarketStatus ?? null,
      update.kalshiFillCount ?? null,
      update.polymarketFillCount ?? null,
      update.kalshiRequestedAt ?? null,
      update.kalshiRespondedAt ?? null,
      update.polymarketRequestedAt ?? null,
      update.polymarketRespondedAt ?? null,
      update.kalshiError ?? null,
      update.polymarketError ?? null,
      update.partialFill ?? false,
      update.quoteSnapshot == null ? null : JSON.stringify(update.quoteSnapshot),
      update.depthVwap ?? null,
      update.projectedEdgeAfterFees ?? null,
      update.fillQualitySnapshot == null ? null : JSON.stringify(update.fillQualitySnapshot),
      update.expectedExecutableEdge ?? update.fillQualitySnapshot?.expectedExecutableEdge ?? null,
      update.executionTimings == null ? null : JSON.stringify(update.executionTimings),
      update.venueConfirmations == null ? null : JSON.stringify(update.venueConfirmations),
      update.executionStrategy ?? null,
      update.riskHedge ?? false,
      update.realizedGuaranteedProfit ?? null,
      update.hedgeCapPrice ?? null,
      update.reconciliationResolvedAt ?? null,
      update.reconciliationResolutionReason ?? null,
      update.reconciliationResolution == null ? null : JSON.stringify(update.reconciliationResolution),
      update.recoveryStatus ?? null,
      update.recoveryAttempts ?? null,
      update.recoveryEvidence == null ? null : JSON.stringify(update.recoveryEvidence),
      update.finalizationMs ?? null,
      update.riskQuarantinedAt ?? null,
      update.riskQuarantineReason ?? null,
      update.riskQuarantineExposureDollars ?? null,
      update.riskQuarantineEvidence == null ? null : JSON.stringify(update.riskQuarantineEvidence),
      update.leadLagSnapshot == null ? null : JSON.stringify(update.leadLagSnapshot),
    ]);
    return result.rows[0] ? signalFromRow(result.rows[0]) : null;
  }

  async loadRecentFilledAttempts(): Promise<FilledAttempt[]> {
    const result = await this.db.query<{ pair_key: string; filled_at_ms: string | number }>(`
      SELECT pair_key, EXTRACT(EPOCH FROM MAX(updated_at)) * 1000 AS filled_at_ms
      FROM cross_venue_arb_signals
      WHERE action = 'filled'
        AND execution_group_id IS NOT NULL
      GROUP BY pair_key
    `);
    return result.rows
      .map((row) => ({ pairKey: row.pair_key, filledAtMs: Number(row.filled_at_ms) }))
      .filter((row) => Number.isFinite(row.filledAtMs));
  }

  async unresolvedRiskQuarantineExposureDollars(): Promise<number> {
    const status = await this.liveRiskQuarantineStatus();
    return status.total;
  }

  async liveRiskQuarantineStatus(): Promise<{ total: number; count: number }> {
    const result = await this.db.query<QuarantineExposureRow>(`
      SELECT COALESCE(SUM(risk_quarantine_exposure_dollars), 0) AS total,
             COUNT(*) AS count
      FROM cross_venue_arb_signals
      WHERE reconciliation_resolved_at IS NULL
        AND risk_quarantined_at IS NOT NULL
    `);
    return {
      total: numberFrom(result.rows[0]?.total ?? null) ?? 0,
      count: numberFrom(result.rows[0]?.count ?? null) ?? 0,
    };
  }

  async liveQuarantineBlockReason(maxUnresolvedExposureDollars?: number): Promise<string | null> {
    if (maxUnresolvedExposureDollars == null || !Number.isFinite(maxUnresolvedExposureDollars)) return null;
    const status = await this.liveRiskQuarantineStatus();
    if (status.total > maxUnresolvedExposureDollars + 1e-9) {
      return `live unresolved quarantined exposure ${status.total.toFixed(2)} exceeds cap ${maxUnresolvedExposureDollars.toFixed(2)} across ${status.count} signals`;
    }
    return null;
  }

  async liveExposureBlockReason(
    candidate: ArbCandidate,
    now: number,
    maxTradesPerWindow: number,
    maxUnresolvedExposureDollars?: number,
  ): Promise<string | null> {
    const quarantineReason = await this.liveQuarantineBlockReason(maxUnresolvedExposureDollars);
    if (quarantineReason) return quarantineReason;

    const result = await this.db.query<LiveExposureRow>(`
      SELECT id, pair_key, expiry_ms, kalshi_contract_id, polymarket_contract_id,
             lower_venue, lower_contract_id, lower_direction,
             higher_venue, higher_contract_id, higher_direction,
             kalshi_fill_count, polymarket_fill_count, reconciliation_resolved_at,
             risk_quarantined_at, risk_quarantine_exposure_dollars
      FROM cross_venue_arb_signals
      WHERE execution_group_id IS NOT NULL
        AND reconciliation_resolved_at IS NULL
        AND risk_quarantined_at IS NULL
        AND expiry_ms = $1
        AND expiry_ms > $2
        AND (
          action = 'filled'
          OR partial_fill = TRUE
          OR COALESCE(kalshi_fill_count, 0) > 0
          OR COALESCE(polymarket_fill_count, 0) > 0
        )
      ORDER BY updated_at DESC
      LIMIT 50
    `, [candidate.expiryMs, now]);

    const maxTrades = Math.max(0, Math.floor(maxTradesPerWindow));
    if (result.rows.length >= maxTrades) {
      return `live max trades per window reached for expiry ${candidate.expiryMs}: ${result.rows.length}/${maxTrades}`;
    }

    for (const row of result.rows) {
      if (row.reconciliation_resolved_at != null) continue;
      if (row.kalshi_contract_id === candidate.kalshiContractId) {
        return `live Kalshi leg ${candidate.kalshiContractId} already has exposure in signal #${row.id}`;
      }
      if (row.polymarket_contract_id === candidate.polymarketContractId) {
        return `live Polymarket leg ${candidate.polymarketContractId} already has exposure in signal #${row.id}`;
      }

      const exposedLegs = [
        { venue: row.lower_venue, contractId: row.lower_contract_id, direction: row.lower_direction },
        { venue: row.higher_venue, contractId: row.higher_contract_id, direction: row.higher_direction },
      ];
      const candidateLegs = [
        candidate.lower,
        candidate.higher,
      ];
      for (const exposed of exposedLegs) {
        if (candidateLegs.some((leg) => leg.venue === exposed.venue && leg.contractId === exposed.contractId && leg.direction === exposed.direction)) {
          return `live ${exposed.venue} ${exposed.direction} leg ${exposed.contractId} already has exposure in signal #${row.id}`;
        }
      }
    }

    return null;
  }

  async liveSubmittedAttemptBlockReason(
    candidate: ArbCandidate,
    now: number,
    maxTradesPerWindow: number,
  ): Promise<string | null> {
    const maxTrades = Math.max(0, Math.floor(maxTradesPerWindow));
    const result = await this.db.query<LiveSubmittedAttemptCountRow>(`
      SELECT COUNT(*) AS attempt_count
      FROM cross_venue_arb_signals
      WHERE execution_group_id IS NOT NULL
        AND expiry_ms = $1
        AND expiry_ms > $2
        AND action IN ('filled', 'failed')
    `, [candidate.expiryMs, now]);
    const attemptCount = numberFrom(result.rows[0]?.attempt_count ?? null) ?? 0;
    if (attemptCount >= maxTrades) {
      return `live submitted attempt limit reached for expiry ${candidate.expiryMs}: ${attemptCount}/${maxTrades}`;
    }
    return null;
  }

  async listLiveExposureSignals(now: number, limit = 500): Promise<DashboardSignal[]> {
    const result = await this.db.query<DashboardSignalRow>(`
      SELECT ${LIVE_SIGNAL_COLUMNS}
      FROM cross_venue_arb_signals
      WHERE execution_group_id IS NOT NULL
        AND reconciliation_resolved_at IS NULL
        AND expiry_ms > $1
        AND (
          action = 'filled'
          OR partial_fill = TRUE
          OR COALESCE(kalshi_fill_count, 0) > 0
          OR COALESCE(polymarket_fill_count, 0) > 0
          OR kalshi_status IN ('unknown', 'unexpected_fill_count')
          OR polymarket_status IN ('unknown', 'unexpected_fill_count')
        )
      ORDER BY updated_at DESC
      LIMIT $2
    `, [now, limit]);
    return result.rows.map(signalFromRow);
  }

  async listLiveSubmittedAttemptSignals(now: number, limit = 500): Promise<DashboardSignal[]> {
    const result = await this.db.query<DashboardSignalRow>(`
      SELECT ${LIVE_SIGNAL_COLUMNS}
      FROM cross_venue_arb_signals
      WHERE execution_group_id IS NOT NULL
        AND expiry_ms > $1
        AND action IN ('filled', 'failed')
      ORDER BY updated_at DESC
      LIMIT $2
    `, [now, limit]);
    return result.rows.map(signalFromRow);
  }

  async listLiveExactExposureSignals(limit = 500): Promise<DashboardSignal[]> {
    const result = await this.db.query<DashboardSignalRow>(`
      SELECT ${LIVE_SIGNAL_COLUMNS}
      FROM cross_venue_arb_signals
      WHERE execution_group_id IS NOT NULL
        AND reconciliation_resolved_at IS NULL
        AND (
          risk_quarantined_at IS NOT NULL
          OR partial_fill = TRUE
          OR ABS(COALESCE(kalshi_fill_count, 0) - COALESCE(polymarket_fill_count, 0)) > 0.000001
          OR kalshi_status IN ('unknown', 'unexpected_fill_count')
          OR polymarket_status IN ('unknown', 'unexpected_fill_count')
        )
      ORDER BY updated_at DESC
      LIMIT $1
    `, [limit]);
    return result.rows.map(signalFromRow);
  }

  async liveExactExposureBlockReason(_now: number): Promise<string | null> {
    const signals = await this.listLiveExactExposureSignals(50);
    const signal = signals[0];
    if (!signal) return null;
    const kalshiCount = signal.kalshiFillCount ?? 0;
    const polymarketCount = signal.polymarketFillCount ?? 0;
    if (signal.riskQuarantinedAt != null) {
      return `live exact-exposure guard blocked: signal #${signal.id} has unresolved quarantined exposure`;
    }
    if (signal.partialFill) return `live exact-exposure guard blocked: signal #${signal.id} is marked partial_fill`;
    if (Math.abs(kalshiCount - polymarketCount) > 0.000001) {
      return `live exact-exposure guard blocked: signal #${signal.id} fill mismatch kalshi=${kalshiCount} polymarket=${polymarketCount}`;
    }
    return `live exact-exposure guard blocked: signal #${signal.id} has unresolved venue status`;
  }

  async listLiveExecutionQualitySignals(now: number, lookbackMs: number, limit = 50): Promise<DashboardSignal[]> {
    const sinceMs = Math.max(0, now - Math.max(0, lookbackMs));
    const result = await this.db.query<DashboardSignalRow>(`
      SELECT ${LIVE_SIGNAL_COLUMNS}
      FROM cross_venue_arb_signals
      WHERE execution_group_id IS NOT NULL
        AND action IN ('filled', 'failed')
        AND updated_at >= to_timestamp($1 / 1000.0)
      ORDER BY updated_at DESC
      LIMIT $2
    `, [sinceMs, limit]);
    return result.rows.map(signalFromRow);
  }

  async liveExecutionQualityStatus(now: number, options: LiveExecutionQualityOptions) {
    const signals = await this.listLiveExecutionQualitySignals(now, options.lookbackMs, options.sampleLimit);
    return buildLiveExecutionQualityStatus(signals, null, options);
  }

  async liveExecutionQualityBlockReason(candidate: ArbCandidate, now: number, options: LiveExecutionQualityOptions): Promise<string | null> {
    const signals = await this.listLiveExecutionQualitySignals(now, options.lookbackMs, options.sampleLimit);
    return liveExecutionQualityBlockReason(buildLiveExecutionQualityStatus(signals, candidate, options));
  }

  async liveReconciliationBlockReason(
    candidate: ArbCandidate,
    now: number,
    maxUnresolvedExposureDollars?: number,
  ): Promise<string | null> {
    return this.liveReconciliationBlockReasonWithCap(candidate, now, maxUnresolvedExposureDollars);
  }

  async liveReconciliationBlockReasonWithCap(
    candidate: ArbCandidate,
    now: number,
    maxUnresolvedExposureDollars?: number,
  ): Promise<string | null> {
    const quarantineReason = await this.liveQuarantineBlockReason(maxUnresolvedExposureDollars);
    if (quarantineReason) return quarantineReason;

    const result = await this.db.query<LiveReconciliationRow>(`
      SELECT id, action, partial_fill, kalshi_status, polymarket_status,
             kalshi_fill_count, polymarket_fill_count, venue_confirmations, reconciliation_resolved_at,
             risk_quarantined_at
      FROM cross_venue_arb_signals
      WHERE execution_group_id IS NOT NULL
        AND reconciliation_resolved_at IS NULL
        AND risk_quarantined_at IS NULL
        AND expiry_ms = $1
        AND expiry_ms > $2
        AND (
          partial_fill = TRUE
          OR COALESCE(kalshi_fill_count, 0) > 0
          OR COALESCE(polymarket_fill_count, 0) > 0
          OR kalshi_status IN ('unknown', 'unexpected_fill_count')
          OR polymarket_status IN ('unknown', 'unexpected_fill_count')
        )
      ORDER BY updated_at DESC
      LIMIT 50
    `, [candidate.expiryMs, now]);

    for (const row of result.rows) {
      if (row.reconciliation_resolved_at != null) continue;
      const kalshiFillCount = numberFrom(row.kalshi_fill_count) ?? 0;
      const polymarketFillCount = numberFrom(row.polymarket_fill_count) ?? 0;
      const hasAnyFill = kalshiFillCount > 0 || polymarketFillCount > 0;
      const confirmations = jsonFromRow<VenueConfirmations>(row.venue_confirmations);
      if (booleanFrom(row.partial_fill)) return `live reconciliation blocked: signal #${row.id} is marked partial_fill`;
      if (hasAnyFill && Math.abs(kalshiFillCount - polymarketFillCount) > 0.000001) {
        return `live reconciliation blocked: signal #${row.id} fill mismatch kalshi=${kalshiFillCount} polymarket=${polymarketFillCount}`;
      }
      if (hasAnyFill && (!confirmedByUserStream(confirmations, "kalshi") || !confirmedByUserStream(confirmations, "polymarket"))) {
        return `live reconciliation blocked: signal #${row.id} has venue fills without private-stream confirmations`;
      }
      if (["unknown", "unexpected_fill_count"].includes(row.kalshi_status ?? "") || ["unknown", "unexpected_fill_count"].includes(row.polymarket_status ?? "")) {
        return `live reconciliation blocked: signal #${row.id} has unresolved venue status`;
      }
    }

    return null;
  }

  async listRecentSignals(limit = 100): Promise<DashboardSignal[]> {
    const values: unknown[] = [limit];
    const result = await this.db.query<DashboardSignalRow>(`
      SELECT ${SIGNAL_COLUMNS}
      FROM cross_venue_arb_signals
      WHERE execution_group_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $1
    `, values);
    return result.rows.map(signalFromRow);
  }

  async listFilledSignalsSince(sinceMs: number, limit = 10_000): Promise<DashboardSignal[]> {
    const values: unknown[] = [sinceMs, limit];
    const result = await this.db.query<DashboardSignalRow>(`
      SELECT ${SIGNAL_COLUMNS}
      FROM cross_venue_arb_signals
      WHERE action = 'filled'
        AND execution_group_id IS NOT NULL
        AND updated_at >= to_timestamp($1 / 1000.0)
      ORDER BY updated_at ASC
      LIMIT $2
    `, values);
    return result.rows.map(signalFromRow);
  }
}
