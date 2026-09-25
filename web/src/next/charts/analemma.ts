/**
 * The analemma (charts2 agent, expansion programme Q5): where the Sun stands at one clock
 * time on every day of the year, the figure-8 a camera fixed to the same spot would record.
 * OWNER: charts2 agent.
 *
 * The engine's `analemma` gives the Sun's apparent altitude and azimuth at the chosen time
 * on each day, on local mean time (the default: the figure is centred on the meridian at
 * 12:00) or on a zone's standard time all year. The picture is the sky around the figure in
 * a stereographic projection (a camera's view that keeps shapes, the zenith included), with
 * lines of equal height every 10° and of equal bearing, and the horizon. The figure's width
 * is the equation of time and its height the Sun's declination: see the "Equation of time"
 * chart for both through the year.
 */

import { h, s } from '../../dom.js';
import { observerKey } from '../component.js';
import { isSunToolsEngine, type AnalemmaClock, type AnalemmaPoint } from '../engine/types.js';
import { stepTime } from '../playback.js';
import { displayZone, engineObserver, type ExplorerState } from '../state.js';
import { segmented } from '../theme/primitives.js';
import { zoneLabel } from '../time.js';
import { localDayCache, mountChart, NotAvailableError, placeName, type Shell } from './chart-shell.js';
import { altitude, bearing, dateShort, dayMonth, MONTHS_LONG } from './format.js';
import { errorText, glyph, overlaps, pill, round, stepperNav, svgText, table, timeButton, type Box, type ChartComponent } from './frame.js';
import { clipRect, linePath, svgRoot } from './plot.js';
import { clamp } from './scale.js';
import {
  computeAnalemma,
  eotText,
  lmtOffsetHours,
  offsetText,
  standardOffsetHours,
  stereographic,
  type AnalemmaData,
  type AnalemmaInput,
} from './sun-data.js';
import { dateKey, localDateOf } from './windows.js';

/** The chart's own choices, remembered for the page's lifetime. */
const choice = { clock: 'lmt' as AnalemmaClock, timeH: 12 };

