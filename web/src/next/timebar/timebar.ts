/**
 * The time bar: the date (a day back or forward, a calendar with a year field), the clock in
 * the display zone with UTC (or UT) beside it and the ±ΔT chip, the day's sky-phase ribbon
 * with the golden and blue hours, the selected body's rise, highest point and set and a
 * handle to drag, and Now, Play and the playback speed. OWNER: time-ui agent (from the
 * shell-design agent's first version).
 *
 * Keys (EXPLORER_PLAN §2) work anywhere on the page (playback.ts `bindTimeKeys`); on the
 * handle, which is a slider, they are handled here, plus Home and End for the start and
 * end of the day. Dragging moves only the handle's position style each frame; the rest
 * of the page redraws at most once a frame (component.ts `watch`).
 *
 * Deep time (CONVENTIONS 15): dates are in the display calendar with a "Julian" (or "ISO")
 * tag before 1582-10-15, years as Settings writes them (585 BC), the zone is local mean
 * time before 1850 for a zone that follows the place, the second clock is UT outside
 * 1972-2035, and the chip shows how far the clock can be trusted when the Earth's rotation
 * is uncertain (time/chip.ts). Faster than two days a second, the day's events are not
 * computed while time runs (they cost 10-40 ms a day): the ribbon shows the hours only,
 * and the day is drawn in full as soon as time stops or slows.
 */

import './timebar.css';
import '../time/time.css';
import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import { isSunToolsEngine, type SkyEvent, type SunLightWindow } from '../engine/types.js';
import { MONTH_S, PLAYBACK_SPEEDS, YEAR_S, applyStepIn, goNow, setPlaying, setSpeed, setTime, stepTime, timeKeyAction, togglePlay } from '../playback.js';
import { aroundToday, dayOf, setAttr, setText, sunToday } from '../shell/derived.js';
import { bearing3, clock, clockParts, clockSeconds, compassPoint, dateLong, dateShort, endOfDay, eventTime, formatAngle, parseClock } from '../shell/format.js';
import { PHASE_LABEL, PHASE_MEANING, clipPhases, segmentAt } from '../shell/sky.js';
import { displayZone, engineObserver, placeZone, shallowEqual, type ExplorerState } from '../state.js';
import { icon } from '../theme/icons.js';
import { button, iconButton, menu, popover, segmented } from '../theme/primitives.js';
import { UTC_ZONE, jdFromWallClock, jdNow, wallClock, zoneShortName, type Zone } from '../time.js';
import { setUncertaintyChip, timeInfoAt, uncertaintyChip, type ChipInfo } from '../time/chip.js';
import { calendarName, calendarTag, calendarTip, formatYear, yearForms } from '../time/format.js';
import { scaleLabel } from '../time/scale.js';
import { tierAt } from '../time/tier.js';
import { zoneTooltip } from '../time/zones.js';
import { calendar, type CalendarDate } from './calendar.js';
import { createRibbon, type RibbonBand, type RibbonHour, type RibbonMark, type RibbonModel } from './ribbon.js';

const SHORT_SPEED: Record<number, string> = {
  1: '×1',
  60: '1 min/s',
  600: '10 min/s',
  3600: '1 h/s',
  21600: '6 h/s',
  86400: '1 d/s',
  604800: '1 wk/s',
  [MONTH_S]: '1 mo/s',
  [YEAR_S]: '1 yr/s',
  [10 * YEAR_S]: '10 yr/s',
};

/** Faster than this (simulated seconds per second) the day's events wait until time slows. */
export const FAST_PLAYBACK_S = 2 * 86_400;

const WORDS: Record<string, [string, string]> = { Sun: ['Sunrise', 'Sunset'], Moon: ['Moonrise', 'Moonset'] };

/** True while time runs so fast that a new day comes every frame or two. */
export function fastPlayback(s: ExplorerState): boolean {
  return s.time.playing && Math.abs(s.time.speed) > FAST_PLAYBACK_S;
}

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

