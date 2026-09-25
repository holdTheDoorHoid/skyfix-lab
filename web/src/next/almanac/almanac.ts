/**
 * The Almanac view: the printed Nautical Almanac's daily pages and its other tables.
 * OWNER: almanac agents (the daily pages: almanac agent; the three-day openings, the
 * tables, any year: almanac2 agent).
 *
 * Five tabs:
 * - **Daily pages**: the opening (three dates on two facing pages, grouped from January 1
 *   as the printed almanac groups them) or one date, for the UT date of the explorer's
 *   time, in any year the engine covers (years BC, the Julian calendar before 1582-10-15,
 *   a ±ΔT chip where the Earth's rotation is uncertain).
 * - **Increments**: Increments and Corrections, two minutes a page as printed, with a
 *   look-up for a time after the hour and a v or d.
 * - **Altitude corrections**: the Sun, stars and planets (10°–90° and 0°–10°), dip,
 *   non-standard temperature and pressure (with a calculator), Venus and Mars for the
 *   year, and the Moon's two-part table.
 * - **Polaris**: a0, a1, a2 and the azimuth for the year, with a look-up.
 * - **Arc to time**.
 *
 * Every number comes from the engine exactly as printed (`printed`); the view lays it
 * out. Themed on screen through the design tokens; printing produces black-on-white
 * pages, one per sheet, on A4 or US Letter (almanac.css). Heavy pages (an opening is
 * three daily pages) are computed when the explorer's time has been still for a moment,
 * never on every frame of a drag of the time bar.
 */

import './almanac.css';
import { h } from '../../dom.js';
import { disposer, watch, type Component, type Ctx, type Mounted } from '../component.js';
import {
  isAlmanacEngine,
  isAlmanacTablesEngine,
  type AlmanacEngine,
  type AlmanacTablesEngine,
  type AltitudeTables,
  type IncrementsMinute,
  type PlanetCorrections,
  type PolarisTable,
  type RefractionConditions,
} from '../engine/types.js';
import { goNow, setTime } from '../playback.js';
import { button, segmented } from '../theme/primitives.js';
import { BANNER } from './cells.js';
import { oneDayPages, openingPages, type HourRows, type RenderedPages } from './daily.js';
import {
  anachronismNote,
  deltaTChip,
  engineCalendar,
  entryToJd,
  shownDate,
  tierNote,
  timeInfoAt,
  yearText,
  type CalendarChoice,
} from './dates.js';
import { dayMonthYear, packForDate, packReason, rangeWords, tierAt, tierNotice } from '../time/index.js';
import { dateEntry } from './entry.js';
import { utHourOf } from './layout.js';
import { altitudeSheets, arcSheet, incrementsSheet, polarisSheets } from './tables.js';
import {
  celsiusOf,
  degMinText,
  hpaOfInHg,
  INCREMENT_PAGES,
  lookupIncrement,
  pageMinutes,
  pageOfMinute,
  parseMinuteSecond,
  polarisLookup,
  zoneOf,
} from './tables-model.js';

type Tab = 'pages' | 'increments' | 'altitude' | 'polaris' | 'arc';
type Mode = 'opening' | 'day';

const TABS: readonly { id: Tab; label: string; tip: string }[] = [
  { id: 'pages', label: 'Daily pages', tip: 'The daily pages: three dates to an opening, as the printed almanac has them' },
  { id: 'increments', label: 'Increments', tip: 'Increments and corrections for the minutes and seconds after the hour' },
  { id: 'altitude', label: 'Altitude corrections', tip: 'Sun, stars, planets, dip, the Moon, and unusual temperature and pressure' },
  { id: 'polaris', label: 'Polaris', tip: 'Latitude from Polaris, and its azimuth, for the year' },
  { id: 'arc', label: 'Arc to time', tip: 'Degrees and minutes of arc as hours, minutes and seconds of time' },
];

/** How long the time must be still before a heavy page is computed, and the longest wait. */
const SETTLE_MS = 300;
const MAX_WAIT_MS = 4000;

