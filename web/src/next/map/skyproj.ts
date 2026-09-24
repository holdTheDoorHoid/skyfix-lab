/**
 * Geometry of the compass overlay drawn at the observer (the SunCalc-style "where is it in
 * my sky" dial). OWNER: map agent. Pure: no DOM; tested in web/test/next/map-compass.test.ts.
 *
 * Projection: the sky above the horizon is projected orthographically onto the horizon
 * plane and viewed from above, like the map under it: north up, east right, the horizon is
 * the ring of radius R and the zenith the centre. A body at altitude h and azimuth A is
 * drawn at distance R cos h from the centre in the direction A (clockwise from north).
 * Only positions come from the engine (apparent altitude and azimuth); this module only
 * places them on the screen (EXPLORER_PLAN 3.1).
 *
 * Screen coordinates are pixels relative to the centre, x right and y DOWN (SVG).
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export type XY = [number, number];

export interface AltAz {
  /** Apparent altitude, degrees. */
  alt: number;
  /** Azimuth, degrees clockwise from true north. */
  az: number;
}

/** A sampled path: parallel arrays of apparent altitude and azimuth. */
export interface SkyTrack {
  readonly alt: ArrayLike<number>;
  readonly az: ArrayLike<number>;
}

export function norm360(deg: number): number {
  const x = deg % 360;
  return x < 0 ? x + 360 : x === 360 ? 0 : x;
}

/** Where a direction in the sky is drawn: `R cos(alt)` from the centre (altitude clamped to 0..90). */
export function skyXY(altDeg: number, azDeg: number, R: number): XY {
  const h = Math.max(0, Math.min(90, altDeg)) * RAD;
  const r = R * Math.cos(h);
  const a = azDeg * RAD;
  return [r * Math.sin(a), -r * Math.cos(a)];
}

/** The point on the horizon ring (or any circle of radius `R`) at azimuth `azDeg`. */
export function ringXY(azDeg: number, R: number): XY {
  const a = azDeg * RAD;
  return [R * Math.sin(a), -R * Math.cos(a)];
}

/** Interpolate an azimuth the short way round, result in [0, 360). */
export function lerpAz(a0: number, a1: number, f: number): number {
  let d = norm360(a1) - norm360(a0);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return norm360(a0 + f * d);
}

function lowestIndex(alt: ArrayLike<number>): number {
  let k = 0;
  for (let i = 1; i < alt.length; i++) if (alt[i]! < alt[k]!) k = i;
  return k;
}

/**
 * The parts of a sampled path above the horizon, in time order, each starting or ending at
 * an interpolated horizon crossing (altitude exactly 0) where the path rises or sets inside
 * the samples. With `cyclic` the samples are one full turn of a closed diurnal path (the
 * Sun over a day): they are read starting from the lowest one, so the part above the horizon
 * comes out in one piece even when the day starts with the Sun up.
 */
export function aboveHorizonRuns(track: SkyTrack, cyclic = false): AltAz[][] {
  const n = Math.min(track.alt.length, track.az.length);
  if (n === 0) return [];
  const order: number[] = [];
  if (cyclic) {
    const k = lowestIndex(track.alt);
    for (let i = 0; i <= n; i++) order.push((k + i) % n);
  } else {
    for (let i = 0; i < n; i++) order.push(i);
  }
  const runs: AltAz[][] = [];
  let run: AltAz[] | null = null;
  for (let j = 0; j < order.length; j++) {
    const i = order[j]!;
    const alt = track.alt[i]!;
    const az = norm360(track.az[i]!);
    if (j > 0) {
      const p = order[j - 1]!;
      const altPrev = track.alt[p]!;
      if (altPrev < 0 !== alt < 0) {
        const f = altPrev / (altPrev - alt);
        const cross: AltAz = { alt: 0, az: lerpAz(track.az[p]!, az, f) };
        if (alt >= 0) run = [cross];
        else if (run) {
          run.push(cross);
          runs.push(run);
          run = null;
        }
      }
    } else if (alt >= 0) {
      run = [];
    }
    if (alt >= 0) run?.push({ alt, az });
  }
  if (run && run.length > 1) runs.push(run);
  return runs;
}

/**
 * Horizon points from `fromAz` to `toAz` along the arc that passes through north
 * (azimuth 0): the direction of the horizon where declinations are highest. Between the
 * ends the points sit on whole multiples of `stepDeg`, so two arcs over the same stretch of
 * horizon share their vertices and cancel exactly in an even-odd fill.
 */
