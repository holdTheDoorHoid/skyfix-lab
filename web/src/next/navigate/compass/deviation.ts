/**
 * The deviation table: a compass's deviation logged against the ship's heading by that
 * compass, and what can honestly be read from it. OWNER: navigate2 agent (expansion
 * programme). Pure; tested in navigate-compass.test.ts.
 *
 * Deviation changes with the heading because the ship's own magnetism turns with her. Two
 * readings of a table:
 *
 * - **Between logged headings**, straight-line interpolation round the circle (what a
 *   navigator does with a deviation card). Stated as interpolated, with the two headings
 *   it came from; nothing is read beyond the widest gap without saying so.
 * - **The classic curve**: deviation = A + B sin θ + C cos θ + D sin 2θ + E cos 2θ, θ the
 *   compass heading (the "approximate coefficients" of compass adjustment: A a constant
 *   error such as a misaligned lubber line, B and C the semicircular deviation of the ship's
 *   permanent magnetism, D and E the quadrantal deviation of induced magnetism). Fitted by
 *   least squares when at least five distinct headings are logged with no gap wider than
 *   120°. On a swing of the eight cardinal and intercardinal headings, A, D and E are
 *   exactly the textbook's approximate coefficients (A = mean, D = (NE + SW − SE − NW)/4,
 *   E = (N + S − E − W)/4); B and C use all eight headings where the textbook's
 *   (B = (E − W)/2, C = (N − S)/2) use two, so the two agree exactly when the deviations
 *   follow the curve and differ by the swing's departure from it (tests check both). The
 *   curve is an approximation of the ship, not a measurement: its RMS misfit is shown.
 */

import type { DeviationEntry } from '../model.js';

const D = Math.PI / 180;

export const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;
/** Signed angle, (−180, 180]. */
export const norm180 = (deg: number): number => {
  const x = norm360(deg);
  return x > 180 ? x - 360 : x;
};

/** The table in heading order (ties: the later entry last). */
export function sortDeviations(list: readonly DeviationEntry[]): DeviationEntry[] {
  return [...list].sort((a, b) => a.headingDeg - b.headingDeg);
}

export interface Interpolated {
  deviationDeg: number;
  /** The logged headings it lies between (the same entry twice at a logged heading). */
  from: DeviationEntry;
  to: DeviationEntry;
  /** The gap between them, degrees of heading. */
  gapDeg: number;
}

/**
 * The deviation on `headingDeg` by straight-line interpolation between the nearest logged
 * headings either side, round the circle. Null with fewer than two distinct headings.
 */
export function interpolateDeviation(list: readonly DeviationEntry[], headingDeg: number): Interpolated | null {
  const sorted = sortDeviations(list);
  const distinct = new Set(sorted.map((e) => e.headingDeg.toFixed(6)));
  if (distinct.size < 2) return null;
  const x = norm360(headingDeg);
  const exact = sorted.find((e) => Math.abs(norm180(e.headingDeg - x)) < 1e-9);
  if (exact) return { deviationDeg: exact.deviationDeg, from: exact, to: exact, gapDeg: 0 };
  // The last logged heading at or below x, and the first above it (wrapping round 360).
  let below = sorted[sorted.length - 1]!;
  let above = sorted[0]!;
  for (const e of sorted) {
    if (e.headingDeg <= x) below = e;
  }
  for (const e of [...sorted].reverse()) {
    if (e.headingDeg > x) above = e;
  }
  const gap = norm360(above.headingDeg - below.headingDeg) || 360;
  const t = norm360(x - below.headingDeg) / gap;
  return { deviationDeg: below.deviationDeg + t * (above.deviationDeg - below.deviationDeg), from: below, to: above, gapDeg: gap };
}

export interface DeviationFit {
  /** Degrees, east positive. */
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  /** Root-mean-square misfit of the logged deviations, degrees. */
  rmsDeg: number;
  /** Entries used, and the degrees of freedom left (entries − 5). */
  n: number;
  dof: number;
  /** The widest gap between logged headings, degrees. */
  maxGapDeg: number;
}

export type FitResult = { ok: true; fit: DeviationFit } | { ok: false; reason: string };

/** The fitted curve at a heading. */
export function deviationAt(fit: DeviationFit, headingDeg: number): number {
  const t = headingDeg * D;
  return fit.a + fit.b * Math.sin(t) + fit.c * Math.cos(t) + fit.d * Math.sin(2 * t) + fit.e * Math.cos(2 * t);
}

/** The widest gap between consecutive logged headings, round the circle. */
export function maxHeadingGap(list: readonly DeviationEntry[]): number {
  const hs = [...new Set(list.map((e) => norm360(e.headingDeg)))].sort((a, b) => a - b);
  if (hs.length === 0) return 360;
  if (hs.length === 1) return 360;
  let gap = 360 - (hs[hs.length - 1]! - hs[0]!);
  for (let i = 1; i < hs.length; i += 1) gap = Math.max(gap, hs[i]! - hs[i - 1]!);
  return gap;
}

