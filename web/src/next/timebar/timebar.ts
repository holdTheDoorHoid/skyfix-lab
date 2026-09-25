/**
 * The time bar: the date (a day back or forward, a calendar), the clock in the display
 * zone with UTC beside it, the day's sky-phase ribbon with the selected body's rise,
 * highest point and set and a handle to drag, and Now, Play and the playback speed.
 * OWNER: shell-design agent.
 *
 * Keys (EXPLORER_PLAN §2) work anywhere on the page (playback.ts `bindTimeKeys`); on the
 * handle, which is a slider, they are handled here, plus Home and End for the start and
 * end of the day. Dragging moves only the handle's position style each frame; the rest
 * of the page redraws at most once a frame (component.ts `watch`).
 */

import './timebar.css';
import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import type { SkyEvent } from '../engine/types.js';
import { MONTH_S, PLAYBACK_SPEEDS, goNow, setPlaying, setSpeed, setTime, stepTime, timeKeyAction, togglePlay } from '../playback.js';
import { aroundToday, dayOf, setAttr, setText, sunToday } from '../shell/derived.js';
import { bearing3, clock, clockParts, clockSeconds, compassPoint, dateLong, dateShort, endOfDay, eventTime, formatAngle, parseClock } from '../shell/format.js';
import { PHASE_LABEL, PHASE_MEANING, clipPhases, segmentAt } from '../shell/sky.js';
import { displayZone, placeZone, shallowEqual, type ExplorerState } from '../state.js';
import { icon } from '../theme/icons.js';
import { button, iconButton, menu, popover, segmented } from '../theme/primitives.js';
import { UTC_ZONE, jdFromWallClock, jdNow, wallClock, zoneShortName, type Zone } from '../time.js';
import { calendar, type CalendarDate } from './calendar.js';
import { createRibbon, type RibbonHour, type RibbonMark, type RibbonModel } from './ribbon.js';

const SHORT_SPEED: Record<number, string> = {
  1: '×1',
  60: '1 min/s',
  600: '10 min/s',
  3600: '1 h/s',
  21600: '6 h/s',
  86400: '1 d/s',
  604800: '1 wk/s',
  [MONTH_S]: '1 mo/s',
};

const WORDS: Record<string, [string, string]> = { Sun: ['Sunrise', 'Sunset'], Moon: ['Moonrise', 'Moonset'] };

/** Ticks on the hour, labelled every three hours, on the zone's clock (23 or 25 of them on a clock-change day). */
export function hourTicks(a: number, b: number, zone: Zone): RibbonHour[] {
  const out: RibbonHour[] = [];
  for (let jd = a; jd <= b + 1e-9; jd += 1 / 24) {
    const end = Math.abs(jd - b) < 1e-7;
    const w = wallClock(Math.min(jd, b), zone);
    const hour = end ? 24 : w.hour;
    const labelled = w.minute === 0 && hour % 3 === 0;
    out.push({ jd: Math.min(jd, b), label: labelled ? String(hour) : '', major: labelled });
  }
  return out;
}

