import http from "node:http";
import https from "node:https";
import axios from "axios";
import { Agent, setGlobalDispatcher } from "undici";
import type { AppConfig } from "../config";
import { logEvent } from "../logger";

let installed = false;

export function installLowLatencyHttpTransport(config: AppConfig): void {
  if (!config.liveLowLatencyHttpEnabled || installed) return;
  installed = true;
  const connections = Math.max(2, Math.min(16, config.executionConcurrency * 4));
  const keepAliveMsecs = Math.max(1_000, config.liveHotPathWarmIntervalMs);
  // LA6: keep warmed order sockets alive across sparse order activity so the next order does not pay a cold
  // TCP+TLS handshake (~150-297ms). The previous undici keepAliveTimeout of warmInterval*2 (~2s) let the
  // socket idle out between orders. maxCachedSessions enables TLS session resumption (abbreviated handshake)
  // when a connection does need to be re-established. We deliberately do NOT enable retries on the
  // (non-idempotent) order POST and do NOT use TLS 1.3 0-RTT early data (order replay risk).
  const idleKeepAliveMs = Math.max(30_000, config.liveHotPathWarmIntervalMs * 2);
  const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs, maxSockets: connections });
  const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs,
    maxSockets: connections,
    maxCachedSessions: 100,
  });

  axios.defaults.httpAgent = httpAgent;
  axios.defaults.httpsAgent = httpsAgent;
  axios.defaults.timeout = Math.max(1_000, config.liveOrderTimeoutMs);
  setGlobalDispatcher(
    new Agent({
      connections,
      pipelining: 1,
      keepAliveTimeout: idleKeepAliveMs,
      keepAliveMaxTimeout: Math.max(60_000, idleKeepAliveMs),
    }),
  );
}

export async function preconnectLiveHttpEndpoints(config: AppConfig): Promise<void> {
  if (!config.liveLowLatencyHttpEnabled) return;
  const endpoints = [config.kalshiApiBase, config.polymarketClobHost, config.polymarketGeoblockUrl].filter(Boolean);
  await Promise.allSettled(
    endpoints.map(async (endpoint) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.max(500, Math.min(2_000, config.liveOrderTimeoutMs)));
        try {
          await fetch(endpoint, { method: "HEAD", signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        logEvent({
          severity: "WARN",
          category: "BOOT",
          message: "live HTTP preconnect failed",
          context: { endpoint, error: error instanceof Error ? error.message : String(error) },
        });
      }
    }),
  );
}