export function arcThroughNorth(fromAz: number, toAz: number, stepDeg = 3): AltAz[] {
  const a = norm360(fromAz);
  const b = norm360(toAz);
  // Increasing azimuth from a reaches b after wrapping through 360 when b < a.
  const increasing = b < a || (a === 0 && b === 0);
  const span = increasing ? norm360(b - a) || 360 : norm360(a - b) || 360;
  const out: AltAz[] = [{ alt: 0, az: a }];
  if (increasing) {
    for (let t = Math.floor(a / stepDeg + 1e-9) * stepDeg + stepDeg; t < a + span - 1e-9; t += stepDeg) {
      out.push({ alt: 0, az: norm360(t) });
    }
  } else {
    for (let t = Math.ceil(a / stepDeg - 1e-9) * stepDeg - stepDeg; t > a - span + 1e-9; t -= stepDeg) {
      out.push({ alt: 0, az: norm360(t) });
    }
  }
  out.push({ alt: 0, az: b });
  return out;
}

/** A region of the sky above the horizon for even-odd filling: closed rings plus full discs. */
export interface SkyRegion {
  rings: AltAz[][];
  /** How many copies of the whole horizon disc to add (even-odd: only parity matters). */
  discs: number;
}

/**
 * The part of the sky above the horizon at declination `>= d`, where `track` is one day's
 * samples of a body whose declination is (close to) `d` all day: the Sun on a solstice.
 *
 * On the horizon declination is highest due north (sin dec = cos(lat) cos(azimuth)), so
 * the region is bounded by the path above the horizon and the horizon arc through north.
 * A path that never sets encloses the region (it circles the north celestial pole) or
 * leaves it outside (it circles the south one); a path that never rises leaves the whole
 * visible sky in the region, or none of it.
 */
export function declinationRegion(track: SkyTrack, latDeg: number): SkyRegion {
  const n = Math.min(track.alt.length, track.az.length);
  if (n < 3) return { rings: [], discs: 0 };
  let above = 0;
  for (let i = 0; i < n; i++) if (track.alt[i]! >= 0) above++;
  if (above === 0) return { rings: [], discs: latDeg > 0 ? 1 : 0 };
  if (above === n) {
    const loop: AltAz[] = [];
    for (let i = 0; i < n; i++) loop.push({ alt: track.alt[i]!, az: norm360(track.az[i]!) });
    return { rings: [loop], discs: latDeg > 0 ? 0 : 1 };
  }
  const rings = aboveHorizonRuns(track, true).map((run) => {
    const first = run[0]!;
    const last = run[run.length - 1]!;
    return [...run, ...arcThroughNorth(last.az, first.az).slice(1, -1)];
  });
  return { rings, discs: 0 };
}

/**
 * The band the Sun sweeps over the year: between its June- and December-solstice paths
 * (declinations +23.4 and -23.4 degrees). The December region (declination >= -23.4)
 * contains the June one, so their even-odd combination is exactly the band.
 */
export function solsticeBand(june: SkyTrack, december: SkyTrack, latDeg: number): SkyRegion {
  const a = declinationRegion(december, latDeg);
  const b = declinationRegion(june, latDeg);
  return { rings: [...a.rings, ...b.rings], discs: (a.discs + b.discs) % 2 };
}

function fmt(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}

/** SVG path data for a list of points (open unless `close`). */
export function pathData(points: readonly XY[], close = false): string {
  if (!points.length) return '';
  let d = `M${fmt(points[0]![0])} ${fmt(points[0]![1])}`;
  for (let i = 1; i < points.length; i++) d += `L${fmt(points[i]![0])} ${fmt(points[i]![1])}`;
  return close ? `${d}Z` : d;
}

/** A full circle of radius `r` as SVG path data. */
export function circlePath(r: number): string {
  return `M${fmt(r)} 0A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(-r)} 0A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(r)} 0Z`;
}

/** Even-odd SVG path data for a region (use `fill-rule: evenodd`). */
export function regionPath(region: SkyRegion, R: number): string {
  let d = region.discs % 2 ? circlePath(R) : '';
  for (const ring of region.rings) d += pathData(ring.map((p) => skyXY(p.alt, p.az, R)), true);
  return d;
}

