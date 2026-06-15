import { loginAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; missing?: string }>;
}) {
  const params = await searchParams;
  const missingPassword = params.missing === "1";
  const invalid = params.error === "1";

  return (
    <main className="bg-grid flex min-h-screen items-center justify-center bg-base p-6">
      <section className="w-full max-w-[420px] overflow-hidden rounded-lg border border-line-strong bg-surface shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line bg-surface-2/60 px-5 py-4">
          <div className="grid size-8 place-items-center rounded-sm bg-gradient-to-br from-cyan/30 to-violet/20 ring-1 ring-cyan/30">
            <span className="font-mono text-[13px] font-bold tracking-tighter text-fg">P</span>
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-[14px] font-semibold tracking-tight text-fg">POK CAPITAL · TERMINAL</span>
            <span className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-fg-faint">Read-Only Operator Access</span>
          </div>
        </div>

        <div className="px-5 py-5">
          <p className="text-[12px] leading-relaxed text-fg-muted">
            Live BTC 15-minute Kalshi ⇄ Polymarket arbitrage telemetry — performance, execution, hedge integrity, and
            system health. No trading controls are exposed in the browser.
          </p>

          <form action={loginAction} className="mt-5 flex flex-col gap-2">
            <label htmlFor="password" className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-muted">
              Dashboard Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              className="h-9 rounded-sm border border-line-strong bg-base px-3 font-mono text-[13px] text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-cyan/50 focus:ring-1 focus:ring-cyan/30"
            />
            <button
              type="submit"
              className="mt-2 h-9 rounded-sm border border-cyan/40 bg-cyan/15 font-mono text-[12px] font-medium uppercase tracking-[0.1em] text-cyan transition-colors hover:bg-cyan/25"
            >
              Enter Terminal
            </button>
          </form>

          {missingPassword ? (
            <p className="mt-3 rounded-sm border border-amber/30 bg-amber/10 px-3 py-2 font-mono text-[11px] text-amber">
              DASHBOARD_PASSWORD is not configured.
            </p>
          ) : null}
          {invalid ? (
            <p className="mt-3 rounded-sm border border-down/30 bg-down/10 px-3 py-2 font-mono text-[11px] text-down">
              Invalid dashboard password.
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
