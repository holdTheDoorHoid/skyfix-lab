/**
 * The Almanac view: the two facing daily pages of a nautical almanac for the UT date of
 * the explorer's time, laid out like the printed Nautical Almanac. OWNER: almanac agent.
 *
 * - Left page: GHA of Aries and GHA/Dec of Venus, Mars, Jupiter and Saturn for every hour,
 *   their v, d, SHA, magnitude and meridian passage, and the 57 stars plus Polaris.
 * - Right page: GHA/Dec of the Sun and GHA, v, Dec, d, HP of the Moon for every hour, the
 *   twilight, sunrise, sunset, moonrise and moonset tables for 72 N to 60 S, and the
 *   Sun/Moon box (equation of time, meridian passages, the Moon's age and phase).
 *
 * The date is the store's time (`store.time`): the date picker and the day buttons set it,
 * keeping the time of day, and the row of the current UT hour is highlighted on screen.
 * Every number comes from the engine's `almanacDay` exactly as printed (`printed`); the
 * view only lays it out. Themed on screen through the design tokens; printing produces
 * black-on-white pages, one per sheet, on A4 or US Letter (almanac.css).
 */

import './almanac.css';
import { h } from '../../dom.js';
import { disposer, watch, type Component } from '../component.js';
import {
  isAlmanacEngine,
  type AlmanacDay,
  type AlmanacEngine,
  type AlmanacHour,
  type AlmanacLatitudeRow,
  type AlmanacTime,
} from '../engine/types.js';
import { goNow, setTime } from '../playback.js';
import {
  blocks,
  dayOfMonth,
  decParts,
  ghaParts,
  moveToUtDate,
  pageHeading,
  phaseName,
  phaseSymbol,
  showDecDegrees,
  timeCellClass,
  timeCellTitle,
  utDateOf,
  utHourOf,
} from './layout.js';

type Child = Node | string | null | undefined | false;

const BANNER = 'Simulation and analysis workbench. Not a navigation instrument.';

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function srOnly(text: string): HTMLElement {
  return h('span', { class: 'alm-sr' }, text);
}

/** `183 12.4` with the degrees right-aligned and the minutes aligned on the point. */
function ghaCell(printed: string, extra = ''): HTMLTableCellElement {
  const p = ghaParts(printed);
  return h(
    'td',
    { class: `alm-a${extra}` },
    h('span', { class: 'alm-deg' }, p.deg),
    h('span', { class: 'alm-min' }, p.min),
  );
}

/** `N 12 34.5`; with `showDeg` false only the minutes (the printed almanac's style). */
function decCell(printed: string, showDeg: boolean): HTMLTableCellElement {
  const p = decParts(printed);
  return h(
    'td',
    { class: 'alm-a alm-dec' },
    showDeg ? null : srOnly(`${p.hemisphere} ${p.deg}° `),
    h('span', { class: 'alm-hemi', 'aria-hidden': showDeg ? undefined : 'true' }, showDeg ? p.hemisphere : ''),
    h('span', { class: 'alm-deg', 'aria-hidden': showDeg ? undefined : 'true' }, showDeg ? p.deg : ''),
    h('span', { class: 'alm-min' }, p.min),
  );
}

function numCell(text: string, cls = 'alm-n'): HTMLTableCellElement {
  return h('td', { class: cls }, text);
}

function timeCell(t: AlmanacTime): HTMLTableCellElement {
  return h('td', { class: timeCellClass(t), title: timeCellTitle(t) }, t.printed);
}

function th(text: Child, attrs: Record<string, string | number> = {}): HTMLTableCellElement {
  return h('th', attrs, text);
}

