import { hasDashboardSession } from "../../../lib/dashboard-session";
import { fetchWorkerStream } from "../../../lib/worker-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  if (!(await hasDashboardSession())) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const upstream = await fetchWorkerStream();
    if (!upstream.ok || !upstream.body) {
      return Response.json({ error: `worker_stream_failed_${upstream.status}` }, { status: 502 });
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
