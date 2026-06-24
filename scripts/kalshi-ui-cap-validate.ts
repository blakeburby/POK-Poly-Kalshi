import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/config";
import {
  buildKalshiUiQuickOrderBody,
  eventTickerFromKalshiMarketTicker,
  kalshiUiExchangeTimestampMs,
  kalshiUiFee,
  kalshiUiFillCount,
  kalshiUiFillPrice,
  kalshiUiHeaders,
  kalshiUiMarketPositionRecords,
  kalshiUiOrderRecord,
  kalshiUiOrderStatus,
  kalshiUiRemainingCount,
  kalshiUiUrl,
  readKalshiUiQuickOrderSession,
  sanitizeError,
  type KalshiUiQuickOrderSession,
  type LiveOrderContext,
} from "../src/execution/live-clients";
import type { ArbLeg, BinaryContract, DashboardSnapshot, LegDirection } from "../src/types";

interface CapValidationSelection {
  contract: BinaryContract;
  leg: ArbLeg;
  displayedAsk: number | null;
  eventTicker: string;
}

export interface KalshiUiCapValidationReport {
  generatedAt: string;
  passed: boolean;
  reason: string;
  mode: {
    arbEnabled: boolean | null;
    liveOrderPlacementMode: string | null;
    kalshiHedgeOrderMode: string | null;
    kalshiUiQuickOrderCapValidated: boolean | null;
  };
  request: {
    ticker: string | null;
    side: LegDirection | null;
    count: number;
    maxPriceCents: number;
    priceDollars: string;
    maxCostCents: number | null;
    orderType: string;
    timeInForce: string;
    marketIdPresent: boolean;
    marketIdHash: string | null;
  };
  market: {
    eventTicker: string | null;
    displayedAsk: number | null;
    expiryMs: number | null;
    updatedAt: number | null;
    marketIdSource: string | null;
  };
  response: {
    httpStatus: number | null;
    status: string | null;
    orderIdPresent: boolean;
    orderIdHash: string | null;
    fillCount: number | null;
    remainingCount: number | null;
    fillPrice: number | null;
    fee: number | null;
    exchangeTimestampMs: number | null;
    responseBodyKeys: string[];
    finalFetchUsed: boolean;
  };
  reportPaths?: {
    json: string;
    markdown: string;
  };
}

export interface KalshiUiCapValidationOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: number;
  writeReport?: boolean;
}

interface UiMarketIdResolution {
  marketId: string;
  source: string;
}

