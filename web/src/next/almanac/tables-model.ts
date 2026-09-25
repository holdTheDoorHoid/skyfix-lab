/**
 * Pure helpers for the Almanac view's tables (almanac2 agent): how each table's engine
 * data becomes rows and pages, the navigator's look-ups (a critical table, an increment
 * and its corrections, a Polaris latitude), and the zone chart's geometry. No DOM, so it
 * is tested in Node (`test/next/almanac-tables.test.ts`); every number shown is the
 * engine's `printed` text, and the look-ups only add printed values as a navigator would.
 */

import type {
  CriticalTable,
  IncrementsMinute,
  MoonCorrectionTable,
  PolarisTable,
  RefractionZone,
} from '../engine/types.js';

// ---------------------------------------------------------------------------
// Critical tables
// ---------------------------------------------------------------------------

/** One printed line of a critical table: a boundary, and the values below it (none on the last). */
export interface CriticalLine {
  boundary: string;
  values: string[] | null;
  /** For screen readers: `9°53′ to 10°05′: Lower limb +10.9′, Upper limb −21.4′`. */
  label: string;
}

function argText(printed: string, unit: CriticalTable['unit']): string {
  if (unit === 'deg_min') {
    const [d = '', m = ''] = printed.split(' ');
    return `${d}°${m}′`;
  }
  if (unit === 'deg') return `${printed}°`;
  return `${printed} ${unit}`;
}

export function criticalLines(t: CriticalTable): CriticalLine[] {
  return t.boundaries.map((b, k) => {
    const values = k < t.values.length ? t.values[k]!.map((c) => c.printed) : null;
    const next = t.boundaries[k + 1];
    const label = values && next
      ? `${argText(b.printed, t.unit)} to ${argText(next.printed, t.unit)}: ${values.map((v, i) => `${t.columns[i] ?? ''} ${v}′`.trim()).join(', ')}`
      : `${argText(b.printed, t.unit)}: end of the table`;
    return { boundary: b.printed, values, label };
  });
}

/**
 * The lines of a correction that falls to zero, printed as the almanac prints the Venus and
 * Mars tables: up to the altitude where it becomes 0.0, which ends the table.
 */
export function trimZeroTail(lines: readonly CriticalLine[]): CriticalLine[] {
  const k = lines.findIndex((l) => l.values !== null && l.values.every((v) => v === '0.0'));
  if (k < 0) return [...lines];
  return [...lines.slice(0, k), { boundary: lines[k]!.boundary, values: null, label: `${lines[k]!.boundary}° and above: 0.0′` }];
}

/** The table's own look-up: between two boundaries, exactly on one the value above it. */
export function criticalLookup(t: CriticalTable, argument: number): string[] | null {
  const first = t.boundaries[0];
  const last = t.boundaries[t.boundaries.length - 1];
  if (!first || !last || !(argument > first.value && argument <= last.value)) return null;
  const k = t.boundaries.findIndex((b) => argument <= b.value) - 1;
  return t.values[k]?.map((c) => c.printed) ?? null;
}

// ---------------------------------------------------------------------------
// Increments
// ---------------------------------------------------------------------------

/** The printed almanac's pages of increments: two minutes each, 30 pages. */
export const INCREMENT_PAGES = 30;

export function pageMinutes(page: number): [number, number] {
  const p = Math.max(0, Math.min(INCREMENT_PAGES - 1, Math.trunc(page)));
  return [2 * p, 2 * p + 1];
}

export function pageOfMinute(minute: number): number {
  return Math.max(0, Math.min(INCREMENT_PAGES - 1, Math.floor(minute / 2)));
}

/** The `v or d` pairs of a seconds row: three columns, 0.0–6.0, 6.0–12.0, 12.0–18.0. */
export function vdPairs(t: IncrementsMinute, second: number): [string, string][] {
  return [0, 60, 120].map((offset) => {
    const c = t.corrections[offset + second];
    return [c?.v_printed ?? '', c?.correction.printed ?? ''] as [string, string];
  });
}

/** `mm:ss`, `mm ss` or `mm` after the hour, or null. */
export function parseMinuteSecond(text: string): { minute: number; second: number } | null {
  const m = /^\s*(\d{1,2})(?:\s*[:\s m]\s*(\d{1,2})\s*s?)?\s*$/.exec(text);
  if (!m) return null;
  const minute = Number(m[1]);
  const second = m[2] === undefined ? 0 : Number(m[2]);
  if (minute > 59 || second > 59) return null;
  return { minute, second };
}

/** `0 14.3` (degrees and minutes) to arcminutes. */
export function arcminOfDegMin(printed: string): number {
  const neg = printed.startsWith('-');
  const [d = '0', m = '0'] = printed.replace(/^-/, '').split(' ');
  const v = Number(d) * 60 + Number(m);
  return neg ? -v : v;
}

/** Arcminutes (tenths exact) as `14° 39.2′`. */
export function degMinText(arcmin: number): string {
  const t = Math.round(Math.abs(arcmin) * 10);
  const sign = arcmin < 0 ? '−' : '';
  return `${sign}${Math.floor(t / 600)}° ${String(Math.floor((t % 600) / 10)).padStart(2, '0')}.${t % 10}′`;
}

export interface IncrementLookup {
  minute: number;
  second: number;
  sunPlanets: string;
  aries: string;
  moon: string;
  /** The corrections for the v and d asked for, when given (0.0-18.0). */
  v: { value: string; correction: string } | null;
  d: { value: string; correction: string } | null;
}

