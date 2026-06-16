import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Legacy path — the login portal now lives at /Terminal. */
export default async function LoginRedirect({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; missing?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const query = new URLSearchParams();
  if (params.error) query.set("error", params.error);
  if (params.missing) query.set("missing", params.missing);
  const suffix = query.toString();
  redirect(`/Terminal${suffix ? `?${suffix}` : ""}`);
}
