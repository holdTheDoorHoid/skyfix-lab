/**
 * Deep-sky objects in the Sky view: their places each frame, which are shown, and their
 * symbols. OWNER: sky2 agent (expansion Q3).
 *
 * Engine use (EXPLORER_API "deep sky"): `dso_catalog()` once; `dso_list(null, jd)` — the
 * 213 apparent places of date, the frame of `starfield_apparent` — at most once per
 * simulated hour (the scene's bucket), as for the stars. The per-frame rotation into the
 * horizon, display refraction and projection are the stars' own (astro.ts).
 *
 * What is shown: objects above the horizon whose magnitude, dimmed by extinction toward
 * the horizon (when that layer is on), is within the deep-sky limit: the sky's zenith
 * limit plus a reach that grows with the zoom (`dsoReach`): an object a pair of
 * binoculars shows is drawn on the whole-sky chart; zoomed in, telescope objects join.
 * The dozen large nebulae without a meaningful integrated magnitude count as 7.0.
 *
 * Symbols (the usual atlas convention; shape carries the type, colour only reinforces
 * it): galaxy — an ellipse with the object's axis ratio; open cluster — a dotted circle;
 * globular cluster — a circle with a cross; nebula (emission, reflection, supernova
 * remnant) — a square; planetary nebula — a circle with four spikes; cluster with nebula
 * — a dotted circle in a square; anything else (star cloud, double, asterism) — a
 * diamond. Sized by the object's apparent size with a readable minimum, so the Andromeda
 * Galaxy is drawn larger than the Ring Nebula.
 */

import type { Dso, DsoCatalog, DsoType, ExplorerEngine } from '../engine/types.js';
import { isDeepSkyEngine } from '../engine/types.js';
import { DEG, horizonBuffers, horizonDirections, unitFromRaDec, type HorizonBuffers } from './astro.js';
import { extinctionAt } from './conditions.js';
import type { Projector } from './projection.js';

export const DsoShape = {
  Galaxy: 0,
  OpenCluster: 1,
  Globular: 2,
  Nebula: 3,
  Planetary: 4,
  ClusterNebula: 5,
  Other: 6,
} as const;
export type DsoShape = (typeof DsoShape)[keyof typeof DsoShape];

export function dsoShape(type: DsoType): DsoShape {
  switch (type) {
    case 'spiral_galaxy':
    case 'elliptical_galaxy':
    case 'lenticular_galaxy':
    case 'irregular_galaxy':
      return DsoShape.Galaxy;
    case 'open_cluster':
      return DsoShape.OpenCluster;
    case 'globular_cluster':
      return DsoShape.Globular;
    case 'planetary_nebula':
      return DsoShape.Planetary;
    case 'emission_nebula':
    case 'reflection_nebula':
    case 'supernova_remnant':
      return DsoShape.Nebula;
    case 'cluster_with_nebula':
      return DsoShape.ClusterNebula;
    default:
      return DsoShape.Other;
  }
}

/** Plain words for a type ("Spiral galaxy"), for cards and the search. */
export const DSO_TYPE_WORDS: Record<DsoType, string> = {
  open_cluster: 'Open star cluster',
  globular_cluster: 'Globular star cluster',
  planetary_nebula: 'Planetary nebula',
  emission_nebula: 'Emission nebula',
  reflection_nebula: 'Reflection nebula',
  supernova_remnant: 'Supernova remnant',
  cluster_with_nebula: 'Star cluster with nebula',
  spiral_galaxy: 'Spiral galaxy',
  elliptical_galaxy: 'Elliptical galaxy',
  lenticular_galaxy: 'Lenticular galaxy',
  irregular_galaxy: 'Irregular galaxy',
  double_star: 'Double star',
  asterism: 'Asterism',
  star_cloud: 'Star cloud',
};

/** The magnitude a nebula without an integrated magnitude is cut at. */
export const NO_MAGNITUDE_AS = 7.0;

/** Smallest symbol radius, CSS px. */
export const MIN_SYMBOL_R = 4.2;

