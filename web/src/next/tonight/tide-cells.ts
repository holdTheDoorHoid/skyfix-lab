/**
 * Whether a place might have a NOAA tide station within 100 nautical miles, without the
 * `tides-us` pack: the Tonight view offers the pack only there. OWNER: tonight agent
 * (expansion programme Q2).
 *
 * The table is the one-degree cells (latitude and longitude rounded down) that hold at least
 * one station of the committed pack, written by `dev/tide-cells.mjs` from the pack's own
 * station list (NOAA CO-OPS, U.S. public domain; docs/THIRD_PARTY.md) and checked against
 * it by test/next/tonight-tides.test.ts. A place "may have a station" when some such cell
 * comes within the radius of it — measured to the nearest point of the cell, so the test
 * never misses a station (it can offer the pack up to a cell's width too generously; once
 * the pack is loaded, the stations themselves decide).
 */

// generated: begin (dev/tide-cells.mjs from tides-us-8fd019a61b7290b2.bin, NOAA data of 2026-09-25: 3499 stations, 485 cells)
export const TIDE_CELLS = 'go2,kx,z,12w,f,iv,g,ja,b,9k,9,1,1,k,j,43,4s,1,2,1,s,94,1,9z,ab,1,m,9b,1,8,ty,4,9q,l,b,9i,h,fx,zr,7h,2j,1,56,4j,a,9p,1,1,9,6y,5,9,2f,7b,t,26,4e,2m,as,98,9w,t,24,6o,g,9j,j,2z,2,1,5x,a,5,2,h,3,2x,1,3,1,1,5z,c,2,1,f,4,2w,1,1,3,6t,2,2,1,2w,2,71,2x,6z,1,1,2x,1,3,72,2r,1,2,r,5p,3g,8,n,5q,n,2n,8,1,4,m,5r,19,1y,4,7,2,1,o,99,5,7,9,1,1,1,2,1,8m,g,1,2,e,1,5,3,2,1,1,1,5u,1n,1f,8,f,4,2,4,1,1,6k,11,1,1e,s,2,1,1,7l,1,1,1,1,1n,8,5,2,3,2,1,5,7k,1q,e,3,1,1,3,1,2,7e,1o,o,1,1,6,8y,2,s,1,1,3,1,1,1,7b,1q,c,g,1,1,2,1,9f,f,1,1,1,1,2,92,d,f,2,7b,1p,j,1,1,4,2,7,2,9l,1,1,1,1,1,1,4,1,1,1,1,1,9n,3,1,1,1,1,1,1,1,2,91,3,w,1,8z,10,1,1,f,8h,1,1,12,1,1,8t,1,1,15,1,8r,1,18,1,8p,1,19,1,8p,1,18,1,1,8o,1,1,18,1,1,1,8n,1b,1,1,8m,1d,1,1,1,8k,1e,1,1,1,1,1,2,8f,1f,2,1,8i,1i,1,1,8g,1,1i,1,1,1,8e,1,1,1j,8f,1,1,9y,1,1,9y,1,1,sg,1,1,1,9t,2,5,1,2,1,1,1,1,9h,1,1,h,1,1,a0,1,1,1,1,3,r,1,1,93,1,1,1,1,1,3,l,1,1,1,1,1,8w,b,1,1,2,1,i,1,1,1,1,8x,d,1,1,1,1,1,g,1,1,1,98,1,1,1,1,1,2,1,1,1,e,1,1,1,1,95,2,1,3,2,2,1,2,1,1,1,1,1,5,2,4,8z,6,1,1,2,1,9,1,2,1,1,1,1,1,3,9b,1,e,1,1,2,1,9i,9t,1,2,5,1,2,9v,2,2,9u,1,1,4,9v,2,1,1,9y,1,9x,k6,7,1,4,2,1,2,9n';
export const TIDE_CELLS_FROM = 'tides-us-8fd019a61b7290b2.bin';
// generated: end

/** The radius the Tonight view looks for a station in, nautical miles (the brief). */
export const TIDE_RADIUS_NM = 100;

/** The tides engine's sphere (EXPLORER_API "tide_stations_near"), km, and the nautical mile. */
const EARTH_KM = 6371.0088;
const NM_KM = 1.852;
const RAD = Math.PI / 180;

let decoded: Int32Array | null = null;

/** The cell numbers `(floor(lat) + 90) * 360 + (floor(lon) + 180)`, sorted. */
export function tideCells(text: string = TIDE_CELLS): Int32Array {
  if (text === TIDE_CELLS && decoded) return decoded;
  const parts = text ? text.split(',') : [];
  const out = new Int32Array(parts.length);
  let at = 0;
  parts.forEach((p, i) => {
    at += parseInt(p, 36);
    out[i] = at;
  });
  if (text === TIDE_CELLS) decoded = out;
  return out;
}

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dlat = (lat2 - lat1) * RAD;
  const dlon = (lon2 - lon1) * RAD;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dlon / 2) ** 2;
  return (2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)))) / NM_KM;
}

/** Signed longitude difference `lon − ref` in (−180, 180]. */
function dlonDeg(lon: number, ref: number): number {
  const d = (((lon - ref) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/**
 * The great-circle distance from a place to the nearest point of the one-degree cell `cell`,
 * nautical miles (exact on the sphere: inside the cell's longitudes the nearest point is on
 * the same meridian; outside, it is on the nearer bounding meridian, at the foot of the
 * perpendicular from the place, kept within the cell's latitudes).
 */
export function cellDistanceNm(latDeg: number, lonDeg: number, cell: number): number {
  const lat0 = Math.floor(cell / 360) - 90;
  const lon0 = (cell % 360) - 180;
  const clampLat = (x: number): number => Math.max(lat0, Math.min(lat0 + 1, x));
  const east = dlonDeg(lonDeg, lon0);
  if (east >= 0 && east <= 1) return (Math.abs(latDeg - clampLat(latDeg)) * RAD * EARTH_KM) / NM_KM;
  // The nearer of the two bounding meridians.
  const toWest = Math.abs(east);
  const toEast = Math.abs(dlonDeg(lonDeg, lon0 + 1));
  const edge = toWest <= toEast ? lon0 : lon0 + 1;
  const d = dlonDeg(lonDeg, edge);
  if (Math.abs(d) >= 90) return Infinity;
  const foot = Math.atan(Math.tan(latDeg * RAD) / Math.cos(d * RAD)) / RAD;
  return haversineNm(latDeg, lonDeg, clampLat(foot), edge);
}

/** True when a place may have a tide station within `radiusNm` (the committed pack's stations). */
export function mayHaveTideStation(latDeg: number, lonDeg: number, radiusNm: number = TIDE_RADIUS_NM, cells: Int32Array = tideCells()): boolean {
  for (const cell of cells) {
    // A cheap latitude gate first: a degree of latitude is 60 NM.
    const lat0 = Math.floor(cell / 360) - 90;
    if (latDeg < lat0 - radiusNm / 60 - 0.01 || latDeg > lat0 + 1 + radiusNm / 60 + 0.01) continue;
    if (cellDistanceNm(latDeg, lonDeg, cell) <= radiusNm) return true;
  }
  return false;
}
