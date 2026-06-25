import {
  Gauge,
  LayoutGrid,
  LineChart,
  Zap,
  ShieldAlert,
  ScrollText,
  Wallet,
  Crosshair,
  BookOpen,
  Rows3,
  Briefcase,
  Radio,
  PencilRuler,
  CandlestickChart,
  Newspaper,
  Activity,
  Boxes,
  Lightbulb,
} from "lucide-react";
import type { ComponentType } from "react";
import type { ViewId } from "@/store/dashboard-store";

export type IconType = ComponentType<{ className?: string; strokeWidth?: number }>;

/** The five primary cockpit sections that replace the flat 16-tab rail. */
export type PrimarySectionId = "cockpit" | "performance" | "risk" | "execution" | "intelligence";

export interface NavItem {
  id: ViewId;
  label: string;
  short: string;
  icon: IconType;
  /** Single-char palette/keyboard mnemonic (informational; the rail binds section hotkeys). */
  hot: string;
  /** Which primary section this leaf view lives under. */
  section: PrimarySectionId;
}

/**
 * Single flat source of truth for every leaf view (consumed by the command palette + keyboard
 * help so EVERY view stays reachable). The desktop rail and mobile tab bar render the derived
 * `SECTIONS` grouping instead. Order within a section here sets the sub-tab order.
 */
export const NAV: NavItem[] = [
  // ── Cockpit — the unified live trading workspace ──
  { id: "cockpit", label: "Cockpit", short: "Cockpit", icon: Gauge, hot: "1", section: "cockpit" },
  { id: "candles", label: "Price Charts", short: "Charts", icon: CandlestickChart, hot: "c", section: "cockpit" },
  { id: "books", label: "Order Books", short: "Books", icon: BookOpen, hot: "b", section: "cockpit" },
  { id: "ladder", label: "Trading Ladder", short: "Ladder", icon: Rows3, hot: "l", section: "cockpit" },
  { id: "tape", label: "Live Tape", short: "Tape", icon: Radio, hot: "t", section: "cockpit" },
  { id: "orderEntry", label: "Order Ticket", short: "Ticket", icon: PencilRuler, hot: "o", section: "cockpit" },
  { id: "positions", label: "Positions", short: "Positions", icon: Briefcase, hot: "p", section: "cockpit" },

  // ── Performance & Portfolio ──
  { id: "overview", label: "Summary", short: "Summary", icon: LayoutGrid, hot: "s", section: "performance" },
  { id: "performance", label: "Analytics", short: "Analytics", icon: LineChart, hot: "a", section: "performance" },
  { id: "venuePnl", label: "Venue P&L", short: "Venue P&L", icon: Wallet, hot: "v", section: "performance" },
  { id: "ledger", label: "Trade Ledger", short: "Ledger", icon: ScrollText, hot: "g", section: "performance" },

  // ── Risk & System Health ──
  { id: "risk", label: "Risk", short: "Risk", icon: ShieldAlert, hot: "r", section: "risk" },
  { id: "health", label: "System Health", short: "Health", icon: Activity, hot: "h", section: "risk" },

  // ── Execution Analytics ──
  { id: "execution", label: "Execution", short: "Execution", icon: Zap, hot: "x", section: "execution" },

  // ── Market Intelligence ──
  { id: "edge", label: "Edge / Opp.", short: "Edge", icon: Crosshair, hot: "e", section: "intelligence" },
  { id: "releases", label: "Releases", short: "Releases", icon: Newspaper, hot: "n", section: "intelligence" },
  { id: "threeD", label: "3D Surfaces", short: "3D", icon: Boxes, hot: "d", section: "intelligence" },
];

export interface NavSection {
  id: PrimarySectionId;
  label: string;
  short: string;
  icon: IconType;
  /** Global hotkey (1-5) bound by the desktop rail; selects this section's default view. */
  hot: string;
  /** The view shown when the section is selected from the primary rail. */
  defaultView: ViewId;
  items: NavItem[];
}

const SECTION_META: Omit<NavSection, "items">[] = [
  { id: "cockpit", label: "Cockpit", short: "Cockpit", icon: Gauge, hot: "1", defaultView: "cockpit" },
  { id: "performance", label: "Performance", short: "Perf", icon: LineChart, hot: "2", defaultView: "performance" },
  { id: "risk", label: "Risk", short: "Risk", icon: ShieldAlert, hot: "3", defaultView: "risk" },
  { id: "execution", label: "Execution", short: "Exec", icon: Zap, hot: "4", defaultView: "execution" },
  { id: "intelligence", label: "Intelligence", short: "Intel", icon: Lightbulb, hot: "5", defaultView: "edge" },
];

/** Derived 5-section grouping for the primary rail + mobile tab bar. */
export const SECTIONS: NavSection[] = SECTION_META.map((meta) => ({
  ...meta,
  items: NAV.filter((n) => n.section === meta.id),
}));

/** The section a given leaf view belongs to (defaults to cockpit for anything untagged). */
export function sectionOf(view: ViewId): PrimarySectionId {
  return NAV.find((n) => n.id === view)?.section ?? "cockpit";
}
