import { redirect } from "next/navigation";
import DashboardTerminal from "./components/DashboardTerminal";
import { hasDashboardSession } from "./lib/dashboard-session";

export const dynamic = "force-dynamic";

type DashboardPageProps = {
  searchParams?: Promise<{
    dashboard?: string | string[];
  }>;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  if (!(await hasDashboardSession())) redirect("/login");
  await searchParams;
  return (
    <DashboardTerminal
      dashboardName={process.env.NEXT_PUBLIC_DASHBOARD_NAME ?? "POK Cross-Venue Terminal"}
    />
  );
}
