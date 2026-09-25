/**
 * The playback clock, "Now", stepping and the keyboard shortcuts (EXPLORER_PLAN section 2).
 */
import { describe, expect, it } from 'vitest';
import { createScheduler } from '../../src/next/component.js';
import {
  applyStep,
  goNow,
  handleTimeKey,
  keyBelongsToTarget,
  MAX_SPEED,
  MONTH_S,
  PLAYBACK_SPEEDS,
  YEAR_S,
  setPlaying,
  setSpeed,
  setTime,
  startPlayback,
  stepTime,
  timeKeyAction,
  togglePlay,
  type KeyEventLike,
} from '../../src/next/playback.js';
import { createExplorerStore } from '../../src/next/state.js';
import { formatDateTime, isoUtc, jdFromIso, jdFromWallClock, msFromJd, UTC_ZONE } from '../../src/next/time.js';
import { FakeFrames, FakeTimers } from './helpers.js';

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const NY = { kind: 'iana', zone: 'America/New_York' } as const;

function setup(initialLive = false) {
  const frames = new FakeFrames();
  const timers = new FakeTimers();
  timers.now = NOW;
  const store = createExplorerStore({
    storage: null,
    now: () => NOW,
    initial: { time: { live: initialLive } },
  });
  const scheduler = createScheduler({ requestFrame: frames.request, cancelFrame: frames.cancel });
  const stop = startPlayback(store, scheduler, {
    now: () => timers.now,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  /** Advance real time by `ms` in 16 ms frames. */
  const run = (ms: number): void => {
    for (let t = 0; t < ms; t += 16) {
      timers.advance(16);
      frames.step(16);
    }
  };
  return { store, frames, timers, scheduler, stop, run };
}

const secondsSince = (jdA: number, jdB: number): number => (msFromJd(jdB) - msFromJd(jdA)) / 1000;

describe('playback clock', () => {
  it('offers speeds from real time to ten years per second', () => {
    expect(PLAYBACK_SPEEDS[0]!.speed).toBe(1);
    expect(PLAYBACK_SPEEDS.at(-1)!.speed).toBe(10 * YEAR_S);
    expect(PLAYBACK_SPEEDS.map((s) => s.speed)).toContain(MONTH_S);
    expect(PLAYBACK_SPEEDS.map((s) => s.speed)).toContain(YEAR_S);
    expect(YEAR_S).toBe(12 * MONTH_S);
    const speeds = PLAYBACK_SPEEDS.map((s) => s.speed);
    expect([...speeds].sort((a, b) => a - b)).toEqual(speeds);
  });

  it('crosses 2000 BC to AD 3000 in minutes at ten years per second', () => {
    const { store, run } = setup();
    setSpeed(store, 10 * YEAR_S);
    const start = store.get().time.jd_utc;
    setPlaying(store, true);
    run(1000);
    expect(secondsSince(start, store.get().time.jd_utc) / YEAR_S).toBeCloseTo(10, 0);
    expect(5000 / 10 / 60).toBeLessThan(9); // minutes for the whole span
  });

  it('advances speed simulated seconds per real second', () => {
    const { store, run, frames } = setup();
    setSpeed(store, 3600);
    const start = store.get().time.jd_utc;
    setPlaying(store, true);
    run(1000);
    expect(secondsSince(start, store.get().time.jd_utc)).toBeCloseTo(3600, -2);
    setPlaying(store, false);
    const paused = store.get().time.jd_utc;
    run(500);
    expect(store.get().time.jd_utc).toBe(paused);
    expect(frames.pending).toBe(0); // no frame loop while paused
  });

  it('runs backwards with a negative speed and clamps silly speeds', () => {
    const { store, run } = setup();
    setSpeed(store, -60);
    const start = store.get().time.jd_utc;
    setPlaying(store, true);
    run(1000);
    expect(secondsSince(start, store.get().time.jd_utc)).toBeCloseTo(-60, -1);
    setSpeed(store, 1e12);
    expect(store.get().time.speed).toBe(MAX_SPEED);
    expect(MAX_SPEED).toBe(10 * YEAR_S);
    setSpeed(store, 0);
    expect(store.get().time.speed).toBe(MAX_SPEED);
  });

  it('never jumps more than one clamped frame after a stall', () => {
    const { store, timers, frames } = setup();
    setSpeed(store, 86_400);
    setPlaying(store, true);
    frames.step(16); // first frame only records the start
    const start = store.get().time.jd_utc;
    timers.advance(60_000); // the tab was hidden for a minute
    frames.step(16);
    expect(secondsSince(start, store.get().time.jd_utc)).toBeCloseTo(0.25 * 86_400, -1);
  });

  it('follows the wall clock once a second while live, without a frame loop', () => {
    const { store, timers, frames } = setup(true);
    expect(store.get().time.live).toBe(true);
    timers.advance(2500);
    expect(isoUtc(store.get().time.jd_utc)).toBe('2026-09-24T12:00:02.005Z');
    expect(frames.pending).toBe(0);
    setTime(store, jdFromIso('2020-01-01T00:00:00Z')!);
    expect(store.get().time.live).toBe(false);
    timers.advance(5000);
    expect(isoUtc(store.get().time.jd_utc)).toBe('2020-01-01T00:00:00.000Z');
    expect(timers.pending).toBe(0);
  });

  it('play leaves live mode, now leaves playing', () => {
    const { store, timers } = setup(true);
    togglePlay(store);
    expect(store.get().time).toMatchObject({ playing: true, live: false });
    goNow(store, timers.now);
    expect(store.get().time).toMatchObject({ playing: false, live: true });
  });

  it('stops cleanly', () => {
    const { store, stop, frames, timers } = setup(true);
    stop();
    setPlaying(store, true);
    expect(frames.pending).toBe(0);
    expect(timers.pending).toBe(0);
  });
});

describe('stepping', () => {
  it('steps minutes and hours exactly and days on the local calendar', () => {
    const t = jdFromWallClock({ year: 2026, month: 3, day: 7, hour: 12 }, NY);
    expect(secondsSince(t, applyStep(t, { unit: 'minute', count: 10 }, NY))).toBe(600);
    expect(secondsSince(t, applyStep(t, { unit: 'hour', count: -1 }, NY))).toBe(-3600);
    expect(formatDateTime(applyStep(t, { unit: 'day', count: 1 }, NY), NY)).toBe('2026-03-08 12:00');
    expect(formatDateTime(applyStep(t, { unit: 'month', count: 1 }, NY), NY)).toBe('2026-04-07 12:00');
    expect(formatDateTime(applyStep(t, { unit: 'year', count: -1 }, NY), NY)).toBe('2025-03-07 12:00');
  });

  it('steps in the display zone and leaves live mode', () => {
    const store = createExplorerStore({ storage: null, now: () => NOW });
    expect(store.get().time.live).toBe(true);
    stepTime(store, { unit: 'day', count: 1 });
    expect(store.get().time.live).toBe(false);
    expect(isoUtc(store.get().time.jd_utc)).toBe('2026-09-25T12:00:00.000Z');
    store.patch({ settings: { timeDisplay: 'utc' } });
    stepTime(store, { unit: 'month', count: 1 });
    expect(isoUtc(store.get().time.jd_utc)).toBe('2026-10-25T12:00:00.000Z');
    stepTime(store, { unit: 'minute', count: 10 }, UTC_ZONE);
    expect(isoUtc(store.get().time.jd_utc)).toBe('2026-10-25T12:10:00.000Z');
  });
});

describe('keyboard shortcuts', () => {
  it('maps the documented keys', () => {
    expect(timeKeyAction({ key: 'ArrowRight' })).toEqual({ kind: 'step', step: { unit: 'minute', count: 10 } });
    expect(timeKeyAction({ key: 'ArrowLeft' })).toEqual({ kind: 'step', step: { unit: 'minute', count: -10 } });
    expect(timeKeyAction({ key: 'ArrowRight', shiftKey: true })).toEqual({ kind: 'step', step: { unit: 'hour', count: 1 } });
    expect(timeKeyAction({ key: 'ArrowLeft', altKey: true })).toEqual({ kind: 'step', step: { unit: 'day', count: -1 } });
    expect(timeKeyAction({ key: 'PageDown' })).toEqual({ kind: 'step', step: { unit: 'month', count: 1 } });
    expect(timeKeyAction({ key: 'PageUp' })).toEqual({ kind: 'step', step: { unit: 'month', count: -1 } });
    expect(timeKeyAction({ key: 'PageUp', shiftKey: true })).toEqual({ kind: 'step', step: { unit: 'year', count: -1 } });
    expect(timeKeyAction({ key: ' ' })).toEqual({ kind: 'toggle-play' });
    expect(timeKeyAction({ key: 'n' })).toEqual({ kind: 'now' });
    expect(timeKeyAction({ key: 'N' })).toEqual({ kind: 'now' });
    expect(timeKeyAction({ key: 'ArrowRight', ctrlKey: true })).toBeNull();
    expect(timeKeyAction({ key: 'n', metaKey: true })).toBeNull();
    expect(timeKeyAction({ key: 'x' })).toBeNull();
    // A century and a millennium (time-ui agent).
    expect(timeKeyAction({ key: 'PageUp', ctrlKey: true })).toEqual({ kind: 'step', step: { unit: 'year', count: -100 } });
    expect(timeKeyAction({ key: 'PageDown', ctrlKey: true })).toEqual({ kind: 'step', step: { unit: 'year', count: 100 } });
    expect(timeKeyAction({ key: 'PageDown', ctrlKey: true, shiftKey: true })).toEqual({ kind: 'step', step: { unit: 'year', count: 1000 } });
    expect(timeKeyAction({ key: 'PageUp', metaKey: true })).toBeNull();
    expect(timeKeyAction({ key: 'PageUp', ctrlKey: true, metaKey: true })).toBeNull();
  });

  it('leaves keys to form fields, widgets and components that own them', () => {
    const el = (tagName: string, role: string | null = null, own = false) => ({
      tagName,
      getAttribute: (name: string) => (name === 'role' ? role : null),
      closest: (selector: string) => (own && selector === '[data-own-keys]' ? {} : null),
    });
    expect(keyBelongsToTarget(el('INPUT'), 'ArrowLeft')).toBe(true);
    expect(keyBelongsToTarget(el('TEXTAREA'), 'n')).toBe(true);
    expect(keyBelongsToTarget(el('SELECT'), ' ')).toBe(true);
    expect(keyBelongsToTarget({ tagName: 'DIV', isContentEditable: true }, 'n')).toBe(true);
    expect(keyBelongsToTarget(el('DIV', 'slider'), 'ArrowLeft')).toBe(true);
    expect(keyBelongsToTarget(el('BUTTON', 'tab'), 'ArrowRight')).toBe(true);
    expect(keyBelongsToTarget(el('BUTTON'), ' ')).toBe(true);
    expect(keyBelongsToTarget(el('BUTTON'), 'ArrowRight')).toBe(false);
    expect(keyBelongsToTarget(el('BUTTON'), 'n')).toBe(false);
    expect(keyBelongsToTarget(el('DIV', null, true), 'ArrowRight')).toBe(true);
    expect(keyBelongsToTarget(el('DIV'), 'ArrowRight')).toBe(false);
    expect(keyBelongsToTarget(null, 'ArrowRight')).toBe(false);
  });

  it('handles a key against the store and prevents the browser default', () => {
    const store = createExplorerStore({ storage: null, now: () => NOW });
    let prevented = 0;
    const key = (k: Partial<KeyEventLike>): boolean =>
      handleTimeKey({ key: '', preventDefault: () => (prevented += 1), ...k }, store, () => NOW);
    expect(key({ key: 'ArrowRight' })).toBe(true);
    expect(isoUtc(store.get().time.jd_utc)).toBe('2026-09-24T12:10:00.000Z');
    expect(key({ key: ' ' })).toBe(true);
    expect(store.get().time.playing).toBe(true);
    expect(key({ key: ' ', repeat: true })).toBe(true);
    expect(store.get().time.playing).toBe(true); // a held Space does not toggle again
    expect(key({ key: 'n' })).toBe(true);
    expect(store.get().time).toMatchObject({ live: true, playing: false });
    expect(key({ key: 'ArrowRight', target: { tagName: 'INPUT' } })).toBe(false);
    expect(key({ key: 'ArrowRight', defaultPrevented: true })).toBe(false);
    expect(key({ key: 'q' })).toBe(false);
    expect(prevented).toBe(4);
  });
});

describe('long steps keep the clock time in the calendar and the zone they land in', () => {
  const philadelphia = (iso: string) =>
    createExplorerStore({
      storage: null,
      now: () => NOW,
      initial: {
        observer: { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0, label: 'Philadelphia', zone: { kind: 'iana', zone: 'America/New_York', guessed: true } },
        time: { jd_utc: jdFromIso(iso)!, live: false },
      },
    });

  it('steps a century back into local mean time (before 1850) at the same clock time', () => {
    const store = philadelphia('1900-06-01T16:00:00Z'); // 11:00 EST
    stepTime(store, { unit: 'year', count: -100 });
    // 1800-06-01 11:00 local mean time at 75° 09.9′ W (UT−5:00:40) is 16:00:40 UT.
    expect(isoUtc(store.get().time.jd_utc)).toBe('1800-06-01T16:00:40.000Z');
    stepTime(store, { unit: 'year', count: 100 });
    expect(isoUtc(store.get().time.jd_utc)).toBe('1900-06-01T16:00:00.000Z');
  });

  it('steps through the Julian calendar before 1582 and across year 0', () => {
    const store = philadelphia('1600-02-29T17:00:40Z'); // noon LMT
    stepTime(store, { unit: 'year', count: -100 });
    // 1500-02-29 exists in the Julian calendar: noon LMT on it.
    expect(isoUtc(store.get().time.jd_utc)).toBe('1500-03-10T17:00:40.000Z');
    stepTime(store, { unit: 'year', count: -1000 });
    stepTime(store, { unit: 'year', count: -1000 });
    // 29 February 501 BC (Julian; astronomical -500) is 23 February on the wire's proleptic Gregorian calendar.
    expect(isoUtc(store.get().time.jd_utc)).toBe('-0500-02-23T17:00:40.000Z');
  });

  it('applies the ten-year and century keys to the store', () => {
    const store = philadelphia('2026-09-24T16:00:00Z');
    handleTimeKey({ key: 'PageUp', ctrlKey: true }, store, () => NOW);
    // 12:00 EDT then as now: New York kept daylight time until 26 September 1926 (tz database).
    expect(isoUtc(store.get().time.jd_utc)).toBe('1926-09-24T16:00:00.000Z');
  });
});
