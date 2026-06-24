import fs from "node:fs";
import path from "node:path";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface HarHeader {
  name?: string;
  value?: string;
}

interface HarPostData {
  mimeType?: string;
  text?: string;
}

interface HarRequest {
  method?: string;
  url?: string;
  headers?: HarHeader[];
  queryString?: Array<{ name?: string; value?: string }>;
  postData?: HarPostData;
}

interface HarResponseContent {
  mimeType?: string;
  text?: string;
  encoding?: string;
}

interface HarResponse {
  status?: number;
  statusText?: string;
  headers?: HarHeader[];
  content?: HarResponseContent;
}

interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request?: HarRequest;
  response?: HarResponse;
}

interface HarObject {
  log?: {
    entries?: HarEntry[];
  };
}

export interface SanitizedHarEntry {
  startedDateTime: string | null;
  durationMs: number | null;
  request: {
    method: string;
    host: string;
    path: string;
    queryKeys: string[];
    headerNames: string[];
    authIndicators: string[];
    body: JsonValue | null;
    bodyKeys: string[];
  };
  response: {
    status: number | null;
    statusText: string | null;
    contentMimeType: string | null;
    headerNames: string[];
    body: JsonValue | null;
    bodyKeys: string[];
  };
  interesting: boolean;
  interestingReasons: string[];
}

export interface SanitizedHarOutput {
  generatedAt: string;
  sourceFile: string | null;
  kalshiEntryCount: number;
  summary: {
    totalEntries: number;
    ignoredNonKalshiEntries: number;
    byPath: Array<{ method: string; host: string; path: string; count: number; statuses: number[] }>;
  };
  decisionHints: {
    documentedV2OrderRequestSeen: boolean;
    legacyOrderRequestSeen: boolean;
    buyMaxCostFieldSeen: boolean;
    quickOrderFieldSeen: boolean;
    marketOrderFieldSeen: boolean;
    dollarSpendFieldSeen: boolean;
    apiKeySignedRequestSeen: boolean;
    sessionCookieRequestSeen: boolean;
    undocumentedOrderLikeRequestSeen: boolean;
    recommendedInterpretation: string;
  };
  entries: SanitizedHarEntry[];
}

const REDACTED = "[redacted]";
const MAX_STRING_LENGTH = 500;

const SENSITIVE_KEY_PATTERNS = [
  /authorization/i,
  /bearer/i,
  /cookie/i,
  /csrf/i,
  /session/i,
  /password/i,
  /secret/i,
  /signature/i,
  /private/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /token/i,
  /account/i,
  /member/i,
  /user[_-]?id/i,
  /client[_-]?order[_-]?id/i,
  /order[_-]?id/i,
  /wallet/i,
  /address/i,
  /email/i,
  /phone/i,
];

const SECRET_STRING_PATTERNS = [
  /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b0x[a-fA-F0-9]{32,}\b/g,
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  /\b[A-Za-z0-9+/=_-]{48,}\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
];

const ORDER_LIKE_PATH_PATTERN = /\/(portfolio|orders?|trades?|quick|market|rfq|quote|buy|sell|fills?)(\/|$|_)/i;
const QUICK_FIELD_PATTERN = /quick[_-]?order|quickOrder/i;
const MARKET_FIELD_PATTERN = /market[_-]?order|marketOrder|order[_-]?type/i;
const DOLLAR_FIELD_PATTERN = /target[_-]?cost[_-]?dollars|buy[_-]?max[_-]?cost|dollar|amount[_-]?dollars|spend/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function redactString(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_STRING_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  if (redacted.length > MAX_STRING_LENGTH) {
    return `${redacted.slice(0, MAX_STRING_LENGTH)}...[truncated ${redacted.length - MAX_STRING_LENGTH} chars]`;
  }
  return redacted;
}

function sanitizeJson(value: unknown, key = ""): JsonValue {
  if (value == null) return null;
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item));
  if (!isRecord(value)) return REDACTED;

  const sanitized: Record<string, JsonValue> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    sanitized[childKey] = sanitizeJson(childValue, childKey);
  }
  return sanitized;
}

function parseBody(text: string | undefined, mimeType: string | undefined): JsonValue | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lowerMime = String(mimeType ?? "").toLowerCase();

  if (lowerMime.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return sanitizeJson(JSON.parse(trimmed));
    } catch {
      return redactString(trimmed);
    }
  }

  if (lowerMime.includes("x-www-form-urlencoded")) {
    const form: Record<string, string> = {};
    const params = new URLSearchParams(trimmed);
    for (const [key, value] of params.entries()) form[key] = value;
    return sanitizeJson(form);
  }

  return `[non-json body redacted: ${trimmed.length} chars]`;
}

