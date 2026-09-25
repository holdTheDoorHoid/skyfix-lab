/**
 * The Milky Way's glow behind the stars. OWNER: sky2 agent (expansion Q3). No DOM here
 * except the offscreen canvas the renderer hands in.
 *
 * Source: the deep-sky engine's `milky_way_outline()` (EXPLORER_API "deep sky"): this
 * project's own isophotes from NASA COBE/DIRBE, four levels, 24 closed rings in ICRS.
 *
 * Why a raster and not polygons: the rings are regions on the sphere, and both of the Sky
 * view's projections have a place where a filled polygon breaks — the dome's nadir (the
 * stereographic projection sends it to infinity, so a ring passing near it would cut a
 * chord across the chart) and the panorama's seam behind the viewer. So the rings are
 * filled once, on a grid in galactic longitude and latitude, where the band is a strip
 * that never reaches a pole (every ring lies within 30° of the galactic equator, and the
 * galactic poles lie outside every level). Each frame the grid is sampled for a coarse
 * raster of the screen (a texel is 4 to 6 CSS px, about a degree), through one rotation
 * from the observer's horizon to galactic coordinates, and the raster is drawn scaled up
 * with smoothing: the soft gradient the design asks for, at a cost that does not depend
 * on the rings.
 *
 * - Filling: along each meridian of galactic longitude, the rings' crossings are counted
 *   up from the south galactic pole (even-odd, as the engine documents); a cell counts
 *   the levels whose region holds its centre. Ring edges are great-circle arcs up to 14°
 *   long; within 30° of the galactic equator a straight line in (l, b) is within 0.1° of
 *   them, so the edges are interpolated linearly.
 * - Softening: the level counts are blurred with a Gaussian of σ = 1°, so the isophotes
 *   read as a glow rather than terraces.
 * - Refraction is left out of the raster (0.6° at most, on the horizon, under a texel);
 *   extinction dims the glow toward the horizon like the stars, when that layer is on.
 */

import type { MilkyWayOutline } from '../engine/types.js';

const DEG = Math.PI / 180;

/** ICRS to galactic, row-major (ESA 1997, Hipparcos Catalogue vol. 1, §1.5.3: the IAU 1958 system via FK5 J2000). */
export const ICRS_TO_GALACTIC: Float64Array = Float64Array.of(
  -0.0548755604162154,
  -0.8734370902348850,
  -0.4838350155487132,
  0.4941094278755837,
  -0.4448296299600112,
  0.7469822444972189,
  -0.8676661490190047,
  -0.1980763734312015,
  0.4559837761750669,
);

/** Galactic longitude and latitude (degrees) of an ICRS direction (degrees). */
export function galacticOf(raDeg: number, decDeg: number): { l: number; b: number } {
  const c = Math.cos(decDeg * DEG);
  const x = c * Math.cos(raDeg * DEG);
  const y = c * Math.sin(raDeg * DEG);
  const z = Math.sin(decDeg * DEG);
  const m = ICRS_TO_GALACTIC;
  const gx = m[0]! * x + m[1]! * y + m[2]! * z;
  const gy = m[3]! * x + m[4]! * y + m[5]! * z;
  const gz = m[6]! * x + m[7]! * y + m[8]! * z;
  let l = Math.atan2(gy, gx) / DEG;
  if (l < 0) l += 360;
  return { l, b: Math.asin(Math.max(-1, Math.min(1, gz))) / DEG };
}

// ---------------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------------

/** Grid spacing, degrees, and the latitude band it covers (every ring lies within ±28°). */
export const GRID_STEP = 0.5;
export const GRID_B_MAX = 32;
export const GRID_COLS = Math.round(360 / GRID_STEP);
export const GRID_ROWS = Math.round((2 * GRID_B_MAX) / GRID_STEP);

export interface MilkyWayGrid {
  /** Brightness 0…1 per cell, row-major: `value[row * cols + col]`; col 0 is l = 0…0.5°, row 0 is b = −32°…−31.5°. */
  value: Float32Array;
  cols: number;
  rows: number;
  /** Levels in the outline (the grid counts how many hold each cell, divided by this). */
  levels: number;
  /** Largest |b| a ring reaches, degrees (a check on the band assumption). */
  maxAbsB: number;
}

/**
 * Fill the rings of each level on the (l, b) grid (even-odd from the south galactic pole)
 * and blur the level counts. `sigmaDeg` 0 leaves them sharp (tests).
 */
