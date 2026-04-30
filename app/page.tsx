import { redirect } from "next/navigation";
import DashboardTerminal from "./components/DashboardTerminal";
import { hasDashboardSession } from "./lib/dashboard-session";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!(await hasDashboardSession())) redirect("/login");
  return <DashboardTerminal dashboardName={process.env.NEXT_PUBLIC_DASHBOARD_NAME ?? "POK Cross-Venue Terminal"} />;
}
