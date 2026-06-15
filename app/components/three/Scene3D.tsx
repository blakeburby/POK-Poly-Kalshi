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
        const r = (p.size ?? 0.05) + 0.03;
        return (
          <mesh key={i} position={[x, y, z]}>
            <sphereGeometry args={[r, 12, 12]} />
            <meshStandardMaterial color={p.color} emissive={p.color} emissiveIntensity={0.35} roughness={0.4} metalness={0.1} />
          </mesh>
        );
      })}
    </>
  );
}

function Ticks({ axis, plane }: { axis: AxisDef; plane: "x" | "y" | "z" }) {
  const labels = [0, 0.5, 1].map((t) => ({ t, val: axis.min + t * (axis.max - axis.min) }));
  return (
    <>
      {labels.map(({ t, val }) => {
        const s = toScene(t);
        const pos: [number, number, number] =
          plane === "x" ? [s, -H - 0.25, H] : plane === "y" ? [-H - 0.25, s, H] : [-H - 0.25, -H - 0.25, s];
        return (
          <Html key={`${plane}-${t}`} position={pos} center distanceFactor={9} style={{ pointerEvents: "none" }}>
            <span style={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: 9, color: "#6b7280", whiteSpace: "nowrap" }}>
              {axis.fmt(val)}
            </span>
          </Html>
        );
      })}
    </>
  );
}

function AxisTitle({ text, position, color }: { text: string; position: [number, number, number]; color: string }) {
  return (
    <Html position={position} center distanceFactor={8} style={{ pointerEvents: "none" }}>
      <span
        style={{
          fontFamily: "var(--font-geist-mono), monospace",
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color,
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </span>
    </Html>
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
      <AxisTitle text={axes.x.label} position={[0, -H - 0.7, H]} color="#22d3ee" />
      <AxisTitle text={axes.y.label} position={[-H - 0.9, 0, H]} color="#26d67c" />
      <AxisTitle text={axes.z.label} position={[-H - 0.9, -H - 0.7, 0]} color="#a855f7" />
      {planeY != null ? (
        <mesh position={[0, planeY, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[H * 2, H * 2]} />
          <meshBasicMaterial color="#f5a623" transparent opacity={0.08} side={THREE.DoubleSide} />
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
      dpr={[1, 1.5]}
      camera={{ position: [4.6, 3.4, 5.2], fov: 46 }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: "transparent" }}
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 8, 4]} intensity={0.8} />
      <pointLight position={[-5, 2, -3]} intensity={0.25} color="#22d3ee" />
      <Frame axes={axes} plane={plane} />
      <Points points={points} axes={axes} />
      <OrbitControls enableDamping={false} enablePan={false} minDistance={4} maxDistance={14} />
    </Canvas>
  );
}
