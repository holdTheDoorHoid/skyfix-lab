/**
 * The Selected card's tools for photographers and astronomers (expansion programme Q8,
 * photo agent): golden and blue hour beside the twilight table, the Milky Way planner, the
 * bearing shared by "When is it at…?" and the alignment finder (typed, or picked on the
 * map, and drawn there as a ray), and, for every body, its right ascension and declination
 * and its magnetic bearing.
 *
 * Every number comes from the engine (EXPLORER_PLAN §3.1): `sun_hours`,
 * `galactic_centre_windows`, `sky_state`, `magnetic_field`, `time_info`. Each engine is
 * behind its type guard, and a build without it gets a plain sentence, never an error.
 * The pure parts (`lightTable`, `galacticNight`, `bestNights`, `Settler`, …) are tested with
 * the mock engine in photo-tools.test.ts; the DOM parts by web/scripts/ui-check.mjs.
 *
 * Performance (the brief: under 5 ms per time-bar redraw): what costs more than a
 * millisecond is asked once per local day or night (the memoised engine keeps the answer),
 * and only once the time settles (`Settler`) while the time bar is being dragged.
 */

import './photo.css';
import type { FeatureCollection } from 'geojson';
import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import {
  isGeomagEngine,
  isSunToolsEngine,
  isTidePackNotLoaded,
  isTidesEngine,
  isTimeEngine,
  TIDE_LABEL,
  type BodyState,
  type GalacticCentreWindows,
  type GalacticWindow,
  type LatLonDeg,
  type MagneticField,
  type SunHours,
  type SunLightKind,
  type SunLightWindow,
  type TideEvent,
  type TideExtremes,
  type TideStationNear,
} from '../engine/types.js';
import { mapServiceFor, pathFeature, pointFeature } from '../map/overlays.js';
import { mapPickerFor } from '../map/pick.js';
import { setTime } from '../playback.js';
import { clampToCoverage, dayOf, setAttr, setText } from '../shell/derived.js';
import { bearing3, compassPoint, compassWords, dateShort, eventTime, formatAngle, formatAzimuth, MINUS, otherDay } from '../shell/format.js';
import { createStore, displayZone, engineObserver, shallowEqual, type ExplorerState } from '../state.js';
import { icon } from '../theme/icons.js';
import { swatch } from '../theme/primitives.js';
import { dayWindow, jdFromWallClock, wallClock, type Zone } from '../time.js';
import {
  formatDecSigned,
  formatRa,
  geodesicInverse,
  magneticFromTrue,
  minutesText,
  normBearing,
  rayPoints,
  timeRange,
} from './sun-tools.js';

// ---------------------------------------------------------------------------------
// Waiting for the time to settle
// ---------------------------------------------------------------------------------

/** How long the time must be still before an expensive row is worked out again, ms. */
export const SETTLE_MS = 250;
/** While the time keeps moving, an expensive row is still worked out at least this often, ms. */
export const MAX_WAIT_MS = 2000;

export interface SettlerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: SettlerClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Whether the time shown is moving: being dragged on the time bar, or playing. `note(jd)`
 * is called on every render with the time shown; the time is moving while it changed less
 * than `delayMs` ago and the change before that was less than `delayMs` earlier still. A
 * single jump (a time pressed in a list, a day stepped) is not motion: what depends on it
 * is worked out at once.
 */
export class Motion {
  private lastJd = Number.NaN;
  private lastChange = -Infinity;
  private prevChange = -Infinity;

  constructor(
    private readonly clock: Pick<SettlerClock, 'now'> = REAL_CLOCK,
    private readonly delayMs = SETTLE_MS,
  ) {}

  note(jd: number): boolean {
    const now = this.clock.now();
    if (jd !== this.lastJd) {
      this.prevChange = this.lastChange;
      this.lastChange = now;
      this.lastJd = jd;
    }
    return now - this.lastChange < this.delayMs && this.lastChange - this.prevChange < this.delayMs;
  }
}

/**
 * Runs an expensive computation (a day's golden hours, a month of Milky Way nights, the
 * Moon's apsides) once per key (a day, a night, a fortnight): at once while the time is
 * still, and while it moves (`Motion`) only once it settles, or at least every
 * `maxWaitMs` for the cheaper ones (a few milliseconds), so a drag of the time bar never
 * waits for it. The heaviest (tens of milliseconds and more) pass `Infinity` and wait for the
 * time to settle whatever happens. The row is marked stale in between (`onStale`). As
 * `navigate/tonight.ts` does for tonight's sights.
 */
export class Settler {
  private key: string | null = null;
  private firstDeferred = 0;
  private timer: unknown = null;
  private pending: (() => void) | null = null;

  constructor(
    private readonly clock: SettlerClock = REAL_CLOCK,
    private readonly delayMs = SETTLE_MS,
    private readonly maxWaitMs = MAX_WAIT_MS,
  ) {}

