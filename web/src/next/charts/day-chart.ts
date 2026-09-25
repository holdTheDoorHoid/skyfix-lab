/**
 * The day chart: how high the Sun, the Moon, the planets and the selected star stand above
 * the horizon through the observer's local day, over the sky's phases. OWNER: charts agent.
 *
 * - Curves are the engine's apparent altitudes (`sample_bodies`, 5-minute steps): solid
 *   above the horizon, dashed below it, over a darker band for the ground.
 * - The background is the sky phase at each moment (`day_events.phases`), in the same
 *   colours as the time bar.
 * - Markers: rise ▲ and set ▼ on the horizon, transit ◆ on the curve (`day_events`).
 * - "Star sights": nautical twilight, when the horizon is still sharp and the brighter
 *   stars are out, bracketed above the plot.
 * - The gold cursor is the app's time. Drag it (or anywhere on the plot), click, or focus
 *   it and use the arrow keys: the whole app moves with it.
 * - Hover readouts ask the engine (`sky_state`) at the minute under the pointer.
 */

import { h, s } from '../../dom.js';
import { disposer, memoize, observerKey, watch, type Ctx } from '../component.js';
import { SOLAR_SYSTEM } from '../engine/bodies.js';
import type { BodyKind, BodyState, SkyPhase } from '../engine/types.js';
import { setPlaying, setTime, stepTime } from '../playback.js';
import { displayZone, engineObserver, eventOptions, type ExplorerState } from '../state.js';
import { axisTime, endOfDay } from '../shell/format.js';
import { zoneLabel, type Zone } from '../time.js';
import { computeDay, curveAt, DAY_STEP_MINUTES, type DayData, type DayInput, type DaySeries } from './day-data.js';
import {
  altitude,
  bearing,
  clockAt,
  clock,
  clockUtc,
  clockWithUtc,
  clockZoned,
  dateLong,
  dateShort,
  duration,
  signedOffsetChange,
} from './format.js';
import { glyphFor } from '../theme/glyphs.js';
import { chip } from '../theme/primitives.js';
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
  timeButton,
  tipHead,
  tipRow,
  tooltip,
  uid,
  type Box,
  type ChartComponent,
} from './frame.js';
import { bodyClass, PHASE_LABELS, phaseClass } from './palette.js';
import { clamp, linearScale, pickStep, type LinearScale } from './scale.js';
import { clockChangeIn, localDayAt, wallHours, zoneKey, type LocalDay } from './windows.js';

/** The altitude axis: fixed, so stepping through days never rescales it. */
export const ALT_MIN = -30;
export const ALT_MAX = 90;
/** Twilight limits drawn as reference lines (the Sun's altitude, CONVENTIONS 13.4). */
const TWILIGHT_LINES: readonly [number, string][] = [
  [-6, 'civil'],
  [-12, 'nautical'],
  [-18, 'astronomical'],
];
/** Shown unless switched off; Uranus and Neptune (not naked-eye objects) start hidden. */
const HIDDEN_BY_DEFAULT = ['Uranus', 'Neptune'];
/** Label priority when peak labels collide. */
const LABEL_PRIORITY = ['Sun', 'Moon', 'Venus', 'Jupiter', 'Mars', 'Saturn', 'Mercury', 'Uranus', 'Neptune'];

const dayMemo = memoize(
  (ctx: Ctx, input: DayInput) => computeDay(ctx.engine, input),
  (ctx, input) =>
    [
      ctx.engine.kind,
      observerKey(input.observer),
      zoneKey(input.zone),
      input.day.key,
      input.day.jd_start,
      input.bodies.join(','),
      input.options.horizon,
      input.options.height_of_eye_m,
    ].join('|'),
  6,
);

interface Geometry {
  day: LocalDay;
  zone: Zone;
  xs: LinearScale;
  ys: LinearScale;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  width: number;
  height: number;
}

function kindOf(ctx: Ctx, body: string): BodyKind | undefined {
  return ctx.engine.bodies().find((b) => b.body === body)?.kind;
}

/** The bodies the chart draws: the Sun, the Moon, the planets, and the selected body if it is a star. */
export function dayBodies(ctx: Ctx, selected: string | null): string[] {
  const list = [...SOLAR_SYSTEM];
  if (selected && !list.includes(selected) && kindOf(ctx, selected) === 'star') list.push(selected);
  return list;
}

function drawOrder(series: readonly DaySeries[], selected: string | null): DaySeries[] {
  const weight = (s: DaySeries): number =>
    s.body === selected ? 4 : s.kind === 'sun' ? 3 : s.kind === 'moon' ? 2 : s.kind === 'star' ? 1 : 0;
  return [...series].sort((a, b) => weight(a) - weight(b));
}

function phaseAt(data: DayData, jd: number): SkyPhase | null {
  for (const p of data.phases) if (jd >= p.jd_start && jd < p.jd_end) return p.phase;
  return data.phases[data.phases.length - 1]?.phase ?? null;
}

