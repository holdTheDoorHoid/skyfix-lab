/**
 * Planet visibility: night by night through the observer's year, when each planet is above
 * the horizon while the sky is dark (the Sun more than 12° down: night and astronomical
 * twilight). OWNER: charts agent.
 *
 * One band per planet, Venus, Mars, Jupiter and Saturn first, then Mercury, Uranus and
 * Neptune. In each band a column is one night, evening at the top and morning at the
 * bottom (local clock, noon to noon); the dark part of the night is shaded and the planet's
 * colour fills the dark hours it is up. The engine's rise and set times inside each night's
 * darkness give the columns (`day_events_batch`, see planet-data.ts); the work is done in
 * month-sized pieces so the chart fills in without freezing the page.
 */

import { h, s } from '../../dom.js';
import { disposer, memoize, observerKey, watch, type Ctx } from '../component.js';
import { setTime, stepTime } from '../playback.js';
import { displayZone, engineObserver, type ExplorerState } from '../state.js';
import { zoneLabel, type Zone } from '../time.js';
import {
  clockAt,
  clockUtcFast,
  dateShort,
  dayMonth,
  duration,
  MONTHS_LONG,
  MONTHS_SHORT,
  offsetOn,
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
  phaseGlyph,
  pill,
  round,
  stepperNav,
  svgText,
  table,
  timeButtonText,
  tipHead,
  tipRow,
  tooltip,
  type ChartComponent,
} from './frame.js';
import { bodyClass } from './palette.js';
import {
  ALL_PLANETS,
  placement,
  planetYearJob,
  PRIMARY_PLANETS,
  visibilityRuns,
  visibleHours,
  type PlanetInput,
  type PlanetJob,
  type PlanetNight,
  type Placement,
  type VisibleSpan,
} from './planet-data.js';
import { clamp, linearScale, type LinearScale } from './scale.js';
import { jdAtWallHours, zoneKey } from './windows.js';
import { yearInputFor, yearMemo, yearSkyMemo } from './year-chart.js';
import type { YearSky } from './year-data.js';

const jobMemo = memoize(
  (ctx: Ctx, input: PlanetInput) => planetYearJob(ctx.engine, input, yearMemo(ctx, { observer: input.observer, zone: input.zone, year: input.year, options: input.options })),
  (ctx, input) =>
    [ctx.engine.kind, observerKey(input.observer), zoneKey(input.zone), input.year, input.options.horizon, input.options.height_of_eye_m, input.planets.join(',')].join('|'),
  3,
);

export function planetInputFor(state: ExplorerState): PlanetInput {
  const y = yearInputFor(state);
  return { ...y, planets: ALL_PLANETS };
}

/** Where in the night a planet is up, in words: from dusk (evening), until dawn (morning). */
const PLACEMENT_WORDS: Record<Placement, string> = {
  evening: 'from dusk',
  morning: 'until dawn',
  'all night': 'all night',
  midnight: 'in the middle of the night',
};

/** The same for the summary table's "part of the night" column. */
const PLACEMENT_NAMES: Record<Placement, string> = {
  evening: 'Evening (up at dusk)',
  morning: 'Morning (up at dawn)',
  'all night': 'All night',
  midnight: 'Middle of the night',
};

interface Band {
  planet: string;
  top: number;
  height: number;
  ys: LinearScale;
  primary: boolean;
}

interface Geometry {
  job: PlanetJob;
  zone: Zone;
  xs: LinearScale;
  x0: number;
  x1: number;
  bands: Band[];
  top: number;
  bottom: number;
  width: number;
}

