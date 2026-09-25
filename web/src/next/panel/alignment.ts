/**
 * The alignment finder on the Sun and Moon cards (expansion programme Q8, photo agent):
 * "When does the Sun set (or rise) along this line?" — down a street (Manhattanhenge), through
 * a window, over a landmark. The bearing is typed, or picked on the map (a click there sets
 * the bearing from the place, and the ray is drawn); the event is setting, rising, or the
 * centre standing at a chosen height (a skyline); a tolerance; a year. The answer lists the
 * days, the closest of each run marked, and pressing a day shows it.
 *
 * The search is the engine's `alignment_days` (suntools, CONVENTIONS 13.10): a whole year in
 * one call, about 0.2 s for the Sun and 0.9 s for the Moon in WebAssembly, so it runs only
 * when the person presses Find, never on its own. The rows are a pure function
 * (`alignmentRows`), tested with the mock engine in photo-tools.test.ts.
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import {
  isGeomagEngine,
  isSunToolsEngine,
  type AlignmentEvent,
  type AlignmentMatch,
  type AlignmentRequest,
  type AlignmentResult,
  type Observer,
} from '../engine/types.js';
import { setTime } from '../playback.js';
import { setText } from '../shell/derived.js';
import { dateShort, eventTime, formatAngle } from '../shell/format.js';
import { displayZone, engineObserver, type AngleFormat, type ExplorerState } from '../state.js';
import { icon } from '../theme/icons.js';
import { segmented } from '../theme/primitives.js';
import { msFromJd, wallClock, type Zone } from '../time.js';
import { formatYear, gregorianDateOfMs, turning } from '../time/index.js';
import { bearingSourceText, deltaTNote, photoBearing, toolChip, type BearingValue } from './photo.js';
import { magneticFromTrue, parseAltitude, parseBearing, parseTolerance, TOLERANCE_MAX, TOLERANCE_MIN } from './sun-tools.js';

export type AlignmentEventKind = 'set' | 'rise' | 'at_altitude';

/** What the person chose, kept per explorer page (never stored). */
interface Choices {
  event: AlignmentEventKind;
  height: string;
  tolerance: string;
  /** Years from the year of the time shown. */
  yearOffset: number;
}

const choices = new WeakMap<object, Choices>();

function choicesFor(store: object): Choices {
  let c = choices.get(store);
  if (!c) {
    c = { event: 'set', height: '0.5', tolerance: '0.5', yearOffset: 0 };
    choices.set(store, c);
  }
  return c;
}

export interface AlignmentRow {
  jd: number;
  /** `Tue 26 May`, on the display clock. */
  date: string;
  /** `20:18`. */
  time: string;
  /** `sets`, `rises`, `sinks through 0.5°`. */
  what: string;
  /** `299.0°`. */
  az: string;
  /** `0.03° right of the line`. */
  offset: string;
  /** `0.03° right`, for the list. */
  offsetShort: string;
  best: boolean;
  /** For assistive technology and the button's name. */
  label: string;
}

/** Offsets smaller than this read as "on the line", degrees. */
const ON_LINE_DEG = 0.005;

/** Where the body is against the line, looking along the bearing: clockwise is to the right. */
export function offsetWords(offsetDeg: number): string {
  if (Math.abs(offsetDeg) < ON_LINE_DEG) return 'on the line';
  const a = Math.abs(offsetDeg);
  return `${a < 1 ? a.toFixed(2) : a.toFixed(1)}° ${offsetDeg > 0 ? 'right' : 'left'} of the line`;
}

function kindWords(m: Pick<AlignmentMatch, 'kind'>, event: AlignmentEvent, format: AngleFormat): string {
  switch (m.kind) {
    case 'rise':
      return 'rises';
    case 'set':
      return 'sets';
    case 'rising':
    case 'setting': {
      const hText = event.kind === 'at_altitude' ? formatAngle(event.altitude_deg, format, 'coarse') : '';
      return `${m.kind === 'rising' ? 'climbs' : 'sinks'} through ${hText}`;
    }
  }
}

function eventName(event: AlignmentEvent, format: AngleFormat): string {
  return event.kind === 'set'
    ? 'sets'
    : event.kind === 'rise'
      ? 'rises'
      : `stands ${formatAngle(event.altitude_deg, format, 'coarse')} high`;
}

/** Runs of consecutive matching days: the engine marks the closest of each `best`. */
function runCount(matches: readonly AlignmentMatch[]): number {
  return matches.filter((m) => m.best).length;
}

