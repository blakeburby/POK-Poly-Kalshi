import { hasDashboardSession } from "../../../lib/dashboard-session";
import { fetchTradingActivity } from "../../../lib/worker-api";
import type { TradingPlatform } from "../../../../types/trading";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  if (!(await hasDashboardSession())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const rawPlatform = url.searchParams.get("platform");
  const platform = rawPlatform === "kalshi" || rawPlatform === "polymarket" ? rawPlatform : null;
  if (rawPlatform && !platform) return Response.json({ error: "invalid_platform" }, { status: 400 });
  try {
    return Response.json(
      platform ? await fetchTradingActivity(platform as TradingPlatform) : await fetchTradingActivity(),
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
