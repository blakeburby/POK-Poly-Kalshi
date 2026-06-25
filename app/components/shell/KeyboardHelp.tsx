"use client";

import * as React from "react";
import { Keyboard } from "lucide-react";
import { Dialog, CenterContent } from "@/components/ui/dialog";
import { NAV } from "./nav-items";
import { cn } from "@/lib/utils";

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-[20px] items-center justify-center rounded-sm border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase leading-none tracking-wide text-fg-secondary",
        className,
      )}
    >
      {children}
    </span>
  );
}

function Row({ keys, label }: { keys: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[12px] text-fg-secondary">{label}</span>
      <span className="flex shrink-0 items-center gap-1">{keys}</span>
    </div>
  );
}

/** Press `?` to open a keyboard-shortcuts reference (companion to the ⌘K command palette). */
export function KeyboardHelp() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <CenterContent title="Keyboard shortcuts">
        <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
          <Keyboard className="size-4 shrink-0 text-fg-muted" strokeWidth={1.75} />
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-secondary">Keyboard Shortcuts</span>
          <Kbd className="ml-auto">esc</Kbd>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-1 px-4 py-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-fg-faint">Actions</div>
            <Row
              label="Command palette"
              keys={
                <>
                  <Kbd>⌘</Kbd>
                  <Kbd>K</Kbd>
                </>
              }
            />
            <Row label="This help" keys={<Kbd>?</Kbd>} />
            <Row label="Close overlay" keys={<Kbd>esc</Kbd>} />
            <div className="mb-1 mt-3 font-mono text-[9px] uppercase tracking-[0.14em] text-fg-faint">Tip</div>
            <p className="text-[11px] leading-relaxed text-fg-muted">
              Type a strike (e.g. <span className="text-fg-secondary">65000</span>) in the command palette to jump
              straight to that market.
            </p>
          </div>

          <div>
            <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-fg-faint">Views</div>
            <div className="max-h-[260px] overflow-y-auto pr-1">
              {NAV.map((n) => (
                <Row key={n.id} label={n.label} keys={<Kbd>{n.hot}</Kbd>} />
              ))}
            </div>
          </div>
        </div>
      </CenterContent>
    </Dialog>
  );
}
