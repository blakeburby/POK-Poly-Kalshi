import { constants, createPrivateKey, sign } from "node:crypto";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { resolveKalshiPrivateKeyPem } from "./auth";

const SOH = "\x01";
const FIX_BEGIN_STRING = "FIXT.1.1";
const FIX_APP_VERSION_FIX50SP2 = "9";
const KALSHI_EXCHANGE_UNAVAILABLE = "EXCHANGE_UNAVAILABLE";

export interface KalshiFixSessionOptions {
  host: string;
  port: number;
  senderCompId: string;
  targetCompId: string;
  heartbeatSeconds: number;
  connectTimeoutMs: number;
  orderResponseTimeoutMs: number;
  useDollars: boolean;
  enableIocCancelReport: boolean;
  preserveOriginalOrderQty: boolean;
}

export interface KalshiFixOrderInput {
  clientOrderId: string;
  symbol: string;
  direction: "yes" | "no";
  quantity: number;
  yesBookLimitPrice: number;
  maxExecutionCostDollars: number;
  timeInForce: "immediate_or_cancel" | "fill_or_kill";
  orderGroupId?: string;
  signal?: AbortSignal;
}

export interface KalshiFixExecutionReport {
  clientOrderId: string;
  orderId: string | null;
  execId: string | null;
  ordStatus: string | null;
  execType: string | null;
  text: string | null;
  cumulativeQuantity: number | null;
  leavesQuantity: number | null;
  averageYesBookPrice: number | null;
  lastYesBookPrice: number | null;
  lastQuantity: number | null;
  feeDollars: number | null;
  exchangeTimestampMs: number | null;
  rawTags: Record<string, string>;
}

export interface KalshiFixOrderExecution {
  clientOrderId: string;
  orderId: string | null;
  status: "filled" | "partial" | "canceled" | "rejected" | "expired" | "unknown";
  fillCount: number | null;
  averageYesBookPrice: number | null;
  feeDollars: number | null;
  exchangeTimestampMs: number | null;
  text: string | null;
  ambiguous: boolean;
  reports: KalshiFixExecutionReport[];
}

type PendingOrder = {
  input: KalshiFixOrderInput;
  reports: KalshiFixExecutionReport[];
  timer: ReturnType<typeof setTimeout>;
  cleanupAbort: () => void;
  resolve: (execution: KalshiFixOrderExecution) => void;
  reject: (error: Error) => void;
};

type PendingLogon = {
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
};

export type KalshiFixSocketFactory = (options: ConnectionOptions, onSecureConnect: () => void) => TLSSocket;

export function kalshiFixTimestamp(date = new Date()): string {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  const millis = date.getUTCMilliseconds().toString().padStart(3, "0");
  return `${year}${month}${day}-${hours}:${minutes}:${seconds}.${millis}`;
}

export function signKalshiFixLogon(
  sendingTime: string,
  msgSeqNum: number,
  senderCompId: string,
  targetCompId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const privateKey = createPrivateKey(resolveKalshiPrivateKeyPem(env));
  const prehash = [sendingTime, "A", String(msgSeqNum), senderCompId, targetCompId].join(SOH);
  return sign("sha256", Buffer.from(prehash, "utf8"), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
}

function checksum(messageWithoutChecksum: string): string {
  const sum = Buffer.from(messageWithoutChecksum, "ascii").reduce((total, byte) => total + byte, 0);
  return (sum % 256).toString().padStart(3, "0");
}

export function encodeFixMessage(fields: Array<[number | string, string | number | boolean]>): string {
  const body =
    fields.map(([tag, value]) => `${tag}=${value === true ? "Y" : value === false ? "N" : value}`).join(SOH) + SOH;
  const head = `8=${FIX_BEGIN_STRING}${SOH}9=${Buffer.byteLength(body, "ascii")}${SOH}`;
  const withoutChecksum = head + body;
  return `${withoutChecksum}10=${checksum(withoutChecksum)}${SOH}`;
}

export function parseFixMessage(message: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const field of message.split(SOH)) {
    if (!field) continue;
    const index = field.indexOf("=");
    if (index <= 0) continue;
    fields[field.slice(0, index)] = field.slice(index + 1);
  }
  return fields;
}

