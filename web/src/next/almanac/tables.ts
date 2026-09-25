/**
 * The Almanac view's tables as printed sheets (almanac2 agent): Increments and
 * Corrections, the Altitude Correction Tables (Sun, stars and planets 10°–90°, 0°–10°,
 * dip, non-standard conditions with the zone chart, Venus and Mars, the Moon's two-part
 * table), the Polaris tables and Conversion of Arc to Time. Each sheet is one printed
 * page (A4 or US Letter, black on white) and also the screen view, themed.
 *
 * Every number is the engine's `printed` text; the layout is the printed Nautical
 * Almanac's. The decisions (rows, pages, look-ups) are the pure helpers of
 * tables-model.ts; this file only builds elements.
 */

import { h, s } from '../../dom.js';
import type {
  AltitudeTables,
  ArcToTime,
  CriticalTable,
  IncrementsMinute,
  MoonCorrectionColumn,
  PlanetCorrections,
  PolarisTable,
  RefractionZone,
} from '../engine/types.js';
import { caption, howTo, notesList, sheet, th, type Child } from './cells.js';
import { MONTHS, yearText } from './dates.js';
import {
  ARC_RANGES,
  criticalLines,
  halves,
  moonPageColumns,
  pageMinutes,
  polarisPageColumns,
  trimZeroTail,
  vdPairs,
  zonePressure,
} from './tables-model.js';

const MONTH_ABBR = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];

function td(text: Child, cls?: string): HTMLTableCellElement {
  return h('td', { class: cls }, text);
}

/** `0 14.3` as degrees and minutes aligned on the point. */
function degMin(printed: string, cls = 'alm-a'): HTMLTableCellElement {
  const [d = '', m = ''] = printed.split(' ');
  return h('td', { class: cls }, h('span', { class: 'alm-deg' }, d), h('span', { class: 'alm-min' }, m));
}

// ---------------------------------------------------------------------------
// Critical tables
// ---------------------------------------------------------------------------

/**
 * A critical table as the printed almanac sets it: boundaries on the lines, each
 * correction on the half-line between its two boundaries.
 */
