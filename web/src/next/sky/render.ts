/**
 * Canvas 2D drawing for the Sky view. OWNER: sky agent.
 *
 * One `draw(frame)` per animation frame, in CSS pixels (the caller sets the
 * devicePixelRatio transform). Order: sky colour and twilight glow → grid and reference
 * lines → constellation figures and boundaries → the selected body's path → stars →
 * planets, Moon, Sun → ground (panorama) or the dome's rim → labels → rings.
 *
 * Performance rules (EXPLORER_PLAN §3.7, 9 000 stars in ≤ 8 ms): stars are drawn by
 * (size, colour) group — one path and one fill per group, `globalAlpha` for brightness —
 * from typed arrays filled by `SkyScene`; nothing is allocated per star; text widths are
 * cached; labels are skipped for faint stars and resolved against each other with a
 * fixed-size rectangle list.
 *
 * Colour comes only from `palette.ts` (design tokens); the night theme is red only.
 */

import type { BodyKind, BodyState, SkyState } from '../engine/types.js';
import type { Layers } from '../state.js';
import { glyphShape, type GlyphName } from '../theme/glyphs.js';
import { azimuthOf, brightLimbScreenAngle, DEG, RAD, refractionArcmin, type HorizonBuffers } from './astro.js';
import { drawDeepSkySymbols, type DeepSkyField, type DsoColours } from './deepsky.js';
import { DomeProjector, PanoramaProjector, type Projector } from './projection.js';
import {
  css,
  mix,
  starRgbFromBv,
  type BodyKey,
  type Rgb,
  type SkyColours,
  type SkyPalette,
} from './palette.js';
import type { SkyScene } from './scene.js';
import { binBv, binMagnitude, COLOUR_BINS, colourBin, MAG_BINS, magBin, starAlpha, starRadius, starTitle } from './stars.js';

const TAU = 2 * Math.PI;
/** Figure segments shorter than this are drawn as chords (see `figures`). */
const COS_CHORD = Math.cos((6 * Math.PI) / 180);
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Hover, focus and selection address stars by index and bodies by name. */
export const bodyKey = (name: string): string => `b:${name}`;
export const starKey = (index: number): string => `s:${index}`;
/** sky2 agent: deep-sky objects by catalogue index, radiants by shower code, added bodies by name, constellations by index. */
export const deepSkyKey = (index: number): string => `d:${index}`;
export const radiantKey = (code: string): string => `r:${code}`;
export const customKey = (name: string): string => `c:${name}`;
export const constellationKey = (index: number): string => `k:${index}`;

/** A meteor radiant to draw (sky2 agent): apparent altitude and azimuth, radians. */
export interface RadiantMark {
  key: string;
  code: string;
  name: string;
  alt: number;
  az: number;
  /** The label's second part: "about 40 an hour", or "" before the night's estimate. */
  rate: string;
  /** 0–1: the peak ZHR on a log scale (symbol size). */
  strength: number;
  x: number;
  y: number;
  drawn: boolean;
}

/** A comet or asteroid the person added (sky2 agent). */
export interface CustomMark {
  key: string;
  name: string;
  kind: 'comet' | 'asteroid';
  alt: number;
  az: number;
  magnitude: number | null;
  /** A point a degree from it toward the Sun (apparent altitude and azimuth, radians): a comet's tail points the other way. */
  sunward: { alt: number; az: number } | null;
  x: number;
  y: number;
  drawn: boolean;
}

/** The field-of-view outline (sky2 agent): horizon unit vectors, and its label. */
export interface FovOutline {
  points: Float64Array;
  count: number;
  label: string;
}

/** The Milky Way's raster, ready to be drawn scaled up (sky2 agent). */
export interface MilkyWayImage {
  source: CanvasImageSource;
  /** Texels drawn, and the CSS pixels per texel. */
  width: number;
  height: number;
  cell: number;
}

export interface BodyMark {
  key: string;
  name: string;
  kind: Exclude<BodyKind, 'star'>;
  state: BodyState | null;
  /** Apparent altitude and azimuth, radians. */
  alt: number;
  az: number;
  x: number;
  y: number;
  /** Radius as drawn, CSS px. */
  r: number;
  /** Above the horizon and inside the view. */
  drawn: boolean;
}

/** A body's path through the local day (`sample_bodies`), apparent, radians. */
export interface PathData {
  body: string;
  bodyKey: BodyKey;
  alt: Float64Array;
  az: Float64Array;
  /** Samples at whole local hours, with their labels ("14"). */
  hourIndex: readonly number[];
  hourLabel: readonly string[];
}

export interface Frame {
  width: number;
  height: number;
  projector: Projector;
  scene: SkyScene;
  sky: SkyState | null;
  layers: Layers;
  palette: SkyPalette;
  colours: SkyColours;
  /** Faintest magnitude drawn (sky brightness). */
  limitMag: number;
  /** Star size factor for the zoom. */
  zoom: number;
  selectedKey: string | null;
  highlightKeys: ReadonlySet<string>;
  focusKey: string | null;
  hoverKey: string | null;
  path: PathData | null;
  // --- sky2 agent ---
  /** Deep-sky objects, projected this frame (null: the layer is off or unavailable). */
  dso?: DeepSkyField | null;
  /** The Milky Way's glow (null: off, not visible, or unavailable). */
  milkyWay?: MilkyWayImage | null;
  /** Meteor radiants active now. */
  radiants?: RadiantMark[];
  /** Comets and asteroids the person added. */
  custom?: CustomMark[];
  /** The field-of-view outline, or null. */
  fov?: FovOutline | null;
  /** A constellation the search found (its figure is drawn brighter), or −1. */
  constellation?: number;
}

const BODY_TOKEN: Record<string, BodyKey> = {
  Sun: 'sun',
  Moon: 'moon',
  Mercury: 'mercury',
  Venus: 'venus',
  Mars: 'mars',
  Jupiter: 'jupiter',
  Saturn: 'saturn',
  Uranus: 'uranus',
  Neptune: 'neptune',
};

