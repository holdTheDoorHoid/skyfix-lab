/**
 * The solar-panel helper (charts2 agent, expansion programme Q5): a clear-sky estimate of
 * the sunlight reaching a tilted panel, day by day through the year, the year's total, the
 * tilt that would collect the most, and the app's day hour by hour. OWNER: charts2 agent.
 *
 * `solar_year` (with the best-tilt search) and `solar_day`: Haurwitz's clear-sky irradiance,
 * the Meinel beam and an isotropic sky (CONVENTIONS 13.10). **Always labelled**: a clear-sky
 * estimate with its typical error; clouds, haze, snow, shading, soiling, temperature and the
 * panel's own efficiency are not modelled. The engine's `model` sentences are shown as they
 * come, with every number.
 */

import { h, s } from '../../dom.js';
import { observerKey } from '../component.js';
import { isSunToolsEngine, type SolarDay } from '../engine/types.js';
import { setTime, stepTime } from '../playback.js';
import { axisTime, endOfDay } from '../shell/format.js';
import { displayZone, engineObserver, type ExplorerState } from '../state.js';
import { button } from '../theme/primitives.js';
import { zoneLabel, type Zone } from '../time.js';
import { localDayCache, mountChart, NotAvailableError, placeName, type Shell } from './chart-shell.js';
import { clock, compassPoint, dateLong, dateShort, dayMonth, MONTHS_LONG } from './format.js';
import { errorText, pill, round, stepperNav, svgText, table, timeButton, type ChartComponent } from './frame.js';
import { parseDate } from './analemma.js';
import { frameRect, linePath, monthGrid, monthLabels, niceStep, panelTitle, svgRoot, todayOnAxis, yearAxis, type MonthLabel, type YearAxis } from './plot.js';
import { clamp, linearScale, type LinearScale } from './scale.js';
import {
  computeSolarDay,
  computeSolarYear,
  dayOfYearOf,
  defaultPanel,
  kwh,
  standardOffsetHours,
  type SolarData,
  type SolarInput,
} from './sun-data.js';
import { dateKey, localDateOf, wallHours, type LocalDay } from './windows.js';
import { formatYear } from '../time/format.js';

/** The person's panel, remembered for the page's lifetime; null follows the place (latitude tilt, facing the equator). */
let chosen: { tilt: number; azimuth: number } | null = null;

const POINTS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** The panel for a place: the person's choice, or the default. */
export function panelFor(latDeg: number): { tilt: number; azimuth: number } {
  return chosen ?? defaultPanel(latDeg);
}