/** Per 6-hour block, which rows show a declination's degrees. */
function decShown(hours: readonly AlmanacHour[], pick: (r: AlmanacHour) => string | null): boolean[] {
  const out: boolean[] = [];
  for (const block of blocks(hours, 6)) {
    out.push(...showDecDegrees(block.map((r) => pick(r) ?? '')));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

function pageHeader(day: AlmanacDay, side: string, mock: boolean): HTMLElement {
  return h(
    'header',
    { class: 'alm-head' },
    h('span', { class: 'alm-head-side' }, side),
    h('h3', { class: 'alm-head-date' }, pageHeading(day)),
    h('span', { class: 'alm-head-ut' }, 'UT'),
    mock
      ? h(
          'p',
          { class: 'alm-mock', role: 'note' },
          'MOCK ENGINE: illustrative numbers for interface development, not from the SkyFix Lab numerical core.',
        )
      : null,
  );
}

function pageFooter(text: string): HTMLElement {
  return h('footer', { class: 'alm-foot' }, h('span', {}, 'SkyFix Lab'), h('span', {}, BANNER), h('span', {}, text));
}

function caption(text: string): HTMLTableCaptionElement {
  return h('caption', { class: 'alm-sr' }, text);
}

// ---------------------------------------------------------------------------
// Left page
// ---------------------------------------------------------------------------

function leftHourly(day: AlmanacDay, rows: HTMLTableRowElement[]): HTMLTableElement {
  const head1 = h('tr', {}, th('UT', { rowspan: 2, scope: 'col', class: 'alm-ut' }), th('ARIES', { scope: 'col' }));
  const head2 = h('tr', {}, th('GHA', { scope: 'col' }));
  for (const p of day.planets) {
    head1.append(
      th(
        h('span', {}, p.body.toUpperCase(), ' ', h('span', { class: 'alm-mag' }, p.printed.magnitude)),
        { colspan: 2, scope: 'colgroup', class: 'alm-body' },
      ),
    );
    head2.append(th('GHA', { scope: 'col' }), th('Dec', { scope: 'col' }));
  }
  const table = h(
    'table',
    { class: 'alm-table alm-hourly alm-hourly-left' },
    caption(`GHA of Aries, and GHA and declination of the planets, every hour of ${day.date} UT`),
    h('thead', {}, head1, head2),
  );
  const shown = day.planets.map((_, i) => decShown(day.hours, (r) => r.planets[i]?.printed.dec ?? null));
  for (const block of blocks(day.hours, 6)) {
    const body = h('tbody', {});
    for (const r of block) {
      const tr = h(
        'tr',
        { 'data-hour': r.hour },
        th(String(r.hour).padStart(2, '0'), { scope: 'row', class: 'alm-ut' }),
        ghaCell(r.aries.printed.gha),
      );
      r.planets.forEach((p, i) => {
        tr.append(ghaCell(p.printed.gha, ' alm-gap'), decCell(p.printed.dec, shown[i]![r.hour]!));
      });
      rows[r.hour] = tr;
      body.append(tr);
    }
    table.append(body);
  }
  const foot = h(
    'tr',
    {},
    h('td', { colspan: 2, class: 'alm-footnote' }, 'Mer. Pass. ', h('b', {}, day.aries.mer_pass.printed)),
  );
  for (const p of day.planets) {
    foot.append(
      h(
        'td',
        { colspan: 2, class: 'alm-footnote' },
        'v ',
        h('b', {}, p.printed.v),
        '  d ',
        h('b', {}, p.printed.d),
      ),
    );
  }
  table.append(h('tfoot', {}, foot));
  return table;
}

function planetBox(day: AlmanacDay): HTMLTableElement {
  return h(
    'table',
    { class: 'alm-table alm-box alm-planet-box' },
    caption(`The planets' SHA at 12h UT and meridian passage at Greenwich on ${day.date}`),
    h('thead', {}, h('tr', {}, th('', { scope: 'col' }), th('SHA', { scope: 'col' }), th('Mer. Pass.', { scope: 'col' }))),
    h(
      'tbody',
      {},
      ...day.planets.map((p) =>
        h('tr', {}, th(p.body, { scope: 'row' }), ghaCell(p.printed.sha), timeCell(p.mer_pass)),
      ),
    ),
  );
}

function starTable(day: AlmanacDay): HTMLTableElement {
  const table = h(
    'table',
    { class: 'alm-table alm-stars' },
    caption(`SHA and declination of the navigational stars and Polaris at 12h UT on ${day.date}`),
    h(
      'thead',
      {},
      h('tr', {}, th('STARS', { colspan: 3, scope: 'colgroup', class: 'alm-body' })),
      h('tr', {}, th('Name', { scope: 'col' }), th('SHA', { scope: 'col' }), th('Dec', { scope: 'col' })),
    ),
  );
  for (const block of blocks(day.stars, 5)) {
    table.append(
      h(
        'tbody',
        {},
        ...block.map((s) =>
          h(
            'tr',
            { class: s.body === 'Polaris' ? 'alm-polaris' : undefined },
            th(s.body, { scope: 'row', class: 'alm-star' }),
            ghaCell(s.printed.sha),
            decCell(s.printed.dec, true),
          ),
        ),
      ),
    );
  }
  return table;
}

function explainBox(): HTMLElement {
  return h(
    'div',
    { class: 'alm-explain' },
    h('p', {}, h('b', {}, 'Using the pages. '), 'GHA of a star = GHA Aries + SHA. Between the hours add the increment for the minutes and seconds (15° an hour for the Sun and planets, 15° 02.5′ for Aries, 14° 19.0′ for the Moon), then v × the fraction of the hour; change the declination by d × the fraction, in the direction the column is going.'),
    h('p', {}, h('b', {}, 'Mer. Pass. '), 'is the UT at which the body crosses the Greenwich meridian; for another longitude add 4 minutes for every degree west (subtract for east).'),
  );
}

function leftPage(day: AlmanacDay, rows: HTMLTableRowElement[], mock: boolean): HTMLElement {
  return h(
    'article',
    { class: 'alm-page alm-page-left', 'aria-label': `Left page for ${day.date}: Aries, planets, stars` },
    pageHeader(day, 'ARIES · PLANETS · STARS', mock),
    h(
      'div',
      { class: 'alm-grid' },
      h('div', { class: 'alm-main' }, leftHourly(day, rows), planetBox(day), explainBox()),
      h('div', { class: 'alm-side' }, starTable(day)),
    ),
    pageFooter(`Stars and SHA at 12h UT · ${day.weekday} ${day.date}`),
  );
}

// ---------------------------------------------------------------------------
// Right page
// ---------------------------------------------------------------------------

function rightHourly(day: AlmanacDay, rows: HTMLTableRowElement[]): HTMLTableElement {
  const table = h(
    'table',
    { class: 'alm-table alm-hourly alm-hourly-right' },
    caption(`GHA and declination of the Sun, and GHA, v, declination, d and HP of the Moon, every hour of ${day.date} UT`),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        th('UT', { rowspan: 2, scope: 'col', class: 'alm-ut' }),
        th('SUN', { colspan: 2, scope: 'colgroup', class: 'alm-body' }),
        th('MOON', { colspan: 5, scope: 'colgroup', class: 'alm-body' }),
      ),
      h(
        'tr',
        {},
        th('GHA', { scope: 'col' }),
        th('Dec', { scope: 'col' }),
        th('GHA', { scope: 'col' }),
        th('v', { scope: 'col' }),
        th('Dec', { scope: 'col' }),
        th('d', { scope: 'col' }),
        th('HP', { scope: 'col' }),
      ),
    ),
  );
  const sunShown = decShown(day.hours, (r) => r.sun.printed.dec);
  const moonShown = decShown(day.hours, (r) => r.moon?.printed.dec ?? null);
  for (const block of blocks(day.hours, 6)) {
    const body = h('tbody', {});
    for (const r of block) {
      const tr = h(
        'tr',
        { 'data-hour': r.hour },
        th(String(r.hour).padStart(2, '0'), { scope: 'row', class: 'alm-ut' }),
        ghaCell(r.sun.printed.gha),
        decCell(r.sun.printed.dec, sunShown[r.hour]!),
      );
      if (r.moon) {
        tr.append(
          ghaCell(r.moon.printed.gha, ' alm-gap'),
          numCell(r.moon.printed.v),
          decCell(r.moon.printed.dec, moonShown[r.hour]!),
          numCell(r.moon.printed.d),
          numCell(r.moon.printed.hp),
        );
      } else {
        tr.append(h('td', { colspan: 5, class: 'alm-na' }, 'Moon not available'));
      }
      rows[r.hour] = tr;
      body.append(tr);
    }
    table.append(body);
  }
  table.append(
    h(
      'tfoot',
      {},
      h(
        'tr',
        {},
        h('td', {}, ''),
        h(
          'td',
          { colspan: 2, class: 'alm-footnote' },
          'SD ',
          h('b', {}, day.sun.printed.sd),
          '  d ',
          h('b', {}, day.sun.printed.d),
        ),
        h(
          'td',
          { colspan: 5, class: 'alm-footnote' },
          ...(day.moon ? ['SD ', h('b', {}, day.moon.printed.sd)] : []),
        ),
      ),
    ),
  );
  return table;
}