export function criticalTableEl(t: CriticalTable, title: string, units: string[], extraClass = ''): HTMLTableElement {
  const lines = criticalLines(t);
  return h(
    'table',
    { class: `alm-table alm-crit ${extraClass}`.trim() },
    caption(`${title}: a critical table; between two arguments take the correction beside them, exactly on one the correction above it`),
    h(
      'thead',
      {},
      h('tr', {}, th(t.unit === 'm' || t.unit === 'ft' ? 'Ht. of Eye' : 'App. Alt.', { scope: 'col' }), ...t.columns.map((c) => th(c, { scope: 'col' }))),
      h('tr', { class: 'alm-units' }, ...units.map((u) => th(u, { scope: 'col' }))),
    ),
    h(
      'tbody',
      {},
      ...lines.map((line) =>
        h(
          'tr',
          { 'aria-label': line.label },
          th(line.boundary, { scope: 'row', class: 'alm-crit-arg' }),
          ...(line.values ? line.values.map((v) => td(h('span', {}, v), 'alm-crit-v')) : t.columns.map(() => td('', 'alm-crit-v'))),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Increments and Corrections
// ---------------------------------------------------------------------------

function minuteTable(t: IncrementsMinute, highlight: number | null): HTMLTableElement {
  const table = h(
    'table',
    { class: 'alm-table alm-inc', 'data-minute': t.minute },
    caption(`Increments and corrections for ${t.minute} minutes of time: seconds 00 to 60`),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        th(h('b', {}, `${t.minute}`, h('sup', {}, 'm')), { rowspan: 2, scope: 'col', class: 'alm-inc-min' }),
        th(h('span', {}, 'SUN', h('br'), 'PLANETS'), { scope: 'col' }),
        th('ARIES', { scope: 'col' }),
        th('MOON', { scope: 'col' }),
        ...[0, 1, 2].map(() => th(h('span', {}, 'v or d', h('br'), 'Corr'), { colspan: 2, scope: 'colgroup', class: 'alm-gap' })),
      ),
      h(
        'tr',
        { class: 'alm-units' },
        th('° ′', { scope: 'col' }),
        th('° ′', { scope: 'col' }),
        th('° ′', { scope: 'col' }),
        ...[0, 1, 2].flatMap(() => [th('′', { scope: 'col', class: 'alm-gap' }), th('′', { scope: 'col' })]),
      ),
    ),
  );
  for (let start = 0; start <= 60; start += 5) {
    const body = h('tbody', {});
    for (let sec = start; sec < Math.min(start + 5, 61); sec += 1) {
      const r = t.rows[sec]!;
      const tr = h(
        'tr',
        { 'data-second': sec, class: sec === highlight ? 'alm-now' : undefined },
        th(String(sec).padStart(2, '0'), { scope: 'row', class: 'alm-ut' }),
        degMin(r.sun_planets.printed),
        degMin(r.aries.printed),
        degMin(r.moon.printed),
      );
      for (const [v, c] of vdPairs(t, sec)) tr.append(td(v, 'alm-n alm-gap alm-vd'), td(c, 'alm-n'));
      body.append(tr);
    }
    table.append(body);
  }
  return table;
}

/** One printed page of increments: two minutes side by side. */
export function incrementsSheet(
  pair: [IncrementsMinute, IncrementsMinute],
  highlight: { minute: number; second: number } | null,
  withHelp: boolean,
  mock: boolean,
): HTMLElement {
  const [a, b] = pair;
  const hl = (t: IncrementsMinute): number | null => (highlight && highlight.minute === t.minute ? highlight.second : null);
  return sheet(
    {
      heading: `${a.minute}m – ${b.minute}m`,
      side: 'INCREMENTS AND CORRECTIONS',
      label: `Increments and corrections for ${a.minute} and ${b.minute} minutes`,
      footer: `Increments for 0–60 seconds after ${a.minute}m and ${b.minute}m · v or d corrections for the middle of the minute`,
      mock,
      extraClass: 'alm-sheet alm-inc-sheet',
    },
    h('div', { class: 'alm-inc-grid' }, minuteTable(a, hl(a)), minuteTable(b, hl(b))),
    withHelp ? howTo(a.how_to_use, [{ title: 'Example', text: a.example }]) : null,
  );
}

/** The minutes of a printed page, for the 30-page print. */
export function incrementsPageMinutes(page: number): [number, number] {
  return pageMinutes(page);
}

// ---------------------------------------------------------------------------
// Altitude correction tables
// ---------------------------------------------------------------------------

/**
 * The additional correction for Venus or Mars through the year: one row per run of dates,
 * each a critical table read across (the altitudes, with the correction printed between
 * the two it holds for), ending where the correction becomes 0.0. Across rather than down
 * so that the busiest year (fifteen runs, 2018) still fits page A2.
 */
function planetTable(pc: PlanetCorrections | null, body: 'venus' | 'mars'): HTMLElement {
  const name = body === 'venus' ? 'Venus' : 'Mars';
  if (!pc) return h('p', { class: 'alm-na' }, `${name}: not available in this engine`);
  const periods = pc[body];
  if (!periods.length) return h('p', { class: 'alm-na' }, `${name}: not computed for ${yearText(pc.year)}`);
  const rows = periods.map((p) => ({
    range: `${MONTH_ABBR[p.from.month - 1]} ${p.from.day} – ${MONTH_ABBR[p.to.month - 1]} ${p.to.day}`,
    lines: trimZeroTail(criticalLines(p.table)),
  }));
  const width = Math.max(...rows.map((r) => r.lines.length * 2 - 1));
  return h(
    'table',
    { class: 'alm-table alm-planet-corr' },
    caption(`${name}, ${yearText(pc.year)}: the additional correction for each run of dates. Between two apparent altitudes add the correction printed between them; above the last, 0.0′`),
    h(
      'thead',
      {},
      h('tr', {}, th(name.toUpperCase(), { scope: 'col', class: 'alm-body' }), th('App. Alt. and correction', { scope: 'colgroup', colspan: width, class: 'alm-pc-head' })),
    ),
    h(
      'tbody',
      {},
      ...rows.map((r) =>
        h(
          'tr',
          { 'aria-label': `${r.range}: ${r.lines.map((l) => l.label).join('; ')}` },
          th(r.range, { scope: 'row', class: 'alm-pc-range' }),
          ...r.lines.flatMap((l) => [td(`${l.boundary}°`, 'alm-pc-arg'), ...(l.values ? [td(l.values[0] ?? '', 'alm-pc-v')] : [])]),
        ),
      ),
    ),
  );
}

function dipMore(rows: { printed_height: string; dip: { printed: string } }[], unit: string): HTMLTableElement {
  return h(
    'table',
    { class: 'alm-table alm-dip-more' },
    caption(`Dip for more heights of eye in ${unit}`),
    h('thead', {}, h('tr', {}, th(unit, { scope: 'col' }), th('Dip', { scope: 'col' }))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, th(r.printed_height, { scope: 'row' }), td(r.dip.printed, 'alm-n')))),
  );
}

/** The engine's worked examples for a sheet: the Moon's go with the Moon's table. */
function examplesFor(t: AltitudeTables, moon: boolean): { title: string; text: string }[] {
  return t.examples.filter((e) => /moon/i.test(e.title) === moon);
}

function a2Sheet(t: AltitudeTables, pc: PlanetCorrections | null, mock: boolean): HTMLElement {
  const year = pc ? yearText(pc.year) : '';
  return sheet(
    {
      heading: 'ALTITUDE CORRECTION TABLES 10°–90° — SUN, STARS, PLANETS',
      side: 'A2',
      right: 'DIP',
      label: 'Altitude correction tables, 10 to 90 degrees: Sun, stars, planets, and dip',
      footer: `Refraction ${t.refraction.model} at ${t.refraction.pressure_hpa} hPa and ${t.refraction.temperature_c} °C · Sun SD ${t.sun_sd_oct_mar_arcmin}′ Oct–Mar, ${t.sun_sd_apr_sep_arcmin}′ Apr–Sep`,
      mock,
      extraClass: 'alm-sheet alm-alt-sheet alm-a2-sheet',
    },
    // Laid out as the printed page A2: the three critical tables and dip across the top,
    // Venus and Mars under the tables they correct, more heights of eye under dip.
    h(
      'div',
      { class: 'alm-a2' },
      h('div', { class: 'alm-crit-col alm-a2-sun1' }, h('h4', {}, 'SUN · OCT.–MAR.'), criticalTableEl(t.sun_oct_mar, 'Sun, October to March', ['° ′', '′', '′'])),
      h('div', { class: 'alm-crit-col alm-a2-sun2' }, h('h4', {}, 'SUN · APR.–SEPT.'), criticalTableEl(t.sun_apr_sep, 'Sun, April to September', ['° ′', '′', '′'])),
      h('div', { class: 'alm-crit-col alm-a2-stars' }, h('h4', {}, 'STARS AND PLANETS'), criticalTableEl(t.stars_planets, 'Stars and planets', ['° ′', '′'])),
      h(
        'div',
        { class: 'alm-crit-col alm-a2-dip' },
        h('h4', {}, 'DIP'),
        h(
          'div',
          { class: 'alm-dip-pair' },
          criticalTableEl(t.dip.metres, 'Dip, height of eye in metres', ['m', '′']),
          criticalTableEl(t.dip.feet, 'Dip, height of eye in feet', ['ft', '′']),
        ),
      ),
      h(
        'div',
        { class: 'alm-a2-add' },
        h('h4', {}, `ADDITIONAL CORRECTIONS FOR VENUS AND MARS${year ? `, ${year}` : ''}`),
        h('div', { class: 'alm-a2-planets' }, planetTable(pc, 'venus'), planetTable(pc, 'mars')),
      ),
      h(
        'div',
        { class: 'alm-a2-dipmore' },
        h('h4', {}, 'DIP · OTHER HEIGHTS'),
        h('div', { class: 'alm-dip-pair' }, dipMore(t.dip.more_metres, 'm'), dipMore(t.dip.more_feet, 'ft')),
      ),
    ),
    howTo(t.how_to_use, examplesFor(t, false)),
    notesList(t.notes),
  );
}

function a3Sheet(t: AltitudeTables, mock: boolean): HTMLElement {
  const table = (rows: AltitudeTables['low']): HTMLTableElement =>
    h(
      'table',
      { class: 'alm-table alm-low' },
      caption('Altitude corrections from 0° to 10°: interpolate between rows'),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          th('App. Alt.', { rowspan: 2, scope: 'col' }),
          th('SUN Oct.–Mar.', { colspan: 2, scope: 'colgroup' }),
          th('SUN Apr.–Sept.', { colspan: 2, scope: 'colgroup' }),
          th(h('span', {}, 'STARS', h('br'), 'PLANETS'), { rowspan: 2, scope: 'col' }),
        ),
        h('tr', {}, th('Lower', { scope: 'col' }), th('Upper', { scope: 'col' }), th('Lower', { scope: 'col' }), th('Upper', { scope: 'col' })),
      ),
      h(
        'tbody',
        {},
        ...rows.map((r) =>
          h(
            'tr',
            {},
            th(r.printed_alt, { scope: 'row', class: 'alm-a' }),
            td(r.sun_oct_mar[0].printed, 'alm-n'),
            td(r.sun_oct_mar[1].printed, 'alm-n'),
            td(r.sun_apr_sep[0].printed, 'alm-n alm-gap'),
            td(r.sun_apr_sep[1].printed, 'alm-n'),
            td(r.stars_planets.printed, 'alm-n alm-gap'),
          ),
        ),
      ),
    );
  const [first, second] = halves(t.low);
  return sheet(
    {
      heading: 'ALTITUDE CORRECTION TABLES 0°–10° — SUN, STARS, PLANETS',
      side: 'A3',
      label: 'Altitude correction tables, 0 to 10 degrees',
      footer: 'Every 3′ to 1° 30′, every 5′ to 6°, every 10′ to 10°: interpolate between rows',
      mock,
      extraClass: 'alm-sheet alm-alt-sheet',
    },
    h('div', { class: 'alm-low-grid' }, table(first), table(second)),
    howTo(
      'For low altitudes, correct the sextant altitude for index error and dip, then enter this table with the apparent altitude, interpolating between rows; in unusual temperature or pressure add the correction of page A4.',
    ),
  );
}

