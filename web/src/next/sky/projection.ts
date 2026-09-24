/**
 * The Sky view's two projections of the horizon sphere onto the canvas, in CSS pixels.
 * OWNER: sky agent. Pure: no DOM.
 *
 * Both are conformal, so shapes and angles (a constellation, the tilt of the Moon's
 * crescent) survive, and both draw the sky as the observer sees it, not mirrored.
 *
 * - **Dome**: stereographic projection from the nadir onto the plane of the horizon,
 *   centred on the zenith. The horizon is a circle of radius `radius`; altitude `h` lies
 *   at `ρ = radius · tan((90° − h) / 2)`. North up puts east on the LEFT, as on any star
 *   chart held overhead; "south up" turns the chart half way round.
 * - **Panorama**: a conformal cylinder (Mercator in altitude) looking toward a chosen
 *   azimuth: the horizon is a straight line, verticals stay vertical, azimuth grows to
 *   the right. `y = yHorizon − s · atanh(sin h)`, so the scale at altitude `h` is
 *   `s · sec h`.
 *
 * Projectors keep their answer in `x` and `y` instead of returning an object, so the
 * per-star loops allocate nothing.
 */

import { DEG, wrapPi } from './astro.js';

export type SkyMode = 'dome' | 'panorama';

/** Altitudes beyond this are clamped in the panorama (Mercator reaches the zenith only at infinity). */
const PANORAMA_MAX_ALT = 89.5 * DEG;
const SIN_MAX = Math.sin(PANORAMA_MAX_ALT);

export interface Projector {
  readonly mode: SkyMode;
  /** The answer of the last `project`/`unproject`. */
  x: number;
  y: number;
  alt: number;
  az: number;
  /** Project apparent altitude and azimuth (radians). Returns false when far outside the view. */
  project(alt: number, az: number): boolean;
  /**
   * The same from precomputed sines and cosines (`horizonDirections`): the per-star path,
   * with no trigonometry in the dome and one `atan2` and one `log` in the panorama.
   */
  projectDir(alt: number, sinAlt: number, cosAlt: number, sinAz: number, cosAz: number): boolean;
  /** Screen point to apparent altitude and azimuth (radians), in `alt`/`az`. False outside the sky. */
  unproject(x: number, y: number): boolean;
  /** Unit screen vector toward the zenith at the last projected point, in `x`/`y` of `out`. */
  upAt(x: number, y: number, out: { x: number; y: number }): void;
  /** Pixels per radian at a given altitude (for drawing a disc at its true size). */
  scaleAt(alt: number): number;
}

// ---------------------------------------------------------------------------
// Dome
// ---------------------------------------------------------------------------

export class DomeProjector implements Projector {
  readonly mode = 'dome' as const;
  x = 0;
  y = 0;
  alt = 0;
  az = 0;
  cx = 0;
  cy = 0;
  /** The horizon circle, CSS px. */
  radius = 1;
  /** −1 turns the chart half way round (south up). */
  private sign = 1;

  configure(cx: number, cy: number, radius: number, southUp: boolean): void {
    this.cx = cx;
    this.cy = cy;
    this.radius = Math.max(1, radius);
    this.sign = southUp ? -1 : 1;
  }

  get southUp(): boolean {
    return this.sign < 0;
  }

  /** Distance from the centre of a point at altitude `h` (radians). */
  rho(h: number): number {
    const s = Math.sin(h);
    // cos h / (1 + sin h) = tan((90° − h) / 2); the nadir is at infinity.
    return s <= -0.999 ? this.radius * 1e3 : (this.radius * Math.cos(h)) / (1 + s);
  }

  project(alt: number, az: number): boolean {
    const r = this.rho(alt);
    const k = this.sign * r;
    this.x = this.cx - k * Math.sin(az);
    this.y = this.cy - k * Math.cos(az);
    // Points well below the horizon (lines crossing it) are kept to 60° below; clipping
    // to the horizon circle hides them.
    return alt > -60 * DEG;
  }

  projectDir(alt: number, sinAlt: number, cosAlt: number, sinAz: number, cosAz: number): boolean {
    const r = sinAlt <= -0.999 ? this.radius * 1e3 : (this.radius * cosAlt) / (1 + sinAlt);
    const k = this.sign * r;
    this.x = this.cx - k * sinAz;
    this.y = this.cy - k * cosAz;
    return alt > -60 * DEG;
  }

  unproject(x: number, y: number): boolean {
    const dx = (x - this.cx) * this.sign;
    const dy = (y - this.cy) * this.sign;
    const r = Math.hypot(dx, dy);
    this.alt = Math.PI / 2 - 2 * Math.atan(r / this.radius);
    const a = Math.atan2(-dx, -dy);
    this.az = a < 0 ? a + 2 * Math.PI : a;
    return r <= this.radius;
  }

  upAt(x: number, y: number, out: { x: number; y: number }): void {
    const dx = this.cx - x;
    const dy = this.cy - y;
    const r = Math.hypot(dx, dy);
    if (r < 1e-6) {
      // At the zenith every direction is "up"; take the top of the chart.
      out.x = 0;
      out.y = -1;
    } else {
      out.x = dx / r;
      out.y = dy / r;
    }
  }

  scaleAt(alt: number): number {
    // dρ/dz = radius / (2 cos²(z/2)), z = 90° − h.
    const c = Math.cos((Math.PI / 2 - alt) / 2);
    return this.radius / (2 * c * c);
  }
}

// ---------------------------------------------------------------------------
// Panorama
// ---------------------------------------------------------------------------

