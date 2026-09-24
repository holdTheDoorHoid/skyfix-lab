/**
 * The explorer's one shared state: place, time, selection, view, layers and settings
 * (EXPLORER_PLAN section 2), in a small typed store with no framework.
 *
 * Store rules
 * - `get()` returns the current state object. Treat it as immutable: change it only
 *   through `set`, `patch` or `batch`.
 * - `patch` merges ONE level deep: each slice named in the patch is shallow-merged into
 *   the current slice. A slice whose fields all compare `Object.is`-equal keeps its old
 *   object, so selectors see no change. `undefined` in a patch means "leave as is".
 * - Listeners run synchronously after each change, or once at the end of `batch`.
 *   A listener that changes the store triggers another round after the current one.
 *
 * Privacy rules (EXPLORER_PLAN section 1, owner decision)
 * - Only `settings` and `layers` are persisted (localStorage, every access guarded).
 *   The place — coordinates, name and time zone, which also reveals a region — is
 *   never persisted.
 * - Nothing here writes to the address bar. `encodeShare` is the one function that
 *   puts a position into a string, and the shell calls it only when the person presses
 *   Share.
 */

import type { EventOptions, Observer } from './engine/types.js';
import {
  dayWindow,
  isoUtc,
  isValidIanaZone,
  jdFromIso,
  jdNow,
  resolveZone,
  UTC_ZONE,
  type Zone,
  type ZoneChoice,
} from './time.js';

// ---------------------------------------------------------------------------
// Generic store
// ---------------------------------------------------------------------------

export type Listener<S> = (state: S, prev: S) => void;
export type Equality<T> = (a: T, b: T) => boolean;

/** One level of partial update: each slice may be given partially. */
export type StatePatch<S> = {
  [K in keyof S]?: S[K] extends readonly unknown[]
    ? S[K]
    : S[K] extends object
      ? Partial<S[K]>
      : S[K];
};

export interface SelectOptions<T> {
  /** Default `Object.is`. Use `shallowEqual` for selectors that build arrays or objects. */
  equals?: Equality<T>;
  /** Call the listener once right away with the current value. Default false. */
  immediate?: boolean;
}

export interface Store<S extends object> {
  get(): S;
  /** Replace the whole state (or compute it from the current one). */
  set(next: S | ((current: S) => S)): void;
  /** Merge one level deep (see the module notes). */
  patch(patch: StatePatch<S>): void;
  /** Called after every committed change with the new and the previous state. */
  subscribe(listener: Listener<S>): () => void;
  /** Called only when `selector(state)` changes under `equals`. */
  select<T>(
    selector: (state: S) => T,
    listener: (value: T, prev: T) => void,
    options?: SelectOptions<T>,
  ): () => void;
  /** Run `fn`; listeners are notified once, after it returns. Nests. */
  batch<R>(fn: () => R): R;
}

export interface StoreOptions {
  /** Where a throwing listener is reported. Default `console.error`. */
  onError?: (error: unknown) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** `Object.is` on each element (arrays) or each own key (plain objects). */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && Object.is(a[k], b[k]));
  }
  return false;
}

/** Apply a one-level patch; returns the same object when nothing changed. */
export function applyPatch<S extends object>(state: S, patch: StatePatch<S>): S {
  let next: S | null = null;
  for (const key of Object.keys(patch) as (keyof S)[]) {
    const value = patch[key] as unknown;
    if (value === undefined) continue;
    const current = state[key] as unknown;
    let merged: unknown = value;
    if (isPlainObject(current) && isPlainObject(value)) {
      let changed = false;
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined && !Object.is(current[k], v)) {
          changed = true;
          break;
        }
      }
      if (!changed) continue;
      const out: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
      merged = out;
    } else if (Object.is(current, value)) {
      continue;
    }
    next ??= { ...state };
    (next as Record<keyof S, unknown>)[key] = merged;
  }
  return next ?? state;
}

const MAX_ROUNDS = 100;

