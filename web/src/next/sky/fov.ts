/**
 * Field-of-view outlines for the Sky view: how much of the sky an eye, binoculars, a small
 * telescope or a camera takes in. OWNER: sky2 agent (expansion Q3). Pure geometry, no DOM.
 *
 * - Circles (eye, binoculars, telescope): a small circle of the given angular diameter
 *   around a direction, drawn through the projection point by point, so it keeps its true
 *   shape anywhere in either view.
 * - A camera: the frame of a sensor behind a lens (a rectilinear lens: the field across
 *   is `2 atan(w / 2f)`), held level (its long side along the horizon), built on the
 *   tangent plane at the direction and carried back onto the sphere.
 *
 * The presets are typical figures (a binocular's true field is printed on it; "7×50,
 * 7.1°" is a common pair), stated as such in the menu.
 */

import { DEG, RAD } from './astro.js';

export type FovPresetId = 'eye' | 'bino7x50' | 'bino10x50' | 'scope' | 'camera';

export interface FovPreset {
  id: FovPresetId;
  /** Menu words. */
  label: string;
  /** On the sky, beside the outline. */
  short: string;
  /** Angular diameter, degrees (null: the camera's, from the lens and sensor). */
  diameterDeg: number | null;
  note: string;
}

export const FOV_PRESETS: readonly FovPreset[] = [
  { id: 'eye', label: 'Naked eye', short: 'Naked eye', diameterDeg: 50, note: 'about 50°: what you take in without moving your eyes' },
  { id: 'bino7x50', label: 'Binoculars 7×50', short: 'Binoculars 7×50', diameterDeg: 7.1, note: 'a typical true field of 7.1°' },
  { id: 'bino10x50', label: 'Binoculars 10×50', short: 'Binoculars 10×50', diameterDeg: 6.5, note: 'a typical true field of 6.5°' },
  { id: 'scope', label: 'Small telescope', short: 'Small telescope', diameterDeg: 1, note: 'about 1° with a low-power eyepiece' },
  { id: 'camera', label: 'Camera', short: 'Camera', diameterDeg: null, note: 'the frame of a lens and sensor' },
];

export interface Sensor {
  id: string;
  label: string;
  widthMm: number;
  heightMm: number;
}

export const SENSORS: readonly Sensor[] = [
  { id: 'ff', label: 'Full frame (36 × 24 mm)', widthMm: 36, heightMm: 24 },
  { id: 'apsc', label: 'APS-C (23.5 × 15.6 mm)', widthMm: 23.5, heightMm: 15.6 },
  { id: 'apsc-canon', label: 'APS-C, Canon (22.3 × 14.9 mm)', widthMm: 22.3, heightMm: 14.9 },
  { id: 'mft', label: 'Micro Four Thirds (17.3 × 13 mm)', widthMm: 17.3, heightMm: 13 },
  { id: '1in', label: '1-inch (13.2 × 8.8 mm)', widthMm: 13.2, heightMm: 8.8 },
];

/** The camera's field across and up, degrees: `2 atan(size / 2f)` for a rectilinear lens. */
export function cameraField(focalMm: number, sensor: Pick<Sensor, 'widthMm' | 'heightMm'>): { widthDeg: number; heightDeg: number } {
  const f = Math.max(1, focalMm);
  return {
    widthDeg: 2 * Math.atan(sensor.widthMm / (2 * f)) * RAD,
    heightDeg: 2 * Math.atan(sensor.heightMm / (2 * f)) * RAD,
  };
}

export interface FovSettings {
  preset: FovPresetId | null;
  focalMm: number;
  sensorId: string;
  /** Around the selected object (following it), or the middle of the view. */
  anchor: 'target' | 'centre';
}

export const DEFAULT_FOV: FovSettings = { preset: null, focalMm: 50, sensorId: 'ff', anchor: 'target' };

export function sensorOf(id: string): Sensor {
  return SENSORS.find((s) => s.id === id) ?? SENSORS[0]!;
}

/** The words beside the outline: "Binoculars 7×50 · 7.1°", "Camera 50 mm · 39.6° × 27.0°". */
export function fovLabel(s: FovSettings): string {
  const preset = FOV_PRESETS.find((p) => p.id === s.preset);
  if (!preset) return '';
  if (preset.diameterDeg !== null) return `${preset.short} · ${formatDeg(preset.diameterDeg)}`;
  const f = cameraField(s.focalMm, sensorOf(s.sensorId));
  return `Camera ${Math.round(s.focalMm)} mm · ${formatDeg(f.widthDeg)} × ${formatDeg(f.heightDeg)}`;
}

