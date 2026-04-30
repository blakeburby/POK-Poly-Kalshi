export type LogSeverity = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LogCategory = "BOOT" | "DB" | "DISCOVERY" | "KALSHI" | "POLYMARKET" | "POLYMARKET_PRICE" | "SCANNER" | "EXECUTION";

export interface LogEntry {
  timestamp: string;
  severity: LogSeverity;
  category: LogCategory;
  message: string;
  context?: Record<string, unknown>;
}

const logs: LogEntry[] = [];
const throttleState = new Map<string, number>();
const maxLogs = 500;

export function logEvent(input: Omit<LogEntry, "timestamp" | "severity"> & { severity?: LogSeverity }): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    severity: input.severity ?? "INFO",
    category: input.category,
    message: input.message,
    context: input.context,
  };
  logs.push(entry);
  if (logs.length > maxLogs) logs.splice(0, logs.length - maxLogs);
  const writer = entry.severity === "ERROR" ? console.error : entry.severity === "WARN" ? console.warn : console.log;
  writer(JSON.stringify(entry));
}

export function logThrottle(key: string, intervalMs: number, event: Parameters<typeof logEvent>[0]): void {
  const now = Date.now();
  const last = throttleState.get(key) ?? 0;
  if (now - last < intervalMs) return;
  throttleState.set(key, now);
  logEvent(event);
}

export function getRecentLogs(limit = 100): LogEntry[] {
  return logs.slice(-limit);
}