function latitudeBlocks(
  rows: readonly AlmanacLatitudeRow[],
  cells: (r: AlmanacLatitudeRow) => AlmanacTime[],
): HTMLTableSectionElement[] {
  return blocks(rows, 5).map((block) =>
    h(
      'tbody',
      {},
      ...block.map((r) =>
        h('tr', {}, th(r.label, { scope: 'row', class: 'alm-lat' }), ...cells(r).map(timeCell)),
      ),
    ),
  );
}

function riseTable(day: AlmanacDay): HTMLTableElement {
  const [d0 = '', d1 = ''] = day.rise_set.moon_dates;
  return h(
    'table',
    { class: 'alm-table alm-rise' },
    caption(`Morning twilight, sunrise and moonrise, LMT at the Greenwich meridian, for ${day.date}`),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        th('Lat.', { rowspan: 2, scope: 'col' }),
        th('Twilight', { colspan: 2, scope: 'colgroup' }),
        th('Sunrise', { rowspan: 2, scope: 'col' }),
        th('Moonrise', { colspan: 2, scope: 'colgroup' }),
      ),
      h(
        'tr',
        {},
        th('Naut.', { scope: 'col' }),
        th('Civil', { scope: 'col' }),
        th(dayOfMonth(d0), { scope: 'col', title: d0 }),
        th(dayOfMonth(d1), { scope: 'col', title: d1 }),
      ),
    ),
    ...latitudeBlocks(day.rise_set.rows, (r) => [r.nautical_dawn, r.civil_dawn, r.sunrise, ...r.moonrise]),
  );
}

