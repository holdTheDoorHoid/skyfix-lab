/**
 * The Moon through the year (charts2 agent, expansion programme Q5): how high the Moon stands
 * and in which direction, at one hour of the evening (or any hour), on every day of the
 * year, with the new and full Moons along the top. OWNER: charts2 agent.
 *
 * At a fixed hour the Moon comes back to the same place in the sky only once a month (it
 * rises about 50 minutes later each day), so the dots climb and fall with each lunation;
 * the full Moons stand highest in winter, as the Sun does in summer. `sample_bodies`, one
 * exact sample a day (moon-year-data.ts); the phases are `moon_phases`, shared with the Year
 * chart and drawn after the dots.
 */

import { h, s } from '../../dom.js';
import { observerKey } from '../component.js';
import type { PhaseEvent } from '../engine/types.js';
import { setTime, stepTime } from '../playback.js';
import { axisTime, currentHourCycle } from '../shell/format.js';
import { displayZone, engineObserver, type ExplorerState } from '../state.js';
import { jdFromWallClock, zoneLabel } from '../time.js';
import { localDayCache, mountChart, placeName, type Shell } from './chart-shell.js';
import { altitude, bearing, clock, dateShort, dayMonth, MONTHS_LONG } from './format.js';
import { errorText, phaseGlyph, round, stepperNav, svgText, table, timeButton, tipHead, tipRow, tooltip, type ChartComponent, type Tooltip } from './frame.js';
import { frameRect, monthGrid, monthLabels, panelTitle, svgRoot, todayOnAxis, yearAxis, type MonthLabel, type YearAxis } from './plot.js';
import { clamp, linearScale } from './scale.js';
import { computeMoonYear, MOON_YEAR_DEFAULT_HOUR, type MoonYearData, type MoonYearInput } from './moon-year-data.js';
import { yearSkyMemo } from './year-chart.js';
import type { YearSky } from './year-data.js';
import { dateKey, localDateOf, zoneKey } from './windows.js';
import { dayOfYearOf } from './sun-data.js';
import { formatYear } from '../time/format.js';

/** The hour, remembered for the page's lifetime. */
let chosenHour = MOON_YEAR_DEFAULT_HOUR;

const PHASE_WORDS: Record<PhaseEvent['kind'], string> = {
  new_moon: 'New Moon',
  first_quarter: 'First quarter',
  full_moon: 'Full Moon',
  last_quarter: 'Last quarter',
};

