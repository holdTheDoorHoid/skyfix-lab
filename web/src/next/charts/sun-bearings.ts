/**
 * Sunrise and sunset bearings through the year (charts2 agent, expansion programme Q5):
 * where on the horizon the Sun rises and sets on every day, and how high it stands at
 * solar noon. OWNER: charts2 agent.
 *
 * The event finder's rise, set and transit on every local day of the year (the upper limb
 * on the horizon): the Year chart's own `day_events_batch`, memoised and shared, so the two
 * charts cost one computation between them. `rise_set_azimuths` is the same finder over the
 * year split into days (EXPLORER_API "sun tools"); sharing the Year chart's days keeps the
 * two charts identical and draws this one at no cost after the other. Three panels share
 * the date axis; in the two bearing panels north is up, so both show the Sun swinging north
 * in summer and south in winter the same way.
 */

import { h, s } from '../../dom.js';
import { observerKey } from '../component.js';
import type { SeasonEvent } from '../engine/types.js';
import { setTime, stepTime } from '../playback.js';
import { displayZone, engineObserver, eventOptions, type ExplorerState } from '../state.js';
import { wallClock, zoneLabel } from '../time.js';
import { localDayCache, mountChart, placeName, type Shell } from './chart-shell.js';
import { OutsideCoverageError } from './coverage.js';
import { yearMemo } from './year-chart.js';
import type { YearInput } from './year-data.js';
import { altitude, bearing, clock, dateShort, dayMonth } from './format.js';
import { errorText, pill, round, stepperNav, svgText, table, timeButton, tipHead, tipRow, tooltip, type ChartComponent, type Tooltip } from './frame.js';
import { frameRect, linePath, monthGrid, monthLabels, panelTitle, svgRoot, todayOnAxis, yearAxis, type MonthLabel, type YearAxis } from './plot.js';
import { clamp, linearScale, type LinearScale } from './scale.js';
import { displayDateKey, monthHeading, parseDate } from './analemma.js';
import { bearingsFromYear, dayOfYearOf, type BearingData, type BearingDay } from './sun-data.js';
import { dateKey, jdAtWallHours, localDateOf, zoneKey } from './windows.js';
import { formatYear } from '../time/format.js';

interface BearingChartData {
  readonly bearings: BearingData;
  readonly seasons: readonly SeasonEvent[];
}

interface Panel {
  readonly top: number;
  readonly bottom: number;
  readonly ys: LinearScale;
}

/** The panels' vertical axis: degrees from north, so north is up in both bearing panels. */
function northing(kind: 'rise' | 'set', az: number): number {
  return kind === 'rise' ? az : 360 - az;
}