/**
 * How much fainter than the zenith's naked-eye limit a deep-sky object may be and still
 * be drawn, for a scale of `pxPerDeg` CSS pixels per degree: 1.5 magnitudes on a
 * whole-sky chart of a laptop screen (binocular objects), up to 4 zoomed in.
 */
export function dsoReach(pxPerDeg: number): number {
  const r = 1.5 + 1.6 * Math.log2(Math.max(1, pxPerDeg / 5));
  return Math.min(4, Math.max(1, r));
}

export class DeepSkyField {
  catalog: readonly Dso[] = [];
  n = 0;
  shape = new Uint8Array(0);
  /** Catalogue magnitude, or NO_MAGNITUDE_AS. */
  mag = new Float32Array(0);
  /** Apparent unit vectors of date (from `dso_list`). */
  units = new Float64Array(0);
  h: HorizonBuffers = horizonBuffers(0);
  x = new Float32Array(0);
  y = new Float32Array(0);
  /** Magnitude with extinction, this frame. */
  effMag = new Float32Array(0);
  /** Symbol radius, CSS px, this frame. */
  radius = new Float32Array(0);
  /** 1 when drawn this frame. */
  on = new Uint8Array(0);
  /** Index by id, cross id and label, lower case without spaces. */
  byKey = new Map<string, number>();
  /** Indices brightest first (label order). */
  byBrightness = new Int32Array(0);
  ok = false;
  error: string | null = null;
  private bucket = Number.NaN;
  source = '';

  /** Load the catalogue (once). False when the engine has no deep-sky calls. */
  load(engine: ExplorerEngine): boolean {
    if (this.n > 0) return true;
    if (!isDeepSkyEngine(engine)) {
      this.error = 'Deep-sky objects are not available in this engine.';
      return false;
    }
    let cat: DsoCatalog;
    try {
      cat = engine.dsoCatalog();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    }
    this.setCatalog(cat);
    return true;
  }