const DEFAULT_REPORT_DIR = "tmp/kalshi-ui-cap-validation";

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hashIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
}

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a finite number`);
  return parsed;
}

function envSide(env: NodeJS.ProcessEnv): LegDirection | null {
  const side = env.KALSHI_UI_CAP_TEST_SIDE?.trim().toLowerCase();
  if (!side) return null;
  if (side === "yes" || side === "no") return side;
  throw new Error("KALSHI_UI_CAP_TEST_SIDE must be yes or no");
}

function makeBaseReport(input: {
  now: number;
  count: number;
  maxPriceCents: number;
  health?: Record<string, unknown> | null;
  selection?: CapValidationSelection | null;
  marketId?: string | null;
  marketIdSource?: string | null;
  body?: Record<string, string | number | boolean> | null;
}): KalshiUiCapValidationReport {
  const health = input.health ?? {};
  return {
    generatedAt: new Date(input.now).toISOString(),
    passed: false,
    reason: "not_run",
    mode: {
      arbEnabled: typeof health.arbEnabled === "boolean" ? health.arbEnabled : null,
      liveOrderPlacementMode: stringOrNull(health.liveOrderPlacementMode),
      kalshiHedgeOrderMode: stringOrNull(health.kalshiHedgeOrderMode),
      kalshiUiQuickOrderCapValidated:
        typeof health.kalshiUiQuickOrderCapValidated === "boolean" ? health.kalshiUiQuickOrderCapValidated : null,
    },
    request: {
      ticker: input.selection?.leg.contractId ?? null,
      side: input.selection?.leg.direction ?? null,
      count: input.count,
      maxPriceCents: input.maxPriceCents,
      priceDollars: (input.body?.price_dollars as string | undefined) ?? (input.maxPriceCents / 100).toFixed(4),
      maxCostCents: finiteOrNull(input.body?.max_cost_cents),
      orderType: String(input.body?.order_type ?? "market"),
      timeInForce: String(input.body?.time_in_force ?? "immediate_or_cancel"),
      marketIdPresent: Boolean(input.marketId),
      marketIdHash: hashIdentifier(input.marketId),
    },
    market: {
      eventTicker: input.selection?.eventTicker ?? null,
      displayedAsk: input.selection?.displayedAsk ?? null,
      expiryMs: input.selection?.contract.expiryMs ?? null,
      updatedAt: input.selection?.contract.updatedAt ?? null,
      marketIdSource: input.marketIdSource ?? null,
    },
    response: {
      httpStatus: null,
      status: null,
      orderIdPresent: false,
      orderIdHash: null,
      fillCount: null,
      remainingCount: null,
      fillPrice: null,
      fee: null,
      exchangeTimestampMs: null,
      responseBodyKeys: [],
      finalFetchUsed: false,
    },
  };
}

function failReport(report: KalshiUiCapValidationReport, reason: string): KalshiUiCapValidationReport {
  return { ...report, passed: false, reason };
}

function passReport(report: KalshiUiCapValidationReport, reason: string): KalshiUiCapValidationReport {
  return { ...report, passed: true, reason };
}

function dashboardAuthHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.DASHBOARD_API_TOKEN?.trim();
  if (!token) throw new Error("DASHBOARD_API_TOKEN is required for protected cap validation");
  return { Authorization: `Bearer ${token}` };
}

async function readJsonResponse(response: Response): Promise<{ text: string; json: Record<string, unknown> }> {
  const text = await response.text();
  if (!text.trim()) return { text, json: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    return { text, json: recordOrNull(parsed) ?? {} };
  } catch {
    return { text, json: {} };
  }
}

async function fetchHealthAndSnapshot(
  fetchFn: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<{ health: Record<string, unknown>; snapshot: DashboardSnapshot }> {
  const base = env.WORKER_API_BASE?.trim() || "http://127.0.0.1:8080";
  const healthUrl = new URL("/health", base);
  const snapshotUrl = new URL("/dashboard/snapshot", base);
  const healthResponse = await fetchFn(healthUrl);
  const healthText = await healthResponse.text();
  if (!healthResponse.ok) throw new Error(`/health failed ${healthResponse.status}: ${sanitizeError(healthText)}`);
  const health = recordOrNull(JSON.parse(healthText)) ?? {};

  const snapshotResponse = await fetchFn(snapshotUrl, { headers: dashboardAuthHeaders(env) });
  const snapshotText = await snapshotResponse.text();
  if (!snapshotResponse.ok)
    throw new Error(`/dashboard/snapshot failed ${snapshotResponse.status}: ${sanitizeError(snapshotText)}`);
  return { health, snapshot: JSON.parse(snapshotText) as DashboardSnapshot };
}

export function stagedModeFailures(health: Record<string, unknown>, snapshot?: DashboardSnapshot): string[] {
  const snapshotHealth = (snapshot?.health ?? {}) as Record<string, unknown>;
  const liveOrderPlacementMode =
    stringOrNull(health.liveOrderPlacementMode) ?? stringOrNull(snapshotHealth.liveOrderPlacementMode);
  const kalshiHedgeOrderMode =
    stringOrNull(health.kalshiHedgeOrderMode) ?? stringOrNull(snapshotHealth.kalshiHedgeOrderMode);
  const capValidated =
    typeof health.kalshiUiQuickOrderCapValidated === "boolean"
      ? health.kalshiUiQuickOrderCapValidated
      : snapshotHealth.kalshiUiQuickOrderCapValidated;
  const failures = [
    ["health.ok=true", health.ok === true],
    ["health.arbEnabled=false", health.arbEnabled === false],
    ["health.liveOrderPlacementMode=parallel_quick", liveOrderPlacementMode === "parallel_quick"],
    ["health.kalshiHedgeOrderMode=ui_quick_order", kalshiHedgeOrderMode === "ui_quick_order"],
    ["health.kalshiUiQuickOrderCapValidated=false", capValidated === false],
  ];
  return failures.filter(([, ok]) => !ok).map(([name]) => String(name));
}

function askForSide(contract: BinaryContract, side: LegDirection): number | null {
  return side === "yes" ? contract.yesAsk : contract.noAsk;
}

function sideCandidates(contract: BinaryContract, capPrice: number): Array<{ side: LegDirection; ask: number }> {
  const candidates: Array<{ side: LegDirection; ask: number }> = [];
  for (const side of ["yes", "no"] as const) {
    const ask = askForSide(contract, side);
    if (ask != null && Number.isFinite(ask) && ask > capPrice + 1e-9) candidates.push({ side, ask });
  }
  return candidates.sort((left, right) => right.ask - left.ask || left.side.localeCompare(right.side));
}

export function selectKalshiUiCapTestLeg(input: {
  snapshot: DashboardSnapshot;
  env?: NodeJS.ProcessEnv;
  seriesTicker?: string;
  maxPriceCents?: number;
}): CapValidationSelection {
  const env = input.env ?? process.env;
  const now = input.snapshot.generatedAt;
  const seriesTicker = input.seriesTicker ?? "KXBTC15M";
  const capPrice = (input.maxPriceCents ?? 1) / 100;
  const explicitTicker = env.KALSHI_UI_CAP_TEST_TICKER?.trim();
  const explicitSide = envSide(env);
  const books = Array.isArray(input.snapshot.books?.kalshi) ? input.snapshot.books.kalshi : [];
  const kalshiBooks = books.filter(
    (book) => book.venue === "kalshi" && book.asset === "BTC" && book.contractId.startsWith(seriesTicker),
  );
  const contract = (() => {
    if (explicitTicker) {
      const match = kalshiBooks.find((book) => book.contractId === explicitTicker);
      if (!match)
        throw new Error(`KALSHI_UI_CAP_TEST_TICKER was not found in protected Kalshi books: ${explicitTicker}`);
      return match;
    }
    const future = kalshiBooks
      .filter((book) => Number.isFinite(book.expiryMs) && book.expiryMs > now)
      .sort((left, right) => left.expiryMs - right.expiryMs || left.contractId.localeCompare(right.contractId));
    const candidates =
      future.length > 0
        ? future
        : kalshiBooks.sort(
            (left, right) => left.expiryMs - right.expiryMs || left.contractId.localeCompare(right.contractId),
          );
    if (candidates.length === 0)
      throw new Error(`No ${seriesTicker} Kalshi books are available in the protected dashboard snapshot`);
    const nearestExpiry = candidates[0]?.expiryMs;
    const nearest = candidates.filter((book) => book.expiryMs === nearestExpiry);
    if (nearest.length !== 1) {
      throw new Error(
        `Kalshi cap-test market selection is ambiguous (${nearest.map((book) => book.contractId).join(", ")}); set KALSHI_UI_CAP_TEST_TICKER`,
      );
    }
    return nearest[0]!;
  })();

  const side = (() => {
    if (explicitSide) return explicitSide;
    const candidates = sideCandidates(contract, capPrice);
    if (candidates.length === 0) {
      throw new Error(
        `No ${contract.contractId} side has displayed ask above $${capPrice.toFixed(2)}; set KALSHI_UI_CAP_TEST_SIDE explicitly if you still want to test`,
      );
    }
    return candidates[0]!.side;
  })();
  const displayedAsk = askForSide(contract, side);
  if (displayedAsk == null || !Number.isFinite(displayedAsk)) {
    throw new Error(`${contract.contractId} ${side.toUpperCase()} ask is unavailable in protected books`);
  }
  const leg: ArbLeg = {
    venue: "kalshi",
    contractId: contract.contractId,
    direction: side,
    strike: contract.strike,
    ask: displayedAsk,
  };
  return { contract, leg, displayedAsk, eventTicker: eventTickerFromKalshiMarketTicker(contract.contractId) };
}

async function resolveUiMarketId(
  config: AppConfig,
  session: KalshiUiQuickOrderSession,
  ticker: string,
  fetchFn: typeof fetch,
): Promise<UiMarketIdResolution> {
  const eventTicker = eventTickerFromKalshiMarketTicker(ticker);
  const url = kalshiUiUrl(
    config,
    `/v1/users/${encodeURIComponent(session.userId)}/event_positions/${encodeURIComponent(eventTicker)}`,
  );
  const response = await fetchFn(url, { method: "GET", headers: kalshiUiHeaders(session) });
  const { text, json } = await readJsonResponse(response);
  if (!response.ok)
    throw new Error(`Kalshi UI event-position lookup failed ${response.status}: ${sanitizeError(text)}`);
  for (const row of kalshiUiMarketPositionRecords(json)) {
    const marketTicker = stringOrNull(row.market_ticker ?? row.marketTicker ?? row.ticker);
    const marketId = stringOrNull(row.market_id ?? row.marketId ?? row.id);
    if (marketTicker === ticker && marketId) return { marketId, source: "event_positions" };
  }
  if (session.allowStaticMarketIdMap === true) {
    const staticMarketId = session.marketIds?.[ticker] ?? session.marketIdByTicker?.[ticker];
    if (staticMarketId?.trim()) return { marketId: staticMarketId.trim(), source: "session_static_map" };
  }
  throw new Error(`No verified Kalshi UI market_id found for ticker ${ticker}`);
}

function responseBodyKeys(payload: Record<string, unknown>): string[] {
  const order = recordOrNull(payload.order);
  return Object.keys(order ?? payload).sort();
}

function rejectionProvesCap(responseStatus: number, text: string): boolean {
  if (responseStatus === 401 || responseStatus === 403) return false;
  if (responseStatus < 400 || responseStatus >= 500) return false;
  return /(insufficient|liquidity|no\s+orders?\s+found|no\s+match|would\s+exceed|max[_ -]?cost|cost\s+cap|price\s+too\s+low|not\s+fillable|immediate.*cancel|cannot\s+be\s+filled)/i.test(
    text,
  );
}

export function classifyCapValidationRecord(input: {
  report: KalshiUiCapValidationReport;
  record: Record<string, unknown>;
  count: number;
  maxPriceDollars: number;
  httpStatus: number;
  finalFetchUsed: boolean;
  payloadKeys: string[];
}): KalshiUiCapValidationReport {
  const fillCount = kalshiUiFillCount(input.record);
  const remainingCount = kalshiUiRemainingCount(input.record);
  const fillPrice = kalshiUiFillPrice(input.record);
  const orderId = stringOrNull(input.record.order_id ?? input.record.orderId);
  const status = kalshiUiOrderStatus(input.record, fillCount, input.count);
  const next: KalshiUiCapValidationReport = {
    ...input.report,
    response: {
      httpStatus: input.httpStatus,
      status,
      orderIdPresent: Boolean(orderId),
      orderIdHash: hashIdentifier(orderId),
      fillCount,
      remainingCount,
      fillPrice,
      fee: kalshiUiFee(input.record),
      exchangeTimestampMs: kalshiUiExchangeTimestampMs(input.record),
      responseBodyKeys: input.payloadKeys,
      finalFetchUsed: input.finalFetchUsed,
    },
  };
  if (fillCount != null && fillCount > 0) {
    if (fillPrice != null && fillPrice <= input.maxPriceDollars + 0.000001) {
      return passReport(next, `filled_${fillCount}_at_or_below_cap`);
    }
    return failReport(
      next,
      fillPrice == null
        ? "filled_but_average_fill_price_was_unparseable"
        : `fill_price_${fillPrice.toFixed(4)}_exceeded_cap_${input.maxPriceDollars.toFixed(4)}`,
    );
  }
  const noFillStatus = /cancel|reject|fail|unfill|kill|expired|closed|immediate/i.test(status);
  if (fillCount === 0 && (noFillStatus || remainingCount === 0)) {
    return passReport(next, "zero_fill_or_rejected_under_cap");
  }
  return failReport(next, `ambiguous_order_state_${status || "unknown"}`);
}

async function fetchUiOrder(
  config: AppConfig,
  session: KalshiUiQuickOrderSession,
  orderId: string,
  fetchFn: typeof fetch,
): Promise<Record<string, unknown>> {
  const url = kalshiUiUrl(
    config,
    `/v1/users/${encodeURIComponent(session.userId)}/orders/${encodeURIComponent(orderId)}`,
  );
  const response = await fetchFn(url, { method: "GET", headers: kalshiUiHeaders(session) });
  const { text, json } = await readJsonResponse(response);
  if (!response.ok) throw new Error(`Kalshi UI order query failed ${response.status}: ${sanitizeError(text)}`);
  return kalshiUiOrderRecord(json);
}

export function writeValidationReport(
  report: KalshiUiCapValidationReport,
  env: NodeJS.ProcessEnv,
): KalshiUiCapValidationReport {
  const reportDir = env.KALSHI_UI_CAP_TEST_REPORT_DIR?.trim() || DEFAULT_REPORT_DIR;
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(reportDir, `kalshi-ui-cap-validation-${timestamp}.json`);
  const markdownPath = path.join(reportDir, `kalshi-ui-cap-validation-${timestamp}.md`);
  const withPaths = { ...report, reportPaths: { json: jsonPath, markdown: markdownPath } };
  fs.writeFileSync(jsonPath, `${JSON.stringify(withPaths, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    markdownPath,
    [
      "# Kalshi UI Quick Order Cap Validation",
      "",
      `- Result: ${report.passed ? "PASS" : "FAIL"}`,
      `- Reason: ${report.reason}`,
      `- Ticker: ${report.request.ticker ?? "unknown"}`,
      `- Side: ${report.request.side ?? "unknown"}`,
      `- Count: ${report.request.count}`,
      `- Cap: $${(report.request.maxPriceCents / 100).toFixed(4)}`,
      `- Displayed ask: ${report.market.displayedAsk ?? "unknown"}`,
      `- HTTP status: ${report.response.httpStatus ?? "unknown"}`,
      `- Order ID present: ${report.response.orderIdPresent}`,
      `- Order ID hash: ${report.response.orderIdHash ?? "none"}`,
      `- Fill count: ${report.response.fillCount ?? "unknown"}`,
      `- Fill price: ${report.response.fillPrice ?? "unknown"}`,
      "",
      "No cookies, CSRF tokens, account IDs, wallet IDs, or private headers are included.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return withPaths;
}

export async function runKalshiUiCapValidation(
  options: KalshiUiCapValidationOptions = {},
): Promise<KalshiUiCapValidationReport> {
  const env = options.env ?? process.env;
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now();
  const count = envNumber(env, "KALSHI_UI_CAP_TEST_COUNT", 1);
  const maxPriceCents = envNumber(env, "KALSHI_UI_CAP_TEST_MAX_PRICE_CENTS", 1);
  if (count !== 1) throw new Error("KALSHI_UI_CAP_TEST_COUNT must be exactly 1 for the tiny live cap test");
  if (maxPriceCents !== 1)
    throw new Error("KALSHI_UI_CAP_TEST_MAX_PRICE_CENTS must be exactly 1 for the first cap validation");
  const maxPriceDollars = maxPriceCents / 100;
  const config = loadConfig(env);
  let health: Record<string, unknown> | null = null;
  let report = makeBaseReport({ now, count, maxPriceCents });
  try {
    const healthAndSnapshot = await fetchHealthAndSnapshot(fetchFn, env);
    health = healthAndSnapshot.health;
    report = makeBaseReport({ now, count, maxPriceCents, health });
    const stagedFailures = stagedModeFailures(health, healthAndSnapshot.snapshot);
    if (stagedFailures.length > 0) return failReport(report, `staged_mode_guard_failed:${stagedFailures.join(",")}`);

    const { session, reason } = readKalshiUiQuickOrderSession(config.kalshiUiSessionPath);
    if (!session) return failReport(report, reason ?? "Kalshi UI session is unavailable");
    const selection = selectKalshiUiCapTestLeg({
      snapshot: healthAndSnapshot.snapshot,
      env,
      seriesTicker: config.kalshiSeriesTicker,
      maxPriceCents,
    });
    report = makeBaseReport({ now, count, maxPriceCents, health, selection });
    const resolution = await resolveUiMarketId(config, session, selection.leg.contractId, fetchFn);
    const context: LiveOrderContext = {
      executionGroupId: `kalshi-ui-cap-${now}`,
      clientOrderId: `kalshi-ui-cap-${now}`,
      size: count,
      maxBuyPrice: maxPriceDollars,
      requiredCollateral: maxPriceDollars,
      requestedAt: now,
      placementMode: "parallel_quick",
    };
    const body = buildKalshiUiQuickOrderBody(selection.leg, context, resolution.marketId);
    report = makeBaseReport({
      now,
      count,
      maxPriceCents,
      health,
      selection,
      marketId: resolution.marketId,
      marketIdSource: resolution.source,
      body,
    });
    const url = kalshiUiUrl(config, `/v1/users/${encodeURIComponent(session.userId)}/orders`);
    const response = await fetchFn(url, {
      method: "POST",
      headers: kalshiUiHeaders(session, true),
      body: JSON.stringify(body),
    });
    const { text, json } = await readJsonResponse(response);
    if (!response.ok) {
      const next = {
        ...report,
        response: {
          ...report.response,
          httpStatus: response.status,
          status: "rejected",
          responseBodyKeys: responseBodyKeys(json),
        },
      };
      return rejectionProvesCap(response.status, text)
        ? passReport(next, "rejected_under_cap")
        : failReport(next, `ui_quick_order_rejected_without_cap_evidence_${response.status}`);
    }
    const initialRecord = kalshiUiOrderRecord(json);
    const orderId = stringOrNull(initialRecord.order_id ?? initialRecord.orderId);
    if (!orderId) {
      return failReport(
        {
          ...report,
          response: {
            ...report.response,
            httpStatus: response.status,
            responseBodyKeys: responseBodyKeys(json),
          },
        },
        "ui_quick_order_response_missing_order_id",
      );
    }
    const finalRecord = await fetchUiOrder(config, session, orderId, fetchFn);
    return classifyCapValidationRecord({
      report,
      record: finalRecord,
      count,
      maxPriceDollars,
      httpStatus: response.status,
      finalFetchUsed: true,
      payloadKeys: responseBodyKeys(json),
    });
  } catch (error) {
    return failReport(report, sanitizeError(error));
  }
}

async function main(): Promise<void> {
  const report = await runKalshiUiCapValidation({ writeReport: true });
  const withPaths = writeValidationReport(report, process.env);
  console.log(
    JSON.stringify(
      {
        passed: withPaths.passed,
        reason: withPaths.reason,
        ticker: withPaths.request.ticker,
        side: withPaths.request.side,
        count: withPaths.request.count,
        maxPriceCents: withPaths.request.maxPriceCents,
        displayedAsk: withPaths.market.displayedAsk,
        httpStatus: withPaths.response.httpStatus,
        orderIdPresent: withPaths.response.orderIdPresent,
        orderIdHash: withPaths.response.orderIdHash,
        fillCount: withPaths.response.fillCount,
        fillPrice: withPaths.response.fillPrice,
        reportPaths: withPaths.reportPaths,
      },
      null,
      2,
    ),
  );
  if (!withPaths.passed) process.exitCode = 1;
}

if (process.argv[1] && path.basename(process.argv[1]) === "kalshi-ui-cap-validate.ts") {
  main().catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