/** Solve a small linear system by Gaussian elimination with partial pivoting; null when singular. */
function solve(m: number[][], v: number[]): number[] | null {
  const n = v.length;
  const a = m.map((row, i) => [...row, v[i]!]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    if (Math.abs(a[pivot]![col]!) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const k = a[r]![col]! / a[col]![col]!;
      for (let c = col; c <= n; c += 1) a[r]![c]! -= k * a[col]![c]!;
    }
  }
  return a.map((row, i) => row[n]! / row[i]!);
}

/** The five-coefficient curve by least squares, or why there is none. */
export function fitDeviation(list: readonly DeviationEntry[]): FitResult {
  const headings = new Set(list.map((e) => norm360(e.headingDeg).toFixed(3)));
  if (headings.size < 5) {
    return { ok: false, reason: `The curve needs deviations on at least five different headings (${headings.size} so far): a swing takes eight, every 45°.` };
  }
  const gap = maxHeadingGap(list);
  if (gap > 120) {
    return { ok: false, reason: `The logged headings leave a gap of ${gap.toFixed(0)}° with nothing in it: the curve would be guessed there. Log headings all round (no gap over 120°).` };
  }
  const rows = list.map((e) => {
    const t = e.headingDeg * D;
    return { x: [1, Math.sin(t), Math.cos(t), Math.sin(2 * t), Math.cos(2 * t)], y: e.deviationDeg };
  });
  const ata = Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (__, j) => rows.reduce((s, r) => s + r.x[i]! * r.x[j]!, 0)));
  const aty = Array.from({ length: 5 }, (_, i) => rows.reduce((s, r) => s + r.x[i]! * r.y, 0));
  const coef = solve(ata, aty);
  if (!coef) return { ok: false, reason: 'The logged headings do not pin the curve down (their pattern leaves it undetermined): log a few more, spread round the compass.' };
  const [a, b, c, d, e] = coef as [number, number, number, number, number];
  const fit: DeviationFit = { a, b, c, d, e, rmsDeg: 0, n: list.length, dof: list.length - 5, maxGapDeg: gap };
  const sq = list.reduce((s, x) => s + (x.deviationDeg - deviationAt(fit, x.headingDeg)) ** 2, 0);
  fit.rmsDeg = Math.sqrt(sq / list.length);
  return { ok: true, fit };
}

/** A deviation card from the curve: the deviation every `stepDeg` of compass heading. */
export function deviationCard(fit: DeviationFit, stepDeg = 15): { headingDeg: number; deviationDeg: number }[] {
  const out: { headingDeg: number; deviationDeg: number }[] = [];
  for (let hdg = 0; hdg < 360 - 1e-9; hdg += stepDeg) out.push({ headingDeg: hdg, deviationDeg: deviationAt(fit, hdg) });
  return out;
}

/** "2.6° W", "1.4° E", "0.0°": deviation and variation are named, not signed. */
export function eastWest(deg: number, digits = 1): string {
  const t = Math.abs(deg).toFixed(digits);
  if (Number(t) === 0) return `${t}°`;
  return `${t}° ${deg > 0 ? 'E' : 'W'}`;
}

/**
 * An angle typed with a name, as navigators write deviation and variation: `2.5 W`,
 * `1.4E`, `-2.5` (west negative), `+3`. Null when it is not one.
 */
export function parseEastWest(text: string): number | null {
  const m = /^\s*([+\-−]?)\s*(\d+(?:[.,]\d*)?|[.,]\d+)\s*°?\s*([EeWw])?\s*$/.exec(text);
  if (!m) return null;
  const v = Number(m[2]!.replace(',', '.'));
  if (!Number.isFinite(v)) return null;
  const signed = m[1] === '-' || m[1] === '−' ? -v : v;
  if (m[3]) {
    if (m[1] === '-' || m[1] === '−') return null; // "-2 W" is ambiguous
    return /[Ww]/.test(m[3]) ? -v : v;
  }
  return signed;
}

/** Plain words for the fitted coefficients (what each one usually means). */
export const COEFFICIENT_TEXT = {
  a: 'A, constant on every heading: a lubber line not on the keel line, or a misread card',
  b: 'B, most on east and west headings: the ship’s permanent magnetism fore and aft',
  c: 'C, most on north and south headings: the ship’s permanent magnetism athwartships',
  d: 'D, most on the intercardinal headings: magnetism the Earth’s field induces in her steel',
  e: 'E, most on the cardinal headings: induced magnetism, when her steel is not symmetrical',
} as const;