/**
 * The list of days and one sentence for an `alignment_days` result. `dt` is the ± text after a
 * time (` ±6 s`): one for every row, or worked out per row (chip2: the Moon's share of σ(ΔT)
 * changes through the month).
 */
export function alignmentRows(
  result: AlignmentResult,
  zone: Zone,
  format: AngleFormat,
  dt: string | ((jd: number) => string) = '',
): { rows: AlignmentRow[]; summary: string } {
  const note = typeof dt === 'function' ? dt : () => dt;
  const body = result.body;
  const along = `${result.azimuth_deg.toFixed(1)}°`;
  const within = `within ${result.tolerance_deg}° of ${along}`;
  const rows = result.matches.map((m): AlignmentRow => {
    const date = dateShort(m.jd_utc, zone);
    const time = `${eventTime(m.jd_utc, zone)}${note(m.jd_utc)}`;
    const what = kindWords(m, result.event, format);
    const offset = offsetWords(m.offset_deg);
    return {
      jd: m.jd_utc,
      date,
      time,
      what,
      az: `${m.az_deg.toFixed(1)}°`,
      offset,
      offsetShort: offset.replace(/ of the line$/, ''),
      best: m.best,
      label: `Show ${date} ${time}: the ${body} ${what} at ${m.az_deg.toFixed(1)}°, ${offset}${m.best ? ', the closest day of its run' : ''}`,
    };
  });
  const cut = result.truncated ? ' Part of the year is outside the years the core covers.' : '';
  let summary: string;
  if (rows.length) {
    const runs = runCount(result.matches);
    summary = `The ${body} ${eventName(result.event, format)} ${within} on ${rows.length} ${rows.length === 1 ? 'day' : 'days'} of ${result.year}${runs > 1 ? `, in ${runs} runs; the closest day of each is marked` : rows.length > 1 ? '; the closest is marked' : ''}. Press a day to show it.${cut}`;
  } else if (result.closest) {
    const c = result.closest;
    summary = `The ${body} never ${eventName(result.event, format)} ${within} in ${result.year}. The nearest is ${dateShort(c.jd_utc, zone)} at ${eventTime(c.jd_utc, zone)}${note(c.jd_utc)}, ${offsetWords(c.offset_deg)}: widen the tolerance, or check the bearing.${cut}`;
  } else {
    summary = `The ${body} never ${result.event.kind === 'set' ? 'sets' : result.event.kind === 'rise' ? 'rises' : 'reaches that height'} here in ${result.year}.${cut}`;
  }
  return { rows, summary };
}

export interface AlignmentTool {
  el: HTMLElement;
  /** On each render of the Selected card (`body` is the Sun or the Moon). */
  update(s: ExplorerState, body: string): void;
  destroy(): void;
}

let seq = 0;