/** The zone chart: temperature across, pressure up, the zones' boundaries as lines. */
function zoneChart(zones: readonly RefractionZone[], chart: AltitudeTables['additional']['chart']): SVGElement {
  const [t0, t1] = chart.temperature_c;
  const [p0, p1] = chart.pressure_hpa;
  const W = 540;
  const H = 200;
  const left = 46;
  const bottom = 28;
  const top = 22;
  const right = 46;
  const x = (t: number): number => left + ((t - t0) / (t1 - t0)) * (W - left - right);
  const y = (p: number): number => H - bottom - ((p - p0) / (p1 - p0)) * (H - bottom - top);
  const clipId = `alm-zone-clip-${Math.random().toString(36).slice(2, 8)}`;
  const lines: SVGElement[] = [];
  const bounds = [...new Set(zones.flatMap((z) => [z.factor_low, z.factor_high]).map((f) => f.toFixed(4)))].map(Number);
  for (const f of bounds) {
    lines.push(s('line', { x1: x(t0), y1: y(zonePressure(f, t0)), x2: x(t1), y2: y(zonePressure(f, t1)), class: 'alm-zone-line' }));
  }
  const labels = zones
    .map((z) => {
      // Place each letter where its band crosses the middle of the chart, if it does.
      for (const t of [10, 0, 20, -10, 30, 35, -15]) {
        const p = zonePressure(z.factor, t);
        if (p > p0 + 4 && p < p1 - 4) return s('text', { x: x(t), y: y(p) + 4, class: 'alm-zone-letter', 'text-anchor': 'middle' }, z.letter);
      }
      return null;
    })
    .filter((e): e is SVGElement => !!e);
  const ticksT = [-20, -10, 0, 10, 20, 30, 40].filter((t) => t >= t0 && t <= t1);
  const ticksP = [970, 990, 1010, 1030, 1050].filter((p) => p >= p0 && p <= p1);
  return s(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'alm-zone-chart', role: 'img', 'aria-label': 'Zone chart: find the zone letter where your temperature and pressure meet' },
    s('title', {}, 'Zones of equal air density, by temperature and pressure'),
    s('defs', {}, s('clipPath', { id: clipId }, s('rect', { x: left, y: top, width: W - left - right, height: H - top - bottom }))),
    s('rect', { x: left, y: top, width: W - left - right, height: H - top - bottom, class: 'alm-zone-frame' }),
    s('g', { 'clip-path': `url(#${clipId})` }, ...lines, ...labels),
    ...ticksT.flatMap((t) => [
      s('line', { x1: x(t), y1: H - bottom, x2: x(t), y2: H - bottom + 4, class: 'alm-zone-tick' }),
      s('text', { x: x(t), y: H - bottom + 15, class: 'alm-zone-axis', 'text-anchor': 'middle' }, `${t} °C`),
      s('text', { x: x(t), y: top - 7, class: 'alm-zone-axis', 'text-anchor': 'middle' }, `${Math.round(t * 1.8 + 32)} °F`),
    ]),
    ...ticksP.flatMap((p) => [
      s('line', { x1: left - 4, y1: y(p), x2: left, y2: y(p), class: 'alm-zone-tick' }),
      s('text', { x: left - 6, y: y(p) + 3, class: 'alm-zone-axis', 'text-anchor': 'end' }, `${p}`),
      s('text', { x: W - right + 6, y: y(p) + 3, class: 'alm-zone-axis', 'text-anchor': 'start' }, `${(p / 33.863889).toFixed(2)}`),
    ]),
    s('text', { x: 4, y: top + 6, class: 'alm-zone-axis' }, 'hPa'),
    s('text', { x: W - 4, y: top + 6, class: 'alm-zone-axis', 'text-anchor': 'end' }, 'inHg'),
  );
}

