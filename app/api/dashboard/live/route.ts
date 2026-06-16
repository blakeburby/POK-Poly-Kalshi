import { hasDashboardSession } from "../../../lib/dashboard-session";
import { fetchWorkerLive } from "../../../lib/worker-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Lightweight in-memory slice; the worker serves it in ~ms. Keep headroom for cold reads.
export const maxDuration = 15;

export async function GET(): Promise<Response> {
  if (!(await hasDashboardSession())) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await fetchWorkerLive(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