export function bodyToken(name: string): BodyKey {
  return BODY_TOKEN[name] ?? 'star';
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Radius of a planet's disc by magnitude, CSS px at zoom 1. */
export function planetRadius(mag: number | null): number {
  const m = mag ?? 3;
  return Math.min(5.2, Math.max(2.3, 2.1 + 0.52 * (1.5 - m)));
}

type Ctx2D = CanvasRenderingContext2D;

export class SkyRenderer {
  /** The Sun, Moon and planets as last drawn (hit-testing, focus, tooltips). */
  readonly bodies: BodyMark[] = [];
  private readonly marks = new Map<string, BodyMark>();
  private starFill: string[] = [];
  private starRgb: Rgb[] = [];
  private glowSprites: (HTMLCanvasElement | null)[] = [];
  private palette: SkyPalette | null = null;
  private readonly widths = new Map<string, number>();
  private rects = new Float32Array(4 * 1024);
  private rectCount = 0;
  /** Scratch for dividing long lines: 2 end vectors. */
  private readonly ends = new Float64Array(6);
  private readonly up = { x: 0, y: -1 };
  /** Glyph shapes as Path2D, built once. */
  private readonly glyphs = new Map<GlyphName, { fill: Path2D[]; stroke: Path2D[] }>();
  /** Labels of reference lines, placed after the bodies' (which win a collision). */
  private readonly lineLabels: { text: string; x: number; y: number; fill: string; centred?: boolean }[] = [];
  /** Indices of stars brighter than 1.5 (glows). */
  private bright = new Int32Array(0);
  private brightFor: object | null = null;

  constructor(private readonly ctx: Ctx2D) {}

  setPalette(p: SkyPalette): void {
    this.palette = p;
    this.starFill = [];
    this.starRgb = [];
    for (let b = 0; b < COLOUR_BINS; b += 1) {
      const bv = binBv(b);
      const tint = starRgbFromBv(bv);
      const rgb = p.theme === 'night' || !tint ? p.body.star : p.filter(mix(p.body.star, tint, 0.9));
      this.starRgb.push(rgb);
      this.starFill.push(css(rgb));
    }
    this.glowSprites = new Array<HTMLCanvasElement | null>(COLOUR_BINS).fill(null);
    this.widths.clear();
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  draw(f: Frame): void {
    const ctx = this.ctx;
    if (!this.palette) this.setPalette(f.palette);
    this.rectCount = 0;
    this.lineLabels.length = 0;
    this.updateBodies(f);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const dome = f.projector instanceof DomeProjector ? f.projector : null;
    if (dome) {
      ctx.fillStyle = css(f.palette.stageBg);
      ctx.fillRect(0, 0, f.width, f.height);
      ctx.save();
      ctx.beginPath();
      ctx.arc(dome.cx, dome.cy, dome.radius, 0, TAU);
      ctx.clip();
      this.domeSky(f, dome);
    } else {
      this.panoramaSky(f, f.projector as PanoramaProjector);
    }
    this.sunGlow(f);
    if (f.milkyWay) this.milkyWay(f, f.milkyWay);
    this.grid(f);
    if (f.layers.raDecGrid) this.raDecGrid(f);
    if (f.layers.constellationBoundaries) this.boundaries(f);
    if (f.layers.equator) this.circle(f, f.scene.eqh, 'equator');
    if (f.layers.ecliptic) this.circle(f, f.scene.eclh, 'ecliptic');
    if (f.layers.meridian) this.meridian(f);
    if (f.layers.constellations) this.figures(f);
    if (f.constellation !== undefined && f.constellation >= 0) this.figures(f, f.constellation);
    if (f.layers.paths && f.path) this.pathLine(f, f.path);
    if (f.dso) this.deepSky(f, f.dso);
    this.stars(f);
    if (f.radiants?.length) this.radiantMarks(f, f.radiants);
    if (f.custom?.length) this.customMarks(f, f.custom);
    this.drawBodies(f);
    if (f.fov) this.fovOutline(f, f.fov);
    if (dome) {
      ctx.restore(); // end of the sky clip
      this.domeRim(f, dome);
    } else {
      this.ground(f, f.projector as PanoramaProjector);
      if (f.layers.paths && f.path) this.pathBelow(f, f.path);
    }
    this.labels(f);
    this.rings(f);
    this.belowHorizonMarker(f);
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Sky and ground
  // -------------------------------------------------------------------------

  private domeSky(f: Frame, d: DomeProjector): void {
    const ctx = this.ctx;
    const { zenith, horizon } = f.colours;
    const g = ctx.createRadialGradient(d.cx, d.cy, 0, d.cx, d.cy, d.radius);
    // ρ/R = tan((90° − h)/2): 0.41 at 45°, 0.75 at 16°.
    g.addColorStop(0, css(zenith));
    g.addColorStop(0.41, css(mix(zenith, horizon, 0.22)));
    g.addColorStop(0.75, css(mix(zenith, horizon, 0.58)));
    g.addColorStop(1, css(horizon));
    ctx.fillStyle = g;
    ctx.fillRect(d.cx - d.radius, d.cy - d.radius, 2 * d.radius, 2 * d.radius);
  }

  private panoramaSky(f: Frame, p: PanoramaProjector): void {
    const ctx = this.ctx;
    const { zenith, horizon } = f.colours;
    const yTop = p.yHorizon - p.s * 1.32; // about 60° up
    const g = ctx.createLinearGradient(0, p.yHorizon, 0, Math.min(yTop, p.yHorizon - 1));
    g.addColorStop(0, css(horizon));
    g.addColorStop(0.25, css(mix(horizon, zenith, 0.42)));
    g.addColorStop(0.6, css(mix(horizon, zenith, 0.8)));
    g.addColorStop(1, css(zenith));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, f.width, Math.max(0, Math.min(f.height, p.yHorizon + 1)));
  }

  private sunGlow(f: Frame): void {
    const sun = this.marks.get('Sun');
    if (!sun?.state) return;
    const ctx = this.ctx;
    const p = f.projector;
    const { glow, glowAlpha, horizon } = f.colours;
    const sunAlt = sun.alt;
    const size = p instanceof DomeProjector ? p.radius : (p as PanoramaProjector).s;
    if (glowAlpha > 0.005) {
      // The twilight glow sits on the horizon below the Sun until it rises.
      if (p.project(Math.max(sunAlt, 0), sun.az)) {
        const rad = size * (p instanceof DomeProjector ? 0.95 : 0.9);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        g.addColorStop(0, css(glow, glowAlpha));
        g.addColorStop(0.3, css(glow, glowAlpha * 0.5));
        g.addColorStop(0.65, css(glow, glowAlpha * 0.14));
        g.addColorStop(1, css(glow, 0));
        ctx.fillStyle = g;
        ctx.fillRect(p.x - rad, p.y - rad, 2 * rad, 2 * rad);
      }
    }
    if (sunAlt > -2 * DEG && p.project(sunAlt, sun.az)) {
      // Daylight: a soft bright halo around the Sun.
      const k = Math.min(1, (sunAlt / DEG + 2) / 6);
      const halo = f.palette.filter(mix(horizon, WHITE, 0.65));
      const rad = size * 0.28;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
      g.addColorStop(0, css(halo, 0.55 * k));
      g.addColorStop(0.35, css(halo, 0.2 * k));
      g.addColorStop(1, css(halo, 0));
      ctx.fillStyle = g;
      ctx.fillRect(p.x - rad, p.y - rad, 2 * rad, 2 * rad);
    }
  }

  private ground(f: Frame, p: PanoramaProjector): void {
    const ctx = this.ctx;
    const y0 = Math.max(0, p.yHorizon);
    if (y0 < f.height) {
      const g = ctx.createLinearGradient(0, y0, 0, f.height);
      g.addColorStop(0, css(mix(f.colours.ground, f.colours.horizon, 0.18)));
      g.addColorStop(1, css(mix(f.colours.ground, { r: 0, g: 0, b: 0 }, 0.35)));
      ctx.fillStyle = g;
      ctx.fillRect(0, y0, f.width, f.height - y0);
    }
    // Horizon line, azimuth ticks and compass points.
    const ink = f.colours.light ? f.palette.inkOnLight : f.palette.inkOnDark;
    const groundInk = f.palette.inkOnDark; // the ground is always dark
    ctx.strokeStyle = css(ink, 0.75);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, p.yHorizon);
    ctx.lineTo(f.width, p.yHorizon);
    ctx.stroke();

    const pxPerDeg = p.s * DEG;
    const labelStep = pxPerDeg * 15 >= 70 ? 15 : pxPerDeg * 30 >= 70 ? 30 : 45;
    const half = f.width / 2 / pxPerDeg + 5;
    const centre = p.az0 * RAD;
    const first = Math.ceil((centre - half) / 5) * 5;
    ctx.strokeStyle = css(groundInk, 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let a = first; a <= centre + half; a += 5) {
      const x = f.width / 2 + p.s * wrap180(a - centre) * DEG;
      const len = a % 30 === 0 ? 10 : a % 10 === 0 ? 6 : 3;
      ctx.moveTo(x, p.yHorizon + 1);
      ctx.lineTo(x, p.yHorizon + 1 + len);
    }
    ctx.stroke();
    const yLabel = p.yHorizon + 26;
    if (yLabel < f.height + 10) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      for (let a = Math.ceil((centre - half) / labelStep) * labelStep; a <= centre + half; a += labelStep) {
        const az = ((a % 360) + 360) % 360;
        const x = f.width / 2 + p.s * wrap180(a - centre) * DEG;
        const cardinal = az % 45 === 0 ? CARDINALS[az / 45]! : null;
        if (cardinal) {
          const main = az % 90 === 0;
          ctx.font = `${main ? 700 : 600} ${main ? 15 : 12}px ${f.palette.fontUi}`;
          ctx.fillStyle = css(az === 0 ? f.palette.accent : groundInk, main ? 1 : 0.85);
          ctx.fillText(cardinal, x, yLabel);
          this.reserve(x - 12, yLabel - 14, 24, 18);
        } else {
          ctx.font = `500 10.5px ${f.palette.fontNum}`;
          ctx.fillStyle = css(groundInk, 0.7);
          ctx.fillText(`${az}°`, x, yLabel - 1);
        }
      }
    }
  }

  private domeRim(f: Frame, d: DomeProjector): void {
    const ctx = this.ctx;
    const p = f.palette;
    ctx.strokeStyle = css(p.stageLineStrong);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(d.cx, d.cy, d.radius, 0, TAU);
    ctx.stroke();
    const sign = d.southUp ? -1 : 1;
    ctx.strokeStyle = css(p.stageInk2, 0.8);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let a = 0; a < 360; a += 5) {
      const len = a % 45 === 0 ? 9 : a % 10 === 0 ? 5 : 2.5;
      const sx = -Math.sin(a * DEG) * sign;
      const sy = -Math.cos(a * DEG) * sign;
      ctx.moveTo(d.cx + sx * (d.radius + 1), d.cy + sy * (d.radius + 1));
      ctx.lineTo(d.cx + sx * (d.radius + 1 + len), d.cy + sy * (d.radius + 1 + len));
    }
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < 8; k += 1) {
      const a = k * 45;
      const main = k % 2 === 0;
      const rr = d.radius + (main ? 21 : 19);
      const x = d.cx - Math.sin(a * DEG) * sign * rr;
      const y = d.cy - Math.cos(a * DEG) * sign * rr;
      ctx.font = `${main ? 700 : 600} ${main ? 15 : 11.5}px ${p.fontUi}`;
      ctx.fillStyle = css(a === 0 ? p.accent : main ? p.stageInk : p.stageInk2);
      ctx.fillText(CARDINALS[k]!, x, y);
    }
    ctx.textBaseline = 'alphabetic';
  }

  // -------------------------------------------------------------------------
  // Grid and reference lines
  // -------------------------------------------------------------------------

  private grid(f: Frame): void {
    const ctx = this.ctx;
    const ink = f.colours.ink;
    const full = f.layers.altAzGrid;
    const p = f.projector;
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    if (p instanceof DomeProjector) {
      for (let h = 10; h < 90; h += 10) {
        const major = h === 30 || h === 60;
        if (!major && !full) continue;
        ctx.strokeStyle = css(ink, major ? 0.16 : 0.1);
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, p.rho(h * DEG), 0, TAU);
        ctx.stroke();
      }
      if (full) {
        ctx.strokeStyle = css(ink, 0.1);
        ctx.beginPath();
        for (let a = 0; a < 360; a += 30) {
          p.project(80 * DEG, a * DEG);
          ctx.moveTo(p.x, p.y);
          p.project(0, a * DEG);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
      // Ring labels along the top spoke.
      ctx.font = `500 10px ${f.palette.fontNum}`;
      ctx.fillStyle = css(ink, 0.5);
      ctx.textAlign = 'left';
      for (const h of full ? [10, 20, 30, 40, 50, 60, 70, 80] : [30, 60]) {
        const y = p.cy - p.rho(h * DEG);
        ctx.fillText(`${h}°`, p.cx + 3, y - 2);
      }
    } else if (p instanceof PanoramaProjector) {
      for (let h = 10; h < 90; h += 10) {
        const major = h === 30 || h === 60;
        if (!major && !full) continue;
        p.project(h * DEG, p.az0);
        if (p.y < -2 || p.y > f.height) continue;
        ctx.strokeStyle = css(ink, major ? 0.16 : 0.1);
        ctx.beginPath();
        ctx.moveTo(0, p.y);
        ctx.lineTo(f.width, p.y);
        ctx.stroke();
        ctx.font = `500 10px ${f.palette.fontNum}`;
        ctx.fillStyle = css(ink, 0.55);
        ctx.textAlign = 'left';
        ctx.fillText(`${h}°`, 6, p.y - 3);
      }
      if (full) {
        const pxPerDeg = p.s * DEG;
        const step = pxPerDeg * 10 >= 40 ? 10 : 30;
        const centre = p.az0 * RAD;
        const half = f.width / 2 / pxPerDeg;
        ctx.strokeStyle = css(ink, 0.1);
        ctx.beginPath();
        for (let a = Math.ceil((centre - half) / step) * step; a <= centre + half; a += step) {
          const x = f.width / 2 + p.s * wrap180(a - centre) * DEG;
          ctx.moveTo(x, p.yHorizon);
          ctx.lineTo(x, 0);
        }
        ctx.stroke();
      }
    }
  }

  private meridian(f: Frame): void {
    const ctx = this.ctx;
    const p = f.projector;
    ctx.strokeStyle = css(f.palette.accent, 0.55);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    for (const az of [0, Math.PI]) {
      let pen = false;
      for (let h = 0; h <= 90; h += 2) {
        if (!p.project(h * DEG, az)) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
        pen = true;
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Label near the top of the view on the southern (or northern) half.
    const labelAz = f.scene.latDeg >= 0 ? Math.PI : 0;
    if (p.project(p instanceof DomeProjector ? 58 * DEG : 25 * DEG, labelAz)) {
      this.lineLabels.push({ text: 'Meridian', x: p.x + 5, y: p.y, fill: css(f.palette.accent, 0.9) });
    }
  }

  /** A closed great circle given as apparent directions. */
  private circle(f: Frame, hb: HorizonBuffers, which: 'equator' | 'ecliptic'): void {
    const ctx = this.ctx;
    const colour = which === 'equator' ? f.colours.ink : f.palette.body.sun;
    ctx.strokeStyle = css(colour, which === 'equator' ? 0.5 : 0.75);
    ctx.lineWidth = 1.2;
    ctx.setLineDash(which === 'equator' ? [6, 4] : [2, 4]);
    ctx.beginPath();
    this.polyline(f, hb, 0, hb.alt.length, -8 * DEG);
    ctx.stroke();
    ctx.setLineDash([]);
    // Label at the highest visible point.
    const { alt, sinAlt, cosAlt, sinAz, cosAz } = hb;
    let best = -1;
    let bestAlt = 3 * DEG;
    const p = f.projector;
    for (let k = 0; k < alt.length; k += 1) {
      if (
        alt[k]! > bestAlt &&
        p.projectDir(alt[k]!, sinAlt[k]!, cosAlt[k]!, sinAz[k]!, cosAz[k]!) &&
        p.x > 40 &&
        p.x < f.width - 120 &&
        p.y > 20 &&
        p.y < f.height - 20
      ) {
        best = k;
        bestAlt = alt[k]!;
      }
    }
    if (best >= 0 && p.projectDir(alt[best]!, sinAlt[best]!, cosAlt[best]!, sinAz[best]!, cosAz[best]!)) {
      const text = which === 'equator' ? 'Celestial equator' : 'Ecliptic';
      this.lineLabels.push({ text, x: p.x + 6, y: p.y - 6, fill: css(colour, 0.95) });
    }
  }

  private boundaries(f: Frame): void {
    const s = f.scene;
    if (s.bCount === 0) return;
    const ctx = this.ctx;
    ctx.strokeStyle = css(f.colours.ink, 0.26);
    ctx.lineWidth = 0.9;
    ctx.setLineDash([1.5, 3.5]);
    ctx.beginPath();
    for (let k = 0; k < s.bCount; k += 1) this.polyline(f, s.bh, s.bStart[k]!, s.bStart[k + 1]!, -8 * DEG);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * Add a polyline of apparent directions to the current path, lifting the pen below
   * `minAlt`, outside the view and across the panorama's seam.
   */
  private polyline(f: Frame, hb: HorizonBuffers, start: number, end: number, minAlt: number): void {
    const ctx = this.ctx;
    const p = f.projector;
    const jump = f.width * 0.5;
    const { alt, sinAlt, cosAlt, sinAz, cosAz } = hb;
    let pen = false;
    let px = 0;
    for (let k = start; k < end; k += 1) {
      const h = alt[k]!;
      if (h < minAlt || !p.projectDir(h, sinAlt[k]!, cosAlt[k]!, sinAz[k]!, cosAz[k]!)) {
        pen = false;
        continue;
      }
      if (pen && Math.abs(p.x - px) > jump) pen = false;
      if (pen) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
      pen = true;
      px = p.x;
    }
  }

  // -------------------------------------------------------------------------
  // Constellation figures
  // -------------------------------------------------------------------------

  /** Every constellation's figure, or (sky2 agent) only constellation `only`, brighter: the one the search found. */
  private figures(f: Frame, only = -1): void {
    const s = f.scene;
    const cat = s.catalog;
    if (!cat || !s.starsOk) return;
    if (only >= cat.constellations.length) return;
    const ctx = this.ctx;
    const p = f.projector;
    const alt = s.h.alt;
    const xs = s.x;
    const ends = this.ends;
    const jump = f.width * 0.5;
    const step = 2.5 * DEG;
    ctx.strokeStyle = only >= 0 ? css(f.palette.accent, 0.95) : css(f.colours.ink, f.colours.light ? 0.32 : 0.36);
    ctx.lineWidth = only >= 0 ? 2 : 1;
    ctx.beginPath();
    for (const c of only >= 0 ? [cat.constellations[only]!] : cat.constellations) {
      for (const [a, b] of c.lines) {
        if (alt[a]! < 0 && alt[b]! < 0) continue;
        if (Number.isNaN(xs[a]!) && Number.isNaN(xs[b]!)) continue;
        s.starHorizonVector(a, ends, 0);
        s.starHorizonVector(b, ends, 1);
        const dot = ends[0]! * ends[3]! + ends[1]! * ends[4]! + ends[2]! * ends[5]!;
        // Short segments with both ends drawn are straight chords between the projected
        // stars (the great circle bows by under half a pixel over 6°, in both views).
        if (dot > COS_CHORD && !Number.isNaN(xs[a]!) && !Number.isNaN(xs[b]!) && alt[a]! > 0 && alt[b]! > 0) {
          if (Math.abs(xs[a]! - xs[b]!) < jump) {
            ctx.moveTo(xs[a]!, s.y[a]!);
            ctx.lineTo(xs[b]!, s.y[b]!);
          }
          continue;
        }
        const n = Math.max(1, Math.ceil(Math.acos(Math.min(1, Math.max(-1, dot))) / step));
        let pen = false;
        let px = 0;
        for (let k = 0; k <= n; k += 1) {
          const t = k / n;
          const e = ends[0]! + (ends[3]! - ends[0]!) * t;
          const nn = ends[1]! + (ends[4]! - ends[1]!) * t;
          const u = ends[2]! + (ends[5]! - ends[2]!) * t;
          const len = Math.hypot(e, nn, u);
          const h0 = Math.asin(Math.max(-1, Math.min(1, u / len)));
          if (h0 < -10 * DEG) {
            pen = false;
            continue;
          }
          const h = h0 + (refractionArcmin(h0 * RAD, s.refraction) / 60) * DEG;
          let azv = Math.atan2(e, nn);
          if (azv < 0) azv += TAU;
          if (!p.project(h, azv)) {
            pen = false;
            continue;
          }
          if (pen && Math.abs(p.x - px) > jump) pen = false;
          if (pen) ctx.lineTo(p.x, p.y);
          else ctx.moveTo(p.x, p.y);
          pen = true;
          px = p.x;
        }
      }
    }
    ctx.stroke();
  }

  // -------------------------------------------------------------------------
  // A body's path through the day
  // -------------------------------------------------------------------------

  /** Add the samples of a path above (or below) the horizon to the current path. */
  private pathTrace(f: Frame, path: PathData, above: boolean): void {
    const ctx = this.ctx;
    const p = f.projector;
    const jump = f.width * 0.5;
    let pen = false;
    let px = 0;
    for (let k = 0; k < path.alt.length; k += 1) {
      const a = path.alt[k]!;
      const keep = above ? a >= -1 * DEG : a <= 1 * DEG;
      if (!keep || !p.project(a, path.az[k]!)) {
        pen = false;
        continue;
      }
      if (pen && Math.abs(p.x - px) > jump) pen = false;
      if (pen) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
      pen = true;
      px = p.x;
    }
  }

  private pathLine(f: Frame, path: PathData): void {
    const ctx = this.ctx;
    const colour = f.palette.body[path.bodyKey];
    // "Today's path": solid, over a casing (the shared line styles, tokens.css).
    ctx.setLineDash(f.palette.dashPath);
    ctx.beginPath();
    this.pathTrace(f, path, true);
    ctx.strokeStyle = css(f.palette.halo, f.palette.haloAlpha * 0.7);
    ctx.lineWidth = 4.4;
    ctx.stroke();
    ctx.strokeStyle = css(colour, 0.95);
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.setLineDash([]);
    const p = f.projector;
    ctx.fillStyle = css(colour);
    ctx.strokeStyle = css(f.palette.halo, f.palette.haloAlpha);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const k of path.hourIndex) {
      if (path.alt[k]! < 0 || !p.project(path.alt[k]!, path.az[k]!)) continue;
      ctx.moveTo(p.x + 2.4, p.y);
      ctx.arc(p.x, p.y, 2.4, 0, TAU);
    }
    ctx.stroke();
    ctx.fill();
    ctx.font = `500 10px ${f.palette.fontNum}`;
    ctx.textAlign = 'center';
    path.hourIndex.forEach((k, i) => {
      if (path.alt[k]! < 1 * DEG || !p.project(path.alt[k]!, path.az[k]!)) return;
      const w = 16;
      if (!this.place(p.x - w / 2, p.y - 16, w, 11)) return;
      ctx.fillStyle = css(colour, 0.95);
      ctx.fillText(path.hourLabel[i]!, p.x, p.y - 7);
    });
  }

  // -------------------------------------------------------------------------
  // Stars
  // -------------------------------------------------------------------------

  /** Per-frame grouping of the stars by (dimmed magnitude bin, colour bin): a counting sort (sky2 agent). */
  private frameOrder = new Int32Array(0);
  private readonly groupStart = new Int32Array(MAG_BINS * COLOUR_BINS + 1);
  private readonly groupFill = new Int32Array(MAG_BINS * COLOUR_BINS);
  private starBin = new Int32Array(0);

  /**
   * The stars, faint first, one path and one fill per (size, colour) group. The groups are
   * made each frame from `scene.effMag` — the catalogue magnitude dimmed by extinction
   * toward the horizon — so a star low in the sky is drawn smaller and fainter, and one
   * dimmed past the limit is not drawn at all. A counting sort over the stars on screen:
   * about 0.1 ms for 9 000, and nothing allocated.
   */
  private stars(f: Frame): void {
    const s = f.scene;
    const data = s.stars;
    if (!data || !s.starsOk) return;
    const ctx = this.ctx;
    const xs = s.x;
    const ys = s.y;
    const on = s.onScreen;
    const eff = s.effMag;
    const cbin = data.cbin;
    const limit = f.limitMag;
    const cut = limit + 0.6; // starAlpha is 0 beyond this
    const n = s.n;
    if (this.frameOrder.length < n) {
      this.frameOrder = new Int32Array(n);
      this.starBin = new Int32Array(n);
    }
    const nb = MAG_BINS * COLOUR_BINS;
    const count = this.groupFill;
    count.fill(0);
    const bin = this.starBin;
    for (let i = 0; i < n; i += 1) {
      if (on[i] === 0) {
        bin[i] = -1;
        continue;
      }
      const m = eff[i]!;
      if (m > cut) {
        bin[i] = -1;
        continue;
      }
      // Faint first: the magnitude bins run from bright (0) to faint, so reverse them.
      const b = (MAG_BINS - 1 - magBin(m)) * COLOUR_BINS + cbin[i]!;
      bin[i] = b;
      count[b]! += 1;
    }
    const start = this.groupStart;
    start[0] = 0;
    for (let b = 0; b < nb; b += 1) start[b + 1] = start[b]! + count[b]!;
    // Reuse `count` as the fill cursor.
    for (let b = 0; b < nb; b += 1) count[b] = start[b]!;
    const order = this.frameOrder;
    for (let i = 0; i < n; i += 1) {
      const b = bin[i]!;
      if (b >= 0) order[count[b]!++] = i;
    }
    for (let b = 0; b < nb; b += 1) {
      const a0 = start[b]!;
      const a1 = start[b + 1]!;
      if (a1 === a0) continue;
      const mb = MAG_BINS - 1 - Math.floor(b / COLOUR_BINS);
      const cb = b % COLOUR_BINS;
      const mag = binMagnitude(mb);
      const alpha = starAlpha(mag, limit);
      if (alpha <= 0.01) continue;
      const r = starRadius(mag) * f.zoom;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.starFill[cb]!;
      ctx.beginPath();
      if (r < 1.1) {
        const side = r * 1.772; // same area as the disc
        const hs = side / 2;
        for (let k = a0; k < a1; k += 1) {
          const i = order[k]!;
          ctx.rect(xs[i]! - hs, ys[i]! - hs, side, side);
        }
      } else {
        for (let k = a0; k < a1; k += 1) {
          const i = order[k]!;
          const x = xs[i]!;
          const y = ys[i]!;
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, TAU);
        }
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.starGlows(f);
    this.navMarks(f);
  }

  private starGlows(f: Frame): void {
    const s = f.scene;
    const data = s.stars!;
    if (this.brightFor !== data) {
      const list: number[] = [];
      for (let i = 0; i < data.count; i += 1) if (data.vmag[i]! < 1.5) list.push(i);
      this.bright = Int32Array.from(list);
      this.brightFor = data;
    }
    const ctx = this.ctx;
    for (let k = 0; k < this.bright.length; k += 1) {
      const i = this.bright[k]!;
      if (s.onScreen[i] === 0) continue;
      const m = s.effMag[i]!;
      if (m >= 1.5) continue; // dimmed by the air below a glow
      const a = starAlpha(m, f.limitMag);
      if (a <= 0.05) continue;
      const sprite = this.glowSprite(data.bv[i]!);
      if (!sprite) continue;
      const r = starRadius(m) * f.zoom * (2.2 + 0.35 * (1.5 - m));
      ctx.globalAlpha = a * 0.65;
      ctx.drawImage(sprite, s.x[i]! - r, s.y[i]! - r, 2 * r, 2 * r);
    }
    ctx.globalAlpha = 1;
  }

  private glowSprite(bv: number): HTMLCanvasElement | null {
    const bin = colourBin(bv);
    const cached = this.glowSprites[bin];
    if (cached) return cached;
    if (typeof document === 'undefined') return null;
    const size = 64;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g2 = c.getContext('2d');
    if (!g2) return null;
    const rgb = this.starRgb[bin]!;
    const g = g2.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, css(rgb, 0.9));
    g.addColorStop(0.18, css(rgb, 0.35));
    g.addColorStop(0.5, css(rgb, 0.08));
    g.addColorStop(1, css(rgb, 0));
    g2.fillStyle = g;
    g2.fillRect(0, 0, size, size);
    this.glowSprites[bin] = c;
    return c;
  }

  /** The 58 navigational stars: a thin ring, fading with the star. */
  private navMarks(f: Frame): void {
    const s = f.scene;
    const data = s.stars!;
    const ctx = this.ctx;
    ctx.strokeStyle = css(f.palette.accent);
    ctx.lineWidth = 0.9;
    // Alpha differs per star; batch by a few levels.
    for (const level of [0.25, 0.5, 0.75, 1]) {
      ctx.globalAlpha = 0.6 * level;
      ctx.beginPath();
      let any = false;
      for (const [, i] of data.navByName) {
        if (s.onScreen[i] === 0) continue;
        const a = starAlpha(s.effMag[i]!, f.limitMag);
        const q = a > 0.75 ? 1 : a > 0.5 ? 0.75 : a > 0.25 ? 0.5 : a > 0.05 ? 0.25 : 0;
        if (q !== level) continue;
        const r = starRadius(s.effMag[i]!) * f.zoom + 3.2;
        ctx.moveTo(s.x[i]! + r, s.y[i]!);
        ctx.arc(s.x[i]!, s.y[i]!, r, 0, TAU);
        any = true;
      }
      if (any) ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // Sun, Moon and planets
  // -------------------------------------------------------------------------

  private updateBodies(f: Frame): void {
    this.bodies.length = 0;
    for (const m of this.marks.values()) {
      m.state = null;
      m.drawn = false;
    }
    if (!f.sky) return;
    const p = f.projector;
    for (const b of f.sky.bodies) {
      if (b.kind === 'star') continue;
      let m = this.marks.get(b.body);
      if (!m) {
        m = { key: bodyKey(b.body), name: b.body, kind: b.kind, state: null, alt: 0, az: 0, x: 0, y: 0, r: 0, drawn: false };
        this.marks.set(b.body, m);
      }
      m.state = b;
      m.alt = b.alt_apparent_deg * DEG;
      m.az = b.az_deg * DEG;
      const ok = p.project(m.alt, m.az);
      m.x = p.x;
      m.y = p.y;
      const sdPx = (b.semidiameter_arcmin / 60) * DEG * p.scaleAt(m.alt);
      // The Sun and Moon are never smaller than a readable disc (their true size is
      // under a pixel in the dome); zoomed in, the Moon grows so its phase reads.
      m.r =
        b.kind === 'sun'
          ? Math.max(7 * f.zoom, sdPx)
          : b.kind === 'moon'
            ? Math.max(6.5 * f.zoom * f.zoom, sdPx)
            : planetRadius(b.magnitude) * f.zoom;
      const sd = (b.semidiameter_arcmin / 60) * DEG;
      m.drawn = ok && m.alt + sd >= 0 && m.x > -20 && m.x < f.width + 20 && m.y > -20 && m.y < f.height + 20;
      this.bodies.push(m);
    }
  }

  private drawBodies(f: Frame): void {
    // Faint to bright, then the Moon, then the Sun on top.
    const order = (m: BodyMark): number => (m.kind === 'sun' ? 2 : m.kind === 'moon' ? 1 : 0);
    const list = this.bodies.filter((m) => m.drawn).sort((a, b) => order(a) - order(b));
    for (const m of list) {
      if (m.kind === 'planet') this.planet(f, m);
      else if (m.kind === 'moon') this.moon(f, m);
      else this.sun(f, m);
    }
  }

  private planet(f: Frame, m: BodyMark): void {
    const ctx = this.ctx;
    const colour = f.palette.body[bodyToken(m.name)];
    const mag = m.state?.magnitude ?? 3;
    // Planets never vanish entirely (they are named bodies of the explorer), but they
    // fade with the sky like stars.
    const a = Math.max(0.5, starAlpha(mag, f.limitMag));
    const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 3.2);
    g.addColorStop(0, css(colour, 0.45 * a));
    g.addColorStop(1, css(colour, 0));
    ctx.fillStyle = g;
    ctx.fillRect(m.x - m.r * 3.2, m.y - m.r * 3.2, m.r * 6.4, m.r * 6.4);
    ctx.globalAlpha = a;
    ctx.fillStyle = css(colour);
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, TAU);
    ctx.fill();
    // The shared casing, so a pale planet still shows on a light sky.
    ctx.strokeStyle = css(f.palette.halo, f.palette.haloAlpha * (f.colours.light ? 0.8 : 0.45));
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private sun(f: Frame, m: BodyMark): void {
    const ctx = this.ctx;
    const colour = f.palette.body.sun;
    const g = ctx.createRadialGradient(m.x, m.y, m.r * 0.6, m.x, m.y, m.r * 3.4);
    g.addColorStop(0, css(colour, 0.55));
    g.addColorStop(1, css(colour, 0));
    ctx.fillStyle = g;
    ctx.fillRect(m.x - m.r * 3.4, m.y - m.r * 3.4, m.r * 6.8, m.r * 6.8);
    ctx.fillStyle = css(colour);
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = css(f.palette.filter(mix(colour, WHITE, 0.5)), 0.9);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /**
   * The Moon with its phase: the lit part is the bright-limb half-disc plus or minus half
   * of the terminator ellipse (semi-axis `r·|2k − 1|` along the bright-limb direction),
   * turned to `bright_limb_angle − parallactic_angle` from the zenith (EXPLORER_API).
   */
  private moon(f: Frame, m: BodyMark): void {
    const ctx = this.ctx;
    const st = m.state;
    const colour = f.palette.moonDisc;
    // The unlit part is always darker than the lit part (the design's phase disc).
    const dark = mix(colour, f.colours.zenith, 0.74);
    const r = m.r;
    // Earthshine side.
    ctx.fillStyle = css(dark, 0.92);
    ctx.beginPath();
    ctx.arc(m.x, m.y, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = css(colour, 0.45);
    ctx.lineWidth = 1;
    ctx.stroke();
    const k = st?.illuminated_fraction;
    const limb = st?.bright_limb_angle_deg;
    ctx.fillStyle = css(colour);
    if (k === null || k === undefined || limb === null || limb === undefined || !Number.isFinite(k)) {
      ctx.beginPath();
      ctx.arc(m.x, m.y, r, 0, TAU);
      ctx.fill();
      return;
    }
    if (k < 0.005) return;
    f.projector.upAt(m.x, m.y, this.up);
    const angle = brightLimbScreenAngle(limb, st!.parallactic_angle_deg, this.up.x, this.up.y);
    const xt = r * (1 - 2 * k); // terminator's crossing of the bright-limb axis
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(angle);
    ctx.beginPath();
    // Bright limb: from the top (−90°) through the bright side (+x) to the bottom.
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    // Terminator back up: on the dark side when gibbous (xt < 0), the bright side when crescent.
    ctx.ellipse(0, 0, Math.max(0.001, Math.abs(xt)), r, 0, Math.PI / 2, -Math.PI / 2, xt > 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** The part of the path below the horizon, over the ground: thin and dashed. */
  private pathBelow(f: Frame, path: PathData): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, (f.projector as PanoramaProjector).yHorizon, f.width, f.height);
    ctx.clip();
    ctx.setLineDash(f.palette.dashBelow.length ? f.palette.dashBelow : [3, 5]);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = css(f.palette.body[path.bodyKey], 0.8);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    this.pathTrace(f, path, false);
    ctx.stroke();
    ctx.restore();
  }

  /** A body glyph (theme/glyphs.ts shapes) centred at (x, y), over the shared casing. */
  private glyph(f: Frame, name: GlyphName, x: number, y: number, size: number, colour: Rgb): void {
    if (typeof Path2D !== 'function') return;
    let g = this.glyphs.get(name);
    if (!g) {
      const shape = glyphShape(name);
      const stroke = (shape.stroke ?? []).map((d) => new Path2D(d));
      for (const [cx, cy, r] of shape.circles ?? []) {
        const c = new Path2D();
        c.arc(cx, cy, r, 0, TAU);
        stroke.push(c);
      }
      g = { fill: (shape.fill ?? []).map((d) => new Path2D(d)), stroke };
      this.glyphs.set(name, g);
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x - size / 2, y - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const halo = css(f.palette.halo, f.palette.haloAlpha);
    ctx.strokeStyle = halo;
    ctx.fillStyle = halo;
    ctx.lineWidth = 1.9 + 3.2;
    for (const p of g.stroke) ctx.stroke(p);
    ctx.lineWidth = 3.2;
    for (const p of g.fill) {
      ctx.stroke(p);
      ctx.fill(p);
    }
    const c = css(colour);
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = 1.9;
    for (const p of g.stroke) ctx.stroke(p);
    for (const p of g.fill) ctx.fill(p);
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  private labels(f: Frame): void {
    const ctx = this.ctx;
    const s = f.scene;
    const ink = f.colours.ink;
    const halo = f.colours.light ? f.colours.horizon : f.colours.zenith;
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';

    // Forced labels first: selection, highlights, focus.
    const forced = new Set<string>();
    if (f.selectedKey) forced.add(f.selectedKey);
    for (const key of f.highlightKeys) forced.add(key);
    if (f.focusKey) forced.add(f.focusKey);

    // Sun, Moon, planets: glyph and name (colour is never the only cue). Brightest
    // first, so a crowded twilight horizon keeps Venus's name over Mercury's; a label
    // that does not fit on the right tries the left.
    const bodyFont = `600 12px ${f.palette.fontUi}`;
    const rank = (m: BodyMark): number => (m.kind === 'sun' ? -100 : m.kind === 'moon' ? -50 : (m.state?.magnitude ?? 9));
    const ordered = this.bodies.filter((m) => m.drawn).sort((a, b) => rank(a) - rank(b));
    for (const m of ordered) {
      const text = m.name;
      const glyph = 14;
      const width = glyph + 3 + this.width(text, bodyFont);
      const y = m.y + 4;
      let x = m.x + m.r + 4;
      if (!this.place(x - 1, y - 12, width + 2, 16)) {
        x = m.x - m.r - 4 - width;
        if (!this.place(x - 1, y - 12, width + 2, 16) && !forced.has(m.key)) continue;
      }
      const token = bodyToken(m.name);
      const colour = m.kind === 'planet' ? f.palette.body[token] : m.kind === 'sun' ? f.palette.body.sun : f.palette.moonDisc;
      this.glyph(f, token as GlyphName, x + glyph / 2, m.y, glyph, colour);
      ctx.font = bodyFont;
      ctx.textAlign = 'left';
      // Body-coloured names read on a dark sky; on a light (day) sky the ink does.
      const nameColour = m.kind === 'planet' && !f.colours.light ? colour : ink;
      this.haloText(text, x + glyph + 3, y, css(nameColour, 0.95), halo);
    }

    // Reference lines: after the bodies, before the stars.
    for (const l of this.lineLabels) this.tagText(f, l.text, l.x, l.y, l.fill, `600 10.5px ${f.palette.fontUi}`, l.centred ? 'center' : 'left');

    // Star names.
    const data = s.stars;
    if (data && s.starsOk) {
      ctx.font = `500 11px ${f.palette.fontUi}`;
      // Fewer names on a small chart (a phone), more when the panorama is zoomed in.
      const p0 = f.projector;
      const sizeLimit = p0 instanceof DomeProjector ? Math.min(1.6, Math.max(0.6, p0.radius / 190 - 0.3)) : 1.6 + 1.2 * (f.zoom - 1);
      const nameLimit = Math.min(f.limitMag + 0.5, sizeLimit);
      const roomyNames = !(p0 instanceof DomeProjector) || p0.radius >= 230;
      for (let k = 0; k < data.named.length; k += 1) {
        const i = data.named[k]!;
        if (s.onScreen[i] === 0) continue;
        const key = starKey(i);
        const nav = data.isNav[i] === 1;
        const mag = s.effMag[i]!;
        const isForced = forced.has(key);
        if (!isForced && (!f.layers.starNames || (mag > nameLimit && !(nav && mag <= nameLimit + 1 && roomyNames)))) continue;
        const text = data.nameOf.get(i)!;
        const r = starRadius(mag) * f.zoom;
        const w = this.width(text, ctx.font);
        let x = s.x[i]! + r + 3;
        const y = s.y[i]! - r - 1;
        if (!this.place(x - 1, y - 10, w + 2, 13)) {
          x = s.x[i]! - r - 3 - w;
          if (!this.place(x - 1, y - 10, w + 2, 13) && !isForced) continue;
        }
        const a = Math.max(0.55, Math.min(1, starAlpha(mag, f.limitMag) + 0.3));
        this.haloText(text, x, y, css(ink, (nav ? 0.95 : 0.8) * a), halo);
      }
      // Forced stars without a proper name (a pinned catalogue star).
      for (const key of forced) {
        if (!key.startsWith('s:')) continue;
        const i = Number(key.slice(2));
        if (!(i >= 0 && i < s.n) || s.onScreen[i] === 0 || data.nameOf.has(i)) continue;
        const text = starTitle(data, i);
        const r = starRadius(s.effMag[i]!) * f.zoom;
        const x = s.x[i]! + r + 3;
        const y = s.y[i]! - r - 1;
        this.place(x - 1, y - 10, this.width(text, ctx.font) + 2, 13);
        this.haloText(text, x, y, css(ink, 0.95), halo);
      }
    }

    // Constellation names, last and quietest.
    const cat = s.catalog;
    const roomy = !(f.projector instanceof DomeProjector) || f.projector.radius >= 230;
    if (cat && f.layers.constellationNames && roomy) {
      const p = f.projector;
      ctx.font = `600 10px ${f.palette.fontUi}`;
      ctx.textAlign = 'center';
      const spacing = 'letterSpacing' in ctx;
      if (spacing) (ctx as Ctx2D & { letterSpacing: string }).letterSpacing = '1.2px';
      const ch = s.ch;
      for (let c = 0; c < cat.constellations.length; c += 1) {
        const h = ch.alt[c]!;
        if (h < 4 * DEG || !p.projectDir(h, ch.sinAlt[c]!, ch.cosAlt[c]!, ch.sinAz[c]!, ch.cosAz[c]!)) continue;
        if (p.x < 0 || p.x > f.width || p.y < 0 || p.y > f.height) continue;
        const text = cat.constellations[c]!.name.toUpperCase();
        const w = this.width(text, ctx.font) + (spacing ? text.length * 1.2 : 0);
        if (!this.place(p.x - w / 2, p.y - 9, w, 12)) continue;
        ctx.fillStyle = css(ink, f.colours.light ? 0.5 : 0.42);
        ctx.fillText(text, p.x, p.y);
      }
      if (spacing) (ctx as Ctx2D & { letterSpacing: string }).letterSpacing = '0px';
    }
    ctx.textAlign = 'left';
  }

  private haloText(text: string, x: number, y: number, fill: string, halo: Rgb): void {
    const ctx = this.ctx;
    ctx.strokeStyle = css(halo, 0.7);
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  private tagText(f: Frame, text: string, x: number, y: number, fill: string, font: string, align: CanvasTextAlign): void {
    const ctx = this.ctx;
    ctx.font = font;
    ctx.textAlign = align;
    const w = this.width(text, font);
    const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    if (!this.place(x0, y - 10, w, 13)) return;
    this.haloText(text, x, y, fill, f.colours.light ? f.colours.horizon : f.colours.zenith);
  }

  private width(text: string, font: string): number {
    const key = `${font}\u0000${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      this.widths.set(key, w);
      if (this.widths.size > 4000) this.widths.clear();
    }
    return w;
  }

  /** Reserve a rectangle for a label; false when it would overlap one already placed. */
  private place(x: number, y: number, w: number, h: number): boolean {
    const r = this.rects;
    for (let k = 0; k < this.rectCount; k += 1) {
      const o = 4 * k;
      if (x < r[o]! + r[o + 2]! && x + w > r[o]! && y < r[o + 1]! + r[o + 3]! && y + h > r[o + 1]!) return false;
    }
    this.reserve(x, y, w, h);
    return true;
  }

  private reserve(x: number, y: number, w: number, h: number): void {
    if (this.rectCount * 4 + 4 > this.rects.length) {
      const bigger = new Float32Array(this.rects.length * 2);
      bigger.set(this.rects);
      this.rects = bigger;
    }
    const o = 4 * this.rectCount;
    this.rects[o] = x;
    this.rects[o + 1] = y;
    this.rects[o + 2] = w;
    this.rects[o + 3] = h;
    this.rectCount += 1;
  }

  // -------------------------------------------------------------------------
  // sky2 agent: the Milky Way, the RA/Dec grid, deep-sky objects, radiants,
  // added bodies and the field of view
  // -------------------------------------------------------------------------

  /** The glow's raster, drawn scaled up with smoothing (the soft edge is the point). */
  private milkyWay(_f: Frame, img: MilkyWayImage): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(img.source, 0, 0, img.width, img.height, 0, 0, img.width * img.cell, img.height * img.cell);
    ctx.restore();
  }

  /** Hour circles and parallels of date, dashed, with hours on the equator and declinations up the meridian. */
  private raDecGrid(f: Frame): void {
    const ctx = this.ctx;
    const s = f.scene;
    const g = s.raDec;
    const hb = s.raDecH;
    const colour = f.palette.raDec;
    ctx.strokeStyle = css(colour, f.colours.light ? 0.5 : 0.42);
    ctx.lineWidth = 0.9;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (let k = 0; k < g.count; k += 1) this.polyline(f, hb, g.start[k]!, g.start[k + 1]!, -8 * DEG);
    ctx.stroke();
    ctx.setLineDash([]);
    const p = f.projector;
    const fill = css(colour, 0.95);
    const at = (i: number): boolean =>
      hb.alt[i]! > 3 * DEG &&
      p.projectDir(hb.alt[i]!, hb.sinAlt[i]!, hb.cosAlt[i]!, hb.sinAz[i]!, hb.cosAz[i]!) &&
      p.x > 4 &&
      p.x < f.width - 30 &&
      p.y > 14 &&
      p.y < f.height - 6;
    // Hours where each hour circle meets the equator.
    for (let k = 0; k < g.count; k += 1) {
      const hour = g.hourOf[k]!;
      if (!Number.isFinite(hour)) continue;
      const mid = g.start[k]! + Math.floor((g.start[k + 1]! - g.start[k]! - 1) / 2);
      if (at(mid)) this.lineLabels.push({ text: `${hour}h`, x: p.x + 3, y: p.y - 3, fill });
    }
    // Declinations up the hour circle nearest the local meridian.
    const hourNow = Math.round(s.lst / 15) % 24;
    const k = hourNow;
    const a = g.start[k]!;
    const b = g.start[k + 1]!;
    const reach = (b - a - 1) / 2; // points each side of the equator, 2° apart
    for (let dec = -80; dec <= 80; dec += 10) {
      if (dec === 0) continue;
      const i = a + reach + dec / 2;
      if (i < a || i >= b || !at(i)) continue;
      this.lineLabels.push({ text: `${dec > 0 ? '+' : '−'}${Math.abs(dec)}°`, x: p.x + 3, y: p.y - 3, fill });
    }
  }

  private dsoColours: DsoColours | null = null;
  private dsoColoursFor: SkyPalette | null = null;

  private deepSkyColours(f: Frame): DsoColours {
    if (!this.dsoColours || this.dsoColoursFor !== f.palette) {
      const d = f.palette.dso;
      this.dsoColours = {
        galaxy: css(d.galaxy),
        nebula: css(d.nebula),
        cluster: css(d.cluster),
        other: css(d.other),
        halo: css(f.palette.halo, f.palette.haloAlpha * 0.75),
      };
      this.dsoColoursFor = f.palette;
    }
    return this.dsoColours;
  }

  private deepSky(f: Frame, field: DeepSkyField): void {
    const index = (key: string | null): number => (key?.startsWith('d:') ? Number(key.slice(2)) : -1);
    drawDeepSkySymbols(this.ctx, field, this.deepSkyColours(f), index(f.selectedKey), index(f.hoverKey));
  }

  /** A meteor radiant: a small ring with eight rays, the stronger showers larger. */
  private radiantMarks(f: Frame, list: RadiantMark[]): void {
    const ctx = this.ctx;
    const p = f.projector;
    const colour = css(f.palette.radiant);
    const halo = css(f.palette.halo, f.palette.haloAlpha * 0.8);
    for (const m of list) {
      m.drawn = m.alt >= 0 && p.project(m.alt, m.az) && p.x > -10 && p.x < f.width + 10 && p.y > -10 && p.y < f.height + 10;
      m.x = p.x;
      m.y = p.y;
      if (!m.drawn) continue;
      const r = 3 + 2.5 * m.strength;
      const ray = r + 3 + 3 * m.strength;
      ctx.beginPath();
      ctx.moveTo(m.x + r, m.y);
      ctx.arc(m.x, m.y, r, 0, TAU);
      for (let k = 0; k < 8; k += 1) {
        const a = (k * Math.PI) / 4;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        ctx.moveTo(m.x + c * (r + 2), m.y + sn * (r + 2));
        ctx.lineTo(m.x + c * ray, m.y + sn * ray);
      }
      ctx.lineCap = 'round';
      ctx.strokeStyle = halo;
      ctx.lineWidth = 3.4;
      ctx.stroke();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  /** Added comets (a dot with a tail away from the Sun) and asteroids (a small diamond). */
  private customMarks(f: Frame, list: CustomMark[]): void {
    const ctx = this.ctx;
    const p = f.projector;
    const colour = css(f.palette.custom);
    const halo = css(f.palette.halo, f.palette.haloAlpha);
    for (const m of list) {
      m.drawn = m.alt >= 0 && p.project(m.alt, m.az) && p.x > -10 && p.x < f.width + 10 && p.y > -10 && p.y < f.height + 10;
      m.x = p.x;
      m.y = p.y;
      if (!m.drawn) continue;
      ctx.lineWidth = 1.5;
      if (m.kind === 'comet') {
        let tail: { dx: number; dy: number } | null = null;
        if (m.sunward && p.project(m.sunward.alt, m.sunward.az)) {
          const dx = m.x - p.x;
          const dy = m.y - p.y;
          const len = Math.hypot(dx, dy);
          if (len > 1e-6) tail = { dx: dx / len, dy: dy / len };
        }
        if (tail) {
          const len = 18;
          ctx.beginPath();
          ctx.moveTo(m.x, m.y);
          ctx.lineTo(m.x + tail.dx * len, m.y + tail.dy * len);
          ctx.strokeStyle = halo;
          ctx.lineWidth = 4;
          ctx.stroke();
          const g = ctx.createLinearGradient(m.x, m.y, m.x + tail.dx * len, m.y + tail.dy * len);
          g.addColorStop(0, css(f.palette.custom, 0.95));
          g.addColorStop(1, css(f.palette.custom, 0));
          ctx.strokeStyle = g;
          ctx.lineWidth = 2.2;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(m.x, m.y, 3, 0, TAU);
        ctx.fillStyle = colour;
        ctx.strokeStyle = halo;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fill();
      } else {
        const r = 3.6;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y - r);
        ctx.lineTo(m.x + r, m.y);
        ctx.lineTo(m.x, m.y + r);
        ctx.lineTo(m.x - r, m.y);
        ctx.closePath();
        ctx.fillStyle = colour;
        ctx.strokeStyle = halo;
        ctx.stroke();
        ctx.fill();
      }
    }
  }

  /** The field-of-view outline over the shared casing, and its label above it. */
  private fovOutline(f: Frame, fov: FovOutline): void {
    const ctx = this.ctx;
    const p = f.projector;
    const pts = fov.points;
    const jump = f.width * 0.5;
    ctx.beginPath();
    let pen = false;
    let px = 0;
    let topX = Number.NaN;
    let topY = Infinity;
    for (let k = 0; k < fov.count; k += 1) {
      const e = pts[3 * k]!;
      const n = pts[3 * k + 1]!;
      const u = pts[3 * k + 2]!;
      const alt = Math.asin(Math.max(-1, Math.min(1, u)));
      if (alt < -12 * DEG || !p.project(alt, azimuthOf(e, n))) {
        pen = false;
        continue;
      }
      if (pen && Math.abs(p.x - px) > jump) pen = false;
      if (pen) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
      pen = true;
      px = p.x;
      if (p.y < topY && alt > 0) {
        topY = p.y;
        topX = p.x;
      }
    }
    ctx.strokeStyle = css(f.palette.halo, f.palette.haloAlpha * 0.85);
    ctx.lineWidth = 3.6;
    ctx.stroke();
    ctx.strokeStyle = css(f.colours.ink, 0.92);
    ctx.lineWidth = 1.6;
    ctx.stroke();
    if (Number.isFinite(topX) && fov.label) {
      this.lineLabels.unshift({ text: fov.label, x: topX, y: Math.max(14, topY - 6), fill: css(f.colours.ink, 0.95), centred: true });
    }
  }

  // -------------------------------------------------------------------------
  // Selection, highlight, focus and hover rings
  // -------------------------------------------------------------------------

  /** Where a target is drawn now, or null. */
  locate(f: Frame, key: string): { x: number; y: number; r: number; alt: number; az: number } | null {
    if (key.startsWith('b:')) {
      const m = this.marks.get(key.slice(2));
      if (!m?.state) return null;
      return { x: m.x, y: m.y, r: m.r, alt: m.alt, az: m.az };
    }
    // sky2 agent: deep-sky objects, radiants, added bodies, constellations.
    if (key.startsWith('d:')) {
      const field = f.scene.dso;
      const i = Number(key.slice(2));
      if (!(i >= 0 && i < field.n)) return null;
      const h = field.h;
      const alt = h.alt[i]!;
      const az = azimuthOf(h.sinAz[i]!, h.cosAz[i]!);
      if (Number.isNaN(field.x[i]!)) {
        const p = f.projector;
        const ok = p.projectDir(alt, h.sinAlt[i]!, h.cosAlt[i]!, h.sinAz[i]!, h.cosAz[i]!);
        return { x: ok ? p.x : Number.NaN, y: ok ? p.y : Number.NaN, r: field.radius[i]! || 6, alt, az };
      }
      return { x: field.x[i]!, y: field.y[i]!, r: Math.max(field.radius[i]!, 5), alt, az };
    }
    if (key.startsWith('r:')) {
      const m = f.radiants?.find((r) => r.key === key);
      if (!m) return null;
      const p = f.projector;
      const ok = p.project(m.alt, m.az);
      return { x: ok ? p.x : Number.NaN, y: ok ? p.y : Number.NaN, r: 6, alt: m.alt, az: m.az };
    }
    if (key.startsWith('c:')) {
      const m = f.custom?.find((c) => c.key === key);
      if (!m) return null;
      const p = f.projector;
      const ok = p.project(m.alt, m.az);
      return { x: ok ? p.x : Number.NaN, y: ok ? p.y : Number.NaN, r: 4, alt: m.alt, az: m.az };
    }
    if (key.startsWith('k:')) {
      const c = Number(key.slice(2));
      const ch = f.scene.ch;
      if (!(c >= 0 && c < ch.alt.length)) return null;
      const p = f.projector;
      const alt = ch.alt[c]!;
      const az = azimuthOf(ch.sinAz[c]!, ch.cosAz[c]!);
      const ok = p.projectDir(alt, ch.sinAlt[c]!, ch.cosAlt[c]!, ch.sinAz[c]!, ch.cosAz[c]!);
      return { x: ok ? p.x : Number.NaN, y: ok ? p.y : Number.NaN, r: 10, alt, az };
    }
    const i = Number(key.slice(2));
    const s = f.scene;
    if (!(i >= 0 && i < s.n) || !s.starsOk || !s.stars) return null;
    const r = starRadius(s.effMag[i]!) * f.zoom;
    return { x: s.x[i]!, y: s.y[i]!, r, alt: s.starAlt(i), az: s.starAz(i) };
  }

  private rings(f: Frame): void {
    const ctx = this.ctx;
    const ring = (key: string, extra: number, colour: string, width: number, dash: number[]): void => {
      const at = this.locate(f, key);
      if (!at || at.alt < 0 || Number.isNaN(at.x)) return;
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.arc(at.x, at.y, at.r + extra, 0, TAU);
      ctx.stroke();
    };
    const accent = f.palette.accent;
    for (const key of f.highlightKeys) ring(key, 8, css(accent, 0.95), 1.6, [3, 3]);
    if (f.selectedKey) {
      ring(f.selectedKey, 5, css(accent), 2.2, []);
    }
    if (f.hoverKey && f.hoverKey !== f.selectedKey) ring(f.hoverKey, 5, css(f.colours.ink, 0.7), 1.2, []);
    if (f.focusKey) ring(f.focusKey, 11, css(f.colours.light ? f.palette.stageFocus : f.palette.focus), 2, [4, 3]);
    ctx.setLineDash([]);
  }

  /** The selected body when it is below the horizon: a mark on the horizon at its bearing. */
  private belowHorizonMarker(f: Frame): void {
    if (!f.selectedKey) return;
    const at = this.locate(f, f.selectedKey);
    if (!at || at.alt >= 0) return;
    const p = f.projector;
    if (!p.project(0, at.az)) return;
    const ctx = this.ctx;
    const x = p.x;
    const y = p.y;
    // A small chevron pointing down, just above the horizon, toward the body.
    let dx = 0;
    let dy = 1;
    if (p instanceof DomeProjector) {
      const r = Math.hypot(x - p.cx, y - p.cy) || 1;
      dx = (x - p.cx) / r;
      dy = (y - p.cy) / r;
    }
    const bx = x - dx * 10;
    const by = y - dy * 10;
    ctx.fillStyle = css(f.palette.accent);
    ctx.beginPath();
    ctx.moveTo(bx + dx * 7, by + dy * 7);
    ctx.lineTo(bx - dy * 5 - dx * 2, by + dx * 5 - dy * 2);
    ctx.lineTo(bx + dy * 5 - dx * 2, by - dx * 5 - dy * 2);
    ctx.closePath();
    ctx.fill();
    const name = f.selectedKey.startsWith('b:') ? f.selectedKey.slice(2) : starTitle(f.scene.stars!, Number(f.selectedKey.slice(2)));
    const text = `${name} ${Math.round(-at.alt * RAD)}° below`;
    ctx.font = `600 11px ${f.palette.fontUi}`;
    ctx.textAlign = 'center';
    this.haloText(text, bx - dx * 16, by - dy * 16 + 4, css(f.palette.accent), f.colours.light ? f.colours.horizon : f.colours.zenith);
    ctx.textAlign = 'left';
  }
}

function wrap180(deg: number): number {
  const x = (((deg + 180) % 360) + 360) % 360 - 180;
  return x;
}
