/**
 * Marching squares over a misfit grid: the regions where the fit is within a level of the
 * best point (1 sigma, 95 %, 3 sigma), as GeoJSON polygons, and their boundaries as lines.
 * OWNER: misfit agent. Pure functions.
 *
 * - Inside means `chi2 <= level`. The grid is padded with an outside border, so every
 *   region is closed: a region that reaches the edge of the grid is closed along it. Those
 *   closing edges belong to the polygon but are not contour lines, so `lines` leaves them
 *   out (a line that meets the edge simply ends there).
 * - Each cell's crossings are interpolated linearly along its edges; a saddle cell (two
 *   opposite corners inside) is resolved by the value at its centre.
 * - Rings keep the inside on their left: exterior rings run anticlockwise and holes
 *   clockwise, in longitude/latitude as RFC 7946 asks.
 * - Antimeridian-safe: a grid that crosses 180 degrees is cut there (with a column
 *   interpolated exactly on the meridian) and each side is contoured on its own, so every
 *   polygon and line lies within [-180, 180] and a region spanning the meridian is two
 *   polygons that meet on it.
 */

import type { Feature, FeatureCollection, MultiLineString, MultiPolygon, Position } from 'geojson';
import type { MisfitGrid, MisfitLevelName } from '../engine/types.js';
import { DEFAULT_LEVELS, type MisfitField } from './grid.js';

/** A rectangular field of values, rows south to north, row-major. */
export interface Field {
  readonly values: ArrayLike<number>;
  readonly rows: number;
  readonly cols: number;
}

/** A closed ring in index space: `x` = column, `y` = row. */
export interface IsoRing {
  /** Vertices, not repeating the first. */
  points: [number, number][];
  /** `boundary[k]` for the segment from `points[k]` to `points[k + 1]` (wrapping): it runs along the field's edge. */
  boundary: boolean[];
  /** Signed area (shoelace): positive for an exterior ring, negative for a hole. */
  area: number;
}

// Cell corners: 0 bottom-left, 1 bottom-right, 2 top-right, 3 top-left. Edges: 0 bottom,
// 1 right, 2 top, 3 left. For each case (bit k set when corner k is inside), the segments
// as [from edge, to edge] with the inside on their left.
const SEGMENTS: readonly (readonly (readonly [number, number])[])[] = [
  [],
  [[0, 3]],
  [[1, 0]],
  [[1, 3]],
  [[2, 1]],
  [], // saddle, below
  [[2, 0]],
  [[2, 3]],
  [[3, 2]],
  [[0, 2]],
  [], // saddle, below
  [[1, 2]],
  [[3, 1]],
  [[0, 1]],
  [[3, 0]],
  [],
];
const SADDLE_5_CENTRE_IN = [[0, 1], [2, 3]] as const;
const SADDLE_5_CENTRE_OUT = [[0, 3], [2, 1]] as const;
const SADDLE_10_CENTRE_IN = [[3, 0], [1, 2]] as const;
const SADDLE_10_CENTRE_OUT = [[1, 0], [3, 2]] as const;

/**
 * The closed rings bounding `{value <= level}` (NaN counts as outside), in index space.
 * Rings along the field's edge are flagged so they can be kept out of contour lines.
 */