export function buildMilkyWayGrid(outline: Pick<MilkyWayOutline, 'levels' | 'rings'>, sigmaDeg = 1): MilkyWayGrid {
  const cols = GRID_COLS;
  const rows = GRID_ROWS;
  const levels = Math.max(1, outline.levels.length);
  const count = new Float32Array(cols * rows);
  let maxAbsB = 0;
  // Every ring in galactic degrees, grouped by level.
  const byLevel: { l: Float64Array; b: Float64Array }[][] = Array.from({ length: levels }, () => []);
  for (const ring of outline.rings) {
    const n = Math.min(ring.ra_deg.length, ring.dec_deg.length);
    if (n < 3 || ring.level < 0 || ring.level >= levels) continue;
    const l = new Float64Array(n);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const g = galacticOf(ring.ra_deg[i]!, ring.dec_deg[i]!);
      l[i] = g.l;
      b[i] = g.b;
      maxAbsB = Math.max(maxAbsB, Math.abs(g.b));
    }
    byLevel[ring.level]!.push({ l, b });
  }
  // Each edge adds its crossing to the few meridians it spans (an edge is at most 14° long),
  // rather than every meridian testing every edge: a few thousand crossings in all.
  const perColumn: number[][] = Array.from({ length: cols }, () => []);
  for (let level = 0; level < levels; level += 1) {
    for (const col of perColumn) col.length = 0;
    for (const { l, b } of byLevel[level]!) {
      const n = l.length;
      for (let i = 0; i < n; i += 1) {
        // Consecutive points; a closed ring repeats its first point, so i -> i+1 covers every edge.
        const j = i + 1 < n ? i + 1 : 0;
        if (j === 0 && l[0] === l[n - 1] && b[0] === b[n - 1]) continue;
        const l1 = l[i]!;
        const dl = wrap180(l[j]! - l1);
        if (dl === 0) continue;
        // Meridians lc = (c + 0.5)·step with d = lc − l1 in [0, dl) (dl > 0) or (dl, 0] (dl < 0):
        // half-open, so an edge counts the meridian at its start, not its end.
        const lo = dl > 0 ? l1 : l1 + dl;
        const hi = dl > 0 ? l1 + dl : l1;
        const c0 = Math.ceil(lo / GRID_STEP - 0.5);
        const c1 = Math.floor(hi / GRID_STEP - 0.5);
        for (let c = c0; c <= c1; c += 1) {
          const lc = (c + 0.5) * GRID_STEP;
          const d = lc - l1;
          if (dl > 0 ? !(d >= 0 && d < dl) : !(d <= 0 && d > dl)) continue;
          const col = ((c % cols) + cols) % cols;
          perColumn[col]!.push(b[i]! + (b[j]! - b[i]!) * (d / dl));
        }
      }
    }
    for (let col = 0; col < cols; col += 1) {
      const crossings = perColumn[col]!;
      if (crossings.length < 2) continue;
      crossings.sort((p, q) => p - q);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.ceil((crossings[k]! + GRID_B_MAX) / GRID_STEP - 0.5));
        const to = Math.min(rows - 1, Math.floor((crossings[k + 1]! + GRID_B_MAX) / GRID_STEP - 0.5));
        for (let row = from; row <= to; row += 1) count[row * cols + col]! += 1;
      }
    }
  }
  for (let i = 0; i < count.length; i += 1) count[i] = count[i]! / levels;
  const value = sigmaDeg > 0 ? blurGrid(count, cols, rows, sigmaDeg / GRID_STEP) : count;
  return { value, cols, rows, levels, maxAbsB };
}

function wrap180(d: number): number {
  const x = (((d + 180) % 360) + 360) % 360 - 180;
  return x === -180 ? 180 : x;
}

/**
 * A Gaussian blur of standard deviation `sigma` cells, as three passes of a running box
 * filter each way (the usual approximation: three boxes of width w give σ² = (w² − 1)/4);
 * longitude wraps, latitude clamps at the grid's edge. Its cost does not grow with σ.
 */
function blurGrid(src: Float32Array, cols: number, rows: number, sigma: number): Float32Array {
  const half = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const a = Float32Array.from(src);
  const b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass += 1) {
    boxRows(a, b, cols, rows, half);
    boxCols(b, a, cols, rows, half);
  }
  return a;
}

