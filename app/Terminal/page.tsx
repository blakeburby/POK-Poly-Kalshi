import type { Metadata } from "next";
import DashboardApp from "../components/DashboardApp";
import { LoginPortal } from "../components/LoginPortal";
import { hasDashboardSession } from "../lib/dashboard-session";

export const dynamic = "force-dynamic";

// Private portal — keep it out of search engines.
export const metadata: Metadata = {
  title: "Terminal · POK Capital",
  robots: { index: false, follow: false },
};

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
