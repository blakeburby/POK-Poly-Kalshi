import { hasDashboardSession } from "../../../lib/dashboard-session";
import { fetchWorkerSnapshot } from "../../../lib/worker-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  if (!(await hasDashboardSession())) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await fetchWorkerSnapshot());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