function collectKeys(value: JsonValue | null): string[] {
  const keys = new Set<string>();
  const visit = (current: JsonValue | null): void => {
    if (current == null || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      keys.add(key);
      visit(child);
    }
  };
  visit(value);
  return [...keys].sort();
}

function containsKey(value: JsonValue | null, pattern: RegExp): boolean {
  return collectKeys(value).some((key) => pattern.test(key));
}

function headerNames(headers: HarHeader[] | undefined): string[] {
  return [...new Set((headers ?? []).map((header) => String(header.name ?? "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function authIndicators(headers: HarHeader[] | undefined): string[] {
  const names = headerNames(headers).map((name) => name.toLowerCase());
  const indicators: string[] = [];
  if (names.includes("cookie")) indicators.push("cookie");
  if (names.includes("authorization")) indicators.push("authorization");
  if (names.includes("kalshi-access-key")) indicators.push("kalshi-access-key");
  if (names.includes("kalshi-access-signature")) indicators.push("kalshi-access-signature");
  if (names.includes("x-csrf-token") || names.includes("x-xsrf-token")) indicators.push("csrf");
  return indicators;
}

function safePathname(url: URL): string {
  return url.pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (/^[0-9a-fA-F-]{24,}$/.test(segment)) return REDACTED;
      if (/^[A-Za-z0-9_-]{32,}$/.test(segment)) return REDACTED;
      return segment;
    })
    .join("/");
}

function isKalshiHost(hostname: string): boolean {
  return hostname === "kalshi.com" || hostname.endsWith(".kalshi.com");
}

function requestUrl(entry: HarEntry): URL | null {
  const raw = entry.request?.url;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function interestingReasons(entry: SanitizedHarEntry): string[] {
  const reasons: string[] = [];
  const pathText = entry.request.path;
  const body = entry.request.body;
  const responseBody = entry.response.body;
  if (ORDER_LIKE_PATH_PATTERN.test(pathText)) reasons.push("order-like path");
  if (containsKey(body, QUICK_FIELD_PATTERN) || containsKey(responseBody, QUICK_FIELD_PATTERN))
    reasons.push("quick-order-like field");
  if (containsKey(body, MARKET_FIELD_PATTERN) || containsKey(responseBody, MARKET_FIELD_PATTERN))
    reasons.push("market-order-like field");
  if (containsKey(body, DOLLAR_FIELD_PATTERN) || containsKey(responseBody, DOLLAR_FIELD_PATTERN))
    reasons.push("dollar-spend-like field");
  if (entry.request.path.endsWith("/portfolio/events/orders")) reasons.push("documented V2 order endpoint");
  if (entry.request.path.endsWith("/portfolio/orders")) reasons.push("legacy order endpoint");
  return reasons;
}

function sanitizeEntry(entry: HarEntry): SanitizedHarEntry | null {
  const url = requestUrl(entry);
  if (!url || !isKalshiHost(url.hostname)) return null;

  const requestHeaders = entry.request?.headers ?? [];
  const responseHeaders = entry.response?.headers ?? [];
  const requestBody = parseBody(entry.request?.postData?.text, entry.request?.postData?.mimeType);
  const responseBody =
    entry.response?.content?.encoding === "base64"
      ? "[base64 response body redacted]"
      : parseBody(entry.response?.content?.text, entry.response?.content?.mimeType);

  const sanitized: SanitizedHarEntry = {
    startedDateTime: entry.startedDateTime ?? null,
    durationMs: typeof entry.time === "number" && Number.isFinite(entry.time) ? entry.time : null,
    request: {
      method: String(entry.request?.method ?? "GET").toUpperCase(),
      host: url.hostname,
      path: safePathname(url),
      queryKeys: [...url.searchParams.keys()].sort(),
      headerNames: headerNames(requestHeaders),
      authIndicators: authIndicators(requestHeaders),
      body: requestBody,
      bodyKeys: collectKeys(requestBody),
    },
    response: {
      status: typeof entry.response?.status === "number" ? entry.response.status : null,
      statusText: entry.response?.statusText ?? null,
      contentMimeType: entry.response?.content?.mimeType ?? null,
      headerNames: headerNames(responseHeaders),
      body: responseBody,
      bodyKeys: collectKeys(responseBody),
    },
    interesting: false,
    interestingReasons: [],
  };

  const reasons = interestingReasons(sanitized);
  sanitized.interesting = reasons.length > 0;
  sanitized.interestingReasons = reasons;
  return sanitized;
}

function pathSummary(entries: SanitizedHarEntry[]): SanitizedHarOutput["summary"]["byPath"] {
  const groups = new Map<
    string,
    { method: string; host: string; path: string; count: number; statuses: Set<number> }
  >();
  for (const entry of entries) {
    const key = `${entry.request.method} ${entry.request.host}${entry.request.path}`;
    const existing = groups.get(key) ?? {
      method: entry.request.method,
      host: entry.request.host,
      path: entry.request.path,
      count: 0,
      statuses: new Set<number>(),
    };
    existing.count += 1;
    if (entry.response.status != null) existing.statuses.add(entry.response.status);
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      method: group.method,
      host: group.host,
      path: group.path,
      count: group.count,
      statuses: [...group.statuses].sort((a, b) => a - b),
    }))
    .sort(
      (a, b) => b.count - a.count || `${a.method} ${a.host}${a.path}`.localeCompare(`${b.method} ${b.host}${b.path}`),
    );
}

function hasAnyField(entries: SanitizedHarEntry[], pattern: RegExp): boolean {
  return entries.some((entry) => containsKey(entry.request.body, pattern) || containsKey(entry.response.body, pattern));
}

function buildDecisionHints(entries: SanitizedHarEntry[]): SanitizedHarOutput["decisionHints"] {
  const documentedV2OrderRequestSeen = entries.some((entry) => entry.request.path.endsWith("/portfolio/events/orders"));
  const legacyOrderRequestSeen = entries.some((entry) => entry.request.path.endsWith("/portfolio/orders"));
  const buyMaxCostFieldSeen = hasAnyField(entries, /buy[_-]?max[_-]?cost/i);
  const quickOrderFieldSeen = hasAnyField(entries, QUICK_FIELD_PATTERN);
  const marketOrderFieldSeen = hasAnyField(entries, MARKET_FIELD_PATTERN);
  const dollarSpendFieldSeen = hasAnyField(entries, DOLLAR_FIELD_PATTERN);
  const apiKeySignedRequestSeen = entries.some(
    (entry) =>
      entry.request.authIndicators.includes("kalshi-access-key") ||
      entry.request.authIndicators.includes("kalshi-access-signature"),
  );
  const sessionCookieRequestSeen = entries.some(
    (entry) => entry.request.authIndicators.includes("cookie") || entry.request.authIndicators.includes("csrf"),
  );
  const undocumentedOrderLikeRequestSeen = entries.some(
    (entry) =>
      entry.interesting &&
      !entry.request.path.startsWith("/trade-api/v2/portfolio/events/orders") &&
      !entry.request.path.startsWith("/trade-api/v2/portfolio/orders"),
  );

  let recommendedInterpretation = "No order-like Kalshi UI request was found in the sanitized capture.";
  if (documentedV2OrderRequestSeen) {
    recommendedInterpretation =
      "UI appears to use the documented V2 order endpoint for at least one order-like request; prefer implementing the supported V2 equivalent.";
  } else if (legacyOrderRequestSeen) {
    recommendedInterpretation =
      "UI appears to use the legacy order endpoint for at least one order-like request; verify in demo/tiny-live only and prefer V2 unless Kalshi confirms legacy behavior.";
  } else if (undocumentedOrderLikeRequestSeen) {
    recommendedInterpretation =
      "UI appears to use an undocumented order-like request; document and ask Kalshi for official support before production use.";
  }

  return {
    documentedV2OrderRequestSeen,
    legacyOrderRequestSeen,
    buyMaxCostFieldSeen,
    quickOrderFieldSeen,
    marketOrderFieldSeen,
    dollarSpendFieldSeen,
    apiKeySignedRequestSeen,
    sessionCookieRequestSeen,
    undocumentedOrderLikeRequestSeen,
    recommendedInterpretation,
  };
}

export function sanitizeHarObject(har: HarObject, sourceFile: string | null = null): SanitizedHarOutput {
  const entries = har.log?.entries ?? [];
  const sanitizedEntries = entries.map(sanitizeEntry).filter((entry): entry is SanitizedHarEntry => entry != null);

  return {
    generatedAt: new Date().toISOString(),
    sourceFile,
    kalshiEntryCount: sanitizedEntries.length,
    summary: {
      totalEntries: entries.length,
      ignoredNonKalshiEntries: entries.length - sanitizedEntries.length,
      byPath: pathSummary(sanitizedEntries),
    },
    decisionHints: buildDecisionHints(sanitizedEntries),
    entries: sanitizedEntries,
  };
}

export function renderMarkdownReport(output: SanitizedHarOutput): string {
  const interesting = output.entries.filter((entry) => entry.interesting);
  const lines: string[] = [
    "# Kalshi UI Quick Order Capture Report",
    "",
    `Generated: ${output.generatedAt}`,
    `Source file: ${output.sourceFile ?? "unknown"}`,
    "",
    "## Summary",
    "",
    `- Total HAR entries: ${output.summary.totalEntries}`,
    `- Kalshi entries retained: ${output.kalshiEntryCount}`,
    `- Non-Kalshi entries ignored: ${output.summary.ignoredNonKalshiEntries}`,
    `- Interesting Kalshi entries: ${interesting.length}`,
    "",
    "## Decision Hints",
    "",
    `- Documented V2 order request seen: ${output.decisionHints.documentedV2OrderRequestSeen}`,
    `- Legacy order request seen: ${output.decisionHints.legacyOrderRequestSeen}`,
    `- buy_max_cost field seen: ${output.decisionHints.buyMaxCostFieldSeen}`,
    `- Quick-order-like field seen: ${output.decisionHints.quickOrderFieldSeen}`,
    `- Market-order-like field seen: ${output.decisionHints.marketOrderFieldSeen}`,
    `- Dollar-spend-like field seen: ${output.decisionHints.dollarSpendFieldSeen}`,
    `- API-key signed request seen: ${output.decisionHints.apiKeySignedRequestSeen}`,
    `- Session/cookie request seen: ${output.decisionHints.sessionCookieRequestSeen}`,
    `- Undocumented order-like request seen: ${output.decisionHints.undocumentedOrderLikeRequestSeen}`,
    "",
    `Recommended interpretation: ${output.decisionHints.recommendedInterpretation}`,
    "",
    "## Path Summary",
    "",
    "| Method | Host | Path | Count | Statuses |",
    "| --- | --- | --- | ---: | --- |",
    ...output.summary.byPath.map(
      (row) => `| ${row.method} | ${row.host} | \`${row.path}\` | ${row.count} | ${row.statuses.join(", ") || "n/a"} |`,
    ),
    "",
    "## Interesting Requests",
    "",
    "| Method | Host | Path | Status | Reasons | Request Keys | Response Keys |",
    "| --- | --- | --- | ---: | --- | --- | --- |",
    ...interesting.map((entry) =>
      [
        `| ${entry.request.method}`,
        entry.request.host,
        `\`${entry.request.path}\``,
        String(entry.response.status ?? "n/a"),
        entry.interestingReasons.join(", "),
        entry.request.bodyKeys.join(", ") || "none",
        `${entry.response.bodyKeys.join(", ") || "none"} |`,
      ].join(" | "),
    ),
    "",
    "## Safety Notes",
    "",
    "- This report intentionally omits non-Kalshi traffic and redacts cookies, tokens, signatures, account identifiers, order identifiers, wallet addresses, and long opaque strings.",
    "- Do not replay any private UI request from this capture.",
    "- If an undocumented order-like endpoint appears, ask Kalshi for written production support before implementation.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]): { inputFile: string | null; outDir: string } {
  let inputFile: string | null = null;
  let outDir = "tmp/kalshi-ui-capture";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      outDir = argv[index + 1] ?? outDir;
      index += 1;
    } else if (!inputFile) {
      inputFile = arg;
    }
  }
  return { inputFile, outDir };
}

async function main(): Promise<void> {
  const { inputFile, outDir } = parseArgs(process.argv.slice(2));
  if (!inputFile) {
    console.error("Usage: npm run kalshi:ui-har:sanitize -- path/to/capture.har [--out tmp/kalshi-ui-capture]");
    process.exit(2);
  }

  const raw = fs.readFileSync(inputFile, "utf8");
  const har = JSON.parse(raw) as HarObject;
  const output = sanitizeHarObject(har, path.basename(inputFile));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `kalshi-ui-capture-sanitized-${timestamp}.json`);
  const reportPath = path.join(outDir, `kalshi-ui-capture-report-${timestamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  fs.writeFileSync(reportPath, renderMarkdownReport(output));
  console.log(
    JSON.stringify(
      {
        sanitizedJson: jsonPath,
        report: reportPath,
        kalshiEntryCount: output.kalshiEntryCount,
        decisionHints: output.decisionHints,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