// Remembered for the page's lifetime, so leaving the view and coming back keeps them.
let lastTab: Tab = 'pages';
let lastMode: Mode = 'opening';
let lastCalendar: CalendarChoice = 'auto';
let lastIncrementsPage = 0;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Env {
  ctx: Ctx;
  mock: boolean;
  pages: AlmanacEngine | null;
  tables: AlmanacTablesEngine | null;
  root: HTMLElement;
}

interface TabMounted extends Mounted {
  /** What the view's Print button prints, when not simply the sheets on screen. */
  print?: () => void;
}

/**
 * Offer the pack a date needs (a pack that extends the years, when this site offers one) and
 * redraw once it is loaded. The pack service asks once and remembers a "Not now".
 */
async function offerPack(env: Env, jd: number, redraw: () => void): Promise<void> {
  const pack = packForDate(env.ctx.packs, jd);
  if (!pack) return;
  if (await env.ctx.packs.ensure(pack.name, packReason(jd, env.ctx, pack))) redraw();
}

function message(text: string, role: 'alert' | 'status' = 'alert'): HTMLElement {
  return h('p', { class: 'alm-message', role }, text);
}

const NOT_AVAILABLE =
  'This engine cannot make the almanac’s tables. Rebuild the numerical core with: npm run wasm --prefix web';

