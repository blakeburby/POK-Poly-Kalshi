"use client";

import * as React from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { H, norm, toScene, type Point3, type AxisDef } from "./axes";

function AxisLine({
  from,
  to,
  color = "#2a323f",
}: {
  from: [number, number, number];
  to: [number, number, number];
  color?: string;
}) {
  return <Line points={[from, to]} color={color} lineWidth={1} />;
}

function Points({ points, axes }: { points: Point3[]; axes: { x: AxisDef; y: AxisDef; z: AxisDef } }) {
  return (
    <>
      {points.map((p, i) => {
        const x = toScene(norm(p.x, axes.x.min, axes.x.max));
        const y = toScene(norm(p.y, axes.y.min, axes.y.max));
        const z = toScene(norm(p.z, axes.z.min, axes.z.max));
        const r = (p.size ?? 0.05) + 0.06;
        return (
          <mesh key={i} position={[x, y, z]}>
            <sphereGeometry args={[r, 16, 16]} />
            <meshStandardMaterial color={p.color} emissive={p.color} emissiveIntensity={0.5} roughness={0.35} metalness={0.1} />
          </mesh>
        );
      })}
    </>
  );
}

/** Screen-space label (constant size, always on top, never scales with zoom). */
function AxisLabel({
  position,
  color,
  title = false,
  children,
}: {
  position: [number, number, number];
  color: string;
  title?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Html position={position} center style={{ pointerEvents: "none", userSelect: "none" }}>
      <span
        style={{
          display: "inline-block",
          fontFamily: "var(--font-geist-mono), monospace",
          fontSize: title ? 9 : 8,
          lineHeight: 1,
          letterSpacing: title ? "0.14em" : "0.01em",
          textTransform: title ? "uppercase" : "none",
          fontWeight: title ? 600 : 400,
          color,
          whiteSpace: "nowrap",
          padding: title ? "2px 5px" : "1px 3px",
          borderRadius: 3,
          background: "rgba(7,9,12,0.82)",
          boxShadow: title ? "inset 0 0 0 1px rgba(255,255,255,0.07)" : "none",
        }}
      >
        {children}
      </span>
    </Html>
  );
}

/** Min/max tick values, placed just outside each axis edge so they don't pile up. */
function Ticks({ axis, plane }: { axis: AxisDef; plane: "x" | "y" | "z" }) {
  const ends = [0, 1].map((t) => ({ t, val: axis.min + t * (axis.max - axis.min) }));
  return (
    <>
      {ends.map(({ t, val }) => {
        const s = toScene(t);
        const pos: [number, number, number] =
          plane === "x"
            ? [s, -H - 0.42, H]
            : plane === "y"
              ? [-H - 0.5, s, H]
              : [-H - 0.02, -H - 0.18, s];
        return (
          <AxisLabel key={`${plane}-${t}`} position={pos} color="#828c9b">
            {axis.fmt(val)}
          </AxisLabel>
        );
      })}
    </>
  );
}

function Frame({
  axes,
  plane,
}: {
  axes: { x: AxisDef; y: AxisDef; z: AxisDef };
  plane?: { value: number; axisMin: number; axisMax: number; label: string };
}) {
  const planeY = plane ? toScene(norm(plane.value, plane.axisMin, plane.axisMax)) : null;
  return (
    <group>
      <gridHelper args={[H * 2, 12, "#1b212b", "#11151c"]} position={[0, -H, 0]} />
      <AxisLine from={[-H, -H, H]} to={[H, -H, H]} />
      <AxisLine from={[-H, -H, H]} to={[-H, H, H]} />
      <AxisLine from={[-H, -H, H]} to={[-H, -H, -H]} />
      <Ticks axis={axes.x} plane="x" />
      <Ticks axis={axes.y} plane="y" />
      <Ticks axis={axes.z} plane="z" />
      <AxisLabel position={[0, -H - 0.92, H]} color="#22d3ee" title>
        {axes.x.label}
      </AxisLabel>
      <AxisLabel position={[-H - 1.14, 0, H]} color="#26d67c" title>
        {axes.y.label}
      </AxisLabel>
      <AxisLabel position={[-H - 0.02, -H - 0.92, 0]} color="#a855f7" title>
        {axes.z.label}
      </AxisLabel>
      {planeY != null ? (
        <mesh position={[0, planeY, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[H * 2, H * 2]} />
          <meshBasicMaterial color="#f5a623" transparent opacity={0.1} side={THREE.DoubleSide} />
        </mesh>
      ) : null}
    </group>
  );
}

export function Scene3D({
  points,
  axes,
  plane,
}: {
  points: Point3[];
  axes: { x: AxisDef; y: AxisDef; z: AxisDef };
  plane?: { value: number; axisMin: number; axisMax: number; label: string };
}) {
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      camera={{ position: [5.8, 4.1, 6.6], fov: 40, near: 0.1, far: 100 }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: "transparent" }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[6, 8, 4]} intensity={0.85} />
      <pointLight position={[-5, 2, -3]} intensity={0.3} color="#22d3ee" />
      <Frame axes={axes} plane={plane} />
      <Points points={points} axes={axes} />
      <OrbitControls
        makeDefault
        target={[0, -0.2, 0]}
        enableDamping={false}
        enablePan={false}
        minDistance={6}
        maxDistance={22}
      />
    </Canvas>
  );
}