function timeText(hours: number): string {
  const total = Math.round(hours * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The clock in words: `12:00 local mean time (UTC−5:00:39)` or `12:00 zone time, UTC−5 all year`. */
export function clockWords(input: Pick<AnalemmaInput, 'clock' | 'timeH' | 'zoneOffsetH' | 'observer'>): string {
  const t = timeText(input.timeH);
  return input.clock === 'lmt'
    ? `${t} local mean time (${offsetText(lmtOffsetHours(input.observer.lon_deg))})`
    : `${t} zone time, ${offsetText(input.zoneOffsetH)} all year (no daylight saving)`;
}

export const analemmaChart: ChartComponent = (host, ctx, ui) => {
  const dayOf = localDayCache();

  const inputFor = (state: ExplorerState): AnalemmaInput => {
    const zone = displayZone(state);
    const year = dayOf(state.time.jd_utc, zone).date.year;
    return {
      observer: engineObserver(state),
      year,
      timeH: choice.timeH,
      clock: choice.clock,
      zoneOffsetH: standardOffsetHours(zone, year),
    };
  };

  return mountChart<AnalemmaInput, AnalemmaData>(host, ctx, ui, {
    kind: 'analemma',
    heading: 'The analemma',
    heavy: true,
    input: inputFor,
    key: (i) => [observerKey(i.observer), i.year, i.timeH, i.clock, i.clock === 'zone' ? i.zoneOffsetH : ''].join('|'),
    compute(input) {
      const engine = ctx.engine;
      if (!isSunToolsEngine(engine)) throw new NotAvailableError('The Sun charts');
      return computeAnalemma(engine, input);
    },
    failureText: (error, input) => `The engine could not compute the analemma for ${input.year}: ${errorText(error)}`,
    setup(shell) {
      const { c } = shell;
      stepperNav(c.nav, 'Previous year', 'Next year', (dir) => stepTime(ctx.store, { unit: 'year', count: dir }));
      const clockChoice = segmented<AnalemmaClock>({
        label: 'Clock',
        size: 'sm',
        value: choice.clock,
        options: [
          { value: 'lmt', label: 'Local mean time', tip: 'The clock of this longitude: 12:00 puts the figure on the meridian' },
          { value: 'zone', label: 'Zone time', tip: 'Your zone’s standard time all year (no daylight saving): what a watch reads in winter' },
        ],
        onChange: (v) => {
          choice.clock = v;
          shell.refresh();
        },
      });
      const time = h('input', {
        type: 'time',
        class: 'sf-input sfc-time-input',
        step: 900,
        value: timeText(choice.timeH),
        'aria-label': 'Clock time of the Sun’s position each day',
        'data-tip': 'The clock time each day',
      });
      time.addEventListener('change', () => {
        const m = /^(\d{2}):(\d{2})/.exec(time.value);
        if (!m) return;
        const hours = Number(m[1]) + Number(m[2]) / 60;
        if (!(hours >= 0 && hours < 24)) return;
        choice.timeH = hours;
        shell.refresh();
      });
      c.actions.append(h('label', { class: 'sfc-control' }, h('span', {}, 'At'), time), clockChoice.el);
      c.legend.replaceChildren(
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key sfc-key-analemma', 'aria-hidden': 'true' }), 'The Sun at this time each day'),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key sfc-key-analemma-below', 'aria-hidden': 'true' }), 'below the horizon'),
        h('span', { class: 'sfc-legend-item' }, h('span', { class: 'sfc-key-dot', 'aria-hidden': 'true' }), 'first of the month'),
        h('span', { class: 'sfc-legend-item' }, glyph('Sun', 'sun', 14), 'the app’s date'),
      );
      return undefined;
    },
    header(shell) {
      const st = ctx.store.get();
      const i = shell.input;
      shell.c.title.replaceChildren(`The analemma · ${i.year}`);
      if (st.settings.navigatorTerms) shell.c.title.append(h('span', { class: 'sfc-term', 'data-term': '' }, ' · the Sun at a fixed mean time'));
      shell.c.subtitle.textContent = `${placeName(st)} · the Sun at ${clockWords(i)}`;
      const label = shell.c.nav.querySelector('.sfc-nav-label');
      if (label) label.textContent = String(i.year);
    },
    draw: (shell) => draw(shell),
    table: (shell) => tables(shell),
    displayKey: (st) => `${st.settings.angleFormat}|${st.settings.navigatorTerms}|${todayKey(st)}`,
    fileParts: (shell) => ['analemma', shell.input.year, timeText(shell.input.timeH).replace(':', ''), shell.input.clock === 'lmt' ? 'lmt' : 'zone'],
    labels: (shell) => [
      `The Sun at ${clockWords(shell.input)} each day; heights are what the eye sees (refraction included), bearings from true north.`,
    ],
  });

  function todayKey(st: ExplorerState): string {
    return dateKey(localDateOf(st.time.jd_utc, displayZone(st)));
  }

  function draw(shell: Shell<AnalemmaInput, AnalemmaData>): SVGSVGElement {
    const data = shell.data!;
    const pts = data.raw.points;
    // As wide as the figure needs (a tall figure gets a narrower picture), centred in the card.
    const plotH = Math.round(clamp(shell.width * 0.62, 300, 560));
    const W = Math.round(Math.min(shell.width, plotH * 1.4 + 16));
    const narrow = W < 560;
    const margin = { left: 8, right: 8, top: 8, bottom: 8 };
    const H = margin.top + plotH + margin.bottom;
    const x0 = margin.left;
    const x1 = W - margin.right;
    const y0 = margin.top;
    const y1 = margin.top + plotH;
    const svg = svgRoot(W, H, `${summary(shell)}`);
    svg.classList.add('sfc-centred');
    if (!pts.length) {
      svg.append(svgText(W / 2, H / 2, 'No days of this year are inside the engine’s coverage.', { 'text-anchor': 'middle', class: 'sfc-strip-label' }));
      shell.c.plot.replaceChildren(svg);
      return svg;
    }

    // Fit the figure (and the horizon when it is near) with equal scales.
    const proj = stereographic(data.centre.az, data.centre.alt);
    const at = pts.map((p) => proj(p.az_deg, p.alt_apparent_deg));
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const q of at) {
      if (!q) continue;
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y);
      maxY = Math.max(maxY, q.y);
    }
    const lowest = Math.min(...pts.map((p) => p.alt_apparent_deg));
    // The horizon joins the picture when the figure comes close to it.
    if (lowest > 0 && lowest < 12) {
      const hz = proj(data.centre.az, 0);
      if (hz) minY = Math.min(minY, hz.y - 3);
    }
    const spanX = Math.max(maxX - minX, 8);
    const spanY = Math.max(maxY - minY, 8);
    const k = Math.min(((x1 - x0) * 0.84) / spanX, ((y1 - y0) * 0.84) / spanY);
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const sx = (x: number): number => (x0 + x1) / 2 + (x - midX) * k;
    const sy = (y: number): number => (y0 + y1) / 2 - (y - midY) * k;
    const screen = (az: number, alt: number): [number, number] | null => {
      const q = proj(az, alt);
      return q ? [sx(q.x), sy(q.y)] : null;
    };
    const clip = clipRect(x0, y0, x1 - x0, y1 - y0);
    svg.append(clip.defs);
    const plot = s('g', { 'clip-path': clip.url });
    svg.append(plot);

    // The ground and the horizon.
    const horizon: [number, number][] = [];
    for (let d = -150; d <= 150; d += 2) {
      const q = screen(data.centre.az + d, 0);
      if (q) horizon.push(q);
    }
    if (horizon.length > 1) {
      const first = horizon[0]!;
      const last = horizon[horizon.length - 1]!;
      const ground = `${linePath(horizon)}L${round(last[0])} ${round(y1 + 4000)}L${round(first[0])} ${round(y1 + 4000)}Z`;
      plot.append(s('path', { class: 'sfc-ground', d: ground }), s('path', { class: 'sfc-sky-horizon', d: linePath(horizon) }));
    }

    // Lines of equal height and of equal bearing; their labels where they leave the picture.
    const grid = s('g', { class: 'sfc-skygrid' });
    const labels = s('g', { class: 'sfc-axis' });
    const boxes: Box[] = [];
    const inside = (q: [number, number]): boolean => q[0] >= x0 + 2 && q[0] <= x1 - 2 && q[1] >= y0 + 2 && q[1] <= y1 - 2;
    // Heights are labelled where their lines pass a little left of the figure.
    const figureLeft = Math.min(...at.flatMap((q) => (q ? [sx(q.x)] : [])));
    const labelX = Math.max(x0 + 18, figureLeft - 46);
    for (let a = 10; a < 90; a += 10) {
      const line: ([number, number] | null)[] = [];
      for (let az = 0; az <= 360; az += 0.5) line.push(screen(az, a));
      grid.append(s('path', { d: linePath(line) }));
      let best: [number, number] | null = null;
      for (const q of line) if (q && inside(q) && (!best || Math.abs(q[0] - labelX) < Math.abs(best[0] - labelX))) best = q;
      if (best && Math.abs(best[0] - labelX) < 12) {
        const t = svgText(best[0], best[1] - 3, `${a}°`, { class: 'sfc-skygrid-label', 'text-anchor': 'middle' });
        labels.append(t);
        boxes.push({ x: best[0] - 13, y: best[1] - 13, w: 26, h: 13 });
      }
    }
    const azStep = k > 18 ? 5 : k > 7 ? 10 : 15;
    const az0 = Math.round(data.centre.az / azStep) * azStep;
    for (let d = -180; d < 180; d += azStep) {
      const az = (((az0 + d) % 360) + 360) % 360;
      const line: ([number, number] | null)[] = [];
      for (let a = 0; a <= 89; a += 1) line.push(screen(az, a));
      grid.append(s('path', { d: linePath(line) }));
      let low: [number, number] | null = null;
      for (const q of line) if (q && inside(q) && (!low || q[1] > low[1])) low = q;
      // Only where the line leaves the picture at the bottom (or meets the horizon), clear of the sides.
      if (low && low[0] > x0 + 22 && low[0] < x1 - 22 && (low[1] > y1 - 24 || lowest < 12)) {
        const text = bearing(az).replace(/ .*/, '');
        const t = svgText(low[0], Math.min(low[1] - 5, y1 - 6), text, { class: 'sfc-skygrid-label', 'text-anchor': 'middle' });
        labels.append(t);
      }
    }
    plot.append(grid);

    // The figure: above the horizon solid, below dashed.
    const fig = s('g', { class: 'sfc-analemma' });
    const up: ([number, number] | null)[] = [];
    const down: ([number, number] | null)[] = [];
    const ring = [...pts, pts[0]!];
    for (const p of ring) {
      const q = screen(p.az_deg, p.alt_apparent_deg);
      const above = p.alt_apparent_deg >= 0;
      up.push(above ? q : null);
      down.push(above ? null : q);
    }
    fig.append(
      s('path', { class: 'sfc-analemma-below', d: linePath(down) }),
      s('path', { class: 'sfc-analemma-casing', d: linePath(up) }),
      s('path', { class: 'sfc-analemma-line', d: linePath(up) }),
    );
    // The first of each month, labelled outward from the figure's middle.
    const cx = sx(midX);
    for (const i of data.monthFirsts) {
      const p = pts[i]!;
      const q = screen(p.az_deg, p.alt_apparent_deg);
      if (!q) continue;
      fig.append(s('circle', { class: 'sfc-analemma-month', cx: round(q[0]), cy: round(q[1]), r: 3.4 }));
      const dx = q[0] - cx;
      const dir = dx >= 0 ? 1 : -1;
      const text = dayMonth(parseDate(p.date));
      for (const [ox, oy] of [
        [dir * 16, 0],
        [dir * 16, -12],
        [dir * 16, 12],
        [-dir * 16, 0],
      ] as const) {
        const lp = pill(q[0] + ox, q[1] + oy, text, { size: 10, anchor: ox >= 0 ? 'start' : 'end' });
        if (boxes.some((b) => overlaps(b, lp.box, 1))) continue;
        boxes.push(lp.box);
        fig.append(lp.el);
        break;
      }
    }
    // The app's date.
    const today = todayKey(ctx.store.get());
    const ti = pts.findIndex((p) => p.date === today);
    if (ti >= 0) {
      const p = pts[ti]!;
      const q = screen(p.az_deg, p.alt_apparent_deg);
      if (q) {
        const g = s('g', { class: 'sfc-now sfc-b-sun' });
        g.append(s('circle', { class: 'sfc-now-halo', cx: round(q[0]), cy: round(q[1]), r: 10 }));
        const gl = glyph('Sun', 'sun', 16);
        gl.setAttribute('x', String(round(q[0] - 8)));
        gl.setAttribute('y', String(round(q[1] - 8)));
        g.append(gl);
        fig.append(g);
      }
    }
    plot.append(fig, labels);
    svg.append(s('rect', { class: 'sfc-frame', x: x0 + 0.5, y: y0 + 0.5, width: x1 - x0 - 1, height: y1 - y0 - 1 }));
    if (narrow) svg.setAttribute('data-narrow', '1');
    shell.c.plot.replaceChildren(svg);

    shell.c.caption.replaceChildren(
      summary(shell),
      ' ',
      h(
        'span',
        { class: 'sfc-muted' },
        'The figure’s height is the Sun’s declination through the year and its width the equation of time (both on the next charts). Heights are what the eye sees; bearings from true north.',
      ),
    );
    const errors = data.raw.errors;
    shell.c.notes.replaceChildren(
      ...(errors.length ? [h('p', { class: 'sfc-note' }, `${errors.length} day${errors.length === 1 ? ' is' : 's are'} outside the engine’s coverage and left out.`)] : []),
    );
    return svg;
  }

  function summary(shell: Shell<AnalemmaInput, AnalemmaData>): string {
    const data = shell.data;
    if (!data || !data.raw.points.length) return 'Where the Sun stands at one clock time on every day of the year.';
    const fmt = ctx.store.get().settings.angleFormat;
    const pts = data.raw.points;
    let hi = pts[0]!;
    let lo = pts[0]!;
    let behind = pts[0]!;
    let ahead = pts[0]!;
    for (const p of pts) {
      if (p.alt_apparent_deg > hi.alt_apparent_deg) hi = p;
      if (p.alt_apparent_deg < lo.alt_apparent_deg) lo = p;
      if (p.eot_s < behind.eot_s) behind = p;
      if (p.eot_s > ahead.eot_s) ahead = p;
    }
    const where = (p: AnalemmaPoint): string => `${dayMonth(parseDate(p.date))} (${altitude(p.alt_apparent_deg, fmt)}, ${bearing(p.az_deg)})`;
    const parts = [
      `At ${clockWords(shell.input)} the Sun stands highest on ${where(hi)} and lowest on ${where(lo)}.`,
      `The loops’ far ends are the days a sundial is furthest behind the clock (${dayMonth(parseDate(behind.date))}, ${eotText(behind.eot_s)}) and furthest ahead (${dayMonth(parseDate(ahead.date))}, ${eotText(ahead.eot_s)}).`,
    ];
    if (lo.alt_apparent_deg < 0) parts.push('Part of the figure is below the horizon: the Sun is down at this time on those days.');
    return parts.join(' ');
  }

  function tables(shell: Shell<AnalemmaInput, AnalemmaData>): HTMLElement[] {
    const data = shell.data!;
    const st = ctx.store.get();
    const zone = displayZone(st);
    const fmt = st.settings.angleFormat;
    const t = table(
      `The Sun at ${clockWords(shell.input)}, every day of ${shell.input.year} (the instant in local time, ${zoneLabel(data.raw.points[0]?.jd_utc ?? st.time.jd_utc, zone)}; UTC on hover)`,
      ['Date', 'Instant', 'Height above the horizon', 'Bearing', 'Declination', 'Equation of time'],
    );
    const today = todayKey(st);
    let month = '';
    for (const p of data.raw.points) {
      const m = p.date.slice(0, 7);
      if (m !== month) {
        month = m;
        t.body.append(h('tr', { class: 'sfc-row-month' }, h('th', { scope: 'rowgroup', colspan: 6 }, `${MONTHS_LONG[Number(p.date.slice(5, 7)) - 1]} ${p.date.slice(0, 4)}`)));
      }
      t.body.append(
        h(
          'tr',
          { class: p.date === today ? 'sfc-row-current' : '' },
          h('th', { scope: 'row' }, dateShort(parseDate(p.date))),
          h('td', {}, timeButton(p.jd_utc, zone)),
          h('td', { 'data-csv': p.alt_apparent_deg.toFixed(3) }, altitude(p.alt_apparent_deg, fmt)),
          h('td', { 'data-csv': p.az_deg.toFixed(3) }, bearing(p.az_deg)),
          h('td', { 'data-csv': p.dec_deg.toFixed(4) }, altitude(p.dec_deg, fmt)),
          h('td', { 'data-csv': p.eot_s.toFixed(1) }, eotText(p.eot_s)),
        ),
      );
    }
    return [t.table];
  }
};

/** `2026-03-15` → a local date. */
export function parseDate(date: string): { year: number; month: number; day: number } {
  const m = /^([+-]?\d{4,6})-(\d{2})-(\d{2})$/.exec(date);
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : { year: 1970, month: 1, day: 1 };
}