/** Call `fn` once the explorer's time has settled; `now()` skips the wait. */
function settler(fn: () => void): { request(): void; now(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let since = 0;
  return {
    request() {
      const t = Date.now();
      if (timer === null) since = t;
      else clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = null;
          fn();
        },
        t - since >= MAX_WAIT_MS ? 0 : SETTLE_MS,
      );
    },
    now() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      fn();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Daily pages
// ---------------------------------------------------------------------------

function mountPages(panel: HTMLElement, env: Env): TabMounted {
  const { ctx } = env;
  const d = disposer();
  const entry = dateEntry({
    initialCalendar: lastCalendar,
    onSubmit: (value, choice) => {
      lastCalendar = choice;
      const jd = ctx.store.get().time.jd_utc;
      const fraction = jd + 0.5 - Math.floor(jd + 0.5);
      const r = entryToJd(value, choice, fraction);
      if ('error' in r) {
        entry.error(r.error);
        return;
      }
      entry.error(null);
      urgent = true;
      setTime(ctx.store, r.jd);
    },
    onCalendar: (choice) => {
      lastCalendar = choice;
      urgent = true;
      render.now();
    },
  });
  d.add(() => entry.destroy());

  const step = (sign: number): void => {
    urgent = true;
    const jd = ctx.store.get().time.jd_utc;
    const days = mode === 'opening' ? (sign > 0 ? 3 - shownIndex : -1 - shownIndex) : sign;
    setTime(ctx.store, jd + days);
  };
  const prev = button({ icon: 'chevron-left', ariaLabel: 'Previous', tip: 'The previous opening (or date), same time of day', size: 'sm', onClick: () => step(-1) });
  const next = button({ icon: 'chevron-right', ariaLabel: 'Next', tip: 'The next opening (or date), same time of day', size: 'sm', onClick: () => step(1) });
  const today = button({
    label: 'Today',
    tip: 'Follow the clock: today’s UT date',
    size: 'sm',
    onClick: () => {
      urgent = true;
      goNow(ctx.store);
    },
  });
  let mode: Mode = env.tables ? lastMode : 'day';
  const modeSeg = segmented<Mode>({
    label: 'Pages',
    size: 'sm',
    value: mode,
    options: [
      { value: 'opening', label: 'Three dates', tip: 'The printed almanac’s opening: three dates on two facing pages' },
      { value: 'day', label: 'One date', tip: 'One date on two pages, larger on screen' },
    ],
    onChange: (value) => {
      mode = value;
      lastMode = value;
      urgent = true;
      render.now();
    },
  });
  if (!env.tables) modeSeg.el.hidden = true;
  const status = h('p', { class: 'alm-status', role: 'status', 'aria-live': 'polite' });
  const spread = h('div', { class: 'alm-spread' });
  panel.append(
    h('div', { class: 'alm-subbar' }, entry.el, h('span', { class: 'alm-btn-group' }, prev, today, next), modeSeg.el, status),
    spread,
  );

  let shownWire: string[] = [];
  let shownMode: Mode | null = null;
  let shownCalendar: CalendarChoice | null = null;
  let shownIndex = 1;
  let rows: HourRows = [];
  let lit: HTMLTableRowElement[] = [];
  let urgent = true;

  const highlight = (): void => {
    for (const tr of lit) tr.classList.remove('alm-now');
    lit = [];
    const jd = ctx.store.get().time.jd_utc;
    const sd = shownDate(jd, lastCalendar);
    const di = shownWire.indexOf(sd.wire);
    if (di < 0) return;
    const hour = utHourOf(jd);
    lit = rows[di]?.[hour] ?? [];
    for (const tr of lit) tr.classList.add('alm-now');
    status.textContent = lit.length ? `Marked: ${String(hour).padStart(2, '0')}h UT, the explorer’s time` : '';
  };

  const show = (rendered: RenderedPages): void => {
    spread.replaceChildren(...rendered.pages);
    rows = rendered.rows;
    lit = [];
    highlight();
  };

  const coverageHelp = (jd: number): Promise<void> =>
    offerPack(env, jd, () => {
      shownWire = [];
      render.now();
    });

  const draw = (): void => {
    const jd = ctx.store.get().time.jd_utc;
    const sd = shownDate(jd, lastCalendar);
    entry.set(sd, lastCalendar);
    if (shownWire.includes(sd.wire) && shownMode === mode && shownCalendar === lastCalendar) {
      if (mode === 'opening') shownIndex = shownWire.indexOf(sd.wire);
      highlight();
      return;
    }
    if (tierAt(ctx, jd) === 'outside') {
      // Nothing to ask the engine: say so, and offer a pack when one covers the date.
      const pack = packForDate(ctx.packs, jd);
      const notice = tierNotice(ctx, jd, { dateText: dayMonthYear(sd), pack });
      spread.replaceChildren(message(notice?.text ?? `No almanac page for ${yearText(sd.year)}.`));
      shownWire = [];
      shownMode = null;
      status.textContent = '';
      if (pack) void coverageHelp(jd);
      return;
    }
    // polish2 (list item 28): an opening is three daily pages, 0.2 s natively and up to a few
    // seconds in a busy browser; say so and let the page paint before the engine works (a
    // newer request, or the tab closing, drops this one).
    const mine = ++computeToken;
    status.textContent = mode === 'opening' ? 'Working out the three dates’ pages…' : 'Working out the page…';
    spread.setAttribute('aria-busy', 'true');
    const go = (): void => {
      if (mine !== computeToken) return;
      spread.removeAttribute('aria-busy');
      compute(jd, sd);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(go, 0));
    else setTimeout(go, 0);
  };
  let computeToken = 0;
  d.add(() => {
    computeToken += 1;
  });
  const compute = (jd: number, sd: ReturnType<typeof shownDate>): void => {
    status.textContent = '';
    const info = timeInfoAt(ctx, jd);
    const chip = deltaTChip(info);
    const extra = [anachronismNote(sd.year), tierNote(ctx, jd)].filter((x): x is string => !!x);
    try {
      if (mode === 'opening' && env.tables) {
        const o = env.tables.almanacOpening(sd.wire, engineCalendar(lastCalendar));
        // The engine's notes already say it for an opening before 1767.
        show(openingPages(o, extra.filter((x) => !x.startsWith('The first Nautical')), chip, env.mock));
        shownWire = o.dates.map((x) => x.date);
        shownIndex = o.index;
      } else if (env.pages) {
        const day = env.pages.almanacDay(sd.wire);
        show(oneDayPages(day, sd, extra, chip, env.mock));
        shownWire = [day.date];
        shownIndex = 0;
      } else {
        spread.replaceChildren(message('This engine cannot make almanac pages (it has no almanacDay). Rebuild the numerical core with: npm run wasm --prefix web'));
        shownWire = [];
        status.textContent = '';
        return;
      }
      shownMode = mode;
      shownCalendar = lastCalendar;
      ctx.notices.dismissKey('almanac');
    } catch (error) {
      const text = `No almanac page for ${sd.wire}: ${errorText(error)}`;
      ctx.notices.push('error', text, { key: 'almanac' });
      spread.replaceChildren(message(text));
      shownWire = [];
      status.textContent = '';
      void coverageHelp(jd);
    }
  };
  const render = settler(draw);
  d.add(() => render.cancel());

  d.add(
    watch(ctx, (s) => s.time.jd_utc, (jd) => {
      const sd = shownDate(jd, lastCalendar);
      if (shownWire.includes(sd.wire) && shownMode === mode && shownCalendar === lastCalendar) {
        entry.set(sd, lastCalendar);
        if (mode === 'opening') shownIndex = shownWire.indexOf(sd.wire);
        highlight();
        return;
      }
      if (urgent || shownMode === null) {
        urgent = false;
        render.now();
      } else {
        entry.set(sd, lastCalendar);
        status.textContent = 'Waiting for the time to settle…';
        render.request();
      }
    }),
  );
  d.add(() => panel.replaceChildren());
  return { destroy: () => d.dispose() };
}

// ---------------------------------------------------------------------------
// Increments and Corrections
// ---------------------------------------------------------------------------

function mountIncrements(panel: HTMLElement, env: Env): TabMounted {
  const d = disposer();
  const tables = env.tables;
  if (!tables) {
    panel.append(message(NOT_AVAILABLE));
    return { destroy: () => panel.replaceChildren() };
  }
  let page = lastIncrementsPage;
  let mark: { minute: number; second: number } | null = null;
  const minuteOf = (m: number): IncrementsMinute => tables.almanacIncrements(m);
  const sheets = h('div', { class: 'alm-sheets' });
  const printAll = h('div', { class: 'alm-print-all', 'aria-hidden': 'true' });
  const pageLabel = h('span', { class: 'alm-page-label', 'aria-live': 'polite' });
  const result = h('p', { class: 'alm-result', role: 'status', 'aria-live': 'polite' });

  const draw = (): void => {
    lastIncrementsPage = page;
    const [a, b] = pageMinutes(page);
    pageLabel.textContent = `Minutes ${a}–${b} · page ${page + 1} of ${INCREMENT_PAGES}`;
    try {
      sheets.replaceChildren(incrementsSheet([minuteOf(a), minuteOf(b)], mark, true, env.mock));
    } catch (error) {
      sheets.replaceChildren(message(errorText(error)));
    }
  };
  const go = (p: number): void => {
    page = Math.max(0, Math.min(INCREMENT_PAGES - 1, p));
    draw();
  };
  const prev = button({ icon: 'chevron-left', ariaLabel: 'Previous page', tip: 'Minutes before these', size: 'sm', onClick: () => go(page - 1) });
  const next = button({ icon: 'chevron-right', ariaLabel: 'Next page', tip: 'Minutes after these', size: 'sm', onClick: () => go(page + 1) });

  const time = h('input', { class: 'sf-input alm-find-time', type: 'text', inputmode: 'numeric', placeholder: 'mm:ss', 'aria-label': 'Minutes and seconds after the hour', size: 6 });
  const vIn = h('input', { class: 'sf-input alm-find-v', type: 'number', step: 0.1, min: -18, max: 18, 'aria-label': 'v, arcminutes', placeholder: 'v' });
  const dIn = h('input', { class: 'sf-input alm-find-d', type: 'number', step: 0.1, min: -18, max: 18, 'aria-label': 'd, arcminutes', placeholder: 'd' });
  const find = (): void => {
    const t = parseMinuteSecond(time.value);
    if (!t) {
      result.textContent = 'Type the minutes and seconds after the hour, as 58:27.';
      return;
    }
    const num = (el: HTMLInputElement): number | null => (el.value.trim() === '' ? null : Number(el.value));
    try {
      const r = lookupIncrement(minuteOf(t.minute), t.second, num(vIn), num(dIn));
      mark = { minute: t.minute, second: t.second };
      page = pageOfMinute(t.minute);
      draw();
      const parts = [
        `${t.minute}m ${String(t.second).padStart(2, '0')}s: Sun and planets +${degMinText(arcminOf(r.sunPlanets))}`,
        `Aries +${degMinText(arcminOf(r.aries))}`,
        `Moon +${degMinText(arcminOf(r.moon))}`,
      ];
      if (r.v) parts.push(`v ${r.v.value}: ${r.v.correction}′`);
      if (r.d) parts.push(`d ${r.d.value}: ${r.d.correction}′ (the sign as the declination goes)`);
      result.textContent = `${parts.join(' · ')}.`;
    } catch (error) {
      result.textContent = errorText(error);
    }
  };
  const findBtn = button({ label: 'Find', size: 'sm', tip: 'Show the row and the corrections', onClick: find });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') find();
  };
  for (const el of [time, vIn, dIn]) el.addEventListener('keydown', onKey);
  d.add(() => {
    for (const el of [time, vIn, dIn]) el.removeEventListener('keydown', onKey);
  });

  const printAllPages = (): void => {
    const all: HTMLElement[] = [];
    for (let p = 0; p < INCREMENT_PAGES; p += 1) {
      const [a, b] = pageMinutes(p);
      all.push(incrementsSheet([minuteOf(a), minuteOf(b)], null, p === 0, env.mock));
    }
    printAll.replaceChildren(...all);
    env.root.dataset.printAll = '1';
    const done = (): void => {
      delete env.root.dataset.printAll;
      printAll.replaceChildren();
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };
  const printAllBtn = button({ label: 'Print all 30 pages', size: 'sm', variant: 'outline', tip: 'Every minute, 0 to 59, two to a sheet', onClick: printAllPages });
  d.add(() => {
    delete env.root.dataset.printAll;
  });

  panel.append(
    h(
      'div',
      { class: 'alm-subbar' },
      h('span', { class: 'alm-btn-group' }, prev, pageLabel, next),
      h(
        'span',
        { class: 'alm-find', role: 'group', 'aria-label': 'Look up a time' },
        h('span', { class: 'alm-date-label' }, 'Look up'),
        time,
        vIn,
        dIn,
        findBtn,
      ),
      printAllBtn,
      result,
    ),
    sheets,
    printAll,
  );
  draw();
  d.add(() => panel.replaceChildren());
  return { destroy: () => d.dispose() };
}

function arcminOf(printed: string): number {
  const [deg = '0', min = '0'] = printed.split(' ');
  return Number(deg) * 60 + Number(min);
}

// ---------------------------------------------------------------------------
// Altitude corrections
// ---------------------------------------------------------------------------

function displayYear(env: Env): { year: number; label: string } {
  const sd = shownDate(env.ctx.store.get().time.jd_utc, lastCalendar);
  return { year: sd.year, label: yearText(sd.year) };
}

function mountAltitude(panel: HTMLElement, env: Env): TabMounted {
  const d = disposer();
  const tables = env.tables;
  if (!tables) {
    panel.append(message(NOT_AVAILABLE));
    return { destroy: () => panel.replaceChildren() };
  }
  const sheets = h('div', { class: 'alm-sheets' });
  const result = h('p', { class: 'alm-result', role: 'status', 'aria-live': 'polite' });
  const tIn = h('input', { class: 'sf-input alm-cond', type: 'number', step: 1, 'aria-label': 'Air temperature', placeholder: '10' });
  const tUnit = h('select', { class: 'sf-input', 'aria-label': 'Temperature unit' }, h('option', { value: 'C' }, '°C'), h('option', { value: 'F' }, '°F'));
  const pIn = h('input', { class: 'sf-input alm-cond', type: 'number', step: 0.01, 'aria-label': 'Air pressure', placeholder: '1010' });
  const pUnit = h('select', { class: 'sf-input', 'aria-label': 'Pressure unit' }, h('option', { value: 'hPa' }, 'hPa'), h('option', { value: 'inHg' }, 'inHg'));

  let conditions: RefractionConditions | null = null;
  let planetsYear: number | null = null;
  let planets: PlanetCorrections | null = null;
  let tablesData: AltitudeTables | null = null;

  const readConditions = (): RefractionConditions | null => {
    if (tIn.value.trim() === '' || pIn.value.trim() === '') return null;
    const t = Number(tIn.value);
    const p = Number(pIn.value);
    if (!Number.isFinite(t) || !Number.isFinite(p)) return null;
    return {
      temperature_c: tUnit.value === 'F' ? celsiusOf(t) : t,
      pressure_hpa: pUnit.value === 'inHg' ? hpaOfInHg(p) : p,
    };
  };

  const draw = (): void => {
    const { year, label } = displayYear(env);
    try {
      tablesData = tables.almanacAltitudeTables(conditions);
    } catch (error) {
      sheets.replaceChildren(message(errorText(error)));
      return;
    }
    if (planetsYear !== year) {
      planetsYear = year;
      try {
        planets = tables.almanacPlanetCorrections(year, engineCalendar(lastCalendar));
      } catch {
        planets = null;
      }
      if (!planets || planets.errors.length) {
        void offerPack(env, env.ctx.store.get().time.jd_utc, () => {
          planetsYear = null;
          draw();
        });
      }
    }
    sheets.replaceChildren(...altitudeSheets(tablesData, planets, env.mock));
    const c = tablesData.additional.conditions;
    if (c) {
      const zone = c.zone ?? zoneOf(tablesData.additional.zones, c.temperature_c, c.pressure_hpa);
      const rows = tablesData.additional.rows;
      const pick = [0, 2, 4, 10, 15, 20, 25].filter((i) => i < rows.length);
      result.textContent =
        `${c.temperature_c.toFixed(1)} °C and ${c.pressure_hpa.toFixed(1)} hPa: air density ${c.factor.toFixed(3)}, ` +
        `${zone ? `zone ${zone}` : 'beyond the zones'}. Exact additional corrections: ` +
        pick.map((i) => `${rows[i]!.printed_alt.replace(' ', '° ')}′ ${c.corrections[i]!.printed}′`).join(', ') +
        '.';
    } else {
      result.textContent = `Venus and Mars for ${label}. Type a temperature and pressure for their zone and exact corrections.`;
    }
  };
  const onCond = (): void => {
    conditions = readConditions();
    draw();
  };
  for (const el of [tIn, tUnit, pIn, pUnit]) el.addEventListener('change', onCond);
  d.add(() => {
    for (const el of [tIn, tUnit, pIn, pUnit]) el.removeEventListener('change', onCond);
  });
  panel.append(
    h(
      'div',
      { class: 'alm-subbar' },
      h(
        'span',
        { class: 'alm-find', role: 'group', 'aria-label': 'Non-standard temperature and pressure' },
        h('span', { class: 'alm-date-label' }, 'Conditions'),
        tIn,
        tUnit,
        pIn,
        pUnit,
      ),
      result,
    ),
    sheets,
  );
  const settle = settler(draw);
  d.add(() => settle.cancel());
  draw();
  // Venus and Mars follow the year of the explorer's time.
  d.add(
    watch(
      env.ctx,
      (s) => shownDate(s.time.jd_utc, lastCalendar).year,
      (year) => {
        if (year !== planetsYear) settle.request();
      },
      { immediate: false },
    ),
  );
  d.add(() => panel.replaceChildren());
  return { destroy: () => d.dispose() };
}

// ---------------------------------------------------------------------------
// Polaris
// ---------------------------------------------------------------------------

function mountPolaris(panel: HTMLElement, env: Env): TabMounted {
  const d = disposer();
  const tables = env.tables;
  if (!tables) {
    panel.append(message(NOT_AVAILABLE));
    return { destroy: () => panel.replaceChildren() };
  }
  const sheets = h('div', { class: 'alm-sheets' });
  const result = h('p', { class: 'alm-result', role: 'status', 'aria-live': 'polite' });
  const lhaDeg = h('input', { class: 'sf-input alm-cond', type: 'number', min: 0, max: 359, step: 1, 'aria-label': 'LHA Aries, degrees', placeholder: '°' });
  const lhaMin = h('input', { class: 'sf-input alm-cond', type: 'number', min: 0, max: 59.9, step: 0.1, 'aria-label': 'LHA Aries, minutes', placeholder: '′' });
  const lat = h('input', { class: 'sf-input alm-cond', type: 'number', min: 0, max: 68, step: 1, 'aria-label': 'Latitude, degrees north', placeholder: 'lat' });
  const month = h('select', { class: 'sf-input', 'aria-label': 'Month' }, ...['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => h('option', { value: String(i + 1) }, m)));
  let table: PolarisTable | null = null;
  let shownYear: number | null = null;

  const lookup = (): void => {
    if (!table) return;
    const lha = Number(lhaDeg.value) + Number(lhaMin.value || 0) / 60;
    const r = polarisLookup(table, lha, Number(lat.value || 0), Number(month.value));
    if (!r || lhaDeg.value.trim() === '') {
      result.textContent = 'Type LHA Aries (degrees and minutes), your latitude and the month.';
      return;
    }
    result.textContent = `a₀ ${r.a0} + a₁ ${r.a1}′ + a₂ ${r.a2}′ − 1° = ${r.correction}′: latitude = Ho ${r.correction}′.`;
  };
  const draw = (): void => {
    const { year, label } = displayYear(env);
    if (year === shownYear && table) return;
    try {
      table = tables.almanacPolaris(year, engineCalendar(lastCalendar));
      shownYear = year;
      sheets.replaceChildren(...polarisSheets(table, env.mock));
      lookup();
    } catch (error) {
      table = null;
      shownYear = null;
      // The tables are made only while Polaris is near the pole, the validated years (polish2).
      const years = rangeWords(errorText(error));
      sheets.replaceChildren(
        message(
          years
            ? `No Polaris tables for ${label}: they are made only for ${years}, while Polaris stands near the pole (in AD 1000 it was 6° from it, and in 2000 BC Thuban was the pole star).`
            : `No Polaris tables for ${label}: ${errorText(error)}`,
          years ? 'status' : 'alert',
        ),
      );
      void offerPack(env, env.ctx.store.get().time.jd_utc, draw);
    }
  };
  for (const el of [lhaDeg, lhaMin, lat, month]) el.addEventListener('change', lookup);
  d.add(() => {
    for (const el of [lhaDeg, lhaMin, lat, month]) el.removeEventListener('change', lookup);
  });
  month.value = String(shownDate(env.ctx.store.get().time.jd_utc, lastCalendar).month);
  panel.append(
    h(
      'div',
      { class: 'alm-subbar' },
      h(
        'span',
        { class: 'alm-find', role: 'group', 'aria-label': 'Latitude by Polaris' },
        h('span', { class: 'alm-date-label' }, 'Look up'),
        lhaDeg,
        lhaMin,
        lat,
        month,
      ),
      result,
    ),
    sheets,
  );
  const settle = settler(draw);
  d.add(() => settle.cancel());
  draw();
  d.add(
    watch(
      env.ctx,
      (s) => shownDate(s.time.jd_utc, lastCalendar).year,
      () => settle.request(),
      { immediate: false },
    ),
  );
  d.add(() => panel.replaceChildren());
  return { destroy: () => d.dispose() };
}

// ---------------------------------------------------------------------------
// Arc to time
// ---------------------------------------------------------------------------

function mountArc(panel: HTMLElement, env: Env): TabMounted {
  if (!env.tables) {
    panel.append(message(NOT_AVAILABLE));
    return { destroy: () => panel.replaceChildren() };
  }
  try {
    panel.append(h('div', { class: 'alm-sheets' }, arcSheet(env.tables.almanacArcToTime(), env.mock)));
  } catch (error) {
    panel.append(message(errorText(error)));
  }
  return { destroy: () => panel.replaceChildren() };
}

const MOUNT: Record<Tab, (panel: HTMLElement, env: Env) => TabMounted> = {
  pages: mountPages,
  increments: mountIncrements,
  altitude: mountAltitude,
  polaris: mountPolaris,
  arc: mountArc,
};

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

let viewCounter = 0;

export const almanacView: Component = (host, ctx) => {
  const d = disposer();
  viewCounter += 1;
  const panelId = `alm-panel-${viewCounter}`;
  const root = h('section', { class: 'almanac sf-on-stage', 'aria-label': 'Nautical almanac' });
  const env: Env = {
    ctx,
    mock: ctx.engine.kind === 'mock',
    pages: isAlmanacEngine(ctx.engine) ? ctx.engine : null,
    tables: isAlmanacTablesEngine(ctx.engine) ? ctx.engine : null,
    root,
  };

  const tablist = h('div', { class: 'sf-seg alm-tabs', role: 'tablist', 'aria-label': 'Almanac' });
  const panel = h('div', { class: 'alm-panel', role: 'tabpanel', id: panelId, tabindex: '-1' });
  let tab: Tab = lastTab;
  let mounted: TabMounted | null = null;

  const select = (next: Tab, focus: boolean): void => {
    tab = next;
    lastTab = next;
    tabs.forEach((el, i) => {
      const on = TABS[i]!.id === next;
      el.setAttribute('aria-selected', String(on));
      el.tabIndex = on ? 0 : -1;
      if (on && focus) el.focus();
    });
    mounted?.destroy();
    panel.replaceChildren();
    panel.setAttribute('aria-labelledby', `${panelId}-${next}`);
    root.dataset.tab = next;
    mounted = MOUNT[next](panel, env);
  };
  const tabs = TABS.map((t, i) => {
    const el = h('button', { type: 'button', class: 'sf-seg__opt', role: 'tab', id: `${panelId}-${t.id}`, 'aria-controls': panelId, 'data-tip': t.tip }, t.label);
    el.addEventListener('click', () => select(t.id, false));
    el.addEventListener('keydown', (event) => {
      let j: number | null = null;
      if (event.key === 'ArrowRight') j = (i + 1) % TABS.length;
      else if (event.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
      else if (event.key === 'Home') j = 0;
      else if (event.key === 'End') j = TABS.length - 1;
      if (j === null) return;
      event.preventDefault();
      select(TABS[j]!.id, true);
    });
    tablist.append(el);
    return el;
  });

  const print = button({
    label: 'Print',
    tip: 'These pages, black on white, one per sheet (A4 or US Letter)',
    size: 'sm',
    variant: 'outline',
    onClick: () => (mounted?.print ? mounted.print() : window.print()),
  });

  root.append(
    h('div', { class: 'alm-toolbar' }, h('h2', { class: 'alm-title' }, 'Nautical almanac'), tablist, h('span', { class: 'alm-spacer' }), print),
    panel,
    h('p', { class: 'alm-banner-line' }, BANNER),
  );
  host.append(root);

  // Printing prints this view and nothing around it (almanac.css, `data-print-view`).
  const html = document.documentElement;
  html.dataset.printView = 'almanac';
  d.add(() => {
    mounted?.destroy();
    mounted = null;
    if (html.dataset.printView === 'almanac') delete html.dataset.printView;
    root.remove();
  });

  select(tab, false);
  return { destroy: () => d.dispose() };
};
