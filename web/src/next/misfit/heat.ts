/**
 * Drawing the residual heat map: on a canvas under any chart that maps latitude and
 * longitude to pixels, as SVG path data for charts drawn in SVG, and as a Mercator raster
 * for the map. OWNER: misfit agent.
 *
 * A chart hands over its projection as `{ project, unproject? }`:
 * - with `unproject` (pixels to position), every pixel is coloured from the grid by
 *   bilinear interpolation: smooth, exact under any projection, one pass over the pixels;
 * - with `project` alone, each node's cell is filled as a projected quadrilateral,
 *   batched by colour (64 shades), slightly enlarged so neighbours leave no hairline gaps.
 * Pixels off the grid (or on the far side of a globe, where `unproject` returns null) are
 * left untouched.
 */

import type { LatLonDeg, MisfitGrid, MisfitLevelName } from '../engine/types.js';
import type { MisfitContours } from './contours.js';
import { columnLon, type MisfitField, rowLat, sampleAt, sampleMisfit } from './grid.js';
import { type HeatRamp, type HeatScale, heatScale, themeRamp } from './ramp.js';

/** How a chart maps positions to its pixels (CSS pixels of the drawing). */
export interface HeatProjection {
  /** Position to pixels, or null where the chart does not draw (the far side of a globe). */
  project(p: LatLonDeg): readonly [number, number] | null;
  /** Pixels to position, or null off the chart. Optional; when given, heat is drawn per pixel. */
  unproject?(x: number, y: number): LatLonDeg | null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HeatOptions {
  /** Default: the document theme's ramp (`themeRamp`). */
  ramp?: HeatRamp;
  /** Default: `heatScale(grid)`. */
  scale?: HeatScale;
  /** 0-1, default 1. */
  opacity?: number;
  /** The part of the canvas to fill, CSS pixels. Default: the whole canvas. */
  rect?: Rect;
  /** Canvas pixels per CSS pixel for the per-pixel path. Default `devicePixelRatio`. */
  pixelRatio?: number;
}

type Grid = MisfitField & Pick<MisfitGrid, 'min'>;

/**
 * RGBA pixels of the heat over `width` x `height` pixels, pixel (px, py) coloured by the
 * chi-square `sample(px, py)` returns (NaN: left transparent).
 */
export function heatPixels(
  width: number,
  height: number,
  sample: (px: number, py: number) => number,
  ramp: HeatRamp,
  scale: HeatScale,
  opacity = 1,
): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(width * height * 4);
  const alpha = Math.round(255 * Math.min(1, Math.max(0, opacity)));
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const v = sample(px, py);
      if (Number.isNaN(v)) continue;
      const k = Math.round(255 * scale.t(v)) * 4;
      const o = (py * width + px) * 4;
      data[o] = ramp.lut[k]!;
      data[o + 1] = ramp.lut[k + 1]!;
      data[o + 2] = ramp.lut[k + 2]!;
      data[o + 3] = alpha;
    }
  }
  return data;
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** Draw the heat onto `ctx` (under whatever transform it has) through `projection`. */
export function drawMisfitHeat(
  ctx: CanvasRenderingContext2D,
  grid: Grid,
  projection: HeatProjection,
  options: HeatOptions = {},
): void {
  const ramp = options.ramp ?? themeRamp();
  const scale = options.scale ?? heatScale(grid);
  const opacity = options.opacity ?? 1;
  const rect = options.rect ?? { x: 0, y: 0, width: ctx.canvas.width, height: ctx.canvas.height };
  const unproject = projection.unproject?.bind(projection);
  if (unproject) {
    const ratio = Math.max(0.25, options.pixelRatio ?? globalThis.devicePixelRatio ?? 1);
    const w = Math.max(1, Math.round(rect.width * ratio));
    const h = Math.max(1, Math.round(rect.height * ratio));
    const data = heatPixels(
      w,
      h,
      (px, py) => {
        const p = unproject(rect.x + (px + 0.5) / ratio, rect.y + (py + 0.5) / ratio);
        return p ? sampleMisfit(grid, p) : Number.NaN;
      },
      ramp,
      scale,
      opacity,
    );
    const off = canvasOf(w, h);
    off.getContext('2d')!.putImageData(new ImageData(data, w, h), 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
    return;
  }
  drawCells(ctx, grid, projection, ramp, scale, opacity);
}

/** The forward path: each node's cell as a projected quadrilateral, 64 shades. */
function drawCells(
  ctx: CanvasRenderingContext2D,
  grid: Grid,
  projection: HeatProjection,
  ramp: HeatRamp,
  scale: HeatScale,
  opacity: number,
): void {
  const { n_lat: rows, n_lon: cols } = grid;
  // Cell edges half-way between nodes, clamped to the grid's edges.
  const latEdge = (k: number): number => rowLat(grid, Math.min(Math.max(k - 0.5, 0), rows - 1));
  const lonEdge = (k: number): number => columnLon(grid, Math.min(Math.max(k - 0.5, 0), cols - 1));
  const corners: ([number, number] | null)[] = [];
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      const p = projection.project({ lat_deg: latEdge(i), lon_deg: lonEdge(j) });
      corners.push(p ? [p[0], p[1]] : null);
    }
  }
  const SHADES = 64;
  const paths = Array.from({ length: SHADES }, () => new Path2D());
  const used = new Array<boolean>(SHADES).fill(false);
  const grow = 0.5;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const q = [corners[i * (cols + 1) + j], corners[i * (cols + 1) + j + 1], corners[(i + 1) * (cols + 1) + j + 1], corners[(i + 1) * (cols + 1) + j]];
      if (q.some((c) => c === null)) continue;
      const v = grid.chi2[i * cols + j]!;
      if (Number.isNaN(v)) continue;
      const shade = Math.min(SHADES - 1, Math.floor(scale.t(v) * SHADES));
      const cx = (q[0]![0] + q[1]![0] + q[2]![0] + q[3]![0]) / 4;
      const cy = (q[0]![1] + q[1]![1] + q[2]![1] + q[3]![1]) / 4;
      const path = paths[shade]!;
      q.forEach((c, k) => {
        const dx = c![0] - cx;
        const dy = c![1] - cy;
        const d = Math.hypot(dx, dy) || 1;
        const x = c![0] + (grow * dx) / d;
        const y = c![1] + (grow * dy) / d;
        if (k === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      path.closePath();
      used[shade] = true;
    }
  }
  ctx.save();
  ctx.globalAlpha *= opacity;
  paths.forEach((path, k) => {
    if (!used[k]) return;
    ctx.fillStyle = ramp.css((k + 0.5) / SHADES);
    ctx.fill(path);
  });
  ctx.restore();
}

