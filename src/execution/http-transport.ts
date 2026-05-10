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
  const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs, maxSockets: connections });
  const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs, maxSockets: connections });

  axios.defaults.httpAgent = httpAgent;
  axios.defaults.httpsAgent = httpsAgent;
  axios.defaults.timeout = Math.max(1_000, config.liveOrderTimeoutMs);
  setGlobalDispatcher(new Agent({
    connections,
    pipelining: 1,
    keepAliveTimeout: Math.max(1_000, config.liveHotPathWarmIntervalMs * 2),
    keepAliveMaxTimeout: 60_000,
  }));
}

export async function preconnectLiveHttpEndpoints(config: AppConfig): Promise<void> {
  if (!config.liveLowLatencyHttpEnabled) return;
  const endpoints = [
    config.kalshiApiBase,
    config.polymarketClobHost,
    config.polymarketGeoblockUrl,
  ].filter(Boolean);
  await Promise.allSettled(endpoints.map(async (endpoint) => {
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
  }));
}