/** Even-odd point test against a region, in screen coordinates (tests, hit testing). */
export function regionContains(region: SkyRegion, R: number, p: XY): boolean {
  let inside = region.discs % 2 === 1 && Math.hypot(p[0], p[1]) < R;
  for (const ring of region.rings) {
    const pts = ring.map((q) => skyXY(q.alt, q.az, R));
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]!;
      const b = pts[j]!;
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}

/**
 * Direction of the Moon's bright limb on the compass, for a glyph drawn at (alt, az).
 *
 * The engine gives the bright limb's position angle from the zenith, `limbFromZenithDeg`
 * (= bright_limb_angle - parallactic_angle, EXPLORER_API), measured on the sky as the
 * observer sees it: from "up" towards decreasing azimuth. A small step on the sky in that
 * direction moves the drawn point by (-sin h * up) outward and (-left) clockwise, because
 * the dial is the sky seen from above (mirrored) and foreshortened near the horizon.
 * Returns the screen angle in radians (from +x towards +y, y down).
 */
export function brightLimbScreenAngle(altDeg: number, azDeg: number, limbFromZenithDeg: number): number {
  const psi = limbFromZenithDeg * RAD;
  const up = Math.cos(psi);
  const left = Math.sin(psi);
  const h = Math.max(0, Math.min(90, altDeg)) * RAD;
  const a = azDeg * RAD;
  const outward: XY = [Math.sin(a), -Math.cos(a)];
  const clockwise: XY = [Math.cos(a), Math.sin(a)];
  let x = -Math.sin(h) * up * outward[0] - left * clockwise[0];
  let y = -Math.sin(h) * up * outward[1] - left * clockwise[1];
  if (Math.hypot(x, y) < 1e-6) {
    // Lit side straight up at the horizon: towards the centre.
    x = -outward[0];
    y = -outward[1];
  }
  return Math.atan2(y, x);
}

/**
 * The lit part of a phase disc of radius `r` with illuminated fraction `k`, bright limb
 * towards +x, as SVG path data; '' at new moon. The terminator is the half-ellipse with
 * semi-axis r |1 - 2k| across the disc.
 */
export function moonLitPath(k: number, r: number): string {
  const f = Math.max(0, Math.min(1, k));
  if (f < 0.005) return '';
  if (f > 0.995) return circlePath(r);
  const e = r * Math.abs(1 - 2 * f);
  const sweep = f < 0.5 ? 0 : 1;
  return `M0 ${fmt(-r)}A${fmt(r)} ${fmt(r)} 0 0 1 0 ${fmt(r)}A${fmt(e)} ${fmt(r)} 0 0 ${sweep} 0 ${fmt(-r)}Z`;
}

/**
 * Where a label goes just outside the ring at screen azimuth `azDeg` (clockwise from up):
 * its anchor point, and the CSS translation that keeps the label's box outside the ring
 * (to the right on the east side, above at the north, centred where it is neither).
 */
export function labelPlacement(azDeg: number, R: number, gap = 12): { x: number; y: number; tx: '0%' | '-50%' | '-100%'; ty: '0%' | '-50%' | '-100%' } {
  const [x, y] = ringXY(azDeg, R + gap);
  const s = Math.sin(azDeg * RAD);
  const c = -Math.cos(azDeg * RAD);
  return { x, y, tx: s > 0.3 ? '0%' : s < -0.3 ? '-100%' : '-50%', ty: c > 0.3 ? '0%' : c < -0.3 ? '-100%' : '-50%' };
}

/** Below this width the dial is compact: times without words, no place label (phones). */
export const COMPACT_WIDTH = 640;

/**
 * The dial's radius: about 38 % of the smaller side of the view, within [min, max] pixels.
 * The cap keeps it the size of the approved design (docs/design/map-light.png) on a desktop;
 * on a narrow screen it leaves room beside the ring for the rise and set times.
 */
export function compassRadius(width: number, height: number, max = 150, min = 64): number {
  let r = 0.38 * Math.min(width, height);
  if (width < COMPACT_WIDTH) r = Math.min(r, 0.23 * width);
  return Math.max(min, Math.min(max, r));
}

/** Degrees between the screen's up and a direction given as a screen vector (for rotating the dial). */
export function screenBearing(dx: number, dy: number): number {
  return norm360(Math.atan2(dx, -dy) * DEG);
}
