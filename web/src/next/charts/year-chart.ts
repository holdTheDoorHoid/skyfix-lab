/**
 * The year chart, a "sunrise and sunset calendar": for every day of the observer's year in
 * the display zone, the sky's phases from midnight to midnight on the local clock, with the
 * sunrise and sunset lines, the equinoxes and solstices, the Moon's phases along the top,
 * the clock changes, and the day length below. OWNER: charts agent.
 *
 * Each day is one column drawn straight from the engine's phases for that local day
 * (`day_events_batch`, one call for the year), so nothing is smoothed: the day the clocks
 * change, sunrise really jumps by an hour, and the chart shows the jump and labels it.
 * Midnight sun and polar night need no special drawing (a column is all day or all night)
 * and are bracketed and named above the plot.
 */

import { h, s } from '../../dom.js';
import { disposer, memoize, observerKey, watch, type Ctx } from '../component.js';
import type { PhaseEvent, SeasonEvent, SunEventKind } from '../engine/types.js';
import { setTime, stepTime } from '../playback.js';
import { displayZone, engineObserver, eventOptions, type ExplorerState } from '../state.js';
import { zoneLabel, type Zone } from '../time.js';
import {
  clockAt,
  clockUtcFast,
  clockWithUtc,
  dateShort,
  dayMonth,
  duration,
  MONTHS_LONG,
  MONTHS_SHORT,
  offsetOn,
  signedOffsetChange,
  zoneNameAt,
} from './format.js';
import { OutsideCoverageError } from './coverage.js';
import {
  applyMode,
  bindTimeButtons,
  scrollToCurrent,
  card,
  errorText,
  glyph,
  message,
  mockBadge,
  observeWidth,
  overlaps,
  pill,
  round,
  stepperNav,
  svgText,
  table,
  textWidth,
  timeButtonText,
  tipHead,
  tipRow,
  phaseGlyph,
  tooltip,
  uid,
  type Box,
  type ChartComponent,
} from './frame.js';
import { PHASE_LABELS, PHASES_DARK_TO_LIGHT } from './palette.js';
import { clamp, linearScale, type LinearScale } from './scale.js';
import { jdAtWallHours, localDateOf, zoneKey, type LocalDay } from './windows.js';
import {
  atLeast,
  computeYear,
  computeYearSky,
  eventsOf,
  SUN_EVENT_ORDER,
  type YearData,
  type YearDay,
  type YearInput,
  type YearSky,
} from './year-data.js';
import { phaseRank } from './day-data.js';

export const yearMemo = memoize(
  (ctx: Ctx, input: YearInput) => computeYear(ctx.engine, input),
  (ctx, input) =>
    [ctx.engine.kind, observerKey(input.observer), zoneKey(input.zone), input.year, input.options.horizon, input.options.height_of_eye_m].join('|'),
  4,
);

export const yearSkyMemo = memoize(
  (ctx: Ctx, zone: Zone, year: number) => computeYearSky(ctx.engine, zone, year),
  (ctx, zone, year) => `${ctx.engine.kind}|${zoneKey(zone)}|${year}`,
  4,
);

export function yearInputFor(state: ExplorerState): YearInput {
  const zone = displayZone(state);
  return { observer: engineObserver(state), zone, year: localDateOf(state.time.jd_utc, zone).year, options: eventOptions(state) };
}

const EVENT_LABELS: Record<SunEventKind, string> = {
  astronomical_dawn: 'Astronomical dawn',
  nautical_dawn: 'Nautical dawn',
  civil_dawn: 'Civil dawn',
  rise: 'Sunrise',
  transit: 'Solar noon',
  set: 'Sunset',
  civil_dusk: 'Civil dusk',
  nautical_dusk: 'Nautical dusk',
  astronomical_dusk: 'Astronomical dusk',
  lower_transit: 'Lower transit',
};

const SEASON_LABELS: Record<SeasonEvent['kind'], string> = {
  march_equinox: 'Equinox',
  june_solstice: 'Solstice',
  september_equinox: 'Equinox',
  december_solstice: 'Solstice',
};

const MOON_LABELS: Record<PhaseEvent['kind'], string> = {
  new_moon: 'New Moon',
  first_quarter: 'First quarter',
  full_moon: 'Full Moon',
  last_quarter: 'Last quarter',
};

interface Geometry {
  data: YearData;
  zone: Zone;
  xs: LinearScale;
  ys: LinearScale;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  width: number;
}

