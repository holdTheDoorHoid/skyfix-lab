/**
 * The ± chip: how far a time or a place on the page can be trusted when the Earth's rotation
 * at that date is known only roughly (CONVENTIONS 15.1-15.2). OWNER: time-ui agent; the
 * sensitivity rule (VERIFICATION_2 finding V18, EXPANSION_PLAN §3 "V18: adopted"): chip2.
 *
 * The engine's time scale TT runs evenly; the clock (UT) follows the Earth's rotation, which is
 * measured only since the 1600s and predicted only roughly. ΔT = TT − UT carries a standard
 * uncertainty σ (`time_info.delta_t_sigma_s`): 15 s in AD 1000, 2.6 min in 585 BC, an hour at
 * 2000 BC, 10 s in 2060, 15 min in 2650. What σ moves depends on the quantity shown, and the
 * chip follows it (`dtChip`, the one place a chip's size is worked out):
 *
 * - `CLOCK`, the clock itself (the time bar, a saved picture's caption, a page's heading): σ,
 *   the date's headline figure, shown when σ exceeds 30 s (half the precision of a time to the
 *   minute) and always in the labelled tier (a "far" date, `farDate`).
 * - `INSTANT`, an instant set by the bodies' own motion (a Moon phase, a season, a conjunction,
 *   an occultation, an eclipse, and what is placed on the Earth from one: an eclipse's path and
 *   local contacts): the whole σ, with the clock's condition.
 * - `turning(body, …)`, a time set by the Earth's turning (a rising, setting, transit, twilight,
 *   a height or a bearing reached): the clock follows that turning, so only the body's own
 *   motion across the sky moves it, σ × k with k = α̇ / (θ̇ − α̇), the body's rate in right
 *   ascension over the Earth's rotation relative to it (the Sun about 0.27 %, the Moon 3.2 to
 *   5 %): the fastest of the bodies named. Shown when it reaches 1 s: never for the Sun's times
 *   between about 850 BC and AD 2400 (0.44 s at 585 BC, 10.6 s at 2000 BC), the Moon's before
 *   about AD 700 and after about 2090 (6 s at 585 BC). No body, or only stars and deep-sky
 *   objects (fixed on the sky): none.
 * - `position(body)`, the body's place at the time shown (altitude and azimuth, right ascension
 *   and declination, GHA), where it is printed to the arcminute or finer: its angular speed
 *   among the stars × σ, in arcminutes, at a far date when it exceeds 0.1′. The Moon 1.5′ at
 *   585 BC (1.4′ at the verifier's σ of 150 s) and 34′ at 2000 BC; the Sun 0.1′ and 2.5′;
 *   stars never.
 *
 * The rates are the engine's own: the body's apparent geocentric right ascension, declination
 * and GHA from `sky_state` an hour apart (`bodyRates`), asked only where a chip could show
 * (σ of 10 s or more for a time, a far date for a place) and remembered per body and hour.
 *
 * Rule for every view: every chip comes from `dtChip` (or `chipOf` with rates in hand), never
 * from σ directly; render it with `uncertaintyChip`, `setUncertaintyChip`, `uncertaintyText`
 * or `withUncertainty`.
 *
 * ```ts
 * import { dtChip, turning, uncertaintyChip, setUncertaintyChip } from '../time/index.js';
 * const chip = uncertaintyChip(null);                                       // once
 * setUncertaintyChip(chip, dtChip(ctx, rise.jd_utc, turning('Moon')));      // on every redraw
 * ```
 */

import { h } from '../../dom.js';
import { SOLAR_SYSTEM } from '../engine/bodies.js';
import type { CoverageTier, ExplorerEngine, TimeInfo } from '../engine/types.js';
import { isTimeEngine } from '../engine/types.js';
import { engineOf, type EngineSource } from './tier.js';

