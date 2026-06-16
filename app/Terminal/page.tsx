import DashboardApp from "../components/DashboardApp";
import { LoginPortal } from "../components/LoginPortal";
import { hasDashboardSession } from "../lib/dashboard-session";

export const dynamic = "force-dynamic";

type TerminalPageProps = {
  searchParams?: Promise<{ error?: string; missing?: string }>;
};

export default async function TerminalPage({ searchParams }: TerminalPageProps) {
  if (await hasDashboardSession()) {
    return <DashboardApp dashboardName={process.env.NEXT_PUBLIC_DASHBOARD_NAME ?? "POK Capital Terminal"} />;
  }
  const params = (await searchParams) ?? {};
  return <LoginPortal error={params.error === "1"} missing={params.missing === "1"} />;
}