function a4Sheet(t: AltitudeTables, mock: boolean): HTMLElement {
  const a = t.additional;
  return sheet(
    {
      heading: 'ADDITIONAL REFRACTION CORRECTIONS FOR NON-STANDARD CONDITIONS',
      side: 'A4',
      label: 'Additional corrections for non-standard temperature and pressure',
      footer: 'Zones of equal air density f = (P/1010) × 283/(273 + T), each 0.02 wide; zone G is standard (10 °C, 1010 hPa)',
      mock,
      extraClass: 'alm-sheet alm-alt-sheet',
    },
    zoneChart(a.zones, a.chart),
    h(
      'table',
      { class: 'alm-table alm-zones' },
      caption('Additional corrections, arcminutes, by apparent altitude and zone'),
      h(
        'thead',
        {},
        h('tr', {}, th('App. Alt.', { scope: 'col' }), ...a.zones.map((z) => th(z.letter, { scope: 'col', title: `density ${z.factor.toFixed(2)}` }))),
      ),
      h(
        'tbody',
        {},
        ...a.rows.map((r) =>
          h('tr', {}, th(r.printed_alt, { scope: 'row', class: 'alm-a' }), ...r.corrections.map((c) => td(c.printed, 'alm-n'))),
        ),
      ),
    ),
    howTo(
      'Find the zone letter where the air temperature and the pressure meet on the chart. In that column, on the row of the apparent altitude (interpolating between rows, not between columns), read the correction and add it to the apparent altitude, as well as the main correction.',
      [{ title: 'Example', text: 'Bowditch (2019) §1907: at 88 °F and 982 hPa the chart gives zone M; at an apparent altitude of 6° 29.7′, between the 6° and 7° rows of column M, the additional correction is +0.8′.' }],
    ),
  );
}