function setTable(day: AlmanacDay): HTMLTableElement {
  const [d0 = '', d1 = ''] = day.rise_set.moon_dates;
  return h(
    'table',
    { class: 'alm-table alm-rise' },
    caption(`Sunset, evening twilight and moonset, LMT at the Greenwich meridian, for ${day.date}`),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        th('Lat.', { rowspan: 2, scope: 'col' }),
        th('Sunset', { rowspan: 2, scope: 'col' }),
        th('Twilight', { colspan: 2, scope: 'colgroup' }),
        th('Moonset', { colspan: 2, scope: 'colgroup' }),
      ),
      h(
        'tr',
        {},
        th('Civil', { scope: 'col' }),
        th('Naut.', { scope: 'col' }),
        th(dayOfMonth(d0), { scope: 'col', title: d0 }),
        th(dayOfMonth(d1), { scope: 'col', title: d1 }),
      ),
    ),
    ...latitudeBlocks(day.rise_set.rows, (r) => [r.sunset, r.civil_dusk, r.nautical_dusk, ...r.moonset]),
  );
}

function eotCell(seconds: number, printed: string): HTMLTableCellElement {
  const negative = seconds < 0;
  return h(
    'td',
    {
      class: `alm-t${negative ? ' alm-neg' : ''}`,
      title: negative ? 'Negative: the Sun crosses the meridian after 12h' : undefined,
    },
    negative ? '−' : '',
    printed,
  );
}

