/**
 * The Sky view's per-frame geometry: engine results turned into apparent altitude and
 * azimuth for every star, boundary point, label and reference circle, then into screen
 * positions. OWNER: sky agent.
 *
 * Engine use (EXPLORER_API; budget EXPLORER_PLAN §3.7):
 * - `starfieldCatalog()` and `constellationBoundaries()` once;
 * - `starfieldApparent(jd)` and `starfieldFrameMatrix(jd)` at most once per simulated
 *   hour (the time is rounded to the hour, so the memoised engine returns the same
 *   array all hour; while playing faster than a day per second, to the day — the stars'
 *   apparent places move by well under an arcsecond in half a day);
 * - `sidereal(jd)` every frame.
 * Everything else is `astro.ts`: rotation into the horizon and display refraction.
 * Buffers are allocated when the catalogue arrives and reused every frame.
 */

import type { ConstellationBoundary, ExplorerEngine, Observer, StarfieldCatalog } from '../engine/types.js';
import {
  azimuthOf,
  DEG,
  greatCircleUnits,
  horizonBuffers,
  horizonDirections,
  horizonMatrix,
  IDENTITY3,
  localSiderealDeg,
  meanObliquityDeg,
  refractionScale,
  rotateUnits,
  unitFromRaDec,
  unitsFromRaDecArray,
  type HorizonBuffers,
} from './astro.js';
import { extinctionAt } from './conditions.js';
import { DeepSkyField } from './deepsky.js';
import type { Projector } from './projection.js';
import { buildStarRenderData, type StarRenderData } from './stars.js';

/** Points on the equator and ecliptic (1° apart, closed). */
export const CIRCLE_POINTS = 361;

/** Directions below this (geometric) are not refracted or projected: never drawn, never line ends. */
const SKIP_BELOW = -25 * DEG;

export interface SceneFlags {
  boundaries: boolean;
  constellationLabels: boolean;
  equator: boolean;
  ecliptic: boolean;
  /** Refresh the star places once per simulated day instead of hour (fast playback). */
  daily?: boolean;
  /** The right ascension and declination grid (sky2 agent). */
  raDecGrid?: boolean;
  /** Deep-sky objects (sky2 agent). */
  deepSky?: boolean;
  /**
   * Keep the star and deep-sky places of the last bucket (sky2 agent): while time runs at
   * weeks a second and more (`fastPlayback`, playback.ts) a new bucket would come every
   * frame, and the places move by arcseconds meanwhile. They are brought up to date when
   * time slows.
   */
  frozen?: boolean;
}

// ---------------------------------------------------------------------------------
// The right ascension and declination grid (sky2 agent): fixed in the frame of date
// ---------------------------------------------------------------------------------

/** Hour circles every hour to ±80° (the four at 0, 6, 12 and 18 h to the poles), parallels every 10°. */
export interface RaDecGrid {
  /** Unit vectors of every polyline point, equator and equinox of date. */
  units: Float64Array;
  /** Polyline k runs over points [start[k], start[k + 1]). */
  start: Int32Array;
  count: number;
  /** Declination of each parallel polyline, or NaN for an hour circle (label placement). */
  decOf: Float64Array;
  /** Right ascension, hours, of each hour circle, or NaN for a parallel. */
  hourOf: Float64Array;
}