function formatDeg(d: number): string {
  return d >= 10 ? `${d.toFixed(0)}°` : `${d.toFixed(1)}°`;
}

/**
 * Points of the outline around the horizon direction `d` (unit vector E, N, U), as
 * horizon unit vectors in `out` (3 per point); returns the point count. A circle of
 * `diameterDeg`, or a level rectangle `widthDeg × heightDeg`.
 */
export function fovOutline(
  d: ArrayLike<number>,
  shape: { diameterDeg: number } | { widthDeg: number; heightDeg: number },
  out: Float64Array,
): number {
  const [dx, dy, dz] = [d[0]!, d[1]!, d[2]!];
  // e1: level, to the right (the horizontal perpendicular to d); e2: up in the frame.
  let ex = dy;
  let ey = -dx;
  let ez = 0;
  let len = Math.hypot(ex, ey);
  if (len < 1e-9) {
    // Looking straight up: take east as "right".
    ex = 1;
    ey = 0;
    len = 1;
  }
  ex /= len;
  ey /= len;
  ez /= len;
  const fx = ey * dz - ez * dy;
  const fy = ez * dx - ex * dz;
  const fz = ex * dy - ey * dx;
  // (fx, fy, fz) = e1 × d points up in the frame; with e1 = right, e2 = d × e1 would point down.
  const max = Math.floor(out.length / 3);
  let n = 0;
  const put = (a: number, b: number, tangent: boolean): void => {
    if (n >= max) return;
    let x: number;
    let y: number;
    let z: number;
    if (tangent) {
      // Gnomonic: a straight line in the frame is a great circle on the sky.
      x = dx + a * ex + b * fx;
      y = dy + a * ey + b * fy;
      z = dz + a * ez + b * fz;
      const l = Math.hypot(x, y, z);
      x /= l;
      y /= l;
      z /= l;
    } else {
      x = a * dx + b * ex;
      y = a * dy + b * ey;
      z = a * dz + b * ez;
    }
    out[3 * n] = x;
    out[3 * n + 1] = y;
    out[3 * n + 2] = z;
    n += 1;
  };
  if ('diameterDeg' in shape) {
    const rho = (shape.diameterDeg / 2) * DEG;
    const c = Math.cos(rho);
    const s = Math.sin(rho);
    const steps = Math.min(max - 1, 96);
    for (let k = 0; k <= steps; k += 1) {
      const t = (2 * Math.PI * k) / steps;
      // cos ρ · d + sin ρ (cos t · e1 + sin t · e2)
      const x = c * dx + s * (Math.cos(t) * ex + Math.sin(t) * fx);
      const y = c * dy + s * (Math.cos(t) * ey + Math.sin(t) * fy);
      const z = c * dz + s * (Math.cos(t) * ez + Math.sin(t) * fz);
      if (n < max) {
        out[3 * n] = x;
        out[3 * n + 1] = y;
        out[3 * n + 2] = z;
        n += 1;
      }
    }
    return n;
  }
  const hw = Math.tan((shape.widthDeg / 2) * DEG);
  const hh = Math.tan((shape.heightDeg / 2) * DEG);
  const per = 16;
  const corners: [number, number][] = [
    [-hw, hh],
    [hw, hh],
    [hw, -hh],
    [-hw, -hh],
  ];
  for (let side = 0; side < 4; side += 1) {
    const [a0, b0] = corners[side]!;
    const [a1, b1] = corners[(side + 1) % 4]!;
    for (let k = 0; k < per; k += 1) put(a0 + ((a1 - a0) * k) / per, b0 + ((b1 - b0) * k) / per, true);
  }
  put(corners[0]![0], corners[0]![1], true);
  return n;
}

/** The angular diameter across the outline's widest side, degrees (for the label and tests). */
export function fovExtentDeg(s: FovSettings): number {
  const preset = FOV_PRESETS.find((p) => p.id === s.preset);
  if (!preset) return 0;
  if (preset.diameterDeg !== null) return preset.diameterDeg;
  return cameraField(s.focalMm, sensorOf(s.sensorId)).widthDeg;
}
