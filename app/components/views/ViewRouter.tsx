"use client";

import * as React from "react";
import { useDashboardStore } from "@/store/dashboard-store";
import { CockpitView } from "./CockpitView";
import { OverviewView } from "./OverviewView";
import { PerformanceView } from "./PerformanceView";
import { ExecutionView } from "./ExecutionView";
import { RiskView } from "./RiskView";
import { LedgerView } from "./LedgerView";
import { VenuePnlView } from "./VenuePnlView";
import { EdgeView } from "./EdgeView";
import { BooksView } from "./BooksView";
import { LadderView } from "./LadderView";
import { PositionsView } from "./PositionsView";
import { TapeView } from "./TapeView";
import { OrderEntryView } from "./OrderEntryView";
import { CandlesView } from "./CandlesView";
import { ReleasesView } from "./ReleasesView";
import { HealthView } from "./HealthView";
import { ThreeDView } from "./ThreeDView";

export function ViewRouter() {
  const view = useDashboardStore((s) => s.view);
  const snap = useDashboardStore((s) => s.snapshot);
  if (!snap) return null;

  switch (view) {
    case "cockpit":
      return <CockpitView snap={snap} />;
    case "overview":
      return <OverviewView snap={snap} />;
    case "performance":
      return <PerformanceView snap={snap} />;
    case "execution":
      return <ExecutionView snap={snap} />;
    case "risk":
      return <RiskView snap={snap} />;
    case "ledger":
      return <LedgerView snap={snap} />;
    case "venuePnl":
      return <VenuePnlView snap={snap} />;
    case "edge":
      return <EdgeView snap={snap} />;
    case "books":
      return <BooksView snap={snap} />;
    case "ladder":
      return <LadderView snap={snap} />;
    case "positions":
      return <PositionsView snap={snap} />;
    case "tape":
      return <TapeView snap={snap} />;
    case "orderEntry":
      return <OrderEntryView snap={snap} />;
    case "candles":
      return <CandlesView />;
    case "releases":
      return <ReleasesView />;
    case "health":
      return <HealthView snap={snap} />;
    case "threeD":
      return <ThreeDView snap={snap} />;
    default:
      return <OverviewView snap={snap} />;
  }
}