export function isoRings(field: Field, level: number): IsoRing[] {
  const { rows, cols, values } = field;
  const W = cols + 2;
  const H = rows + 2;
  const val = (r: number, c: number): number => {
    if (r <= 0 || c <= 0 || r >= H - 1 || c >= W - 1) return Infinity;
    const v = values[(r - 1) * cols + (c - 1)]!;
    return Number.isNaN(v) ? Infinity : v;
  };
  const points = new Map<number, [number, number]>();
  /** The crossing on the edge from node A to node B, in unpadded index space. */
  const crossing = (id: number, ra: number, ca: number, rb: number, cb: number, va: number, vb: number): void => {
    if (points.has(id)) return;
    // Measured from whichever end is inside, so an infinite far end puts it on the near node.
    const t = va <= level ? (vb === Infinity ? 0 : (level - va) / (vb - va)) : va === Infinity ? 1 : (va - level) / (va - vb);
    points.set(id, [ca + t * (cb - ca) - 1, ra + t * (rb - ra) - 1]);
  };
  const next = new Map<number, { to: number; boundary: boolean }>();
  for (let r = 0; r < H - 1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const bl = val(r, c);
      const br = val(r, c + 1);
      const tr = val(r + 1, c + 1);
      const tl = val(r + 1, c);
      const idx = (bl <= level ? 1 : 0) | (br <= level ? 2 : 0) | (tr <= level ? 4 : 0) | (tl <= level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      let segments: readonly (readonly [number, number])[] = SEGMENTS[idx]!;
      if (idx === 5 || idx === 10) {
        const centre = (bl + br + tr + tl) / 4;
        const inside = centre <= level;
        segments =
          idx === 5
            ? inside
              ? SADDLE_5_CENTRE_IN
              : SADDLE_5_CENTRE_OUT
            : inside
              ? SADDLE_10_CENTRE_IN
              : SADDLE_10_CENTRE_OUT;
      }
      const edge = [2 * (r * W + c), 2 * (r * W + c + 1) + 1, 2 * ((r + 1) * W + c), 2 * (r * W + c) + 1];
      const boundary = r === 0 || c === 0 || r === H - 2 || c === W - 2;
      for (const [a, b] of segments) {
        for (const e of [a, b]) {
          if (e === 0) crossing(edge[0]!, r, c, r, c + 1, bl, br);
          else if (e === 1) crossing(edge[1]!, r, c + 1, r + 1, c + 1, br, tr);
          else if (e === 2) crossing(edge[2]!, r + 1, c, r + 1, c + 1, tl, tr);
          else crossing(edge[3]!, r, c, r + 1, c, bl, tl);
        }
        next.set(edge[a]!, { to: edge[b]!, boundary });
      }
    }
  }
  const rings: IsoRing[] = [];
  for (const start of [...next.keys()]) {
    if (!next.has(start)) continue;
    const pts: [number, number][] = [];
    const flags: boolean[] = [];
    let cur = start;
    let closed = false;
    for (let guard = 0; guard <= next.size + pts.length + 1; guard++) {
      const s = next.get(cur);
      if (!s) break;
      next.delete(cur);
      pts.push(points.get(cur)!);
      flags.push(s.boundary);
      cur = s.to;
      if (cur === start) {
        closed = true;
        break;
      }
    }
    if (!closed || pts.length < 3) continue;
    let area = 0;
    for (let k = 0; k < pts.length; k++) {
      const [x0, y0] = pts[k]!;
      const [x1, y1] = pts[(k + 1) % pts.length]!;
      area += x0 * y1 - x1 * y0;
    }
    area /= 2;
    if (Math.abs(area) < 1e-12) continue;
    rings.push({ points: pts, boundary: flags, area });
  }
  return rings;
}

/** Even-odd ray test. */
function inside(pt: [number, number], ring: [number, number][]): boolean {
  const [x, y] = pt;
  let odd = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}

/** Exterior rings, each with the holes directly inside it. */
export function polygons(rings: IsoRing[]): { outer: IsoRing; holes: IsoRing[] }[] {
  const outers = rings.filter((r) => r.area > 0).sort((a, b) => a.area - b.area);
  const out = outers.map((outer) => ({ outer, holes: [] as IsoRing[] }));
  for (const hole of rings.filter((r) => r.area < 0)) {
    // The smallest exterior containing it: rings of one level never cross.
    const home = out.find((p) => p.outer.area > -hole.area && inside(hole.points[0]!, p.outer.points));
    if (home) home.holes.push(hole);
  }
  return out;
}

/** The contour lines of a ring: its runs of segments that are not along the edge. */
export function ringLines(ring: IsoRing): [number, number][][] {
  const n = ring.points.length;
  const first = ring.boundary.indexOf(true);
  if (first < 0) return [[...ring.points, ring.points[0]!]];
  const lines: [number, number][][] = [];
  let run: [number, number][] = [];
  for (let s = 1; s <= n; s++) {
    const k = (first + s) % n;
    if (ring.boundary[k]) {
      if (run.length >= 2) lines.push(run);
      run = [];
    } else {
      if (run.length === 0) run.push(ring.points[k]!);
      run.push(ring.points[(k + 1) % n]!);
    }
  }
  if (run.length >= 2) lines.push(run);
  return lines;
}

// ---------------------------------------------------------------------------------------
// From a misfit grid to GeoJSON

/** One side of the antimeridian: a sub-field and the longitude of each of its columns. */
interface Part {
  field: Field;
  /** Longitude of each column, already in [-180, 180]. */
  lons: number[];
}