export function raDecGridUnits(stepDeg = 2): RaDecGrid {
  const pts: number[] = [];
  const start: number[] = [];
  const decOf: number[] = [];
  const hourOf: number[] = [];
  const push = (ra: number, dec: number): void => {
    const c = Math.cos(dec * DEG);
    pts.push(c * Math.cos(ra * DEG), c * Math.sin(ra * DEG), Math.sin(dec * DEG));
  };
  for (let hour = 0; hour < 24; hour += 1) {
    start.push(pts.length / 3);
    decOf.push(Number.NaN);
    hourOf.push(hour);
    const reach = hour % 6 === 0 ? 90 : 80;
    for (let dec = -reach; dec <= reach + 1e-9; dec += stepDeg) push(hour * 15, dec);
  }
  for (let dec = -80; dec <= 80; dec += 10) {
    start.push(pts.length / 3);
    decOf.push(dec);
    hourOf.push(Number.NaN);
    for (let ra = 0; ra <= 360 + 1e-9; ra += stepDeg) push(ra, dec);
  }
  start.push(pts.length / 3);
  return {
    units: Float64Array.from(pts),
    start: Int32Array.from(start),
    count: start.length - 1,
    decOf: Float64Array.from(decOf),
    hourOf: Float64Array.from(hourOf),
  };
}

export class SkyScene {
  catalog: StarfieldCatalog | null = null;
  stars: StarRenderData | null = null;
  n = 0;
  /** Unit vectors of the stars, equator and equinox of date (from `starfield_apparent`). */
  units = new Float64Array(0);
  /** Apparent directions of the stars this frame. */
  h: HorizonBuffers = horizonBuffers(0);
  /** Screen position, CSS px (NaN when not projected). */
  x = new Float32Array(0);
  y = new Float32Array(0);
  /** 1 when above the horizon and projected inside (or near) the view. */
  onScreen = new Uint8Array(0);
  /**
   * Each star's magnitude as seen this frame: the catalogue's, plus the extinction
   * relative to the zenith when that layer is on (sky2 agent). Set by `project`.
   */
  effMag = new Float32Array(0);

  /** J2000 unit vectors of the boundary polylines, and of date. */
  private bJ2000 = new Float64Array(0);
  bUnits = new Float64Array(0);
  bh: HorizonBuffers = horizonBuffers(0);
  /** Polyline k runs over points [bStart[k], bStart[k + 1]). */
  bStart = new Int32Array(1);
  bCount = 0;

  /** Constellation label directions. */
  private cJ2000 = new Float64Array(0);
  cUnits = new Float64Array(0);
  ch: HorizonBuffers = horizonBuffers(0);

  eqUnits = greatCircleUnits(0, CIRCLE_POINTS);
  eclUnits = new Float64Array(3 * CIRCLE_POINTS);
  eqh: HorizonBuffers = horizonBuffers(CIRCLE_POINTS);
  eclh: HorizonBuffers = horizonBuffers(CIRCLE_POINTS);

  /** The right ascension and declination grid of date, and its directions this frame (sky2 agent). */
  readonly raDec: RaDecGrid = raDecGridUnits();
  raDecH: HorizonBuffers = horizonBuffers(this.raDec.units.length / 3);
  /** Deep-sky objects (sky2 agent). */
  readonly dso = new DeepSkyField();
  /** ICRS to the frame of date for the current bucket (identity until the engine gives it). */
  readonly frame = Float64Array.from(IDENTITY3);
  /** The instant (rounded to the hour or day) the star places are for. */
  get bucketJd(): number {
    return this.bucketKey;
  }

  /** The horizon rotation of the frame: (E, N, U) = hm · v. */
  hm = new Float64Array(9);
  /** Local sidereal angle, degrees. */
  lst = 0;
  latDeg = 0;
  refraction = 1;

  /** The hour (or day) the star places are for; NaN = none yet. */
  private bucketKey = Number.NaN;
  /** True when the frame matrix came from the engine (else J2000 is used as is). */
  frameOfDate = false;
  starsOk = false;
  /** The last error from a star-field call (shown once as a notice by the view). */
  error: string | null = null;
  /** Star-field refreshes so far (tests: at most one per simulated hour). */
  refreshes = 0;