export const moonYearChart: ChartComponent = (host, ctx, ui) => {
  const dayOf = localDayCache();
  let tip: Tooltip | null = null;
  let sky: YearSky | null = null;
  let skyKey = '';
  let geom: { axis: YearAxis; top: number; bottom: number; svg: SVGSVGElement; months: MonthLabel[]; data: MoonYearData } | null = null;
  const hourSelect = h('select', { class: 'sfc-select', 'aria-label': 'Hour of the local clock' });
  let hoursKey = '';

  const inputFor = (state: ExplorerState): MoonYearInput => {
    const zone = displayZone(state);
    return { observer: engineObserver(state), zone, year: dayOf(state.time.jd_utc, zone).date.year, hour: chosenHour };
  };

  let gone = false;
  const mounted = mountChart<MoonYearInput, MoonYearData>(host, ctx, ui, {
    kind: 'moonyear',
    heading: 'The Moon through the year',
    heavy: true,
    input: inputFor,
    key: (i) => [observerKey(i.observer), zoneKey(i.zone), i.year, i.hour].join('|'),
    compute: (input) => computeMoonYear(ctx.engine, input),
    failureText: (error, input) => `The engine could not follow the Moon through ${formatYear(input.year)}: ${errorText(error)}`,
    setup(shell) {
      stepperNav(shell.c.nav, 'Previous year', 'Next year', (dir) => stepTime(ctx.store, { unit: 'year', count: dir }));
      fillHours(displayZone(ctx.store.get()));
      hourSelect.addEventListener('change', () => {
        chosenHour = Number(hourSelect.value);
        shell.refresh();
      });
      shell.c.actions.append(h('label', { class: 'sfc-control' }, h('span', {}, 'At'), hourSelect));
      tip = tooltip(shell.c.plot);
      shell.c.legend.replaceChildren(
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-dot sfc-key-dot--moon', 'aria-hidden': 'true' }), 'The Moon up'),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-dot sfc-key-dot--below', 'aria-hidden': 'true' }), 'below the horizon'),
        h('span', { class: 'sfc-legend-item' }, phaseGlyph('new_moon', 7, 7, 7, false), 'New'),
        h('span', { class: 'sfc-legend-item' }, phaseGlyph('full_moon', 7, 7, 7, false), 'Full'),
      );
      return undefined;
    },
    header(shell) {
      const st = ctx.store.get();
      const i = shell.input;
      shell.c.title.replaceChildren(`The Moon through the year · ${formatYear(i.year)}`);
      if (st.settings.navigatorTerms) shell.c.title.append(h('span', { class: 'sfc-term', 'data-term': '' }, ' · altitude and azimuth at a fixed hour'));
      const jd = jdFromWallClock({ year: i.year, month: 1, day: 1, hour: i.hour }, i.zone);
      const clockName = i.zone.kind === 'iana' ? `${i.zone.zone}, with its daylight saving` : i.zone.name;
      shell.c.subtitle.textContent = `${placeName(st)} · the Moon at ${axisTime(jd, i.zone)} every day on the local clock (${clockName})`;
      const label = shell.c.nav.querySelector('.sfc-nav-label');
      if (label) label.textContent = formatYear(i.year);
      fillHours(i.zone);
      hourSelect.value = String(i.hour);
    },
    draw: (shell) => draw(shell),
    cursor: (shell) => placeToday(shell),
    table: (shell) => tables(shell),
    displayKey: (st) => `${st.settings.angleFormat}|${st.settings.navigatorTerms}`,
    fileParts: (shell) => ['moon-through-the-year', shell.input.year, `${String(shell.input.hour).padStart(2, '0')}h`],
    labels: () => ['Heights are what the eye sees (apparent altitude, refraction included); bearings from true north.'],
  });
  const destroy = (): void => {
    gone = true;
    mounted.destroy();
  };

  /** The hour picker's options, written on the person's clock (24- or 12-hour). */
  function fillHours(zone: MoonYearInput['zone']): void {
    const key = `${zoneKey(zone)}|${currentHourCycle()}`;
    if (key === hoursKey) return;
    hoursKey = key;
    const options: HTMLOptionElement[] = [];
    for (let hr = 0; hr < 24; hr += 1) {
      // Any winter date will do: only the clock's form matters.
      const jd = jdFromWallClock({ year: 2001, month: 1, day: 1, hour: hr }, zone);
      options.push(h('option', { value: String(hr), selected: hr === chosenHour }, axisTime(jd, zone)));
    }
    hourSelect.replaceChildren(...options);
    hourSelect.value = String(chosenHour);
  }

  function draw(shell: Shell<MoonYearInput, MoonYearData>): SVGSVGElement {
    const data = shell.data!;
    const W = shell.width;
    const narrow = W < 560;
    const x0 = narrow ? 40 : 52;
    const x1 = W - (narrow ? 8 : 14);
    const axis = yearAxis(data.input.year, x0, x1);
    const strip = 20;
    const top = strip + 22;
    const altH = Math.round(clamp(W * 0.26, 170, 280));
    const gap = 30;
    const azH = Math.round(altH * 0.8);
    const altBottom = top + altH;
    const azTop = altBottom + gap;
    const azBottom = azTop + azH;
    const axisY = azBottom + 16;
    const H = axisY + 12;
    const svg = svgRoot(W, H, summary(shell));
    const alts = data.days.map((d) => d.alt);
    const lo = Math.max(-90, Math.floor((Math.min(0, ...alts) - 5) / 10) * 10);
    const hi = Math.min(90, Math.ceil((Math.max(10, ...alts) + 5) / 10) * 10);
    const ya = linearScale([lo, hi], [altBottom, top]);
    const yz = linearScale([0, 360], [azTop, azBottom]);

    svg.append(monthGrid(axis, top, azBottom));
    // Height: the ground below the horizon.
    const zero = ya(0);
    svg.append(s('rect', { class: 'sfc-ground', x: x0, y: round(zero), width: x1 - x0, height: round(Math.max(0, altBottom - zero)) }));
    const grid = s('g', { class: 'sfc-grid' });
    const ticks = s('g', { class: 'sfc-axis' });
    const altStep = hi - lo > 100 ? 30 : 15;
    for (let v = Math.ceil(lo / altStep) * altStep; v <= hi; v += altStep) {
      const y = round(ya(v)) + 0.5;
      grid.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, class: v === 0 ? '' : 'sfc-grid--faint' }));
      ticks.append(svgText(x0 - 6, y + 3.5, `${v < 0 ? '−' : ''}${Math.abs(v)}°`, { 'text-anchor': 'end' }));
    }
    for (const [v, name] of [
      [0, 'N'],
      [90, 'E'],
      [180, 'S'],
      [270, 'W'],
      [360, 'N'],
    ] as const) {
      const y = round(yz(v)) + 0.5;
      grid.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'sfc-grid--faint' }));
      ticks.append(svgText(x0 - 6, y + 3.5, name, { 'text-anchor': 'end', class: 'sfc-compass--main' }));
    }
    svg.append(
      grid,
      ticks,
      panelTitle(x0, top - 6, 'Height above the horizon', 'what the eye sees'),
      panelTitle(x0, azTop - 6, 'Bearing', 'north at the top and bottom'),
    );
    const dots = s('g', { class: 'sfc-moondots sfc-b-moon' });
    for (const d of data.days) {
      const x = round(axis.xs(d.index + 0.5));
      const up = d.alt >= 0;
      const cls = up ? 'sfc-moondot' : 'sfc-moondot sfc-moondot--below';
      dots.append(
        s('circle', { class: cls, cx: x, cy: round(ya(clamp(d.alt, lo, hi))), r: up ? 2.3 : 1.7 }),
        s('circle', { class: cls, cx: x, cy: round(yz(d.az)), r: up ? 2.3 : 1.7 }),
      );
    }
    svg.append(dots, frameRect(x0, top, x1, altBottom), frameRect(x0, azTop, x1, azBottom));

    // The phases along the top (after the dots: they are shared with the Year chart).
    const phases = s('g', { class: 'sfc-moonstrip' });
    const skyNow = sky && skyKey === `${zoneKey(data.input.zone)}|${data.input.year}` ? sky : null;
    if (skyNow) {
      for (const ev of skyNow.moonPhases) {
        if (ev.kind !== 'new_moon' && ev.kind !== 'full_moon') continue;
        const i = dayOfYearOf(dateKey(localDateOf(ev.jd_utc, data.input.zone)));
        if (!(i >= 0 && i < axis.n)) continue;
        const disc = phaseGlyph(ev.kind, axis.xs(i + 0.5), strip / 2 + 2, narrow ? 4.5 : 5.5, data.input.observer.lat_deg < 0);
        const title = s('title');
        title.textContent = `${PHASE_WORDS[ev.kind]} ${dayMonth(localDateOf(ev.jd_utc, data.input.zone))} ${clock(ev.jd_utc, data.input.zone)}`;
        disc.prepend(title);
        phases.append(disc);
      }
    } else {
      phases.append(svgText(x0, strip / 2 + 5, 'Moon phases…', { class: 'sfc-strip-label' }));
      const k = `${zoneKey(data.input.zone)}|${data.input.year}`;
      setTimeout(() => {
        if (gone || !geom || geom.data !== data) return;
        try {
          sky = yearSkyMemo(ctx, data.input.zone, data.input.year);
          skyKey = k;
        } catch {
          sky = null;
        }
        shell.redraw();
      }, 0);
    }
    svg.append(phases);

    const months = monthLabels(axis, axisY, narrow);
    svg.append(months.g, s('g', { class: 'sfc-today-layer' }));
    const hover = s('g', { class: 'sfc-hover', 'pointer-events': 'none' }) as SVGGElement;
    svg.append(hover);
    geom = { axis, top, bottom: azBottom, svg, months: months.labels, data };
    svg.addEventListener('pointermove', (event) => onHover(event, shell, hover));
    svg.addEventListener('pointerleave', () => {
      tip?.hide();
      hover.replaceChildren();
    });
    svg.addEventListener('click', (event) => {
      const d = dayAt(event);
      if (d) setTime(ctx.store, d.jd);
    });
    svg.style.cursor = 'crosshair';
    shell.c.plot.replaceChildren(svg, tip!.el);
    placeToday(shell);
    shell.c.caption.replaceChildren(
      summary(shell),
      ' ',
      h('span', { class: 'sfc-muted' }, 'Each dot is one day; faint dots: the Moon is below the horizon then. Click a day to go to it.'),
    );
    const notes: HTMLElement[] = [];
    if (data.missing) notes.push(h('p', { class: 'sfc-note' }, `${data.missing} day${data.missing === 1 ? ' is' : 's are'} outside the engine’s coverage and left out.`));
    for (const e of data.errors) notes.push(h('p', { class: 'sfc-note' }, e));
    shell.c.notes.replaceChildren(...notes);
    return svg;
  }

  function dayAt(event: MouseEvent): MoonYearData['days'][number] | null {
    if (!geom) return null;
    const rect = geom.svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (px < geom.axis.x0 || px > geom.axis.x1 || py < geom.top - 4 || py > geom.bottom + 4) return null;
    const i = clamp(Math.floor(geom.axis.xs.invert(px)), 0, geom.axis.n - 1);
    return geom.data.days.find((d) => d.index === i) ?? null;
  }

  function onHover(event: PointerEvent, shell: Shell<MoonYearInput, MoonYearData>, layer: SVGGElement): void {
    const d = dayAt(event);
    if (!d || !geom || !tip) {
      tip?.hide();
      layer.replaceChildren();
      return;
    }
    const fmt = ctx.store.get().settings.angleFormat;
    const x = round(geom.axis.xs(d.index + 0.5)) + 0.5;
    layer.replaceChildren(s('line', { x1: x, x2: x, y1: geom.top, y2: geom.bottom }));
    const rect = geom.svg.getBoundingClientRect();
    tip.show(event.clientX - rect.left, event.clientY - rect.top, [
      tipHead(dateShort(d.day.date), clock(d.jd, shell.input.zone)),
      tipRow(altitude(d.alt, fmt), d.alt >= 0 ? 'above the horizon' : 'below the horizon'),
      tipRow(bearing(d.az), 'bearing'),
    ]);
  }

  function placeToday(shell: Shell<MoonYearInput, MoonYearData>): void {
    if (!geom) return;
    const st = ctx.store.get();
    const date = localDateOf(st.time.jd_utc, displayZone(st));
    const index = date.year === shell.input.year ? dayOfYearOf(dateKey(date)) : -1;
    geom.svg.querySelector('.sfc-today-layer')?.replaceChildren(todayOnAxis(geom.axis, index, [[geom.top, geom.bottom]], geom.bottom + 16, dayMonth(date), geom.months));
  }

  function summary(shell: Shell<MoonYearInput, MoonYearData>): string {
    const data = shell.data;
    if (!data || !data.days.length) return 'The Moon’s height and bearing at one hour, every day of the year.';
    const fmt = ctx.store.get().settings.angleFormat;
    const up = data.days.filter((d) => d.alt >= 0).length;
    let best = data.days[0]!;
    for (const d of data.days) if (d.alt > best.alt) best = d;
    const jd = jdFromWallClock({ year: data.input.year, month: 1, day: 1, hour: data.input.hour }, data.input.zone);
    return `At ${axisTime(jd, data.input.zone)} the Moon is above the horizon on ${up} of ${data.days.length} days; highest on ${dayMonth(best.day.date)} (${altitude(best.alt, fmt)}, ${bearing(best.az)}). It comes back to the same part of the sky about once a month.`;
  }

  function tables(shell: Shell<MoonYearInput, MoonYearData>): HTMLElement[] {
    const data = shell.data!;
    const st = ctx.store.get();
    const fmt = st.settings.angleFormat;
    const zone = data.input.zone;
    const t = table(`The Moon every day of ${formatYear(data.input.year)} at the same hour (local times, ${zoneLabel(st.time.jd_utc, zone)}; negative heights below the horizon)`, [
      'Date',
      'Time',
      'Height above the horizon',
      'Bearing',
    ]);
    const today = dateKey(localDateOf(st.time.jd_utc, displayZone(st)));
    let month = 0;
    for (const d of data.days) {
      if (d.day.date.month !== month) {
        month = d.day.date.month;
        t.body.append(h('tr', { class: 'sfc-row-month' }, h('th', { scope: 'rowgroup', colspan: 4 }, `${MONTHS_LONG[month - 1]} ${formatYear(d.day.date.year)}`)));
      }
      t.body.append(
        h(
          'tr',
          { class: d.day.key === today ? 'sfc-row-current' : '' },
          h('th', { scope: 'row' }, dateShort(d.day.date)),
          h('td', {}, timeButton(d.jd, zone)),
          h('td', { 'data-csv': d.alt.toFixed(3) }, altitude(d.alt, fmt)),
          h('td', { 'data-csv': d.az.toFixed(2) }, bearing(d.az)),
        ),
      );
    }
    return [t.table];
  }

  return { destroy };
};