/** Evenly spaced hour ticks, with no zone arithmetic: for a day seen for one frame while time runs fast. */
export function evenHourTicks(a: number, b: number): RibbonHour[] {
  const out: RibbonHour[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const labelled = i % 3 === 0;
    out.push({ jd: a + ((b - a) * i) / 24, label: labelled ? String(i) : '', major: labelled });
  }
  return out;
}

const BAND_WORDS: Record<SunLightWindow['kind'], [string, string]> = {
  golden: ['Golden hour', 'the Sun between 6° above and 4° below the horizon: warm, low light and long shadows'],
  blue: ['Blue hour', 'the Sun 4° to 6° below the horizon: a deep blue sky and soft, even light'],
};

/** The golden and blue hours of the day shown, as ribbon bands with their tooltips. */
export function sunBands(windows: readonly SunLightWindow[], a: number, b: number, zone: Zone): RibbonBand[] {
  const z = zoneShortName((a + b) / 2, zone);
  return windows
    .filter((w) => w.jd_end > a && w.jd_start < b)
    .map((w) => {
      const [name, meaning] = BAND_WORDS[w.kind];
      const from = w.jd_start <= a ? 'from midnight' : eventTime(w.jd_start, zone);
      const to = w.jd_end >= b ? endOfDay(zone) : eventTime(w.jd_end, zone);
      return { kind: w.kind, jd_start: w.jd_start, jd_end: w.jd_end, tip: `${name} ${from}–${to} ${z}: ${meaning}.` };
    });
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
    { type: 'button', class: 'sf-tb-date__label', 'data-tip': 'Choose a date or a year (Page Up / Page Down: a month; Ctrl: a century)' },
    icon('calendar'),
    h('span', {}, dateText, yearText),
  );
  // "Julian" before 15 October 1582 (or "ISO" for a proleptic Gregorian date): the calendar in use.
  const calTag = h('span', { class: 'sf-cal-tag sf-tb-date__cal', tabindex: 0, hidden: true });
  const local = h('span', {});
  const seconds = h('span', { class: 'sf-tb-clock__sec' });
  // AM or PM on the 12-hour clock: its own element, so it stays when phones hide the seconds.
  const ampm = h('span', { class: 'sf-tb-clock__ampm' });
  const zoneName = h('span', { class: 'sf-tb-clock__zone' });
  const other = h('output', { class: 'sf-tb-clock__utc' });
  const chip = uncertaintyChip(null);
  chip.classList.add('sf-tb-clock__chip');
  const clockButton = h(
    'button',
    { type: 'button', class: 'sf-tb-clock', 'data-tip': 'Type a time' },
    h('output', { class: 'sf-tb-clock__local' }, local, seconds, ampm),
    h('span', { class: 'sf-tb-clock__row' }, zoneName, other),
  );
  prevDay.addEventListener('click', () => stepTime(store, { unit: 'day', count: -1 }));
  nextDay.addEventListener('click', () => stepTime(store, { unit: 'day', count: 1 }));
  const when = h(
    'div',
    { class: 'sf-tb-when' },
    h('div', { class: 'sf-tb-date' }, prevDay, dateButton, nextDay, calTag),
    h('div', { class: 'sf-tb-clockline' }, clockButton, chip),
  );

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
    const jd = s.time.jd_utc;
    if (fastPlayback(s)) {
      // A new day every frame or two: draw the hours and the handle, and the day in full
      // once time stops or slows (the watch below includes `fastPlayback`).
      phases = [];
      marks = [];
      ribbon.update({ window: [a, b], phases, bands: [], hours: evenHourTicks(a, b), marks, jd, glyph: 'sun', valueText: valueText(s), bubbleText: bubbleText(s), nowJd: jdNow() });
      el.classList.remove('sf-timebar--nodata');
      el.classList.add('sf-timebar--fast');
      return;
    }
    el.classList.remove('sf-timebar--fast');
    const day = sunToday(ctx, s);
    phases = day ? clipPhases(day.phases, a, b) : [];
    const body = s.selection.body ?? 'Sun';
    const around = aroundToday(ctx, s, body);
    const events: SkyEvent[] = around?.bodies.find((x) => x.body === body)?.events ?? [];
    const [riseWord, setWord] = WORDS[body] ?? [`${body} rises`, `${body} sets`];
    const z = zoneShortName((a + b) / 2, zone);
    const u = scaleLabel((a + b) / 2);
    marks = events
      .filter((e) => (e.kind === 'rise' || e.kind === 'transit' || e.kind === 'set') && e.jd_utc >= a && e.jd_utc < b)
      .map((e) => {
        const kind = e.kind as RibbonMark['kind'];
        const t = eventTime(e.jd_utc, zone);
        const tip =
          kind === 'transit'
            ? `${body} highest ${t} ${z} (${eventTime(e.jd_utc, UTC_ZONE)} ${u}), ${formatAngle(e.alt_deg, s.settings.angleFormat, 'coarse')} up`
            : `${kind === 'rise' ? riseWord : setWord} ${t} ${z} (${eventTime(e.jd_utc, UTC_ZONE)} ${u}), toward ${bearing3(e.az_deg)} ${compassPoint(e.az_deg)}`;
        return { kind, jd: e.jd_utc, label: t, tip };
      });
    ribbon.update({
      window: [a, b],
      phases,
      bands: day ? goldenAndBlue(s, a, b, zone) : [],
      hours: hourTicks(a, b, zone),
      marks,
      jd,
      glyph: glyphAt(jd),
      valueText: valueText(s),
      bubbleText: bubbleText(s),
      nowJd: jdNow(),
      phaseTip: (p) =>
        `${PHASE_LABEL[p.phase]}, ${eventTime(p.jd_start, zone)}–${p.jd_end >= b ? endOfDay(zone) : eventTime(p.jd_end, zone)}. ${PHASE_MEANING[p.phase]}`,
    });
    el.classList.toggle('sf-timebar--nodata', !day);
  };

  /** The golden and blue hours from the sun tools, when this engine has them (one call a day, memoised). */
  const goldenAndBlue = (s: ExplorerState, a: number, b: number, zone: Zone): RibbonBand[] => {
    const engine = ctx.engine;
    if (!isSunToolsEngine(engine)) return [];
    try {
      return sunBands(engine.sunHours(engineObserver(s), a, b).windows, a, b, zone);
    } catch {
      return [];
    }
  };

  const glyphAt = (jd: number): 'sun' | 'moon' => (segmentAt(phases, jd)?.phase === 'day' ? 'sun' : phases.length ? 'moon' : 'sun');
  const valueText = (s: ExplorerState): string => {
    const zone = displayZone(s);
    const w = wallClock(s.time.jd_utc, zone);
    const tag = calendarTag(w);
    return `${clock(s.time.jd_utc, zone)} ${zoneShortName(s.time.jd_utc, zone)}, ${dateLong(s.time.jd_utc, zone)}${tag ? ` (${calendarName(w)})` : ''}`;
  };
  const bubbleText = (s: ExplorerState): string => {
    const zone = displayZone(s);
    return `${clock(s.time.jd_utc, zone)} ${zoneShortName(s.time.jd_utc, zone)}`;
  };

  /** What the chip needs: σ(ΔT) for the day (it changes by well under a second a day) and the tier now. */
  const chipInfo = (jd: number): ChipInfo | null => {
    const info = timeInfoAt(ctx, Math.floor(jd - 0.5) + 0.5);
    return info ? { delta_t_sigma_s: info.delta_t_sigma_s, tier: tierAt(ctx, jd) } : null;
  };

  // --- the moving part: handle, clock, buttons -------------------------------------------------
  const renderTime = (): void => {
    const s = store.get();
    const zone = displayZone(s);
    const jd = s.time.jd_utc;
    const w = wallClock(jd, zone);
    ribbon.setHandle(jd, valueText(s), bubbleText(s), glyphAt(jd));
    ribbon.setNow(jdNow());
    setText(dateText, dateShort(jd, zone));
    setText(yearText, ` ${formatYear(w.year)}`);
    // Beyond the years 1000-9999 phones keep the year beside the date (it is the news).
    setAttr(dateButton, 'data-far', w.year < 1000 || w.year > 9999 ? '' : null);
    setAttr(yearText, 'data-tip', w.year < 1000 || w.year > 9999 ? yearForms(w.year) : null);
    const tag = calendarTag(w);
    setText(calTag, tag);
    if (calTag.hidden === Boolean(tag)) calTag.hidden = !tag;
    setAttr(calTag, 'data-tip', tag ? calendarTip(w) : null);
    setAttr(calTag, 'aria-label', tag ? calendarName(w) : null);
    setAttr(dateButton, 'aria-label', `Date: ${dateLong(jd, zone)}${tag ? `, ${calendarName(w)}` : ''}. Choose a date or a year`);
    const full = clockSeconds(jd, zone);
    // Big hours and minutes, small seconds (and AM/PM on the 12-hour clock).
    const partsNow = clockParts(jd, zone);
    setText(local, partsNow.hm);
    setText(seconds, partsNow.seconds);
    setText(ampm, partsNow.suffix);
    setText(zoneName, zoneShortName(jd, zone));
    setAttr(zoneName, 'data-tip', zoneTooltip(jd, zone, s.observer.lon_deg));
    // UTC (UT outside 1972-2035) beside the display zone; when that is the display zone, the place's own clock.
    const placeZ = placeZone(s);
    const utcShown = !(zone.kind === 'fixed' && zone.offsetMs === 0 && zone.name === 'UTC');
    setText(other, utcShown ? `${clock(jd, UTC_ZONE)} ${scaleLabel(jd)}` : `${clock(jd, placeZ)} ${zoneShortName(jd, placeZ)}`);
    setAttr(other, 'data-tip', utcShown ? zoneTooltip(jd, UTC_ZONE, s.observer.lon_deg) : zoneTooltip(jd, placeZ, s.observer.lon_deg));
    setAttr(clockButton, 'aria-label', `Time: ${full} ${zoneShortName(jd, zone)}. Type a time`);
    setUncertaintyChip(chip, chipInfo(jd));
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
        return [a, b, s.observer, s.selection.body, s.settings.horizon, s.settings.height_of_eye_m, s.settings.timeDisplay, s.settings.angleFormat, fastPlayback(s)] as const;
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
  /** The date and the clock time shown now, in the display zone. */
  const shownWall = () => {
    const s = store.get();
    const zone = displayZone(s);
    return { s, zone, w: wallClock(s.time.jd_utc, zone) };
  };
  const chooseDate = (date: CalendarDate): void => {
    const { zone, w } = shownWall();
    setTime(store, jdFromWallClock({ ...date, hour: w.hour, minute: w.minute, second: w.second, millisecond: w.millisecond }, zone));
    calPop.close();
  };
  /** After a year step or a typed year: the calendar shows the new month and keeps the popover open. */
  const followTime = (): void => {
    const { w } = shownWall();
    view = { year: w.year, month: w.month };
    focus = undefined;
    drawCalendar();
  };
  const stepYears = (years: number): void => {
    const s = store.get();
    setTime(store, applyStepIn(s, s.time.jd_utc, { unit: 'year', count: years }));
    followTime();
  };
  /** A typed year: the same month, day and clock time in that year (a step of whole years). */
  const goToYear = (year: number): void => {
    const { w } = shownWall();
    stepYears(year - w.year);
    calHost.querySelector<HTMLElement>('.sf-cal__day[tabindex="0"]')?.focus();
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
        onYearStep: stepYears,
        onGoToYear: goToYear,
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
    setTime(store, jdFromWallClock({ year: w.year, month: w.month, day: w.day, calendar: w.calendar, hour: m.hour, minute: m.minute, second: m.second }, zone));
    timePop.close();
  });
  const timePop = popover(clockButton, timeForm, {
    label: 'Type a time',
    placement: 'bottom-start',
    onOpen: () => {
      const s = store.get();
      const zone = displayZone(s);
      timeInput.value = clockSeconds(s.time.jd_utc, zone);
      const z = zoneShortName(s.time.jd_utc, zone);
      timeZoneNote.textContent = `On the clock of ${z}. ${scaleLabel(s.time.jd_utc)} is always shown beside it.`;
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
