/**
 * Moving through time: the playback clock, "Now", stepping, and the keyboard shortcuts
 * of EXPLORER_PLAN section 2. OWNER: time-ui agent (from the shell-design agent's first
 * version).
 *
 * | key | step |
 * |---|---|
 * | `←` / `→` | ∓/± 10 minutes |
 * | `Shift` + `←` / `→` | ∓/± 1 hour |
 * | `Alt` + `←` / `→` | ∓/± 1 day (calendar day in the display zone) |
 * | `PgUp` / `PgDn` | − / + 1 month (`Shift`: 1 year), as in WAI-ARIA date pickers |
 * | `Ctrl` + `PgUp` / `PgDn` | − / + 100 years (`Ctrl` + `Shift`: 1000 years) |
 * | `Space` | play / pause |
 * | `N` | now (follow the wall clock) |
 *
 * `live` (following the wall clock) and `playing` are never both on. Any manual change
 * of the time turns `live` off; playing continues from the new time.
 *
 * Calendar steps keep the clock time in the display calendar (Julian before 1582-10-15
 * unless Settings chose ISO; time/civil.ts) and in the zone of the instant they land on,
 * which differs from the zone they start in when a step crosses 1850 (local mean time
 * before it, for a zone that follows the place).
 */

import type { FrameScheduler } from './component.js';
import type { ExplorerState, ExplorerStore } from './state.js';
import { displayZoneAt } from './state.js';
import { addCalendar, addDuration, jdFromWallClock, jdNow, wallClock, type Zone } from './time.js';

// ---------------------------------------------------------------------------
// Speeds
// ---------------------------------------------------------------------------

/** Mean Gregorian month, seconds (365.2425 / 12 days). */
export const MONTH_S = 2_629_746;

/** Mean Gregorian year, seconds (365.2425 days). */
export const YEAR_S = 31_556_952;

/**
 * Simulated seconds per real second, from real time to ten years per second (time-ui agent:
 * a year and ten years a second, so 2000 BC to AD 3000 is a few minutes of playback).
 */
export const PLAYBACK_SPEEDS: readonly { speed: number; label: string }[] = [
  { speed: 1, label: 'Real time' },
  { speed: 60, label: '1 minute per second' },
  { speed: 600, label: '10 minutes per second' },
  { speed: 3600, label: '1 hour per second' },
  { speed: 6 * 3600, label: '6 hours per second' },
  { speed: 86_400, label: '1 day per second' },
  { speed: 7 * 86_400, label: '1 week per second' },
  { speed: MONTH_S, label: '1 month per second' },
  { speed: YEAR_S, label: '1 year per second' },
  { speed: 10 * YEAR_S, label: '10 years per second' },
];

export const MAX_SPEED = 10 * YEAR_S;

/**
 * Faster than this (simulated seconds per real second: 8 days) a new day comes every few
 * frames, and the per-day events (rise, set, twilight: 5 to 40 ms each in WebAssembly) are
 * not computed while time runs: the time bar draws the hours only and the panel's cards
 * wait, and all of it is drawn in full as soon as time stops or slows (shell/derived.ts).
 * A week a second stays below it, a month a second and faster are above it.
 */
export const FAST_PLAYBACK_S = 8 * 86_400;

