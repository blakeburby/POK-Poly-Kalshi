"use client";

import * as React from "react";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { cn } from "@/lib/utils";

/** Thin re-exports so the rest of the app imports split-pane bits from one place. */
export const ResizableGroup = PanelGroup;
export const ResizablePane = Panel;

/**
 * Draggable divider between panes — a slim grip that brightens to cyan on hover/drag.
 * Honours the terminal's "no decorative motion" rule (colour-only state change).
 */
export function ResizeHandle({ className }: { className?: string }) {
  return (
    <PanelResizeHandle
      className={cn("group relative flex w-2 shrink-0 items-center justify-center outline-none", className)}
    >
      <div className="h-10 w-px rounded-full bg-line-strong transition-colors group-hover:bg-cyan/60 group-data-[resize-handle-state=drag]:bg-cyan" />
    </PanelResizeHandle>
  );
}
