"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import type { Point3, AxisDef } from "./axes";

const Scene3D = dynamic(() => import("./Scene3D").then((m) => m.Scene3D), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center font-mono text-[11px] text-fg-faint">initializing WebGL…</div>
  ),
});

interface Props {
  points: Point3[];
  axes: { x: AxisDef; y: AxisDef; z: AxisDef };
  plane?: { value: number; axisMin: number; axisMax: number; label: string };
}

class WebGLBoundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function Viz3DPanel({ points, axes, plane }: Props) {
  return (
    <WebGLBoundary
      fallback={
        <div className="flex h-full flex-col items-center justify-center gap-1 font-mono text-[11px] text-fg-muted">
          <span>WebGL unavailable</span>
          <span className="text-fg-faint">{points.length} points · use the 2D views</span>
        </div>
      }
    >
      {points.length ? (
        <Scene3D points={points} axes={axes} plane={plane} />
      ) : (
        <div className="flex h-full items-center justify-center font-mono text-[11px] text-fg-faint">no data points</div>
      )}
    </WebGLBoundary>
  );
}
