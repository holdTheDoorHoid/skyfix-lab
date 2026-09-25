/**
 * What the Sky view precomputes once per star catalogue so that a frame allocates
 * nothing per star: a magnitude bin (radius and brightness), a colour bin (B−V), a draw
 * order grouped by (size, colour) so each group is one path and one fill, and the
 * name and designation look-ups the labels and tooltips need. OWNER: sky agent.
 *
 * Display only (CONVENTIONS 13.6).
 */

import type { StarfieldCatalog } from '../engine/types.js';

/** Magnitude bins: 0.25 mag wide from −1.75, so radius steps are about 0.1 px. */
export const MAG_MIN = -1.75;
export const MAG_STEP = 0.25;
export const MAG_BINS = 40; // to +8.25, past the catalogue's faintest (≈ 8.0)

/** Colour bins: B−V from −0.4 to 2.0 in 0.2 steps, plus one "unknown" bin (neutral). */
export const BV_MIN = -0.4;
export const BV_STEP = 0.2;
export const BV_BINS = 12;
export const BV_UNKNOWN = BV_BINS; // index of the neutral bin
export const COLOUR_BINS = BV_BINS + 1;

export function magBin(mag: number): number {
  if (!Number.isFinite(mag)) return MAG_BINS - 1;
  const b = Math.floor((mag - MAG_MIN) / MAG_STEP);
  return b < 0 ? 0 : b >= MAG_BINS ? MAG_BINS - 1 : b;
}

/** The magnitude a bin is drawn at (its centre). */
export function binMagnitude(bin: number): number {
  return MAG_MIN + (bin + 0.5) * MAG_STEP;
}

export function colourBin(bv: number): number {
  if (!Number.isFinite(bv)) return BV_UNKNOWN;
  const b = Math.floor((bv - BV_MIN) / BV_STEP);
  return b < 0 ? 0 : b >= BV_BINS ? BV_BINS - 1 : b;
}

/** The B−V a colour bin is drawn at (its centre); NaN for the neutral bin. */
export function binBv(bin: number): number {
  return bin >= BV_BINS ? Number.NaN : BV_MIN + (bin + 0.5) * BV_STEP;
}

/**
 * Radius in CSS pixels of a star of magnitude `mag` at zoom factor 1: linear in
 * magnitude, which reads better on screen than true flux (Sirius would be 30 times
 * the faintest star). 0.55 px at 6.5, 3.6 px at −1.5.
 */
export function starRadius(mag: number): number {
  const r = 0.55 + 0.38 * (6.5 - mag);
  return r < 0.45 ? 0.45 : r > 4.4 ? 4.4 : r;
}

/**
 * How strongly a star of magnitude `mag` is drawn when the faintest visible magnitude is
 * `limit` (0 = not drawn). Stars fade out over the last 0.6 mag.
 */
export function starAlpha(mag: number, limit: number): number {
  const margin = limit - mag;
  if (margin <= -0.6) return 0;
  if (margin < 0) return 0.3 * (1 + margin / 0.6);
  const a = 0.45 + 0.55 * Math.min(1, margin / 2.5);
  return a;
}

export interface StarRenderData {
  count: number;
  vmag: Float32Array;
  bv: Float32Array;
  /** Star indices ordered by (magnitude bin descending = faint first, colour bin). */
  order: Int32Array;
  /** For each non-empty (size, colour) group, in draw order: [magBin, colourBin, start, end) into `order`. */
  groups: Int32Array;
  groupCount: number;
  /** Each star's colour bin (`colourBin(bv)`), for grouping stars by dimmed magnitude each frame. */
  cbin: Uint8Array;
  /** 1 for the 58 navigational stars. */
  isNav: Uint8Array;
  /** Proper names (the 58 use the Nautical Almanac spelling). */
  nameOf: Map<number, string>;
  /** Named stars, brightest first (label candidates). */
  named: Int32Array;
  /** Canonical navigational name to star index. */
  navByName: Map<string, number>;
  /** Lower-case proper name to star index (highlights and search). */
  byName: Map<string, number>;
  designations: readonly string[];
  hr: Int32Array;
}

export function buildStarRenderData(cat: StarfieldCatalog): StarRenderData {
  const n = cat.count;
  const bins = new Int32Array(n);
  const cbin = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    cbin[i] = colourBin(cat.bv[i]!);
    // Faint first so bright stars are drawn over faint ones.
    bins[i] = (MAG_BINS - 1 - magBin(cat.vmag[i]!)) * COLOUR_BINS + cbin[i]!;
  }
  const order = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => bins[a]! - bins[b]! || a - b);
  const groups: number[] = [];
  let start = 0;
  for (let k = 1; k <= n; k += 1) {
    if (k === n || bins[order[k]!] !== bins[order[start]!]) {
      const key = bins[order[start]!]!;
      const mb = MAG_BINS - 1 - Math.floor(key / COLOUR_BINS);
      groups.push(mb, key % COLOUR_BINS, start, k);
      start = k;
    }
  }
  const isNav = new Uint8Array(n);
  const navByName = new Map<string, number>();
  for (const { name, index } of cat.navigational) {
    if (index >= 0 && index < n) {
      isNav[index] = 1;
      navByName.set(name, index);
    }
  }
  const nameOf = new Map<number, string>();
  const byName = new Map<string, number>();
  for (const { index, name } of cat.names) {
    if (index < 0 || index >= n) continue;
    nameOf.set(index, name);
    byName.set(name.toLowerCase(), index);
  }
  for (const [name, index] of navByName) {
    nameOf.set(index, name);
    byName.set(name.toLowerCase(), index);
  }
  const named = Int32Array.from(nameOf.keys()).sort((a, b) => cat.vmag[a]! - cat.vmag[b]! || a - b);
  return {
    count: n,
    vmag: cat.vmag,
    bv: cat.bv,
    order,
    groups: Int32Array.from(groups),
    groupCount: groups.length / 4,
    cbin,
    isNav,
    nameOf,
    named,
    navByName,
    byName,
    designations: cat.designations,
    hr: cat.hr,
  };
}

/** What a star is called on screen: its name, else its designation, else "HR n". */
export function starTitle(data: StarRenderData, index: number): string {
  const name = data.nameOf.get(index);
  if (name) return name;
  const d = data.designations[index];
  if (d) return d;
  const hr = data.hr[index]!;
  return hr > 0 ? `HR ${hr}` : `Star ${index + 1}`;
}

/** The catalogue designation line: "α Lyr · HR 7001" (HR omitted for the mock's placeholders). */
export function starDesignation(data: StarRenderData, index: number): string {
  const parts: string[] = [];
  const d = data.designations[index];
  if (d) parts.push(d);
  const hr = data.hr[index]!;
  if (hr > 0) parts.push(`HR ${hr}`);
  return parts.join(' · ');
}