  /**
   * Ask for `run` under `key`. Nothing happens when the key is the one last asked for.
   * Returns true when `run` ran now; false when it waits (after calling `onStale`).
   */
  request(key: string, moving: boolean, run: () => void, onStale?: () => void): boolean {
    if (key === this.key) return false;
    this.key = key;
    const now = this.clock.now();
    if (!moving || (this.timer !== null && now - this.firstDeferred >= this.maxWaitMs)) {
      this.clear();
      run();
      return true;
    }
    onStale?.();
    if (this.timer === null) this.firstDeferred = now;
    else this.clock.clearTimeout(this.timer);
    this.pending = run;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      const fn = this.pending;
      this.pending = null;
      fn?.();
    }, this.delayMs);
    return false;
  }

  /** Forget the last key, so the next request runs again (a pack loaded). */
  reset(): void {
    this.key = null;
  }

  /** Stop a waiting run (the component is destroyed). */
  cancel(): void {
    this.clear();
    this.key = null;
  }

  private clear(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

function reducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------
// Uncertainty of a time: until the time-ui helpers land
// ---------------------------------------------------------------------------------

/**
 * ` ±12 min` when the engine says the Earth's rotation at `jd` is uncertain by more than
 * 30 s (`time_info.delta_t_sigma_s`, CONVENTIONS 15.2), else ''. The labelled tier's rule:
 * no time without its uncertainty.
 */
// time-ui: replace with the shared ±ΔT chip (web/src/next/time/, uncertaintyChip(timeInfo)).
export function deltaTNote(ctx: Pick<Ctx, 'engine'>, jd: number): string {
  const engine = ctx.engine;
  if (!isTimeEngine(engine)) return '';
  try {
    const sigma = engine.timeInfo(jd).delta_t_sigma_s;
    if (!(sigma > 30)) return '';
    return sigma >= 5400 ? ` ±${(sigma / 3600).toFixed(1)} h` : ` ±${Math.max(1, Math.round(sigma / 60))} min`;
  } catch {
    return '';
  }
}

/**
 * Whether `jd` is in the validated tier (CONVENTIONS 15.1), where sights and predicted
 * readings are offered. Engines without `time_info` answer only inside it.
 */
// time-ui: use the shared tierAt(jd) helper when it lands.
export function inValidatedTier(ctx: Pick<Ctx, 'engine'>, jd: number): boolean {
  const engine = ctx.engine;
  if (!isTimeEngine(engine)) return true;
  try {
    return engine.timeInfo(jd).tier === 'validated';
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------
// Golden and blue hour (the Sun card)
// ---------------------------------------------------------------------------------

export const LIGHT_TIPS: Record<SunLightKind, string> = {
  golden:
    'Golden hour: the Sun between 6° above and 4° below the horizon (its centre, no refraction), when the light is low, warm and soft. A photographers’ convention, not a physical boundary.',
  blue: 'Blue hour: the Sun between 4° and 6° below the horizon, when the sky is a deep blue and lights come on; it ends at the end of civil twilight in the evening and begins with it in the morning. A photographers’ convention, not a physical boundary.',
};

export interface LightCell {
  text: string;
  tip: string;
  /** The instant pressing the cell shows: the start of the window (or its end when it began earlier). */
  jd: number | null;
}

export interface LightRowModel {
  kind: SunLightKind;
  label: string;
  morning: LightCell;
  evening: LightCell;
  /** A window that is neither morning nor evening (around noon or midnight, all day), across both columns. */
  whole: LightCell | null;
}

export interface LightTableModel {
  rows: LightRowModel[];
  /** A sentence when the Sun never passes through a band today (polar day or night). */
  note: string | null;
}

const NONE: LightCell = { text: '—', tip: '', jd: null };

function cellFor(w: SunLightWindow, zone: Zone, dt: string): LightCell {
  const a = eventTime(w.jd_start, zone);
  const b = eventTime(w.jd_end, zone);
  if (w.open_start && w.open_end) return { text: 'All day', tip: 'The whole day', jd: null };
  if (w.open_start) return { text: `to ${b}${dt}`, tip: `It began before midnight and ends at ${b}.`, jd: w.jd_end };
  if (w.open_end) return { text: `from ${a}${dt}`, tip: `It begins at ${a} and goes on past midnight.`, jd: w.jd_start };
  return { text: `${timeRange(w.jd_start, w.jd_end, zone)}${dt}`, tip: `${minutesText(w.duration_min)}, ${a} to ${b}.`, jd: w.jd_start };
}

/**
 * The golden and blue hour rows for one local day, from `sun_hours`: a morning and an
 * evening cell each (a time range), or one cell across both for a window around noon,
 * around midnight or all day (high latitudes), and a sentence when the Sun never enters a
 * band. `dt` is the uncertainty note to put after every time (`deltaTNote`).
 */
export function lightTable(hours: SunHours, zone: Zone, dt = ''): LightTableModel {
  const rows: LightRowModel[] = (['golden', 'blue'] as const).map((kind) => {
    const of = hours.windows.filter((w) => w.kind === kind);
    const morning = of.find((w) => w.period === 'morning');
    const evening = of.find((w) => w.period === 'evening');
    const other = of.find((w) => w.period === 'midday' || w.period === 'midnight' || w.period === 'all_day');
    let whole: LightCell | null = null;
    if (other) {
      if (other.period === 'all_day') whole = { text: 'All day', tip: 'The Sun stays in this band the whole day.', jd: null };
      else {
        const c = cellFor(other, zone, dt);
        const around = other.period === 'midday' ? 'Around noon' : 'Around midnight';
        whole = { ...c, text: `${around}, ${c.text}`, tip: `${around}: ${other.period === 'midday' ? 'the Sun culminates inside the band' : 'the Sun’s lowest point is inside the band'}. ${c.tip}` };
      }
    }
    return {
      kind,
      label: kind === 'golden' ? 'Golden hour' : 'Blue hour',
      morning: morning ? cellFor(morning, zone, dt) : NONE,
      evening: evening ? cellFor(evening, zone, dt) : NONE,
      whole,
    };
  });
  // Polar words, from the thresholds (−6, −4, +6 degrees) the Sun never crosses.
  const by = (alt: number) => hours.boundaries.find((b) => b.altitude_deg === alt);
  const b6 = by(6);
  const bm6 = by(-6);
  let note: string | null = null;
  if (!hours.windows.length) {
    if (b6?.always_above) note = 'The Sun stays more than 6° up all day: no golden or blue hour today.';
    else if (bm6?.always_below) note = 'The Sun stays more than 6° below the horizon all day: no golden or blue hour today.';
    else note = 'No golden or blue hour today.';
  }
  return { rows, note };
}

/** The golden and blue hour table's element, redrawn by `update`. */
export interface LightTableView {
  el: HTMLElement;
  /** `moving`: the time is being dragged or playing (`Motion`). */
  update(s: ExplorerState, moving: boolean): void;
  destroy(): void;
}

/**
 * Golden and blue hour for the local day shown, beside the twilight table (the Sun card).
 * `sun_hours` costs a few milliseconds: asked once per day and place, and while the time
 * bar is dragged across days only when it settles.
 */
export function lightTableView(ctx: Ctx): LightTableView {
  const { store, engine } = ctx;
  const body = h('tbody', {});
  const note = h('p', { class: 'sf-photo__note', hidden: true });
  const table = h(
    'table',
    { class: 'sf-table sf-photo-light__table', 'aria-label': 'Golden and blue hour' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Light for photos'), h('th', { scope: 'col', class: 'sf-num-r' }, 'Morning'), h('th', { scope: 'col', class: 'sf-num-r' }, 'Evening'))),
    body,
  );
  const el = h('div', { class: 'sf-twilight sf-photo-light', 'data-tip': `${LIGHT_TIPS.golden} ${LIGHT_TIPS.blue}` }, table, note);
  const settler = new Settler();

  const cellEl = (c: LightCell, colspan?: number): HTMLElement => {
    const td = h('td', { class: 'sf-num-r', colspan, 'data-tip': c.tip || undefined });
    if (c.jd === null) {
      td.textContent = c.text;
      return td;
    }
    const jd = c.jd;
    const b = h('button', { type: 'button', class: 'sf-photo__time', 'aria-label': `Show ${c.text}` }, c.text);
    b.addEventListener('click', () => setTime(store, jd));
    td.append(b);
    return td;
  };

  const draw = (s: ExplorerState): void => {
    el.removeAttribute('data-stale');
    if (!isSunToolsEngine(engine)) {
      body.replaceChildren();
      note.hidden = false;
      setText(note, 'Golden and blue hour are not available in this engine: rebuild the WebAssembly package.');
      return;
    }
    const zone = displayZone(s);
    const [a, b] = dayWindow(s.time.jd_utc, zone);
    const span = clampToCoverage(ctx, a, b);
    let hours: SunHours | null = null;
    let error = '';
    if (span) {
      try {
        hours = engine.sunHours(engineObserver(s), span[0], span[1]);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    if (!hours) {
      body.replaceChildren();
      note.hidden = false;
      setText(note, span ? `Golden and blue hour: not computed (${error}).` : 'Golden and blue hour: this day is outside the years the core covers.');
      return;
    }
    const model = lightTable(hours, zone, deltaTNote(ctx, s.time.jd_utc));
    body.replaceChildren(
      ...model.rows.map((r) =>
        h(
          'tr',
          { 'data-kind': r.kind, 'data-tip': LIGHT_TIPS[r.kind] },
          h('th', { scope: 'row' }, swatch(r.kind === 'golden' ? 'var(--body-sun)' : 'var(--phase-civil)'), r.label),
          ...(r.whole ? [cellEl(r.whole, 2)] : [cellEl(r.morning), cellEl(r.evening)]),
        ),
      ),
    );
    note.hidden = !model.note;
    setText(note, model.note ?? '');
  };

  return {
    el,
    update(s, moving) {
      const zone = displayZone(s);
      const [a] = dayWindow(s.time.jd_utc, zone);
      const key = `${a}|${s.observer.lat_deg}|${s.observer.lon_deg}|${s.observer.height_m}|${s.settings.hourCycle}|${s.settings.timeDisplay}|${JSON.stringify(s.observer.zone)}`;
      settler.request(key, moving, () => draw(store.get()), () => el.setAttribute('data-stale', ''));
    },
    destroy: () => settler.cancel(),
  };
}

// ---------------------------------------------------------------------------------
// The bearing: typed or picked on the map, shared by the tools, drawn as a ray
// ---------------------------------------------------------------------------------

export interface BearingValue {
  /** Degrees from true north, [0, 360), or null when none is set. */
  azimuth: number | null;
  /** What was typed (kept so the field shows it back), or the picked bearing's text. */
  text: string;
  /** The point picked on the map, while the place has not moved since. */
  target: LatLonDeg | null;
  /** The place the bearing was picked from. */
  from: LatLonDeg | null;
  /** Distance to the picked point, metres. */
  distance_m: number | null;
}

export interface PhotoBearing {
  get(): BearingValue;
  /** A bearing typed in a field (`azimuth` null when the text is not a bearing). */
  setTyped(text: string, azimuth: number | null): void;
  /** Wait for a click on the map; the bearing becomes the direction from `from` to the point. */
  pick(from: LatLonDeg, done?: (value: BearingValue) => void): void;
  /** Stop a waiting pick. */
  cancelPick(): void;
  picking(): boolean;
  subscribe(listener: (value: BearingValue) => void): () => void;
  /** While any holder holds it, the ray is drawn on the map. Returns the release function. */
  holdRay(): () => void;
}

/** The overlay id of the ray (the Layers menu lists it under "photo-", map/controls.ts). */
export const RAY_ID = 'photo-bearing';

/**
 * Length of the ray drawn for a bearing, km: at the map's opening zoom it reaches well past
 * the compass dial drawn round the place (whose radius is a few hundred kilometres there).
 */
const RAY_KM = 3000;

const bearings = new WeakMap<object, PhotoBearing>();

/** The page's shared bearing (one per store). */
export function photoBearing(ctx: Pick<Ctx, 'store'>): PhotoBearing {
  let b = bearings.get(ctx.store);
  if (!b) {
    b = createPhotoBearing(ctx);
    bearings.set(ctx.store, b);
  }
  return b;
}

function sameSpot(a: LatLonDeg | null, b: LatLonDeg): boolean {
  return Boolean(a) && Math.abs(a!.lat_deg - b.lat_deg) < 1e-9 && Math.abs(a!.lon_deg - b.lon_deg) < 1e-9;
}

function createPhotoBearing(ctx: Pick<Ctx, 'store'>): PhotoBearing {
  const value = createStore<BearingValue>({ azimuth: null, text: '', target: null, from: null, distance_m: null });
  const picker = mapPickerFor(ctx);
  let cancelPick: (() => void) | null = null;
  let holders = 0;
  /** The person took the ray off the map (Layers → Remove): keep it off until the bearing changes. */
  let removedByPerson = false;
  let drawing = false;
  let stopObserver: (() => void) | null = null;
  let stopService: (() => void) | null = null;

  const service = (): ReturnType<typeof mapServiceFor> => mapServiceFor(ctx);

  const draw = (): void => {
    const v = value.get();
    const o = ctx.store.get().observer;
    const here = { lat_deg: o.lat_deg, lon_deg: o.lon_deg };
    const wanted = holders > 0 && v.azimuth !== null && !removedByPerson;
    drawing = true;
    try {
      if (!wanted) {
        if (service().hasOverlay(RAY_ID)) service().removeOverlay(RAY_ID);
        return;
      }
      const onTarget = v.target && sameSpot(v.from, here) ? v.target : null;
      const km = onTarget && v.distance_m ? Math.min(10_000, Math.max(RAY_KM, (v.distance_m / 1000) * 1.2)) : RAY_KM;
      const label = `${v.azimuth!.toFixed(1)}° true`;
      const fc: FeatureCollection = {
        type: 'FeatureCollection',
        features: [pathFeature(rayPoints(here, v.azimuth!, km, km / 200), { label })],
      };
      if (onTarget) fc.features.push(pointFeature(onTarget, { label: 'Picked point' }));
      service().addOverlay(RAY_ID, fc, { color: '--accent', width: 2.5, dash: '--dash-rise', labelProperty: 'label', pointRadius: 5, z: 2 });
    } finally {
      drawing = false;
    }
  };

  const watchWhileHeld = (): void => {
    if (holders > 0 && !stopObserver) {
      stopObserver = ctx.store.select((s) => s.observer, draw);
      stopService = service().subscribe((e) => {
        if (e.kind === 'remove' && e.id === RAY_ID && !drawing) removedByPerson = true;
      });
    } else if (holders === 0 && stopObserver) {
      stopObserver();
      stopService?.();
      stopObserver = null;
      stopService = null;
    }
  };

  value.subscribe(() => {
    removedByPerson = false;
    draw();
  });

  return {
    get: () => value.get(),
    setTyped(text, azimuth) {
      const v = value.get();
      if (v.text === text && v.azimuth === azimuth && !v.target) return;
      value.set({ azimuth, text, target: null, from: null, distance_m: null });
    },
    pick(from, done) {
      cancelPick?.();
      cancelPick = picker.request({
        prompt: 'Click the point the bearing should run to: a street, a peak, a window.',
        onPick: (point) => {
          cancelPick = null;
          const g = geodesicInverse(from, point);
          if (!Number.isFinite(g.azimuth_deg)) return;
          const azimuth = Number(normBearing(g.azimuth_deg).toFixed(2));
          value.set({ azimuth, text: azimuth.toFixed(1), target: point, from: { ...from }, distance_m: g.distance_m });
          done?.(value.get());
        },
        onCancel: () => {
          cancelPick = null;
          value.set({ ...value.get() });
        },
      });
      value.set({ ...value.get() });
    },
    cancelPick() {
      cancelPick?.();
    },
    picking: () => cancelPick !== null,
    subscribe(listener) {
      return value.subscribe((v) => listener(v));
    },
    holdRay() {
      holders += 1;
      watchWhileHeld();
      draw();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders -= 1;
        watchWhileHeld();
        draw();
      };
    },
  };
}

/** How the bearing's source reads under the field: "Picked on the map: 1.2 km to the point." */
export function bearingSourceText(v: BearingValue, here: LatLonDeg): string {
  if (!v.target || !sameSpot(v.from, here) || v.distance_m === null) return '';
  const d = v.distance_m;
  const dist = d < 1000 ? `${Math.round(d)} m` : d < 100_000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 1000)} km`;
  return `Picked on the map: the point is ${dist} away.`;
}

// ---------------------------------------------------------------------------------
// The Milky Way planner
// ---------------------------------------------------------------------------------

/**
 * The night the planner describes: local noon to the next local noon on the display clock.
 * `sunUp` is asked only before noon (it costs an engine call).
 */
export function nightWindow(jd: number, zone: Zone, sunUp: boolean | (() => boolean)): [number, number] {
  const w = wallClock(jd, zone);
  const noon = jdFromWallClock({ year: w.year, month: w.month, day: w.day, hour: 12 }, zone);
  const up = (): boolean => (typeof sunUp === 'function' ? sunUp() : sunUp);
  // After noon: tonight. In the morning: last night while it is still dark, else tonight.
  const start = jd >= noon ? noon : up() ? noon : jdFromWallClock({ year: w.year, month: w.month, day: w.day - 1, hour: 12 }, zone);
  const w2 = wallClock(start, zone);
  return [start, jdFromWallClock({ year: w2.year, month: w2.month, day: w2.day + 1, hour: 12 }, zone)];
}

function dirText(az: number): string {
  return `${compassWords(az)} (${bearing3(az)})`;
}

export interface GalacticNightModel {
  windows: GalacticWindow[];
  /** The window whose best moment is highest, Moon-free ones first; null when there is none. */
  best: GalacticWindow | null;
  /** Plain sentences: when, where, the Moon. */
  sentences: string[];
  /** The arch at the best moment, in words. */
  arch: string | null;
}

/** Tonight's dark-sky windows for the galactic centre, in words (`galactic_centre_windows`). */
export function galacticNight(result: GalacticCentreWindows, zone: Zone, format: ExplorerState['settings']['angleFormat'], dt = ''): GalacticNightModel {
  const windows = [...result.windows].sort((a, b) => a.jd_start - b.jd_start);
  if (!windows.length) {
    return {
      windows,
      best: null,
      sentences: [
        `The Milky Way’s core does not climb ${Math.round(result.min_altitude_deg)}° above the horizon while the sky is fully dark tonight (the Sun ${Math.abs(result.sun_max_altitude_deg)}° or more below the horizon).`,
      ],
      arch: null,
    };
  }
  const moonFree = windows.filter((w) => !w.moon_up);
  const pool = moonFree.length ? moonFree : windows;
  const best = pool.reduce((a, b) => (b.best.alt_apparent_deg > a.best.alt_apparent_deg ? b : a));
  const first = windows[0]!;
  const last = windows[windows.length - 1]!;
  const total = windows.reduce((sum, w) => sum + w.duration_h * 60, 0);
  const sentences = [
    `The Milky Way’s core is up in a fully dark sky from ${eventTime(first.jd_start, zone)} to ${eventTime(last.jd_end, zone)}${dt} (${minutesText(total)}${windows.length > 1 ? ' in all' : ''}).`,
    `Best at ${eventTime(best.best.jd_utc, zone)}${dt}: ${formatAngle(best.best.alt_apparent_deg, format, 'coarse')} high in the ${dirText(best.best.az_deg)}.`,
  ];
  const lit = (f: number) => `${Math.round(f * 100)} % lit`;
  if (!moonFree.length) {
    const k = first.moon_illuminated_fraction;
    sentences.push(
      k < 0.25
        ? `The Moon (${lit(k)}) is up the whole time; a crescent this thin brightens the sky only a little.`
        : `The Moon (${lit(k)}) is up the whole time: its light will wash out the fainter parts.`,
    );
  } else if (moonFree.length === windows.length) {
    sentences.push(first.moon_illuminated_fraction < 0.02 ? 'No Moon in the sky: the best kind of night.' : 'The Moon is down the whole time.');
  } else {
    const free = moonFree.reduce((sum, w) => sum + w.duration_h * 60, 0);
    const spans = moonFree.map((w) => timeRange(w.jd_start, w.jd_end, zone)).join(' and ');
    sentences.push(`Without the Moon: ${spans}${dt} (${minutesText(free)}); the Moon (${lit(first.moon_illuminated_fraction)}) is up for the rest.`);
  }
  const m = best.best;
  const [e1, e2] = m.arch_ends_az_deg;
  const arch = `At its best the band arches from the ${compassWords(e1)} (${bearing3(e1)}) to the ${compassWords(e2)} (${bearing3(e2)}), highest (${Math.round(m.arch_top_alt_deg)}°) toward the ${compassWords(m.arch_top_az_deg)}.`;
  return { windows, best, sentences, arch };
}

export interface BestNight {
  /** The night's start (local noon). */
  night_start: number;
  /** Minutes of dark sky with the core above the limit and the Moon down. */
  moon_free_min: number;
  /** The Moon-free window with the highest core, and that moment. */
  window: GalacticWindow;
  alt_deg: number;
  /** One of the best few by Moon-free time. */
  top: boolean;
}

/**
 * The nights of a span (`galactic_centre_windows` over a month) with at least `minMinutes`
 * of Moon-free dark sky with the core up, in date order; the `topN` with the most
 * Moon-free time are marked `top`.
 */
export function bestNights(result: GalacticCentreWindows, firstNight: number, minMinutes = 30, topN = 3): BestNight[] {
  const byNight = new Map<number, GalacticWindow[]>();
  for (const w of result.windows) {
    if (w.moon_up) continue;
    const k = Math.floor(w.jd_start - firstNight + 1e-9);
    byNight.set(k, [...(byNight.get(k) ?? []), w]);
  }
  const out: BestNight[] = [];
  for (const [k, list] of byNight) {
    const minutes = list.reduce((sum, w) => sum + w.duration_h * 60, 0);
    if (minutes < minMinutes) continue;
    const window = list.reduce((a, b) => (b.best.alt_apparent_deg > a.best.alt_apparent_deg ? b : a));
    out.push({ night_start: firstNight + k, moon_free_min: minutes, window, alt_deg: window.best.alt_apparent_deg, top: false });
  }
  [...out]
    .sort((a, b) => b.moon_free_min - a.moon_free_min || b.alt_deg - a.alt_deg)
    .slice(0, topN)
    .forEach((n) => {
      n.top = true;
    });
  return out.sort((a, b) => a.night_start - b.night_start);
}

const planners = new WeakMap<object, { open(): void }>();
const pendingOpen = new WeakSet<object>();

/**
 * Open the Milky Way planner on the Selected card and bring it into view: the Tonight
 * view's "Plan a photo" (tonight agent). Works before the panel has mounted.
 */
export function openMilkyWayPlanner(ctx: Pick<Ctx, 'store'>): void {
  const p = planners.get(ctx.store);
  if (p) p.open();
  else pendingOpen.add(ctx.store);
}

export interface MilkyWayTool {
  el: HTMLElement;
  update(s: ExplorerState, moving: boolean): void;
  destroy(): void;
}

/** The planner's drawer on the Selected card (every body: the Milky Way is not one of them). */
export function milkyWayTool(ctx: Ctx): MilkyWayTool {
  const { store, engine } = ctx;
  const status = h('div', { class: 'sf-photo__lines', 'aria-live': 'polite' });
  const arch = h('p', { class: 'sf-photo__note' });
  const actions = h('div', { class: 'sf-photo__actions' });
  const monthHead = h('p', { class: 'sf-photo__subhead' }, 'The best nights in the next 30 (Moon-free)');
  const month = h('ul', { class: 'sf-photo__list', 'aria-label': 'The best nights for the Milky Way' });
  const monthStatus = h('p', { class: 'sf-photo__note', role: 'status' });
  const el = h(
    'details',
    { class: 'sf-details sf-photo-mw' },
    h('summary', {}, 'Milky Way planner', icon('chevron-down')),
    h(
      'div',
      { class: 'sf-photo__body' },
      h(
        'p',
        { class: 'sf-photo__intro' },
        'When the bright core of the Milky Way (the direction of the galaxy’s centre, in Sagittarius) is at least 10° up in a fully dark sky, and where the band stands.',
      ),
      status,
      arch,
      actions,
      monthHead,
      monthStatus,
      month,
    ),
  ) as HTMLDetailsElement;
  const nightSettler = new Settler();
  // A month of nights is about 0.1 s: never while the time moves.
  const monthSettler = new Settler(undefined, SETTLE_MS, Infinity);
  let last: ExplorerState | null = null;
  let lastMoving = false;

  const unavailable = !isSunToolsEngine(engine);
  if (unavailable) {
    status.replaceChildren(h('p', { class: 'sf-photo__note' }, 'The Milky Way planner is not available in this engine: rebuild the WebAssembly package.'));
    monthHead.hidden = true;
  }

  const sunUp = (s: ExplorerState): boolean => {
    try {
      return engine.skyState(engineObserver(s), s.time.jd_utc, ['Sun']).sun_altitude_deg > -0.833;
    } catch {
      return false;
    }
  };

  const drawNight = (s: ExplorerState): void => {
    status.removeAttribute('data-stale');
    if (!isSunToolsEngine(engine)) return;
    const zone = displayZone(s);
    const [a, b] = nightWindow(s.time.jd_utc, zone, () => sunUp(s));
    const span = clampToCoverage(ctx, a, b);
    let result: GalacticCentreWindows | null = null;
    let error = '';
    if (span) {
      try {
        result = engine.galacticCentreWindows(engineObserver(s), span[0], span[1]);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    actions.replaceChildren();
    if (!result) {
      status.replaceChildren(h('p', { class: 'sf-photo__note' }, span ? `Not computed: ${error}.` : 'This night is outside the years the core covers.'));
      setText(arch, '');
      return;
    }
    const model = galacticNight(result, zone, s.settings.angleFormat, deltaTNote(ctx, a));
    status.replaceChildren(
      h('p', { class: 'sf-photo__head' }, `The night of ${dateShort(a, zone)}`),
      ...model.sentences.map((t) => h('p', { class: 'sf-photo__line' }, t)),
    );
    setText(arch, model.arch ?? '');
    arch.hidden = !model.arch;
    if (model.best) {
      const best = model.best.best;
      const at = eventTime(best.jd_utc, zone);
      const show = h('button', { type: 'button', class: 'sf-btn sf-btn--secondary sf-btn--sm' }, icon('clock'), h('span', { class: 'sf-btn__label' }, `Show ${at}`));
      show.addEventListener('click', () => setTime(store, best.jd_utc));
      const sky = h('button', { type: 'button', class: 'sf-btn sf-btn--secondary sf-btn--sm' }, icon('sky'), h('span', { class: 'sf-btn__label' }, 'Show in Sky'));
      sky.addEventListener('click', () => {
        // sky2: aim the Sky view at the galactic centre (az best.az_deg, alt best.alt_apparent_deg) once it offers a way.
        store.batch(() => {
          setTime(store, best.jd_utc);
          store.patch({ view: 'sky' });
        });
      });
      actions.replaceChildren(show, sky);
    }
  };

  const drawMonth = (s: ExplorerState): void => {
    month.removeAttribute('data-stale');
    if (!isSunToolsEngine(engine)) return;
    const zone = displayZone(s);
    const [a] = nightWindow(s.time.jd_utc, zone, () => sunUp(s));
    const span = clampToCoverage(ctx, a, a + 30);
    let result: GalacticCentreWindows | null = null;
    let error = '';
    if (span) {
      try {
        result = engine.galacticCentreWindows(engineObserver(s), span[0], span[1]);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    if (!result) {
      month.replaceChildren();
      setText(monthStatus, span ? `Not computed: ${error}.` : 'Outside the years the core covers.');
      return;
    }
    const nights = bestNights(result, a);
    const dt = deltaTNote(ctx, a);
    setText(
      monthStatus,
      nights.length
        ? 'Nights with at least half an hour of dark sky, the core up and the Moon down; the best three are marked. Press one to show its best moment.'
        : 'No night in the next 30 has half an hour of dark sky with the core up and the Moon down.',
    );
    month.replaceChildren(
      ...nights.map((n) => {
        const w = n.window;
        const b = h(
          'button',
          { type: 'button', class: `sf-photo__row${n.top ? ' sf-photo__row--best' : ''}`, 'aria-label': `Show ${dateShort(w.best.jd_utc, zone)} ${eventTime(w.best.jd_utc, zone)}` },
          h('span', { class: 'sf-photo__date' }, dateShort(n.night_start, zone)),
          h('span', { class: 'sf-num' }, `${timeRange(w.jd_start, w.jd_end, zone)}${dt}`),
          h('span', { class: 'sf-photo__what' }, `${minutesText(n.moon_free_min)} Moon-free, ${Math.round(n.alt_deg)}° high`),
          n.top ? h('span', { class: 'sf-photo__badge' }, 'best') : null,
        );
        b.addEventListener('click', () => setTime(store, w.best.jd_utc));
        return h('li', {}, b);
      }),
    );
  };

  const run = (): void => {
    if (!last || !el.open || unavailable) return;
    const s = last;
    const zone = displayZone(s);
    const [a] = nightWindow(s.time.jd_utc, zone, () => sunUp(s));
    const place = `${s.observer.lat_deg}|${s.observer.lon_deg}|${s.observer.height_m}|${s.settings.angleFormat}|${s.settings.hourCycle}|${s.settings.timeDisplay}|${JSON.stringify(s.observer.zone)}`;
    nightSettler.request(`${a}|${place}`, lastMoving, () => drawNight(store.get()), () => status.setAttribute('data-stale', ''));
    monthSettler.request(`${a}|${place}`, lastMoving, () => drawMonth(store.get()), () => month.setAttribute('data-stale', ''));
  };
  el.addEventListener('toggle', run);

  const tool: MilkyWayTool = {
    el,
    update(s, moving) {
      last = s;
      lastMoving = moving;
      run();
    },
    destroy() {
      nightSettler.cancel();
      monthSettler.cancel();
      if (planners.get(store)?.open === openNow) planners.delete(store);
    },
  };
  const openNow = (): void => {
    el.open = true;
    run();
    el.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    el.querySelector('summary')?.focus({ preventScroll: true });
  };
  planners.set(store, { open: openNow });
  if (pendingOpen.has(store)) {
    pendingOpen.delete(store);
    el.open = true;
  }
  return tool;
}

// ---------------------------------------------------------------------------------
// Every body: equatorial coordinates and the magnetic bearing
// ---------------------------------------------------------------------------------

/** Right ascension and declination with the navigator's SHA (`sky_state`: apparent, of date, geocentric). */
export function coordText(b: Pick<BodyState, 'ra_deg' | 'dec_deg' | 'sha_deg'>, format: ExplorerState['settings']['angleFormat']): {
  ra: string;
  dec: string;
  sha: string;
} {
  return { ra: formatRa(b.ra_deg, format), dec: formatDecSigned(b.dec_deg, format), sha: formatAngle(b.sha_deg, format, 'coarse') };
}

export const COORD_TIP =
  'Right ascension and declination: the body’s place among the stars, like longitude and latitude on the sky. The apparent place of the date, seen from the Earth’s centre, as an almanac lists it (the Moon seen from here is up to a degree away). Star charts and telescope catalogues use the year 2000’s axes (J2000), which precession has moved by a fraction of a degree since.';

export interface CoordRow {
  el: HTMLElement;
  update(b: BodyState, s: ExplorerState): void;
}

/** The "Sky position" row: RA and Dec, and the navigator's SHA beside (navigator's terms). */
export function coordRow(): CoordRow {
  const ra = h('span', { class: 'sf-num' });
  const dec = h('span', { class: 'sf-num' });
  const sha = h('span', { class: 'sf-num' });
  const el = h(
    'div',
    { class: 'sf-photo-coord', 'data-tip': COORD_TIP },
    h(
      'div',
      { class: 'sf-kv' },
      icon('target'),
      h('span', { class: 'sf-kv__k' }, 'Sky position'),
      h('span', { class: 'sf-kv__v sf-photo-coord__v' }, h('span', { class: 'sf-photo-coord__lab' }, 'RA '), ra, h('span', { class: 'sf-photo-coord__lab' }, ' Dec '), dec),
    ),
    h('div', { class: 'sf-photo-coord__term', 'data-term': '' }, 'right ascension, declination · SHA ', sha),
  );
  return {
    el,
    update(b, s) {
      const t = coordText(b, s.settings.angleFormat);
      setText(ra, t.ra);
      setText(dec, t.dec);
      setText(sha, t.sha);
    },
  };
}

export interface MagneticText {
  /** Under the direction readout: `257° magnetic`, or why there is none. */
  line: string;
  tip: string;
  available: boolean;
}

/** The magnetic bearing of a true azimuth at a place and date, in words (`magnetic_field`). */
export function magneticText(trueAz: number, field: MagneticField, format: ExplorerState['settings']['angleFormat']): MagneticText {
  if (!field.available) {
    const year = field.decimal_year;
    const which = year < 1900 ? 'before 1900' : year > 2030 ? 'after 2030' : 'here';
    return { line: `Magnetic: not available ${which}`, tip: field.reason, available: false };
  }
  const mag = magneticFromTrue(trueAz, field.declination_deg);
  const name = field.model === 'WMM2025' ? 'World Magnetic Model 2025' : 'International Geomagnetic Reference Field (IGRF-14)';
  const sigma = field.uncertainty.declination_deg;
  const sense = field.declination_deg < 0 ? 'west' : 'east';
  const add = field.declination_deg < 0 ? 'add' : 'subtract';
  const to = field.declination_deg < 0 ? 'to' : 'from';
  const zone =
    field.zone === 'blackout'
      ? ' Near a magnetic pole the compass is unreliable here.'
      : field.zone === 'caution'
        ? ' The field is weak here: a compass may be sluggish or wrong.'
        : '';
  const tip = `Variation ${field.variation_text}, ${name}, ±${sigma < 1 ? sigma.toFixed(1) : Math.round(sigma)}°: a compass here points ${Math.abs(field.declination_deg).toFixed(1)}° ${sense} of true north, so ${add} ${Math.abs(field.declination_deg).toFixed(1)}° ${to} a true bearing to get the magnetic one. ${field.annual_change_text.replace(/^./, (c) => c.toUpperCase())}.${zone}${field.forecast ? ' A forecast: the model extrapolates the field’s recent change.' : ''}`;
  return { line: `${formatAzimuth(mag, format === 'dms' ? 'dm' : format, 'coarse')} magnetic`, tip, available: true };
}

/** The magnetic bearing line under the direction readout, from the geomag engine; hidden without it. */
export function magneticLine(ctx: Ctx): { el: HTMLElement; update(b: BodyState, s: ExplorerState, day: number): void } {
  const el = h('div', { class: 'sf-photo-mag sf-num', tabindex: 0 });
  el.hidden = true;
  return {
    el,
    update(b, s, day) {
      const engine = ctx.engine;
      if (!isGeomagEngine(engine)) {
        el.hidden = true;
        return;
      }
      let field: MagneticField;
      try {
        // Once per day and place: the variation changes by minutes of arc a year.
        field = engine.magneticField(s.observer.lat_deg, s.observer.lon_deg, s.observer.height_m, day);
      } catch {
        el.hidden = true;
        return;
      }
      const t = magneticText(b.az_deg, field, s.settings.angleFormat);
      el.hidden = false;
      setText(el, t.line);
      setAttr(el, 'data-tip', t.tip);
      el.classList.toggle('sf-photo-mag--none', !t.available);
      setAttr(el, 'aria-label', t.available ? `${t.line}. ${t.tip}` : t.tip);
    },
  };
}

// ---------------------------------------------------------------------------------
// The tides line (the Place section)
// ---------------------------------------------------------------------------------

/** A station farther than this from the place gets no tides line, nautical miles. */
export const TIDE_RADIUS_NM = 50;
/** Tide predictions exist from 1900 to 2100 only (EXPLORER_API "Tides": `outside_range`). */
const TIDE_FIRST_JD = 2415020.5;
const TIDE_END_JD = 2488434.5;

export interface TideLineModel {
  station: TideStationNear;
  nextHigh: TideEvent | null;
  nextLow: TideEvent | null;
  /** From which comes first: a high next means the water is rising. */
  state: 'rising' | 'falling' | null;
  datum: string;
}

/** The next high and low water after `jd` from a station's tide table. */
export function tideLineModel(station: TideStationNear, extremes: TideExtremes, jd: number): TideLineModel {
  const after = extremes.extremes.filter((e) => e.jd_utc > jd).sort((a, b) => a.jd_utc - b.jd_utc);
  const nextHigh = after.find((e) => e.kind === 'high') ?? null;
  const nextLow = after.find((e) => e.kind === 'low') ?? null;
  const next = after[0];
  return { station, nextHigh, nextLow, state: next ? (next.kind === 'high' ? 'rising' : 'falling') : null, datum: extremes.datum };
}

/** A tide height in the chosen units, with a true minus: `1.9 m`, `−0.3 ft`. */
export function tideHeight(m: number, units: ExplorerState['settings']['units']): string {
  const v = units === 'imperial' ? m / 0.3048 : m;
  const text = Math.abs(v).toFixed(1);
  return `${v < 0 && Number(text) !== 0 ? MINUS : ''}${text} ${units === 'imperial' ? 'ft' : 'm'}`;
}

/** `2.1 NM N` (nautical and imperial: NM; metric: km). */
function stationDistance(st: TideStationNear, units: ExplorerState['settings']['units']): string {
  const d = units === 'metric' ? `${st.distance_km < 10 ? st.distance_km.toFixed(1) : Math.round(st.distance_km)} km` : `${st.distance_nm < 10 ? st.distance_nm.toFixed(1) : Math.round(st.distance_nm)} NM`;
  return `${d} ${compassPoint(st.bearing_deg)}`;
}

/** Which of the stations near the place to use: the nearest within the radius that predicts. */
function usableStations(near: readonly TideStationNear[]): TideStationNear[] {
  return near.filter((st) => st.distance_nm <= TIDE_RADIUS_NM && st.curve !== 'none' && !st.flags.includes('no_constants'));
}

/**
 * The next high and low water at the nearest NOAA station within 50 NM, in the Place
 * section, with a link to the Tides chart. Shown only when the `tides-us` pack is loaded (it
 * never asks for it: Settings → Data packs and the Tonight view offer it); a saved pack not
 * yet loaded is loaded through `ctx.packs.ensure`, which then asks no question. Hidden
 * outside 1900–2100 and where no station is near. Predictions, not observations: the line
 * says so.
 */
export function tidesLine(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const { store, engine } = ctx;
  const d = disposer();
  const high = h('span', { class: 'sf-kv__v' });
  const low = h('span', { class: 'sf-kv__v' });
  const where = h('span', {});
  const chart = h('button', { type: 'button', class: 'sf-link' }, 'Tides chart');
  chart.addEventListener('click', () => {
    // charts2: open the Charts view on its Tides tab once it has one (a per-store tab request).
    store.patch({ view: 'charts' });
  });
  const el = h(
    'div',
    { class: 'sf-photo-tide', hidden: true },
    h('div', { class: 'sf-kv', 'data-tip': '' }, icon('tide'), h('span', { class: 'sf-kv__k' }, 'Next high water'), high),
    h('div', { class: 'sf-kv' }, h('span', {}), h('span', { class: 'sf-kv__k' }, 'Next low water'), low),
    h('p', { class: 'sf-photo-tide__where' }, where, ' · predicted, not observed · ', chart),
  );
  const motion = new Motion();
  const settler = new Settler();
  let packVersion = 0;
  let ensuring = false;
  let ensured = false;

  const loaded = (): boolean => {
    if (!isTidesEngine(engine)) return false;
    try {
      return engine.tidePackInfo() !== null;
    } catch {
      return false;
    }
  };

  const hide = (): void => {
    el.hidden = true;
  };

  const draw = (s: ExplorerState): void => {
    el.removeAttribute('data-stale');
    if (!isTidesEngine(engine) || !loaded()) return hide();
    const jd = s.time.jd_utc;
    if (jd < TIDE_FIRST_JD || jd >= TIDE_END_JD) return hide();
    const zone = displayZone(s);
    const [a] = dayOf(s);
    // One table per local day: from the day before (a high just past) to three days ahead.
    const from = Math.max(TIDE_FIRST_JD, a - 1);
    const to = Math.min(TIDE_END_JD - 1e-6, a + 3);
    let model: TideLineModel | null = null;
    try {
      const near = usableStations(engine.tideStationsNear(s.observer.lat_deg, s.observer.lon_deg, 5));
      for (const st of near) {
        try {
          model = tideLineModel(st, engine.tideExtremes(st.id, from, to, ''), jd);
          break;
        } catch (error) {
          if (isTidePackNotLoaded(error)) return hide();
        }
      }
    } catch {
      return hide();
    }
    if (!model || (!model.nextHigh && !model.nextLow)) return hide();
    const u = s.settings.units;
    const cell = (e: TideEvent | null): string => {
      if (!e) return '—';
      const day = otherDay(e.jd_utc, jd, zone);
      return `${eventTime(e.jd_utc, zone)}${day ? ` ${day}` : ''} · ${tideHeight(e.height_m, u)}`;
    };
    setText(high, cell(model.nextHigh));
    setText(low, cell(model.nextLow));
    const st = model.station;
    setText(where, `${st.name}${st.state ? `, ${st.state}` : ''} (${stationDistance(st, u)})${model.state ? `, ${model.state}` : ''}`);
    const kind = st.kind === 'subordinate' ? ` A subordinate station: its times and heights are offsets from ${st.reference_name ?? 'a reference station'}, as NOAA's tide tables give them.` : '';
    setAttr(
      el,
      'data-tip',
      `${TIDE_LABEL}. Heights above ${model.datum === 'MLLW' ? 'mean lower low water (MLLW), the chart datum of US charts' : model.datum}. NOAA station ${st.id}.${kind}`,
    );
    el.hidden = false;
  };

  const render = (): void => {
    const s = store.get();
    const moving = motion.note(s.time.jd_utc);
    if (!isTidesEngine(engine)) return hide();
    if (!loaded()) {
      // A copy saved on this device but not yet loaded: load it (no question is asked).
      const st = ctx.packs.status().find((p) => p.name === 'tides-us');
      if (st?.saved && !ensuring && !ensured) {
        ensuring = true;
        void ctx.packs.ensure('tides-us', 'Tide times for US stations need the US tides pack.').then((ok) => {
          ensuring = false;
          ensured = ok;
          packVersion += 1;
          render();
        });
      }
      return hide();
    }
    const zone = displayZone(s);
    // The next high and low change only when the time passes one: worked out per local day
    // and redrawn per minute (the list of the day is kept by the memoised engine).
    const key = `${dayOf(s)[0]}|${Math.floor(s.time.jd_utc * 1440)}|${s.observer.lat_deg}|${s.observer.lon_deg}|${s.settings.units}|${s.settings.hourCycle}|${zone.kind === 'iana' ? zone.zone : zone.name}|${packVersion}`;
    settler.request(key, moving, () => draw(store.get()), () => el.setAttribute('data-stale', ''));
  };

  d.add(watch(ctx, (s) => [s.time.jd_utc, s.observer, s.settings] as const, render, { equals: shallowEqual }));
  d.add(
    ctx.packs.subscribe(() => {
      packVersion += 1;
      render();
    }),
  );
  d.add(() => settler.cancel());
  return { el, destroy: () => d.dispose() };
}

/** A minus sign for tests that compare text. */
export const PHOTO_MINUS = MINUS;