export const planetChart: ChartComponent = (host, ctx, ui) => {
  const { store } = ctx;
  const d = disposer();
  const c = card('planets', 'Planets in the dark sky');
  host.append(c.root);
  d.add(() => c.root.remove());

  let width = 0;
  let job: PlanetJob | null = null;
  let failure: string | null = null;
  let geom: Geometry | null = null;
  let svg: SVGSVGElement | null = null;
  let todayLayer: SVGGElement | null = null;
  let hoverLayer: SVGGElement | null = null;
  let visibleLayer: SVGGElement | null = null;
  let hover: { index: number; x: number; y: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let monthLabels: { el: SVGTextElement; x: number }[] = [];
  let stripLayer: SVGGElement | null = null;
  let sky: YearSky | null = null;

  const tip = tooltip(c.plot);
  const nav = stepperNav(c.nav, 'Previous year', 'Next year', (dir) => stepTime(store, { unit: 'year', count: dir }));
  const progress = h('span', { class: 'sfc-progress', 'aria-hidden': 'true' });
  c.status.after(progress);

  // --- data --------------------------------------------------------------------------------
  let inputCache: { key: string; start: number; end: number; input: PlanetInput } | null = null;
  function inputFor(st: ExplorerState): PlanetInput {
    const zone = displayZone(st);
    const key = `${observerKey(engineObserver(st))}|${zoneKey(zone)}|${st.settings.horizon}|${st.settings.height_of_eye_m}`;
    const jd = st.time.jd_utc;
    if (inputCache && inputCache.key === key && jd >= inputCache.start && jd < inputCache.end) return inputCache.input;
    const input = planetInputFor(st);
    inputCache = { key, start: Number.NaN, end: Number.NaN, input };
    return input;
  }

  function recompute(): void {
    const input = inputFor(store.get());
    try {
      job = jobMemo(ctx, input);
      failure = null;
      const nights = job.data.nights;
      if (inputCache && nights.length) {
        // The chart's year is its nights' evenings; a moment before the first noon belongs to
        // the previous year's last night, so the cache only spans this year's days.
        const year = yearMemo(ctx, { observer: input.observer, zone: input.zone, year: input.year, options: input.options });
        inputCache.start = year.days[0]!.day.jd_start;
        inputCache.end = year.days[year.days.length - 1]!.day.jd_end;
      }
    } catch (error) {
      job = null;
      failure = error instanceof OutsideCoverageError ? error.message : `The engine could not compute this year: ${errorText(error)}`;
    }
    sky = null;
    publishTiming();
    continueJob();
  }

  function publishTiming(): void {
    if (!job) return;
    const t = job.data.timing;
    c.root.dataset.compute = `planets ${job.done ? '' : `${Math.round(job.progress * 100)} % `}${t.totalMs.toFixed(0)} ms (engine ${t.engineMs.toFixed(0)})`;
  }

  /** Run the planet job a piece at a time, redrawing the bands as nights come in. */
  function continueJob(): void {
    if (job?.done && !sky) {
      // Everything is computed already (a memo hit): only the Moon strip is missing.
      setTimeout(() => {
        if (!job || sky) return;
        sky = yearSkyMemo(ctx, job.data.input.zone, job.data.input.year);
        drawStrip();
        updateStatus();
      }, 0);
    }
    if (timer !== null || !job || job.done) {
      updateStatus();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (!job) return;
      if (!sky) {
        sky = yearSkyMemo(ctx, job.data.input.zone, job.data.input.year);
        drawStrip();
      }
      job.step(45);
      publishTiming();
      drawVisible();
      updateStatus();
      if (job.done) {
        renderCaption();
        if (ui.get().mode === 'table') renderTable();
      } else {
        continueJob();
      }
    }, 0);
  }
  d.add(() => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  });

  function updateStatus(): void {
    const text = job && !job.done ? 'Working out the planets night by night…' : '';
    if (c.status.textContent !== text) c.status.textContent = text;
    progress.textContent = job && !job.done ? `${Math.round(job.progress * 100)} %` : '';
    const drawn = ui.get().mode === 'table' ? c.tableWrap.childElementCount > 0 : geom !== null;
    c.root.dataset.ready = job?.done && sky && drawn ? '1' : '0';
  }

  // --- header and legend -------------------------------------------------------------------
  function renderHeader(): void {
    const st = store.get();
    const input = inputFor(st);
    c.title.replaceChildren(`Planets in the dark sky · ${input.year}`);
    if (ctx.engine.kind === 'mock') c.title.append(mockBadge(ctx.engine.description));
    const place = st.observer.label || `${st.observer.lat_deg.toFixed(3)}°, ${st.observer.lon_deg.toFixed(3)}°`;
    c.subtitle.textContent = `${place} · when each planet is above the horizon while the Sun is more than 12° down · ${zoneLabel(st.time.jd_utc, input.zone)}`;
    nav.textContent = String(input.year);
  }

  function renderLegend(): void {
    c.legend.replaceChildren(
      h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-swatch sfc-swatch--light', 'aria-hidden': 'true' }), 'Too light (Sun less than 12° down)'),
      h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-swatch sfc-swatch--astronomical', 'aria-hidden': 'true' }), 'Astronomical twilight'),
      h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-swatch sfc-swatch--night', 'aria-hidden': 'true' }), 'Night'),
      h('span', { class: 'sfc-legend-sep', 'aria-hidden': 'true' }),
      h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-swatch sfc-swatch--body sfc-b-jupiter', 'aria-hidden': 'true' }), 'Planet up in the dark (in its own colour)'),
      h('span', { class: 'sfc-legend-sep', 'aria-hidden': 'true' }),
      h('span', { class: 'sfc-legend-note sfc-muted' }, 'Each column is one night: evening at the top, morning at the bottom.'),
    );
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
    if (!job || width <= 0) return;
    const data = job.data;
    const zone = data.input.zone;
    const nights = data.nights;
    const n = nights.length;
    const narrow = width < 560;
    const W = width;
    const margin = { left: narrow ? 64 : 92, right: narrow ? 30 : 40, top: 26 };
    const x0 = margin.left;
    const x1 = W - margin.right;
    const xs = linearScale([0, n], [x0, x1]);
    const range = data.hourRange;
    const bandsSpec: { planet: string; primary: boolean }[] = data.input.planets.map((p) => ({
      planet: p,
      primary: (PRIMARY_PLANETS as readonly string[]).includes(p),
    }));
    const bands: Band[] = [];
    let y = margin.top;
    let lastPrimary = true;
    const groupLabels: { y: number; text: string }[] = [];
    for (const b of bandsSpec) {
      if (lastPrimary && !b.primary) {
        y += 22;
        groupLabels.push({ y: y - 7, text: narrow ? 'Harder to see' : 'Harder to see: low in twilight, or too faint for the eye' });
      }
      lastPrimary = b.primary;
      const height = b.primary ? (narrow ? 40 : 52) : narrow ? 26 : 32;
      const ys = linearScale(range ?? [6, 18], [y, y + height]);
      bands.push({ planet: b.planet, top: y, height, ys, primary: b.primary });
      y += height + (b.primary ? 8 : 6);
    }
    const bottom = y - 6;
    const H = bottom + 30;
    geom = { job, zone, xs, x0, x1, bands, top: margin.top, bottom, width: W };

    const root = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': summaryText() }) as SVGSVGElement;

    // Moon phases along the top (new and full moons matter for dark skies), once known.
    stripLayer = s('g', { class: 'sfc-moonstrip' }) as SVGGElement;
    root.append(stripLayer);
    drawStrip();

    // Month grid.
    const grid = s('g', { class: 'sfc-grid' });
    const monthStarts = nights.filter((nt) => nt.night.date.day === 1).map((nt) => nt.index);
    for (const i of monthStarts) {
      if (i === 0) continue;
      const x = round(xs(i)) + 0.5;
      grid.append(s('line', { x1: x, x2: x, y1: margin.top - 4, y2: bottom }));
    }

    const bandsG = s('g', {});
    const colW = (x1 - x0) / n;
    for (const band of bands) {
      bandsG.append(s('rect', { class: 'sfc-band-bg', x: x0, y: band.top, width: x1 - x0, height: band.height }));
      let astro = '';
      let night = '';
      for (const nt of nights) {
        const xa = round(xs(nt.index));
        const w = round(colW + 0.6);
        for (const sp of nt.dark) {
          const ya = round(band.ys(clamp(sp.from, band.ys.domain[0], band.ys.domain[1])));
          const yb = round(band.ys(clamp(sp.to, band.ys.domain[0], band.ys.domain[1])));
          const seg = `M${xa} ${ya}h${w}V${yb}h${-w}Z`;
          if (sp.phase === 'night') night += seg;
          else astro += seg;
        }
      }
      if (astro) bandsG.append(s('path', { class: 'sfc-dark-astro', d: astro }));
      if (night) bandsG.append(s('path', { class: 'sfc-dark-night', d: night }));
      // Where darkness begins and ends each night, as two thin lines: in the dark themes
      // "too light" and astronomical twilight are close in colour.
      let edges = '';
      for (const key of ['from', 'to'] as const) {
        let open = false;
        for (const nt of nights) {
          const sp = key === 'from' ? nt.dark[0] : nt.dark[nt.dark.length - 1];
          if (!sp) {
            open = false;
            continue;
          }
          const yv = round(band.ys(clamp(sp[key], band.ys.domain[0], band.ys.domain[1])));
          edges += `${open ? 'L' : 'M'}${round(xs(nt.index + 0.5))} ${yv}`;
          open = true;
        }
      }
      if (edges) bandsG.append(s('path', { class: 'sfc-dark-edge', d: edges }));
      // Midnight, faintly.
      if (range && 12 > range[0] && 12 < range[1]) {
        const ym = round(band.ys(12)) + 0.5;
        grid.append(s('line', { x1: x0, x2: x1, y1: ym, y2: ym, class: 'sfc-grid--faint' }));
      }
    }
    root.append(bandsG);
    visibleLayer = s('g', {}) as SVGGElement;
    root.append(visibleLayer, grid);

    // Labels: planet names on the left, clock ticks on the right.
    const labels = s('g', {});
    for (const band of bands) {
      labels.append(
        svgText(x0 - 10, band.top + band.height / 2 + 4, band.planet, {
          'text-anchor': 'end',
          class: `sfc-band-name${band.primary ? '' : ' sfc-band-name--minor'}`,
        }),
      );
      labels.append(
        s('rect', {
          class: bodyClass(band.planet, 'planet'),
          x: x0 - 7,
          y: round(band.top + 3),
          width: 3,
          height: round(band.height - 6),
          rx: 1.5,
          style: 'fill: var(--c)',
        }),
      );
      if (range && band.primary) {
        for (const hr of tickHours(range, band.height)) {
          labels.append(svgText(x1 + 5, band.ys(hr) + 3.5, clockLabel(hr), { class: 'sfc-tick' }));
        }
      }
    }
    for (const gl of groupLabels) labels.append(svgText(x0, gl.y, gl.text, { class: 'sfc-group-label' }));
    root.append(labels);

    const axis = s('g', { class: 'sfc-axis' });
    monthLabels = [];
    for (const i of monthStarts) {
      const nt = nights[i]!;
      const next = monthStarts.find((j) => j > i) ?? n;
      const label = narrow ? MONTHS_SHORT[nt.night.date.month - 1]!.charAt(0) : MONTHS_SHORT[nt.night.date.month - 1]!;
      const t = svgText(xs((i + next) / 2), bottom + 16, label, { 'text-anchor': 'middle' });
      monthLabels.push({ el: t, x: xs((i + next) / 2) });
      axis.append(t);
    }
    root.append(axis);

    if (!range) {
      root.append(svgText((x0 + x1) / 2, (margin.top + bottom) / 2, 'The sky never gets dark here this year (the Sun is never more than 12° down).', { 'text-anchor': 'middle', class: 'sfc-band-sub' }));
    }

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
    drawVisible();
    placeToday();
    if (hover) drawHover();
    renderCaption();
    if (ui.get().mode === 'table') renderTable();
    updateStatus();
  }

  /** Clock ticks for a band: at most one per 15 px, on 2, 3, 6 or 12-hour marks. */
  function tickHours(range: readonly [number, number], height: number): number[] {
    const span = range[1] - range[0];
    const fit = Math.max(1, Math.floor(height / 15));
    const step = [2, 3, 6, 12].find((st) => span / st <= fit) ?? 12;
    const out: number[] = [];
    for (let hr = Math.ceil(range[0] / step) * step; hr <= range[1]; hr += step) out.push(hr);
    return out;
  }

  function clockLabel(hoursAfterNoon: number): string {
    return `${String((((Math.round(hoursAfterNoon) + 12) % 24) + 24) % 24).padStart(2, '0')}h`;
  }

  /** New and full moons along the top, from the year chart's (observer-free) Moon phases. */
  function drawStrip(): void {
    if (!geom || !stripLayer || !job) return;
    stripLayer.replaceChildren();
    const { xs, x0, zone } = geom;
    const nights = job.data.nights;
    const narrow = geom.width < 560;
    const south = store.get().observer.lat_deg < 0;
    stripLayer.append(svgText(x0 - 8, 14.5, 'Moon', { 'text-anchor': 'end', class: 'sfc-strip-label' }));
    if (!sky) return;
    for (const ev of sky.moonPhases) {
      if (ev.kind !== 'new_moon' && ev.kind !== 'full_moon') continue;
      const i = nights.findIndex((nt) => ev.jd_utc >= nt.night.jd_start && ev.jd_utc < nt.night.jd_end);
      if (i < 0) continue;
      const nt = nights[i]!.night;
      const pos = i + (ev.jd_utc - nt.jd_start) / (nt.jd_end - nt.jd_start);
      const g = phaseGlyph(ev.kind, xs(pos), 11, narrow ? 4.5 : 5.5, south);
      const t = s('title', {});
      const off = offsetOn(nt, ev.jd_utc, zone);
      t.textContent = `${ev.kind === 'new_moon' ? 'New Moon' : 'Full Moon'}, night of ${dayMonth(nt.date)}, ${clockAt(ev.jd_utc, off)} ${zoneNameAt(ev.jd_utc, zone, off)} · ${clockUtcFast(ev.jd_utc)}`;
      g.append(t);
      stripLayer.append(g);
    }
  }

  /** The planets' columns: redrawn as the job fills them in. */
  function drawVisible(): void {
    if (!geom || !visibleLayer || !job) return;
    const { xs, bands } = geom;
    const nights = job.data.nights;
    const colW = (geom.x1 - geom.x0) / nights.length;
    visibleLayer.replaceChildren();
    for (const band of bands) {
      let dStr = '';
      let pending = '';
      for (const nt of nights) {
        const xa = round(xs(nt.index));
        const w = round(colW + 0.6);
        const spans = nt.visible.get(band.planet);
        if (!spans) {
          if (nt.darkWindow) pending += `M${xa} ${round(band.top)}h${w}v${round(band.height)}h${-w}Z`;
          continue;
        }
        for (const sp of spans) {
          const lo = band.ys.domain[0];
          const hi = band.ys.domain[1];
          const ya = round(band.ys(clamp(sp.from, lo, hi)));
          const yb = round(band.ys(clamp(sp.to, lo, hi)));
          dStr += `M${xa} ${ya}h${w}V${Math.max(yb, ya + 0.8)}h${-w}Z`;
        }
      }
      if (dStr) visibleLayer.append(s('path', { class: `sfc-visible ${bodyClass(band.planet, 'planet')}`, d: dStr }));
      if (pending) visibleLayer.append(s('path', { class: 'sfc-pending', d: pending }));
    }
  }

  function currentNightIndex(): number {
    if (!job) return -1;
    const jd = store.get().time.jd_utc;
    return job.data.nights.findIndex((nt) => jd >= nt.night.jd_start && jd < nt.night.jd_end);
  }

  function placeToday(): void {
    if (!geom || !todayLayer || !job) return;
    todayLayer.replaceChildren();
    const i = currentNightIndex();
    for (const m of monthLabels) m.el.style.visibility = '';
    if (i < 0) return;
    const nt = job.data.nights[i]!;
    const x = geom.xs(i + 0.5);
    todayLayer.append(s('line', { x1: round(x), x2: round(x), y1: geom.top - 4, y2: geom.bottom }));
    const lp = pill(x, geom.bottom + 16, dayMonth(nt.night.date), { size: 11, cls: 'sfc-pill--accent' });
    const shift = clamp(x, geom.x0 + lp.box.w / 2, geom.x1 - lp.box.w / 2) - x;
    if (shift) lp.el.setAttribute('transform', `translate(${round(shift)} 0)`);
    todayLayer.append(lp.el);
    for (const m of monthLabels) m.el.style.visibility = Math.abs(m.x - (x + shift)) < lp.box.w / 2 + 14 ? 'hidden' : '';
  }

  // --- hover and click -----------------------------------------------------------------------
  function pointerAt(event: PointerEvent | MouseEvent): { index: number; x: number; y: number } | null {
    if (!geom || !svg || !job) return null;
    const rect = svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (px < geom.x0 || px > geom.x1 || py < geom.top - 6 || py > geom.bottom + 2) return null;
    const index = clamp(Math.floor(geom.xs.invert(px)), 0, job.data.nights.length - 1);
    return { index, x: px, y: py };
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

  function spanText(nt: PlanetNight, sp: VisibleSpan, zone: Zone): string {
    return `${clockAt(sp.jd_start, offsetOn(nt.night, sp.jd_start, zone))}–${clockAt(sp.jd_end, offsetOn(nt.night, sp.jd_end, zone))}`;
  }

  function drawHover(): void {
    if (!geom || !hoverLayer || !hover || !job) return;
    const nt = job.data.nights[hover.index]!;
    const zone = geom.zone;
    const x = geom.xs(hover.index + 0.5);
    hoverLayer.style.display = '';
    hoverLayer.replaceChildren(s('line', { x1: round(x) + 0.5, x2: round(x) + 0.5, y1: geom.top - 4, y2: geom.bottom }));
    const next = new Date(Date.UTC(nt.night.date.year, nt.night.date.month - 1, nt.night.date.day + 1));
    const nextDate = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
    const rows: Node[] = [];
    const dark = nt.darkWindow;
    rows.push(
      tipHead(
        `Night of ${dateShort(nt.night.date).replace(/ \d{4}$/, '')} → ${dayMonth(nextDate)}`,
        dark
          ? `dark ${clockAt(dark[0], offsetOn(nt.night, dark[0], zone))} → ${clockAt(dark[1], offsetOn(nt.night, dark[1], zone))} ${zoneNameAt(dark[0], zone, offsetOn(nt.night, dark[0], zone))} (${clockUtcFast(dark[0])} → ${clockUtcFast(dark[1])})`
          : 'the sky does not get dark',
      ),
    );
    for (const planet of job.data.input.planets) {
      const spans = nt.visible.get(planet);
      if (!dark) break;
      if (!spans) {
        rows.push(tipRow('…', planet, glyph(planet, 'planet', 13)));
        continue;
      }
      const hours = visibleHours(spans);
      if (hours < 1 / 60) {
        rows.push(tipRow('—', planet, glyph(planet, 'planet', 13), 'not up in the dark'));
        continue;
      }
      const place = placement(spans, dark);
      rows.push(
        tipRow(
          spans.map((sp) => spanText(nt, sp, zone)).join(', '),
          planet,
          glyph(planet, 'planet', 13),
          `${duration(hours)}${place ? `, ${PLACEMENT_WORDS[place]}` : ''}`,
        ),
      );
    }
    tip.show(x, hover.y, rows);
  }

  function onClick(event: MouseEvent): void {
    const p = pointerAt(event);
    if (!p || !geom || !job) return;
    const nt = job.data.nights[p.index]!;
    const band = geom.bands.find((b) => p.y >= b.top && p.y <= b.top + b.height);
    let jd: number;
    if (band) {
      const hoursAfterNoon = band.ys.invert(p.y);
      jd = jdAtWallHours(nt.night.date, 12 + Math.round(hoursAfterNoon * 60) / 60, geom.zone);
    } else if (nt.darkWindow) {
      jd = (nt.darkWindow[0] + nt.darkWindow[1]) / 2;
    } else {
      jd = (nt.night.jd_start + nt.night.jd_end) / 2;
    }
    setTime(store, jd);
  }

  // --- caption and table -------------------------------------------------------------------
  function tonight(): { night: PlanetNight; lines: string[] } | null {
    if (!job) return null;
    const i = currentNightIndex();
    if (i < 0) return null;
    const nt = job.data.nights[i]!;
    const zone = job.data.input.zone;
    const lines: string[] = [];
    if (!nt.darkWindow) return { night: nt, lines: ['the sky does not get dark'] };
    if (!nt.computed && !PRIMARY_PLANETS.some((p) => nt.visible.has(p))) return { night: nt, lines: ['working it out…'] };
    for (const planet of PRIMARY_PLANETS) {
      const spans = nt.visible.get(planet);
      if (!spans) continue;
      if (visibleHours(spans) < 1 / 60) lines.push(`${planet} not up in the dark`);
      else lines.push(`${planet} ${spans.map((sp) => spanText(nt, sp, zone)).join(', ')}`);
    }
    return { night: nt, lines };
  }

  function summaryText(): string {
    const t = tonight();
    if (!t) return 'When each planet is above the horizon in the dark, night by night through the year.';
    return `Night of ${dayMonth(t.night.night.date)}: ${t.lines.join('; ')}.`;
  }

  function renderCaption(): void {
    c.caption.replaceChildren(
      summaryText(),
      ' ',
      h(
        'span',
        { class: 'sfc-muted' },
        'Dark means the Sun is more than 12° below the horizon; "up" means above the horizon, whether or not there is a clear view down to it. Click a night to go to it; hover for times in UTC.',
      ),
    );
    const notes: Node[] = [];
    if (job) {
      for (const p of job.data.problems) notes.push(h('p', { class: 'sfc-note' }, p));
      if (job.data.errors.length) {
        notes.push(h('p', { class: 'sfc-note' }, `Not drawn: ${job.data.errors.map((e) => `${e.body} (${e.message})`).join('; ')}.`));
      }
    }
    c.notes.replaceChildren(...notes);
  }

  function renderTable(): void {
    if (!job) {
      c.tableWrap.replaceChildren(h('p', { class: 'sfc-message' }, failure ?? 'Nothing to show.'));
      return;
    }
    const data = job.data;
    const zone = data.input.zone;
    const nights = data.nights;
    if (!job.done) {
      c.tableWrap.replaceChildren(h('p', { class: 'sfc-message' }, `Working out the planets night by night… ${Math.round(job.progress * 100)} %`));
      return;
    }
    const summary = table(`When to look for each planet in ${data.input.year} (in the dark, from ${store.get().observer.label || 'this place'})`, [
      'Planet',
      'Part of the night',
      'From the night of',
      'To the night of',
      'Longest',
    ]);
    for (const planet of data.input.planets) {
      const runs = visibilityRuns(nights, planet).filter((r) => r.last - r.first >= 2 || r.bestHours >= 0.5);
      if (!runs.length) {
        summary.body.append(h('tr', {}, h('th', { scope: 'row' }, planet), h('td', { class: 'sfc-text sfc-muted', colspan: 4 }, 'Not up in the dark sky this year')));
        continue;
      }
      runs.forEach((r, k) => {
        summary.body.append(
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, k ? '' : planet),
            h('td', { class: 'sfc-text' }, PLACEMENT_NAMES[r.placement]),
            h('td', {}, dateShort(nights[r.first]!.night.date)),
            h('td', {}, dateShort(nights[r.last]!.night.date)),
            h('td', {}, `${duration(r.bestHours)} (${dayMonth(nights[r.bestIndex]!.night.date)})`),
          ),
        );
      });
    }

    const detail = table(`Night by night: when each planet is up in the dark (local times, ${zoneLabel(nights[0]!.night.jd_start, zone)}; UTC on hover)`, [
      'Night of',
      'Dark',
      ...data.input.planets,
    ]);
    const current = currentNightIndex();
    let month = 0;
    for (const nt of nights) {
      if (nt.night.date.month !== month) {
        month = nt.night.date.month;
        detail.body.append(h('tr', { class: 'sfc-row-month' }, h('th', { scope: 'rowgroup', colspan: 2 + data.input.planets.length }, `${MONTHS_LONG[month - 1]} ${nt.night.date.year}`)));
      }
      const dark = nt.darkWindow;
      const cells: Node[] = [];
      for (const planet of data.input.planets) {
        const spans = nt.visible.get(planet) ?? [];
        if (!dark || visibleHours(spans) < 1 / 60) {
          cells.push(h('td', { class: 'sfc-muted' }, '—'));
          continue;
        }
        const td = h('td', {});
        spans.forEach((sp, k) => {
          if (k) td.append(', ');
          const offA = offsetOn(nt.night, sp.jd_start, zone);
          const offB = offsetOn(nt.night, sp.jd_end, zone);
          const a = clockAt(sp.jd_start, offA);
          const b = clockAt(sp.jd_end, offB);
          td.append(
            timeButtonText(sp.jd_start, a, `${a} ${zoneNameAt(sp.jd_start, zone, offA)}`, clockUtcFast(sp.jd_start)),
            '–',
            timeButtonText(sp.jd_end, b, `${b} ${zoneNameAt(sp.jd_end, zone, offB)}`, clockUtcFast(sp.jd_end)),
          );
        });
        cells.push(td);
      }
      const darkText = dark
        ? `${clockAt(dark[0], offsetOn(nt.night, dark[0], zone))}–${clockAt(dark[1], offsetOn(nt.night, dark[1], zone))}`
        : 'never dark';
      detail.body.append(
        h(
          'tr',
          { class: nt.index === current ? 'sfc-row-current' : '' },
          h('th', { scope: 'row' }, dateShort(nt.night.date)),
          h('td', { class: dark ? '' : 'sfc-muted' }, darkText),
          ...cells,
        ),
      );
    }
    c.tableWrap.replaceChildren(summary.table, detail.table);
    if (sky) c.root.dataset.ready = '1';
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
      (st) => {
        const input = inputFor(st);
        return `${observerKey(input.observer)}|${zoneKey(input.zone)}|${input.year}|${input.options.horizon}|${input.options.height_of_eye_m}`;
      },
      () => {
        dataDirty = true;
        frame();
      },
    ),
  );
  d.add(
    watch(
      ctx,
      (st) => st.time.jd_utc,
      () => {
        placeToday();
      },
      { immediate: false },
    ),
  );
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