function sunMoonBox(day: AlmanacDay): HTMLTableElement {
  const m = day.moon;
  const phase = m?.phase
    ? h(
        'span',
        { class: 'alm-phase', title: `${phaseName(m.phase.kind)} at ${m.phase.utc.slice(11, 16)} UT` },
        phaseSymbol(m.phase.kind),
      )
    : null;
  return h(
    'table',
    { class: 'alm-table alm-box alm-sunmoon' },
    caption(`Equation of time, meridian passages, and the Moon's age and phase for ${day.date}`),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        th('Day', { rowspan: 3, scope: 'col' }),
        th('SUN', { colspan: 3, scope: 'colgroup', class: 'alm-body' }),
        th('MOON', { colspan: 4, scope: 'colgroup', class: 'alm-body' }),
      ),
      h(
        'tr',
        {},
        th('Eqn. of Time', { colspan: 2, scope: 'colgroup' }),
        th('Mer. Pass.', { scope: 'col' }),
        th('Mer. Pass.', { colspan: 2, scope: 'colgroup' }),
        th('Age', { scope: 'col' }),
        th('Phase', { scope: 'col' }),
      ),
      h(
        'tr',
        { class: 'alm-units' },
        th('00h', { scope: 'col' }),
        th('12h', { scope: 'col' }),
        th('h m', { scope: 'col' }),
        th('Upper', { scope: 'col' }),
        th('Lower', { scope: 'col' }),
        th('d', { scope: 'col' }),
        th('%', { scope: 'col' }),
      ),
    ),
    h(
      'tbody',
      {},
      h(
        'tr',
        {},
        th(dayOfMonth(day.date), { scope: 'row' }),
        eotCell(day.sun.eot_00h_s, day.sun.printed.eot_00h),
        eotCell(day.sun.eot_12h_s, day.sun.printed.eot_12h),
        timeCell(day.sun.mer_pass),
        ...(m
          ? [
              timeCell(m.mer_pass_upper),
              timeCell(m.mer_pass_lower),
              numCell(m.printed.age),
              h('td', { class: 'alm-n' }, m.printed.illuminated, phase ? ' ' : '', phase),
            ]
          : [h('td', { colspan: 4, class: 'alm-na' }, 'Moon not available')]),
      ),
    ),
  );
}

function notesBox(day: AlmanacDay): HTMLElement {
  return h(
    'div',
    { class: 'alm-notes' },
    h('ul', {}, ...day.notes.map((n) => h('li', {}, n))),
    day.errors.length
      ? h(
          'p',
          { class: 'alm-errors' },
          h('b', {}, 'Not computed: '),
          day.errors.map((e) => `${e.body}: ${e.message}`).join(' · '),
        )
      : null,
  );
}