/** Mercator ordinate of an altitude (radians): `atanh(sin h)`. */
export function mercator(alt: number): number {
  const h = alt > PANORAMA_MAX_ALT ? PANORAMA_MAX_ALT : alt < -PANORAMA_MAX_ALT ? -PANORAMA_MAX_ALT : alt;
  const s = Math.sin(h);
  return 0.5 * Math.log((1 + s) / (1 - s));
}

/** Inverse of `mercator`. */
export function inverseMercator(m: number): number {
  return Math.asin(Math.tanh(m));
}

export interface PanoramaLimits {
  /** Horizontal field, degrees. */
  minFov: number;
  maxFov: number;
  /** The lowest altitude the bottom edge may show, degrees. */
  minAlt: number;
  /** The highest altitude the top edge may show, degrees. */
  maxAlt: number;
}

export const PANORAMA_LIMITS: PanoramaLimits = { minFov: 60, maxFov: 180, minAlt: -10, maxAlt: 88 };

/** Where the panorama looks: centre azimuth, horizontal field, and the altitude at the bottom edge. */
export interface PanoramaView {
  /** Degrees, [0, 360). */
  azimuth: number;
  /** Requested horizontal field, degrees. */
  fov: number;
  /** Altitude at the bottom edge, degrees. */
  bottomAlt: number;
}

export class PanoramaProjector implements Projector {
  readonly mode = 'panorama' as const;
  x = 0;
  y = 0;
  alt = 0;
  az = 0;
  width = 1;
  height = 1;
  /** Centre azimuth, radians. */
  az0 = 0;
  /** Pixels per radian at the horizon. */
  s = 1;
  /** Screen y of the horizon (altitude 0). */
  yHorizon = 0;
  /** The field actually shown (a tall, narrow canvas shows less than requested), degrees. */
  fov = 180;
  bottomAlt = -5;
  topAlt = 70;
  private sin0 = 0;
  private cos0 = 1;
  private cosReach = -2;

  /**
   * Fit the view into a `width × height` canvas. The field is clamped to the limits, and
   * narrowed when the canvas is too tall to fill with the altitudes allowed; the bottom
   * altitude is clamped so the top never passes `maxAlt`. Returns the view as applied.
   */
  configure(width: number, height: number, view: PanoramaView, limits: PanoramaLimits = PANORAMA_LIMITS): PanoramaView {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const fov = Math.min(limits.maxFov, Math.max(limits.minFov, view.fov));
    const span = mercator(limits.maxAlt * DEG) - mercator(limits.minAlt * DEG);
    this.s = Math.max(this.width / (fov * DEG), this.height / span);
    this.fov = (this.width / this.s) * (180 / Math.PI);
    const visible = this.height / this.s; // Mercator units shown
    const lo = mercator(limits.minAlt * DEG);
    const hi = mercator(limits.maxAlt * DEG) - visible;
    const bottom = Math.min(Math.max(mercator(view.bottomAlt * DEG), lo), Math.max(lo, hi));
    this.yHorizon = this.height + this.s * bottom;
    this.bottomAlt = inverseMercator(bottom) / DEG;
    this.topAlt = inverseMercator(bottom + visible) / DEG;
    this.az0 = (((view.azimuth % 360) + 360) % 360) * DEG;
    this.sin0 = Math.sin(this.az0);
    this.cos0 = Math.cos(this.az0);
    // project() keeps directions up to 20° beyond the edges; so does the dot-product test.
    const reach = this.width / 2 / this.s + 20 * DEG;
    this.cosReach = reach >= Math.PI ? -2 : Math.cos(reach);
    return { azimuth: this.az0 / DEG, fov: this.fov, bottomAlt: this.bottomAlt };
  }

  get cx(): number {
    return this.width / 2;
  }

  project(alt: number, az: number): boolean {
    const d = wrapPi(az - this.az0);
    this.x = this.width / 2 + this.s * d;
    this.y = this.yHorizon - this.s * mercator(alt);
    // Anything more than 20° outside the field is dropped (it is also where the
    // azimuth seam behind the viewer lies).
    return Math.abs(d) * this.s <= this.width / 2 + 20 * DEG * this.s;
  }

  projectDir(alt: number, sinAlt: number, _cosAlt: number, sinAz: number, cosAz: number): boolean {
    // Behind the viewer: rejected with a dot product, before any trigonometry.
    if (sinAz * this.sin0 + cosAz * this.cos0 < this.cosReach) return false;
    const d = wrapPi(Math.atan2(sinAz, cosAz) - this.az0);
    this.x = this.width / 2 + this.s * d;
    const sa = alt > PANORAMA_MAX_ALT ? SIN_MAX : alt < -PANORAMA_MAX_ALT ? -SIN_MAX : sinAlt;
    this.y = this.yHorizon - this.s * 0.5 * Math.log((1 + sa) / (1 - sa));
    return Math.abs(d) * this.s <= this.width / 2 + 20 * DEG * this.s;
  }

  unproject(x: number, y: number): boolean {
    const a = this.az0 + (x - this.width / 2) / this.s;
    this.az = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    this.alt = inverseMercator((this.yHorizon - y) / this.s);
    return true;
  }

  upAt(_x: number, _y: number, out: { x: number; y: number }): void {
    out.x = 0;
    out.y = -1;
  }

  scaleAt(alt: number): number {
    return this.s / Math.cos(Math.min(Math.abs(alt), PANORAMA_MAX_ALT));
  }

  /** Azimuth difference (radians, (−π, π]) from the centre, for seam tests. */
  offset(az: number): number {
    return wrapPi(az - this.az0);
  }
}