export function createStore<S extends object>(initial: S, options: StoreOptions = {}): Store<S> {
  const onError = options.onError ?? ((error: unknown) => console.error('store listener failed', error));
  let state = initial;
  let depth = 0;
  let pendingPrev: S | null = null;
  let notifying = false;
  const listeners = new Set<Listener<S>>();

  function flush(): void {
    if (notifying) return; // the running loop picks the change up
    notifying = true;
    try {
      let rounds = 0;
      while (pendingPrev !== null) {
        if (++rounds > MAX_ROUNDS) {
          pendingPrev = null;
          onError(new Error('store: listeners kept changing the state; stopped after 100 rounds'));
          break;
        }
        const prev = pendingPrev;
        pendingPrev = null;
        const current = state;
        for (const listener of [...listeners]) {
          try {
            listener(current, prev);
          } catch (error) {
            onError(error);
          }
        }
      }
    } finally {
      notifying = false;
    }
  }

  function commit(next: S): void {
    if (Object.is(next, state)) return;
    if (pendingPrev === null) pendingPrev = state;
    state = next;
    if (depth === 0) flush();
  }

  return {
    get: () => state,
    set(next) {
      commit(typeof next === 'function' ? (next as (current: S) => S)(state) : next);
    },
    patch(patch) {
      commit(applyPatch(state, patch));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select(selector, listener, opts = {}) {
      const equals = opts.equals ?? Object.is;
      let current = selector(state);
      if (opts.immediate) listener(current, current);
      const unsubscribe = (): void => {
        listeners.delete(wrapped);
      };
      const wrapped: Listener<S> = (s) => {
        const next = selector(s);
        if (equals(current, next)) return;
        const prev = current;
        current = next;
        listener(next, prev);
      };
      listeners.add(wrapped);
      return unsubscribe;
    },
    batch(fn) {
      depth += 1;
      try {
        return fn();
      } finally {
        depth -= 1;
        if (depth === 0) flush();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Explorer state
// ---------------------------------------------------------------------------

export type ViewId =
  | 'map'
  | 'globe'
  | 'sky'
  | 'charts'
  | 'navigate'
  | 'almanac'
  | 'events'
  | 'learn'
  | 'about';

export const VIEW_IDS: readonly ViewId[] = [
  'map',
  'globe',
  'sky',
  'charts',
  'navigate',
  'almanac',
  'events',
  'learn',
  'about',
];

export interface ObserverState {
  /** Geodetic latitude, north positive. */
  lat_deg: number;
  /** East positive, (-180, 180] (CONVENTIONS section 2). */
  lon_deg: number;
  /** Site height above the WGS84 ellipsoid, metres (engine input; not the height of eye). */
  height_m: number;
  /** Place name as shown ("Philadelphia City Hall"), or "" for a bare position. */
  label: string;
  /** The place's time zone (CONVENTIONS 13.8). */
  zone: ZoneChoice;
}

export interface TimeState {
  /** The instant being shown (EXPLORER_API "Common rules"). */
  jd_utc: number;
  /** Advancing at `speed`. Never true at the same time as `live`. */
  playing: boolean;
  /** Simulated seconds per real second while playing; negative runs backwards. */
  speed: number;
  /** Following the wall clock ("Now"). Any manual change of time turns this off. */
  live: boolean;
}

export interface SelectionState {
  /** Canonical body name, or null for nothing selected. */
  body: string | null;
}

/** Map and sky overlays. Every key is a simple on/off switch. */
export interface Layers {
  /** Map: day/night boundary. */
  terminator: boolean;
  /** Map: civil, nautical and astronomical twilight shading. */
  twilight: boolean;
  /** Map: ground points (GPs) of the bodies. */
  groundPoints: boolean;
  /** Map: circles of position of the bodies. */
  circles: boolean;
  /** Map: SunCalc-style compass overlay at the observer. */
  compass: boolean;
  /** Map and sky: today's path of the selected body. */
  paths: boolean;
  /** Map: latitude/longitude grid. */
  graticule: boolean;
  /** Map: optional online OpenStreetMap layer. Off by default (network; EXPLORER_PLAN 3.4). */
  streets: boolean;
  /** Sky: constellation figures. */
  constellations: boolean;
  /** Sky: constellation names. */
  constellationNames: boolean;
  /** Sky: names of the brighter stars. */
  starNames: boolean;
  /** Sky: altitude and azimuth grid. */
  altAzGrid: boolean;
  /** Sky: the ecliptic. */
  ecliptic: boolean;
  /** Sky: the celestial equator. */
  equator: boolean;
  /** Sky: the local meridian. */
  meridian: boolean;
}

export type Theme = 'light' | 'dark' | 'night';
/** Which clock is primary on screen; the other is always shown beside it. */
export type TimeDisplay = 'local' | 'utc';
/** `dm` = 39° 57.2′ (navigator), `dms` = 39° 57′ 09″, `decimal` = 39.9526°. */
export type AngleFormat = 'dm' | 'dms' | 'decimal';
/** metric: m, km · nautical: m, NM · imperial: ft, statute mi. */
export type Units = 'metric' | 'nautical' | 'imperial';
export type HorizonOption = EventOptions['horizon'];

export interface Settings {
  theme: Theme;
  timeDisplay: TimeDisplay;
  angleFormat: AngleFormat;
  units: Units;
  /** Show navigator terms beside plain words ("Height above horizon · altitude"). */
  navigatorTerms: boolean;
  /** Rise/set horizon for events (CONVENTIONS 13.3): sea-level or dipped by height of eye. */
  horizon: HorizonOption;
  /** Instrument: height of eye above the sea, metres. */
  height_of_eye_m: number;
  /**
   * Instrument: index correction, arcminutes, ADDED to the reading. Index error "on the
   * arc" gives a negative value (CONVENTIONS section 5).
   */
  index_correction_arcmin: number;
}

export interface ExplorerState {
  observer: ObserverState;
  time: TimeState;
  selection: SelectionState;
  view: ViewId;
  layers: Layers;
  settings: Settings;
}

export type ExplorerStore = Store<ExplorerState>;

/** Philadelphia City Hall, the project's reference place (CONVENTIONS section 2). */
export const DEFAULT_OBSERVER: ObserverState = {
  lat_deg: 39.9526,
  lon_deg: -75.1652,
  height_m: 0,
  label: 'Philadelphia City Hall',
  zone: { kind: 'iana', zone: 'America/New_York' },
};

/** One hour per second: a day in 24 seconds. */
export const DEFAULT_SPEED = 3600;

export const DEFAULT_LAYERS: Layers = {
  terminator: true,
  twilight: true,
  groundPoints: true,
  circles: false,
  compass: true,
  paths: true,
  graticule: false,
  streets: false,
  constellations: true,
  constellationNames: true,
  starNames: true,
  altAzGrid: false,
  ecliptic: false,
  equator: false,
  meridian: false,
};

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  timeDisplay: 'local',
  angleFormat: 'dm',
  units: 'metric',
  navigatorTerms: true,
  horizon: 'standard',
  height_of_eye_m: 2,
  index_correction_arcmin: 0,
};

export function defaultState(nowMs: number = Date.now()): ExplorerState {
  return {
    observer: { ...DEFAULT_OBSERVER },
    time: { jd_utc: jdNow(nowMs), playing: false, speed: DEFAULT_SPEED, live: true },
    selection: { body: 'Sun' },
    view: 'map',
    layers: { ...DEFAULT_LAYERS },
    settings: { ...DEFAULT_SETTINGS },
  };
}

// ---------------------------------------------------------------------------
// Derived values every view needs
// ---------------------------------------------------------------------------

/** The engine's observer (EXPLORER_API "Common rules"). */
export function engineObserver(state: ExplorerState): Observer {
  const o = state.observer;
  return { lat_deg: o.lat_deg, lon_deg: o.lon_deg, height_m: o.height_m };
}

/** The place's own zone, whatever the display preference. */
export function placeZone(state: ExplorerState): Zone {
  return resolveZone(state.observer.zone, state.observer.lon_deg);
}

/** The zone times are shown in first (UTC is always shown beside it). */
export function displayZone(state: ExplorerState): Zone {
  return state.settings.timeDisplay === 'utc' ? UTC_ZONE : placeZone(state);
}

/** Options for `day_events`, from the settings. */
export function eventOptions(state: ExplorerState): EventOptions {
  return { horizon: state.settings.horizon, height_of_eye_m: state.settings.height_of_eye_m };
}

/** Local midnight to local midnight in the display zone around the current time. */
export function currentDayWindow(state: ExplorerState): [number, number] {
  return dayWindow(state.time.jd_utc, displayZone(state));
}

// ---------------------------------------------------------------------------
// Persistence: settings and layers only
// ---------------------------------------------------------------------------

/** The one localStorage key the explorer writes. */
export const PREFS_KEY = 'skyfix.explorer.prefs.v1';

/** localStorage, or null where it is missing or throws (private windows, blocked storage). */
export function safeLocalStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = '__skyfix_probe__';
    storage.setItem(probe, probe);
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

const THEMES: readonly Theme[] = ['light', 'dark', 'night'];
const TIME_DISPLAYS: readonly TimeDisplay[] = ['local', 'utc'];
const ANGLE_FORMATS: readonly AngleFormat[] = ['dm', 'dms', 'decimal'];
const UNITS: readonly Units[] = ['metric', 'nautical', 'imperial'];
const HORIZONS: readonly HorizonOption[] = ['standard', 'dip'];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function finiteIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** Keep only well-formed settings; anything else takes its default. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = isPlainObject(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    theme: pick(r.theme, THEMES, d.theme),
    timeDisplay: pick(r.timeDisplay, TIME_DISPLAYS, d.timeDisplay),
    angleFormat: pick(r.angleFormat, ANGLE_FORMATS, d.angleFormat),
    units: pick(r.units, UNITS, d.units),
    navigatorTerms: typeof r.navigatorTerms === 'boolean' ? r.navigatorTerms : d.navigatorTerms,
    horizon: pick(r.horizon, HORIZONS, d.horizon),
    height_of_eye_m: finiteIn(r.height_of_eye_m, 0, 500, d.height_of_eye_m),
    index_correction_arcmin: finiteIn(r.index_correction_arcmin, -60, 60, d.index_correction_arcmin),
  };
}

export function sanitizeLayers(raw: unknown): Layers {
  const r = isPlainObject(raw) ? raw : {};
  const out = { ...DEFAULT_LAYERS };
  for (const key of Object.keys(DEFAULT_LAYERS) as (keyof Layers)[]) {
    const value = r[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export function loadPrefs(storage: Storage | null): { settings: Settings; layers: Layers } {
  let raw: unknown = null;
  try {
    const text = storage?.getItem(PREFS_KEY);
    raw = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    raw = null;
  }
  const r = isPlainObject(raw) ? raw : {};
  return { settings: sanitizeSettings(r.settings), layers: sanitizeLayers(r.layers) };
}

/** Returns false when the browser refused (quota, private mode); that is not an error. */
export function savePrefs(storage: Storage | null, settings: Settings, layers: Layers): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify({ settings, layers }));
    return true;
  } catch {
    return false;
  }
}

export interface ExplorerStoreOptions {
  /** Where preferences live. Default: `safeLocalStorage()`. `null` disables persistence. */
  storage?: Storage | null;
  /** Wall clock in Unix ms, for the initial "now". */
  now?: () => number;
  /** Applied over the defaults and the stored preferences. */
  initial?: StatePatch<ExplorerState>;
  onError?: (error: unknown) => void;
}

/** The explorer's store: defaults, stored preferences, and saving them when they change. */
export function createExplorerStore(options: ExplorerStoreOptions = {}): ExplorerStore {
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
  const prefs = loadPrefs(storage);
  const base = defaultState(options.now ? options.now() : Date.now());
  const initial = applyPatch(
    { ...base, settings: prefs.settings, layers: prefs.layers },
    options.initial ?? {},
  );
  const store = createStore(initial, options.onError ? { onError: options.onError } : {});
  store.select(
    (s) => [s.settings, s.layers] as const,
    ([settings, layers]) => {
      savePrefs(storage, settings, layers);
    },
    { equals: shallowEqual },
  );
  return store;
}

// ---------------------------------------------------------------------------
// Share links: only on an explicit Share action
// ---------------------------------------------------------------------------

export const SHARE_VERSION = '1';

export interface ShareOptions {
  /** Include the place (coordinates, name, zone). Default true: it is what Share is for. */
  place?: boolean;
  /** Include the moment. Default true; without it the link opens at "now". */
  time?: boolean;
}

/** What a share link sets. `observer` is complete when present. */
export interface SharePatch {
  observer?: ObserverState;
  time?: { jd_utc: number };
  selection?: SelectionState;
  view?: ViewId;
}

const MAX_LABEL = 120;
const MAX_BODY = 40;

function roundTo(value: number, digits: number): string {
  // Fixed digits, then drop trailing zeros: 39.95260 -> "39.9526".
  return String(Number(value.toFixed(digits)));
}

function zoneParam(zone: ZoneChoice): string {
  return zone.kind === 'iana' ? zone.zone : zone.kind;
}

/**
 * The URL fragment (`#v=1&lat=…`) for a share link. Call it ONLY when the person asks to
 * share; nothing in the explorer writes it to the address bar on its own. Coordinates
 * are rounded to 5 decimals (about a metre), time to the millisecond.
 */
export function encodeShare(state: ExplorerState, options: ShareOptions = {}): string {
  const params = new URLSearchParams();
  params.set('v', SHARE_VERSION);
  if (options.place ?? true) {
    const o = state.observer;
    params.set('lat', roundTo(o.lat_deg, 5));
    params.set('lon', roundTo(o.lon_deg, 5));
    if (o.height_m) params.set('h', roundTo(o.height_m, 1));
    if (o.label) params.set('place', o.label.slice(0, MAX_LABEL));
    params.set('tz', zoneParam(o.zone));
  }
  if (options.time ?? true) {
    params.set('t', isoUtc(state.time.jd_utc).replace('.000Z', 'Z'));
  }
  if (state.selection.body) params.set('body', state.selection.body.slice(0, MAX_BODY));
  params.set('view', state.view);
  return `#${params.toString()}`;
}

/** A full link: `base` (page URL without fragment) plus the share fragment. */
export function shareUrl(state: ExplorerState, base: string, options: ShareOptions = {}): string {
  return `${base.split('#')[0]}${encodeShare(state, options)}`;
}

function parseNumber(text: string | null): number | null {
  if (text === null || text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function normLon(lon: number): number {
  const x = (((lon % 360) + 360) % 360);
  return x > 180 ? x - 360 : x;
}

/**
 * Read a share fragment. Returns null when it is not one of ours. Invalid fields are
 * dropped one by one; a place needs both a valid latitude and longitude.
 */
export function decodeShare(hash: string): SharePatch | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!text) return null;
  const params = new URLSearchParams(text);
  if (params.get('v') !== SHARE_VERSION) return null;
  const out: SharePatch = {};

  const lat = parseNumber(params.get('lat'));
  const lon = parseNumber(params.get('lon'));
  if (lat !== null && lon !== null && lat >= -90 && lat <= 90) {
    const h = parseNumber(params.get('h'));
    const tz = params.get('tz') ?? '';
    const zone: ZoneChoice =
      tz === 'utc'
        ? { kind: 'utc' }
        : tz === 'nautical' || !isValidIanaZone(tz)
          ? { kind: 'nautical' } // a place with no usable zone gets its nautical zone time
          : { kind: 'iana', zone: tz };
    out.observer = {
      lat_deg: lat,
      lon_deg: normLon(lon),
      height_m: h !== null && h >= -500 && h <= 9000 ? h : 0,
      label: (params.get('place') ?? '').slice(0, MAX_LABEL),
      zone,
    };
  }

  const t = params.get('t');
  const jd = t ? jdFromIso(t) : null;
  if (jd !== null) out.time = { jd_utc: jd };

  const body = params.get('body')?.trim();
  if (body && body.length <= MAX_BODY) out.selection = { body };

  const view = params.get('view');
  if (view && (VIEW_IDS as readonly string[]).includes(view)) out.view = view as ViewId;

  return out;
}

/** Apply a decoded share. A shared moment stops the clock (not live, not playing). */
export function applyShare(store: ExplorerStore, patch: SharePatch): void {
  store.batch(() => {
    if (patch.observer) store.patch({ observer: patch.observer });
    if (patch.time) store.patch({ time: { jd_utc: patch.time.jd_utc, live: false, playing: false } });
    if (patch.selection) store.patch({ selection: patch.selection });
    if (patch.view) store.patch({ view: patch.view });
  });
}

/**
 * At start-up: apply a share fragment from the address bar, then REMOVE it, so the bar
 * does not keep carrying a position the person may move away from. Returns whether a
 * share was applied.
 */
export function consumeShareFromLocation(
  store: ExplorerStore,
  loc: Pick<Location, 'hash' | 'pathname' | 'search'> | undefined = globalThis.location,
  hist: Pick<History, 'replaceState' | 'state'> | undefined = globalThis.history,
): boolean {
  if (!loc) return false;
  const patch = decodeShare(loc.hash);
  if (!patch) return false;
  applyShare(store, patch);
  try {
    hist?.replaceState(hist.state, '', `${loc.pathname}${loc.search}`);
  } catch {
    // A sandboxed frame may refuse; the state is applied either way.
  }
  return true;
}