export const dayChart: ChartComponent = (host, ctx, ui) => {
  const { store } = ctx;
  const d = disposer();
  const c = card('day', 'Height above the horizon');
  host.append(c.root);
  d.add(() => c.root.remove());

  const clipSky = uid('sfc-clip-sky');
  const clipGround = uid('sfc-clip-ground');
  const clipPlot = uid('sfc-clip-plot');
  const hidden = new Set<string>(HIDDEN_BY_DEFAULT);
  let width = 0;
  let data: DayData | null = null;
  let failure: string | null = null;
  let geom: Geometry | null = null;
  let svg: SVGSVGElement | null = null;
  let cursorLayer: SVGGElement | null = null;
  let hoverLayer: SVGGElement | null = null;
  let hoverJd: number | null = null;
  let hoverY = 0;
  let dragging = false;
  let resumePlay = false;
  let timeLabels: { el: SVGTextElement; x: number }[] = [];

  const tip = tooltip(c.plot);
  const readout = h('div', { class: 'sfc-readout', 'aria-live': 'off' });
  c.figure.insertBefore(readout, c.caption);

  const nav = stepperNav(c.nav, 'Previous day', 'Next day', (dir) => stepTime(store, { unit: 'day', count: dir }));

  // --- the day being shown -----------------------------------------------------------
  let dayCache: { zoneKey: string; day: LocalDay } | null = null;
  function currentDay(s: ExplorerState): { zone: Zone; day: LocalDay } {
    const zone = displayZone(s);
    const zk = zoneKey(zone);
    const jd = s.time.jd_utc;
    if (!dayCache || dayCache.zoneKey !== zk || jd < dayCache.day.jd_start || jd >= dayCache.day.jd_end) {
      dayCache = { zoneKey: zk, day: localDayAt(jd, zone) };
    }
    return { zone, day: dayCache.day };
  }

  function inputFor(s: ExplorerState): DayInput {
    const { zone, day } = currentDay(s);
    return {
      observer: engineObserver(s),
      zone,
      day,
      bodies: dayBodies(ctx, s.selection.body),
      options: eventOptions(s),
    };
  }

  function recompute(): void {
    const input = inputFor(store.get());
    try {
      data = dayMemo(ctx, input);
      failure = null;
      c.root.dataset.compute = `day ${data.timing.totalMs.toFixed(0)} ms (engine ${data.timing.engineMs.toFixed(0)})`;
    } catch (error) {
      data = null;
      failure = error instanceof OutsideCoverageError ? error.message : `The engine could not compute this day: ${errorText(error)}`;
    }
  }

  // --- header ----------------------------------------------------------------------------
  function renderHeader(): void {
    const s = store.get();
    const { zone, day } = currentDay(s);
    c.title.replaceChildren('Height above the horizon');
    if (s.settings.navigatorTerms) c.title.append(h('span', { class: 'sfc-term' }, ' · altitude'));
    if (ctx.engine.kind === 'mock') c.title.append(mockBadge(ctx.engine.description));
    const place = s.observer.label || `${s.observer.lat_deg.toFixed(3)}°, ${s.observer.lon_deg.toFixed(3)}°`;
    c.subtitle.textContent = `${dateLong(day.date)} · ${place} · ${zoneLabel(day.jd_start + 0.5, zone)}${
      day.hours !== 24 ? ` · a ${day.hours}-hour day (the clocks change)` : ''
    }`;
    nav.textContent = dateShort(day.date);
  }

  // --- legend: body toggles and the star picker ---------------------------------------
  function renderLegend(): void {
    const s = store.get();
    const selected = s.selection.body;
    const bodies = dayBodies(ctx, selected);
    const chips = bodies.map((body, i) => {
      const on = !hidden.has(body);
      return chip({
        label: body,
        lead: glyph(body, kindOf(ctx, body)),
        selected: on,
        class: body === selected ? 'sfc-chip--selected' : undefined,
        tip: on ? `Hide ${body}` : `Show ${body}`,
        onClick: () => {
          if (hidden.has(body)) hidden.delete(body);
          else hidden.add(body);
          renderLegend();
          schedule();
          (c.legend.querySelectorAll('.sf-chip')[i] as HTMLElement | undefined)?.focus();
        },
      });
    });
    const stars = ctx.engine.bodies().filter((b) => b.kind === 'star').map((b) => b.body).sort((a, b) => a.localeCompare(b));
    const selectedStar = selected && kindOf(ctx, selected) === 'star' ? selected : '';
    const picker = h('select', { class: 'sfc-select', 'aria-label': 'Star to show (selects it everywhere)' });
    picker.append(h('option', { value: '' }, 'Add a star…'));
    for (const name of stars) picker.append(h('option', { value: name, selected: name === selectedStar }, name));
    picker.value = selectedStar;
    picker.addEventListener('change', () => {
      store.patch({ selection: { body: picker.value || null } });
    });
    c.legend.replaceChildren(
      ...chips,
      h('span', { class: 'sfc-legend-sep', 'aria-hidden': 'true' }),
      h('label', { class: 'sfc-legend-item' }, h('span', {}, 'Star'), picker),
    );
  }

  // --- drawing ---------------------------------------------------------------------------
  function visibleSeries(): DaySeries[] {
    return data ? data.series.filter((s) => !hidden.has(s.body)) : [];
  }

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
    const s = store.get();
    const selected = s.selection.body;
    const zone = data.input.zone;
    const day = data.input.day;
    const narrow = width < 560;
    const margin = { left: narrow ? 34 : 42, right: narrow ? 6 : 10, top: 34, bottom: 30 };
    const plotH = Math.round(clamp(width * 0.4, 230, 420));
    const W = width;
    const H = margin.top + plotH + margin.bottom;
    const x0 = margin.left;
    const x1 = W - margin.right;
    const y0 = margin.top;
    const y1 = margin.top + plotH;
    const xs = linearScale([0, day.hours], [x0, x1]);
    const ys = linearScale([ALT_MIN, ALT_MAX], [y1, y0]);
    const hourOf = (jd: number): number => (jd - day.jd_start) * 24;
    const yH = ys(0);
    geom = { day, zone, xs, ys, x0, x1, y0, y1, width: W, height: H };

    // A group, not an image: it holds the time slider, which must stay reachable.
    const root = s_('svg', {
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      role: 'group',
      'aria-label': `Height above the horizon through the day. ${summaryText()} The table view lists every value.`,
    }) as SVGSVGElement;
    const defs = s_('defs');
    defs.append(
      clip(clipSky, x0, y0, x1 - x0, yH - y0),
      clip(clipGround, x0, yH, x1 - x0, y1 - yH),
      clip(clipPlot, x0, y0, x1 - x0, y1 - y0),
    );
    root.append(defs);

    // Sky phases behind everything.
    const bands = s_('g', { class: 'sfc-bands', 'clip-path': `url(#${clipPlot})` });
    for (const p of data.phases) {
      const a = xs(hourOf(p.jd_start));
      const b = xs(hourOf(p.jd_end));
      bands.append(s_('rect', { class: phaseClass(p.phase), x: round(a), y: y0, width: round(Math.max(0, b - a) + 0.6), height: plotH }));
    }
    bands.append(s_('rect', { class: 'sfc-ground', x: x0, y: round(yH), width: x1 - x0, height: round(y1 - yH) }));
    root.append(bands);

    // Star-sight windows: a wash over the plot, a bracket and a label above it.
    const callouts = s_('g', { class: 'sfc-callout' });
    const labelBoxes: Box[] = [];
    for (const w of data.starSights) {
      const a = xs(hourOf(w.jd_start));
      const b = xs(hourOf(w.jd_end));
      callouts.append(s_('rect', { class: 'sfc-callout-bar', x: round(a), y: y0, width: round(Math.max(2, b - a)), height: 3 }));
      const yb = y0 - 9;
      callouts.append(s_('path', { d: `M${round(a)} ${yb + 6}V${yb}H${round(b)}V${yb + 6}` }));
      const text = `★ Star sights ${clock(w.jd_start, zone)}–${clock(w.jd_end, zone)}`;
      const lp = pill((a + b) / 2, yb - 10, text, { size: 10.5 });
      const title = s_('title');
      title.textContent = `Nautical twilight ${clockZoned(w.jd_start, zone)} – ${clockZoned(w.jd_end, zone)} (${clockUtc(w.jd_start)} – ${clockUtc(w.jd_end)}): the horizon is still sharp and the brighter stars are out.`;
      lp.el.prepend(title);
      const shift = clamp((a + b) / 2, lp.box.w / 2 + 2, W - lp.box.w / 2 - 2) - (a + b) / 2;
      let dy = 0;
      if (labelBoxes.some((bx) => overlaps(bx, { ...lp.box, x: lp.box.x + shift }))) dy = -18;
      lp.el.setAttribute('transform', `translate(${round(shift)} ${dy})`);
      labelBoxes.push({ ...lp.box, x: lp.box.x + shift, y: lp.box.y + dy });
      callouts.append(lp.el);
    }
    root.append(callouts);

    // Grid and axes. Hour lines fall on the clock's whole hours, labelled every few hours by
    // the clock too: on the day the clocks change, the gap where an hour is lost (or the
    // stretch where one repeats) shows between the labels.
    const grid = s_('g', { class: 'sfc-grid' });
    const hourStep = pickStep(day.hours, Math.max(2, Math.floor((x1 - x0) / 58)), [3, 6, 12]);
    const hourMarks: { k: number; wall: number }[] = [];
    for (let k = 0; k <= Math.floor(day.hours + 1e-9); k += 1) {
      const wall = Math.round(wallHours(day, day.jd_start + k / 24, zone) * 60) / 60;
      hourMarks.push({ k, wall });
    }
    // A repeated clock hour (clocks going back) is labelled once, the first time.
    const labelled = new Set<number>();
    const major = hourMarks.filter((m) => {
      if (m.wall % hourStep !== 0 || labelled.has(m.wall)) return false;
      labelled.add(m.wall);
      return true;
    });
    for (const m of hourMarks) {
      const x = round(xs(m.k)) + 0.5;
      grid.append(s_('line', { x1: x, x2: x, y1: y0, y2: y1, class: major.includes(m) ? '' : 'sfc-grid--faint' }));
    }
    for (const a of [30, 60]) grid.append(s_('line', { x1: x0, x2: x1, y1: round(ys(a)) + 0.5, y2: round(ys(a)) + 0.5 }));
    for (const [a] of TWILIGHT_LINES) {
      grid.append(s_('line', { x1: x0, x2: x1, y1: round(ys(a)) + 0.5, y2: round(ys(a)) + 0.5, class: 'sfc-grid--faint' }));
    }
    root.append(grid);

    const axis = s_('g', { class: 'sfc-axis' });
    for (const a of [90, 60, 30, 0, -30]) {
      axis.append(svgText(x0 - 6, ys(a) + 3.5, `${a < 0 ? '−' : ''}${Math.abs(a)}°`, { 'text-anchor': 'end' }));
    }
    if (ys(-12) - ys(-6) >= 13) {
      for (const [a] of TWILIGHT_LINES) {
        axis.append(svgText(x0 - 6, ys(a) + 3.5, `−${Math.abs(a)}°`, { 'text-anchor': 'end', class: 'sfc-tick', opacity: 0.8 }));
      }
    }
    timeLabels = [];
    for (const m of major) {
      const jd = day.jd_start + m.k / 24;
      const t = svgText(xs(m.k), y1 + 16, m.k >= day.hours - 1e-9 ? endOfDay(zone) : axisTime(jd, zone), { 'text-anchor': 'middle' });
      timeLabels.push({ el: t, x: xs(m.k) });
      axis.append(t);
    }
    axis.append(s_('line', { x1: x0, x2: x1, y1: y1 + 0.5, y2: y1 + 0.5 }));
    root.append(axis);

    // Horizon and twilight labels.
    const refs = s_('g', {});
    refs.append(s_('line', { class: 'sfc-horizon', x1: x0, x2: x1, y1: round(yH), y2: round(yH) }));
    const hz = pill(x0 + 6, yH - 10, 'Horizon', { anchor: 'start', size: 10 });
    refs.append(hz.el);
    // Name the Sun's twilight zones between the reference lines (0° to −6° is civil, ...).
    let upper = 0;
    for (const [lower, name] of TWILIGHT_LINES) {
      const top = ys(upper);
      const bottom = ys(lower);
      upper = lower;
      if (bottom - top < 15) continue;
      refs.append(pill(x1 - 6, (top + bottom) / 2, name, { anchor: 'end', size: 9, cls: 'sfc-pill--zone' }).el);
    }

    // Curves.
    const series = drawOrder(visibleSeries(), selected);
    const curves = s_('g', { class: 'sfc-curves' });
    const times = data.times;
    const xAt = new Float64Array(times.length);
    for (let i = 0; i < times.length; i += 1) xAt[i] = xs(hourOf(times[i]!));
    for (const ser of series) {
      let dStr = '';
      for (let i = 0; i < ser.alt.length; i += 1) {
        const y = ys(clamp(ser.alt[i]!, ALT_MIN - 3, ALT_MAX + 3));
        dStr += `${i ? 'L' : 'M'}${round(xAt[i]!)} ${round(y)}`;
      }
      const cls = `sfc-series ${bodyClass(ser.body, ser.kind)}${
        ser.body === selected ? ' sfc-series--selected' : ser.kind === 'planet' || ser.kind === 'star' ? ' sfc-series--minor' : ''
      }`;
      const g = s_('g', { class: cls });
      g.append(
        s_('path', { class: 'sfc-below', d: dStr, 'clip-path': `url(#${clipGround})` }),
        s_('path', { class: 'sfc-casing', d: dStr, 'clip-path': `url(#${clipSky})` }),
        s_('path', { class: 'sfc-line', d: dStr, 'clip-path': `url(#${clipSky})` }),
      );
      curves.append(g);
    }
    root.append(curves, refs);

    // Rise, transit and set markers.
    const markers = s_('g', { class: 'sfc-markers' });
    const shown = new Set(series.map((x) => x.body));
    for (const m of data.markers) {
      if (!shown.has(m.body)) continue;
      const ser = data.series.find((x) => x.body === m.body)!;
      const x = xs(hourOf(m.event.jd_utc));
      const big = m.body === selected || ser.kind === 'sun' || ser.kind === 'moon';
      const r = big ? 5.5 : 4.2;
      if (m.kind === 'transit') {
        const alt = curveAt(times, ser.alt, m.event.jd_utc);
        if (!(alt > ALT_MIN)) continue;
        const y = ys(alt);
        markers.append(
          s_('path', {
            class: 'sfc-marker sfc-marker--transit',
            d: `M${round(x)} ${round(y - r)}L${round(x + r)} ${round(y)}L${round(x)} ${round(y + r)}L${round(x - r)} ${round(y)}Z`,
          }),
        );
      } else {
        const up = m.kind === 'rise';
        const y = yH;
        const tri = up
          ? `M${round(x)} ${round(y - r * 1.15)}L${round(x + r)} ${round(y + r * 0.7)}L${round(x - r)} ${round(y + r * 0.7)}Z`
          : `M${round(x)} ${round(y + r * 1.15)}L${round(x + r)} ${round(y - r * 0.7)}L${round(x - r)} ${round(y - r * 0.7)}Z`;
        markers.append(s_('path', { class: `sfc-marker sfc-marker--${m.kind}`, d: tri }));
      }
    }
    root.append(markers);

    // Direct labels at each body's highest point, most important first, never overlapping.
    const labels = s_('g', { class: 'sfc-labels' });
    const placed: Box[] = [...labelBoxes, hz.box];
    const priority = (body: string): number => {
      if (body === selected) return -1;
      const i = LABEL_PRIORITY.indexOf(body);
      return i < 0 ? LABEL_PRIORITY.length : i;
    };
    for (const ser of [...series].sort((a, b) => priority(a.body) - priority(b.body))) {
      if (!ser.everUp || ser.peakAlt <= 0) continue;
      const px0 = xAt[ser.peakIndex]!;
      const py = ys(Math.min(ser.peakAlt, ALT_MAX));
      for (const dy of [-13, 13, -28, 28]) {
        const lp = pill(px0, py + dy, ser.body, {
          size: 10.5,
          glyph: glyphFor(ser.body, ser.kind),
          cls: `${bodyClass(ser.body, ser.kind)}${ser.body === selected ? ' sfc-pill--selected' : ''}`,
        });
        const shift = clamp(px0, x0 + lp.box.w / 2 + 1, x1 - lp.box.w / 2 - 1) - px0;
        const box = { ...lp.box, x: lp.box.x + shift };
        if (box.y < y0 - 2 || box.y + box.h > yH - 1) continue;
        if (placed.some((b) => overlaps(b, box))) continue;
        if (shift) lp.el.setAttribute('transform', `translate(${round(shift)} 0)`);
        placed.push(box);
        labels.append(lp.el);
        break;
      }
    }
    root.append(labels);

    root.append(s_('rect', { class: 'sfc-frame', x: x0 + 0.5, y: y0 + 0.5, width: x1 - x0 - 1, height: plotH - 1 }));

    // The moment the clocks change, if they do today.
    const change = clockChangeIn(day, zone);
    if (change) {
      const cx = round(xs((change.jd - day.jd_start) * 24)) + 0.5;
      const cg = s_('g', { class: 'sfc-season' });
      cg.append(s_('line', { x1: cx, x2: cx, y1: y0, y2: y1 }));
      const text = `Clocks ${signedOffsetChange(change.toOffsetMs - change.fromOffsetMs)}: ${clockAt(change.jd, change.fromOffsetMs)} → ${clockAt(change.jd, change.toOffsetMs)}`;
      const lp = pill(cx, y1 - 12, text, { size: 10 });
      const shift = clamp(cx, x0 + lp.box.w / 2 + 2, x1 - lp.box.w / 2 - 2) - cx;
      if (shift) lp.el.setAttribute('transform', `translate(${round(shift)} 0)`);
      cg.append(lp.el);
      root.append(cg);
    }

    hoverLayer = s_('g', { class: 'sfc-hover', 'pointer-events': 'none' }) as SVGGElement;
    hoverLayer.style.display = 'none';
    root.append(hoverLayer);

    cursorLayer = s_('g', {
      class: 'sfc-cursor',
      tabindex: '0',
      role: 'slider',
      'aria-label': 'Time of day (moves the whole explorer)',
      'aria-valuemin': '0',
      'aria-valuemax': String(Math.round(day.hours * 60)),
    }) as SVGGElement;
    cursorLayer.append(
      s_('line', { class: 'sfc-cursor-hit', x1: 0, x2: 0, y1: y0, y2: y1 }),
      s_('line', { x1: 0, x2: 0, y1: y0, y2: y1 + 4 }),
    );
    cursorLayer.addEventListener('keydown', onCursorKey);
    root.append(cursorLayer);

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
    root.addEventListener('pointerleave', onPointerLeave);
    root.style.touchAction = 'pan-y';

    const hadFocus = svg?.contains(document.activeElement) ?? false;
    c.plot.replaceChildren(root, tip.el);
    svg = root;
    placeCursor();
    if (hadFocus) cursorLayer.focus();
    if (hoverJd !== null) drawHover();
    renderCaption();
    if (ui.get().mode === 'table') renderTable();
    c.root.dataset.ready = '1';
  }

  function s_(tag: string, attrs: Record<string, string | number | undefined> = {}): SVGElement {
    return s(tag, attrs);
  }

  function clip(id: string, x: number, y: number, w: number, hgt: number): SVGElement {
    const cp = s_('clipPath', { id });
    cp.append(s_('rect', { x: round(x), y: round(y), width: round(Math.max(0, w)), height: round(Math.max(0, hgt)) }));
    return cp;
  }

  // --- cursor and readout ----------------------------------------------------------------
  function placeCursor(): void {
    if (!geom || !cursorLayer) return;
    const jd = store.get().time.jd_utc;
    const { day, zone, xs, y1 } = geom;
    const inside = jd >= day.jd_start && jd < day.jd_end;
    cursorLayer.style.display = inside ? '' : 'none';
    if (!inside) return;
    const x = xs((jd - day.jd_start) * 24);
    cursorLayer.setAttribute('transform', `translate(${round(x)} 0)`);
    cursorLayer.querySelector('.sfc-pill')?.remove();
    const label = clock(jd, zone);
    const p = pill(0, y1 + 15, label, { size: 11, cls: 'sfc-pill--accent' });
    const shift = clamp(x, p.box.w / 2 + 1, geom.width - p.box.w / 2 - 1) - x;
    if (shift) p.el.setAttribute('transform', `translate(${round(shift)} 0)`);
    cursorLayer.append(p.el);
    // The time labels under the cursor's pill would collide with it.
    for (const t of timeLabels) t.el.style.visibility = Math.abs(t.x - (x + shift)) < p.box.w / 2 + 16 ? 'hidden' : '';
    cursorLayer.setAttribute('aria-valuenow', String(Math.round((jd - day.jd_start) * 1440)));
    cursorLayer.setAttribute('aria-valuetext', clockWithUtc(jd, zone));
  }

  function bodyStates(jd: number, bodies: string[]): BodyState[] {
    if (!bodies.length) return [];
    try {
      return ctx.engine.skyState(engineObserver(store.get()), jd, bodies).bodies;
    } catch {
      return [];
    }
  }

  function renderReadout(): void {
    if (!data) {
      readout.replaceChildren();
      return;
    }
    const s = store.get();
    const jd = s.time.jd_utc;
    const zone = data.input.zone;
    const bodies = visibleSeries().map((x) => x.body);
    const states = bodyStates(jd, bodies);
    const items: Node[] = [h('span', { class: 'sfc-readout-time' }, clockWithUtc(jd, zone))];
    for (const name of bodies) {
      const st = states.find((b) => b.body === name);
      if (!st) continue;
      const up = st.alt_apparent_deg > 0;
      items.push(
        h(
          'span',
          { class: `sfc-readout-item${up ? '' : ' sfc-readout-item--down'}` },
          glyph(name, st.kind, 13),
          name,
          h('strong', {}, altitude(st.alt_apparent_deg, s.settings.angleFormat)),
          h('span', { class: 'sfc-muted' }, bearing(st.az_deg)),
        ),
      );
    }
    readout.replaceChildren(...items);
  }

  // --- hover -----------------------------------------------------------------------------
  function drawHover(): void {
    if (!geom || !hoverLayer || !data || hoverJd === null) return;
    const { day, zone, xs, ys, y0, y1 } = geom;
    const x = xs((hoverJd - day.jd_start) * 24);
    hoverLayer.style.display = '';
    hoverLayer.replaceChildren(s_('line', { x1: round(x) + 0.5, x2: round(x) + 0.5, y1: y0, y2: y1 }));
    const series = visibleSeries();
    for (const ser of series) {
      const a = curveAt(data.times, ser.alt, hoverJd);
      if (!(a > ALT_MIN) || a > ALT_MAX) continue;
      hoverLayer.append(s_('circle', { class: `sfc-hover-dot ${bodyClass(ser.body, ser.kind)}`, cx: round(x), cy: round(ys(a)), r: 3.5, style: 'fill: var(--c)' }));
    }
    const s = store.get();
    const states = bodyStates(
      hoverJd,
      series.map((x2) => x2.body),
    )
      .slice()
      .sort((a, b) => b.alt_apparent_deg - a.alt_apparent_deg);
    const phase = phaseAt(data, hoverJd);
    const rows: Node[] = [tipHead(clockZoned(hoverJd, zone), `${clockUtc(hoverJd)}${phase ? ` · ${PHASE_LABELS[phase]}` : ''}`)];
    // Events within a few pixels of the pointer.
    const near = data.markers.filter(
      (m) => series.some((x2) => x2.body === m.body) && Math.abs(xs((m.event.jd_utc - day.jd_start) * 24) - x) < 6,
    );
    for (const m of near) {
      const verb = m.kind === 'rise' ? 'rises' : m.kind === 'set' ? 'sets' : 'crosses the meridian';
      rows.push(
        tipRow(
          clock(m.event.jd_utc, zone),
          `${m.body} ${verb}`,
          glyph(m.body, kindOf(ctx, m.body), 13),
          m.kind === 'transit' ? clockUtc(m.event.jd_utc) : `${bearing(m.event.az_deg)} · ${clockUtc(m.event.jd_utc)}`,
        ),
      );
    }
    if (near.length) rows.push(h('div', { class: 'sfc-tip-sep' }));
    for (const st of states) {
      rows.push(tipRow(altitude(st.alt_apparent_deg, s.settings.angleFormat), st.body, glyph(st.body, st.kind, 13), bearing(st.az_deg)));
    }
    tip.show(x, hoverY, rows);
  }

  function hideHover(): void {
    hoverJd = null;
    if (hoverLayer) hoverLayer.style.display = 'none';
    tip.hide();
  }

  function jdAtPointer(event: PointerEvent): number | null {
    if (!geom || !svg) return null;
    const rect = svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const hours = clamp(geom.xs.invert(px), 0, geom.day.hours);
    const minute = Math.round(hours * 60);
    return geom.day.jd_start + Math.min(minute, Math.round(geom.day.hours * 60) - 1) / 1440;
  }

  const hoverTask = (): void => drawHover();

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !geom || !svg) return;
    const jd = jdAtPointer(event);
    if (jd === null) return;
    dragging = true;
    resumePlay = store.get().time.playing;
    if (resumePlay) setPlaying(store, false);
    svg.setPointerCapture(event.pointerId);
    hideHover();
    setTime(store, jd);
    cursorLayer?.focus({ preventScroll: true });
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    const jd = jdAtPointer(event);
    if (jd === null || !geom || !svg) return;
    if (dragging) {
      setTime(store, jd);
      return;
    }
    const rect = svg.getBoundingClientRect();
    const py = event.clientY - rect.top;
    if (py < geom.y0 - 4 || py > geom.y1 + 4) {
      hideHover();
      return;
    }
    hoverJd = jd;
    hoverY = py;
    ctx.scheduler.schedule(hoverTask);
  }

  function onPointerUp(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    if (svg?.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    if (resumePlay) setPlaying(store, true);
    resumePlay = false;
  }

  function onPointerLeave(): void {
    if (!dragging) hideHover();
  }

  function onCursorKey(event: KeyboardEvent): void {
    if (!geom) return;
    const jd = store.get().time.jd_utc;
    const { day } = geom;
    let next: number | null = null;
    const minute = 1 / 1440;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = jd - (event.shiftKey ? 60 : DAY_STEP_MINUTES) * minute;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = jd + (event.shiftKey ? 60 : DAY_STEP_MINUTES) * minute;
        break;
      case 'PageUp':
        next = jd - 60 * minute;
        break;
      case 'PageDown':
        next = jd + 60 * minute;
        break;
      case 'Home':
        next = day.jd_start;
        break;
      case 'End':
        next = day.jd_end - minute;
        break;
      default:
        return;
    }
    event.preventDefault();
    setTime(store, clamp(next, day.jd_start, day.jd_end - minute));
  }

  // --- caption and table -----------------------------------------------------------------
  function summaryText(): string {
    if (!data) return 'Height of each body above the horizon through the day.';
    const zone = data.input.zone;
    const parts: string[] = [];
    const sun = data.events.get('Sun');
    if (sun) {
      const rise = sun.events.find((e) => e.kind === 'rise');
      const set = sun.events.find((e) => e.kind === 'set');
      if (sun.always_above) parts.push('The Sun stays up all day (midnight sun).');
      else if (sun.always_below) parts.push('The Sun stays below the horizon all day.');
      else {
        const bits: string[] = [];
        if (rise) bits.push(`sunrise ${clock(rise.jd_utc, zone)}`);
        if (set) bits.push(`sunset ${clock(set.jd_utc, zone)}`);
        parts.push(`${bits.join(', ')}${sun.day_length_h !== null ? ` (${duration(sun.day_length_h)} of daylight)` : ''}.`);
      }
    }
    if (data.starSights.length) {
      parts.push(
        `Star sights (nautical twilight): ${data.starSights.map((w) => `${clock(w.jd_start, zone)}–${clock(w.jd_end, zone)}`).join(' and ')}.`,
      );
    } else {
      parts.push('No nautical twilight today, so no star-sight window.');
    }
    const moon = data.events.get('Moon');
    if (moon) {
      const bits: string[] = [];
      for (const e of moon.events) {
        if (e.kind === 'rise') bits.push(`rises ${clock(e.jd_utc, zone)}`);
        if (e.kind === 'set') bits.push(`sets ${clock(e.jd_utc, zone)}`);
      }
      if (moon.always_above) bits.push('is up all day');
      if (moon.always_below) bits.push('stays below the horizon');
      if (bits.length) parts.push(`The Moon ${bits.join(', ')}.`);
    }
    const text = parts.join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function renderCaption(): void {
    c.caption.replaceChildren(
      summaryText(),
      ' ',
      h('span', { class: 'sfc-muted' }, 'Heights are what the eye sees (refraction included); bearings from true north. Times are local; hover for UTC.'),
    );
    const notes: Node[] = [];
    if (data?.errors.length) {
      notes.push(
        h('p', { class: 'sfc-note' }, `Not drawn: ${data.errors.map((e) => `${e.body} (${e.message})`).join('; ')}.`),
      );
    }
    c.notes.replaceChildren(...notes);
  }

  function renderTable(): void {
    if (!data) {
      c.tableWrap.replaceChildren(h('p', { class: 'sfc-message' }, failure ?? 'Nothing to show.'));
      return;
    }
    const s = store.get();
    const zone = data.input.zone;
    const day = data.input.day;
    const fmt = s.settings.angleFormat;

    const ev = table(`Rise, highest point and set, ${dateLong(day.date)} (times ${zoneLabel(day.jd_start + 0.5, zone)})`, [
      'Body',
      'Rises',
      'Bearing',
      'Crosses the meridian',
      'Height then',
      'Sets',
      'Bearing',
    ]);
    for (const ser of data.series) {
      const be = data.events.get(ser.body);
      const rises = be?.events.filter((e) => e.kind === 'rise') ?? [];
      const sets = be?.events.filter((e) => e.kind === 'set') ?? [];
      const transits = be?.events.filter((e) => e.kind === 'transit') ?? [];
      const states = transits.length ? bodyStates(transits[0]!.jd_utc, [ser.body]) : [];
      const note = be?.always_above ? 'up all day' : be?.always_below ? 'below the horizon all day' : '—';
      const cellTimes = (list: typeof rises): (Node | string)[] =>
        list.length ? list.flatMap((e, i) => [i ? ', ' : '', timeButton(e.jd_utc, zone)]) : [h('span', { class: 'sfc-muted' }, note)];
      ev.body.append(
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, ser.body),
          h('td', {}, ...cellTimes(rises)),
          h('td', {}, rises.map((e) => bearing(e.az_deg)).join(', ') || ''),
          h('td', {}, ...(transits.length ? transits.flatMap((e, i) => [i ? ', ' : '', timeButton(e.jd_utc, zone)]) : ['—'])),
          h('td', {}, states[0] ? altitude(states[0].alt_apparent_deg, fmt) : '—'),
          h('td', {}, ...cellTimes(sets)),
          h('td', {}, sets.map((e) => bearing(e.az_deg)).join(', ') || ''),
        ),
      );
    }

    const hourly = table(`Height above the horizon, hour by hour (what the eye sees; negative is below the horizon)`, [
      'Time',
      ...data.series.map((x) => x.body),
    ]);
    const per = Math.round(60 / DAY_STEP_MINUTES);
    const now = store.get().time.jd_utc;
    for (let i = 0; i < data.times.length; i += per) {
      const jd = data.times[i]!;
      if (jd >= day.jd_end - 1e-9) break;
      hourly.body.append(
        h(
          'tr',
          { class: now >= jd && now < jd + 1 / 24 ? 'sfc-row-current' : '' },
          h('th', { scope: 'row' }, timeButton(jd, zone)),
          ...data.series.map((x) => h('td', {}, altitude(x.alt[i]!, fmt))),
        ),
      );
    }

    const ph = table('The sky through the day (from the Sun’s height)', ['From', 'To', 'Sky', 'Note']);
    for (const p of data.phases) {
      const star = data.starSights.find((w) => w.jd_start === p.jd_start);
      ph.body.append(
        h(
          'tr',
          {},
          h('td', {}, p.jd_start <= day.jd_start ? '00:00' : timeButton(p.jd_start, zone)),
          h('td', {}, p.jd_end >= day.jd_end ? '24:00' : timeButton(p.jd_end, zone)),
          h('td', { class: 'sfc-text' }, PHASE_LABELS[p.phase]),
          h('td', { class: 'sfc-text' }, star ? 'Best time for star sights: horizon still sharp, brighter stars out' : ''),
        ),
      );
    }
    c.tableWrap.replaceChildren(ev.table, ph.table, hourly.table);
    c.root.dataset.ready = '1';
  }

  // --- wiring ----------------------------------------------------------------------------
  // One render task. Store changes and resizes only mark what is stale; the task redoes the
  // least it can: new data (a new day, place or body list), a new drawing, or just the cursor.
  let dataDirty = true;
  let drawDirty = true;
  function frame(): void {
    if (dataDirty) {
      dataDirty = false;
      drawDirty = true;
      recompute();
      renderLegend();
      // The table is what is showing: it needs the new numbers even though nothing is drawn.
      if (ui.get().mode === 'table') {
        renderHeader();
        renderTable();
      }
    }
    if (drawDirty) {
      drawDirty = false;
      draw();
    }
    placeCursor();
    renderReadout();
  }
  function schedule(): void {
    drawDirty = true;
    ctx.scheduler.schedule(frame);
  }

  d.add(
    watch(
      ctx,
      (s) => {
        const input = inputFor(s);
        return [
          observerKey(input.observer),
          zoneKey(input.zone),
          input.day.key,
          input.day.jd_start,
          input.bodies.join(','),
          input.options.horizon,
          input.options.height_of_eye_m,
          s.selection.body ?? '',
        ].join('|');
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
      (s) => s.time.jd_utc,
      () => {
        placeCursor();
        renderReadout();
      },
      { immediate: false },
    ),
  );
  d.add(
    watch(
      ctx,
      (s) => `${s.settings.angleFormat}|${s.settings.navigatorTerms}`,
      () => {
        renderHeader();
        renderReadout();
        if (ui.get().mode === 'table') renderTable();
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