  setCatalog(cat: DsoCatalog): void {
    const n = cat.objects.length;
    this.catalog = cat.objects;
    this.source = cat.source;
    this.n = n;
    this.shape = new Uint8Array(n);
    this.mag = new Float32Array(n);
    this.units = new Float64Array(3 * n);
    this.h = horizonBuffers(n);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.effMag = new Float32Array(n);
    this.radius = new Float32Array(n);
    this.on = new Uint8Array(n);
    this.byKey.clear();
    cat.objects.forEach((o, i) => {
      this.shape[i] = dsoShape(o.type);
      this.mag[i] = o.magnitude ?? NO_MAGNITUDE_AS;
      // J2000 until the first `dso_list` (the engine's places replace these).
      unitFromRaDec(o.ra_j2000_deg * DEG, o.dec_j2000_deg * DEG, this.units, i);
      for (const k of [o.id, o.label, ...o.cross_ids]) this.byKey.set(dsoKey(k), i);
    });
    this.byBrightness = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => this.mag[a]! - this.mag[b]! || a - b);
    this.bucket = Number.NaN;
    this.error = null;
  }

  /** Places of date for this bucket (a simulated hour or day), from the engine. */
  ensureBucket(engine: ExplorerEngine, bucketJd: number): void {
    if (this.n === 0 || bucketJd === this.bucket || !isDeepSkyEngine(engine)) return;
    this.bucket = bucketJd;
    try {
      const pos = engine.dsoList(null, bucketJd);
      const idx = pos.index;
      for (let k = 0; k < idx.length; k += 1) {
        const i = idx[k]!;
        if (i >= 0 && i < this.n) unitFromRaDec(pos.ra_deg[k]! * DEG, pos.dec_deg[k]! * DEG, this.units, i);
      }
      this.ok = true;
      this.error = null;
    } catch (error) {
      this.ok = false;
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** Apparent altitude and azimuth this frame (the stars' horizon matrix and refraction). */
  update(hm: Float64Array, refraction: number): void {
    if (this.n) horizonDirections(this.units, this.n, hm, refraction, this.h, -25 * DEG);
  }

  /**
   * Screen places, dimmed magnitudes, symbol sizes and which are shown. `limit` is the
   * deep-sky limit (zenith limit + reach); `ext` the relative extinction (null: none).
   */
  project(p: Projector, width: number, height: number, limit: number, ext: Float32Array | null): number {
    const { alt, sinAlt, cosAlt, sinAz, cosAz } = this.h;
    let shown = 0;
    for (let i = 0; i < this.n; i += 1) {
      this.on[i] = 0;
      const a = alt[i]!;
      if (a < 0 || !p.projectDir(a, sinAlt[i]!, cosAlt[i]!, sinAz[i]!, cosAz[i]!)) {
        this.x[i] = Number.NaN;
        continue;
      }
      const x = p.x;
      const y = p.y;
      this.x[i] = x;
      this.y[i] = y;
      const m = this.mag[i]! + (ext ? extinctionAt(ext, a) : 0);
      this.effMag[i] = m;
      const o = this.catalog[i]!;
      const r = Math.max(MIN_SYMBOL_R, (o.major_arcmin / 120) * DEG * p.scaleAt(a));
      this.radius[i] = Math.min(r, 0.3 * Math.min(width, height));
      if (m > limit) continue;
      if (x < -r || x > width + r || y < -r || y > height + r) continue;
      this.on[i] = 1;
      shown += 1;
    }
    return shown;
  }

  /** The object nearest a screen point among those drawn, within its symbol plus `slop` px. */
  hit(x: number, y: number, slop = 5): { index: number; distance: number } | null {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.n; i += 1) {
      if (this.on[i] === 0) continue;
      const d = Math.hypot(this.x[i]! - x, this.y[i]! - y);
      const reach = Math.max(this.radius[i]!, 7) + slop;
      if (d > reach) continue;
      // A small symbol under the pointer wins over the big one it sits inside (M32 in M31).
      const score = d / reach;
      if (score < bestD) {
        bestD = score;
        best = i;
      }
    }
    return best < 0 ? null : { index: best, distance: bestD };
  }

  indexOf(id: string): number {
    return this.byKey.get(dsoKey(id)) ?? -1;
  }

  /** Right ascension and declination of date, degrees. */
  raDec(i: number): { ra: number; dec: number } {
    const u = this.units;
    let ra = Math.atan2(u[3 * i + 1]!, u[3 * i]!) / DEG;
    if (ra < 0) ra += 360;
    return { ra, dec: Math.asin(Math.max(-1, Math.min(1, u[3 * i + 2]!))) / DEG };
  }
}

/** Lower case, no spaces: "NGC 869" and "ngc869" meet. */
export function dsoKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------

export interface DsoColours {
  galaxy: string;
  nebula: string;
  cluster: string;
  other: string;
  halo: string;
}

type Ctx2D = CanvasRenderingContext2D;
const TAU = 2 * Math.PI;

function colourOf(shape: DsoShape, c: DsoColours): string {
  switch (shape) {
    case DsoShape.Galaxy:
      return c.galaxy;
    case DsoShape.Nebula:
    case DsoShape.Planetary:
      return c.nebula;
    case DsoShape.OpenCluster:
    case DsoShape.Globular:
    case DsoShape.ClusterNebula:
      return c.cluster;
    default:
      return c.other;
  }
}

/** Add one symbol's outline to the current path (and its dotted part to `dotted`). */
function symbolPath(ctx: Ctx2D, shape: DsoShape, x: number, y: number, r: number, ratio: number, dotted: boolean): void {
  switch (shape) {
    case DsoShape.Galaxy: {
      const ry = Math.max(r * Math.max(0.38, Math.min(1, ratio)), 2.6);
      ctx.moveTo(x + r, y);
      ctx.ellipse(x, y, r, ry, 0, 0, TAU);
      return;
    }
    case DsoShape.OpenCluster:
      if (dotted) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
      }
      return;
    case DsoShape.Globular: {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r);
      ctx.lineTo(x, y + r);
      return;
    }
    case DsoShape.Nebula:
      ctx.rect(x - r * 0.86, y - r * 0.86, r * 1.72, r * 1.72);
      return;
    case DsoShape.Planetary: {
      const c = Math.max(2.4, r * 0.62);
      ctx.moveTo(x + c, y);
      ctx.arc(x, y, c, 0, TAU);
      const s = c + Math.max(2.4, r * 0.55);
      ctx.moveTo(x + c, y);
      ctx.lineTo(x + s, y);
      ctx.moveTo(x - c, y);
      ctx.lineTo(x - s, y);
      ctx.moveTo(x, y + c);
      ctx.lineTo(x, y + s);
      ctx.moveTo(x, y - c);
      ctx.lineTo(x, y - s);
      return;
    }
    case DsoShape.ClusterNebula:
      if (dotted) {
        ctx.moveTo(x + r * 0.7, y);
        ctx.arc(x, y, r * 0.7, 0, TAU);
      } else {
        ctx.rect(x - r, y - r, 2 * r, 2 * r);
      }
      return;
    default:
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
  }
}

