import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface HarHeader {
  name?: string;
  value?: string;
}

interface HarCookie {
  name?: string;
  value?: string;
}

interface HarEntry {
  startedDateTime?: string;
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
    cookies?: HarCookie[];
  };
  response?: {
    status?: number;
  };
}

interface HarObject {
  log?: {
    entries?: HarEntry[];
  };
}

interface ExtractedSession {
  userId: string;
  csrfToken: string;
  cookie?: string;
  userAgent?: string;
  headers?: Record<string, string>;
}

function usage(): never {
  console.error("Usage: npm run kalshi:ui-session:extract -- /path/to/fresh-kalshi.har --out tmp/kalshi-ui-session-fresh.json");
  process.exit(2);
}

function hash(value: string | undefined): string | null {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function headerMap(headers: HarHeader[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers ?? []) {
    const name = header.name?.trim().toLowerCase();
    const value = header.value?.trim();
    if (name && value) map.set(name, value);
  }
  return map;
}

function cookieHeaderFromHarCookies(cookies: HarCookie[] | undefined): string | null {
  const pairs = [];
  for (const cookie of cookies ?? []) {
    const name = cookie.name?.trim();
    const value = cookie.value?.trim();
    if (name && value) pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join("; ") : null;
}

function safeExtraHeaders(headers: Map<string, string>): Record<string, string> | undefined {
  const blocked = new Set([
    "accept",
    "authorization",
    "connection",
    "content-length",
    "content-type",
    "cookie",
    "host",
    "origin",
    "referer",
    "x-csrf-token",
    "x-xsrf-token",
  ]);
  const keepPatterns = [
    /^accept-language$/,
    /^priority$/,
    /^sec-/,
    /^x-aws-waf-token$/,
  ];
  const result: Record<string, string> = {};
  for (const [key, value] of headers) {
    if (blocked.has(key)) continue;
    if (!keepPatterns.some((pattern) => pattern.test(key))) continue;
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isUsefulKalshiUiRequest(entry: HarEntry): boolean {
  try {
    const url = new URL(entry.request?.url ?? "");
    if (!/kalshi/i.test(url.hostname)) return false;
    if (!/\/v1\/users\/[^/]+\/(orders|event_positions)(\/|$)/.test(url.pathname)) return false;
    const method = String(entry.request?.method ?? "").toUpperCase();
    if (method === "OPTIONS") return false;
    return true;
  } catch {
    return false;
  }
}

function extractUserId(urlString: string): string | null {
  const url = new URL(urlString);
  return url.pathname.match(/\/v1\/users\/([^/]+)/)?.[1] ?? null;
}

function extractSessionFromEntry(entry: HarEntry): ExtractedSession | null {
  const url = entry.request?.url;
  if (!url) return null;
  const headers = headerMap(entry.request?.headers);
  const userId = extractUserId(url);
  const csrfToken = headers.get("x-csrf-token") ?? headers.get("x-xsrf-token");
  const cookie = headers.get("cookie") ?? cookieHeaderFromHarCookies(entry.request?.cookies) ?? undefined;
  const wafToken = headers.get("x-aws-waf-token");
  if (!userId || !csrfToken) return null;
  if (!cookie && !wafToken) return null;
  const extraHeaders = safeExtraHeaders(headers);
  return {
    userId,
    csrfToken,
    ...(cookie ? { cookie } : {}),
    ...(headers.get("user-agent") ? { userAgent: headers.get("user-agent") } : {}),
    ...(extraHeaders ? { headers: extraHeaders } : {}),
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const harPath = args[0];
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!harPath || !outPath) usage();
  const har = JSON.parse(fs.readFileSync(harPath, "utf8")) as HarObject;
  const entries = (har.log?.entries ?? [])
    .filter(isUsefulKalshiUiRequest)
    .filter((entry) => {
      const status = Number(entry.response?.status ?? 0);
      return status >= 200 && status < 300;
    })
    .sort((left, right) => Date.parse(right.startedDateTime ?? "0") - Date.parse(left.startedDateTime ?? "0"));
  const selected = entries.map(extractSessionFromEntry).find((session): session is ExtractedSession => session != null);
  if (!selected) {
    console.error("No usable Kalshi UI session request found. Export a fresh HAR after loading a logged-in Kalshi page that calls /v1/users/{user_id}/event_positions or /orders.");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outPath, `${JSON.stringify(selected, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(outPath, 0o600);
  console.log(JSON.stringify({
    outPath,
    userIdHash: hash(selected.userId),
    csrfHash: hash(selected.csrfToken),
    cookiePresent: Boolean(selected.cookie),
    cookieHash: hash(selected.cookie),
    cookiePartCount: selected.cookie?.split(/;\s*/).filter(Boolean).length ?? 0,
    wafTokenPresent: Boolean(selected.headers?.["x-aws-waf-token"]),
    wafTokenHash: hash(selected.headers?.["x-aws-waf-token"]),
    userAgentPresent: Boolean(selected.userAgent),
    selectedFromSuccessfulRequest: true,
  }, null, 2));
}

if (process.argv[1] && path.basename(process.argv[1]) === "extract-kalshi-ui-session-from-har.ts") {
  main();
}