export function extractFixMessages(buffer: string): { messages: string[]; rest: string } {
  const messages: string[] = [];
  let rest = buffer;
  while (rest.length > 0) {
    const start = rest.indexOf(`8=${FIX_BEGIN_STRING}${SOH}`);
    if (start < 0) {
      return { messages, rest: rest.slice(Math.max(0, rest.length - 64)) };
    }
    if (start > 0) rest = rest.slice(start);
    const checksumMatch = /\x0110=\d{3}\x01/.exec(rest);
    if (!checksumMatch) return { messages, rest };
    const end = checksumMatch.index + checksumMatch[0].length;
    messages.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return { messages, rest };
}

function clampPrice(value: number): number {
  return Math.max(0.0001, Math.min(0.9999, value));
}

function fixedDollars(value: number): string {
  return clampPrice(value).toFixed(4);
}

function fixedQuantity(value: number): string {
  return Math.max(0, value).toFixed(2);
}

function fixedCost(value: number): string {
  return Math.max(0, Math.floor(value * 10_000 + 1e-9) / 10_000).toFixed(4);
}

function centsLimitPrice(yesBookPrice: number, direction: "yes" | "no"): string {
  const scaled = clampPrice(yesBookPrice) * 100;
  const cents = direction === "yes" ? Math.floor(scaled + 1e-9) : Math.ceil(scaled - 1e-9);
  return Math.max(1, Math.min(99, cents)).toString();
}

export function kalshiFixLimitPriceField(yesBookPrice: number, direction: "yes" | "no", useDollars: boolean): string {
  return useDollars ? fixedDollars(yesBookPrice) : centsLimitPrice(yesBookPrice, direction);
}

function priceFromFix(raw: string | undefined, useDollars: boolean): number | null {
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return useDollars ? parsed : parsed / 100;
}

function numberFromFix(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampFromFix(raw: string | undefined): number | null {
  if (!raw) return null;
  const normalized = raw.replace(
    /^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?$/,
    (_, year, month, day, hours, minutes, seconds, millis = ".000") =>
      `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${millis.padEnd(4, "0")}Z`,
  );
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildKalshiFixNewOrderFields(
  input: KalshiFixOrderInput,
  options: Pick<KalshiFixSessionOptions, "useDollars">,
  transactTime = kalshiFixTimestamp(),
): Array<[number | string, string | number | boolean]> {
  const fields: Array<[number | string, string | number | boolean]> = [
    [11, input.clientOrderId],
    [38, fixedQuantity(input.quantity)],
    [40, 2],
    [44, kalshiFixLimitPriceField(input.yesBookLimitPrice, input.direction, options.useDollars)],
    [54, input.direction === "yes" ? 1 : 2],
    [55, input.symbol],
    [59, input.timeInForce === "fill_or_kill" ? 4 : 3],
    [60, transactTime],
    [2964, 1],
    [21006, true],
    [21009, fixedCost(input.maxExecutionCostDollars)],
  ];
  return fields;
}

function isTerminalReport(report: KalshiFixExecutionReport): boolean {
  return ["2", "4", "8", "C"].includes(report.ordStatus ?? "") || ["4", "8", "C"].includes(report.execType ?? "");
}

function reportStatus(report: KalshiFixExecutionReport, requestedQuantity: number): KalshiFixOrderExecution["status"] {
  if (report.text === KALSHI_EXCHANGE_UNAVAILABLE) return "unknown";
  if (report.cumulativeQuantity != null && Math.abs(report.cumulativeQuantity - requestedQuantity) < 0.000001)
    return "filled";
  if ((report.cumulativeQuantity ?? 0) > 0 && ["4", "C"].includes(report.ordStatus ?? "")) return "partial";
  if (report.ordStatus === "4") return "canceled";
  if (report.ordStatus === "8") return "rejected";
  if (report.ordStatus === "C") return "expired";
  if ((report.cumulativeQuantity ?? 0) > 0) return "partial";
  return "unknown";
}

function executionFromReports(
  input: KalshiFixOrderInput,
  reports: KalshiFixExecutionReport[],
): KalshiFixOrderExecution {
  const finalReport = reports[reports.length - 1] ?? null;
  const tradeReports = reports.filter((report) => (report.cumulativeQuantity ?? 0) > 0 || report.execType === "F");
  const lastTradeReport = tradeReports[tradeReports.length - 1] ?? finalReport;
  const ambiguous = reports.some((report) => report.text === KALSHI_EXCHANGE_UNAVAILABLE);
  return {
    clientOrderId: input.clientOrderId,
    orderId: finalReport?.orderId ?? null,
    status: finalReport ? reportStatus(finalReport, input.quantity) : "unknown",
    fillCount: finalReport?.cumulativeQuantity ?? null,
    averageYesBookPrice: lastTradeReport?.averageYesBookPrice ?? finalReport?.averageYesBookPrice ?? null,
    feeDollars: tradeReports.reduce<number | null>((total, report) => {
      if (report.feeDollars == null) return total;
      return (total ?? 0) + report.feeDollars;
    }, null),
    exchangeTimestampMs: finalReport?.exchangeTimestampMs ?? null,
    text: finalReport?.text ?? null,
    ambiguous,
    reports,
  };
}

export function parseKalshiFixExecutionReport(
  fields: Record<string, string>,
  useDollars: boolean,
): KalshiFixExecutionReport {
  return {
    clientOrderId: fields["11"] ?? "",
    orderId: fields["37"] ?? null,
    execId: fields["17"] ?? null,
    ordStatus: fields["39"] ?? null,
    execType: fields["150"] ?? null,
    text: fields["58"] ?? null,
    cumulativeQuantity: numberFromFix(fields["14"]),
    leavesQuantity: numberFromFix(fields["151"]),
    averageYesBookPrice: priceFromFix(fields["6"], useDollars),
    lastYesBookPrice: priceFromFix(fields["31"], useDollars),
    lastQuantity: numberFromFix(fields["32"]),
    feeDollars: numberFromFix(fields["137"]),
    exchangeTimestampMs: timestampFromFix(fields["60"]),
    rawTags: fields,
  };
}

export class KalshiFixOrderSession {
  private socket: TLSSocket | null = null;
  private inboundBuffer = "";
  private outboundSeqNum = 1;
  private loggedOn = false;
  private connectPromise: Promise<void> | null = null;
  private pendingLogon: PendingLogon | null = null;
  private readonly pendingOrders = new Map<string, PendingOrder>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: KalshiFixSessionOptions,
    private readonly socketFactory: KalshiFixSocketFactory = tlsConnect,
  ) {}

  isReady(): boolean {
    return this.loggedOn && this.socket != null && !this.socket.destroyed;
  }

  async readiness(): Promise<{ ready: boolean; reason: string | null }> {
    try {
      await this.ensureConnected();
      return { ready: true, reason: null };
    } catch (error) {
      return { ready: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async warm(): Promise<void> {
    await this.ensureConnected();
  }

  async ensureConnected(): Promise<void> {
    if (this.isReady()) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        this.pendingLogon = null;
        reject(error);
      };
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        resolve();
      };
      const socket = this.socketFactory(
        {
          host: this.options.host,
          port: this.options.port,
          servername: this.options.host,
          minVersion: "TLSv1.2",
        },
        () => {
          try {
            socket.setNoDelay(true);
            this.sendLogon();
          } catch (error) {
            settleReject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );

      this.socket = socket;
      socket.setEncoding("ascii");
      socket.on("data", (chunk) => this.onData(String(chunk)));
      socket.on("error", (error) => this.onSocketFailure(error));
      socket.on("close", () => this.onSocketClose());
      this.pendingLogon = {
        timer: setTimeout(
          () => settleReject(new Error(`Kalshi FIX logon timeout after ${this.options.connectTimeoutMs}ms`)),
          this.options.connectTimeoutMs,
        ),
        resolve: () => {
          clearTimeout(this.pendingLogon?.timer);
          this.pendingLogon = null;
          settleResolve();
        },
        reject: (error) => {
          clearTimeout(this.pendingLogon?.timer);
          this.pendingLogon = null;
          settleReject(error);
        },
      };
    });

    return this.connectPromise;
  }

  async placeOrder(input: KalshiFixOrderInput): Promise<KalshiFixOrderExecution> {
    await this.ensureConnected();
    if (!this.isReady()) throw new Error("Kalshi FIX session is not logged on");
    if (this.pendingOrders.has(input.clientOrderId)) {
      throw new Error(`Kalshi FIX order is already pending for client order id ${input.clientOrderId}`);
    }

    return new Promise<KalshiFixOrderExecution>((resolve, reject) => {
      const cleanupAbort = onAbort(input.signal, () => {
        const pending = this.pendingOrders.get(input.clientOrderId);
        if (!pending) return;
        this.pendingOrders.delete(input.clientOrderId);
        clearTimeout(pending.timer);
        pending.cleanupAbort();
        reject(new Error("Kalshi FIX order aborted before terminal execution report"));
      });
      const pending: PendingOrder = {
        input,
        reports: [],
        cleanupAbort,
        timer: setTimeout(() => {
          const existing = this.pendingOrders.get(input.clientOrderId);
          if (!existing) return;
          this.pendingOrders.delete(input.clientOrderId);
          existing.cleanupAbort();
          reject(new Error(`Kalshi FIX order response timeout after ${this.options.orderResponseTimeoutMs}ms`));
        }, this.options.orderResponseTimeoutMs),
        resolve,
        reject,
      };
      this.pendingOrders.set(input.clientOrderId, pending);
      try {
        this.send("D", buildKalshiFixNewOrderFields(input, { useDollars: this.options.useDollars }));
      } catch (error) {
        this.pendingOrders.delete(input.clientOrderId);
        clearTimeout(pending.timer);
        cleanupAbort();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    try {
      if (this.isReady()) this.send("5", []);
    } catch {
      // Ignore logout write failures; close below still tears down local state.
    }
    this.socket?.destroy();
    this.onSocketClose();
  }

  private sendLogon(): void {
    const sendingTime = kalshiFixTimestamp();
    const msgSeqNum = this.outboundSeqNum++;
    const signature = signKalshiFixLogon(sendingTime, msgSeqNum, this.options.senderCompId, this.options.targetCompId);
    const fields: Array<[number | string, string | number | boolean]> = [
      [35, "A"],
      [34, msgSeqNum],
      [49, this.options.senderCompId],
      [56, this.options.targetCompId],
      [52, sendingTime],
      [98, 0],
      [108, Math.max(4, Math.floor(this.options.heartbeatSeconds))],
      [1137, FIX_APP_VERSION_FIX50SP2],
      [141, true],
      [96, signature],
    ];
    if (this.options.useDollars) fields.push([21005, true]);
    if (this.options.enableIocCancelReport) fields.push([21007, true]);
    if (this.options.preserveOriginalOrderQty) fields.push([21008, true]);
    this.writeRaw(encodeFixMessage(fields));
  }

  private send(msgType: string, extraFields: Array<[number | string, string | number | boolean]>): void {
    const fields: Array<[number | string, string | number | boolean]> = [
      [35, msgType],
      [34, this.outboundSeqNum++],
      [49, this.options.senderCompId],
      [56, this.options.targetCompId],
      [52, kalshiFixTimestamp()],
      ...extraFields,
    ];
    this.writeRaw(encodeFixMessage(fields));
  }

  private writeRaw(message: string): void {
    if (!this.socket || this.socket.destroyed) throw new Error("Kalshi FIX socket is not connected");
    this.socket.write(message, "ascii");
  }

  private onData(chunk: string): void {
    this.inboundBuffer += chunk;
    const { messages, rest } = extractFixMessages(this.inboundBuffer);
    this.inboundBuffer = rest;
    for (const message of messages) this.onMessage(parseFixMessage(message));
  }

  private onMessage(fields: Record<string, string>): void {
    const msgType = fields["35"];
    if (msgType === "A") {
      this.loggedOn = true;
      this.startHeartbeats();
      this.pendingLogon?.resolve();
      return;
    }
    if (msgType === "5") {
      const reason = fields["58"] ? `Kalshi FIX logout: ${fields["58"]}` : "Kalshi FIX logout";
      this.pendingLogon?.reject(new Error(reason));
      this.rejectPendingOrders(new Error(reason));
      this.loggedOn = false;
      return;
    }
    if (msgType === "1") {
      this.send("0", fields["112"] ? [[112, fields["112"]]] : []);
      return;
    }
    if (msgType !== "8") return;

    const report = parseKalshiFixExecutionReport(fields, this.options.useDollars);
    const pending = this.pendingOrders.get(report.clientOrderId);
    if (!pending) return;
    pending.reports.push(report);
    if (!isTerminalReport(report) && reportStatus(report, pending.input.quantity) !== "filled") return;

    this.pendingOrders.delete(report.clientOrderId);
    clearTimeout(pending.timer);
    pending.cleanupAbort();
    pending.resolve(executionFromReports(pending.input, pending.reports));
  }

  private startHeartbeats(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(
      () => {
        if (!this.isReady()) return;
        try {
          this.send("0", []);
        } catch {
          // Socket failure handlers will fail readiness/pending orders.
        }
      },
      Math.max(4, this.options.heartbeatSeconds) * 1_000,
    );
    this.heartbeatTimer.unref?.();
  }

  private onSocketFailure(error: Error): void {
    this.pendingLogon?.reject(error);
    this.rejectPendingOrders(error);
    this.loggedOn = false;
  }

  private onSocketClose(): void {
    this.loggedOn = false;
    this.connectPromise = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.pendingLogon?.reject(new Error("Kalshi FIX socket closed before logon completed"));
    this.pendingLogon = null;
    this.rejectPendingOrders(new Error("Kalshi FIX socket closed before terminal execution report"));
  }

  private rejectPendingOrders(error: Error): void {
    for (const [clientOrderId, pending] of this.pendingOrders.entries()) {
      this.pendingOrders.delete(clientOrderId);
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      pending.reject(error);
    }
  }
}

function onAbort(signal: AbortSignal | undefined, callback: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    callback();
    return () => undefined;
  }
  signal.addEventListener("abort", callback, { once: true });
  return () => signal.removeEventListener("abort", callback);
}