export function alignmentTool(ctx: Ctx): AlignmentTool {
  const { store, engine } = ctx;
  const id = `sf-align-${++seq}`;
  const c = choicesFor(store);
  const bearing = photoBearing(ctx);
  const summaryText = h('span', {}, 'Sunset or sunrise along a line');
  const intro = h('p', { class: 'sf-photo__intro' });

  // --- the bearing: typed, or picked on the map -----------------------------------------
  const bearingInput = h('input', {
    class: 'sf-input sf-num sf-photo__input',
    id: `${id}-az`,
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: '299',
    value: bearing.get().text,
    'aria-describedby': `${id}-az-note`,
  });
  const pickBtn = h(
    'button',
    { type: 'button', class: 'sf-btn sf-btn--secondary sf-btn--sm sf-photo__pick', 'data-tip': 'Click a point on the map: the bearing becomes the direction from your place to it' },
    icon('target'),
    h('span', { class: 'sf-btn__label' }, 'Pick on the map'),
  );
  const bearingNote = h('p', { class: 'sf-photo__sub', id: `${id}-az-note` });

  // --- the event, its height, the tolerance and the year ------------------------------------
  const eventSeg = segmented<AlignmentEventKind>({
    label: 'Which moment',
    size: 'sm',
    value: c.event,
    options: [
      { value: 'set', label: 'Sets', tip: 'Its upper edge touches a sea-level horizon, as the rise and set times give it' },
      { value: 'rise', label: 'Rises', tip: 'Its upper edge touches a sea-level horizon, as the rise and set times give it' },
      { value: 'at_altitude', label: 'At a height', tip: 'Its centre at a height you choose, refraction included: for a skyline or a hill' },
    ],
    onChange: (v) => {
      c.event = v;
      syncHeight();
      markChanged();
    },
  });
  const heightInput = h('input', {
    class: 'sf-input sf-num sf-photo__input',
    id: `${id}-h`,
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    value: c.height,
  });
  const heightRow = h(
    'div',
    { class: 'sf-photo__ask' },
    h('label', { class: 'sf-photo__label', for: `${id}-h`, 'data-tip': 'The height of its centre as you would see it, refraction included. 0.5° puts the centre on a sea horizon without refraction (the “half Sun” of the Manhattanhenge dates newspapers print).' }, 'Height of its centre'),
    heightInput,
    h('span', { class: 'sf-photo__unit' }, '°'),
  );
  const tolInput = h('input', {
    class: 'sf-input sf-num sf-photo__input',
    id: `${id}-tol`,
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    value: c.tolerance,
  });
  const yearValue = h('span', { class: 'sf-num sf-photo__year' });
  const prevYear = h('button', { type: 'button', class: 'sf-btn sf-btn--ghost sf-btn--sm sf-btn--icon', 'aria-label': 'The year before' }, icon('chevron-left'));
  const nextYear = h('button', { type: 'button', class: 'sf-btn sf-btn--ghost sf-btn--sm sf-btn--icon', 'aria-label': 'The year after' }, icon('chevron-right'));
  const find = h('button', { type: 'button', class: 'sf-btn sf-btn--primary sf-btn--sm sf-photo__find' }, h('span', { class: 'sf-btn__label' }, 'Find the days'));
  const statusText = h('span', {});
  const chip = toolChip();
  const status = h('p', { class: 'sf-photo__status', role: 'status', 'aria-live': 'polite' }, statusText, ' ', chip.el);
  const list = h('ul', { class: 'sf-photo__list', 'aria-label': 'Days on the line' });
  // The Sun's rising and setting bearings through the year (charts2's Sun tab), on demand.
  const bearingsChart = h('button', { type: 'button', class: 'sf-link sf-photo__chartlink' }, 'The Sun’s bearings through the year (Charts)');
  bearingsChart.addEventListener('click', () => {
    void import('../charts/index.js').then((m) => m.showCharts(store, 'sun', 'bearings'));
  });

  const el = h(
    'details',
    { class: 'sf-details sf-photo-align' },
    h('summary', {}, summaryText, icon('chevron-down')),
    h(
      'div',
      { class: 'sf-photo__body' },
      intro,
      h(
        'div',
        { class: 'sf-photo__ask' },
        h('label', { class: 'sf-photo__label', for: `${id}-az` }, 'Bearing from here'),
        bearingInput,
        h('span', { class: 'sf-photo__unit' }, '° true'),
      ),
      h('div', { class: 'sf-photo__pickrow' }, pickBtn),
      bearingNote,
      h('div', { class: 'sf-photo__ask' }, h('span', { class: 'sf-photo__label' }, 'Moment'), eventSeg.el),
      heightRow,
      h(
        'div',
        { class: 'sf-photo__ask' },
        h('label', { class: 'sf-photo__label', for: `${id}-tol`, 'data-tip': 'How far from the line still counts, either side' }, 'Within'),
        tolInput,
        h('span', { class: 'sf-photo__unit' }, '° either side'),
      ),
      h('div', { class: 'sf-photo__ask' }, h('span', { class: 'sf-photo__label' }, 'Year'), prevYear, yearValue, nextYear),
      find,
      status,
      list,
      bearingsChart,
    ),
  ) as HTMLDetailsElement;

  let last: { s: ExplorerState; body: string } | null = null;
  /** What the shown list answers, to tell when the inputs changed since. */
  let shownKey = '';
  let releaseRay: (() => void) | null = null;
  let busy = false;

  const syncHeight = (): void => {
    heightRow.hidden = c.event !== 'at_altitude';
  };
  syncHeight();

  /** The year the engine lays out (the wire's proleptic Gregorian year of the local time). */
  const yearOf = (s: ExplorerState): number => {
    const w = wallClock(s.time.jd_utc, displayZone(s));
    return gregorianDateOfMs(msFromJd(s.time.jd_utc) + w.offsetMs).year + c.yearOffset;
  };

  /** The request as the inputs stand, or a sentence saying what is wrong. */
  const request = (
    s: ExplorerState,
    body: string,
  ): { req: AlignmentRequest; obs: Observer; key: string } | string => {
    const az = bearing.get().azimuth;
    if (az === null) return 'Type a bearing (degrees from true north, 0 to 360, or a compass point such as WNW), or pick one on the map.';
    const tol = parseTolerance(tolInput.value);
    if (tol === null) return `Type a tolerance from ${TOLERANCE_MIN}° to ${TOLERANCE_MAX}°.`;
    let event: AlignmentEvent;
    if (c.event === 'at_altitude') {
      const hDeg = parseAltitude(heightInput.value);
      if (hDeg === null || hDeg < -5) return 'Type the height of its centre, from −5° to 90°.';
      event = { kind: 'at_altitude', altitude_deg: hDeg };
    } else {
      event = { kind: c.event };
    }
    const zone = displayZone(s);
    const offset = wallClock(s.time.jd_utc, zone).offsetMs / 3_600_000;
    const req: AlignmentRequest = { body, year: yearOf(s), azimuth_deg: az, tolerance_deg: tol, event, utc_offset_hours: offset };
    const obs = engineObserver(s);
    return { req, obs, key: JSON.stringify([req, obs]) };
  };
  const sunEngine = isSunToolsEngine(engine) ? engine : null;

  const describe = (s: ExplorerState, body: string): void => {
    setText(summaryText, body === 'Moon' ? 'Moonrise or moonset along a line' : 'Sunrise or sunset along a line');
    bearingsChart.hidden = body !== 'Sun';
    setText(
      intro,
      body === 'Moon'
        ? 'The days of a year when the Moon rises or sets along a line: over a landmark, down a valley. Type the bearing or pick it on the map.'
        : 'The days of a year when the Sun sets or rises along a line: down a street (Manhattanhenge), through a window, over a landmark. Type the bearing or pick it on the map.',
    );
    setText(yearValue, formatYear(yearOf(s)));
    const v = bearing.get();
    if (document.activeElement !== bearingInput && bearingInput.value !== v.text) bearingInput.value = v.text;
    bearingInput.toggleAttribute('aria-invalid', bearingInput.value.trim() !== '' && v.azimuth === null);
    setText(bearingNote, bearingNoteText(v, s, ctx));
    pickBtn.setAttribute('aria-pressed', String(bearing.picking()));
    setText(pickBtn.querySelector('.sf-btn__label')!, bearing.picking() ? 'Click the map… (Esc stops)' : 'Pick on the map');
  };

  const markChanged = (): void => {
    if (!last || busy) return;
    const r = request(last.s, last.body);
    const stale = typeof r === 'string' || r.key !== shownKey;
    list.toggleAttribute('data-stale', stale && list.childElementCount > 0);
    if (stale && list.childElementCount > 0) setText(statusText, 'The line, the moment or the place changed: press Find the days again.');
  };

  const run = (): void => {
    if (busy) return;
    // Before the card's first frame (a hidden tab draws none), from the store as it is.
    const s = last?.s ?? store.get();
    const body = last?.body ?? (s.selection.body === 'Moon' ? 'Moon' : 'Sun');
    if (!sunEngine) {
      setText(statusText, 'The alignment finder is not available in this engine: rebuild the WebAssembly package.');
      return;
    }
    const r = request(s, body);
    if (typeof r === 'string') {
      setText(statusText, r);
      list.replaceChildren();
      return;
    }
    busy = true;
    find.setAttribute('aria-busy', 'true');
    find.disabled = true;
    setText(statusText, `Searching ${r.req.year}${body === 'Moon' ? ' (about a second for the Moon)' : ''}…`);
    // Let the words paint before the search takes the page's time.
    requestAnimationFrame(() =>
      setTimeout(() => {
        const st = store.get();
        let result: AlignmentResult | null = null;
        let error = '';
        try {
          result = sunEngine.alignmentDays(r.obs, r.req);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        busy = false;
        find.removeAttribute('aria-busy');
        find.disabled = false;
        list.removeAttribute('data-stale');
        if (!result) {
          list.replaceChildren();
          setText(statusText, `Not found: ${error}.`);
          return;
        }
        shownKey = r.key;
        const zone = displayZone(st);
        // A rising, setting or height on a line: set by the Earth's turning, the body's own
        // share of σ(ΔT) (chip2).
        chip.set(ctx, turning(result.body), result.jd_start, result.jd_end);
        const model = alignmentRows(result, zone, st.settings.angleFormat, (jd) => deltaTNote(ctx, jd, turning(result.body)));
        setText(statusText, model.summary);
        list.replaceChildren(
          ...model.rows.map((row) => {
            const b = h(
              'button',
              { type: 'button', class: `sf-photo__row${row.best ? ' sf-photo__row--best' : ''}`, 'aria-label': row.label },
              h('span', { class: 'sf-photo__date' }, row.date),
              h('span', { class: 'sf-num' }, row.time),
              // "sets" is in the sentence above; a height's crossing says which way.
              h(
                'span',
                { class: 'sf-photo__what' },
                /^(climbs|sinks)/.test(row.what) ? `${row.what.split(' ')[0]}, ` : '',
                h('span', { class: 'sf-num' }, row.az),
                `, ${row.offsetShort}`,
              ),
              row.best ? h('span', { class: 'sf-photo__badge' }, 'best') : null,
            );
            b.addEventListener('click', () => setTime(store, row.jd));
            return h('li', {}, b);
          }),
        );
      }, 0),
    );
  };

  // --- wiring ------------------------------------------------------------------------------
  bearingInput.addEventListener('input', () => {
    bearing.setTyped(bearingInput.value, parseBearing(bearingInput.value));
  });
  for (const input of [bearingInput, heightInput, tolInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
  }
  heightInput.addEventListener('input', () => {
    c.height = heightInput.value;
    heightInput.toggleAttribute('aria-invalid', parseAltitude(heightInput.value) === null);
    markChanged();
  });
  tolInput.addEventListener('input', () => {
    c.tolerance = tolInput.value;
    tolInput.toggleAttribute('aria-invalid', parseTolerance(tolInput.value) === null);
    markChanged();
  });
  const stepYear = (n: number): void => {
    c.yearOffset += n;
    if (last) setText(yearValue, formatYear(yearOf(last.s)));
    markChanged();
  };
  prevYear.addEventListener('click', () => stepYear(-1));
  nextYear.addEventListener('click', () => stepYear(1));
  find.addEventListener('click', run);
  pickBtn.addEventListener('click', () => {
    if (bearing.picking()) {
      bearing.cancelPick();
      return;
    }
    const s = store.get();
    // The picking happens on the map: show it if another view is up.
    if (s.view !== 'map' && s.view !== 'globe') store.patch({ view: 'map' });
    bearing.pick({ lat_deg: s.observer.lat_deg, lon_deg: s.observer.lon_deg }, () => bearingInput.focus({ preventScroll: true }));
  });
  const stopBearing = bearing.subscribe(() => {
    if (last) describe(last.s, last.body);
    markChanged();
  });
  const syncRay = (): void => {
    if (el.open && !releaseRay) releaseRay = bearing.holdRay();
    else if (!el.open && releaseRay) {
      releaseRay();
      releaseRay = null;
    }
  };
  el.addEventListener('toggle', syncRay);

  return {
    el,
    update(s, body) {
      const prev = last;
      last = { s, body };
      if (!prev || prev.body !== body || prev.s.observer !== s.observer || prev.s.settings !== s.settings || yearOf(prev.s) !== yearOf(s)) {
        describe(s, body);
        markChanged();
      }
    },
    destroy() {
      stopBearing();
      releaseRay?.();
      releaseRay = null;
      if (bearing.picking()) bearing.cancelPick();
    },
  };
}

/** Under the bearing: where it came from, and the same bearing on a magnetic compass. */
function bearingNoteText(v: BearingValue, s: ExplorerState, ctx: Ctx): string {
  if (v.azimuth === null) return 'Degrees from true north, clockwise (90 east, 270 west), or a compass point: WNW.';
  const here = { lat_deg: s.observer.lat_deg, lon_deg: s.observer.lon_deg };
  const source = bearingSourceText(v, here);
  let magnetic = '';
  const engine = ctx.engine;
  if (isGeomagEngine(engine)) {
    try {
      const f = engine.magneticField(here.lat_deg, here.lon_deg, s.observer.height_m, Math.floor(s.time.jd_utc));
      if (f.available) magnetic = ` On a compass: ${magneticFromTrue(v.azimuth, f.declination_deg).toFixed(1)}° magnetic (variation ${f.variation_text}).`;
    } catch {
      magnetic = '';
    }
  }
  return `${source ? `${source} ` : ''}The line is drawn on the map.${magnetic}`;
}