/**
 * Draw every shown object's symbol: one path per (colour, dash) pair, stroked over the
 * shared casing so a symbol reads on any sky; the selected and hovered objects again,
 * heavier.
 */
export function drawDeepSkySymbols(ctx: Ctx2D, field: DeepSkyField, colours: DsoColours, selected: number, hover: number): void {
  const groups: { colour: string; dotted: boolean; list: number[] }[] = [];
  const find = (colour: string, dotted: boolean): number[] => {
    let g = groups.find((q) => q.colour === colour && q.dotted === dotted);
    if (!g) {
      g = { colour, dotted, list: [] };
      groups.push(g);
    }
    return g.list;
  };
  for (let i = 0; i < field.n; i += 1) {
    if (field.on[i] === 0) continue;
    const shape = field.shape[i]! as DsoShape;
    const colour = colourOf(shape, colours);
    if (shape === DsoShape.OpenCluster || shape === DsoShape.ClusterNebula) find(colour, true).push(i);
    if (shape !== DsoShape.OpenCluster) find(colour, false).push(i);
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pass of [0, 1] as const) {
    for (const g of groups) {
      ctx.beginPath();
      for (const i of g.list) {
        const o = field.catalog[i]!;
        const ratio = o.major_arcmin > 0 ? o.minor_arcmin / o.major_arcmin : 1;
        symbolPath(ctx, field.shape[i]! as DsoShape, field.x[i]!, field.y[i]!, field.radius[i]!, ratio, g.dotted);
      }
      if (pass === 0) {
        // The casing: solid and wider, under every symbol.
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colours.halo;
        ctx.lineWidth = 3.2;
        ctx.stroke();
      } else {
        ctx.setLineDash(g.dotted ? [1.6, 2.6] : []);
        ctx.strokeStyle = g.colour;
        ctx.lineWidth = 1.35;
        // Faint objects near the limit are drawn more quietly.
        ctx.globalAlpha = 0.92;
        ctx.stroke();
      }
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  // Selected and hovered symbols get a second, brighter stroke.
  for (const [i, width] of [
    [hover, 2],
    [selected, 2.4],
  ] as const) {
    if (i < 0 || i >= field.n || Number.isNaN(field.x[i]!)) continue;
    const shape = field.shape[i]! as DsoShape;
    const o = field.catalog[i]!;
    ctx.beginPath();
    symbolPath(ctx, shape, field.x[i]!, field.y[i]!, field.radius[i]!, o.major_arcmin > 0 ? o.minor_arcmin / o.major_arcmin : 1, true);
    if (shape === DsoShape.ClusterNebula) symbolPath(ctx, shape, field.x[i]!, field.y[i]!, field.radius[i]!, 1, false);
    ctx.strokeStyle = colourOf(shape, colours);
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.restore();
}
