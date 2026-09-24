/**
 * Equirectangular projection for the local graticule plot, plus the clipping the plot
 * needs. No map SDK, no tiles: a plain SVG graticule (BRIEF "Interface").
 *
 * Aspect: one degree of latitude is drawn `scale` pixels; one degree of longitude is
 * drawn `scale * cos(lat0)` pixels, so a circle of position looks circular near the
 * centre of the view instead of being stretched east-west.
 *
 * Longitudes are unwrapped about the view centre, so a circle crossing the
 * antimeridian is split into separate polylines instead of drawing a line across the
 * whole plot.
 */

export interface Pt {
  lat_deg: number;
  lon_deg: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normalise a longitude difference into (-180, +180]. */
export function norm180(deg: number): number {
  let x = ((deg % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return x;
}

/** The representative of `lon` nearest `about`, so a view near +180 stays continuous. */
export function unwrapLon(lon: number, about: number): number {
  return about + norm180(lon - about);
}

export class Projection {
  readonly lat0: number;
  readonly lon0: number;
  /** Pixels per degree of latitude (y). */
  readonly scale: number;
  /** Pixels per degree of longitude (x) = scale * cos(lat0). */
  readonly scaleLon: number;
  readonly rect: Rect;

  constructor(lat0: number, lon0: number, scale: number, rect: Rect) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.scale = scale;
    // cos(lat0) floored so a polar view does not collapse the x axis to zero.
    this.scaleLon = scale * Math.max(Math.cos((lat0 * Math.PI) / 180), 0.01);
    this.rect = rect;
  }

  get cx(): number {
    return this.rect.x + this.rect.width / 2;
  }
  get cy(): number {
    return this.rect.y + this.rect.height / 2;
  }

  /** Latitude/longitude (east-positive degrees) to SVG pixels. y grows downward. */
  project(lat: number, lon: number): [number, number] {
    const dLon = unwrapLon(lon, this.lon0) - this.lon0;
    return [this.cx + dLon * this.scaleLon, this.cy - (lat - this.lat0) * this.scale];
  }

  projectPoint(p: Pt): [number, number] {
    return this.project(p.lat_deg, p.lon_deg);
  }

  unproject(x: number, y: number): Pt {
    return {
      lat_deg: this.lat0 - (y - this.cy) / this.scale,
      lon_deg: norm180(this.lon0 + (x - this.cx) / this.scaleLon),
    };
  }

  /** Visible range, in unwrapped degrees about (lat0, lon0). */
  bounds(): { latMin: number; latMax: number; lonMin: number; lonMax: number } {
    const halfLat = this.rect.height / 2 / this.scale;
    const halfLon = this.rect.width / 2 / this.scaleLon;
    return {
      latMin: this.lat0 - halfLat,
      latMax: this.lat0 + halfLat,
      lonMin: this.lon0 - halfLon,
      lonMax: this.lon0 + halfLon,
    };
  }
}

export interface FitOptions {
  /** Pixels of margin kept clear inside the rect. */
  padding?: number;
  /** Never zoom in further than this many degrees of latitude across the view. */
  minSpanDeg?: number;
  /** Never zoom out further than this. */
  maxSpanDeg?: number;
}

/**
 * Fit a projection so every point is inside `rect` with `padding` to spare.
 * With no points, or a single point, falls back to `minSpanDeg`.
 */
export function fitProjection(points: Pt[], rect: Rect, options: FitOptions = {}): Projection {
  const padding = options.padding ?? 24;
  const minSpan = options.minSpanDeg ?? 0.05;
  const maxSpan = options.maxSpanDeg ?? 340;

  if (points.length === 0) {
    return new Projection(0, 0, Math.max(rect.height - 2 * padding, 1) / minSpan, rect);
  }

  // Centre latitude first, then unwrap longitudes about the first point's longitude.
  const lats = points.map((p) => p.lat_deg);
  const latMin = Math.min(...lats);
  const latMax = Math.max(...lats);
  const lat0 = (latMin + latMax) / 2;

  const lonRef = points[0]!.lon_deg;
  const lons = points.map((p) => unwrapLon(p.lon_deg, lonRef));
  const lonMin = Math.min(...lons);
  const lonMax = Math.max(...lons);
  const lon0 = norm180((lonMin + lonMax) / 2);

  const usableW = Math.max(rect.width - 2 * padding, 1);
  const usableH = Math.max(rect.height - 2 * padding, 1);
  const cosLat = Math.max(Math.cos((lat0 * Math.PI) / 180), 0.01);

  const spanLat = Math.max(latMax - latMin, minSpan);
  const spanLon = Math.max(lonMax - lonMin, minSpan);

  // Pixels per degree of latitude that fits both axes.
  const scale = Math.min(usableH / spanLat, usableW / (spanLon * cosLat));
  const clamped = Math.min(Math.max(scale, usableH / maxSpan), usableH / minSpan);
  return new Projection(lat0, lon0, clamped, rect);
}

/** Round graticule steps, coarse to fine, in degrees. 1 deg is the brief's default. */
const GRATICULE_STEPS = [
  30, 20, 10, 5, 2, 1, 0.5, 0.25, 10 / 60, 5 / 60, 2 / 60, 1 / 60, 0.5 / 60,
];

/**
 * Largest step that still draws at least `minLines` grid lines across `spanDeg`.
 * 1 degree wins whenever the view is 2-10 degrees across, as the brief asks.
 */
export function graticuleStep(spanDeg: number, minLines = 3): number {
  for (const step of GRATICULE_STEPS) {
    if (spanDeg / step >= minLines) return step;
  }
  return GRATICULE_STEPS[GRATICULE_STEPS.length - 1]!;
}

/** Multiples of `step` inside [min, max], inclusive of touching endpoints. */
export function gridLines(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);
  // Guard against a degenerate step producing an unbounded loop.
  if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 2000) return out;
  for (let i = first; i <= last; i++) out.push(i * step);
  return out;
}