/** Above this many seconds of σ(ΔT) a date is far: a time to the minute carries the clock's chip. */
export const CHIP_THRESHOLD_S = 30;
/** A time set by the Earth's turning carries its chip from this many seconds (the brief: 1 s). */
export const TURNING_THRESHOLD_S = 1;
/** A place carries its chip above this many arcminutes (the brief: 0.1′), at a far date. */
export const POSITION_THRESHOLD_ARCMIN = 0.1;
/**
 * An upper bound on any body's k (the Moon's is at most about 0.06): below
 * `TURNING_THRESHOLD_S / TURNING_K_BOUND` seconds of σ no turning chip can show, and no rate
 * is asked of the engine.
 */
export const TURNING_K_BOUND = 0.1;

/** The σ and tier a chip needs (a whole `TimeInfo` will do). */
export type ChipInfo = Pick<TimeInfo, 'delta_t_sigma_s' | 'tier'> & Partial<Pick<TimeInfo, 'jd_utc' | 'scale'>>;

/** What a chip qualifies (CONVENTIONS 15.2): see the module's comment. */
export type ChipSubject =
  | { readonly kind: 'clock' }
  | { readonly kind: 'instant' }
  | { readonly kind: 'turning'; readonly bodies: readonly string[] }
  | { readonly kind: 'position'; readonly body: string };

/** The clock itself: σ. */
export const CLOCK: ChipSubject = Object.freeze({ kind: 'clock' });
/** An instant set by the bodies' own motion (a phase, a season, a conjunction, an eclipse): σ. */
export const INSTANT: ChipSubject = Object.freeze({ kind: 'instant' });

/**
 * A time set by the Earth's turning, for one body or the fastest of several (a planet's time
 * bounded by twilight: `turning('Saturn', 'Sun')`). Names that are not the Sun, the Moon or a
 * planet (a star, a deep-sky object) are fixed on the sky and add nothing.
 */
export function turning(...bodies: string[]): ChipSubject {
  return { kind: 'turning', bodies };
}

/** The body's place at the time shown. */
export function position(body: string): ChipSubject {
  return { kind: 'position', body };
}

/** A body's motion as the engine gives it: the rates behind `turning` and `position`. */
export interface BodyRates {
  /** Right ascension, degrees a day (negative when retrograde). */
  ra_deg_per_day: number;
  dec_deg_per_day: number;
  /** Its GHA: the Earth's rotation relative to the body, θ̇ − α̇, degrees a day. */
  gha_deg_per_day: number;
  /** Its angular speed among the stars, arcseconds a second of time. */
  arcsec_per_s: number;
  /** A turning time's seconds per second of ΔT: |α̇| / (θ̇ − α̇). */
  k: number;
}

/** A body fixed on the sky: nothing it does moves with ΔT. */
const FIXED: BodyRates = Object.freeze({ ra_deg_per_day: 0, dec_deg_per_day: 0, gha_deg_per_day: 360.9856, arcsec_per_s: 0, k: 0 });

/** The ± chip for one quantity at one instant: what `dtChip` works out, what the renderers draw. */
export interface DtChip {
  readonly subject: ChipSubject;
  /** σ(ΔT) at the date, seconds. */
  readonly sigmaS: number;
  readonly tier: CoverageTier;
  /** σ over 30 s or the labelled tier: the clock's own chip shows. */
  readonly far: boolean;
  /**
   * How much the quantity moves for each second of ΔT: 1 for the clock and instants, k for a
   * turning time, arcseconds a second for a place; null when not worked out (no chip could
   * show) or when the engine could not give the body's motion.
   */
  readonly rate: number | null;
  /** The uncertainty: seconds of time, or arcminutes for a place; null when not worked out. */
  readonly value: number | null;
  readonly unit: 's' | 'arcmin';
  /** The body whose motion sets it (the fastest of a turning time's), when there is one. */
  readonly body: string | null;
  readonly shown: boolean;
  /** `±3 min`, `±6 s`, `±1.4′`; '' when not shown. */
  readonly text: string;
  /** What it means, in plain words; '' when not shown. */
  readonly tip: string;
}