function moonSheet(t: AltitudeTables['moon'], page: 0 | 1, mock: boolean, moonExamples: { title: string; text: string }[] = []): HTMLElement {
  const cols = moonPageColumns(t, page);
  const upperRows: HTMLTableSectionElement[] = [];
  for (let d = 0; d < 5; d += 1) {
    const body = h('tbody', {});
    body.append(
      h('tr', { class: 'alm-moon-deg' }, th('', { scope: 'row' }), ...cols.map((c) => th(`${c.from_deg + d}°`, { scope: 'col' })), th('', { scope: 'row' })),
    );
    for (let m = 0; m < 6; m += 1) {
      const label = String(m * 10).padStart(2, '0');
      body.append(
        h(
          'tr',
          {},
          th(label, { scope: 'row', class: 'alm-ut' }),
          ...cols.map((c) => td(c.upper[d * 6 + m]!.printed, 'alm-n')),
          th(label, { scope: 'row', class: 'alm-ut' }),
        ),
      );
    }
    upperRows.push(body);
  }
  const lower = h(
    'tbody',
    { class: 'alm-moon-lower' },
    h('tr', { class: 'alm-units' }, th('HP', { scope: 'col' }), ...cols.flatMap(() => [th('L', { scope: 'col' }), th('U', { scope: 'col' })]), th('HP', { scope: 'col' })),
    ...t.hp_rows.map((hp, k) =>
      h(
        'tr',
        { class: k % 3 === 0 && k > 0 ? 'alm-block' : undefined },
        th(hp.toFixed(1), { scope: 'row', class: 'alm-ut' }),
        ...cols.flatMap((c: MoonCorrectionColumn) => [td(c.lower_limb[k]!.printed, 'alm-n alm-gap'), td(c.upper_limb[k]!.printed, 'alm-n')]),
        th(hp.toFixed(1), { scope: 'row', class: 'alm-ut' }),
      ),
    ),
  );
  const first = cols[0]!.from_deg;
  const last = cols[cols.length - 1]!.from_deg + 4;
  return sheet(
    {
      heading: `ALTITUDE CORRECTION TABLES ${first}°–${last + 1}° — MOON`,
      side: page === 0 ? 'MOON · I' : 'MOON · II',
      label: `The Moon's altitude corrections, ${first} to ${last} degrees`,
      footer: `Upper part at HP ${t.hp0_arcmin}′, every 10′ of apparent altitude; lower part at the middle of each 5° column · subtract 30′ for the upper limb`,
      mock,
      extraClass: 'alm-sheet alm-moon-sheet',
    },
    h(
      'table',
      { class: 'alm-table alm-moon' },
      caption(`The Moon's altitude correction, ${first}° to ${last}°: upper part by apparent altitude, lower part by horizontal parallax`),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          th('App. Alt.', { scope: 'col' }),
          ...cols.map((c) => th(`${c.from_deg}°–${c.from_deg + 4}°`, { scope: 'col', colspan: 1 })),
          th('App. Alt.', { scope: 'col' }),
        ),
        h('tr', { class: 'alm-units' }, th('′', { scope: 'col' }), ...cols.map(() => th('Corr′', { scope: 'col' })), th('′', { scope: 'col' })),
      ),
      ...upperRows,
    ),
    h(
      'table',
      { class: 'alm-table alm-moon alm-moon-hp' },
      caption('The second correction, by horizontal parallax, lower limb (L) and upper limb (U), in the same column'),
      h('thead', {}, h('tr', {}, th('', { scope: 'col' }), ...cols.map((c) => th(`${c.from_deg}°–${c.from_deg + 4}°`, { colspan: 2, scope: 'colgroup' })), th('', { scope: 'col' }))),
      lower,
    ),
    page === 0 ? howTo(t.how_to_use, moonExamples) : notesList(t.notes),
  );
}