type XY = [number, number];

/** Liang-Barsky clip of one segment. Returns the clipped segment, or null. */
export function clipSegment(a: XY, b: XY, rect: Rect): [XY, XY] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - rect.x, rect.x + rect.width - a[0], a[1] - rect.y, rect.y + rect.height - a[1]];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return null; // Parallel to this edge and outside it.
    } else {
      const r = q[i]! / p[i]!;
      if (p[i]! < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/**
 * Clip a polyline to `rect`, returning the visible pieces. Consecutive segments that
 * stay inside are joined into one piece; a segment that leaves and re-enters starts a
 * new piece. Pieces shorter than two points are dropped.
 */
export function clipPolyline(points: XY[], rect: Rect): XY[][] {
  const pieces: XY[][] = [];
  let current: XY[] = [];
  const EPS = 1e-6;

  for (let i = 0; i + 1 < points.length; i++) {
    const seg = clipSegment(points[i]!, points[i + 1]!, rect);
    if (!seg) {
      if (current.length >= 2) pieces.push(current);
      current = [];
      continue;
    }
    const [s, e] = seg;
    if (current.length === 0) {
      current.push(s, e);
    } else {
      const last = current[current.length - 1]!;
      if (Math.abs(last[0] - s[0]) < EPS && Math.abs(last[1] - s[1]) < EPS) {
        current.push(e);
      } else {
        if (current.length >= 2) pieces.push(current);
        current = [s, e];
      }
    }
  }
  if (current.length >= 2) pieces.push(current);
  return pieces;
}

/**
 * Project a closed ring of lat/lon points, splitting wherever the unwrapped longitude
 * jumps more than `maxStepDeg` (the antimeridian, or a circle passing over a pole),
 * then clip each run to the rect.
 */
export function projectAndClipRing(
  ring: Pt[],
  projection: Projection,
  options: { closed?: boolean; maxStepDeg?: number } = {},
): XY[][] {
  const closed = options.closed ?? true;
  const maxStep = options.maxStepDeg ?? 180;
  if (ring.length < 2) return [];

  const ordered = closed ? [...ring, ring[0]!] : ring;
  const runs: XY[][] = [];
  let run: XY[] = [];
  let previousLon: number | null = null;

  for (const p of ordered) {
    const lon: number =
      previousLon === null
        ? unwrapLon(p.lon_deg, projection.lon0)
        : unwrapLon(p.lon_deg, previousLon);
    if (previousLon !== null && Math.abs(lon - previousLon) > maxStep) {
      if (run.length >= 2) runs.push(run);
      run = [];
    }
    run.push(projection.project(p.lat_deg, lon));
    previousLon = lon;
  }
  if (run.length >= 2) runs.push(run);

  return runs.flatMap((r) => clipPolyline(r, projection.rect));
}
