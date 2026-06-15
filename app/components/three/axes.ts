/** Pure 3D-axis helpers — NO three/R3F imports, safe for the SSR graph. */

export interface Point3 {
  x: number;
  y: number;
  z: number;
  color: string;
  label?: string;
  size?: number;
}

export interface AxisDef {
  label: string;
  min: number;
  max: number;
  fmt: (v: number) => string;
}

/** half-extent of the plotting cube */
export const H = 2.4;

export function norm(v: number, min: number, max: number): number {
  if (!(max > min)) return 0.5;
  return Math.max(0, Math.min(1, (v - min) / (max - min)));
}

export const toScene = (n: number): number => (n - 0.5) * 2 * H;

function axisRange(values: number[]): [number, number] {
  if (!values.length) return [0, 1];
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.08;
  return [min - pad, max + pad];
}

export function autoAxes(
  points: Array<{ x: number; y: number; z: number }>,
  meta: { x: Omit<AxisDef, "min" | "max">; y: Omit<AxisDef, "min" | "max">; z: Omit<AxisDef, "min" | "max"> },
): { x: AxisDef; y: AxisDef; z: AxisDef } {
  const [xmin, xmax] = axisRange(points.map((p) => p.x));
  const [ymin, ymax] = axisRange(points.map((p) => p.y));
  const [zmin, zmax] = axisRange(points.map((p) => p.z));
  return {
    x: { ...meta.x, min: xmin, max: xmax },
    y: { ...meta.y, min: ymin, max: ymax },
    z: { ...meta.z, min: zmin, max: zmax },
  };
}
