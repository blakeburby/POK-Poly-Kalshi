import type { DashboardSnapshot } from "../../src/types";

function workerBase(): string {
  const base = process.env.WORKER_API_BASE?.trim();
  if (!base) throw new Error("WORKER_API_BASE is required");
  return base.replace(/\/$/, "");
}

function workerToken(): string {
  const token = process.env.DASHBOARD_API_TOKEN?.trim();
  if (!token) throw new Error("DASHBOARD_API_TOKEN is required");
  return token;
}

export async function fetchWorkerSnapshot(): Promise<DashboardSnapshot> {
  const response = await fetch(`${workerBase()}/dashboard/snapshot`, {
    headers: { Authorization: `Bearer ${workerToken()}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Worker snapshot failed ${response.status}: ${await response.text()}`);
  return response.json() as Promise<DashboardSnapshot>;
}

export async function fetchWorkerStream(): Promise<Response> {
  return fetch(`${workerBase()}/dashboard/stream`, {
    headers: { Authorization: `Bearer ${workerToken()}` },
    cache: "no-store",
  });
}
