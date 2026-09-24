/**
 * Moving through time: the playback clock, "Now", stepping, and the keyboard shortcuts
 * of EXPLORER_PLAN section 2:
 *
 * | key | step |
 * |---|---|
 * | `←` / `→` | ∓/± 10 minutes |
 * | `Shift` + `←` / `→` | ∓/± 1 hour |
 * | `Alt` + `←` / `→` | ∓/± 1 day (calendar day in the display zone) |
 * | `PgUp` / `PgDn` | − / + 1 month (`Shift`: 1 year), as in WAI-ARIA date pickers |
 * | `Space` | play / pause |
 * | `N` | now (follow the wall clock) |
 *
 * `live` (following the wall clock) and `playing` are never both on. Any manual change
 * of the time turns `live` off; playing continues from the new time.
 */

import type { FrameScheduler } from './component.js';
import type { ExplorerStore } from './state.js';
import { displayZone } from './state.js';
import { addCalendar, addDuration, jdNow, type Zone } from './time.js';

// ---------------------------------------------------------------------------
// Speeds
// ---------------------------------------------------------------------------

/** Mean Gregorian month, seconds (365.2425 / 12 days). */
export const MONTH_S = 2_629_746;

/** Simulated seconds per real second, from real time to a month per second. */
export const PLAYBACK_SPEEDS: readonly { speed: number; label: string }[] = [
  { speed: 1, label: 'Real time' },
  { speed: 60, label: '1 minute per second' },
  { speed: 600, label: '10 minutes per second' },
  { speed: 3600, label: '1 hour per second' },
  { speed: 6 * 3600, label: '6 hours per second' },
  { speed: 86_400, label: '1 day per second' },
  { speed: 7 * 86_400, label: '1 week per second' },
  { speed: MONTH_S, label: '1 month per second' },
];

export const MAX_SPEED = MONTH_S;

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

/** Step the shown time; calendar steps use the display zone unless one is given. */
export function stepTime(store: ExplorerStore, step: TimeStep, zone?: Zone): void {
  const state = store.get();
  setTime(store, applyStep(state.time.jd_utc, step, zone ?? displayZone(state)));
}

export function setPlaying(store: ExplorerStore, playing: boolean): void {
  store.patch({ time: playing ? { playing: true, live: false } : { playing: false } });
}

export function togglePlay(store: ExplorerStore): void {
  setPlaying(store, !store.get().time.playing);
}

/** Set the playback speed (simulated seconds per real second), clamped to ± a month per second. */
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

/** Map a key press to a time action, or null. Ctrl/Cmd combinations are left to the browser. */
export function timeKeyAction(e: KeyLike): TimeKeyAction | null {
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
