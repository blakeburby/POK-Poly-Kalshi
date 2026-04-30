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
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-kicker">READ-ONLY OPERATOR ACCESS</div>
        <h1>POK Cross-Venue Terminal</h1>
        <p>
          Monitor live BTC 15-minute Kalshi/Polymarket spreads, signal history,
          and venue health without exposing trading controls in the browser.
        </p>
        <form action={loginAction} className="login-form">
          <label htmlFor="password">Dashboard password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" autoFocus />
          <button type="submit">Enter terminal</button>
        </form>
        {missingPassword ? <p className="login-error">DASHBOARD_PASSWORD is not configured.</p> : null}
        {invalid ? <p className="login-error">Invalid dashboard password.</p> : null}
      </section>
    </main>
  );
}