export const sunBearingsChart: ChartComponent = (host, ctx, ui) => {
  const dayOf = localDayCache();
  let tip: Tooltip | null = null;
  let geom: { axis: YearAxis; top: number; bottom: number; svg: SVGSVGElement; months: MonthLabel[] } | null = null;
  let hoverLayer: SVGGElement | null = null;

  const inputFor = (state: ExplorerState): YearInput => {
    const zone = displayZone(state);
    return { observer: engineObserver(state), zone, year: dayOf(state.time.jd_utc, zone).date.year, options: eventOptions(state) };
  };

  return mountChart<YearInput, BearingChartData>(host, ctx, ui, {
    kind: 'bearings',
    heading: 'Sunrise and sunset bearings',
    heavy: true,
    input: inputFor,
    key: (i) => [observerKey(i.observer), zoneKey(i.zone), i.year, i.options.horizon, i.options.height_of_eye_m].join('|'),
    compute(input) {
      const year = yearMemo(ctx, input);
      const bearings = bearingsFromYear(input.year, year.days);
      let seasons: SeasonEvent[] = [];
      try {
        seasons = [...ctx.engine.seasons(input.year)];
      } catch {
        seasons = [];
      }
      return { bearings, seasons };
    },
    failureText: (error, input) =>
      error instanceof OutsideCoverageError ? error.message : `The engine could not find this year’s sunrises and sunsets (${formatYear(input.year)}): ${errorText(error)}`,
    setup(shell) {
      stepperNav(shell.c.nav, 'Previous year', 'Next year', (dir) => stepTime(ctx.store, { unit: 'year', count: dir }));
      tip = tooltip(shell.c.plot);
      shell.c.legend.replaceChildren(
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-line sfc-key-line--rise', 'aria-hidden': 'true' }), 'Sunrise bearing (dashed)'),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-line sfc-key-line--set', 'aria-hidden': 'true' }), 'Sunset bearing (dotted)'),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-line sfc-key-line--noon', 'aria-hidden': 'true' }), 'Height at solar noon'),
      );
      return undefined;
    },
    header(shell) {
      const st = ctx.store.get();
      shell.c.title.replaceChildren(`Sunrise and sunset bearings · ${formatYear(shell.input.year)}`);
      if (st.settings.navigatorTerms) shell.c.title.append(h('span', { class: 'sfc-term', 'data-term': '' }, ' · azimuth of rising and setting'));
      shell.c.subtitle.textContent = `${placeName(st)} · every day of ${formatYear(shell.input.year)}; bearings from true north`;
      const label = shell.c.nav.querySelector('.sfc-nav-label');
      if (label) label.textContent = formatYear(shell.input.year);
    },
    draw: (shell) => draw(shell),
    cursor: (shell) => placeToday(shell),
    table: (shell) => tables(shell),
    displayKey: (st) => `${st.settings.angleFormat}|${st.settings.navigatorTerms}`,
    fileParts: (shell) => ['sunrise-sunset-bearings', shell.input.year],
    labels: () => ['Sunrise and sunset: the upper limb of the Sun on a sea-level horizon (standard refraction). Bearings from true north. Heights at solar noon are geometric (without refraction).'],
  });

  function draw(shell: Shell<YearInput, BearingChartData>): SVGSVGElement {
    const { bearings, seasons } = shell.data!;
    const W = shell.width;
    const narrow = W < 560;
    const margin = { left: narrow ? 58 : 76, right: narrow ? 8 : 14, top: 22 };
    const x0 = margin.left;
    const x1 = W - margin.right;
    const axis = yearAxis(bearings.year, x0, x1);
    const panelH = Math.round(clamp(W * 0.17, 110, 170));
    const gap = 30;
    const noonH = Math.round(panelH * 0.75);

    // Equal degrees per pixel in both bearing panels.
    const pad = 4;
    const riseN = bearings.days.flatMap((d) => (d.rise ? [northing('rise', d.rise.az)] : []));
    const setN = bearings.days.flatMap((d) => (d.set ? [northing('set', d.set.az)] : []));
    const spanOf = (v: number[]): [number, number] => (v.length ? [Math.min(...v) - pad, Math.max(...v) + pad] : [60, 120]);
    const rs = spanOf(riseN);
    const ss = spanOf(setN);
    const span = Math.max(rs[1] - rs[0], ss[1] - ss[0], 20);
    const centred = (r: [number, number]): [number, number] => [(r[0] + r[1]) / 2 - span / 2, (r[0] + r[1]) / 2 + span / 2];
    const riseTop = margin.top;
    const rise: Panel = { top: riseTop, bottom: riseTop + panelH, ys: linearScale(centred(rs), [riseTop, riseTop + panelH]) };
    const setTop = rise.bottom + gap;
    const set: Panel = { top: setTop, bottom: setTop + panelH, ys: linearScale(centred(ss), [setTop, setTop + panelH]) };
    const noonTop = set.bottom + gap;
    const maxNoon = Math.max(10, ...bearings.days.flatMap((d) => (d.transit ? [d.transit.alt] : [])));
    const minNoon = Math.min(0, ...bearings.days.flatMap((d) => (d.transit ? [d.transit.alt] : [])));
    const noon: Panel = {
      top: noonTop,
      bottom: noonTop + noonH,
      ys: linearScale([Math.floor(minNoon / 10) * 10, Math.ceil(maxNoon / 10) * 10], [noonTop + noonH, noonTop]),
    };
    const axisY = noon.bottom + 16;
    const H = axisY + 12;
    const svg = svgRoot(W, H, summary(shell));

    svg.append(monthGrid(axis, rise.top, noon.bottom));
    const seasonLines = s('g', { class: 'sfc-season' });
    for (const ev of seasons) {
      const i = dayOfYearOf(dateKey(localDateOf(ev.jd_utc, displayZone(ctx.store.get()))));
      if (!(i >= 0 && i < axis.n)) continue;
      const x = round(axis.xs(i + 0.5)) + 0.5;
      seasonLines.append(s('line', { x1: x, x2: x, y1: rise.top, y2: noon.bottom }));
    }
    svg.append(seasonLines);

    const tickStep = span > 120 ? 30 : span > 60 ? 15 : 10;
    for (const [kind, panel] of [
      ['rise', rise],
      ['set', set],
    ] as const) {
      const [lo, hi] = panel.ys.domain;
      const ticks = s('g', { class: 'sfc-axis' });
      const grid = s('g', { class: 'sfc-grid' });
      for (let v = Math.ceil(Math.min(lo, hi) / tickStep) * tickStep; v <= Math.max(lo, hi); v += tickStep) {
        const az = kind === 'rise' ? v : 360 - v;
        const y = round(panel.ys(v)) + 0.5;
        const due = az === 90 || az === 270;
        grid.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, class: due ? 'sfc-due' : 'sfc-grid--faint' }));
        ticks.append(svgText(x0 - 6, y + 3.5, bearing(az), { 'text-anchor': 'end', class: due ? 'sfc-compass--main' : '' }));
      }
      svg.append(grid, ticks);
      svg.append(panelTitle(x0, panel.top - 6, kind === 'rise' ? 'Sunrise bearing' : 'Sunset bearing', 'north up'));
      const series = bearings.days.map((d) => {
        const ev = kind === 'rise' ? d.rise : d.set;
        return ev ? ([axis.xs(d.index + 0.5), panel.ys(northing(kind, ev.az))] as [number, number]) : null;
      });
      // A day without the event breaks the line; so does a jump (two events a day at high latitude).
      const pts: ([number, number] | null)[] = [];
      let prev: [number, number] | null = null;
      for (const p of series) {
        if (p && prev && Math.abs(p[1] - prev[1]) > panelH / 3) pts.push(null);
        pts.push(p);
        prev = p;
      }
      const d = linePath(pts);
      svg.append(
        s('path', { class: 'sfc-sunline-casing', d }),
        s('path', { class: `sfc-sunline sfc-sunline--${kind}`, d }),
        frameRect(x0, panel.top, x1, panel.bottom),
      );
      // Where the Sun rises (sets) farthest north and south.
      const withEv = bearings.days.filter((x) => (kind === 'rise' ? x.rise : x.set));
      if (withEv.length) {
        const val = (x: BearingDay): number => northing(kind, (kind === 'rise' ? x.rise : x.set)!.az);
        let north = withEv[0]!;
        let south = withEv[0]!;
        for (const x of withEv) {
          if (val(x) < val(north)) north = x;
          if (val(x) > val(south)) south = x;
        }
        for (const [x, where] of [
          [north, 'north'],
          [south, 'south'],
        ] as const) {
          const ev = (kind === 'rise' ? x.rise : x.set)!;
          const px = axis.xs(x.index + 0.5);
          const py = panel.ys(val(x));
          const text = `${bearing(ev.az)} · ${dayMonth(parseDate(x.date))}`;
          const lp = pill(clamp(px, x0 + 60, x1 - 60), clamp(py + (where === 'north' ? 12 : -12), panel.top + 10, panel.bottom - 10), text, { size: 10 });
          svg.append(s('circle', { class: 'sfc-extreme-dot', cx: round(px), cy: round(py), r: 3.5 }), lp.el);
        }
      }
    }

    // Height at solar noon.
    const [n0, n1] = noon.ys.domain;
    const noonTicks = s('g', { class: 'sfc-axis' });
    const noonGrid = s('g', { class: 'sfc-grid' });
    const nStep = n1 - n0 > 60 ? 20 : 10;
    for (let v = n0; v <= n1; v += nStep) {
      const y = round(noon.ys(v)) + 0.5;
      noonGrid.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, class: v === 0 ? '' : 'sfc-grid--faint' }));
      noonTicks.append(svgText(x0 - 6, y + 3.5, `${v < 0 ? '−' : ''}${Math.abs(v)}°`, { 'text-anchor': 'end' }));
    }
    svg.append(noonGrid, noonTicks, panelTitle(x0, noon.top - 6, 'Height at solar noon', 'geometric'));
    const noonPath = linePath(bearings.days.map((d) => (d.transit ? ([axis.xs(d.index + 0.5), noon.ys(d.transit.alt)] as [number, number]) : null)));
    svg.append(s('path', { class: 'sfc-noonline', d: noonPath }), frameRect(x0, noon.top, x1, noon.bottom));

    const months = monthLabels(axis, axisY, narrow);
    svg.append(months.g);
    const today = s('g', { class: 'sfc-today-layer' }) as SVGGElement;
    svg.append(today);
    hoverLayer = s('g', { class: 'sfc-hover', 'pointer-events': 'none' }) as SVGGElement;
    svg.append(hoverLayer);
    geom = { axis, top: rise.top, bottom: noon.bottom, svg, months: months.labels };
    svg.addEventListener('pointermove', (event) => onHover(event, shell));
    svg.addEventListener('pointerleave', () => {
      tip?.hide();
      if (hoverLayer) hoverLayer.replaceChildren();
    });
    svg.addEventListener('click', (event) => onClick(event, shell));
    svg.style.cursor = 'crosshair';
    shell.c.plot.replaceChildren(svg, tip!.el);
    placeToday(shell);
    shell.c.caption.replaceChildren(
      summary(shell),
      ' ',
      h('span', { class: 'sfc-muted' }, 'Dashed lines: the equinoxes and solstices. Click a day to go to it; hover for the times.'),
    );
    const notes: HTMLElement[] = [];
    if (bearings.missing) notes.push(h('p', { class: 'sfc-note' }, `${bearings.missing} day${bearings.missing === 1 ? ' is' : 's are'} outside the engine’s coverage and left blank.`));
    shell.c.notes.replaceChildren(...notes);
    return svg;
  }

  function placeToday(shell: Shell<YearInput, BearingChartData>): void {
    if (!geom) return;
    const layer = geom.svg.querySelector<SVGGElement>('.sfc-today-layer');
    if (!layer) return;
    const st = ctx.store.get();
    const date = localDateOf(st.time.jd_utc, displayZone(st));
    const index = date.year === shell.input.year ? dayOfYearOf(dateKey(date)) : -1;
    layer.replaceChildren(todayOnAxis(geom.axis, index, [[geom.top, geom.bottom]], geom.bottom + 16, dayMonth(date), geom.months));
  }

  function dayAt(event: MouseEvent): number | null {
    if (!geom) return null;
    const rect = geom.svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (px < geom.axis.x0 || px > geom.axis.x1 || py < geom.top - 4 || py > geom.bottom + 4) return null;
    return clamp(Math.floor(geom.axis.xs.invert(px)), 0, geom.axis.n - 1);
  }

  function onHover(event: PointerEvent, shell: Shell<YearInput, BearingChartData>): void {
    const i = dayAt(event);
    const day = i === null ? undefined : shell.data?.bearings.days.find((d) => d.index === i);
    if (!geom || !day || !tip || !hoverLayer) {
      tip?.hide();
      hoverLayer?.replaceChildren();
      return;
    }
    const zone = displayZone(ctx.store.get());
    const fmt = ctx.store.get().settings.angleFormat;
    const x = round(geom.axis.xs(day.index + 0.5)) + 0.5;
    hoverLayer.replaceChildren(s('line', { x1: x, x2: x, y1: geom.top, y2: geom.bottom }));
    const rows: Node[] = [tipHead(dateShort(parseDate(day.date)))];
    if (day.alwaysAbove) rows.push(tipRow('24 h', 'the Sun does not set'));
    else if (day.alwaysBelow) rows.push(tipRow('0 h', 'the Sun does not rise'));
    if (day.rise) rows.push(tipRow(bearing(day.rise.az), 'sunrise', null, clock(day.rise.jd, zone)));
    if (day.set) rows.push(tipRow(bearing(day.set.az), 'sunset', null, clock(day.set.jd, zone)));
    if (day.transit) rows.push(tipRow(altitude(day.transit.alt, fmt), 'at solar noon', null, clock(day.transit.jd, zone)));
    const rect = geom.svg.getBoundingClientRect();
    tip.show(event.clientX - rect.left, event.clientY - rect.top, rows);
  }

  function onClick(event: MouseEvent, shell: Shell<YearInput, BearingChartData>): void {
    const i = dayAt(event);
    const day = i === null ? undefined : shell.data?.bearings.days.find((d) => d.index === i);
    if (!day) return;
    const st = ctx.store.get();
    const zone = displayZone(st);
    const w = wallClock(st.time.jd_utc, zone);
    setTime(ctx.store, jdAtWallHours(parseDate(day.date), w.hour + w.minute / 60, zone));
  }

  function summary(shell: Shell<YearInput, BearingChartData>): string {
    const data = shell.data;
    if (!data) return 'Where on the horizon the Sun rises and sets through the year.';
    const b = data.bearings;
    const parts: string[] = [];
    if (b.riseRange) parts.push(`The Sun rises between ${bearing(b.riseRange.min)} and ${bearing(b.riseRange.max)} over the year`);
    if (b.setRange) parts.push(`and sets between ${bearing(b.setRange.min)} and ${bearing(b.setRange.max)}`);
    let text = parts.length ? `${parts.join(' ')}: farthest north at midsummer, due east and west at the equinoxes.` : 'The Sun neither rises nor sets on any day of this year here.';
    const up = b.days.filter((d) => d.alwaysAbove).length;
    const down = b.days.filter((d) => d.alwaysBelow).length;
    if (up) text += ` It does not set on ${up} day${up === 1 ? '' : 's'}.`;
    if (down) text += ` It does not rise on ${down} day${down === 1 ? '' : 's'}.`;
    return text;
  }

  function tables(shell: Shell<YearInput, BearingChartData>): HTMLElement[] {
    const b = shell.data!.bearings;
    const st = ctx.store.get();
    const zone = displayZone(st);
    const fmt = st.settings.angleFormat;
    const t = table(`Sunrise, sunset and solar noon, every day of ${b.year} (local times, ${zoneLabel(st.time.jd_utc, zone)}; UTC on hover)`, [
      'Date',
      'Sunrise',
      'Bearing',
      'Sunset',
      'Bearing',
      'Solar noon',
      'Height then (geometric)',
    ]);
    const today = dateKey(localDateOf(st.time.jd_utc, zone));
    let month = '';
    for (const d of b.days) {
      const m = monthHeading(d.date);
      if (m !== month) {
        month = m;
        t.body.append(h('tr', { class: 'sfc-row-month' }, h('th', { scope: 'rowgroup', colspan: 7 }, m)));
      }
      const none = d.alwaysAbove ? 'up all day' : d.alwaysBelow ? 'down all day' : '—';
      t.body.append(
        h(
          'tr',
          { class: displayDateKey(d.date) === today ? 'sfc-row-current' : '' },
          h('th', { scope: 'row' }, dateShort(parseDate(d.date))),
          d.rise ? h('td', {}, timeButton(d.rise.jd, zone)) : h('td', { class: 'sfc-muted' }, none),
          h('td', { 'data-csv': d.rise ? d.rise.az.toFixed(2) : '' }, d.rise ? bearing(d.rise.az) : ''),
          d.set ? h('td', {}, timeButton(d.set.jd, zone)) : h('td', { class: 'sfc-muted' }, none),
          h('td', { 'data-csv': d.set ? d.set.az.toFixed(2) : '' }, d.set ? bearing(d.set.az) : ''),
          d.transit ? h('td', {}, timeButton(d.transit.jd, zone)) : h('td', {}, '—'),
          h('td', { 'data-csv': d.transit ? d.transit.alt.toFixed(3) : '' }, d.transit ? altitude(d.transit.alt, fmt) : '—'),
        ),
      );
    }
    return [t.table];
  }
};
