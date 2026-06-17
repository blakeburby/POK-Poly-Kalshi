"use client";

import * as React from "react";
import { useDashboardStore } from "@/store/dashboard-store";
import { OverviewView } from "./OverviewView";
import { PerformanceView } from "./PerformanceView";
import { ExecutionView } from "./ExecutionView";
import { RiskView } from "./RiskView";
import { LedgerView } from "./LedgerView";
import { VenuePnlView } from "./VenuePnlView";
import { EdgeView } from "./EdgeView";
import { BooksView } from "./BooksView";
import { HealthView } from "./HealthView";
import { ThreeDView } from "./ThreeDView";

export function ViewRouter() {
  const view = useDashboardStore((s) => s.view);
  const snap = useDashboardStore((s) => s.snapshot);
  if (!snap) return null;

  switch (view) {
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
    case "health":
      return <HealthView snap={snap} />;
    case "threeD":
      return <ThreeDView snap={snap} />;
    default:
      return <OverviewView snap={snap} />;
  }
}