/** Line styles by level: the 95 % line solid and strongest, 1 sigma dotted, 3 sigma dashed. */
export const LEVEL_LINE: Record<MisfitLevelName, { width: number; dash: number[] }> = {
  p95: { width: 2.25, dash: [] },
  one_sigma: { width: 1.5, dash: [1, 4] },
  three_sigma: { width: 1.5, dash: [7, 4] },
};

export interface LineOptions {
  /** Line colour; default the `--accent` token. */
  color?: string;
  /** Dark casing under the lines; default the `--line-halo` token. */
  halo?: string;
}

function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Project a line, breaking it wherever the projection has no point. */
function projectedRuns(line: readonly (readonly number[])[], projection: HeatProjection): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  for (const [lon, lat] of line) {
    const p = projection.project({ lat_deg: lat!, lon_deg: lon! });
    if (!p) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    run.push([p[0], p[1]]);
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/** Draw the contour lines (from `misfitContours`) on a canvas. */
export function drawMisfitLines(
  ctx: CanvasRenderingContext2D,
  contours: MisfitContours,
  projection: HeatProjection,
  options: LineOptions = {},
): void {
  const color = options.color ?? token('--accent', '#f2b63c');
  const halo = options.halo ?? token('--line-halo', 'rgba(22, 16, 4, 0.86)');
  ctx.save();
  ctx.lineJoin = 'round';
  for (const feature of contours.lines.features) {
    const style = LEVEL_LINE[feature.properties.level];
    const runs = feature.geometry.coordinates.flatMap((line) => projectedRuns(line, projection));
    for (const [stroke, width, dash] of [
      [halo, style.width + 2, []],
      [color, style.width, style.dash],
    ] as const) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.lineCap = dash.length ? 'butt' : 'round';
      ctx.setLineDash(dash);
      ctx.beginPath();
      for (const run of runs) {
        run.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** SVG path data for each level's lines (`d` attributes), for charts drawn in SVG. */
export function misfitLinePaths(
  contours: MisfitContours,
  projection: HeatProjection,
  digits = 2,
): { level: MisfitLevelName; label: string; d: string }[] {
  const f = (v: number): string => v.toFixed(digits);
  return contours.lines.features.map((feature) => ({
    level: feature.properties.level,
    label: feature.properties.label,
    d: feature.geometry.coordinates
      .flatMap((line) => projectedRuns(line, projection))
      .map((run) => run.map(([x, y], k) => `${k === 0 ? 'M' : 'L'}${f(x)} ${f(y)}`).join(''))
      .join(''),
  }));
}

/**
 * The heat as an image for an SVG chart (`<image href=…>` over `rect`): a data URL, one
 * pixel per CSS pixel times `pixelRatio`.
 */
export function misfitHeatDataUrl(grid: Grid, projection: HeatProjection, rect: Rect, options: HeatOptions = {}): string {
  const ratio = options.pixelRatio ?? 1;
  const w = Math.max(1, Math.round(rect.width * ratio));
  const h = Math.max(1, Math.round(rect.height * ratio));
  const c = canvasOf(w, h);
  const ctx = c.getContext('2d')!;
  ctx.scale(w / rect.width, h / rect.height);
  ctx.translate(-rect.x, -rect.y);
  drawMisfitHeat(ctx, grid, projection, { ...options, rect, pixelRatio: ratio });
  return c.toDataURL('image/png');
}

// ---------------------------------------------------------------------------------------
// A raster for the map (MapLibre image source, Web Mercator)

/** MapLibre's Mercator stops here. */
export const MERCATOR_MAX_LAT = 85.051129;

const mercY = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const mercLat = (y: number): number => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

/** The image corners MapLibre wants: top-left, top-right, bottom-right, bottom-left, as [lon, lat]. */
export type ImageCorners = [[number, number], [number, number], [number, number], [number, number]];

export interface MercatorHeat {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
  coordinates: ImageCorners;
}

/**
 * The heat resampled so its rows are evenly spaced in Web Mercator (an image source is
 * stretched linearly between its corners in the map's projection), clamped to MapLibre's
 * latitude limit. Longitudes run east from `west_deg` and may exceed 180.
 */
export function mercatorHeat(
  grid: Grid,
  ramp: HeatRamp,
  options: { width?: number; height?: number; opacity?: number; scale?: HeatScale } = {},
): MercatorHeat {
  const north = Math.min(grid.bounds.north_deg, MERCATOR_MAX_LAT);
  const south = Math.max(grid.bounds.south_deg, -MERCATOR_MAX_LAT);
  const width = Math.min(2048, options.width ?? 2 * grid.n_lon);
  const height = Math.min(2048, options.height ?? 2 * grid.n_lat);
  const y0 = mercY(north);
  const y1 = mercY(south);
  const west = grid.bounds.west_deg;
  const east = grid.bounds.east_deg;
  const scale = options.scale ?? heatScale(grid);
  const data = heatPixels(
    width,
    height,
    (px, py) => {
      // By grid index, so a box across the antimeridian needs no longitude wrapping.
      const lat = mercLat(y0 + ((py + 0.5) / height) * (y1 - y0));
      const i = (lat - grid.bounds.south_deg) / grid.lat_step_deg;
      const j = (((px + 0.5) / width) * (east - west)) / grid.lon_step_deg;
      if (!(i >= 0 && i <= grid.n_lat - 1 && j >= 0 && j <= grid.n_lon - 1)) return Number.NaN;
      return sampleAt(grid, i, j);
    },
    ramp,
    scale,
    options.opacity ?? 1,
  );
  return {
    width,
    height,
    data,
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  };
}