/** True when the date is far: σ(ΔT) over 30 s, or the labelled tier (the clock's chip shows). */
export function farDate(info: ChipInfo | null | undefined): boolean {
  if (!info || !Number.isFinite(info.delta_t_sigma_s)) return false;
  return info.tier === 'labelled' || info.delta_t_sigma_s > CHIP_THRESHOLD_S;
}

/**
 * A standard uncertainty in words, rounded the way it is meant: `±45 s`, `±12 min`, `±1.5 h`,
 * `±2 h`. Seconds below 90 s, minutes below an hour, hours (one decimal below ten) above.
 */
export function sigmaText(sigmaS: number): string {
  if (!Number.isFinite(sigmaS) || sigmaS < 0) return '';
  if (sigmaS < 89.5) return `±${Math.max(1, Math.round(sigmaS))} s`;
  if (sigmaS < 59.5 * 60) return `±${Math.round(sigmaS / 60)} min`;
  const hours = sigmaS / 3600;
  const text = hours < 9.95 ? hours.toFixed(1).replace(/\.0$/, '') : String(Math.round(hours));
  return `±${text} h`;
}

/** An angle's uncertainty in words: `±0.3′`, `±1.4′` (one decimal below 10′), `±34′`, `±1.2°`. */
export function arcminText(arcmin: number): string {
  if (!Number.isFinite(arcmin) || arcmin < 0) return '';
  if (arcmin < 9.95) return `±${Math.max(0.1, arcmin).toFixed(1)}′`;
  if (arcmin < 59.5) return `±${Math.round(arcmin)}′`;
  return `±${(arcmin / 60).toFixed(1)}°`;
}

/** `3.8 %`, `0.27 %`: a share of the sky's turning. */
function shareText(k: number): string {
  const p = k * 100;
  return `${p < 1 ? p.toFixed(2) : p.toFixed(1)} %`;
}

/** `the Moon`, `Venus`. */
function bodyWords(body: string): string {
  return body === 'Sun' || body === 'Moon' ? `the ${body}` : body;
}

const BAND = ' These years are an estimate outside the validated span.';
const DELTA_T = '(ΔT, the difference between the Earth’s clock and an even one)';

function tipFor(c: Omit<DtChip, 'tip' | 'text' | 'shown'>, text: string): string {
  const sigma = sigmaText(c.sigmaS).slice(1);
  const band = c.tier === 'labelled' ? BAND : '';
  const known = `The Earth’s rotation at this date is known only to ±${sigma} ${DELTA_T}`;
  switch (c.subject.kind) {
    case 'clock':
      return `${known}. An event set by the bodies’ own motion (a new or full Moon, a solstice, an eclipse) carries all of it; a rising, setting or twilight time carries only the share of the sky’s turning that the body’s own motion makes, and the Moon’s place at the time shown moves about half an arcsecond for each second of it. The chip beside each time or place says how much.${band}`;
    case 'instant':
      return `${known}. This moment is set by the bodies’ own motion, so its clock time carries all of it.${band}`;
    case 'turning':
      if (c.rate === null || c.body === null) {
        return `${known}. How much of it this time carries could not be worked out here, so it is shown whole.${band}`;
      }
      return `${known}. A rising, setting or transit is set by the Earth’s turning, which the clock follows, so only ${bodyWords(c.body)}’s own motion across the sky (${shareText(c.rate)} of the sky’s turning) moves this time, by about ${text.slice(1)}.${band}`;
    case 'position':
      return `At the time shown ${bodyWords(c.body ?? c.subject.body)}’s place among the stars is uncertain by ${text.slice(1)}: the Earth’s rotation at this date is known only to ±${sigma} ${DELTA_T}, and ${bodyWords(c.body ?? c.subject.body)} moves ${(c.rate ?? 0).toFixed(2)}″ across the sky for each second of it.${band}`;
  }
}