/** Index of the day containing `jd` (days back to back), or -1. */
export function dayIndexAt(days: readonly { day: LocalDay }[], jd: number): number {
  let lo = 0;
  let hi = days.length - 1;
  if (hi < 0 || jd < days[0]!.day.jd_start || jd >= days[hi]!.day.jd_end) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (days[mid]!.day.jd_start <= jd) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Fractional day position of an instant: the day's index plus the elapsed part of it. */
function dayPosition(days: readonly YearDay[], jd: number): number | null {
  const i = dayIndexAt(days, jd);
  if (i < 0) return null;
  const d = days[i]!.day;
  return i + (jd - d.jd_start) / (d.jd_end - d.jd_start);
}

export const yearChart: ChartComponent = (host, ctx, ui) => {
  const { store } = ctx;
  const d = disposer();
  const c = card('year', 'Sunrise, sunset and twilight');
  host.append(c.root);
  d.add(() => c.root.remove());

  let width = 0;
  let data: YearData | null = null;
  let sky: YearSky | null = null;
  let failure: string | null = null;
  let geom: Geometry | null = null;
  let svg: SVGSVGElement | null = null;
  let todayLayer: SVGGElement | null = null;
  let hoverLayer: SVGGElement | null = null;
  let hover: { index: number; hours: number; x: number; y: number } | null = null;
  let monthLabels: { el: SVGTextElement; x: number }[] = [];
  const clipId = uid('sfc-clip-year');

  const tip = tooltip(c.plot);
  const nav = stepperNav(c.nav, 'Previous year', 'Next year', (dir) => stepTime(store, { unit: 'year', count: dir }));

  // --- data --------------------------------------------------------------------------------
  let yearCache: { key: string; start: number; end: number; input: YearInput } | null = null;
  function inputFor(s2: ExplorerState): YearInput {
    const zone = displayZone(s2);
    const key = `${observerKey(engineObserver(s2))}|${zoneKey(zone)}|${s2.settings.horizon}|${s2.settings.height_of_eye_m}`;
    const jd = s2.time.jd_utc;
    if (yearCache && yearCache.key === key && jd >= yearCache.start && jd < yearCache.end) return yearCache.input;
    const input = yearInputFor(s2);
    const next = { key, start: Number.NaN, end: Number.NaN, input };
    yearCache = next;
    return input;
  }

  function recompute(): void {
    const input = inputFor(store.get());
    try {
      data = yearMemo(ctx, input);
      failure = null;
      if (yearCache) {
        yearCache.start = data.days[0]!.day.jd_start;
        yearCache.end = data.days[data.days.length - 1]!.day.jd_end;
      }
      c.root.dataset.compute = `year ${data.timing.totalMs.toFixed(0)} ms (batch ${data.timing.batchMs.toFixed(0)})`;
    } catch (error) {
      data = null;
      failure = error instanceof OutsideCoverageError ? error.message : `The engine could not compute this year: ${errorText(error)}`;
    }
    sky = null;
  }

  /** Moon phases and seasons: after the first drawing, since they do not depend on the place. */
  let alive = true;
  d.add(() => {
    alive = false;
  });
  const loadSky = (): void => {
    if (!alive || !data || sky) return;
    sky = yearSkyMemo(ctx, data.input.zone, data.input.year);
    drawDirty = true;
    frame();
    if (ui.get().mode === 'table') renderTable();
  };

  // --- header and legend -------------------------------------------------------------------
  function renderHeader(): void {
    const s2 = store.get();
    const input = inputFor(s2);
    c.title.replaceChildren(`Sunrise, sunset and twilight · ${input.year}`);
    if (ctx.engine.kind === 'mock') c.title.append(mockBadge(ctx.engine.description));
    const place = s2.observer.label || `${s2.observer.lat_deg.toFixed(3)}°, ${s2.observer.lon_deg.toFixed(3)}°`;
    c.subtitle.textContent = `${place} · every day of ${input.year} on the local clock, ${zoneLabel(s2.time.jd_utc, input.zone)}`;
    nav.textContent = String(input.year);
  }

  function renderLegend(): void {
    const items: Node[] = PHASES_DARK_TO_LIGHT.map((p) =>
      h('span', { class: 'sfc-legend-item' }, h('span', { class: `sfc-swatch sfc-swatch--${p}`, 'aria-hidden': 'true' }), PHASE_LABELS[p]),
    );
    items.push(
      h('span', { class: 'sfc-legend-sep', 'aria-hidden': 'true' }),
      h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-line sfc-key-line--rise', 'aria-hidden': 'true' }), 'Sunrise (dashed)'),
      h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-line sfc-key-line--set', 'aria-hidden': 'true' }), 'Sunset (dotted)'),
      h('span', { class: 'sfc-legend-sep', 'aria-hidden': 'true' }),
      h('span', { class: 'sfc-legend-item' }, legendGlyph('new_moon'), 'New'),
      h('span', { class: 'sfc-legend-item' }, legendGlyph('first_quarter'), 'First quarter'),
      h('span', { class: 'sfc-legend-item' }, legendGlyph('full_moon'), 'Full'),
      h('span', { class: 'sfc-legend-item' }, legendGlyph('last_quarter'), 'Last quarter'),
    );
    c.legend.replaceChildren(...items);
  }

  function legendGlyph(kind: PhaseEvent['kind']): SVGSVGElement {
    return phaseGlyph(kind, 7, 7, 7, store.get().observer.lat_deg < 0);
  }

  // --- drawing -----------------------------------------------------------------------------
  function draw(): void {
    renderHeader();
    if (failure !== null) {
      message(c.plot, failure);
      c.plot.append(tip.el);
      svg = null;
      geom = null;
      c.root.dataset.ready = '1';
      return;
    }
    if (!data || width <= 0) return;
    const zone = data.input.zone;
    const days = data.days;
    const n = days.length;
    const south = store.get().observer.lat_deg < 0;
    const narrow = width < 560;
    const W = width;
    const polarRow = data.polar.length ? 20 : 0;
    const margin = { left: narrow ? 38 : 46, right: narrow ? 6 : 12, top: 30 + polarRow };
    const plotH = Math.round(clamp(W * 0.36, 240, 440));
    const x0 = margin.left;
    const x1 = W - margin.right;
    const y0 = margin.top;
    const y1 = y0 + plotH;
    const axisH = 24;
    const dlTop = y1 + axisH + 14;
    const dlH = narrow ? 70 : 92;
    const dlBottom = dlTop + dlH;
    const H = dlBottom + 8;
    const xs = linearScale([0, n], [x0, x1]);
    const ys = linearScale([0, 24], [y0, y1]);
    const dly = linearScale([0, 24], [dlBottom, dlTop]);
    geom = { data, zone, xs, ys, x0, x1, y0, y1, width: W };

    const root = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': summaryText() }) as SVGSVGElement;

    // Phases: night underneath, then each lighter phase as nested layers (no seams).
    const defs = s('defs');
    const clipCp = s('clipPath', { id: clipId });
    clipCp.append(s('rect', { x: x0, y: y0, width: x1 - x0, height: plotH }));
    defs.append(clipCp);
    root.append(defs);
    const bands = s('g', { class: 'sfc-bands', 'clip-path': `url(#${clipId})` });
    bands.append(s('rect', { class: 'sfc-ph-night', x: x0, y: y0, width: x1 - x0, height: plotH }));
    const colW = (x1 - x0) / n;
    for (const phase of PHASES_DARK_TO_LIGHT.slice(1)) {
      const rank = phaseRank(phase);
      let dStr = '';
      for (const day of days) {
        const xa = round(xs(day.index));
        const w = round(colW + 0.6);
        for (const [from, to] of atLeast(day, rank, phaseRank)) {
          dStr += `M${xa} ${round(ys(from))}h${w}V${round(ys(to))}h${-w}Z`;
        }
      }
      if (dStr) bands.append(s('path', { class: `sfc-ph-${phase}`, d: dStr }));
    }
    root.append(bands);

    // Grid: every 3 hours, and the months.
    const grid = s('g', { class: 'sfc-grid' });
    for (let hr = 3; hr < 24; hr += 3) {
      const y = round(ys(hr)) + 0.5;
      grid.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, class: hr % 6 ? 'sfc-grid--faint' : '' }));
    }
    const monthStarts: number[] = [];
    for (const day of days) if (day.day.date.day === 1) monthStarts.push(day.index);
    for (const i of monthStarts) {
      if (i === 0) continue;
      const x = round(xs(i)) + 0.5;
      grid.append(s('line', { x1: x, x2: x, y1: y0, y2: y1 }), s('line', { x1: x, x2: x, y1: dlTop, y2: dlBottom, class: 'sfc-grid--faint' }));
    }
    root.append(grid);

    // Sunrise and sunset lines, broken where the Sun does not rise or set, stepping honestly
    // across a clock change.
    const lines = s('g', {});
    for (const kind of ['rise', 'set'] as const) {
      let dStr = '';
      let prev: number | null = null;
      for (const day of days) {
        const evs = eventsOf(day, kind);
        const ev = evs.length ? (kind === 'rise' ? evs[0]! : evs[evs.length - 1]!) : null;
        if (!ev) {
          prev = null;
          continue;
        }
        const x = xs(day.index + 0.5);
        const y = ys(clamp(ev.hour, 0, 24));
        dStr += `${prev === null || Math.abs(ev.hour - prev) > 3 ? 'M' : 'L'}${round(x)} ${round(y)}`;
        prev = ev.hour;
      }
      if (!dStr) continue;
      lines.append(s('path', { class: 'sfc-sunline-casing', d: dStr }), s('path', { class: `sfc-sunline sfc-sunline--${kind}`, d: dStr }));
    }
    root.append(lines);

    // Seasons.
    const labelBoxes: Box[] = [];
    const seasons = s('g', { class: 'sfc-season' });
    for (const ev of sky?.seasons ?? []) {
      const pos = dayPosition(days, ev.jd_utc);
      if (pos === null) continue;
      const x = round(xs(pos)) + 0.5;
      seasons.append(s('line', { x1: x, x2: x, y1: y0, y2: y1 }));
      const date = localDateOf(ev.jd_utc, zone);
      for (const [text, dy] of [
        [`${SEASON_LABELS[ev.kind]} ${dayMonth(date)}`, 0],
        [`${SEASON_LABELS[ev.kind]} ${dayMonth(date)}`, -20],
        [dayMonth(date), 0],
      ] as const) {
        const lp = pill(x, y1 - 11 + dy, text, { size: 10 });
        const shift = clamp(x, x0 + lp.box.w / 2 + 2, x1 - lp.box.w / 2 - 2) - x;
        const box = { ...lp.box, x: lp.box.x + shift };
        if (labelBoxes.some((b) => overlaps(b, box))) continue;
        if (shift) lp.el.setAttribute('transform', `translate(${round(shift)} 0)`);
        labelBoxes.push(box);
        seasons.append(lp.el);
        break;
      }
    }
    root.append(seasons);

    // Clock changes: a marker at the top of the column and a label.
    const changes = s('g', { class: 'sfc-clockchange' });
    for (const cc of data.clockChanges) {
      const i = cc.day.jd_start;
      const pos = dayPosition(days, i);
      if (pos === null) continue;
      const x = xs(pos + 0.5);
      const text = `Clocks ${signedOffsetChange(cc.toOffsetMs - cc.fromOffsetMs)}`;
      const lp = pill(x, y0 + 11, text, { size: 10 });
      const shift = clamp(x, x0 + lp.box.w / 2 + 2, x1 - lp.box.w / 2 - 2) - x;
      let dy = 0;
      if (labelBoxes.some((b) => overlaps(b, { ...lp.box, x: lp.box.x + shift }))) dy = 20;
      lp.el.setAttribute('transform', `translate(${round(shift)} ${dy})`);
      labelBoxes.push({ ...lp.box, x: lp.box.x + shift, y: lp.box.y + dy });
      changes.append(lp.el);
    }
    root.append(changes);

    // Polar day and night brackets above the plot.
    if (data.polar.length) {
      const polar = s('g', { class: 'sfc-polar' });
      const yb = y0 - 8;
      for (const run of data.polar) {
        const a = xs(run.first);
        const b = xs(run.last + 1);
        polar.append(s('path', { d: `M${round(a)} ${yb + 5}V${yb}H${round(b)}V${yb + 5}` }));
        const first = days[run.first]!.day.date;
        const last = days[run.last]!.day.date;
        const name = run.kind === 'midnight_sun' ? 'Midnight sun' : 'Polar night';
        const text = `${name} ${dayMonth(first)} – ${dayMonth(last)}`;
        const lp = pill((a + b) / 2, yb - 8, text, { size: 10 });
        const mid = (a + b) / 2;
        const shift = clamp(mid, lp.box.w / 2 + 2, W - lp.box.w / 2 - 2) - mid;
        if (shift) lp.el.setAttribute('transform', `translate(${round(shift)} 0)`);
        polar.append(lp.el);
      }
      root.append(polar);
    }

    // Moon phases along the top.
    const strip = s('g', { class: 'sfc-moonstrip' });
    const ym = polarRow ? 10 : 12;
    // Where the quarters would crowd each other, only new and full moons.
    const phases = sky?.moonPhases ?? [];
    const crowded = phases.length > 0 && (x1 - x0) / phases.length < 13;
    for (const ev of crowded ? phases.filter((p) => p.kind === 'new_moon' || p.kind === 'full_moon') : phases) {
      const pos = dayPosition(days, ev.jd_utc);
      if (pos === null) continue;
      const disc = phaseGlyph(ev.kind, xs(pos), ym, narrow ? 4.5 : 5.5, south);
      const title = s('title', {});
      title.textContent = `${MOON_LABELS[ev.kind]} ${dayMonth(localDateOf(ev.jd_utc, zone))} ${clockWithUtc(ev.jd_utc, zone)}`;
      disc.prepend(title);
      strip.append(disc);
    }
    if (!sky) strip.append(svgText(x0, ym + 3.5, 'Moon phases…', { class: 'sfc-strip-label' }));
    root.append(strip);

    // Axes.
    const axis = s('g', { class: 'sfc-axis' });
    for (let hr = 0; hr <= 24; hr += narrow ? 6 : 3) {
      axis.append(svgText(x0 - 6, ys(hr) + 3.5, `${String(hr).padStart(2, '0')}:00`, { 'text-anchor': 'end' }));
    }
    monthLabels = [];
    for (const i of monthStarts) {
      const date = days[i]!.day.date;
      const next = monthStarts.find((j) => j > i) ?? n;
      const label = narrow ? MONTHS_SHORT[date.month - 1]!.charAt(0) : MONTHS_SHORT[date.month - 1]!;
      const t = svgText(xs((i + next) / 2), y1 + 16, label, { 'text-anchor': 'middle' });
      monthLabels.push({ el: t, x: xs((i + next) / 2) });
      axis.append(t);
    }
    axis.append(s('line', { x1: x0, x2: x1, y1: y1 + 0.5, y2: y1 + 0.5 }));
    for (const hr of [0, 12, 24]) axis.append(svgText(x0 - 6, dly(hr) + 3.5, `${hr} h`, { 'text-anchor': 'end' }));
    axis.append(svgText(x0, dlTop - 5, 'Day length (Sun above the horizon)', { class: 'sfc-axis-title' }));
    root.append(axis);

    // Day length.
    const dl = s('g', {});
    dl.append(
      s('line', { class: 'sfc-frame', x1: x0, x2: x1, y1: round(dly(12)) + 0.5, y2: round(dly(12)) + 0.5 }),
      s('rect', { class: 'sfc-frame', x: x0 + 0.5, y: dlTop + 0.5, width: x1 - x0 - 1, height: dlH - 1 }),
    );
    let line = '';
    let area = '';
    let open = false;
    let firstX = 0;
    let lastX = 0;
    for (const day of days) {
      if (day.dayLengthH === null || day.error) {
        if (open) area += `L${round(lastX)} ${round(dly(0))}L${round(firstX)} ${round(dly(0))}Z`;
        open = false;
        continue;
      }
      const x = xs(day.index + 0.5);
      const y = dly(clamp(day.dayLengthH, 0, 24));
      if (!open) {
        line += `M${round(x)} ${round(y)}`;
        area += `M${round(x)} ${round(y)}`;
        firstX = x;
        open = true;
      } else {
        line += `L${round(x)} ${round(y)}`;
        area += `L${round(x)} ${round(y)}`;
      }
      lastX = x;
    }
    if (open) area += `L${round(lastX)} ${round(dly(0))}L${round(firstX)} ${round(dly(0))}Z`;
    dl.append(s('path', { class: 'sfc-daylen-area', d: area }), s('path', { class: 'sfc-daylen-line', d: line }));
    const ext = s('g', { class: 'sfc-extreme' });
    const extBoxes: Box[] = [];
    for (const [which, e] of [
      ['Longest', data.longest && data.longest.hours < 23.99 ? data.longest : null],
      ['Shortest', data.shortest && data.shortest.hours > 0.01 ? data.shortest : null],
    ] as const) {
      if (!e || (data.longest && data.shortest && data.longest.hours === data.shortest.hours)) continue;
      const x = xs(e.index + 0.5);
      const y = dly(e.hours);
      ext.append(s('circle', { cx: round(x), cy: round(y), r: 4 }));
      const text = `${which} ${duration(e.hours)}, ${dayMonth(days[e.index]!.day.date)}`;
      const anchorRight = x > (x0 + x1) / 2;
      const w = textWidth(text, 10.5);
      const tx = x + (anchorRight ? -8 : 8);
      // Longest below its point, shortest above; the other side if that collides.
      for (const dy of which === 'Longest' ? [13, -7] : [-7, 13]) {
        const ty = clamp(y + dy, dlTop + 10, dlBottom - 4);
        const box = { x: anchorRight ? tx - w : tx, y: ty - 10, w, h: 12 };
        if (extBoxes.some((b) => overlaps(b, box))) continue;
        extBoxes.push(box);
        ext.append(svgText(tx, ty, text, { 'text-anchor': anchorRight ? 'end' : 'start' }));
        break;
      }
    }
    dl.append(ext);
    root.append(dl);

    root.append(s('rect', { class: 'sfc-frame', x: x0 + 0.5, y: y0 + 0.5, width: x1 - x0 - 1, height: plotH - 1 }));

    todayLayer = s('g', { class: 'sfc-today', 'pointer-events': 'none' }) as SVGGElement;
    hoverLayer = s('g', { class: 'sfc-hover', 'pointer-events': 'none' }) as SVGGElement;
    hoverLayer.style.display = 'none';
    root.append(todayLayer, hoverLayer);

    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerleave', hideHover);
    root.addEventListener('click', onClick);
    root.style.cursor = 'crosshair';

    c.plot.replaceChildren(root, tip.el);
    svg = root;
    placeToday();
    if (hover) drawHover();
    renderCaption();
    if (ui.get().mode === 'table') renderTable();
    c.root.dataset.ready = sky ? '1' : '0';
  }

  function placeToday(): void {
    if (!geom || !todayLayer) return;
    const { data: yd, xs, ys, y0, y1, x0, x1, zone } = geom;
    const jd = store.get().time.jd_utc;
    const i = dayIndexAt(yd.days, jd);
    todayLayer.replaceChildren();
    if (i < 0) return;
    const day = yd.days[i]!;
    const x = xs(i + 0.5);
    const hr = (jd - day.day.jd_start) * 24 + (offsetOn(day.day, jd, zone) - day.day.offsetStartMs) / 3_600_000;
    todayLayer.append(
      s('line', { x1: round(x), x2: round(x), y1: y0, y2: y1 }),
      s('circle', { cx: round(x), cy: round(ys(clamp(hr, 0, 24))), r: 5 }),
    );
    const lp = pill(x, y1 + 16, dayMonth(day.day.date), { size: 11, cls: 'sfc-pill--accent' });
    const shift = clamp(x, x0 + lp.box.w / 2, x1 - lp.box.w / 2) - x;
    if (shift) lp.el.setAttribute('transform', `translate(${round(shift)} 0)`);
    todayLayer.append(lp.el);
    for (const m of monthLabels) m.el.style.visibility = Math.abs(m.x - (x + shift)) < lp.box.w / 2 + 14 ? 'hidden' : '';
  }

  // --- hover and click -----------------------------------------------------------------------
  function pointerAt(event: PointerEvent | MouseEvent): { index: number; hours: number; x: number; y: number } | null {
    if (!geom || !svg) return null;
    const rect = svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (px < geom.x0 || px > geom.x1 || py < geom.y0 - 2 || py > geom.y1 + 2) return null;
    const index = clamp(Math.floor(geom.xs.invert(px)), 0, geom.data.days.length - 1);
    return { index, hours: clamp(geom.ys.invert(py), 0, 23.99), x: px, y: py };
  }

  const hoverTask = (): void => drawHover();

  function onPointerMove(event: PointerEvent): void {
    const p = pointerAt(event);
    if (!p) {
      hideHover();
      return;
    }
    hover = p;
    ctx.scheduler.schedule(hoverTask);
  }

  function hideHover(): void {
    hover = null;
    if (hoverLayer) hoverLayer.style.display = 'none';
    tip.hide();
  }

  function onClick(event: MouseEvent): void {
    const p = pointerAt(event);
    if (!p || !geom) return;
    const day = geom.data.days[p.index]!;
    setTime(store, jdAtWallHours(day.day.date, Math.round(p.hours * 60) / 60, geom.zone));
  }

  function drawHover(): void {
    if (!geom || !hoverLayer || !hover) return;
    const { data: yd, xs, ys, y0, y1, zone } = geom;
    const day = yd.days[hover.index]!;
    const x = xs(hover.index + 0.5);
    hoverLayer.style.display = '';
    hoverLayer.replaceChildren(
      s('line', { x1: round(x) + 0.5, x2: round(x) + 0.5, y1: y0, y2: y1 }),
      s('circle', { class: 'sfc-hover-dot', cx: round(x), cy: round(ys(hover.hours)), r: 3.5 }),
    );
    const jdPointer = jdAtWallHours(day.day.date, Math.round(hover.hours * 60) / 60, zone);
    const off = offsetOn(day.day, day.day.jd_start + 0.5, zone);
    const rows: Node[] = [tipHead(dateShort(day.day.date), `${zoneNameAt(day.day.jd_start + 0.5, zone, off)} · pointer ${clockWithUtc(jdPointer, zone)}`)];
    if (day.error) rows.push(tipRow('—', day.error));
    else if (day.alwaysAbove) rows.push(tipRow('24 h', 'Sun up all day (midnight sun)', glyph('Sun', 'sun', 13)));
    else if (day.alwaysBelow) rows.push(tipRow('0 h', 'Sun below the horizon all day', glyph('Sun', 'sun', 13)));
    for (const kind of SUN_EVENT_ORDER) {
      if (kind === 'transit') continue;
      for (const ev of eventsOf(day, kind)) {
        rows.push(tipRow(clockAt(ev.jd, offsetOn(day.day, ev.jd, zone)), EVENT_LABELS[kind], undefined, clockUtcFast(ev.jd)));
      }
    }
    if (day.dayLengthH !== null && !day.alwaysAbove && !day.alwaysBelow) rows.push(tipRow(duration(day.dayLengthH), 'Day length'));
    if (day.clockChange) {
      const cc = day.clockChange;
      rows.push(
        h('div', { class: 'sfc-tip-sep' }),
        tipRow(
          signedOffsetChange(cc.toOffsetMs - cc.fromOffsetMs),
          `Clocks change at ${clockAt(cc.jd, cc.fromOffsetMs)} → ${clockAt(cc.jd, cc.toOffsetMs)}`,
        ),
      );
    }
    tip.show(x, hover.y, rows);
  }

  // --- caption and table -------------------------------------------------------------------
  function summaryText(): string {
    if (!data) return 'Sunrise, sunset and twilight through the year.';
    const parts: string[] = [];
    const days = data.days;
    // Where the Sun stays up or down all day, the runs below say more than "the longest day".
    const longest = data.longest && data.longest.hours < 23.99 ? data.longest : null;
    const shortest = data.shortest && data.shortest.hours > 0.01 ? data.shortest : null;
    if (longest) parts.push(`The longest day is ${dayMonth(days[longest.index]!.day.date)} (${duration(longest.hours)}).`);
    if (shortest) parts.push(`The shortest is ${dayMonth(days[shortest.index]!.day.date)} (${duration(shortest.hours)}).`);
    for (const run of data.polar) {
      const name = run.kind === 'midnight_sun' ? 'The Sun does not set' : 'The Sun does not rise';
      parts.push(`${name} from ${dayMonth(days[run.first]!.day.date)} to ${dayMonth(days[run.last]!.day.date)}.`);
    }
    if (data.clockChanges.length) {
      parts.push(
        `The clocks change on ${data.clockChanges
          .map((cc) => `${dayMonth(cc.day.date)} (${signedOffsetChange(cc.toOffsetMs - cc.fromOffsetMs)})`)
          .join(' and ')}; sunrise and sunset jump with them.`,
      );
    }
    return parts.join(' ');
  }

  function renderCaption(): void {
    c.caption.replaceChildren(
      summaryText(),
      ' ',
      h('span', { class: 'sfc-muted' }, 'Each column is one day, midnight at the top. Click anywhere to go to that day and time; hover for UTC.'),
    );
    const notes: Node[] = [];
    for (const e of [...(data?.errors ?? []), ...(sky?.errors ?? [])]) notes.push(h('p', { class: 'sfc-note' }, e));
    c.notes.replaceChildren(...notes);
  }

  function renderTable(): void {
    if (!data) {
      c.tableWrap.replaceChildren(h('p', { class: 'sfc-message' }, failure ?? 'Nothing to show.'));
      return;
    }
    const zone = data.input.zone;
    const kinds: SunEventKind[] = [
      'astronomical_dawn',
      'nautical_dawn',
      'civil_dawn',
      'rise',
      'set',
      'civil_dusk',
      'nautical_dusk',
      'astronomical_dusk',
    ];
    const main = table(
      `Sunrise, sunset and twilight, ${data.input.year}, local times (${zoneLabel(data.days[0]!.day.jd_start + 0.5, zone)}); each time also in UTC on hover`,
      ['Date', 'Astronomical dawn', 'Nautical dawn', 'Civil dawn', 'Sunrise', 'Sunset', 'Civil dusk', 'Nautical dusk', 'Astronomical dusk', 'Day length'],
    );
    const currentIndex = dayIndexAt(data.days, store.get().time.jd_utc);
    let month = 0;
    const rows: Node[] = [];
    for (const day of data.days) {
      if (day.day.date.month !== month) {
        month = day.day.date.month;
        rows.push(h('tr', { class: 'sfc-row-month' }, h('th', { scope: 'rowgroup', colspan: 10 }, `${MONTHS_LONG[month - 1]} ${day.day.date.year}`)));
      }
      const cells: Node[] = [];
      for (const kind of kinds) {
        const evs = eventsOf(day, kind);
        if (!evs.length) {
          const note = day.error ? '—' : day.alwaysAbove && (kind === 'rise' || kind === 'set') ? 'up all day' : day.alwaysBelow && (kind === 'rise' || kind === 'set') ? 'down all day' : '—';
          cells.push(h('td', { class: 'sfc-muted' }, note));
          continue;
        }
        const td = h('td', {});
        evs.forEach((ev, k) => {
          const off = offsetOn(day.day, ev.jd, zone);
          const local = clockAt(ev.jd, off);
          if (k) td.append(', ');
          td.append(timeButtonText(ev.jd, local, `${local} ${zoneNameAt(ev.jd, zone, off)}`, clockUtcFast(ev.jd)));
        });
        cells.push(td);
      }
      const dateCell = h('th', { scope: 'row' }, dateShort(day.day.date));
      if (day.clockChange) {
        dateCell.append(h('span', { class: 'sfc-muted' }, ` · clocks ${signedOffsetChange(day.clockChange.toOffsetMs - day.clockChange.fromOffsetMs)}`));
      }
      rows.push(
        h(
          'tr',
          { class: day.index === currentIndex ? 'sfc-row-current' : '' },
          dateCell,
          ...cells,
          h('td', {}, day.dayLengthH === null ? '—' : duration(day.dayLengthH)),
        ),
      );
    }
    main.body.append(...rows);

    const tables: Node[] = [main.table];
    if (sky) {
      const mp = table('Moon phases', ['Date', 'Time', 'Phase']);
      for (const ev of sky.moonPhases) {
        const date = localDateOf(ev.jd_utc, zone);
        const i = dayIndexAt(data.days, ev.jd_utc);
        const off = i >= 0 ? offsetOn(data.days[i]!.day, ev.jd_utc, zone) : 0;
        const local = clockAt(ev.jd_utc, off);
        mp.body.append(
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, dateShort(date)),
            h('td', {}, timeButtonText(ev.jd_utc, local, `${local} ${zoneNameAt(ev.jd_utc, zone, off)}`, clockUtcFast(ev.jd_utc))),
            h('td', { class: 'sfc-text' }, MOON_LABELS[ev.kind]),
          ),
        );
      }
      const se = table('Equinoxes and solstices', ['Date', 'Time', 'Event']);
      for (const ev of sky.seasons) {
        const date = localDateOf(ev.jd_utc, zone);
        const i = dayIndexAt(data.days, ev.jd_utc);
        const off = i >= 0 ? offsetOn(data.days[i]!.day, ev.jd_utc, zone) : 0;
        const local = clockAt(ev.jd_utc, off);
        se.body.append(
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, dateShort(date)),
            h('td', {}, timeButtonText(ev.jd_utc, local, `${local} ${zoneNameAt(ev.jd_utc, zone, off)}`, clockUtcFast(ev.jd_utc))),
            h('td', { class: 'sfc-text' }, ev.kind.replace('_', ' ').replace(/^./, (ch) => ch.toUpperCase())),
          ),
        );
      }
      tables.push(se.table, mp.table);
    }
    if (data.clockChanges.length) {
      const cc = table('Clock changes', ['Date', 'At', 'Change']);
      for (const x of data.clockChanges) {
        cc.body.append(
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, dateShort(x.day.date)),
            h('td', {}, `${clockAt(x.jd, x.fromOffsetMs)} → ${clockAt(x.jd, x.toOffsetMs)} (${clockUtcFast(x.jd)})`),
            h('td', { class: 'sfc-text' }, `${signedOffsetChange(x.toOffsetMs - x.fromOffsetMs)}: ${zoneNameAt(x.jd - 1 / 1440, zone, x.fromOffsetMs)} to ${zoneNameAt(x.jd + 1 / 1440, zone, x.toOffsetMs)}`),
          ),
        );
      }
      tables.push(cc.table);
    }
    c.tableWrap.replaceChildren(...tables);
    if (sky) c.root.dataset.ready = '1';
    else setTimeout(loadSky, 0);
  }

  // --- wiring ------------------------------------------------------------------------------
  let dataDirty = true;
  let drawDirty = true;
  function frame(): void {
    if (dataDirty) {
      dataDirty = false;
      drawDirty = true;
      recompute();
      renderLegend();
      if (ui.get().mode === 'table') {
        renderHeader();
        renderTable();
      }
    }
    if (drawDirty) {
      drawDirty = false;
      draw();
      if (data && !sky) setTimeout(loadSky, 0);
    }
    placeToday();
  }
  function schedule(): void {
    drawDirty = true;
    ctx.scheduler.schedule(frame);
  }

  d.add(
    watch(
      ctx,
      (s2) => {
        const input = inputFor(s2);
        return `${observerKey(input.observer)}|${zoneKey(input.zone)}|${input.year}|${input.options.horizon}|${input.options.height_of_eye_m}`;
      },
      () => {
        dataDirty = true;
        frame();
      },
    ),
  );
  d.add(watch(ctx, (s2) => s2.time.jd_utc, () => placeToday(), { immediate: false }));
  d.add(
    ui.select(
      (u) => u.mode,
      (mode) => {
        applyMode(c, mode);
        if (mode === 'table') {
          renderTable();
          scrollToCurrent(c);
        }
        else schedule();
      },
      { immediate: true },
    ),
  );
  d.add(
    observeWidth(c.plot, (w) => {
      width = w;
      schedule();
    }),
  );
  d.add(bindTimeButtons(c.tableWrap, ctx));
  d.add(() => ctx.scheduler.cancel(hoverTask));
  d.add(() => ctx.scheduler.cancel(frame));

  return { destroy: () => d.dispose() };
};
