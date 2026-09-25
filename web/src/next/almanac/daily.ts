/**
 * The daily pages: the printed almanac's three-day opening (almanac2 agent) and the
 * one-date pages (the almanac agent's, moved here from almanac.ts), laid out like the
 * printed Nautical Almanac.
 *
 * - Left page: GHA of Aries and GHA/Dec of Venus, Mars, Jupiter and Saturn for every
 *   hour, their v, d, SHA, magnitude and meridian passage, and the 57 stars plus Polaris.
 * - Right page: GHA/Dec of the Sun and GHA, v, Dec, d, HP of the Moon for every hour, the
 *   twilight, sunrise, sunset, moonrise and moonset tables for 72 N to 60 S, and the
 *   Sun and Moon box (equation of time, meridian passages, the Moon's age and phase).
 *
 * An opening covers three dates: once-per-opening values are the middle date's (the
 * engine's `days[1]`), moonrise and moonset cover the three dates and the next.
 */

import { h } from '../../dom.js';
import type {
  AlmanacDay,
  AlmanacHour,
  AlmanacLatitudeRow,
  AlmanacOpening,
  AlmanacTime,
  BodyError,
} from '../engine/types.js';
import { caption, decCell, ghaCell, numCell, pageFooter, th, timeCell, type Child } from './cells.js';
import { dayHeading, openingHeading, type ShownDate } from './dates.js';
import { blocks, dayOfMonth, phaseName, phaseSymbol, showDecDegrees } from './layout.js';

/** The table rows of each hour, per date, so the view can mark the explorer's hour. */
export type HourRows = HTMLTableRowElement[][][];

export interface RenderedPages {
  pages: HTMLElement[];
  /** `rows[dateIndex][hour]` = the rows of that hour on both pages. */
  rows: HourRows;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Per 6-hour block, which rows show a declination's degrees. */
function decShown(hours: readonly AlmanacHour[], pick: (r: AlmanacHour) => string | null): boolean[] {
  const out: boolean[] = [];
  for (const block of blocks(hours, 6)) out.push(...showDecDegrees(block.map((r) => pick(r) ?? '')));
  return out;
}

function pageHead(heading: string, side: string, extra: Child, mock: boolean): HTMLElement {
  return h(
    'header',
    { class: 'alm-head' },
    h('span', { class: 'alm-head-side' }, side),
    h('h3', { class: 'alm-head-date' }, heading, extra ? ' ' : '', extra),
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

function phaseMark(day: AlmanacDay): HTMLElement | null {
  const p = day.moon?.phase;
  return p
    ? h('span', { class: 'alm-phase', title: `${phaseName(p.kind)} at ${p.utc.slice(-13, -8)} UT` }, phaseSymbol(p.kind))
    : null;
}

function notesBox(notes: readonly string[], errors: readonly BodyError[], extra: readonly string[] = []): HTMLElement {
  return h(
    'div',
    { class: 'alm-notes' },
    h('ul', {}, ...[...extra, ...notes].map((n) => h('li', {}, n))),
    errors.length
      ? h('p', { class: 'alm-errors' }, h('b', {}, 'Not computed: '), errors.map((e) => `${e.body}: ${e.message}`).join(' · '))
      : null,
  );
}

function planetBox(day: AlmanacDay, sha: readonly { body: string; printed: { gha: string } }[] | null, when: string): HTMLTableElement {
  return h(
    'table',
    { class: 'alm-table alm-box alm-planet-box' },
    caption(`The planets' SHA (${when}) and meridian passage at Greenwich`),
    h('thead', {}, h('tr', {}, th('', { scope: 'col' }), th('SHA', { scope: 'col' }), th('Mer. Pass.', { scope: 'col' }))),
    h(
      'tbody',
      {},
      ...day.planets.map((p, i) =>
        h('tr', {}, th(p.body, { scope: 'row' }), ghaCell(sha?.[i]?.printed.gha ?? p.printed.sha), timeCell(p.mer_pass)),
      ),
    ),
  );
}

function starTable(day: AlmanacDay, when: string): HTMLTableElement {
  const table = h(
    'table',
    { class: 'alm-table alm-stars' },
    caption(`SHA and declination of the navigational stars and Polaris at ${when}`),
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
    h(
      'p',
      {},
      h('b', {}, 'Using the pages. '),
      'GHA of a star = GHA Aries + SHA. Between the hours add the increment for the minutes and seconds (the Increments tab: 15° an hour for the Sun and planets, 15° 02.5′ for Aries, 14° 19.0′ for the Moon), then the correction for v; change the declination by the correction for d, in the direction the column is going.',
    ),
    h(
      'p',
      {},
      h('b', {}, 'Mer. Pass. '),
      'is the UT at which the body crosses the Greenwich meridian; for another longitude add 4 minutes for every degree west (subtract for east).',
    ),
  );
}

function riseSetTables(
  rows: readonly AlmanacLatitudeRow[],
  moon: readonly { moonrise: AlmanacTime[]; moonset: AlmanacTime[] }[],
  moonDates: readonly string[],
  moonLabels: readonly string[],
  when: string,
): HTMLTableElement[] {
  const moonHeads = (): HTMLTableCellElement[] =>
    moonLabels.map((label, i) => th(label, { scope: 'col', title: moonDates[i] ?? '' }));
  const body = (cells: (r: AlmanacLatitudeRow, i: number) => AlmanacTime[]): HTMLTableSectionElement[] =>
    blocks(
      rows.map((r, i) => ({ r, i })),
      5,
    ).map((block) =>
      h('tbody', {}, ...block.map(({ r, i }) => h('tr', {}, th(r.label, { scope: 'row', class: 'alm-lat' }), ...cells(r, i).map(timeCell)))),
    );
  const n = moonLabels.length;
  const rise = h(
    'table',
    { class: 'alm-table alm-rise' },
    caption(`Morning twilight and sunrise (${when}) and moonrise, LMT at the Greenwich meridian`),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        th('Lat.', { rowspan: 2, scope: 'col' }),
        th('Twilight', { colspan: 2, scope: 'colgroup' }),
        th('Sunrise', { rowspan: 2, scope: 'col' }),
        th('Moonrise', { colspan: n, scope: 'colgroup' }),
      ),
      h('tr', {}, th('Naut.', { scope: 'col' }), th('Civil', { scope: 'col' }), ...moonHeads()),
    ),
    ...body((r, i) => [r.nautical_dawn, r.civil_dawn, r.sunrise, ...moon[i]!.moonrise]),
  );
  const set = h(
    'table',
    { class: 'alm-table alm-rise' },
    caption(`Sunset and evening twilight (${when}) and moonset, LMT at the Greenwich meridian`),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        th('Lat.', { rowspan: 2, scope: 'col' }),
        th('Sunset', { rowspan: 2, scope: 'col' }),
        th('Twilight', { colspan: 2, scope: 'colgroup' }),
        th('Moonset', { colspan: n, scope: 'colgroup' }),
      ),
      h('tr', {}, th('Civil', { scope: 'col' }), th('Naut.', { scope: 'col' }), ...moonHeads()),
    ),
    ...body((r, i) => [r.sunset, r.civil_dusk, r.nautical_dusk, ...moon[i]!.moonset]),
  );
  return [rise, set];
}

