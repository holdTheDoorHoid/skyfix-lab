// Build-time geometry helpers for tools/mapdata/build.mjs. Development-time only: nothing
// here ships to the browser. Coordinates are GeoJSON [lon, lat] in degrees, longitude
// east-positive (CONVENTIONS section 2).
//
// Antimeridian rules applied by the build (RFC 7946 section 3.1.9 and what MapLibre needs):
//   - every longitude lies in [-180, 180]; Natural Earth has a few vertices at -180.000015
//     and seam vertices at 179.999219 / -179.999951, which are clamped or snapped to +/-180;
//   - no segment of any output spans more than 180 degrees of longitude (a segment like that
//     would be drawn the long way round the world);
//   - polygons stay split at the antimeridian, as Natural Earth ships them, so fills meet
//     exactly on the +/-180 meridian; the artificial edges along the seam (and along the
//     South Pole, which closes Antarctica) are removed from the derived coastline lines, so a
//     stroked coast never shows a vertical line at 180 degrees.

/** Round to `d` decimals, never returning negative zero. */
export function round(v, d) {
  const f = 10 ** d;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

/** A vertex that lies on the antimeridian seam, after rounding. */
export const SEAM_LON = 179.999;
export const POLE_LAT = 89.99;

export function isSeamLon(x) {
  return Math.abs(x) >= SEAM_LON;
}

/** Clamp to [-180, 180] / [-90, 90] and snap seam vertices to exactly +/-180. */
export function cleanVertex([x, y], decimals) {
  let lon = Math.max(-180, Math.min(180, x));
  let lat = Math.max(-90, Math.min(90, y));
  lon = round(lon, decimals);
  lat = round(lat, decimals);
  if (lon >= SEAM_LON) lon = 180;
  if (lon <= -SEAM_LON) lon = -180;
  return [lon, lat];
}

function sameXY(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

/** Drop consecutive duplicate vertices. */
export function dedupe(points) {
  const out = [];
  for (const p of points) if (out.length === 0 || !sameXY(out[out.length - 1], p)) out.push(p);
  return out;
}

/**
 * Douglas-Peucker on an open polyline. Distances are measured in degrees with longitude
 * scaled by cos(latitude) of the chord, so the tolerance is roughly uniform on the ground
 * (0.01 deg ~ 1.1 km). `locked[i]` forces a vertex to be kept.
 */
export function simplifyOpen(points, tol, locked) {
  const n = points.length;
  if (n <= 2 || tol <= 0) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  // Split at locked vertices first: each piece is simplified between fixed ends.
  const anchors = [0];
  if (locked) for (let i = 1; i < n - 1; i++) if (locked[i]) anchors.push(i);
  anchors.push(n - 1);
  const t2 = tol * tol;
  const stack = [];
  for (let k = 1; k < anchors.length; k++) stack.push([anchors[k - 1], anchors[k]]);
  for (const a of anchors) keep[a] = 1;
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const k = Math.cos(((points[a][1] + points[b][1]) / 2) * (Math.PI / 180));
    const ax = points[a][0] * k;
    const ay = points[a][1];
    const bx = points[b][0] * k;
    const by = points[b][1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = points[i][0] * k;
      const py = points[i][1];
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > t2) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Simplify a closed ring (first vertex == last). The ring is split at its first vertex and at
 * the vertex farthest from it so the result does not depend on a single long chord, and at
 * every locked vertex. Returns null when fewer than four vertices would remain.
 */
export function simplifyRing(ring, tol, isLocked) {
  const open = ring.slice(0, -1);
  if (open.length < 3) return null;
  let far = 1;
  let farD = -1;
  for (let i = 1; i < open.length; i++) {
    const d = (open[i][0] - open[0][0]) ** 2 + (open[i][1] - open[0][1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const closed = open.concat([open[0]]);
  const locked = new Uint8Array(closed.length);
  locked[far] = 1;
  if (isLocked) for (let i = 0; i < closed.length; i++) if (isLocked(closed[i], i)) locked[i] = 1;
  const out = simplifyOpen(closed, tol, locked);
  return out.length >= 4 ? out : null;
}

/** Signed area of a ring in the lon/lat plane (positive = counter-clockwise). */
export function signedArea(ring) {
  let s = 0;
  for (let i = 1; i < ring.length; i++) {
    s += (ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1]);
  }
  return s / 2;
}

/** RFC 7946 winding: exterior rings counter-clockwise, holes clockwise. */
export function rewindPolygon(rings) {
  return rings.map((r, i) => {
    const ccw = signedArea(r) > 0;
    const wantCcw = i === 0;
    return ccw === wantCcw ? r : r.slice().reverse();
  });
}

/** Polygon or MultiPolygon geometry -> array of polygons (each an array of rings). */
export function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  throw new Error(`expected a polygon, got ${geometry.type}`);
}

/** LineString or MultiLineString geometry -> array of lines. */
export function linesOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  throw new Error(`expected a line, got ${geometry.type}`);
}

export function polygonGeometry(polys) {
  if (polys.length === 1) return { type: 'Polygon', coordinates: polys[0] };
  return { type: 'MultiPolygon', coordinates: polys };
}

export function lineGeometry(lines) {
  if (lines.length === 1) return { type: 'LineString', coordinates: lines[0] };
  return { type: 'MultiLineString', coordinates: lines };
}

/**
 * Split a line wherever consecutive vertices are more than 180 degrees of longitude apart
 * (it crossed the antimeridian without a vertex on it). The crossing latitude is
 * interpolated and both pieces end exactly on the seam.
 */
export function splitAtAntimeridian(line) {
  const out = [];
  let cur = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    if (Math.abs(x1 - x0) > 180) {
      const x1u = x1 > x0 ? x1 - 360 : x1 + 360; // x1 unwrapped next to x0
      const seam = x0 > 0 ? 180 : -180;
      const t = (seam - x0) / (x1u - x0);
      const yc = y0 + t * (y1 - y0);
      cur.push([seam, yc]);
      out.push(cur);
      cur = [[-seam, yc], line[i]];
    } else {
      cur.push(line[i]);
    }
  }
  out.push(cur);
  return out.filter((l) => l.length >= 2);
}

/** Longest |delta lon| between consecutive vertices anywhere in a geometry. */
export function maxLonStep(geometry) {
  let worst = 0;
  const visitLine = (l) => {
    for (let i = 1; i < l.length; i++) worst = Math.max(worst, Math.abs(l[i][0] - l[i - 1][0]));
  };
  switch (geometry.type) {
    case 'Point':
      break;
    case 'LineString':
      visitLine(geometry.coordinates);
      break;
    case 'MultiLineString':
    case 'Polygon':
      geometry.coordinates.forEach(visitLine);
      break;
    case 'MultiPolygon':
      geometry.coordinates.forEach((p) => p.forEach(visitLine));
      break;
    default:
      throw new Error(`unexpected geometry ${geometry.type}`);
  }
  return worst;
}

/**
 * Replace any polygon edge that runs along the pole (both ends at |lat| >= 89.99) and spans
 * more than `step` degrees of longitude by intermediate vertices. Natural Earth's 110m
 * Antarctica closes with a single edge from (180, -90) to (-180, -90); split into steps it
 * keeps every segment under 180 degrees.
 */
export function densifyPolarEdges(ring, step = 1.40625) {
  const out = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const [x0, y0] = ring[i - 1];
    const [x1, y1] = ring[i];
    if (Math.abs(y0) >= POLE_LAT && Math.abs(y1) >= POLE_LAT && Math.abs(x1 - x0) > step) {
      const n = Math.ceil(Math.abs(x1 - x0) / step);
      for (let k = 1; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
    }
    out.push(ring[i]);
  }
  return out;
}

/**
 * Coastline from a land polygon ring: the ring minus its artificial edges (runs along the
 * +/-180 seam, and runs along the South Pole). Returns open polylines.
 */
export function coastFromRing(ring) {
  const artificial = (a, b) =>
    (isSeamLon(a[0]) && isSeamLon(b[0]) && Math.sign(a[0]) === Math.sign(b[0])) ||
    (Math.abs(a[1]) >= POLE_LAT && Math.abs(b[1]) >= POLE_LAT);
  const n = ring.length - 1; // closed ring: ring[n] == ring[0]
  // Start just after an artificial edge so that no real run is split across the ring's start.
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (artificial(ring[i], ring[i + 1])) {
      start = (i + 1) % n;
      break;
    }
  }
  if (start < 0) return [ring.slice()]; // no artificial edges: the whole ring is coast
  const lines = [];
  let cur = [ring[start]];
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const a = ring[i];
    const b = ring[i + 1]; // i <= n - 1 and the ring is closed, so ring[i + 1] exists
    if (artificial(a, b)) {
      if (cur.length >= 2) lines.push(cur);
      cur = [b];
    } else {
      cur.push(b);
    }
  }
  if (cur.length >= 2) lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------------------------------
// Point in polygon and distances (for build-time joins; the browser has its own copy in
// web/src/next/geo/regions.ts)

export function bboxOfRings(rings) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rings)
    for (const [x, y] of r) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  return [minX, minY, maxX, maxY];
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x, y, rings) {
  if (!pointInRing(x, y, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) if (pointInRing(x, y, rings[h])) return false;
  return true;
}

const KM_PER_DEG = 111.195; // mean-sphere degree, only for the build's coarse joins

/** Distance in km from (lat, lon) to segment a-b, local equirectangular approximation. */
export function segmentDistanceKm(lat, lon, a, b) {
  const k = Math.cos((lat * Math.PI) / 180);
  let ax = a[0] - lon;
  let bx = b[0] - lon;
  if (ax > 180) ax -= 360;
  if (ax < -180) ax += 360;
  if (bx > 180) bx -= 360;
  if (bx < -180) bx += 360;
  ax *= k;
  bx *= k;
  const ay = a[1] - lat;
  const by = b[1] - lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + t * dx, ay + t * dy) * KM_PER_DEG;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const s =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Index of polygon parts for "which polygon contains this point, or which is within
 * `marginKm` of it". `items` is [{ key, polygons }]. Returns { key, distanceKm } or null.
 */
export function makeLocator(items) {
  const parts = [];
  for (const it of items)
    for (const rings of it.polygons) parts.push({ key: it.key, rings, bbox: bboxOfRings([rings[0]]) });
  return function locate(lat, lon, marginKm = 0, filter = null) {
    for (const p of parts) {
      if (filter && !filter(p.key)) continue;
      const [a, b, c, d] = p.bbox;
      if (lon < a || lon > c || lat < b || lat > d) continue;
      if (pointInPolygon(lon, lat, p.rings)) return { key: p.key, distanceKm: 0 };
    }
    if (!(marginKm > 0)) return null;
    const mLat = marginKm / KM_PER_DEG;
    const mLon = mLat / Math.max(0.01, Math.cos((Math.min(89, Math.abs(lat)) * Math.PI) / 180));
    let best = null;
    let bestD = marginKm;
    for (const p of parts) {
      if (filter && !filter(p.key)) continue;
      const [a, b, c, d] = p.bbox;
      if (lat < b - mLat || lat > d + mLat) continue;
      if (lon < a - mLon || lon > c + mLon) continue;
      for (const r of p.rings)
        for (let i = 1; i < r.length; i++) {
          const e = segmentDistanceKm(lat, lon, r[i - 1], r[i]);
          if (e < bestD) {
            bestD = e;
            best = p.key;
          }
        }
    }
    return best === null ? null : { key: best, distanceKm: bestD };
  };
}

// ---------------------------------------------------------------------------------------
// Pole of inaccessibility (label point) — an independent implementation of the published
// quadtree search (Agafonkin 2016, "A new algorithm for finding a visual center of a
// polygon"): cells are refined best-first by an upper bound on the distance any point in
// the cell can have from the boundary.

function ringsDistance(x, y, rings) {
  let inside = false;
  let minD2 = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i];
      const b = r[j];
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = a[0] + t * dx - x;
      const ey = a[1] + t * dy - y;
      const d2 = ex * ex + ey * ey;
      if (d2 < minD2) minD2 = d2;
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minD2);
}