/** The altitude correction pages: A2, A3, A4 and the Moon's two. */
export function altitudeSheets(t: AltitudeTables, pc: PlanetCorrections | null, mock: boolean): HTMLElement[] {
  return [a2Sheet(t, pc, mock), a3Sheet(t, mock), a4Sheet(t, mock), moonSheet(t.moon, 0, mock, examplesFor(t, true)), moonSheet(t.moon, 1, mock)];
}

// ---------------------------------------------------------------------------
// Polaris
// ---------------------------------------------------------------------------

function polarisSheet(t: PolarisTable, page: 0 | 1 | 2, mock: boolean): HTMLElement {
  const cols = polarisPageColumns(t, page);
  const group = (
    label: string,
    columnLabel: string,
    rows: { head: string; cells: (c: PolarisTable['columns'][number]) => string }[],
    cls: string,
  ): HTMLTableSectionElement =>
    h(
      'tbody',
      { class: cls },
      h('tr', { class: 'alm-pol-group' }, th(label, { scope: 'rowgroup' }), ...cols.map(() => th(columnLabel, { scope: 'col' }))),
      ...rows.map((r, i) =>
        h('tr', { class: i > 0 && i % 5 === 0 ? 'alm-block' : undefined }, th(r.head, { scope: 'row', class: 'alm-ut' }), ...cols.map((c) => td(r.cells(c), 'alm-n'))),
      ),
    );
  const first = cols[0]!.from_deg;
  return sheet(
    {
      heading: `POLARIS (POLE STAR) TABLES, ${yearText(t.year)}`,
      side: 'FOR LATITUDE AND AZIMUTH',
      right: `LHA ARIES ${first}°–${first + 119}°`,
      label: `Polaris tables for ${yearText(t.year)}, LHA Aries ${first} to ${first + 119} degrees`,
      footer: `Mean position SHA ${t.printed_mean.sha}, Dec ${t.printed_mean.dec} · formula error ${t.formula_error_arcmin.toFixed(3)}′ · Latitude = Ho − 1° + a₀ + a₁ + a₂`,
      mock,
      extraClass: 'alm-sheet alm-pol-sheet',
    },
    t.warnings.length ? h('p', { class: 'alm-warning', role: 'note' }, t.warnings.join(' ')) : null,
    h(
      'table',
      { class: 'alm-table alm-polaris-table' },
      caption(`Polaris a0, a1, a2 and azimuth for LHA Aries ${first}° to ${first + 119}°`),
      h(
        'thead',
        {},
        h('tr', {}, th(h('span', {}, 'LHA', h('br'), 'ARIES'), { scope: 'col' }), ...cols.map((c) => th(`${c.from_deg}°–${c.from_deg + 9}°`, { scope: 'col' }))),
      ),
      group(
        'LHA',
        'a₀',
        Array.from({ length: 11 }, (_, r) => ({ head: String(r), cells: (c) => c.a0[r]!.printed })),
        'alm-pol-a0',
      ),
      group(
        'Lat.',
        'a₁',
        t.a1_latitudes.map((lat, i) => ({ head: `${lat}`, cells: (c) => c.a1[i]!.printed })),
        'alm-pol-a1',
      ),
      group(
        'Month',
        'a₂',
        MONTHS.map((m, i) => ({ head: MONTH_ABBR[i] ?? m, cells: (c) => c.a2[i]!.printed })),
        'alm-pol-a2',
      ),
      group(
        'Lat.',
        'Azimuth °',
        t.azimuth_latitudes.map((lat, i) => ({ head: `${lat}`, cells: (c) => c.azimuth[i]!.printed })),
        'alm-pol-az',
      ),
    ),
    page === 0 ? howTo(t.how_to_use, t.example ? [{ title: 'Illustration', text: t.example.text }] : []) : null,
    page === 2 ? notesList(t.notes) : null,
  );
}

