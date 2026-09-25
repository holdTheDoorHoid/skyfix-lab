/**
 * The equation of time and the Sun's declination through the year (charts2 agent,
 * expansion programme Q5). OWNER: charts2 agent.
 *
 * `equation_of_time(year, 12)`: for every UTC date, how far a sundial runs ahead of (+) or
 * behind (−) mean time at 12:00 UTC — the almanac page's `eot_12h` (CONVENTIONS 13.9) — and
 * the Sun's apparent declination: how far north or south of the equator it is overhead.
 * The same for every place. Together they are the analemma's two axes.
 */

import { h, s } from '../../dom.js';
import { isSunToolsEngine, type EotPoint, type SeasonEvent } from '../engine/types.js';
import { stepTime } from '../playback.js';
import { formatDeclination } from '../shell/format.js';
import { displayZone, type ExplorerState } from '../state.js';
import { localDayCache, mountChart, NotAvailableError, type Shell } from './chart-shell.js';
import { dateShort, dayMonth } from './format.js';
import { errorText, pill, round, stepperNav, svgText, table, uid, type ChartComponent } from './frame.js';
import { displayDateKey, monthHeading, parseDate } from './analemma.js';
import { scaleLabel } from '../time/scale.js';
import { frameRect, linePath, monthGrid, monthLabels, panelTitle, svgRoot, todayOnAxis, yearAxis, type MonthLabel, type YearAxis } from './plot.js';
import { clamp, linearScale } from './scale.js';
import { computeEot, dayOfYearOf, EOT_UTC_HOUR, eotText, type EotData } from './sun-data.js';
import { dateKey, localDateOf } from './windows.js';
import { formatYear } from '../time/format.js';

interface EotChartData {
  readonly eot: EotData;
  readonly seasons: readonly SeasonEvent[];
}

interface EotInput {
  readonly year: number;
}

/** A declination in plain words: `12° 04′ N`. */
function decText(dec: number, fmt: ExplorerState['settings']['angleFormat']): string {
  return formatDeclination(dec, fmt);
}