/** True while time runs faster than `FAST_PLAYBACK_S`. */
export function fastPlayback(state: Pick<ExplorerState, 'time'>): boolean {
  return state.time.playing && Math.abs(state.time.speed) > FAST_PLAYBACK_S;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type StepUnit = 'minute' | 'hour' | 'day' | 'month' | 'year';

export interface TimeStep {
  unit: StepUnit;
  count: number;
}

/** Apply a step: minutes and hours are exact durations; days, months, years are calendar steps in `zone`. */
export function applyStep(jd: number, step: TimeStep, zone: Zone): number {
  switch (step.unit) {
    case 'minute':
      return addDuration(jd, { minutes: step.count });
    case 'hour':
      return addDuration(jd, { hours: step.count });
    case 'day':
      return addCalendar(jd, zone, { days: step.count });
    case 'month':
      return addCalendar(jd, zone, { months: step.count });
    case 'year':
      return addCalendar(jd, zone, { years: step.count });
  }
}

/** Follow the wall clock ("Now"): stops playing. */
export function goNow(store: ExplorerStore, nowMs: number = Date.now()): void {
  store.patch({ time: { jd_utc: jdNow(nowMs), live: true, playing: false } });
}

/** Show a particular instant: leaves live mode; playing continues from there. */
export function setTime(store: ExplorerStore, jd: number): void {
  if (!Number.isFinite(jd)) return;
  store.patch({ time: { jd_utc: jd, live: false } });
}

/**
 * A step in the display zone of the state, keeping the clock time of the zone the step
 * lands in: when the zone there differs (a step across 1850, local mean time before it), the
 * step is taken again in that zone, so 12:00 stays 12:00 on the clock shown.
 */
export function applyStepIn(state: ExplorerState, jd: number, step: TimeStep): number {
  const from = displayZoneAt(state, jd);
  const landed = applyStep(jd, step, from);
  if (step.unit === 'minute' || step.unit === 'hour') return landed;
  const to = displayZoneAt(state, landed);
  if (sameZone(from, to)) return landed;
  // The same date and clock time, read on the clock of the zone the step lands in.
  const w = wallClock(landed, from);
  const again = jdFromWallClock(w, to);
  // At the very edge of 1850 the new zone may not hold at the corrected instant: keep the first.
  return sameZone(displayZoneAt(state, again), to) ? again : landed;
}

function sameZone(a: Zone, b: Zone): boolean {
  if (a.kind === 'iana' || b.kind === 'iana') return a.kind === 'iana' && b.kind === 'iana' && a.zone === b.zone;
  return a.offsetMs === b.offsetMs && a.name === b.name;
}

/** Step the shown time; calendar steps use the display zone unless one is given. */
export function stepTime(store: ExplorerStore, step: TimeStep, zone?: Zone): void {
  const state = store.get();
  setTime(store, zone ? applyStep(state.time.jd_utc, step, zone) : applyStepIn(state, state.time.jd_utc, step));
}

export function setPlaying(store: ExplorerStore, playing: boolean): void {
  store.patch({ time: playing ? { playing: true, live: false } : { playing: false } });
}

export function togglePlay(store: ExplorerStore): void {
  setPlaying(store, !store.get().time.playing);
}

/** Set the playback speed (simulated seconds per real second), clamped to ± ten years per second. */
export function setSpeed(store: ExplorerStore, speed: number): void {
  if (!Number.isFinite(speed) || speed === 0) return;
  store.patch({ time: { speed: Math.max(-MAX_SPEED, Math.min(MAX_SPEED, speed)) } });
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export type TimeKeyAction =
  | { kind: 'step'; step: TimeStep }
  | { kind: 'toggle-play' }
  | { kind: 'now' };

/** The parts of a KeyboardEvent the mapping looks at. */
export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * Map a key press to a time action, or null. Ctrl/Cmd combinations are left to the browser,
 * except Ctrl + Page Up / Page Down: a century (with Shift, a millennium). Browsers with tabs
 * may keep that one for switching tabs; the calendar's ±100 and ±1000 buttons do the same.
 */
export function timeKeyAction(e: KeyLike): TimeKeyAction | null {
  if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
    const sign = e.key === 'PageDown' ? 1 : -1;
    return { kind: 'step', step: { unit: 'year', count: sign * (e.shiftKey ? 1000 : 100) } };
  }
  if (e.ctrlKey || e.metaKey) return null;
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      const sign = e.key === 'ArrowRight' ? 1 : -1;
      if (e.altKey) return { kind: 'step', step: { unit: 'day', count: sign } };
      if (e.shiftKey) return { kind: 'step', step: { unit: 'hour', count: sign } };
      return { kind: 'step', step: { unit: 'minute', count: 10 * sign } };
    }
    case 'PageUp':
    case 'PageDown': {
      const sign = e.key === 'PageDown' ? 1 : -1;
      return { kind: 'step', step: { unit: e.shiftKey ? 'year' : 'month', count: sign } };
    }
    case ' ':
    case 'Spacebar':
      return e.altKey || e.shiftKey ? null : { kind: 'toggle-play' };
    case 'n':
    case 'N':
      return e.altKey ? null : { kind: 'now' };
    default:
      return null;
  }
}

/** WAI-ARIA widgets that use the arrow and page keys themselves. */
const ARROW_ROLES = new Set([
  'combobox',
  'grid',
  'gridcell',
  'listbox',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'radiogroup',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'tab',
  'tablist',
  'textbox',
  'tree',
  'treegrid',
  'treeitem',
]);

/** Widgets that Space activates. */
const ACTIVATE_ROLES = new Set([
  'button',
  'checkbox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'switch',
  'tab',
  'treeitem',
]);

/** Widgets that take typed letters. */
const TEXT_ROLES = new Set(['combobox', 'searchbox', 'spinbutton', 'textbox']);

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