export function polarisSheets(t: PolarisTable, mock: boolean): HTMLElement[] {
  return [polarisSheet(t, 0, mock), polarisSheet(t, 1, mock), polarisSheet(t, 2, mock)];
}

// ---------------------------------------------------------------------------
// Conversion of arc to time
// ---------------------------------------------------------------------------

export function arcSheet(t: ArcToTime, mock: boolean): HTMLElement {
  const body = h('tbody', {});
  for (let row = 0; row < 60; row += 1) {
    const tr = h('tr', { class: row > 0 && row % 5 === 0 ? 'alm-block' : undefined });
    for (const start of ARC_RANGES) {
      const d = t.degrees[start + row]!;
      tr.append(th(String(d.deg), { scope: 'row', class: 'alm-ut alm-gap' }), td(d.printed, 'alm-n'));
    }
    const m = t.arcminutes[row]!;
    tr.append(th(String(m.arcmin), { scope: 'row', class: 'alm-ut alm-gap' }), ...m.printed.map((p) => td(p, 'alm-n')));
    body.append(tr);
  }
  return sheet(
    {
      heading: 'CONVERSION OF ARC TO TIME',
      side: 'ARC TO TIME',
      label: 'Conversion of arc to time',
      footer: '1° of arc = 4 minutes of time · 1′ = 4 seconds · exact',
      mock,
      extraClass: 'alm-sheet alm-arc-sheet',
    },
    h(
      'table',
      { class: 'alm-table alm-arc' },
      caption('Degrees of arc in hours and minutes of time, and minutes of arc (with quarters) in minutes and seconds'),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...ARC_RANGES.map((s0) => th(`${s0}°–${s0 + 59}°`, { colspan: 2, scope: 'colgroup', class: 'alm-gap' })),
          th('', { scope: 'col', class: 'alm-gap' }),
          th('0′·00', { scope: 'col' }),
          th('0′·25', { scope: 'col' }),
          th('0′·50', { scope: 'col' }),
          th('0′·75', { scope: 'col' }),
        ),
        h(
          'tr',
          { class: 'alm-units' },
          ...ARC_RANGES.flatMap(() => [th('°', { scope: 'col', class: 'alm-gap' }), th('h m', { scope: 'col' })]),
          th('′', { scope: 'col', class: 'alm-gap' }),
          ...[0, 1, 2, 3].map(() => th('m s', { scope: 'col' })),
        ),
      ),
      body,
    ),
    howTo(t.how_to_use, [{ title: 'Example', text: t.example }]),
  );
}