function sunMoonBox(days: readonly AlmanacDay[], labels: readonly string[]): HTMLTableElement {
  return h(
    'table',
    { class: 'alm-table alm-box alm-sunmoon' },
    caption('Equation of time, meridian passages, and the Moon’s age and phase for each date'),
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
      ...days.map((day, i) => {
        const m = day.moon;
        const phase = phaseMark(day);
        return h(
          'tr',
          {},
          th(labels[i] ?? dayOfMonth(day.date), { scope: 'row' }),
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
        );
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Hourly tables for one or three dates
// ---------------------------------------------------------------------------

interface DateBlock {
  day: AlmanacDay;
  /** `7`, the day of the month in the display calendar. */
  dayNumber: string;
  weekday: string;
}

/** One tbody per date: the date's label spans its 24 rows; rows 6, 12, 18 start a block. */
function hourBodies(
  dates: readonly DateBlock[],
  rows: HourRows,
  cells: (r: AlmanacHour, d: DateBlock, shown: (k: string) => boolean[]) => HTMLTableCellElement[],
): HTMLTableSectionElement[] {
  return dates.map((d, di) => {
    const memo = new Map<string, boolean[]>();
    const shown = (k: string): boolean[] => {
      let v = memo.get(k);
      if (!v) {
        v = decShown(d.day.hours, (r) => {
          if (k === 'sun') return r.sun.printed.dec;
          if (k === 'moon') return r.moon?.printed.dec ?? null;
          return r.planets[Number(k)]?.printed.dec ?? null;
        });
        memo.set(k, v);
      }
      return v;
    };
    const body = h('tbody', { class: 'alm-day' });
    for (const r of d.day.hours) {
      const tr = h('tr', { 'data-hour': r.hour, class: r.hour > 0 && r.hour % 6 === 0 ? 'alm-block' : undefined });
      if (dates.length > 1 && r.hour === 0) {
        tr.append(
          th(h('span', {}, h('b', {}, d.dayNumber), ' ', d.weekday), {
            rowspan: 24,
            scope: 'rowgroup',
            class: 'alm-daylabel',
          }),
        );
      }
      tr.append(th(String(r.hour).padStart(2, '0'), { scope: 'row', class: 'alm-ut' }), ...cells(r, d, shown));
      ((rows[di] ??= [])[r.hour] ??= []).push(tr);
      body.append(tr);
    }
    return body;
  });
}

function leftHourly(dates: readonly DateBlock[], middle: AlmanacDay, rows: HourRows): HTMLTableElement {
  const multi = dates.length > 1;
  const head1 = h('tr', {});
  if (multi) head1.append(th('', { rowspan: 2, scope: 'col', class: 'alm-daylabel-head' }));
  head1.append(th('UT', { rowspan: 2, scope: 'col', class: 'alm-ut' }), th('ARIES', { scope: 'col' }));
  const head2 = h('tr', {}, th('GHA', { scope: 'col' }));
  for (const p of middle.planets) {
    head1.append(
      th(h('span', {}, p.body.toUpperCase(), ' ', h('span', { class: 'alm-mag' }, p.printed.magnitude)), {
        colspan: 2,
        scope: 'colgroup',
        class: 'alm-body',
      }),
    );
    head2.append(th('GHA', { scope: 'col' }), th('Dec', { scope: 'col' }));
  }
  const table = h(
    'table',
    { class: `alm-table alm-hourly alm-hourly-left${multi ? ' alm-multi' : ''}` },
    caption(`GHA of Aries, and GHA and declination of the planets, every hour of ${dates.map((d) => d.day.date).join(', ')} UT`),
    h('thead', {}, head1, head2),
    ...hourBodies(
      dates,
      rows,
      (r, _d, shown) => {
        const out = [ghaCell(r.aries.printed.gha)];
        r.planets.forEach((p, i) => out.push(ghaCell(p.printed.gha, ' alm-gap'), decCell(p.printed.dec, shown(String(i))[r.hour]!)));
        return out;
      },
    ),
  );
  const foot = h('tr', {}, h('td', { colspan: multi ? 3 : 2, class: 'alm-footnote' }, 'Mer. Pass. ', h('b', {}, middle.aries.mer_pass.printed)));
  for (const p of middle.planets) {
    foot.append(h('td', { colspan: 2, class: 'alm-footnote' }, 'v ', h('b', {}, p.printed.v), '  d ', h('b', {}, p.printed.d)));
  }
  table.append(h('tfoot', {}, foot));
  return table;
}

function rightHourly(dates: readonly DateBlock[], middle: AlmanacDay, rows: HourRows): HTMLTableElement {
  const multi = dates.length > 1;
  const head1 = h('tr', {});
  if (multi) head1.append(th('', { rowspan: 2, scope: 'col', class: 'alm-daylabel-head' }));
  head1.append(
    th('UT', { rowspan: 2, scope: 'col', class: 'alm-ut' }),
    th('SUN', { colspan: 2, scope: 'colgroup', class: 'alm-body' }),
    th('MOON', { colspan: 5, scope: 'colgroup', class: 'alm-body' }),
  );
  const table = h(
    'table',
    { class: `alm-table alm-hourly alm-hourly-right${multi ? ' alm-multi' : ''}` },
    caption(`GHA and declination of the Sun, and GHA, v, declination, d and HP of the Moon, every hour of ${dates.map((d) => d.day.date).join(', ')} UT`),
    h(
      'thead',
      {},
      head1,
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
    ...hourBodies(
      dates,
      rows,
      (r, _d, shown) => {
        const out = [ghaCell(r.sun.printed.gha), decCell(r.sun.printed.dec, shown('sun')[r.hour]!)];
        if (r.moon) {
          out.push(
            ghaCell(r.moon.printed.gha, ' alm-gap'),
            numCell(r.moon.printed.v),
            decCell(r.moon.printed.dec, shown('moon')[r.hour]!),
            numCell(r.moon.printed.d),
            numCell(r.moon.printed.hp),
          );
        } else {
          out.push(h('td', { colspan: 5, class: 'alm-na' }, 'Moon not available'));
        }
        return out;
      },
    ),
  );
  const moonSd = dates.map((d) => d.day.moon?.printed.sd).filter((x): x is string => !!x);
  table.append(
    h(
      'tfoot',
      {},
      h(
        'tr',
        {},
        h('td', { colspan: multi ? 2 : 1 }, ''),
        h('td', { colspan: 2, class: 'alm-footnote' }, 'SD ', h('b', {}, middle.sun.printed.sd), '  d ', h('b', {}, middle.sun.printed.d)),
        h('td', { colspan: 5, class: 'alm-footnote' }, ...(moonSd.length ? ['SD ', h('b', {}, moonSd.join('  '))] : [])),
      ),
    ),
  );
  return table;
}

// ---------------------------------------------------------------------------
// The two kinds of spread
// ---------------------------------------------------------------------------

/** The printed almanac's opening: three dates on two facing pages. */
export function openingPages(o: AlmanacOpening, extraNotes: readonly string[], headExtra: Child, mock: boolean): RenderedPages {
  const heading = openingHeading(o.dates);
  const dates: DateBlock[] = o.days.map((day, i) => ({
    day,
    dayNumber: String(o.dates[i]?.day ?? dayOfMonth(day.date)),
    weekday: o.dates[i]?.weekday ?? day.weekday,
  }));
  const middle = o.days[1]!;
  const rows: HourRows = [];
  const labels = o.dates.map((d) => String(d.day));
  const moonLabels = o.moon_days.map((d) => String(d.day));
  const left = h(
    'article',
    { class: 'alm-page alm-page-left alm-opening', 'aria-label': `Left page for ${heading}: Aries, planets, stars` },
    pageHead(heading, 'ARIES · PLANETS · STARS', headExtra, mock),
    h(
      'div',
      { class: 'alm-grid' },
      h('div', { class: 'alm-main' }, leftHourly(dates, middle, rows), explainBox()),
      h('div', { class: 'alm-side' }, starTable(middle, `12h UT on ${middle.date}`), planetBox(middle, o.planet_sha_00h, `0h UT on ${middle.date}`)),
    ),
    pageFooter(`Stars, planets' SHA, v, d and Mer. Pass. for the middle date · ${heading}`),
  );
  const right = h(
    'article',
    { class: 'alm-page alm-page-right alm-opening', 'aria-label': `Right page for ${heading}: Sun, Moon, twilight, rise and set` },
    pageHead(heading, 'SUN · MOON · TWILIGHT', headExtra, mock),
    h(
      'div',
      { class: 'alm-grid' },
      h('div', { class: 'alm-main' }, rightHourly(dates, middle, rows)),
      h(
        'div',
        { class: 'alm-side' },
        ...riseSetTables(middle.rise_set.rows, o.moon_rows, o.moon_dates, moonLabels, `the middle date, ${middle.date}`),
        sunMoonBox(o.days, labels),
      ),
    ),
    notesBox(o.notes, o.errors, extraNotes),
    pageFooter(`Twilight and sunrise for the middle date; moonrise for four dates · LMT at Greenwich · ${heading}`),
  );
  return { pages: [left, right], rows };
}

/** One date on two facing pages (the almanac agent's layout). */
export function oneDayPages(day: AlmanacDay, shown: ShownDate, extraNotes: readonly string[], headExtra: Child, mock: boolean): RenderedPages {
  const heading = dayHeading(shown, day.weekday);
  const dates: DateBlock[] = [{ day, dayNumber: String(shown.day), weekday: day.weekday }];
  const rows: HourRows = [];
  const labels = day.rise_set.moon_dates.map((wire, i) => (i === 0 ? String(shown.day) : dayOfMonth(wire)));
  const left = h(
    'article',
    { class: 'alm-page alm-page-left', 'aria-label': `Left page for ${day.date}: Aries, planets, stars` },
    pageHead(heading, 'ARIES · PLANETS · STARS', headExtra, mock),
    h(
      'div',
      { class: 'alm-grid' },
      h('div', { class: 'alm-main' }, leftHourly(dates, day, rows), planetBox(day, null, `12h UT on ${day.date}`), explainBox()),
      h('div', { class: 'alm-side' }, starTable(day, `12h UT on ${day.date}`)),
    ),
    pageFooter(`Stars and SHA at 12h UT · ${day.weekday} ${day.date}`),
  );
  const right = h(
    'article',
    { class: 'alm-page alm-page-right', 'aria-label': `Right page for ${day.date}: Sun, Moon, twilight, rise and set` },
    pageHead(heading, 'SUN · MOON · TWILIGHT', headExtra, mock),
    h(
      'div',
      { class: 'alm-grid' },
      h('div', { class: 'alm-main' }, rightHourly(dates, day, rows), sunMoonBox([day], [String(shown.day)]), notesBox(day.notes, day.errors, extraNotes)),
      h(
        'div',
        { class: 'alm-side' },
        ...riseSetTables(
          day.rise_set.rows,
          day.rise_set.rows.map((r) => ({ moonrise: r.moonrise, moonset: r.moonset })),
          day.rise_set.moon_dates,
          labels,
          day.date,
        ),
      ),
    ),
    pageFooter(`Twilight, rise and set: LMT at Greenwich · ${day.weekday} ${day.date}`),
  );
  return { pages: [left, right], rows };
}