function rightPage(day: AlmanacDay, rows: HTMLTableRowElement[], mock: boolean): HTMLElement {
  return h(
    'article',
    { class: 'alm-page alm-page-right', 'aria-label': `Right page for ${day.date}: Sun, Moon, twilight, rise and set` },
    pageHeader(day, 'SUN · MOON · TWILIGHT', mock),
    h(
      'div',
      { class: 'alm-grid' },
      h('div', { class: 'alm-main' }, rightHourly(day, rows), sunMoonBox(day), notesBox(day)),
      h('div', { class: 'alm-side' }, riseTable(day), setTable(day)),
    ),
    pageFooter(`Twilight, rise and set: LMT at Greenwich · ${day.weekday} ${day.date}`),
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The coverage as UT dates, for the picker's range. */
function dateRange(start: string, end: string): { min: string; max: string } {
  return { min: start.slice(0, 10), max: end.slice(0, 10) };
}

export const almanacView: Component = (host, ctx) => {
  const d = disposer();
  const engine: AlmanacEngine | null = isAlmanacEngine(ctx.engine) ? ctx.engine : null;
  const mock = ctx.engine.kind === 'mock';

  let range = { min: '1990-01-01', max: '2060-12-31' };
  try {
    const c = ctx.engine.coverage();
    range = dateRange(c.start_utc, c.end_utc);
  } catch {
    // Keep the documented range; the engine will refuse a date it cannot do.
  }

  const dateInput = h('input', {
    type: 'date',
    class: 'alm-date',
    id: 'alm-date',
    min: range.min,
    max: range.max,
    required: true,
  });
  const button = (label: string, title: string): HTMLButtonElement =>
    h('button', { type: 'button', class: 'alm-btn', title }, label);
  const prev = button('◀ Day', 'Previous UT date (same time of day)');
  const next = button('Day ▶', 'Next UT date (same time of day)');
  const today = button('Today', 'Follow the clock: today’s UT date');
  const print = button('Print…', 'Print both pages, black on white, one per sheet (A4 or US Letter)');
  const status = h('p', { class: 'alm-status', role: 'status', 'aria-live': 'polite' });
  const toolbar = h(
    'div',
    { class: 'alm-toolbar' },
    h('h2', { class: 'alm-title' }, 'Nautical almanac', h('span', { class: 'alm-title-sub' }, ' · daily pages')),
    h('label', { class: 'alm-date-label', for: 'alm-date' }, 'UT date'),
    dateInput,
    h('span', { class: 'alm-btn-group' }, prev, today, next),
    print,
    status,
  );
  const spread = h('div', { class: 'alm-spread' });
  const root = h('section', { class: 'almanac', 'aria-label': 'Nautical almanac daily pages' }, toolbar, spread);
  host.append(root);

  // Printing prints this view and nothing around it (almanac.css, `data-print-view`).
  const html = document.documentElement;
  html.dataset.printView = 'almanac';
  d.add(() => {
    if (html.dataset.printView === 'almanac') delete html.dataset.printView;
    root.remove();
  });

  const move = (days: number): void => {
    const jd = ctx.store.get().time.jd_utc;
    setTime(ctx.store, jd + days);
  };
  const onDate = (): void => {
    const jd = moveToUtDate(ctx.store.get().time.jd_utc, dateInput.value);
    if (jd !== null) setTime(ctx.store, jd);
  };
  const onPrint = (): void => window.print();
  const onPrev = (): void => move(-1);
  const onNext = (): void => move(1);
  const onToday = (): void => goNow(ctx.store);
  dateInput.addEventListener('change', onDate);
  prev.addEventListener('click', onPrev);
  next.addEventListener('click', onNext);
  today.addEventListener('click', onToday);
  print.addEventListener('click', onPrint);
  d.add(() => {
    dateInput.removeEventListener('change', onDate);
    prev.removeEventListener('click', onPrev);
    next.removeEventListener('click', onNext);
    today.removeEventListener('click', onToday);
    print.removeEventListener('click', onPrint);
  });

  let shown: string | null = null;
  let hourRows: HTMLTableRowElement[][] = [];
  let lit = -1;

  const render = (date: string): void => {
    shown = date;
    lit = -1;
    hourRows = [];
    if (!engine) {
      spread.replaceChildren(
        h(
          'p',
          { class: 'alm-message', role: 'alert' },
          'This engine cannot make almanac pages (it has no almanacDay). Rebuild the numerical core with: npm run wasm --prefix web',
        ),
      );
      status.textContent = '';
      return;
    }
    let day: AlmanacDay;
    try {
      day = engine.almanacDay(date);
      ctx.notices.dismissKey('almanac');
    } catch (error) {
      const text = `No almanac page for ${date}: ${errorText(error)}`;
      ctx.notices.push('error', text, { key: 'almanac' });
      spread.replaceChildren(h('p', { class: 'alm-message', role: 'alert' }, text));
      status.textContent = '';
      return;
    }
    const left: HTMLTableRowElement[] = [];
    const right: HTMLTableRowElement[] = [];
    spread.replaceChildren(leftPage(day, left, mock), rightPage(day, right, mock));
    hourRows = day.hours.map((r) => [left[r.hour], right[r.hour]].filter((x): x is HTMLTableRowElement => !!x));
    status.textContent = `${pageHeading(day)} · UT`;
  };

  const highlight = (hour: number): void => {
    if (hour === lit) return;
    for (const tr of hourRows[lit] ?? []) tr.classList.remove('alm-now');
    for (const tr of hourRows[hour] ?? []) tr.classList.add('alm-now');
    lit = hour;
  };

  d.add(
    watch(ctx, (s) => s.time.jd_utc, (jd) => {
      const date = utDateOf(jd);
      if (dateInput.value !== date) dateInput.value = date;
      if (date !== shown) render(date);
      highlight(utHourOf(jd));
    }),
  );

  return { destroy: () => d.dispose() };
};
