import { hasDashboardSession } from "../../../lib/dashboard-session";
import { fetchWorkerSnapshot } from "../../../lib/worker-api";
import { trimSnapshot } from "../../../lib/trim-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The worker can take ~6s to build a snapshot; keep the function alive well past that.
export const maxDuration = 30;

export async function GET(): Promise<Response> {
  if (!(await hasDashboardSession())) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const snapshot = await fetchWorkerSnapshot();
    return Response.json(trimSnapshot(snapshot), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