/** The grid as one part, or two cut at 180 degrees (each with a column exactly on it). */
function parts(grid: MisfitField): Part[] {
  const { n_lat: rows, n_lon: cols, chi2 } = grid;
  const west = grid.bounds.west_deg;
  const lonOf = (j: number): number => west + j * grid.lon_step_deg;
  /** Columns `cols0`, with a column interpolated at fractional `extra.at` before or after them. */
  const slice = (cols0: number[], extra: { at: number; before: boolean } | null, shift: number): Part => {
    const order: (number | null)[] = extra ? (extra.before ? [null, ...cols0] : [...cols0, null]) : cols0;
    const n = order.length;
    const values = new Float64Array(rows * n);
    const lons: number[] = [];
    for (const [k, col] of order.entries()) {
      for (let i = 0; i < rows; i++) {
        if (col === null) {
          const j0 = Math.floor(extra!.at);
          const f = extra!.at - j0;
          values[i * n + k] = (1 - f) * chi2[i * cols + j0]! + f * chi2[i * cols + Math.min(j0 + 1, cols - 1)]!;
        } else {
          values[i * n + k] = chi2[i * cols + col]!;
        }
      }
      lons.push((col === null ? 180 : lonOf(col)) + shift);
    }
    return { field: { values, rows, cols: n }, lons };
  };
  const all = Array.from({ length: cols }, (_, j) => j);
  // West is in [-180, 180), so only an east edge beyond 180 crosses the meridian (a full
  // circle that starts at -180 ends on it and does not).
  if (grid.bounds.east_deg <= 180 + 1e-9) return [slice(all, null, 0)];
  const xs = (180 - west) / grid.lon_step_deg;
  const onNode = Math.abs(xs - Math.round(xs)) < 1e-9;
  const j0 = onNode ? Math.round(xs) : Math.floor(xs);
  const left = all.slice(0, j0 + 1);
  const right = all.slice(onNode ? j0 : j0 + 1);
  return [slice(left, onNode ? null : { at: xs, before: false }, 0), slice(right, onNode ? null : { at: xs, before: true }, -360)];
}

function toLonLat(part: Part, grid: MisfitField, [x, y]: [number, number]): Position {
  const j0 = Math.min(Math.max(Math.floor(x), 0), part.lons.length - 2);
  const f = x - j0;
  const lon = part.lons[j0]! + f * (part.lons[j0 + 1]! - part.lons[j0]!);
  const lat = Math.min(grid.bounds.north_deg, grid.bounds.south_deg + y * grid.lat_step_deg);
  return [lon, lat];
}

export interface LevelProperties {
  level: MisfitLevelName;
  /** `95 %` and so on. */
  label: string;
  delta_chi2: number;
  chi2: number;
  confidence: number;
}

export interface MisfitContours {
  /** Where the fit is within each level of the best point, outermost level first. */
  regions: FeatureCollection<MultiPolygon, LevelProperties>;
  /** Their boundaries without the grid's edges, outermost first. */
  lines: FeatureCollection<MultiLineString, LevelProperties>;
}

const ORDER: readonly MisfitLevelName[] = ['three_sigma', 'p95', 'one_sigma'];

/**
 * The regions and lines of `levels` (default: 95 % and 3 sigma; pass all three for the
 * 1-sigma line too), as GeoJSON in [-180, 180].
 */
export function misfitContours(
  grid: MisfitField & Pick<MisfitGrid, 'levels'>,
  levels: readonly MisfitLevelName[] = DEFAULT_LEVELS,
): MisfitContours {
  const regions: Feature<MultiPolygon, LevelProperties>[] = [];
  const lines: Feature<MultiLineString, LevelProperties>[] = [];
  const pieces = parts(grid);
  for (const name of ORDER) {
    if (!levels.includes(name)) continue;
    const level = grid.levels.find((l) => l.name === name);
    if (!level) continue;
    const properties: LevelProperties = {
      level: name,
      label: level.label,
      delta_chi2: level.delta_chi2,
      chi2: level.chi2,
      confidence: level.confidence,
    };
    const polys: Position[][][] = [];
    const strings: Position[][] = [];
    for (const part of pieces) {
      const rings = isoRings(part.field, level.chi2);
      const close = (ring: IsoRing): Position[] => {
        const pts = ring.points.map((p) => toLonLat(part, grid, p));
        return [...pts, pts[0]!];
      };
      for (const p of polygons(rings)) polys.push([close(p.outer), ...p.holes.map(close)]);
      for (const ring of rings) {
        for (const run of ringLines(ring)) strings.push(run.map((p) => toLonLat(part, grid, p)));
      }
    }
    regions.push({ type: 'Feature', properties, geometry: { type: 'MultiPolygon', coordinates: polys } });
    lines.push({ type: 'Feature', properties, geometry: { type: 'MultiLineString', coordinates: strings } });
  }
  return {
    regions: { type: 'FeatureCollection', features: regions },
    lines: { type: 'FeatureCollection', features: lines },
  };
}