/** What a navigator reads for `second` of this minute, and the corrections for v and d. */
export function lookupIncrement(t: IncrementsMinute, second: number, v: number | null, d: number | null): IncrementLookup {
  const row = t.rows[Math.max(0, Math.min(60, second))]!;
  const corr = (x: number | null): { value: string; correction: string } | null => {
    if (x === null || !Number.isFinite(x)) return null;
    const k = Math.round(Math.abs(x) * 10);
    const c = t.corrections[k];
    if (!c) return null;
    return { value: c.v_printed, correction: `${x < 0 ? '−' : '+'}${c.correction.printed}` };
  };
  return {
    minute: t.minute,
    second: row.second,
    sunPlanets: row.sun_planets.printed,
    aries: row.aries.printed,
    moon: row.moon.printed,
    v: corr(v),
    d: corr(d),
  };
}

// ---------------------------------------------------------------------------
// The 0°–10° table and the Moon
// ---------------------------------------------------------------------------

/** Split rows into two halves for a two-column page (the first half the longer). */
export function halves<T>(rows: readonly T[]): [T[], T[]] {
  const n = Math.ceil(rows.length / 2);
  return [rows.slice(0, n), rows.slice(n)];
}

/** The Moon's columns on each of its two printed pages: 0°–34° and 35°–89°. */
export function moonPageColumns(t: MoonCorrectionTable, page: 0 | 1): MoonCorrectionTable['columns'] {
  return t.columns.filter((c) => (page === 0 ? c.from_deg < 35 : c.from_deg >= 35));
}

/** Linear interpolation of printed values, rounded to 0.1 as a navigator would. */
export function interpolatePrinted(x0: number, v0: string, x1: number, v1: string, x: number): string {
  const a = Number(v0);
  const b = Number(v1);
  const v = a + ((x - x0) / (x1 - x0)) * (b - a);
  const t = Math.floor(v * 10 + 0.5);
  const sign = t < 0 ? '-' : '';
  return `${sign}${Math.floor(Math.abs(t) / 10)}.${Math.abs(t) % 10}`;
}

// ---------------------------------------------------------------------------
// Polaris
// ---------------------------------------------------------------------------

/** The printed Polaris pages: LHA Aries 0°–119°, 120°–239°, 240°–359°. */
export function polarisPageColumns(t: PolarisTable, page: 0 | 1 | 2): PolarisTable['columns'] {
  return t.columns.slice(12 * page, 12 * page + 12);
}

export interface PolarisLookup {
  a0: string;
  a1: string;
  a2: string;
  /** Ho − 1° + a0 + a1 + a2, in arcminutes to add to Ho (a0 + a1 + a2 − 60′). */
  correction: string;
}

/** The navigator's reading: a0 interpolated between whole degrees; a1 for the nearest latitude row; a2 for the month. */
export function polarisLookup(t: PolarisTable, lhaAries: number, latitude: number, month: number): PolarisLookup | null {
  if (!Number.isFinite(lhaAries) || !Number.isFinite(latitude) || month < 1 || month > 12) return null;
  const lha = ((lhaAries % 360) + 360) % 360;
  const deg = Math.floor(lha);
  const col = t.columns[Math.floor(deg / 10)];
  if (!col) return null;
  const row = deg - col.from_deg;
  const v0 = arcminOfDegMin(col.a0[row]!.printed);
  const v1 = arcminOfDegMin(col.a0[row + 1]!.printed);
  const a0t = Math.floor((v0 + (lha - deg) * (v1 - v0)) * 10 + 0.5);
  const li = t.a1_latitudes.reduce((best, x, i) => (Math.abs(x - latitude) < Math.abs(t.a1_latitudes[best]! - latitude) ? i : best), 0);
  const a1 = col.a1[li]!.printed;
  const a2 = col.a2[month - 1]!.printed;
  const sum = a0t + Math.round(Number(a1) * 10) + Math.round(Number(a2) * 10) - 600;
  const a0 = `${a0t < 0 ? '-' : ''}${Math.floor(Math.abs(a0t) / 600)} ${String(Math.floor((Math.abs(a0t) % 600) / 10)).padStart(2, '0')}.${Math.abs(a0t) % 10}`;
  return { a0, a1, a2, correction: `${sum < 0 ? '−' : '+'}${Math.floor(Math.abs(sum) / 10)}.${Math.abs(sum) % 10}` };
}

// ---------------------------------------------------------------------------
// Arc to time
// ---------------------------------------------------------------------------

/** The six degree ranges of the arc-to-time page: 0°–59° … 300°–359°. */
export const ARC_RANGES = [0, 60, 120, 180, 240, 300] as const;

// ---------------------------------------------------------------------------
// The non-standard conditions chart
// ---------------------------------------------------------------------------

/** The pressure (hPa) on a zone line of density factor `f` at temperature `t` (°C). */
export function zonePressure(f: number, t: number): number {
  return (1010 * f * (273 + t)) / 283;
}

/** The air-density factor of a temperature and pressure. */
export function densityFactor(t: number, p: number): number {
  return (p / 1010) * (283 / (273 + t));
}

/** The zone letter of a temperature and pressure, or null beyond A to N. */
export function zoneOf(zones: readonly RefractionZone[], t: number, p: number): string | null {
  const f = densityFactor(t, p);
  return zones.find((z) => f >= z.factor_low && f < z.factor_high)?.letter ?? null;
}

export const F_PER_C = 1.8;

export function celsiusOf(fahrenheit: number): number {
  return (fahrenheit - 32) / F_PER_C;
}

/** Inches of mercury to hectopascals. */
export function hpaOfInHg(inches: number): number {
  return inches * 33.863_889;
}
