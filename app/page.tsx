import { redirect } from "next/navigation";
import DashboardTerminal from "./components/DashboardTerminal";
import type { DashboardKind } from "./components/DashboardTerminal";
import { hasDashboardSession } from "./lib/dashboard-session";

export const dynamic = "force-dynamic";

type DashboardPageProps = {
  searchParams?: Promise<{
    dashboard?: string | string[];
  }>;
};

function parseDashboardKind(value: string | string[] | undefined): DashboardKind | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "live" || raw === "paper" ? raw : null;
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  if (!(await hasDashboardSession())) redirect("/login");
  const params = await searchParams;
  return (
    <DashboardTerminal
      dashboardName={process.env.NEXT_PUBLIC_DASHBOARD_NAME ?? "POK Cross-Venue Terminal"}
      initialDashboard={parseDashboardKind(params?.dashboard)}
    />
  );
}