function finish(c: Omit<DtChip, 'tip' | 'text'>): DtChip {
  if (!c.shown || c.value === null) return { ...c, shown: false, text: '', tip: '' };
  const text = c.unit === 'arcmin' ? arcminText(c.value) : sigmaText(c.value);
  return { ...c, text, tip: tipFor(c, text) };
}

/**
 * The chip for a quantity, from the date's σ and tier and, for a turning time or a place, the
 * bodies' motion (`rates(body)`: null when the engine cannot give it). Pure; `dtChip` asks the
 * engine. Null when there is no time information (an engine without time scales).
 */
export function chipOf(
  info: ChipInfo | null | undefined,
  subject: ChipSubject,
  rates: (body: string) => BodyRates | null = () => null,
): DtChip | null {
  if (!info || !Number.isFinite(info.delta_t_sigma_s)) return null;
  const sigmaS = Math.max(0, info.delta_t_sigma_s);
  const far = farDate(info);
  const base = { subject, sigmaS, tier: info.tier, far };
  switch (subject.kind) {
    case 'clock':
    case 'instant':
      return finish({ ...base, rate: 1, value: sigmaS, unit: 's', body: null, shown: far });
    case 'turning': {
      const moving = subject.bodies.filter(isSolarSystem);
      if (!moving.length) return finish({ ...base, rate: 0, value: 0, unit: 's', body: null, shown: false });
      // No body turns fast enough to reach a second: nothing is asked of the engine.
      if (sigmaS * TURNING_K_BOUND < TURNING_THRESHOLD_S) return finish({ ...base, rate: null, value: null, unit: 's', body: null, shown: false });
      let best: { body: string; k: number } | null = null;
      for (const body of moving) {
        const r = rates(body);
        // A body whose motion the engine cannot give: the whole σ, as before the rule.
        if (!r) return finish({ ...base, rate: null, value: sigmaS, unit: 's', body: null, shown: far });
        if (!best || r.k > best.k) best = { body, k: r.k };
      }
      const value = best!.k * sigmaS;
      return finish({ ...base, rate: best!.k, value, unit: 's', body: best!.body, shown: value >= TURNING_THRESHOLD_S });
    }
    case 'position': {
      if (!isSolarSystem(subject.body)) return finish({ ...base, rate: 0, value: 0, unit: 'arcmin', body: subject.body, shown: false });
      if (!far) return finish({ ...base, rate: null, value: null, unit: 'arcmin', body: subject.body, shown: false });
      const r = rates(subject.body);
      if (!r) return finish({ ...base, rate: null, value: null, unit: 'arcmin', body: subject.body, shown: false });
      const value = (r.arcsec_per_s * sigmaS) / 60;
      return finish({ ...base, rate: r.arcsec_per_s, value, unit: 'arcmin', body: subject.body, shown: value > POSITION_THRESHOLD_ARCMIN });
    }
  }
}

function isSolarSystem(body: string): boolean {
  return SOLAR_SYSTEM.includes(body);
}

/**
 * The ± chip for a quantity at `jd` (CONVENTIONS 15.2): the one helper every chip on the page
 * comes from. `info` is the date's `time_info` when the caller has it (a day's or a night's,
 * `timeInfoForSpan`); else it is asked (`timeInfoAt`). The bodies' rates are asked at `jd`.
 */
export function dtChip(source: EngineSource, jd: number, subject: ChipSubject, info?: ChipInfo | null): DtChip | null {
  const i = info === undefined ? timeInfoAt(source, jd) : info;
  if (!i) return null;
  return chipOf(i, subject, (body) => bodyRates(source, body, jd));
}

/** The chip's text, or '' when it does not show: for tables, CSV and aria labels. */
export function uncertaintyText(chip: DtChip | null | undefined): string {
  return chip?.shown ? chip.text : '';
}