export const eotChart: ChartComponent = (host, ctx, ui) => {
  const dayOf = localDayCache();
  let geom: { axis: YearAxis; top: number; bottom: number; svg: SVGSVGElement; months: MonthLabel[] } | null = null;
  const readout = h('p', { class: 'sfc-readout sfc-readout--line', 'aria-live': 'off' });

  return mountChart<EotInput, EotChartData>(host, ctx, ui, {
    kind: 'eot',
    heading: 'Sundial and clock',
    heavy: true,
    input: (st) => ({ year: dayOf(st.time.jd_utc, displayZone(st)).date.year }),
    key: (i) => String(i.year),
    compute(input) {
      const engine = ctx.engine;
      if (!isSunToolsEngine(engine)) throw new NotAvailableError('The Sun charts');
      const eot = computeEot(engine, input.year);
      let seasons: SeasonEvent[] = [];
      try {
        seasons = [...engine.seasons(input.year)];
      } catch {
        seasons = [];
      }
      return { eot, seasons };
    },
    failureText: (error, input) => `The engine could not compute the equation of time for ${formatYear(input.year)}: ${errorText(error)}`,
    setup(shell) {
      stepperNav(shell.c.nav, 'Previous year', 'Next year', (dir) => stepTime(ctx.store, { unit: 'year', count: dir }));
      shell.c.figure.insertBefore(readout, shell.c.caption);
      shell.c.legend.replaceChildren(
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-swatch sfc-swatch--fast', 'aria-hidden': 'true' }), 'Sundial ahead of the clock'),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-swatch sfc-swatch--slow', 'aria-hidden': 'true' }), 'Sundial behind'),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-line sfc-key-line--dec', 'aria-hidden': 'true' }), 'Where the Sun is overhead'),
      );
      return undefined;
    },
    header(shell) {
      const st = ctx.store.get();
      shell.c.title.replaceChildren(`Sundial and clock · ${formatYear(shell.input.year)}`);
      if (st.settings.navigatorTerms) shell.c.title.append(h('span', { class: 'sfc-term', 'data-term': '' }, ' · equation of time and declination'));
      shell.c.subtitle.textContent = `The same everywhere · each day at ${String(EOT_UTC_HOUR).padStart(2, '0')}:00 ${scaleLabel(st.time.jd_utc)}`;
      const label = shell.c.nav.querySelector('.sfc-nav-label');
      if (label) label.textContent = formatYear(shell.input.year);
    },
    draw: (shell) => draw(shell),
    cursor: (shell) => placeToday(shell),
    table: (shell) => tables(shell),
    displayKey: (st) => `${st.settings.angleFormat}|${st.settings.navigatorTerms}`,
    fileParts: (shell) => ['equation-of-time', shell.input.year],
    labels: () => [
      `Equation of time: apparent minus mean solar time at 12:00 ${scaleLabel(ctx.store.get().time.jd_utc)} (CONVENTIONS 13.9); positive when a sundial is ahead of the clock. Declination: the Sun’s apparent declination.`,
    ],
  });

  function draw(shell: Shell<EotInput, EotChartData>): SVGSVGElement {
    const { eot, seasons } = shell.data!;
    const pts = eot.raw.points;
    const W = shell.width;
    const narrow = W < 560;
    const x0 = narrow ? 56 : 70;
    const x1 = W - (narrow ? 8 : 14);
    const axis = yearAxis(eot.year, x0, x1);
    const top = 22;
    const eotH = Math.round(clamp(W * 0.24, 160, 260));
    const gap = 30;
    const decH = Math.round(eotH * 0.7);
    const eotBottom = top + eotH;
    const decTop = eotBottom + gap;
    const decBottom = decTop + decH;
    const axisY = decBottom + 16;
    const H = axisY + 12;
    const svg = svgRoot(W, H, summary(shell));

    const minutes = pts.map((p) => p.eot_s / 60);
    const lo = Math.floor((Math.min(0, ...minutes) - 1) / 5) * 5;
    const hi = Math.ceil((Math.max(0, ...minutes) + 1) / 5) * 5;
    const ye = linearScale([lo, hi], [eotBottom, top]);
    const yd = linearScale([-25, 25], [decBottom, decTop]);
    const xOf = (p: EotPoint): number => axis.xs(dayOfYearOf(p.date) + 0.5);

    svg.append(monthGrid(axis, top, decBottom));
    const seasonLines = s('g', { class: 'sfc-season' });
    for (const ev of seasons) {
      const i = dayOfYearOf(dateKey(localDateOf(ev.jd_utc, displayZone(ctx.store.get()))));
      if (!(i >= 0 && i < axis.n)) continue;
      const x = round(axis.xs(i + 0.5)) + 0.5;
      seasonLines.append(s('line', { x1: x, x2: x, y1: top, y2: decBottom }));
    }
    svg.append(seasonLines);

    // Equation of time: the area to the zero line, ahead and behind.
    const grid = s('g', { class: 'sfc-grid' });
    const ticks = s('g', { class: 'sfc-axis' });
    for (let v = lo; v <= hi; v += 5) {
      const y = round(ye(v)) + 0.5;
      grid.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, class: v === 0 ? '' : 'sfc-grid--faint' }));
      ticks.append(svgText(x0 - 6, y + 3.5, v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)} min`, { 'text-anchor': 'end' }));
    }
    svg.append(grid, ticks, panelTitle(x0, top - 6, 'How far a sundial is ahead of the clock', 'minutes'));
    const zero = ye(0);
    const line = pts.map((p) => [xOf(p), ye(p.eot_s / 60)] as [number, number]);
    if (line.length) {
      const first = line[0]!;
      const last = line[line.length - 1]!;
      const area = `${linePath(line)}L${round(last[0])} ${round(zero)}L${round(first[0])} ${round(zero)}Z`;
      const clipFast = uid('sfc-eot-fast');
      const clipSlow = uid('sfc-eot-slow');
      const defs = s('defs');
      const cf = s('clipPath', { id: clipFast });
      cf.append(s('rect', { x: x0, y: top, width: x1 - x0, height: round(zero - top) }));
      const cs = s('clipPath', { id: clipSlow });
      cs.append(s('rect', { x: x0, y: round(zero), width: x1 - x0, height: round(eotBottom - zero) }));
      defs.append(cf, cs);
      svg.append(
        defs,
        s('path', { class: 'sfc-eot-fast', d: area, 'clip-path': `url(#${clipFast})` }),
        s('path', { class: 'sfc-eot-slow', d: area, 'clip-path': `url(#${clipSlow})` }),
        s('path', { class: 'sfc-eot-line', d: linePath(line) }),
      );
    }
    // In the corners the curve leaves empty: January starts behind, December ends near zero.
    svg.append(svgText(x0 + 6, top + 14, 'sundial ahead ↑', { 'text-anchor': 'start', class: 'sfc-strip-label' }));
    svg.append(svgText(x1 - 6, eotBottom - 6, 'sundial behind ↓', { 'text-anchor': 'end', class: 'sfc-strip-label' }));
    for (const ex of eot.raw.extremes) {
      const i = dayOfYearOf(ex.date);
      const x = axis.xs(i + 0.5);
      const y = ye(ex.eot_s / 60);
      const text = `${eotText(ex.eot_s)} · ${dayMonth(parseDate(ex.date))}`;
      const lp = pill(clamp(x, x0 + 60, x1 - 60), y + (ex.kind === 'maximum' ? -13 : 13), text, { size: 10 });
      svg.append(s('circle', { class: 'sfc-extreme-dot', cx: round(x), cy: round(y), r: 3.5 }), lp.el);
    }
    svg.append(frameRect(x0, top, x1, eotBottom));

    // Declination.
    const dgrid = s('g', { class: 'sfc-grid' });
    const dticks = s('g', { class: 'sfc-axis' });
    for (const v of [-20, -10, 0, 10, 20]) {
      const y = round(yd(v)) + 0.5;
      dgrid.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, class: v === 0 ? '' : 'sfc-grid--faint' }));
      dticks.append(svgText(x0 - 6, y + 3.5, v === 0 ? 'Equator' : `${Math.abs(v)}° ${v > 0 ? 'N' : 'S'}`, { 'text-anchor': 'end' }));
    }
    svg.append(dgrid, dticks, panelTitle(x0, decTop - 6, 'Where the Sun is overhead', 'north or south of the equator'));
    svg.append(s('path', { class: 'sfc-dec-line', d: linePath(pts.map((p) => [xOf(p), yd(p.dec_deg)] as [number, number])) }));
    svg.append(frameRect(x0, decTop, x1, decBottom));

    const months = monthLabels(axis, axisY, narrow);
    svg.append(months.g);
    const today = s('g', { class: 'sfc-today-layer' });
    svg.append(today);
    geom = { axis, top, bottom: decBottom, svg, months: months.labels };
    shell.c.plot.replaceChildren(svg);
    placeToday(shell);
    shell.c.caption.replaceChildren(
      summary(shell),
      ' ',
      h(
        'span',
        { class: 'sfc-muted' },
        'A sundial shows apparent solar time; clocks keep mean time. The difference comes from the tilt of the Earth’s axis and its elliptical orbit. Dashed lines: the equinoxes and solstices.',
      ),
    );
    const errors = eot.raw.errors;
    shell.c.notes.replaceChildren(
      ...(errors.length ? [h('p', { class: 'sfc-note' }, `${errors.length} day${errors.length === 1 ? ' is' : 's are'} outside the engine’s coverage and left out.`)] : []),
    );
    return svg;
  }

  function todayPoint(shell: Shell<EotInput, EotChartData>): EotPoint | null {
    const st = ctx.store.get();
    const key = dateKey(localDateOf(st.time.jd_utc, displayZone(st)));
    return shell.data?.eot.raw.points.find((p) => p.date === key) ?? null;
  }

  function placeToday(shell: Shell<EotInput, EotChartData>): void {
    const st = ctx.store.get();
    const date = localDateOf(st.time.jd_utc, displayZone(st));
    if (geom) {
      const layer = geom.svg.querySelector('.sfc-today-layer');
      const index = date.year === shell.input.year ? dayOfYearOf(dateKey(date)) : -1;
      layer?.replaceChildren(todayOnAxis(geom.axis, index, [[geom.top, geom.bottom]], geom.bottom + 16, dayMonth(date), geom.months));
    }
    const p = todayPoint(shell);
    const fmt = st.settings.angleFormat;
    readout.textContent = p
      ? `${dateShort(date)}: a sundial is ${Math.abs(p.eot_s) < 30 ? 'within half a minute of' : `${eotText(Math.abs(p.eot_s)).replace('+', '')} ${p.eot_s > 0 ? 'ahead of' : 'behind'}`} the clock; the Sun is overhead at ${decText(p.dec_deg, fmt)}.`
      : `${dateShort(date)} is not in ${formatYear(shell.input.year)}.`;
  }

  function summary(shell: Shell<EotInput, EotChartData>): string {
    const data = shell.data;
    if (!data) return 'The equation of time and the Sun’s declination through the year.';
    const ex = data.eot.raw.extremes;
    const max = ex.filter((e) => e.kind === 'maximum').sort((a, b) => b.eot_s - a.eot_s)[0];
    const min = ex.filter((e) => e.kind === 'minimum').sort((a, b) => a.eot_s - b.eot_s)[0];
    const parts: string[] = [];
    if (max && min) {
      parts.push(
        `A sundial is furthest ahead of the clock on ${dayMonth(parseDate(max.date))} (${eotText(max.eot_s)}) and furthest behind on ${dayMonth(parseDate(min.date))} (${eotText(min.eot_s)}).`,
      );
    }
    parts.push('The Sun is overhead farthest north at the June solstice and farthest south at the December solstice.');
    return parts.join(' ');
  }

  function tables(shell: Shell<EotInput, EotChartData>): HTMLElement[] {
    const { eot } = shell.data!;
    const st = ctx.store.get();
    const fmt = st.settings.angleFormat;
    const ext = table(`The year’s turning points, ${formatYear(eot.year)}`, ['Date', 'Sundial against the clock', 'Kind']);
    for (const e of eot.raw.extremes) {
      ext.body.append(
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, dateShort(parseDate(e.date))),
          h('td', { 'data-csv': e.eot_s.toFixed(1) }, eotText(e.eot_s)),
          h('td', { class: 'sfc-text' }, e.kind === 'maximum' ? 'Furthest ahead (maximum)' : 'Furthest behind (minimum)'),
        ),
      );
    }
    const word = scaleLabel(st.time.jd_utc);
    const t = table(`Equation of time and declination, every day of ${formatYear(eot.year)} at 12:00 ${word} (positive: the sundial is ahead)`, [
      `Date (${word})`,
      'Equation of time',
      'Seconds',
      'Declination',
    ]);
    const today = dateKey(localDateOf(st.time.jd_utc, displayZone(st)));
    let month = '';
    for (const p of eot.raw.points) {
      const m = monthHeading(p.date);
      if (m !== month) {
        month = m;
        t.body.append(h('tr', { class: 'sfc-row-month' }, h('th', { scope: 'rowgroup', colspan: 4 }, m)));
      }
      t.body.append(
        h(
          'tr',
          { class: displayDateKey(p.date) === today ? 'sfc-row-current' : '' },
          h('th', { scope: 'row' }, dateShort(parseDate(p.date))),
          h('td', { 'data-csv': (p.eot_s / 60).toFixed(3) }, eotText(p.eot_s)),
          h('td', { 'data-csv': p.eot_s.toFixed(1) }, p.eot_s.toFixed(1)),
          h('td', { 'data-csv': p.dec_deg.toFixed(4) }, decText(p.dec_deg, fmt)),
        ),
      );
    }
    return [ext.table, t.table];
  }
};
