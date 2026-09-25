/**
 * Words and numbers for the Tonight view. Pure functions; times go through the shell's
 * formatters (the 12- or 24-hour clock, the display zone), angles and lengths through the
 * person's settings. OWNER: tonight agent (expansion programme Q2).
 */

import type { CompassPoint, DsoInstrument, DsoType, PhaseEvent } from '../engine/types.js';
import { compassWords, eventTime, formatDistance, formatMagnitude, MINUS, otherDay } from '../shell/format.js';
import type { AngleFormat, Units } from '../state.js';
import type { Zone } from '../time.js';

/** How the view writes things: the display zone and the person's settings. */
export interface Fmt {
  zone: Zone;
  angle: AngleFormat;
  units: Units;
}

/** `18:40` (or `6:40 PM`), rounded to the minute like every event time. */
export function clock(jd: number, f: Pick<Fmt, 'zone'>): string {
  // time-ui: the display calendar's clock (LMT before 1850) once time-ui's helpers land.
  return eventTime(jd, f.zone);
}

/** `18:40`, with the weekday when it falls on another local date than `ref`: `01:10 Fri`. */
export function clockOn(jd: number, ref: number, f: Pick<Fmt, 'zone'>): string {
  const day = otherDay(jd, ref, f.zone);
  return day ? `${clock(jd, f)} ${day}` : clock(jd, f);
}

/** `20:12–05:02`. */
export function clockRange(a: number, b: number, f: Pick<Fmt, 'zone'>): string {
  return `${clock(a, f)}–${clock(b, f)}`;
}

/** A duration: `45 min`, `3 h 50 min`, `11 h`. */
export function duration(days: number): string {
  const minutes = Math.max(0, Math.round(days * 1440));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

/** Hours with one decimal as the engine gives them: `3.8 h`. */
export function hoursText(hours: number): string {
  return `${Math.max(0, hours).toFixed(1)} h`;
}

/** Whole degrees of altitude with a true minus: `61°`. */
export function degrees(deg: number): string {
  const r = Math.round(deg);
  return `${r < 0 ? MINUS : ''}${Math.abs(r)}°`;
}

/** A percentage of the Moon lit: `78%` (`0%` and `100%` only when truly so). */
export function percentLit(fraction: number): string {
  const p = fraction * 100;
  const r = Math.round(p);
  if (r === 0 && p > 0) return '<1%';
  if (r === 100 && p < 100) return '>99%';
  return `${r}%`;
}

/** The engine's 16-point compass word, in plain words: `SSE` → `south-south-east`. */
export function directionWords(point: CompassPoint | string, azDeg?: number): string {
  const words: Record<string, string> = {
    N: 'north',
    NNE: 'north-north-east',
    NE: 'north-east',
    ENE: 'east-north-east',
    E: 'east',
    ESE: 'east-south-east',
    SE: 'south-east',
    SSE: 'south-south-east',
    S: 'south',
    SSW: 'south-south-west',
    SW: 'south-west',
    WSW: 'west-south-west',
    W: 'west',
    WNW: 'west-north-west',
    NW: 'north-west',
    NNW: 'north-north-west',
  };
  return words[point] ?? (azDeg === undefined ? String(point) : compassWords(azDeg));
}

/** `magnitude −2.7`. */
export function magnitudeText(m: number | null): string {
  return m === null ? '' : `magnitude ${formatMagnitude(m)}`;
}

export function distanceText(km: number, units: Units): string {
  return formatDistance(km, units);
}

const TYPE_WORDS: Record<DsoType, string> = {
  open_cluster: 'open cluster',
  globular_cluster: 'globular cluster',
  planetary_nebula: 'planetary nebula',
  emission_nebula: 'emission nebula',
  reflection_nebula: 'reflection nebula',
  supernova_remnant: 'supernova remnant',
  cluster_with_nebula: 'cluster with nebula',
  spiral_galaxy: 'spiral galaxy',
  elliptical_galaxy: 'elliptical galaxy',
  lenticular_galaxy: 'lenticular galaxy',
  irregular_galaxy: 'irregular galaxy',
  double_star: 'double star',
  asterism: 'asterism',
  star_cloud: 'star cloud',
};

export function dsoTypeWords(type: DsoType): string {
  return TYPE_WORDS[type] ?? type.replace(/_/g, ' ');
}

const INSTRUMENT_WORDS: Record<DsoInstrument, string> = {
  eye: 'naked eye',
  binoculars: 'binoculars',
  telescope: 'a small telescope',
  camera: 'a camera (long exposure)',
};

export function instrumentWords(i: DsoInstrument): string {
  return INSTRUMENT_WORDS[i];
}

const PHASE_WORDS: Record<PhaseEvent['kind'], string> = {
  new_moon: 'new Moon',
  first_quarter: 'first quarter',
  full_moon: 'full Moon',
  last_quarter: 'last quarter',
};

export function phaseEventWords(kind: PhaseEvent['kind']): string {
  return PHASE_WORDS[kind];
}

/** Capitalise the first letter. */
export function cap(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** `A`, `A and B`, `A, B and C`. */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A count of days in words: `a day`, `3 days`. */
export function daysWords(n: number): string {
  return n === 1 ? 'a day' : `${n} days`;
}