/**
 * True when the key belongs to the focused control, not to the time shortcuts: any key
 * in a form field or editable text, arrows in a slider or tab list, Space on a button
 * or link. Also true inside an element marked `data-own-keys` (a component that
 * handles these keys itself, such as the time bar's handle).
 */
export function keyBelongsToTarget(target: unknown, key: string): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as ElementLike;
  if (typeof el.closest === 'function' && el.closest('[data-own-keys]')) return true;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'INPUT') return true;
  const role = el.getAttribute?.('role') ?? '';
  if (key === ' ' || key === 'Spacebar' || key === 'Enter') {
    return tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || ACTIVATE_ROLES.has(role) || TEXT_ROLES.has(role);
  }
  if (key.startsWith('Arrow') || key.startsWith('Page')) return ARROW_ROLES.has(role);
  return TEXT_ROLES.has(role);
}

export interface KeyEventLike extends KeyLike {
  target?: unknown;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  preventDefault?: () => void;
}

/**
 * Handle one key press against the store. Returns true (and calls `preventDefault`)
 * when the key was a time shortcut.
 */
export function handleTimeKey(
  e: KeyEventLike,
  store: ExplorerStore,
  nowMs: () => number = Date.now,
): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  const action = timeKeyAction(e);
  if (!action) return false;
  if (keyBelongsToTarget(e.target, e.key)) return false;
  if (action.kind !== 'step' && e.repeat) {
    e.preventDefault?.();
    return true; // holding Space must not flicker play/pause
  }
  switch (action.kind) {
    case 'step':
      stepTime(store, action.step);
      break;
    case 'toggle-play':
      togglePlay(store);
      break;
    case 'now':
      goNow(store, nowMs());
      break;
  }
  e.preventDefault?.();
  return true;
}

/** Listen for the time shortcuts on `target` (usually `window`). Returns the unbind function. */
export function bindTimeKeys(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  store: ExplorerStore,
): () => void {
  const listener = (e: Event): void => {
    handleTimeKey(e as KeyboardEvent, store);
  };
  target.addEventListener('keydown', listener);
  return () => target.removeEventListener('keydown', listener);
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

export interface PlaybackOptions {
  /** Wall clock, Unix ms. Default `Date.now`. */
  now?: () => number;
  /** Longest real interval one frame may advance (a background tab resumes gently). Default 250 ms. */
  maxFrameMs?: number;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

/**
 * Drive `time` from the store's flags: while `playing`, advance `speed` simulated seconds
 * per real second on every frame; while `live`, follow the wall clock once a second (a
 * timer, not a frame loop, so an idle page costs nothing). Returns a stop function.
 */
export function startPlayback(
  store: ExplorerStore,
  scheduler: FrameScheduler,
  options: PlaybackOptions = {},
): () => void {
  const now = options.now ?? Date.now;
  const maxFrameMs = options.maxFrameMs ?? 250;
  const setTimer =
    options.setTimer ?? ((cb: () => void, ms: number) => Number(setTimeout(cb, ms)));
  const clearTimer = options.clearTimer ?? ((id: number) => clearTimeout(id));

  let removeHook: (() => void) | null = null;
  let lastMs: number | null = null;
  let timer: number | null = null;

  const frame = (): void => {
    const t = store.get().time;
    const wall = now();
    if (!t.playing || t.live) return;
    if (lastMs === null) {
      lastMs = wall;
      return;
    }
    const dt = Math.min(Math.max(wall - lastMs, 0), maxFrameMs);
    lastMs = wall;
    if (dt === 0) return;
    const next = t.jd_utc + (t.speed * dt) / 86_400_000;
    if (!Number.isFinite(next)) {
      store.patch({ time: { playing: false } });
      return;
    }
    store.patch({ time: { jd_utc: next } });
  };

  const liveTick = (): void => {
    timer = null;
    if (!store.get().time.live) return;
    const wall = now();
    store.patch({ time: { jd_utc: jdNow(wall) } });
    timer = setTimer(liveTick, 1000 - (wall % 1000) + 5);
  };

  const sync = (playing: boolean, live: boolean): void => {
    if (playing && !live) {
      if (!removeHook) {
        lastMs = null;
        removeHook = scheduler.onFrame(frame);
      }
    } else if (removeHook) {
      removeHook();
      removeHook = null;
    }
    if (live) {
      if (timer === null) liveTick();
    } else if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const stopSelect = store.select(
    (s) => (s.time.playing ? 1 : 0) + (s.time.live ? 2 : 0),
    (flags) => sync((flags & 1) !== 0, (flags & 2) !== 0),
  );
  const t = store.get().time;
  sync(t.playing, t.live);

  return () => {
    stopSelect();
    removeHook?.();
    removeHook = null;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
}