/** One box pass along longitude (wrapping), width 2·half + 1 (half < cols). */
function boxRows(src: Float32Array, dst: Float32Array, cols: number, rows: number, half: number): void {
  const inv = 1 / (2 * half + 1);
  for (let row = 0; row < rows; row += 1) {
    const o = row * cols;
    let acc = 0;
    for (let i = -half; i <= half; i += 1) acc += src[o + (i < 0 ? i + cols : i)]!;
    for (let col = 0; col < cols; col += 1) {
      dst[o + col] = acc * inv;
      const inn = col + half + 1;
      const out = col - half;
      acc += src[o + (inn >= cols ? inn - cols : inn)]! - src[o + (out < 0 ? out + cols : out)]!;
    }
  }
}

/** One box pass along latitude (clamped at the edges), width 2·half + 1: rows swept in order. */
function boxCols(src: Float32Array, dst: Float32Array, cols: number, rows: number, half: number): void {
  const inv = 1 / (2 * half + 1);
  const acc = new Float64Array(cols);
  const rowOf = (r: number): number => (r < 0 ? 0 : r >= rows ? rows - 1 : r) * cols;
  for (let i = -half; i <= half; i += 1) {
    const o = rowOf(i);
    for (let c = 0; c < cols; c += 1) acc[c]! += src[o + c]!;
  }
  for (let row = 0; row < rows; row += 1) {
    const o = row * cols;
    const add = rowOf(row + half + 1);
    const sub = rowOf(row - half);
    for (let c = 0; c < cols; c += 1) {
      dst[o + c] = acc[c]! * inv;
      acc[c]! += src[add + c]! - src[sub + c]!;
    }
  }
}

/** The grid's brightness at a galactic unit vector (0 outside the band). Nearest cell. */
export function sampleGrid(grid: MilkyWayGrid, gx: number, gy: number, gz: number): number {
  if (gz > SIN_B_MAX || gz < -SIN_B_MAX) return 0;
  let l = Math.atan2(gy, gx);
  if (l < 0) l += 2 * Math.PI;
  const b = Math.asin(gz);
  let col = Math.floor(l / STEP_RAD);
  if (col >= grid.cols) col = grid.cols - 1;
  let row = Math.floor((b + B_MAX_RAD) / STEP_RAD);
  if (row < 0) row = 0;
  else if (row >= grid.rows) row = grid.rows - 1;
  return grid.value[row * grid.cols + col]!;
}

const STEP_RAD = GRID_STEP * DEG;
const B_MAX_RAD = GRID_B_MAX * DEG;
const SIN_B_MAX = Math.sin(B_MAX_RAD);

// ---------------------------------------------------------------------------------
// The raster
// ---------------------------------------------------------------------------------

/** `out = a · b` for row-major 3×3 matrices. */
export function mul3(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array = new Float64Array(9)): Float64Array {
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      out[3 * i + j] = a[3 * i]! * b[j]! + a[3 * i + 1]! * b[3 + j]! + a[3 * i + 2]! * b[6 + j]!;
    }
  }
  return out;
}

/** `out = mᵀ`. */
export function transpose3(m: ArrayLike<number>, out: Float64Array = new Float64Array(9)): Float64Array {
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) out[3 * j + i] = m[3 * i + j]!;
  return out;
}

/**
 * The rotation from the observer's horizon `(E, N, U)` to galactic coordinates:
 * `G · Fᵀ · Hᵀ`, with `H` the horizon matrix of the frame of date (astro.ts) and `F` the
 * star field's ICRS-to-date frame matrix.
 */
export function horizonToGalactic(horizon: ArrayLike<number>, frame: ArrayLike<number>, out: Float64Array = new Float64Array(9)): Float64Array {
  const ft = transpose3(frame);
  const ht = transpose3(horizon);
  return mul3(ICRS_TO_GALACTIC, mul3(ft, ht), out);
}

/** How a texel's screen position becomes a direction: the dome or the panorama's parameters. */
export type RasterView =
  | { kind: 'dome'; cx: number; cy: number; radius: number; southUp: boolean }
  | { kind: 'panorama'; width: number; az0: number; s: number; yHorizon: number };

export interface RasterTarget {
  /** RGBA, `width × height` texels (an ImageData's buffer in the browser). */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** CSS pixels per texel. */
  cell: number;
}

export interface RasterStyle {
  /** The glow's colour, 0–255. */
  r: number;
  g: number;
  b: number;
  /** Opacity of the brightest part (all four levels). */
  alpha: number;
  /**
   * Dimming toward the horizon: 201 factors for sin(altitude) = 0, 0.005, … 1 (null: none).
   * `extinctionFade` makes them from the relative extinction.
   */
  fade: Float32Array | null;
}

