/**
 * The Tides tab (charts2 agent, expansion programme Q5): predicted high and low water and the
 * tide curve at the US tide station nearest the place (or one the person picks), for the app's
 * day or the week from it, on a chosen datum, with the app's time as a cursor. OWNER:
 * charts2 agent.
 *
 * The numbers come from the optional `tides-us` pack (NOAA's harmonic constants for 3 499
 * stations, EXPLORER_API "Expansion programme — tides"). The pack is asked for once
 * (`ctx.packs.ensure`); declined, the tab says so and offers Get. Every picture, table and
 * file says what the numbers are: **predicted, not observed**, US stations, weather and surge
 * not included.
 */

import { h, s } from '../../dom.js';
import { observerKey } from '../component.js';
import { isTidesEngine, TIDE_LABEL, type TideDatum, type TideEvent } from '../engine/types.js';
import { mapServiceFor, pointFeature } from '../map/overlays.js';
import { formatBytes } from '../packs/service.js';
import { setTime, stepTime } from '../playback.js';
import { axisTime, endOfDay, formatDistance } from '../shell/format.js';
import { displayZone, engineObserver, eventOptions, type ExplorerState } from '../state.js';
import { button, segmented } from '../theme/primitives.js';
import { zoneLabel, type Zone } from '../time.js';
import { localDayCache, mountChart, NotAvailableError, placeName, type Shell } from './chart-shell.js';
import { bearing, clock, clockWithUtc, dateLong, dateShort, WEEKDAYS_SHORT } from './format.js';
import { errorText, overlaps, pill, round, stepperNav, svgText, table, timeButton, tipHead, tipRow, tooltip, type Box, type ChartComponent, type Tooltip } from './frame.js';
import { clipRect, frameRect, linePath, niceStep, svgRoot } from './plot.js';
import { clamp, linearScale, type LinearScale } from './scale.js';
import {
  computeTides,
  DATUM_WORDS,
  FAR_STATION_KM,
  heightAt,
  heightText,
  heightUnit,
  heightValue,
  rateAt,
  rateText,
  tideAround,
  type TideData,
  type TideInput,
  type TideSpan,
} from './tides-data.js';
import { localDateOf, wallHours, zoneKey } from './windows.js';

/** The tab's own choices, remembered for the page's lifetime. */
const choice: { span: TideSpan; datum: TideDatum | ''; station: { observer: string; id: string | null } } = {
  span: 'day',
  datum: '',
  station: { observer: '', id: null },
};

/** Choose the span and datum before the tab mounts (the developer page; links from other views). */
export function presetTides(options: { span?: TideSpan; datum?: TideDatum | '' }): void {
  if (options.span) choice.span = options.span;
  if (options.datum !== undefined) choice.datum = options.datum;
}

const PACK = 'tides-us';
const PACK_REASON = 'Tide predictions need the US tides data pack.';

/** Thrown while the tides pack is not loaded. */
class PackMissingError extends Error {
  constructor() {
    super('The tide curve and the tables appear here once the US tides data pack is loaded.');
    this.name = 'PackMissingError';
  }
}


