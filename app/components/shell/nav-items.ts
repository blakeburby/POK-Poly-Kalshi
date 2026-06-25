import {
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
} from "lucide-react";
import type { ComponentType } from "react";
import type { ViewId } from "@/store/dashboard-store";

export interface NavItem {
  id: ViewId;
  label: string;
  short: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  hot: string;
}

/** Single source of truth for navigation, shared by the desktop rail and mobile tab bar. */
export const NAV: NavItem[] = [
  { id: "overview", label: "Overview", short: "Home", icon: LayoutGrid, hot: "1" },
  { id: "performance", label: "Performance", short: "Perf", icon: LineChart, hot: "2" },
  { id: "execution", label: "Execution", short: "Exec", icon: Zap, hot: "3" },
  { id: "risk", label: "Risk", short: "Risk", icon: ShieldAlert, hot: "4" },
  { id: "ledger", label: "Trade Ledger", short: "Ledger", icon: ScrollText, hot: "5" },
  { id: "venuePnl", label: "Venue P&L", short: "P&L", icon: Wallet, hot: "6" },
  { id: "edge", label: "Edge / Opp.", short: "Edge", icon: Crosshair, hot: "7" },
  { id: "books", label: "Order Books", short: "Books", icon: BookOpen, hot: "8" },
  { id: "ladder", label: "Trading Ladder", short: "Ladder", icon: Rows3, hot: "l" },
  { id: "positions", label: "Positions", short: "Pos", icon: Briefcase, hot: "p" },
  { id: "tape", label: "Live Tape", short: "Tape", icon: Radio, hot: "t" },
  { id: "orderEntry", label: "Order Ticket", short: "Ticket", icon: PencilRuler, hot: "o" },
  { id: "candles", label: "Price Charts", short: "Price", icon: CandlestickChart, hot: "c" },
  { id: "releases", label: "Releases", short: "News", icon: Newspaper, hot: "n" },
  { id: "health", label: "System Health", short: "Health", icon: Activity, hot: "9" },
  { id: "threeD", label: "3D Analytics", short: "3D", icon: Boxes, hot: "0" },
];