/**
 * Label point of a polygon given as rings in a projected plane. `extraLimit(x, y)` returns
 * an additional signed distance the point must respect (for example a latitude band);
 * the search maximises min(boundary distance, extraLimit).
 */
export function poleOfInaccessibility(rings, precision, extraLimit = () => Infinity) {
  const [minX, minY, maxX, maxY] = bboxOfRings([rings[0]]);
  const w = maxX - minX;
  const h = maxY - minY;
  const size = Math.min(w, h);
  if (size === 0) return [minX, minY];
  const dist = (x, y) => Math.min(ringsDistance(x, y, rings), extraLimit(x, y));
  const heap = [];
  const push = (c) => {
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].max >= heap[i].max) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].max > heap[m].max) m = l;
        if (r < heap.length && heap[r].max > heap[m].max) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const cell = (x, y, half) => {
    const d = dist(x, y);
    return { x, y, half, d, max: d + half * Math.SQRT2 };
  };
  const half0 = size / 2;
  for (let x = minX; x < maxX; x += size) for (let y = minY; y < maxY; y += size) push(cell(x + half0, y + half0, half0));
  let best = cell(minX + w / 2, minY + h / 2, 0);
  let guard = 0;
  while (heap.length && guard++ < 200000) {
    const c = pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const hh = c.half / 2;
    push(cell(c.x - hh, c.y - hh, hh));
    push(cell(c.x + hh, c.y - hh, hh));
    push(cell(c.x - hh, c.y + hh, hh));
    push(cell(c.x + hh, c.y + hh, hh));
  }
  return [best.x, best.y, best.d];
}