export function timebar(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const { store } = ctx;
  const d = disposer();

  // --- date and clock ------------------------------------------------------------------
  const prevDay = iconButton('chevron-left', 'One day earlier', { size: 'sm', tip: 'One day earlier (Alt+Left)' });
  const nextDay = iconButton('chevron-right', 'One day later', { size: 'sm', tip: 'One day later (Alt+Right)' });
  const dateText = h('span', {});
  const yearText = h('span', { class: 'sf-tb-date__year' });
  const dateButton = h(
    'button',
    { type: 'button', class: 'sf-tb-date__label', 'data-tip': 'Choose a date (Page Up / Page Down: a month)' },
    icon('calendar'),
    h('span', {}, dateText, yearText),
  );
  const local = h('span', {});
  const seconds = h('span', { class: 'sf-tb-clock__sec' });
  const zoneName = h('span', { class: 'sf-tb-clock__zone' });
  const other = h('output', { class: 'sf-tb-clock__utc' });
  const clockButton = h(
    'button',
    { type: 'button', class: 'sf-tb-clock', 'data-tip': 'Type a time' },
    h('output', { class: 'sf-tb-clock__local' }, local, seconds),
    h('span', { class: 'sf-tb-clock__row' }, zoneName, other),
  );
  prevDay.addEventListener('click', () => stepTime(store, { unit: 'day', count: -1 }));
  nextDay.addEventListener('click', () => stepTime(store, { unit: 'day', count: 1 }));
  const when = h('div', { class: 'sf-tb-when' }, h('div', { class: 'sf-tb-date' }, prevDay, dateButton, nextDay), clockButton);

  // --- ribbon ----------------------------------------------------------------------------
  const s0 = store.get();
  const w0 = dayOf(s0);
  const ribbon = createRibbon({
    window: w0,
    phases: [],
    hours: [],
    marks: [],
    jd: s0.time.jd_utc,
    glyph: 'sun',
    valueText: '',
    bubbleText: '',
  });
  let marks: RibbonMark[] = [];
  let phases = [] as RibbonModel['phases'];

  // --- transport ----------------------------------------------------------------------------
  const liveDot = h('span', { class: 'sf-live-dot', 'aria-hidden': 'true' });
  const nowButton = button({ label: 'Now', variant: 'secondary', class: 'sf-tb-now', pressed: false });
  nowButton.prepend(liveDot);
  nowButton.addEventListener('click', () => goNow(store));
  const playButton = button({ icon: 'play', variant: 'primary', class: 'sf-tb-play', ariaLabel: 'Play', tip: 'Play: run time forward (Space)' });
  playButton.addEventListener('click', () => togglePlay(store));
  const speedText = h('span', { class: 'sf-btn__label' });
  const speedButton = h(
    'button',
    { type: 'button', class: 'sf-btn sf-btn--ghost sf-tb-speed', 'data-tip': 'Playback speed and direction' },
    icon('speed'),
    speedText,
    icon('chevron-down'),
  );
  const transport = h('div', { class: 'sf-tb-transport' }, nowButton, playButton, speedButton);

  const el = h('div', { class: 'sf-timebar', role: 'region', 'aria-label': 'Date and time' }, when, ribbon.el, transport);

  // --- the static part of the ribbon: the day, its phases, the selected body's events --------
  const renderDay = (): void => {
    const s = store.get();
    const zone = displayZone(s);
    const [a, b] = dayOf(s);
    const day = sunToday(ctx, s);
    phases = day ? clipPhases(day.phases, a, b) : [];
    const body = s.selection.body ?? 'Sun';
    const around = aroundToday(ctx, s, body);
    const events: SkyEvent[] = around?.bodies.find((x) => x.body === body)?.events ?? [];
    const [riseWord, setWord] = WORDS[body] ?? [`${body} rises`, `${body} sets`];
    const z = zoneShortName((a + b) / 2, zone);
    marks = events
      .filter((e) => (e.kind === 'rise' || e.kind === 'transit' || e.kind === 'set') && e.jd_utc >= a && e.jd_utc < b)
      .map((e) => {
        const kind = e.kind as RibbonMark['kind'];
        const t = eventTime(e.jd_utc, zone);
        const tip =
          kind === 'transit'
            ? `${body} highest ${t} ${z} (${eventTime(e.jd_utc, UTC_ZONE)} UTC), ${formatAngle(e.alt_deg, s.settings.angleFormat, 'coarse')} up`
            : `${kind === 'rise' ? riseWord : setWord} ${t} ${z} (${eventTime(e.jd_utc, UTC_ZONE)} UTC), toward ${bearing3(e.az_deg)} ${compassPoint(e.az_deg)}`;
        return { kind, jd: e.jd_utc, label: t, tip };
      });
    const jd = s.time.jd_utc;
    ribbon.update({
      window: [a, b],
      phases,
      hours: hourTicks(a, b, zone),
      marks,
      jd,
      glyph: glyphAt(jd),
      valueText: valueText(s),
      bubbleText: `${clock(jd, zone)} ${zoneShortName(jd, zone)}`,
      nowJd: jdNow(),
      phaseTip: (p) =>
        `${PHASE_LABEL[p.phase]}, ${eventTime(p.jd_start, zone)}–${p.jd_end >= b ? endOfDay(zone) : eventTime(p.jd_end, zone)}. ${PHASE_MEANING[p.phase]}`,
    });
    el.classList.toggle('sf-timebar--nodata', !day);
  };

  const glyphAt = (jd: number): 'sun' | 'moon' => (segmentAt(phases, jd)?.phase === 'day' ? 'sun' : phases.length ? 'moon' : 'sun');
  const valueText = (s: ExplorerState): string => {
    const zone = displayZone(s);
    return `${clock(s.time.jd_utc, zone)} ${zoneShortName(s.time.jd_utc, zone)}, ${dateLong(s.time.jd_utc, zone)}`;
  };

  // --- the moving part: handle, clock, buttons -------------------------------------------------
  const renderTime = (): void => {
    const s = store.get();
    const zone = displayZone(s);
    const jd = s.time.jd_utc;
    const w = wallClock(jd, zone);
    ribbon.setHandle(jd, valueText(s), `${clock(jd, zone)} ${zoneShortName(jd, zone)}`, glyphAt(jd));
    ribbon.setNow(jdNow());
    setText(dateText, dateShort(jd, zone));
    setText(yearText, ` ${w.year}`);
    setAttr(dateButton, 'aria-label', `Date: ${dateLong(jd, zone)}. Choose a date`);
    const full = clockSeconds(jd, zone);
    // Big hours and minutes, small seconds (and AM/PM on the 12-hour clock).
    const partsNow = clockParts(jd, zone);
    setText(local, partsNow.hm);
    setText(seconds, `${partsNow.seconds}${partsNow.suffix}`);
    setText(zoneName, zoneShortName(jd, zone));
    // UTC beside the display zone; when UTC is the display zone, the place's own clock.
    const placeZ = placeZone(s);
    const utcShown = !(zone.kind === 'fixed' && zone.offsetMs === 0);
    setText(other, utcShown ? `${clock(jd, UTC_ZONE)} UTC` : `${clock(jd, placeZ)} ${zoneShortName(jd, placeZ)}`);
    setAttr(clockButton, 'aria-label', `Time: ${full} ${zoneShortName(jd, zone)}. Type a time`);
    setAttr(nowButton, 'aria-pressed', String(s.time.live));
    setAttr(nowButton, 'data-tip', s.time.live ? 'Following the clock (N)' : 'Back to now, and follow the clock (N)');
    const playing = s.time.playing;
    if (playButton.dataset.state !== String(playing)) {
      playButton.dataset.state = String(playing);
      playButton.replaceChildren(icon(playing ? 'pause' : 'play'));
      setAttr(playButton, 'aria-label', playing ? 'Pause' : 'Play');
      setAttr(playButton, 'data-tip', playing ? 'Pause (Space)' : 'Play: run time forward (Space)');
    }
    setAttr(playButton, 'aria-pressed', String(playing));
    const speed = s.time.speed;
    const label = SHORT_SPEED[Math.abs(speed)] ?? `${Math.abs(speed)}×`;
    setText(speedText, `${speed < 0 ? '−' : ''}${label}`);
    setAttr(speedButton, 'aria-label', `Playback speed: ${label}${speed < 0 ? ', backwards' : ''}. Change`);
  };

  d.add(
    watch(
      ctx,
      (s) => {
        const [a, b] = dayOf(s);
        return [a, b, s.observer, s.selection.body, s.settings.horizon, s.settings.height_of_eye_m, s.settings.timeDisplay, s.settings.angleFormat] as const;
      },
      renderDay,
      { equals: shallowEqual },
    ),
  );
  d.add(
    watch(ctx, (s) => [s.time, s.settings.timeDisplay, s.observer.zone, s.observer.lon_deg, s.selection.body] as const, renderTime, {
      equals: shallowEqual,
    }),
  );

  // --- dragging the handle -------------------------------------------------------------------
  let dragging = false;
  const snapJd = (clientX: number): number => {
    const jd = ribbon.jdAtClientX(clientX);
    const r = ribbon.bar.getBoundingClientRect();
    const [a, b] = ribbon.window();
    const perPx = r.width ? (b - a) / r.width : 0;
    for (const m of marks) if (Math.abs(m.jd - jd) <= 6 * perPx) return m.jd;
    return Math.round(jd * 1440) / 1440;
  };
  ribbon.el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    ribbon.el.setPointerCapture(e.pointerId);
    ribbon.el.dataset.dragging = '';
    if (store.get().time.playing) setPlaying(store, false);
    setTime(store, snapJd(e.clientX));
    ribbon.handle.focus({ preventScroll: true });
  });
  ribbon.el.addEventListener('pointermove', (e) => {
    if (dragging) setTime(store, snapJd(e.clientX));
  });
  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    ribbon.el.releasePointerCapture?.(e.pointerId);
    delete ribbon.el.dataset.dragging;
  };
  ribbon.el.addEventListener('pointerup', endDrag);
  ribbon.el.addEventListener('pointercancel', endDrag);

  ribbon.handle.addEventListener('keydown', (e) => {
    const [a, b] = ribbon.window();
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setTime(store, e.key === 'Home' ? a : b - 1 / 1440);
      return;
    }
    const action = timeKeyAction(e);
    if (!action) return;
    e.preventDefault();
    if (action.kind === 'step') stepTime(store, action.step);
    else if (action.kind === 'toggle-play') {
      if (!e.repeat) togglePlay(store);
    } else goNow(store);
  });

  // --- calendar ------------------------------------------------------------------------------
  const calHost = h('div', {});
  let view = { year: 2000, month: 1 };
  let focus: CalendarDate | undefined;
  const chooseDate = (date: CalendarDate): void => {
    const s = store.get();
    const zone = displayZone(s);
    const w = wallClock(s.time.jd_utc, zone);
    setTime(store, jdFromWallClock({ ...date, hour: w.hour, minute: w.minute, second: w.second, millisecond: w.millisecond }, zone));
    calPop.close();
  };
  const drawCalendar = (): void => {
    const s = store.get();
    const zone = displayZone(s);
    const w = wallClock(s.time.jd_utc, zone);
    const t = wallClock(jdNow(), zone);
    calHost.replaceChildren(
      calendar({
        view,
        selected: { year: w.year, month: w.month, day: w.day },
        today: { year: t.year, month: t.month, day: t.day },
        ...(focus ? { focus } : {}),
        onChoose: chooseDate,
        onStep: (n) => {
          const m = view.month - 1 + n;
          view = { year: view.year + Math.floor(m / 12), month: (((m % 12) + 12) % 12) + 1 };
          focus = undefined;
          drawCalendar();
        },
        onToday: () => chooseDate({ year: t.year, month: t.month, day: t.day }),
        onMoveFocus: (date) => {
          view = { year: date.year, month: date.month };
          focus = date;
          drawCalendar();
          calHost.querySelector<HTMLElement>(`[data-date="${date.year}-${date.month}-${date.day}"]`)?.focus();
        },
      }),
    );
  };
  const calPop = popover(dateButton, calHost, {
    label: 'Choose a date',
    placement: 'bottom-start',
    onOpen: () => {
      const s = store.get();
      const w = wallClock(s.time.jd_utc, displayZone(s));
      view = { year: w.year, month: w.month };
      focus = undefined;
      drawCalendar();
      calHost.querySelector<HTMLElement>('.sf-cal__day[tabindex="0"]')?.focus();
    },
  });
  d.add(() => calPop.destroy());

  // --- typing a time ------------------------------------------------------------------------------
  const timeInput = h('input', { class: 'sf-input sf-num', type: 'time', step: 1, id: 'sf-time-input' });
  const timeZoneNote = h('p', { class: 'sf-editor__hint' });
  const timeForm = h(
    'form',
    { class: 'sf-editor sf-editor--time' },
    h('div', { class: 'sf-popover__title' }, 'Time'),
    h('div', { class: 'sf-editor__field' }, h('label', { class: 'sf-label', for: 'sf-time-input' }, 'Time of day'), timeInput, timeZoneNote),
    h('div', { class: 'sf-editor__actions' }, button({ label: 'Now', variant: 'ghost', size: 'sm', attrs: { 'data-now': '' } }), button({ label: 'Set', variant: 'primary', size: 'sm', attrs: { type: 'submit' } })),
  );
  timeForm.querySelector('[data-now]')!.addEventListener('click', () => {
    goNow(store);
    timePop.close();
  });
  timeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    // Either clock: 18:40, 18:40:05, 6:40 pm (shell/format.ts `parseClock`).
    const m = parseClock(timeInput.value);
    if (!m) return;
    const s = store.get();
    const zone = displayZone(s);
    const w = wallClock(s.time.jd_utc, zone);
    setTime(store, jdFromWallClock({ year: w.year, month: w.month, day: w.day, hour: m.hour, minute: m.minute, second: m.second }, zone));
    timePop.close();
  });
  const timePop = popover(clockButton, timeForm, {
    label: 'Type a time',
    placement: 'bottom-start',
    onOpen: () => {
      const s = store.get();
      const zone = displayZone(s);
      timeInput.value = clockSeconds(s.time.jd_utc, zone);
      timeZoneNote.textContent = `On the clock of ${zoneShortName(s.time.jd_utc, zone)}. UTC is always shown beside it.`;
      timeInput.focus();
    },
  });
  d.add(() => timePop.destroy());

  // --- speed menu ------------------------------------------------------------------------------------
  const direction = segmented<'back' | 'forward'>({
    label: 'Direction',
    value: store.get().time.speed < 0 ? 'back' : 'forward',
    size: 'sm',
    options: [
      { value: 'back', label: 'Backward', icon: 'chevrons-left' },
      { value: 'forward', label: 'Forward', icon: 'chevrons-right' },
    ],
    onChange: (dir) => {
      const speed = Math.abs(store.get().time.speed);
      setSpeed(store, dir === 'back' ? -speed : speed);
    },
  });
  const speedHost = h('div', {});
  const drawSpeeds = (): void => {
    const current = Math.abs(store.get().time.speed);
    speedHost.replaceChildren(
      menu(
        'Playback speed',
        PLAYBACK_SPEEDS.map((p) => ({ value: String(p.speed), label: p.label, hint: SHORT_SPEED[p.speed] ?? '' })),
        String(current),
        (value) => {
          const sign = store.get().time.speed < 0 ? -1 : 1;
          setSpeed(store, sign * Number(value));
          setPlaying(store, true);
          speedPop.close();
        },
      ),
    );
  };
  const speedMenu = h(
    'div',
    { class: 'sf-speed' },
    h('div', { class: 'sf-popover__title' }, 'Direction'),
    h('div', { class: 'sf-speed__direction' }, direction.el),
    h('div', { class: 'sf-popover__title' }, 'Speed'),
    speedHost,
  );
  const speedPop = popover(speedButton, speedMenu, {
    label: 'Playback speed',
    placement: 'bottom-end',
    onOpen: () => {
      direction.set(store.get().time.speed < 0 ? 'back' : 'forward');
      drawSpeeds();
      speedHost.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    },
  });
  d.add(() => speedPop.destroy());

  d.add(() => ribbon.destroy());
  return { el, destroy: () => d.dispose() };
}