/** `18:40 ±12 min`, `05:31 ±6 s`, or the text alone when the chip does not show. */
export function withUncertainty(text: string, chip: DtChip | null | undefined): string {
  const u = uncertaintyText(chip);
  return u ? `${text} ${u}` : text;
}

/** The chip's tooltip: what the number means, in plain words ('' when it does not show). */
export function uncertaintyTip(chip: DtChip | null | undefined): string {
  return chip?.shown ? chip.tip : '';
}

/**
 * The chip itself: a small `±12 min` or `±1.4′` label with its tooltip, hidden when it does
 * not show. Append it once beside a time or a place and keep it current with
 * `setUncertaintyChip`.
 */
export function uncertaintyChip(chip: DtChip | null | undefined): HTMLElement {
  const el = h('span', { class: 'sf-dt-chip', tabindex: 0, hidden: true });
  setUncertaintyChip(el, chip);
  return el;
}

/** Bring a chip up to date (cheap: it writes only what changed). */
export function setUncertaintyChip(el: HTMLElement, chip: DtChip | null | undefined): void {
  const shown = Boolean(chip?.shown);
  if (el.hidden === shown) el.hidden = !shown;
  if (!shown || !chip) return;
  if (el.textContent !== chip.text) el.textContent = chip.text;
  if (el.dataset.tip !== chip.tip) el.dataset.tip = chip.tip;
  const label = `Uncertain by ${chip.text.slice(1)}: ${chip.tip}`;
  if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
  if (el.dataset.tier !== chip.tier) el.dataset.tier = chip.tier;
  if (el.dataset.kind !== chip.subject.kind) el.dataset.kind = chip.subject.kind;
}

/**
 * A line saying how well a place shown is known at this date, `At this date its place is known
 * to ±1.5′`, hidden unless its chip shows: under a body's altitude and azimuth, or its
 * navigator's figures (chip2).
 */
export function placeLine(words = 'At this date its place is known to'): { el: HTMLElement; set(chip: DtChip | null | undefined): void } {
  const chip = uncertaintyChip(null);
  const el = h('p', { class: 'sf-dt-place', hidden: true }, `${words} `, chip);
  return {
    el,
    set(c) {
      setUncertaintyChip(chip, c);
      const hide = !c?.shown;
      if (el.hidden !== hide) el.hidden = hide;
    },
  };
}

// ---------------------------------------------------------------------------------
// The bodies' motion, from the engine's positions
// ---------------------------------------------------------------------------------

/** Right ascension, declination and GHA do not depend on the place: any observer will do. */
const ANY_PLACE = Object.freeze({ lat_deg: 0, lon_deg: 0 });
const HOUR = 1 / 24;
const RATES_MAX = 256;

interface Place {
  ra: number;
  dec: number;
  gha: number;
}

const rateCache = new WeakMap<object, { coverage: unknown; map: Map<string, BodyRates | null> }>();

function placeAt(engine: ExplorerEngine, body: string, jd: number): Place | null {
  try {
    const b = engine.skyState(ANY_PLACE, jd, [body]).bodies.find((x) => x.body === body);
    return b && Number.isFinite(b.ra_deg) && Number.isFinite(b.dec_deg) && Number.isFinite(b.gha_deg) ? { ra: b.ra_deg, dec: b.dec_deg, gha: b.gha_deg } : null;
  } catch {
    return null;
  }
}

/** An angle difference in (−180, 180]. */
function turn180(d: number): number {
  const x = ((((d + 180) % 360) + 360) % 360) - 180;
  return x === -180 ? 180 : x;
}