/** Text ending in a full stop. */
function sentence(text: string): string {
  const s = text.trim();
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** `+0.3 %` */
function percentGain(a: number, b: number): string {
  if (!(b > 0)) return '';
  const p = (a / b - 1) * 100;
  const t = Math.abs(p) < 0.05 ? '0.0' : Math.abs(p).toFixed(1);
  return `${p < -0.05 ? '−' : '+'}${t} %`;
}

export const solarChart: ChartComponent = (host, ctx, ui) => {
  const dayOf = localDayCache();
  let geom: { axis: YearAxis; top: number; bottom: number; svg: SVGSVGElement; months: MonthLabel[] } | null = null;
  let dayGeom: { svg: SVGSVGElement; xs: LinearScale; day: LocalDay; zone: Zone; top: number; bottom: number } | null = null;
  let dayCache: { key: string; value: SolarDay | null; error: string | null } | null = null;
  const tiles = h('div', { class: 'sfc-tiles', 'aria-live': 'off' });
  const estimate = h('p', { class: 'sfc-estimate' });
  const dayPlot = h('div', { class: 'sfc-plot sfc-plot--second' });
  const dayCaption = h('p', { class: 'sfc-caption' });

  const tiltInput = h('input', { type: 'number', class: 'sf-input sfc-num-input', min: 0, max: 90, step: 1, 'aria-label': 'Panel tilt from flat, degrees' });
  const facing = h('select', { class: 'sfc-select', 'aria-label': 'The direction the panel faces' });

  const inputFor = (state: ExplorerState): SolarInput => {
    const zone = displayZone(state);
    const year = dayOf(state.time.jd_utc, zone).date.year;
    return { observer: engineObserver(state), year, offsetH: standardOffsetHours(zone, year), panel: panelFor(state.observer.lat_deg) };
  };

  return mountChart<SolarInput, SolarData>(host, ctx, ui, {
    kind: 'solar',
    heading: 'Sunlight on a solar panel',
    heavy: true,
    input: inputFor,
    key: (i) => [observerKey(i.observer), i.year, i.offsetH, i.panel.tilt, i.panel.azimuth].join('|'),
    compute(input) {
      const engine = ctx.engine;
      if (!isSunToolsEngine(engine)) throw new NotAvailableError('The Sun charts');
      return computeSolarYear(engine, input);
    },
    failureText: (error, input) => `The engine could not estimate ${formatYear(input.year)}’s sunlight: ${errorText(error)}`,
    setup(shell) {
      const { c } = shell;
      stepperNav(c.nav, 'Previous year', 'Next year', (dir) => stepTime(ctx.store, { unit: 'year', count: dir }));
      for (let k = 0; k < 16; k += 1) facing.append(h('option', { value: String(k * 22.5) }, `${POINTS16[k]} (${k * 22.5}°)`));
      const sync = (): void => {
        const p = panelFor(ctx.store.get().observer.lat_deg);
        tiltInput.value = String(p.tilt);
        facing.value = String(Math.round(p.azimuth / 22.5) * 22.5 % 360);
      };
      sync();
      const apply = (): void => {
        const tilt = Number(tiltInput.value);
        const azimuth = Number(facing.value);
        if (!(tilt >= 0 && tilt <= 90) || !Number.isFinite(azimuth)) return;
        chosen = { tilt: Math.round(tilt * 10) / 10, azimuth };
        shell.refresh();
      };
      tiltInput.addEventListener('change', apply);
      facing.addEventListener('change', apply);
      const reset = button({
        label: 'Reset',
        size: 'sm',
        variant: 'ghost',
        tip: 'Tilted at the latitude, facing the equator',
        onClick: () => {
          chosen = null;
          sync();
          shell.refresh();
        },
      });
      const controls = h(
        'div',
        { class: 'sfc-controls', role: 'group', 'aria-label': 'The panel' },
        h('label', { class: 'sfc-control' }, h('span', {}, 'Tilt'), tiltInput, h('span', { class: 'sfc-muted' }, '° from flat')),
        h('label', { class: 'sfc-control' }, h('span', {}, 'Facing'), facing),
        reset,
      );
      c.legend.replaceChildren(
        controls,
        h('span', { class: 'sfc-legend-sep', 'aria-hidden': 'true' }),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-line sfc-key-line--poa', 'aria-hidden': 'true' }), 'On the panel'),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-line sfc-key-line--ghi', 'aria-hidden': 'true' }), 'On flat ground'),
      );
      c.root.insertBefore(estimate, c.legend);
      c.figure.insertBefore(tiles, c.plot);
      c.figure.insertBefore(dayPlot, c.caption);
      c.figure.insertBefore(dayCaption, c.caption);
      const stop = ctx.store.select((st) => st.observer.lat_deg, () => {
        if (!chosen) sync();
      });
      return stop;
    },
    header(shell) {
      const st = ctx.store.get();
      const p = shell.input.panel;
      shell.c.title.replaceChildren(`Sunlight on a solar panel · ${formatYear(shell.input.year)}`);
      if (st.settings.navigatorTerms) shell.c.title.append(h('span', { class: 'sfc-term', 'data-term': '' }, ' · clear-sky irradiance, plane of array'));
      shell.c.subtitle.textContent = `${placeName(st)} · panel tilted ${p.tilt}° facing ${compassPoint(p.azimuth)} (${p.azimuth}°)`;
      const label = shell.c.nav.querySelector('.sfc-nav-label');
      if (label) label.textContent = formatYear(shell.input.year);
      const model = shell.data?.year.model;
      estimate.replaceChildren(
        h('strong', {}, 'Clear-sky estimate; clouds not modelled.'),
        ' ',
        model ? `${sentence(model.typical_error)} Not modelled: ${sentence(model.not_modelled)}` : '',
      );
      if (!chosen) {
        tiltInput.value = String(p.tilt);
        facing.value = String(p.azimuth);
      }
    },
    draw: (shell) => draw(shell),
    cursor: (shell) => {
      placeToday(shell);
      drawDay(shell);
    },
    table: (shell) => tables(shell),
    displayKey: (st) => `${st.settings.navigatorTerms}|${st.settings.timeDisplay}`,
    fileParts: (shell) => ['solar-panel', shell.input.year, `tilt-${shell.input.panel.tilt}`, `facing-${compassPoint(shell.input.panel.azimuth)}`],
    labels: (shell) => {
      const m = shell.data?.year.model;
      return [
        'Clear-sky estimate; clouds not modelled.',
        ...(m ? [`Model: ${m.clear_sky}; ${m.diffuse_split}; ${m.transposition}.`, `Typical error: ${sentence(m.typical_error)}`, `Not modelled: ${sentence(m.not_modelled)}`] : []),
      ];
    },
  });

  function draw(shell: Shell<SolarInput, SolarData>): SVGSVGElement {
    const data = shell.data!;
    const y = data.year;
    const W = shell.width;
    const narrow = W < 560;
    renderTiles(shell);
    const x0 = narrow ? 44 : 56;
    const x1 = W - (narrow ? 8 : 14);
    const axis = yearAxis(y.year, x0, x1);
    const top = 22;
    const plotH = Math.round(clamp(W * 0.3, 180, 300));
    const bottom = top + plotH;
    const axisY = bottom + 16;
    const H = axisY + 12;
    const svg = svgRoot(W, H, summary(shell));
    const maxV = Math.max(1, ...y.days.map((d) => Math.max(d.poa_kwh_m2, d.ghi_kwh_m2)));
    const step = niceStep(maxV, 5);
    const ys = linearScale([0, Math.ceil((maxV * 1.08) / step) * step], [bottom, top]);
    svg.append(monthGrid(axis, top, bottom));
    const grid = s('g', { class: 'sfc-grid' });
    const ticks = s('g', { class: 'sfc-axis' });
    for (let v = 0; v <= ys.domain[1] + 1e-9; v += step) {
      const yy = round(ys(v)) + 0.5;
      grid.append(s('line', { x1: x0, x2: x1, y1: yy, y2: yy, class: v === 0 ? '' : 'sfc-grid--faint' }));
      ticks.append(svgText(x0 - 6, yy + 3.5, kwh(v, step < 1 ? 1 : 0), { 'text-anchor': 'end' }));
    }
    svg.append(grid, ticks, panelTitle(x0, top - 6, 'Clear-sky sunlight each day', 'kWh per square metre'));
    const poa = y.days.map((d, i) => [axis.xs(data.index[i]! + 0.5), ys(d.poa_kwh_m2)] as [number, number]);
    const ghi = y.days.map((d, i) => [axis.xs(data.index[i]! + 0.5), ys(d.ghi_kwh_m2)] as [number, number]);
    if (poa.length) {
      const area = `${linePath(poa)}L${round(poa[poa.length - 1]![0])} ${round(bottom)}L${round(poa[0]![0])} ${round(bottom)}Z`;
      svg.append(s('path', { class: 'sfc-solar-area', d: area }));
    }
    svg.append(s('path', { class: 'sfc-solar-ghi', d: linePath(ghi) }), s('path', { class: 'sfc-solar-poa', d: linePath(poa) }));
    for (const [e, where] of [
      [data.best, 'most'],
      [data.worst, 'least'],
    ] as const) {
      if (!e) continue;
      const x = axis.xs(e.index + 0.5);
      const yy = ys(e.poa);
      const date = y.days.find((_, i) => data.index[i] === e.index)?.date;
      const lp = pill(clamp(x, x0 + 70, x1 - 70), yy + (where === 'most' ? -13 : 13), `${kwh(e.poa, 1)} · ${date ? dayMonth(parseDate(date)) : ''}`, { size: 10 });
      svg.append(s('circle', { class: 'sfc-extreme-dot', cx: round(x), cy: round(yy), r: 3.5 }), lp.el);
    }
    svg.append(frameRect(x0, top, x1, bottom));
    const months = monthLabels(axis, axisY, narrow);
    svg.append(months.g, s('g', { class: 'sfc-today-layer' }));
    geom = { axis, top, bottom, svg, months: months.labels };
    shell.c.plot.replaceChildren(svg);
    shell.c.caption.replaceChildren(
      summary(shell),
      ' ',
      h('span', { class: 'sfc-muted' }, 'Energy per square metre of panel before the panel converts any of it: multiply by the panel’s area and its efficiency for electricity.'),
    );
    shell.c.notes.replaceChildren(
      ...(y.truncated ? [h('p', { class: 'sfc-note' }, 'Part of this year is outside the engine’s coverage and is left out of the totals.')] : []),
    );
    dayCache = null;
    placeToday(shell);
    drawDay(shell);
    return svg;
  }

  function renderTiles(shell: Shell<SolarInput, SolarData>): void {
    const y = shell.data!.year;
    const p = shell.input.panel;
    const tile = (value: string, unit: string, label: string, extra?: Node): HTMLElement =>
      h('div', { class: 'sfc-tile' }, h('div', { class: 'sfc-tile__value' }, h('strong', {}, value), h('span', {}, unit)), h('div', { class: 'sfc-tile__label' }, label), extra ?? null);
    const items: HTMLElement[] = [
      tile(kwh(y.poa_kwh_m2), 'kWh/m²', `on the panel in ${formatYear(y.year)} (tilted ${p.tilt}°, facing ${compassPoint(p.azimuth)})`),
      tile(kwh(y.ghi_kwh_m2), 'kWh/m²', 'on flat ground'),
    ];
    if (y.optimal) {
      const best = y.optimal;
      const use = button({
        label: `Use ${Math.round(best.tilt_deg)}°`,
        size: 'sm',
        variant: 'outline',
        tip: 'Set the tilt to the best one',
        onClick: () => {
          chosen = { tilt: Math.round(best.tilt_deg), azimuth: p.azimuth };
          tiltInput.value = String(chosen.tilt);
          shell.refresh();
        },
      });
      items.push(
        tile(
          `${best.tilt_deg.toFixed(1)}°`,
          'best tilt',
          `facing ${compassPoint(best.azimuth_deg)}: ${kwh(best.poa_kwh_m2)} kWh/m² (${percentGain(best.poa_kwh_m2, y.poa_kwh_m2)} on yours)`,
          Math.abs(best.tilt_deg - p.tilt) >= 0.5 ? use : undefined,
        ),
      );
    }
    tiles.replaceChildren(...items);
  }

  function placeToday(shell: Shell<SolarInput, SolarData>): void {
    if (!geom) return;
    const st = ctx.store.get();
    const date = localDateOf(st.time.jd_utc, displayZone(st));
    const index = date.year === shell.input.year ? dayOfYearOf(dateKey(date)) : -1;
    geom.svg.querySelector('.sfc-today-layer')?.replaceChildren(todayOnAxis(geom.axis, index, [[geom.top, geom.bottom]], geom.bottom + 16, dayMonth(date), geom.months));
  }

  /** The app's day, hour by hour: computed once per day (under a millisecond natively), the cursor every frame. */
  function drawDay(shell: Shell<SolarInput, SolarData>): void {
    const st = ctx.store.get();
    const zone = displayZone(st);
    const day = dayOf(st.time.jd_utc, zone);
    const key = `${ctx.engine.kind}|${observerKey(shell.input.observer)}|${day.key}|${day.jd_start}|${shell.input.panel.tilt}|${shell.input.panel.azimuth}|${shell.width}`;
    if (!dayCache || dayCache.key !== key) {
      const engine = ctx.engine;
      let value: SolarDay | null = null;
      let error: string | null = null;
      try {
        if (!isSunToolsEngine(engine)) throw new NotAvailableError('The Sun charts');
        value = computeSolarDay(engine, shell.input.observer, day, shell.input.panel);
      } catch (e) {
        error = errorText(e);
      }
      dayCache = { key, value, error };
      renderDay(shell, day, zone, value, error);
    }
    moveDayCursor();
  }

  function renderDay(shell: Shell<SolarInput, SolarData>, day: LocalDay, zone: Zone, sd: SolarDay | null, error: string | null): void {
    if (!sd) {
      dayPlot.replaceChildren(h('p', { class: 'sfc-message' }, `The day’s sunlight could not be computed: ${error ?? 'no result'}`));
      dayGeom = null;
      return;
    }
    const W = shell.width;
    const narrow = W < 560;
    const x0 = narrow ? 44 : 56;
    const x1 = W - (narrow ? 8 : 14);
    const top = 22;
    const plotH = Math.round(clamp(W * 0.18, 120, 190));
    const bottom = top + plotH;
    const H = bottom + 30;
    const xs = linearScale([0, day.hours], [x0, x1]);
    const maxW = Math.max(100, ...sd.samples.map((q) => Math.max(q.poa_w_m2, q.ghi_w_m2)));
    const step = niceStep(maxW, 4);
    const ys = linearScale([0, Math.ceil((maxW * 1.05) / step) * step], [bottom, top]);
    const svg = svgRoot(W, H, `Clear-sky sunlight on the panel through ${dateLong(day.date)}: ${kwh(sd.poa_kwh_m2, 2)} kWh per square metre.`);
    const grid = s('g', { class: 'sfc-grid' });
    const axis = s('g', { class: 'sfc-axis' });
    for (let v = 0; v <= ys.domain[1] + 1e-9; v += step) {
      const yy = round(ys(v)) + 0.5;
      grid.append(s('line', { x1: x0, x2: x1, y1: yy, y2: yy, class: v === 0 ? '' : 'sfc-grid--faint' }));
      axis.append(svgText(x0 - 6, yy + 3.5, String(v), { 'text-anchor': 'end' }));
    }
    const hourStep = narrow ? 6 : 3;
    for (let hr = 0; hr <= Math.floor(day.hours); hr += 1) {
      const jd = day.jd_start + hr / 24;
      const wall = Math.round(wallHours(day, jd, zone));
      if (wall % hourStep !== 0) continue;
      const x = round(xs(hr)) + 0.5;
      grid.append(s('line', { x1: x, x2: x, y1: top, y2: bottom, class: 'sfc-grid--faint' }));
      axis.append(svgText(x, bottom + 16, hr >= day.hours - 1e-9 ? endOfDay(zone) : axisTime(jd, zone), { 'text-anchor': 'middle' }));
    }
    const hourOf = (jd: number): number => (jd - day.jd_start) * 24;
    const poa = sd.samples.map((q) => [xs(hourOf(q.jd_utc)), ys(q.poa_w_m2)] as [number, number]);
    const ghi = sd.samples.map((q) => [xs(hourOf(q.jd_utc)), ys(q.ghi_w_m2)] as [number, number]);
    svg.append(grid, axis, panelTitle(x0, top - 6, `${dateShort(day.date)}, hour by hour`, 'watts per square metre'));
    svg.append(s('path', { class: 'sfc-solar-ghi', d: linePath(ghi) }), s('path', { class: 'sfc-solar-poa', d: linePath(poa) }), frameRect(x0, top, x1, bottom));
    const cursor = s('g', { class: 'sfc-cursor sfc-cursor--static', 'pointer-events': 'none' });
    cursor.append(s('line', { x1: 0, x2: 0, y1: top, y2: bottom }));
    svg.append(cursor);
    svg.addEventListener('click', (event) => {
      const rect = svg.getBoundingClientRect();
      const hr = clamp(xs.invert(event.clientX - rect.left), 0, day.hours);
      setTime(ctx.store, day.jd_start + Math.round(hr * 60) / 1440);
    });
    svg.style.cursor = 'crosshair';
    dayPlot.replaceChildren(svg);
    dayGeom = { svg, xs, day, zone, top, bottom };
    let peak = sd.samples[0];
    for (const q of sd.samples) if (!peak || q.poa_w_m2 > peak.poa_w_m2) peak = q;
    dayCaption.replaceChildren(
      `${dateLong(day.date)}: ${kwh(sd.poa_kwh_m2, 2)} kWh/m² on the panel and ${kwh(sd.ghi_kwh_m2, 2)} on flat ground, on a clear day`,
      peak && peak.poa_w_m2 > 0 ? `; at most ${Math.round(peak.poa_w_m2)} W/m² at ${clock(peak.jd_utc, zone)}.` : '.',
      ' ',
      h('span', { class: 'sfc-muted' }, 'Click to go to that time.'),
    );
  }

  function moveDayCursor(): void {
    if (!dayGeom) return;
    const jd = ctx.store.get().time.jd_utc;
    const c = dayGeom.svg.querySelector<SVGGElement>('.sfc-cursor');
    if (!c) return;
    const inside = jd >= dayGeom.day.jd_start && jd < dayGeom.day.jd_end;
    c.style.display = inside ? '' : 'none';
    if (inside) c.setAttribute('transform', `translate(${round(dayGeom.xs((jd - dayGeom.day.jd_start) * 24))} 0)`);
  }

  function summary(shell: Shell<SolarInput, SolarData>): string {
    const data = shell.data;
    if (!data) return 'A clear-sky estimate of the sunlight on a solar panel through the year.';
    const y = data.year;
    const p = shell.input.panel;
    const parts = [
      `On clear days a panel tilted ${p.tilt}° and facing ${compassPoint(p.azimuth)} would receive about ${kwh(y.poa_kwh_m2)} kWh per square metre in ${formatYear(y.year)}, against ${kwh(y.ghi_kwh_m2)} on flat ground.`,
    ];
    if (y.optimal) parts.push(`The best tilt facing ${compassPoint(y.optimal.azimuth_deg)} is ${y.optimal.tilt_deg.toFixed(1)}° (${kwh(y.optimal.poa_kwh_m2)} kWh/m²).`);
    parts.push('Real years are cloudier: this is the ceiling, not a forecast.');
    return parts.join(' ');
  }

  function tables(shell: Shell<SolarInput, SolarData>): HTMLElement[] {
    const data = shell.data!;
    const y = data.year;
    const st = ctx.store.get();
    const zone = displayZone(st);
    const months = table(`Clear-sky sunlight by month, ${y.year} (kWh per square metre; panel tilted ${shell.input.panel.tilt}°, facing ${compassPoint(shell.input.panel.azimuth)})`, [
      'Month',
      'Days',
      'On the panel',
      'On flat ground',
    ]);
    for (const m of y.months) {
      months.body.append(
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, MONTHS_LONG[m.month - 1] ?? String(m.month)),
          h('td', {}, String(m.days)),
          h('td', { 'data-csv': m.poa_kwh_m2.toFixed(2) }, kwh(m.poa_kwh_m2, 1)),
          h('td', { 'data-csv': m.ghi_kwh_m2.toFixed(2) }, kwh(m.ghi_kwh_m2, 1)),
        ),
      );
    }
    months.body.append(
      h(
        'tr',
        { class: 'sfc-row-total' },
        h('th', { scope: 'row' }, 'The year'),
        h('td', {}, String(y.days.length)),
        h('td', { 'data-csv': y.poa_kwh_m2.toFixed(1) }, kwh(y.poa_kwh_m2)),
        h('td', { 'data-csv': y.ghi_kwh_m2.toFixed(1) }, kwh(y.ghi_kwh_m2)),
      ),
    );
    const days = table(`Clear-sky sunlight each day, ${y.year} (kWh per square metre)`, ['Date', 'On the panel', 'On flat ground']);
    const today = dateKey(localDateOf(st.time.jd_utc, zone));
    for (const d of y.days) {
      days.body.append(
        h(
          'tr',
          { class: d.date === today ? 'sfc-row-current' : '' },
          h('th', { scope: 'row' }, dateShort(parseDate(d.date))),
          h('td', { 'data-csv': d.poa_kwh_m2.toFixed(3) }, kwh(d.poa_kwh_m2, 2)),
          h('td', { 'data-csv': d.ghi_kwh_m2.toFixed(3) }, kwh(d.ghi_kwh_m2, 2)),
        ),
      );
    }
    const out: HTMLElement[] = [months.table];
    const day = dayOf(st.time.jd_utc, zone);
    let sd = dayCache?.value ?? null;
    if (!sd) {
      // The Table view shown first: the day's hours have not been drawn yet.
      try {
        const engine = ctx.engine;
        if (isSunToolsEngine(engine)) sd = computeSolarDay(engine, shell.input.observer, day, shell.input.panel);
      } catch {
        sd = null;
      }
    }
    if (sd) {
      const hours = table(`${dateLong(day.date)}, every ${sd.step_minutes} minutes (watts per square metre; local times, ${zoneLabel(day.jd_start + 0.5, zone)})`, [
        'Time',
        'On the panel',
        'On flat ground',
        'Direct beam',
        'Diffuse sky',
        'Sun’s height',
        'Angle to the panel',
      ]);
      for (const q of sd.samples) {
        if (q.sun_alt_apparent_deg < -1) continue;
        hours.body.append(
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, timeButton(q.jd_utc, zone)),
            h('td', { 'data-csv': q.poa_w_m2.toFixed(1) }, String(Math.round(q.poa_w_m2))),
            h('td', { 'data-csv': q.ghi_w_m2.toFixed(1) }, String(Math.round(q.ghi_w_m2))),
            h('td', { 'data-csv': q.dni_w_m2.toFixed(1) }, String(Math.round(q.dni_w_m2))),
            h('td', { 'data-csv': q.dhi_w_m2.toFixed(1) }, String(Math.round(q.dhi_w_m2))),
            h('td', { 'data-csv': q.sun_alt_apparent_deg.toFixed(2) }, `${q.sun_alt_apparent_deg.toFixed(1)}°`),
            h('td', { 'data-csv': q.incidence_deg === null ? '' : q.incidence_deg.toFixed(2) }, q.incidence_deg === null ? '—' : `${q.incidence_deg.toFixed(1)}°`),
          ),
        );
      }
      out.push(hours.table);
    }
    out.push(days.table);
    return out;
  }
};