export const tidesChart: ChartComponent = (host, ctx, ui) => {
  const dayOf = localDayCache();
  let alive = true;
  let packStatus: 'ok' | 'asking' | 'declined' = 'ok';
  let geom: {
    svg: SVGSVGElement;
    xs: LinearScale;
    ys: LinearScale;
    top: number;
    bottom: number;
    x0: number;
    x1: number;
    data: TideData;
  } | null = null;
  let tip: Tooltip | null = null;
  const readout = h('p', { class: 'sfc-readout sfc-readout--line', 'aria-live': 'off' });
  const label = h('p', { class: 'sfc-estimate' });
  const packBox = h('div', { class: 'sfc-packbox', hidden: true });
  const stationSelect = h('select', { class: 'sfc-select sfc-station', 'aria-label': 'Tide station' });
  const datumSelect = h('select', { class: 'sfc-select', 'aria-label': 'Heights above (datum)' });
  const mapButton = button({ label: 'Show on the map', icon: 'map', size: 'sm', variant: 'ghost', tip: 'Mark the station on the map and go there' });
  const noaaLink = h('a', { class: 'sfc-link', target: '_blank', rel: 'noopener noreferrer' }, 'NOAA’s page ↗');
  /** The station and datum pickers: shown once there are stations to pick from. */
  let controls: HTMLElement | null = null;

  const inputFor = (state: ExplorerState): TideInput => {
    const zone = displayZone(state);
    const observer = engineObserver(state);
    const ok = observerKey(observer);
    return {
      observer,
      zone,
      day: dayOf(state.time.jd_utc, zone),
      span: choice.span,
      datum: choice.datum,
      stationId: choice.station.observer === ok ? choice.station.id : null,
      options: eventOptions(state),
    };
  };

  return mountChart<TideInput, TideData>(host, ctx, ui, {
    kind: 'tides',
    heading: 'Tides',
    heavy: true,
    input: inputFor,
    key: (i) => [observerKey(i.observer), zoneKey(i.zone), i.day.key, i.day.jd_start, i.span, i.datum, i.stationId ?? '', i.options.horizon].join('|'),
    compute(input) {
      const engine = ctx.engine;
      if (!isTidesEngine(engine)) throw new NotAvailableError('Tide predictions');
      if (!engine.tidePackInfo()) throw new PackMissingError();
      return computeTides(engine, input);
    },
    failureText(error) {
      if (error instanceof PackMissingError) return error.message;
      const text = errorText(error);
      if (/outside_range/.test(text)) return 'Tide predictions are offered from 1900 to 2100 only: the harmonic constants describe today’s harbours.';
      if (/pack_not_loaded/.test(text)) return new PackMissingError().message;
      return `The tides could not be predicted: ${text}`;
    },
    setup(shell) {
      const { c } = shell;
      stepperNav(c.nav, 'Earlier', 'Later', (dir) => stepTime(ctx.store, { unit: 'day', count: choice.span === 'week' ? 7 * dir : dir }));
      const span = segmented<TideSpan>({
        label: 'Span',
        size: 'sm',
        value: choice.span,
        options: [
          { value: 'day', label: 'Day', tip: 'The app’s day' },
          { value: 'week', label: 'Week', tip: 'Seven days from the app’s day' },
        ],
        onChange: (v) => {
          choice.span = v;
          shell.refresh();
        },
      });
      c.actions.append(span.el);
      stationSelect.addEventListener('change', () => {
        choice.station = { observer: observerKey(engineObserver(ctx.store.get())), id: stationSelect.value || null };
        shell.refresh();
      });
      datumSelect.addEventListener('change', () => {
        choice.datum = datumSelect.value as TideDatum | '';
        shell.refresh();
      });
      mapButton.addEventListener('click', () => {
        const st = shell.data?.station;
        if (!st) return;
        const map = mapServiceFor(ctx);
        // Listed in the map's Layers as "The tide station from Charts" (map/controls.ts
        // OVERLAY_OWNERS, the `charts-` prefix).
        map.addOverlay(
          'charts-tide-station',
          { type: 'FeatureCollection', features: [pointFeature({ lat_deg: st.lat_deg, lon_deg: st.lon_deg }, { label: `Tide station: ${st.name}` })] },
          { color: '--info', labelProperty: 'label', pointRadius: 6 },
        );
        map.flyTo({ lat_deg: st.lat_deg, lon_deg: st.lon_deg }, 10);
        ctx.store.patch({ view: 'map' });
      });
      controls = h(
        'div',
        { class: 'sfc-controls', role: 'group', 'aria-label': 'Station and datum', hidden: true },
        h('label', { class: 'sfc-control' }, h('span', {}, 'Station'), stationSelect),
        h('label', { class: 'sfc-control' }, h('span', {}, 'Heights above'), datumSelect),
        mapButton,
        noaaLink,
      );
      c.root.insertBefore(controls, c.legend);
      c.legend.replaceChildren(
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-line sfc-key-line--tide', 'aria-hidden': 'true' }), 'Predicted height'),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-mark sfc-key-mark--high', 'aria-hidden': 'true' }), 'High water'),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-mark sfc-key-mark--low', 'aria-hidden': 'true' }), 'Low water'),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-swatch sfc-swatch--night', 'aria-hidden': 'true' }), 'Night (strip below)'),
      );
      c.root.insertBefore(label, c.legend);
      c.root.insertBefore(packBox, c.legend);
      c.figure.insertBefore(readout, c.caption);
      tip = tooltip(c.plot);
      label.replaceChildren(h('strong', {}, 'Predicted, not observed.'), ` ${TIDE_LABEL.replace(/^US stations \(NOAA\); predictions, not observations; /, 'US stations (NOAA); ')}.`);
      const stopPacks = ctx.packs.subscribe(() => renderPack(shell));
      void ensurePack(shell);
      return () => {
        alive = false;
        stopPacks();
      };
    },
    header(shell) {
      const st = ctx.store.get();
      const i = shell.input;
      const station = shell.data?.station;
      shell.c.title.replaceChildren(station ? `Tides · ${station.name}${station.state ? `, ${station.state}` : ''}` : 'Tides');
      if (st.settings.navigatorTerms) shell.c.title.append(h('span', { class: 'sfc-term', 'data-term': '' }, ' · tide tables'));
      const when = i.span === 'day' ? dateLong(i.day.date) : `7 days from ${dateShort(i.day.date)}`;
      shell.c.subtitle.textContent = `${when} · near ${placeName(st)} · local times, ${zoneLabel(i.day.jd_start + 0.5, i.zone)}`;
      const navLabel = shell.c.nav.querySelector('.sfc-nav-label');
      if (navLabel) navLabel.textContent = i.span === 'day' ? dateShort(i.day.date) : `from ${dateShort(i.day.date)}`;
      const have = shell.data !== null && shell.failure === null;
      if (controls) controls.hidden = !have;
      shell.c.legend.hidden = !have || shell.ui.get().mode === 'table';
      if (!have) readout.replaceChildren();
      renderPack(shell);
    },
    draw: (shell) => draw(shell),
    cursor: (shell) => placeCursor(shell),
    table: (shell) => tables(shell),
    displayKey: (st) => `${st.settings.units}|${st.settings.navigatorTerms}`,
    fileParts: (shell) => ['tides', shell.data?.station.id ?? 'station', shell.input.day.key, shell.input.span],
    labels: (shell) => {
      const d = shell.data;
      if (!d) return ['Predicted, not observed.', TIDE_LABEL];
      const units = ctx.store.get().settings.units;
      return [
        `Predicted, not observed: ${d.extremes.label.replace(/; predictions, not observations/, '')}.`,
        `Station ${d.station.name}${d.station.state ? `, ${d.station.state}` : ''} (NOAA ${d.station.id}), ${formatDistance(d.station.distance_km, units)} from the place.`,
        `Heights in ${heightUnit(units).unit} above ${d.datum}: ${DATUM_WORDS[d.datum]}.`,
        ...d.station.notes,
        ...d.extremes.notes,
      ];
    },
  });

  // --- the pack ---------------------------------------------------------------------------
  async function ensurePack(shell: Shell<TideInput, TideData>): Promise<void> {
    const engine = ctx.engine;
    if (!isTidesEngine(engine) || engine.tidePackInfo()) return;
    packStatus = 'asking';
    renderPack(shell);
    const ok = await ctx.packs.ensure(PACK, PACK_REASON);
    if (!alive) return;
    packStatus = ok && engine.tidePackInfo() ? 'ok' : 'declined';
    renderPack(shell);
    shell.refresh();
  }

  function renderPack(shell: Shell<TideInput, TideData>): void {
    const engine = ctx.engine;
    if (!isTidesEngine(engine) || engine.tidePackInfo()) {
      packStatus = 'ok';
      packBox.hidden = true;
      return;
    }
    const state = ctx.packs.status().find((p) => p.name === PACK);
    packBox.hidden = false;
    if (packStatus === 'asking') {
      packBox.replaceChildren(h('p', { role: 'status' }, `${PACK_REASON} Answer the card at the bottom of the view to get it.`));
      return;
    }
    if (!state || !state.offered) {
      packBox.replaceChildren(h('p', {}, `${PACK_REASON} This page does not offer it here.`));
      return;
    }
    const size = formatBytes(state.bytes);
    const progress = state.progress;
    const get = button({
      label: progress ? 'Downloading…' : state.error ? 'Try again' : `Get the pack (${size})`,
      variant: 'primary',
      size: 'sm',
      onClick: async () => {
        const ok = await ctx.packs.get(PACK);
        if (!alive) return;
        if (ok) {
          packStatus = 'ok';
          shell.refresh();
        }
        renderPack(shell);
      },
    });
    if (progress) get.setAttribute('disabled', '');
    const parts: HTMLElement[] = [
      h(
        'p',
        {},
        h('strong', {}, 'Not saved on this device. '),
        `Tide predictions come from the US tides data pack (${state.description ? state.description.replace(/\.$/, '') : 'NOAA’s tide stations'}): ${size}, downloaded once and kept for offline use.`,
      ),
    ];
    if (progress) parts.push(h('p', { role: 'status' }, `Downloading… ${Math.round((100 * progress.received) / Math.max(1, progress.total))} %`));
    if (state.error) parts.push(h('p', { class: 'sfc-note' }, state.error));
    parts.push(get);
    packBox.replaceChildren(...parts);
  }

  // --- drawing ----------------------------------------------------------------------------
  function draw(shell: Shell<TideInput, TideData>): SVGSVGElement {
    const data = shell.data!;
    const st = ctx.store.get();
    const units = st.settings.units;
    const zone = data.input.zone;
    renderControls(shell);
    const W = shell.width;
    const narrow = W < 560;
    const week = data.input.span === 'week';
    const x0 = narrow ? 44 : 56;
    const x1 = W - (narrow ? 8 : 14);
    const top = 30;
    const plotH = Math.round(clamp(W * 0.34, 220, 380));
    const bottom = top + plotH;
    const strip = 8;
    const axisY = bottom + strip + 16;
    const H = axisY + (week ? 18 : 10);
    const u = heightUnit(units);
    const heights: number[] = [...(data.curve ? Array.from(data.curve.height_m) : []), ...data.extremes.extremes.map((e) => e.height_m), 0];
    const lo = Math.min(...heights);
    const hi = Math.max(...heights);
    const padH = Math.max(0.1, (hi - lo) * 0.12);
    const ys = linearScale([(lo - padH) * u.perMetre, (hi + padH) * u.perMetre], [bottom, top]);
    const yM = (m: number): number => ys(m * u.perMetre);
    const xs = linearScale([data.window.start, data.window.end], [x0, x1]);
    const svg = svgRoot(W, H, summary(shell), 'img');
    const clip = clipRect(x0, top, x1 - x0, bottom - top);
    svg.append(clip.defs);

    // Grid: heights, and hours (a day) or midnights (a week).
    const grid = s('g', { class: 'sfc-grid' });
    const axis = s('g', { class: 'sfc-axis' });
    const step = niceStep((ys.domain[1] - ys.domain[0]) || 1, 5);
    for (let v = Math.ceil(ys.domain[0] / step) * step; v <= ys.domain[1] + 1e-9; v += step) {
      const y = round(ys(v)) + 0.5;
      grid.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, class: Math.abs(v) < 1e-9 ? 'sfc-datum-line' : 'sfc-grid--faint' }));
      axis.append(svgText(x0 - 6, y + 3.5, `${Math.abs(v) < 1e-9 ? '0' : `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(step < 1 ? 1 : 0)}`} ${u.unit}`, { 'text-anchor': 'end' }));
    }
    const y0line = yM(0);
    axis.append(svgText(x1 - 4, y0line - 4, data.datum, { 'text-anchor': 'end', class: 'sfc-datum-label' }));
    for (const day of data.window.days) {
      if (week) {
        const x = round(xs(day.jd_start)) + 0.5;
        if (day !== data.window.days[0]) grid.append(s('line', { x1: x, x2: x, y1: top, y2: bottom }));
        const mid = xs((day.jd_start + day.jd_end) / 2);
        const wd = WEEKDAYS_SHORT[weekdayIndex(day.date)]!;
        axis.append(svgText(mid, axisY, narrow ? wd.charAt(0) : `${wd} ${day.date.day}`, { 'text-anchor': 'middle' }));
        continue;
      }
      const hourStep = narrow ? 6 : 3;
      for (let k = 0; k <= Math.floor(day.hours + 1e-9); k += 1) {
        const jd = day.jd_start + k / 24;
        const wall = Math.round(wallHours(day, jd, zone));
        if (wall % hourStep !== 0 && k < day.hours - 1e-9) continue;
        const x = round(xs(jd)) + 0.5;
        grid.append(s('line', { x1: x, x2: x, y1: top, y2: bottom, class: 'sfc-grid--faint' }));
        axis.append(svgText(x, axisY, k >= day.hours - 1e-9 ? endOfDay(zone) : axisTime(jd, zone), { 'text-anchor': 'middle' }));
      }
    }
    svg.append(grid, axis);

    // Day and night: a strip under the plot (the Sun's phases, the same colours as the time bar).
    const ribbon = s('g', { class: 'sfc-tide-ribbon' });
    for (const p of data.phases) {
      const a = xs(Math.max(p.jd_start, data.window.start));
      const b = xs(Math.min(p.jd_end, data.window.end));
      if (b <= a) continue;
      ribbon.append(s('rect', { class: `sfc-ph-${p.phase}`, x: round(a), y: bottom + 2, width: round(b - a + 0.5), height: strip }));
    }
    svg.append(ribbon);

    // The curve: water below it, the line on top (dashed where it is only an estimate).
    const plot = s('g', { 'clip-path': clip.url });
    if (data.curve && data.curve.jd_utc.length > 1) {
      const pts: [number, number][] = [];
      for (let i = 0; i < data.curve.jd_utc.length; i += 1) pts.push([xs(data.curve.jd_utc[i]!), yM(data.curve.height_m[i]!)]);
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      const d = linePath(pts);
      plot.append(
        s('path', { class: 'sfc-tide-water', d: `${d}L${round(last[0])} ${bottom}L${round(first[0])} ${bottom}Z` }),
        s('path', { class: `sfc-tide-line${data.curve.method === 'interpolated' ? ' sfc-tide-line--estimated' : ''}`, d }),
      );
    }
    svg.append(plot);

    // High and low water.
    const marks = s('g', { class: 'sfc-tide-marks' });
    const boxes: Box[] = [];
    for (const e of data.extremes.extremes) {
      const x = xs(e.jd_utc);
      const y = yM(e.height_m);
      const r = 5;
      const high = e.kind === 'high';
      marks.append(
        s('path', {
          class: `sfc-marker sfc-marker--${high ? 'high' : 'low'}`,
          d: high
            ? `M${round(x)} ${round(y - r * 1.2)}L${round(x + r)} ${round(y + r * 0.6)}L${round(x - r)} ${round(y + r * 0.6)}Z`
            : `M${round(x)} ${round(y + r * 1.2)}L${round(x + r)} ${round(y - r * 0.6)}L${round(x - r)} ${round(y - r * 0.6)}Z`,
        }),
      );
      const text = week ? heightText(e.height_m, units) : `${clock(e.jd_utc, zone)} · ${heightText(e.height_m, units)}`;
      const lp = pill(clamp(x, x0 + 40, x1 - 40), y + (high ? -15 : 15), text, { size: 10 });
      if (boxes.some((b) => overlaps(b, lp.box, 1))) continue;
      boxes.push(lp.box);
      marks.append(lp.el);
    }
    svg.append(marks, frameRect(x0, top, x1, bottom));

    // The app's time.
    const cursor = s('g', { class: 'sfc-cursor sfc-cursor--static', 'pointer-events': 'none' });
    svg.append(cursor);
    const hover = s('g', { class: 'sfc-hover', 'pointer-events': 'none' });
    svg.append(hover);
    svg.addEventListener('pointermove', (event) => onHover(event, hover as SVGGElement));
    svg.addEventListener('pointerleave', () => {
      tip?.hide();
      hover.replaceChildren();
    });
    svg.addEventListener('click', (event) => {
      if (!geom) return;
      const rect = svg.getBoundingClientRect();
      const px = event.clientX - rect.left;
      if (px < geom.x0 || px > geom.x1) return;
      setTime(ctx.store, Math.round(geom.xs.invert(px) * 1440) / 1440);
    });
    svg.style.cursor = 'crosshair';
    geom = { svg, xs, ys, top, bottom, x0, x1, data };
    shell.c.plot.replaceChildren(svg, tip!.el);
    placeCursor(shell);

    shell.c.caption.replaceChildren(
      summary(shell),
      ' ',
      h('span', { class: 'sfc-muted' }, 'Click the chart to go to that time; hover for the height.'),
    );
    const notes: HTMLElement[] = [];
    if (data.station.distance_km > FAR_STATION_KM) {
      notes.push(
        h(
          'p',
          { class: 'sfc-note' },
          `The nearest station is ${formatDistance(data.station.distance_km, units)} away (${bearing(data.station.bearing_deg)}): the tide changes along a coast, so this may say little about the water at your place.`,
        ),
      );
    }
    for (const n of [...data.station.notes, ...data.extremes.notes]) notes.push(h('p', { class: 'sfc-note' }, n));
    shell.c.notes.replaceChildren(...notes);
    return svg;
  }

  function weekdayIndex(date: { year: number; month: number; day: number }): number {
    const d = new Date(0);
    d.setUTCFullYear(date.year, date.month - 1, date.day);
    return d.getUTCDay();
  }

  function renderControls(shell: Shell<TideInput, TideData>): void {
    const data = shell.data!;
    const units = ctx.store.get().settings.units;
    const options = data.near.map((st) =>
      h(
        'option',
        { value: st.id, selected: st.id === data.station.id },
        `${st.name}${st.state ? `, ${st.state}` : ''} · ${formatDistance(st.distance_km, units)} ${bearingWord(st.bearing_deg)}${st.kind === 'subordinate' ? ' · high and low only' : ''}`,
      ),
    );
    stationSelect.replaceChildren(...options);
    stationSelect.value = data.station.id;
    datumSelect.replaceChildren(
      ...data.station.datums.map((d) => h('option', { value: d, selected: d === data.datum }, `${d}: ${DATUM_WORDS[d]}`)),
    );
    datumSelect.value = data.datum;
    noaaLink.setAttribute('href', `https://tidesandcurrents.noaa.gov/stationhome.html?id=${encodeURIComponent(data.station.id)}`);
    noaaLink.hidden = ctx.engine.kind === 'mock';
  }

  function bearingWord(az: number): string {
    return bearing(az).replace(/^\d+° /, '');
  }

  function placeCursor(shell: Shell<TideInput, TideData>): void {
    const st = ctx.store.get();
    const jd = st.time.jd_utc;
    const data = shell.data;
    if (!data) return;
    const units = st.settings.units;
    const zone = data.input.zone;
    if (geom) {
      const cursor = geom.svg.querySelector<SVGGElement>('.sfc-cursor');
      if (cursor) {
        cursor.replaceChildren();
        const inside = jd >= data.window.start && jd < data.window.end;
        if (inside) {
          const x = round(geom.xs(jd));
          cursor.append(s('line', { x1: x, x2: x, y1: geom.top, y2: geom.bottom }));
          const hgt = data.curve ? heightAt(data.curve, jd) : null;
          if (hgt !== null) cursor.append(s('circle', { class: 'sfc-cursor-dot', cx: x, cy: round(geom.ys(hgt * heightUnit(units).perMetre)), r: 4.5 }));
        }
      }
    }
    readout.replaceChildren(readoutText(data, jd, zone, units));
  }

  function readoutText(data: TideData, jd: number, zone: Zone, units: ExplorerState['settings']['units']): string {
    const when = clockWithUtc(jd, zone);
    const around = tideAround(data.around, jd);
    const nextText = (e: TideEvent | null, name: string): string =>
      e ? `next ${name} ${e.jd_utc - jd > 1 ? `${WEEKDAYS_SHORT[weekdayIndex(localDateOf(e.jd_utc, zone))]} ` : ''}${clock(e.jd_utc, zone)} (${heightText(e.height_m, units)})` : '';
    const nexts = [nextText(around.nextHigh, 'high water'), nextText(around.nextLow, 'low water')].filter(Boolean).join(', ');
    const hgt = data.curve ? heightAt(data.curve, jd) : null;
    if (hgt === null) return `${when}: ${nexts ? `${nexts.charAt(0).toUpperCase()}${nexts.slice(1)}.` : 'outside this window.'}`;
    const rate = rateAt(data.curve!, jd) ?? 0;
    const state = rate > 0 ? 'rising' : 'falling';
    return `${when}: ${heightText(hgt, units)} above ${data.datum}, ${state} ${rateText(rate, units)} (predicted)${nexts ? `; ${nexts}` : ''}.`;
  }

  function onHover(event: PointerEvent, layer: SVGGElement): void {
    if (!geom || !tip) return;
    const rect = geom.svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (px < geom.x0 || px > geom.x1 || py < geom.top - 4 || py > geom.bottom + 12) {
      tip.hide();
      layer.replaceChildren();
      return;
    }
    const jd = geom.xs.invert(px);
    const data = geom.data;
    const units = ctx.store.get().settings.units;
    const hgt = data.curve ? heightAt(data.curve, jd) : null;
    const x = round(px) + 0.5;
    layer.replaceChildren(s('line', { x1: x, x2: x, y1: geom.top, y2: geom.bottom }));
    const rows: Node[] = [tipHead(clockWithUtc(jd, data.input.zone))];
    if (hgt !== null) rows.push(tipRow(heightText(hgt, units), `above ${data.datum} (predicted)`));
    const near = data.extremes.extremes.find((e) => Math.abs(geom!.xs(e.jd_utc) - px) < 8);
    if (near) rows.push(tipRow(clock(near.jd_utc, data.input.zone), `${near.kind === 'high' ? 'High' : 'Low'} water, ${heightText(near.height_m, units)}`));
    tip.show(px, py, rows);
  }

  function summary(shell: Shell<TideInput, TideData>): string {
    const data = shell.data;
    if (!data) return 'Predicted high and low water at a US tide station.';
    const units = ctx.store.get().settings.units;
    const zone = data.input.zone;
    const ex = data.extremes.extremes;
    const parts: string[] = [];
    if (data.input.span === 'day') {
      const highs = ex.filter((e) => e.kind === 'high').map((e) => `${clock(e.jd_utc, zone)} (${heightText(e.height_m, units)})`);
      const lows = ex.filter((e) => e.kind === 'low').map((e) => `${clock(e.jd_utc, zone)} (${heightText(e.height_m, units)})`);
      if (highs.length) parts.push(`High water ${highs.join(' and ')}.`);
      if (lows.length) parts.push(`Low water ${lows.join(' and ')}.`);
      if (!ex.length) parts.push('No high or low water falls on this day.');
    } else {
      const highs = ex.filter((e) => e.kind === 'high');
      const lows = ex.filter((e) => e.kind === 'low');
      const top = highs.reduce<TideEvent | null>((a, e) => (!a || e.height_m > a.height_m ? e : a), null);
      const bottomEv = lows.reduce<TideEvent | null>((a, e) => (!a || e.height_m < a.height_m ? e : a), null);
      parts.push(`${highs.length} high and ${lows.length} low waters in the week.`);
      if (top) parts.push(`Highest ${heightText(top.height_m, units)} on ${dateShort(localDateOf(top.jd_utc, zone))} at ${clock(top.jd_utc, zone)}.`);
      if (bottomEv) parts.push(`Lowest ${heightText(bottomEv.height_m, units)} on ${dateShort(localDateOf(bottomEv.jd_utc, zone))} at ${clock(bottomEv.jd_utc, zone)}.`);
    }
    parts.push(`Heights above ${data.datum}, ${DATUM_WORDS[data.datum]}.`);
    if (data.curve?.method === 'interpolated') parts.push('This is a subordinate station: NOAA predicts only its high and low water, and the curve between them is an estimate (dashed).');
    if (!data.curve) parts.push('This station has high and low water only; no curve.');
    return parts.join(' ');
  }

  function tables(shell: Shell<TideInput, TideData>): HTMLElement[] {
    const data = shell.data!;
    const st = ctx.store.get();
    const units = st.settings.units;
    const zone = data.input.zone;
    const u = heightUnit(units).unit;
    const ex = table(
      `High and low water at ${data.station.name} (predicted; local times, ${zoneLabel(data.window.start + 0.5, zone)}; heights in ${u} above ${data.datum})`,
      ['Date', 'Time', 'Tide', `Height (${u})`],
    );
    // time-ui: the tier chip belongs beside this caption (tides are offered 1900-2100 only).
    for (const e of data.extremes.extremes) {
      ex.body.append(
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, dateShort(localDateOf(e.jd_utc, zone))),
          h('td', {}, timeButton(e.jd_utc, zone)),
          h('td', { class: 'sfc-text' }, e.kind === 'high' ? 'High water' : 'Low water'),
          h('td', { 'data-csv': heightValue(e.height_m, units) }, heightText(e.height_m, units)),
        ),
      );
    }
    const out: HTMLElement[] = [ex.table];
    if (data.curve) {
      const every = data.input.span === 'day' ? 1 : 3;
      const hourly = table(`Predicted height every ${every === 1 ? 'hour' : `${every} hours`} (${u} above ${data.datum})`, ['Date', 'Time', `Height (${u})`]);
      const now = st.time.jd_utc;
      for (const day of data.window.days) {
        for (let k = 0; k < Math.round(day.hours); k += every) {
          const jd = day.jd_start + k / 24;
          const hgt = heightAt(data.curve, jd);
          if (hgt === null) continue;
          hourly.body.append(
            h(
              'tr',
              { class: now >= jd && now < jd + every / 24 ? 'sfc-row-current' : '' },
              h('th', { scope: 'row' }, dateShort(day.date)),
              h('td', {}, timeButton(jd, zone)),
              h('td', { 'data-csv': heightValue(hgt, units) }, heightText(hgt, units)),
            ),
          );
        }
      }
      out.push(hourly.table);
    }
    return out;
  }
};
