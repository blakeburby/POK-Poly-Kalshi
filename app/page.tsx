export const dynamic = "force-static";

/**
 * Public homepage placeholder for the future POK Capital company site.
 * Intentionally generic scaffolding — no references to the strategy, exchanges,
 * or specific markets. The dashboard lives privately at /Terminal.
 */
const SECTIONS = [
  { title: "Mission", body: "Coming soon." },
  { title: "Investment Philosophy", body: "Coming soon." },
  { title: "Technology", body: "Coming soon." },
  { title: "Capabilities", body: "Coming soon." },
];

export default function HomePage() {
  const year = 2026;
  return (
    <main className="bg-grid flex min-h-dvh flex-col bg-base text-fg">
      <header className="flex items-center gap-3 px-6 py-5 sm:px-10">
        <div className="grid size-9 place-items-center rounded-sm bg-gradient-to-br from-cyan/30 to-violet/20 ring-1 ring-cyan/30">
          <span className="font-mono text-[15px] font-bold tracking-tighter text-fg">P</span>
        </div>
        <span className="text-[15px] font-semibold tracking-tight text-fg">POK CAPITAL</span>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        <h1 className="max-w-3xl text-[40px] font-semibold leading-[1.05] tracking-tight text-fg sm:text-[64px]">
          POK Capital
        </h1>
        <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-fg-muted sm:text-[17px]">
          A quantitative investment firm. Our website is coming soon.
        </p>
        <span className="mt-8 inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
          <span className="size-1.5 rounded-full bg-cyan" /> Under construction
        </span>
      </section>

      <section className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-px border-t border-line sm:grid-cols-2 lg:grid-cols-4">
        {SECTIONS.map((s) => (
          <div key={s.title} className="border-r border-line/60 px-6 py-8">
            <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-fg-secondary">{s.title}</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-faint">{s.body}</p>
          </div>
        ))}
      </section>

      <footer className="px-6 py-6 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-fg-faint sm:px-10">
        © {year} POK Capital
      </footer>
    </main>
  );
}