  /** Load the catalogue (and, optionally, the boundaries) once. */
  setCatalog(catalog: StarfieldCatalog, boundaries: readonly ConstellationBoundary[]): void {
    this.catalog = catalog;
    this.stars = buildStarRenderData(catalog);
    const n = catalog.count;
    this.n = n;
    this.units = new Float64Array(3 * n);
    this.h = horizonBuffers(n);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.onScreen = new Uint8Array(n);
    this.effMag = Float32Array.from(catalog.vmag);

    let points = 0;
    for (const b of boundaries) points += b.ra_deg.length;
    this.bJ2000 = new Float64Array(3 * points);
    this.bStart = new Int32Array(boundaries.length + 1);
    let k = 0;
    boundaries.forEach((b, i) => {
      this.bStart[i] = k;
      for (let j = 0; j < b.ra_deg.length; j += 1) {
        unitFromRaDec(b.ra_deg[j]! * DEG, b.dec_deg[j]! * DEG, this.bJ2000, k);
        k += 1;
      }
    });
    this.bStart[boundaries.length] = k;
    this.bCount = boundaries.length;
    this.bUnits = new Float64Array(3 * points);
    this.bh = horizonBuffers(points);

    const cons = catalog.constellations;
    this.cJ2000 = new Float64Array(3 * cons.length);
    cons.forEach((c, i) => unitFromRaDec(c.label_ra_deg * DEG, c.label_dec_deg * DEG, this.cJ2000, i));
    this.cUnits = new Float64Array(3 * cons.length);
    this.ch = horizonBuffers(cons.length);
    this.bucketKey = Number.NaN;
  }

  /**
   * Bring the star places to the simulated hour (or day) of `jd` and carry the J2000
   * boundaries and labels into the frame of date. Cheap when the bucket has not changed.
   */
  private ensureBucket(engine: ExplorerEngine, jd: number, daily: boolean, frozen = false): void {
    if (!this.catalog) return;
    const perDay = daily ? 1 : 24;
    const key = Math.round(jd * perDay) / perDay;
    if (key === this.bucketKey) return;
    if (frozen && Number.isFinite(this.bucketKey)) return;
    try {
      const apparent = engine.starfieldApparent(key);
      unitsFromRaDecArray(apparent, this.n, this.units);
      this.starsOk = true;
      this.error = null;
    } catch (error) {
      this.starsOk = false;
      this.error = error instanceof Error ? error.message : String(error);
    }
    let m: ArrayLike<number> = IDENTITY3;
    this.frameOfDate = false;
    if (engine.starfieldFrameMatrix) {
      try {
        m = engine.starfieldFrameMatrix(key);
        this.frameOfDate = m.length === 9;
        if (!this.frameOfDate) m = IDENTITY3;
      } catch {
        m = IDENTITY3;
      }
    }
    rotateUnits(m, this.bJ2000, this.bJ2000.length / 3, this.bUnits);
    rotateUnits(m, this.cJ2000, this.cJ2000.length / 3, this.cUnits);
    greatCircleUnits(meanObliquityDeg(key), CIRCLE_POINTS, this.eclUnits);
    this.frame.set(m);
    this.bucketKey = key;
    this.refreshes += 1;
  }

  /** The frame's horizon rotation and every direction's apparent altitude and azimuth. */
  update(engine: ExplorerEngine, observer: Observer, jd: number, flags: SceneFlags): void {
    this.ensureBucket(engine, jd, flags.daily ?? false, flags.frozen ?? false);
    if (flags.deepSky && this.dso.load(engine) && !(flags.frozen && this.dso.ok)) {
      const perDay = flags.daily ? 1 : 24;
      this.dso.ensureBucket(engine, Math.round(jd * perDay) / perDay);
    }
    const gha = engine.sidereal(jd).gha_aries_deg;
    this.lst = localSiderealDeg(gha, observer.lon_deg);
    this.latDeg = observer.lat_deg;
    this.refraction = refractionScale(observer.pressure_hpa ?? 1010, observer.temperature_c ?? 10);
    horizonMatrix(this.lst, observer.lat_deg, this.hm);
    if (this.starsOk) horizonDirections(this.units, this.n, this.hm, this.refraction, this.h, SKIP_BELOW);
    if (flags.boundaries && this.bCount > 0) {
      horizonDirections(this.bUnits, this.bh.alt.length, this.hm, this.refraction, this.bh, SKIP_BELOW);
    }
    if (flags.constellationLabels) {
      horizonDirections(this.cUnits, this.ch.alt.length, this.hm, this.refraction, this.ch, SKIP_BELOW);
    }
    if (flags.equator) horizonDirections(this.eqUnits, CIRCLE_POINTS, this.hm, this.refraction, this.eqh, SKIP_BELOW);
    if (flags.ecliptic) horizonDirections(this.eclUnits, CIRCLE_POINTS, this.hm, this.refraction, this.eclh, SKIP_BELOW);
    if (flags.raDecGrid) {
      horizonDirections(this.raDec.units, this.raDecH.alt.length, this.hm, this.refraction, this.raDecH, SKIP_BELOW);
    }
    if (flags.deepSky) this.dso.update(this.hm, this.refraction);
  }

