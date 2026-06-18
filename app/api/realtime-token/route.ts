import { createHmac } from "node:crypto";
import { hasDashboardSession } from "../../lib/dashboard-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Issues a short-lived (60s) HMAC token to a logged-in operator so the browser
 * can open a direct realtime stream to the worker (api.pokstrategies.com) without
 * exposing the long-lived worker API token. The worker validates the same HMAC
 * (DASHBOARD_REALTIME_SECRET shared between this app and the worker).
 */
export async function GET(): Promise<Response> {
  if (!(await hasDashboardSession())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const secret = process.env.DASHBOARD_REALTIME_SECRET?.trim();
  const url = process.env.NEXT_PUBLIC_REALTIME_URL?.trim();
  if (!secret || !url) return Response.json({ error: "realtime_not_configured" }, { status: 503 });
  const exp = String(Date.now() + 60_000);
  const token = `${exp}.${createHmac("sha256", secret).update(exp).digest("base64url")}`;
  return Response.json({ token, url }, { headers: { "Cache-Control": "no-store" } });
}
