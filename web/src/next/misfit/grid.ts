/**
 * Reading a misfit grid (EXPLORER_API "Misfit grid"): node positions without the
 * antimeridian jump, the levels by name, and the value anywhere inside by bilinear
 * interpolation. OWNER: misfit agent. Pure functions.
 */

import type { LatLonDeg, MisfitGrid, MisfitLevel, MisfitLevelName } from '../engine/types.js';

/**
 * What drawing and contouring need of a grid. A real `MisfitGrid` is one; tests build
 * synthetic ones.
 */
export type MisfitField = Pick<MisfitGrid, 'bounds' | 'n_lat' | 'n_lon' | 'lat_step_deg' | 'lon_step_deg' | 'chi2'>;

/** Latitude of row `i` (may be fractional). */
export function rowLat(f: MisfitField, i: number): number {
  return i >= f.n_lat - 1 ? f.bounds.north_deg - (f.n_lat - 1 - i) * f.lat_step_deg : f.bounds.south_deg + i * f.lat_step_deg;
}

/** Longitude of column `j` (may be fractional), without the jump: from `west_deg` eastward. */
export function columnLon(f: MisfitField, j: number): number {
  return f.bounds.west_deg + j * f.lon_step_deg;
}

/** `lon` in (-180, 180]. */
export function wrap180(lon: number): number {
  const x = (((lon % 360) + 360) % 360);
  return x > 180 ? x - 360 : x;
}

/** Fractional (row, column) of a position, or null outside the grid. */
export function gridIndex(f: MisfitField, p: LatLonDeg): [number, number] | null {
  const i = (p.lat_deg - f.bounds.south_deg) / f.lat_step_deg;
  const span = f.bounds.east_deg - f.bounds.west_deg;
  let east = (((p.lon_deg - f.bounds.west_deg) % 360) + 360) % 360;
  // A full circle's last column is its first; anything within rounding of it is inside.
  if (east > span + 1e-9 && east > 360 - 1e-9) east -= 360;
  const j = east / f.lon_step_deg;
  const eps = 1e-9;
  if (!(i >= -eps && i <= f.n_lat - 1 + eps && j >= -eps && j <= f.n_lon - 1 + eps)) return null;
  return [Math.min(Math.max(i, 0), f.n_lat - 1), Math.min(Math.max(j, 0), f.n_lon - 1)];
}

/** Bilinear interpolation of chi2 at `p`; NaN outside the grid. */
export function sampleMisfit(f: MisfitField, p: LatLonDeg): number {
  const at = gridIndex(f, p);
  if (!at) return Number.NaN;
  return sampleAt(f, at[0], at[1]);
}

/** Bilinear interpolation at fractional (row, column), both inside the grid. */
export function sampleAt(f: MisfitField, i: number, j: number): number {
  const i0 = Math.min(Math.floor(i), f.n_lat - 2);
  const j0 = Math.min(Math.floor(j), f.n_lon - 2);
  const di = i - i0;
  const dj = j - j0;
  const v = f.chi2;
  const n = f.n_lon;
  const a = v[i0 * n + j0]!;
  const b = v[i0 * n + j0 + 1]!;
  const c = v[(i0 + 1) * n + j0]!;
  const d = v[(i0 + 1) * n + j0 + 1]!;
  return (1 - di) * ((1 - dj) * a + dj * b) + di * ((1 - dj) * c + dj * d);
}

/** A level by name (the grid always carries all three). */
export function levelOf(grid: Pick<MisfitGrid, 'levels'>, name: MisfitLevelName): MisfitLevel {
  const level = grid.levels.find((l) => l.name === name);
  if (!level) throw new Error(`the grid has no level ${name}`);
  return level;
}

/** The levels the map draws by default: the 95 % line inside the 3-sigma line. */
export const DEFAULT_LEVELS: readonly MisfitLevelName[] = ['p95', 'three_sigma'];
