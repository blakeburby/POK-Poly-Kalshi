"use server";

import { redirect } from "next/navigation";
import { setDashboardSession, verifyDashboardPassword } from "../lib/dashboard-session";

export async function loginAction(formData: FormData): Promise<void> {
  const configured = Boolean(process.env.DASHBOARD_PASSWORD?.trim());
  if (!configured) redirect("/login?missing=1");
  const password = String(formData.get("password") ?? "");
  if (!verifyDashboardPassword(password)) redirect("/login?error=1");
  await setDashboardSession();
  redirect("/");
}