  /**
   * Screen positions of the stars. Stars down to 25° below the horizon are projected
   * (constellation lines that cross the horizon need their far end); `onScreen` marks
   * the ones above the horizon inside the view plus a margin. `ext` is the extinction
   * relative to the zenith per degree of altitude (conditions.ts), or null for none: it
   * sets `effMag`, the magnitude every star is drawn and labelled at this frame.
   */
  project(p: Projector, width: number, height: number, margin = 24, ext: Float32Array | null = null): void {
    const n = this.starsOk ? this.n : 0;
    const { alt, sinAlt, cosAlt, sinAz, cosAz } = this.h;
    const xs = this.x;
    const ys = this.y;
    const on = this.onScreen;
    const eff = this.effMag;
    const vmag = this.stars?.vmag;
    for (let i = 0; i < n; i += 1) {
      const a = alt[i]!;
      if (a < SKIP_BELOW || !p.projectDir(a, sinAlt[i]!, cosAlt[i]!, sinAz[i]!, cosAz[i]!)) {
        on[i] = 0;
        xs[i] = Number.NaN;
        continue;
      }
      const x = p.x;
      const y = p.y;
      xs[i] = x;
      ys[i] = y;
      const shown = a >= 0 && x > -margin && x < width + margin && y > -margin && y < height + margin;
      on[i] = shown ? 1 : 0;
      if (shown && vmag) eff[i] = ext ? vmag[i]! + extinctionAt(ext, a) : vmag[i]!;
    }
    for (let i = n; i < this.n; i += 1) on[i] = 0;
  }

  /** Apparent altitude of star `i`, radians. */
  starAlt(i: number): number {
    return this.h.alt[i]!;
  }

  /** Azimuth of star `i`, radians [0, 2π). */
  starAz(i: number): number {
    return azimuthOf(this.h.sinAz[i]!, this.h.cosAz[i]!);
  }

  /** Horizon unit vector (E, N, U) of star `i` into `out` (for dividing long lines). */
  starHorizonVector(i: number, out: Float64Array, k = 0): void {
    const m = this.hm;
    const u = this.units;
    const x = u[3 * i]!;
    const y = u[3 * i + 1]!;
    const z = u[3 * i + 2]!;
    out[3 * k] = m[0]! * x + m[1]! * y + m[2]! * z;
    out[3 * k + 1] = m[3]! * x + m[4]! * y + m[5]! * z;
    out[3 * k + 2] = m[6]! * x + m[7]! * y + m[8]! * z;
  }

  /** Right ascension and declination of date of star `i`, degrees (tooltips). */
  starRaDecDeg(i: number): { ra: number; dec: number } {
    const u = this.units;
    const ra = Math.atan2(u[3 * i + 1]!, u[3 * i]!) / DEG;
    return { ra: ra < 0 ? ra + 360 : ra, dec: Math.asin(Math.max(-1, Math.min(1, u[3 * i + 2]!))) / DEG };
  }
}