/** Transmission 10^(−0.4 Δm) toward the horizon, tabulated by sin(altitude) in steps of 0.005. */
export function extinctionFade(rel: Float32Array): Float32Array {
  const out = new Float32Array(201);
  for (let i = 0; i <= 200; i += 1) {
    const h = Math.asin(i / 200) / DEG;
    const k = Math.floor(h);
    const e = k >= 90 ? 0 : rel[k]! + (rel[Math.min(90, k + 1)]! - rel[k]!) * (h - k);
    out[i] = Math.pow(10, -0.4 * e);
  }
  return out;
}

/**
 * Fill `target` with the glow as seen through `view`, `m` the horizon-to-galactic
 * rotation. Returns the number of texels that carry any glow (tests and statistics).
 * Allocation-free; about 25 000 texels a frame at most.
 */
export function rasterMilkyWay(grid: MilkyWayGrid, target: RasterTarget, view: RasterView, m: ArrayLike<number>, style: RasterStyle): number {
  const { data, width, height, cell } = target;
  const m0 = m[0]!, m1 = m[1]!, m2 = m[2]!, m3 = m[3]!, m4 = m[4]!, m5 = m[5]!, m6 = m[6]!, m7 = m[7]!, m8 = m[8]!;
  const { r, g, b, alpha, fade } = style;
  const a255 = 255 * alpha;
  let lit = 0;
  data.fill(0);
  if (view.kind === 'dome') {
    const inv = 1 / view.radius;
    const sign = view.southUp ? -1 : 1;
    for (let y = 0; y < height; y += 1) {
      const dy = ((y + 0.5) * cell - view.cy) * inv * sign;
      for (let x = 0; x < width; x += 1) {
        const dx = ((x + 0.5) * cell - view.cx) * inv * sign;
        const t2 = dx * dx + dy * dy;
        if (t2 > 1.0) continue; // below the horizon
        // Stereographic from the nadir: t = tan(z/2) = ρ/R; E = −2dx/(1+t²), N = −2dy/(1+t²), U = (1−t²)/(1+t²).
        const q = 1 / (1 + t2);
        const e = -2 * dx * q;
        const n = -2 * dy * q;
        const u = (1 - t2) * q;
        const gz = m6 * e + m7 * n + m8 * u;
        if (gz > SIN_B_MAX || gz < -SIN_B_MAX) continue;
        const v = sampleGrid(grid, m0 * e + m1 * n + m2 * u, m3 * e + m4 * n + m5 * u, gz);
        if (v <= 0.004) continue;
        const f = fade ? fade[Math.min(200, Math.max(0, Math.round(u * 200)))]! : 1;
        const o = 4 * (y * width + x);
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = a255 * v * f;
        lit += 1;
      }
    }
    return lit;
  }
  // Panorama: azimuth by column, altitude by row (Mercator), so the trigonometry is per line.
  const colSin = scratch(width, 0);
  const colCos = scratch(width, 1);
  for (let x = 0; x < width; x += 1) {
    const az = view.az0 + ((x + 0.5) * cell - view.width / 2) / view.s;
    colSin[x] = Math.sin(az);
    colCos[x] = Math.cos(az);
  }
  for (let y = 0; y < height; y += 1) {
    const mm = (view.yHorizon - (y + 0.5) * cell) / view.s;
    if (mm < 0) continue; // the ground
    const u = Math.tanh(mm);
    const c = 1 / Math.cosh(mm);
    const f = fade ? fade[Math.min(200, Math.max(0, Math.round(u * 200)))]! : 1;
    if (f < 0.004) continue;
    for (let x = 0; x < width; x += 1) {
      const e = c * colSin[x]!;
      const n = c * colCos[x]!;
      const gz = m6 * e + m7 * n + m8 * u;
      if (gz > SIN_B_MAX || gz < -SIN_B_MAX) continue;
      const v = sampleGrid(grid, m0 * e + m1 * n + m2 * u, m3 * e + m4 * n + m5 * u, gz);
      if (v <= 0.004) continue;
      const o = 4 * (y * width + x);
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a255 * v * f;
      lit += 1;
    }
  }
  return lit;
}

const scratches: Float64Array[] = [new Float64Array(0), new Float64Array(0)];
function scratch(n: number, which: 0 | 1): Float64Array {
  if (scratches[which]!.length < n) scratches[which] = new Float64Array(n);
  return scratches[which]!;
}

/** The largest element-wise difference of two 3×3 matrices (when a raster must be redone). */
export function matrixDelta(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  for (let i = 0; i < 9; i += 1) d = Math.max(d, Math.abs(a[i]! - b[i]!));
  return d;
}