/** The rates between two places `dt` days apart. */
export function ratesBetween(a: Place, b: Place, dt: number): BodyRates {
  const ra = turn180(b.ra - a.ra) / dt;
  const dec = (b.dec - a.dec) / dt;
  const gha = (((b.gha - a.gha) % 360) + 360) % 360 / dt;
  const cosDec = Math.cos((((a.dec + b.dec) / 2) * Math.PI) / 180);
  const degPerDay = Math.hypot(ra * cosDec, dec);
  return { ra_deg_per_day: ra, dec_deg_per_day: dec, gha_deg_per_day: gha, arcsec_per_s: degPerDay / 24, k: gha > 0 ? Math.abs(ra) / gha : 0 };
}

/**
 * A body's motion around `jd` from the engine's apparent geocentric places an hour apart (the
 * hour `jd` falls in, or the one before when the next is outside the coverage): remembered per
 * engine, body and hour, and forgotten when the engine's coverage changes. A star or any name
 * that is not the Sun, the Moon or a planet is fixed on the sky. Null when the engine cannot
 * place the body then.
 */
export function bodyRates(source: EngineSource, body: string, jd: number): BodyRates | null {
  if (!isSolarSystem(body)) return FIXED;
  if (!Number.isFinite(jd)) return null;
  const engine = engineOf(source);
  let coverage: unknown = null;
  try {
    coverage = engine.coverage();
  } catch {
    coverage = null;
  }
  let entry = rateCache.get(engine);
  if (!entry || entry.coverage !== coverage) rateCache.set(engine, (entry = { coverage, map: new Map() }));
  const t0 = Math.floor(jd * 24) / 24;
  const key = `${body}|${t0}`;
  if (entry.map.has(key)) return entry.map.get(key) ?? null;
  const a = placeAt(engine, body, t0);
  let rates: BodyRates | null = null;
  if (a) {
    const b = placeAt(engine, body, t0 + HOUR);
    if (b) rates = ratesBetween(a, b, HOUR);
    else {
      const before = placeAt(engine, body, t0 - HOUR);
      if (before) rates = ratesBetween(before, a, HOUR);
    }
  }
  if (entry.map.size >= RATES_MAX) entry.map.delete(entry.map.keys().next().value as string);
  entry.map.set(key, rates);
  return rates;
}

// ---------------------------------------------------------------------------------
// time_info, asked cheaply
// ---------------------------------------------------------------------------------

const recent = new WeakMap<object, { coverage: unknown; map: Map<number, TimeInfo> }>();
const RECENT_MAX = 64;

/**
 * `time_info` for an instant, or null when the engine has no time scales (the mock and
 * older modules still work). Remembered for the last few dozen instants per engine, so a
 * frame that shows the same time in several places asks once, and forgotten when the
 * engine's coverage report changes (a data pack was loaded: the tiers moved). About 0.1 ms
 * in WebAssembly.
 */
export function timeInfoAt(source: EngineSource, jd: number): TimeInfo | null {
  if (!Number.isFinite(jd)) return null;
  const engine: ExplorerEngine = engineOf(source);
  if (!isTimeEngine(engine)) return null;
  let coverage: unknown = null;
  try {
    coverage = engine.coverage();
  } catch {
    coverage = null;
  }
  let entry = recent.get(engine);
  if (!entry || entry.coverage !== coverage) recent.set(engine, (entry = { coverage, map: new Map() }));
  const map = entry.map;
  const hit = map.get(jd);
  if (hit) return hit;
  let info: TimeInfo;
  try {
    info = engine.timeInfo(jd);
  } catch {
    return null;
  }
  if (map.size >= RECENT_MAX) map.delete(map.keys().next().value as number);
  map.set(jd, info);
  return info;
}

/**
 * The uncertainty that applies to a whole day or night (a list of rise and set times, a
 * table row): σ changes by well under a second a day, so the day's middle speaks for it.
 */
export function timeInfoForSpan(source: EngineSource, jdStart: number, jdEnd: number): TimeInfo | null {
  return timeInfoAt(source, Math.round(((jdStart + jdEnd) / 2) * 1440) / 1440);
}
