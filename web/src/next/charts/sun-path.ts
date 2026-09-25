/**
 * The sun path diagram (charts2 agent, expansion programme Q5): the Sun's path across the
 * sky on the app's local day, with its whole hours marked, between the paths of the year's
 * solstices and equinoxes. OWNER: charts2 agent.
 *
 * Two pictures of the same numbers (`sun_path`, apparent altitude):
 *
 * - **From above**: the sky dome seen from above like a map, north up and east to the
 *   right, the zenith in the middle and the horizon round the edge; the height above the
 *   horizon runs inward (equal steps of altitude).
 * - **Along the horizon**: bearing across (centred on the direction of the equator, as a
 *   person facing it sees the sky: east on the left north of the equator) and height up.
 *
 * Sunrise and sunset are the event finder's (`day_events`, the upper limb on the horizon);
 * the Sun's position now is `sky_state` at the app's time, drawn every frame while the time
 * moves. Clicking the day's path moves the app to that moment.
 */

import { h, s } from '../../dom.js';
import { observerKey } from '../component.js';
import { isSunToolsEngine, type BodyEvents, type SkyEvent } from '../engine/types.js';
import { fastPlayback, setTime, stepTime } from '../playback.js';
import { currentHourCycle } from '../shell/format.js';
import { displayZone, engineObserver, eventOptions, type ExplorerState } from '../state.js';
import { drawGlyph } from '../theme/glyphs.js';
import { segmented } from '../theme/primitives.js';
import { zoneLabel, type Zone } from '../time.js';
import { localDayCache, mountChart, NotAvailableError, placeName, type Shell } from './chart-shell.js';
import { altitude, bearing, clock, clockWithUtc, dateLong, dateShort, dayMonth, duration } from './format.js';
import {
  errorText,
  glyph,
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
  type Box,
  type ChartComponent,
  type Tooltip,
} from './frame.js';
import { clipRect, linePath, svgRoot } from './plot.js';
import { clamp, linearScale } from './scale.js';
import {
  azAxisStart,
  computeSunPath,
  unwrapAz,
  type HourMark,
  type PathCurve,
  type SkyPoint,
  type SunPathData,
  type SunPathInput,
} from './sun-data.js';
import { localDateOf, zoneKey } from './windows.js';
import { dtChip, position, timeInfoAt, uncertaintyText } from '../time/chip.js';

export type SunPathVariant = 'polar' | 'across';
type Variant = SunPathVariant;
/** Remembered for the page's lifetime. */
let variant: Variant = 'polar';

/** Choose the picture before the chart mounts (the developer page; links from other views). */
export function presetSunPath(v: SunPathVariant): void {
  variant = v;
}

interface PathChartData {
  readonly path: SunPathData;
  readonly sun: BodyEvents | null;
  /** The Sun's apparent height at its transit (solar noon). */
  readonly transitAlt: number | null;
}

const ENVELOPE_CLASS: Record<string, string> = {
  march_equinox: 'sfc-env sfc-env--equinox',
  september_equinox: 'sfc-env sfc-env--equinox',
  june_solstice: 'sfc-env sfc-env--june',
  december_solstice: 'sfc-env sfc-env--december',
};

/** An hour on the path: `06` (24-hour clock) or `6 AM`. */
export function hourTag(hour: number): string {
  if (currentHourCycle() === 'h23') return String(hour).padStart(2, '0');
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? 'AM' : 'PM'}`;
}

function firstEvent(sun: BodyEvents | null, kind: SkyEvent['kind']): SkyEvent | null {
  return sun?.events.find((e) => e.kind === kind) ?? null;
}

/** Where a sky position is drawn; null when it cannot be (below the horizon in the polar picture). */
type Projector = (az: number, alt: number) => [number, number] | null;

interface Picture {
  readonly svg: SVGSVGElement;
  readonly project: Projector;
  /** Today's path in screen coordinates, for the pointer. */
  readonly screen: { readonly p: SkyPoint; readonly x: number; readonly y: number }[];
}

export const sunPathChart: ChartComponent = (host, ctx, ui) => {
  const dayOf = localDayCache();
  let picture: Picture | null = null;
  let nowLayer: SVGGElement | null = null;
  let tip: Tooltip | null = null;
  const readout = h('p', { class: 'sfc-readout sfc-readout--line', 'aria-live': 'off' });

  const inputFor = (state: ExplorerState): SunPathInput => {
    const zone = displayZone(state);
    return { observer: engineObserver(state), zone, day: dayOf(state.time.jd_utc, zone), options: eventOptions(state) };
  };

  return mountChart<SunPathInput, PathChartData>(host, ctx, ui, {
    kind: 'sunpath',
    heading: 'The Sun’s path across the sky',
    heavy: true,
    input: inputFor,
    key: (i) => [observerKey(i.observer), zoneKey(i.zone), i.day.key, i.day.jd_start, i.options.horizon, i.options.height_of_eye_m].join('|'),
    compute(input) {
      const engine = ctx.engine;
      if (!isSunToolsEngine(engine)) throw new NotAvailableError('The Sun charts');
      const path = computeSunPath(engine, input);
      let sun: BodyEvents | null = null;
      let transitAlt: number | null = null;
      try {
        sun = engine.dayEvents(input.observer, input.day.jd_start, input.day.jd_end, ['Sun'], input.options).bodies.find((b) => b.body === 'Sun') ?? null;
        const tr = firstEvent(sun, 'transit');
        if (tr) transitAlt = engine.skyState(input.observer, tr.jd_utc, ['Sun']).bodies[0]?.alt_apparent_deg ?? null;
      } catch {
        sun = null;
      }
      return { path, sun, transitAlt };
    },
    failureText: (error) => `The engine could not draw the Sun’s path for this day: ${errorText(error)}`,
    setup(shell) {
      const { c } = shell;
      const nav = stepperNav(c.nav, 'Previous day', 'Next day', (dir) => stepTime(ctx.store, { unit: 'day', count: dir }));
      const choice = segmented<Variant>({
        label: 'Picture',
        size: 'sm',
        value: variant,
        options: [
          { value: 'polar', label: 'From above', tip: 'The sky dome seen from above, like a map: north up, the zenith in the middle' },
          { value: 'across', label: 'Along the horizon', tip: 'Bearing across and height up, facing the equator' },
        ],
        onChange: (v) => {
          variant = v;
          shell.redraw();
        },
      });
      c.actions.append(choice.el);
      c.figure.insertBefore(readout, c.caption);
      tip = tooltip(c.plot);
      c.legend.replaceChildren(
        legendItem('sfc-key-path', 'Today, with the hours'),
        legendItem('sfc-key-env sfc-key-env--june', 'June solstice'),
        legendItem('sfc-key-env sfc-key-env--equinox', 'Equinoxes'),
        legendItem('sfc-key-env sfc-key-env--december', 'December solstice'),
        h('span', { class: 'sfc-legend-item' }, glyph('Sun', 'sun', 14), 'The Sun now'),
      );
      const navLabel = (): void => {
        nav.textContent = dateShort(shell.input.day.date);
      };
      navLabel();
      return undefined;
    },
    header(shell) {
      const st = ctx.store.get();
      const { day, zone } = shell.input;
      shell.c.title.replaceChildren('The Sun’s path across the sky');
      if (st.settings.navigatorTerms) shell.c.title.append(h('span', { class: 'sfc-term', 'data-term': '' }, ' · sun path diagram'));
      shell.c.subtitle.textContent = `${dateLong(day.date)} · ${placeName(st)} · ${zoneLabel(day.jd_start + 0.5, zone)}`;
      const label = shell.c.nav.querySelector('.sfc-nav-label');
      if (label) label.textContent = dateShort(day.date);
    },
    draw(shell) {
      const data = shell.data!;
      picture = variant === 'polar' ? drawPolar(shell, data) : drawAcross(shell, data);
      const svg = picture.svg;
      nowLayer = s('g', { class: 'sfc-now sfc-b-sun', 'pointer-events': 'none' }) as SVGGElement;
      svg.append(nowLayer);
      svg.addEventListener('click', (event) => onClick(event));
      svg.addEventListener('pointermove', (event) => onHover(event, shell));
      svg.addEventListener('pointerleave', () => tip?.hide());
      shell.c.plot.replaceChildren(svg, tip!.el);
      shell.c.caption.replaceChildren(
        summary(data, shell.input.zone),
        ' ',
        h('span', { class: 'sfc-muted' }, 'Heights are what the eye sees (refraction included); bearings from true north. Click the day’s path to go to that time.'),
      );
      shell.c.notes.replaceChildren(...data.path.errors.map((e) => h('p', { class: 'sfc-note' }, e)));
      placeNow(shell);
      return svg;
    },
    cursor: (shell) => placeNow(shell),
    table: (shell) => tables(shell),
    displayKey: (st) => `${st.settings.angleFormat}|${st.settings.navigatorTerms}`,
    fileParts: (shell) => ['sun-path', shell.input.day.key],
    labels: () => ['Heights are what the eye sees (apparent altitude, refraction included); bearings from true north.'],
  });

  // --- the Sun now -----------------------------------------------------------------------
  function placeNow(shell: Shell<SunPathInput, PathChartData>): void {
    if (!picture || !nowLayer) return;
    const st = ctx.store.get();
    const jd = st.time.jd_utc;
    const { day, zone } = shell.input;
    nowLayer.replaceChildren();
    let sunAlt: number | null = null;
    let sunAz: number | null = null;
    try {
      const b = ctx.engine.skyState(shell.input.observer, jd, ['Sun']).bodies[0];
      if (b) {
        sunAlt = b.alt_apparent_deg;
        sunAz = b.az_deg;
      }
    } catch {
      // Outside the coverage: no Sun drawn.
    }
    const inDay = jd >= day.jd_start && jd < day.jd_end;
    if (sunAlt !== null && sunAz !== null && sunAlt >= 0 && inDay) {
      const p = picture.project(sunAz, sunAlt);
      if (p) {
        nowLayer.append(s('circle', { class: 'sfc-now-halo', cx: round(p[0]), cy: round(p[1]), r: 11 }));
        drawGlyph(nowLayer, 'sun', p[0], p[1], 16);
      }
    }
    const when = clockWithUtc(jd, zone);
    // chip2: at a far date the Sun's place at the time shown moves with the Earth's uncertain
    // rotation (time/chip.ts `position`; 2.5′ at 2000 BC, under 0.1′ at 585 BC).
    const place = sunAlt === null || fastPlayback(st) ? '' : uncertaintyText(dtChip(ctx, jd, position('Sun'), timeInfoAt(ctx, Math.floor(jd - 0.5) + 0.5)));
    const known = place ? ` (at this date its place is known to ${place})` : '';
    if (sunAlt === null || sunAz === null) readout.textContent = `${when}: the Sun cannot be computed at this time.`;
    else if (sunAlt >= 0) {
      readout.textContent = `${when}: the Sun is ${altitude(sunAlt, st.settings.angleFormat)} above the horizon, bearing ${bearing(sunAz)}${known}.`;
    } else {
      readout.textContent = `${when}: the Sun is below the horizon (${altitude(sunAlt, st.settings.angleFormat)}), bearing ${bearing(sunAz)}${known}.`;
    }
    if (!inDay) readout.textContent += ' (The app’s time is on another day.)';
  }

  // --- pointer ---------------------------------------------------------------------------
  function nearest(event: MouseEvent): { p: SkyPoint; x: number; y: number } | null {
    if (!picture) return null;
    const rect = picture.svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let best: { p: SkyPoint; x: number; y: number } | null = null;
    let bestD = 14 * 14;
    for (const q of picture.screen) {
      const d2 = (q.x - px) ** 2 + (q.y - py) ** 2;
      if (d2 < bestD) {
        bestD = d2;
        best = q;
      }
    }
    return best;
  }

  function onClick(event: MouseEvent): void {
    const q = nearest(event);
    if (q) setTime(ctx.store, q.p.jd);
  }

  function onHover(event: PointerEvent, shell: Shell<SunPathInput, PathChartData>): void {
    const q = nearest(event);
    if (!q || !tip) {
      tip?.hide();
      return;
    }
    const fmt = ctx.store.get().settings.angleFormat;
    tip.show(q.x, q.y, [
      tipHead(clockWithUtc(q.p.jd, shell.input.zone)),
      tipRow(altitude(q.p.alt, fmt), 'above the horizon'),
      tipRow(bearing(q.p.az), 'bearing'),
      tipRow('', 'Click to go to this time'),
    ]);
  }

  // --- pictures --------------------------------------------------------------------------
  function drawPolar(shell: Shell<SunPathInput, PathChartData>, data: PathChartData): Picture {
    // As wide as the dome, centred in the card (and so in a picture of it).
    const W = Math.min(shell.width, 640);
    const pad = W < 420 ? 24 : 30;
    const size = W;
    const R = size / 2 - pad;
    const cx = W / 2;
    const cy = pad + R;
    const H = cy + R + pad;
    const lat = shell.input.observer.lat_deg;
    const rOf = (alt: number): number => (R * (90 - clamp(alt, 0, 90))) / 90;
    const project: Projector = (az, alt) => {
      if (alt < -1e-9) return null;
      const r = rOf(alt);
      const a = (az * Math.PI) / 180;
      return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    };
    const svg = svgRoot(W, H, `The Sun’s path across the sky seen from above. ${summary(data, shell.input.zone)}`);
    svg.classList.add('sfc-centred');
    const boxes: Box[] = [];

    // The dome: altitude rings every 15°, spokes every 15° (every 45° stronger), compass points.
    const grid = s('g', { class: 'sfc-dome' });
    grid.append(s('circle', { class: 'sfc-dome-disc', cx: round(cx), cy: round(cy), r: round(R) }));
    for (const a of [15, 30, 45, 60, 75]) grid.append(s('circle', { class: 'sfc-dome-ring', cx: round(cx), cy: round(cy), r: round(rOf(a)) }));
    for (let az = 0; az < 360; az += 15) {
      const p = project(az, 0)!;
      grid.append(s('line', { class: az % 45 ? 'sfc-dome-spoke sfc-dome-spoke--faint' : 'sfc-dome-spoke', x1: round(cx), y1: round(cy), x2: round(p[0]), y2: round(p[1]) }));
    }
    grid.append(s('circle', { class: 'sfc-dome-horizon', cx: round(cx), cy: round(cy), r: round(R) }));
    const labels = s('g', { class: 'sfc-axis' });
    for (const a of [30, 60]) {
      const t = svgText(cx + 4, cy - rOf(a) - 3, `${a}°`, { class: 'sfc-dome-alt' });
      labels.append(t);
    }
    const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    points.forEach((name, k) => {
      const az = k * 45;
      const a = (az * Math.PI) / 180;
      const x = cx + (R + pad * 0.55) * Math.sin(a);
      const y = cy - (R + pad * 0.55) * Math.cos(a) + 4;
      labels.append(svgText(x, y, name, { 'text-anchor': 'middle', class: k % 2 ? 'sfc-compass' : 'sfc-compass sfc-compass--main' }));
      boxes.push({ x: x - 10, y: y - 11, w: 20, h: 14 });
    });
    svg.append(grid, labels);

    const screen = drawPaths(svg, data, project, boxes, shell.input.zone, {
      // Hour labels go on the side of the path away from the celestial pole.
      away: project(lat >= 0 ? 0 : 180, Math.abs(lat)) ?? [cx, cy],
      outward: true,
      centre: [cx, cy],
    });
    drawRiseSet(svg, data, project, shell.input.zone, boxes, 'polar', [cx, cy]);
    return { svg, project, screen };
  }

  function drawAcross(shell: Shell<SunPathInput, PathChartData>, data: PathChartData): Picture {
    const W = shell.width;
    const narrow = W < 560;
    const lat = shell.input.observer.lat_deg;
    const start = azAxisStart(lat);
    let peak = 0;
    for (const cur of [data.path.today, ...data.path.envelope]) if (cur.peak && cur.peak.alt > peak) peak = cur.peak.alt;
    const top = clamp(Math.ceil((peak + 8) / 10) * 10, 30, 90);
    const margin = { left: narrow ? 34 : 42, right: narrow ? 8 : 14, top: 18, bottom: 34 };
    const plotH = Math.round(clamp(W * 0.42, 220, 420));
    const H = margin.top + plotH + margin.bottom;
    const x0 = margin.left;
    const x1 = W - margin.right;
    const y0 = margin.top;
    const y1 = margin.top + plotH;
    const xs = linearScale([start, start + 360], [x0, x1]);
    const ys = linearScale([0, top], [y1, y0]);
    const project: Projector = (az, alt) => (alt < -1e-9 ? null : [xs(unwrapAz(az, start)), ys(Math.min(alt, top + 5))]);
    const svg = svgRoot(W, H, `The Sun’s path across the sky, bearing across and height up. ${summary(data, shell.input.zone)}`);
    const clip = clipRect(x0, y0 - 10, x1 - x0, y1 - y0 + 10);
    svg.append(clip.defs);

    const grid = s('g', { class: 'sfc-grid' });
    const axis = s('g', { class: 'sfc-axis' });
    const altStep = top > 60 ? 15 : 10;
    for (let a = 0; a <= top; a += altStep) {
      const y = round(ys(a)) + 0.5;
      if (a > 0) grid.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'sfc-grid--faint' }));
      axis.append(svgText(x0 - 6, y + 3.5, `${a}°`, { 'text-anchor': 'end' }));
    }
    const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let k = 0; k <= 360; k += narrow ? 45 : 15) {
      const az = start + k;
      const x = round(xs(az)) + 0.5;
      const name = names[((az % 360) + 360) % 360];
      grid.append(s('line', { x1: x, x2: x, y1: y0, y2: y1, class: name && (az % 90 === 0) ? '' : 'sfc-grid--faint' }));
      if (name || !narrow) {
        if (k % 45 === 0) axis.append(svgText(x, y1 + 16, name ?? `${az % 360}°`, { 'text-anchor': 'middle', class: name && az % 90 === 0 ? 'sfc-compass--main' : '' }));
      }
    }
    axis.append(s('line', { x1: x0, x2: x1, y1: y1 + 0.5, y2: y1 + 0.5 }));
    axis.append(svgText(x0, y1 + 30, `Bearing (facing ${lat >= 0 ? 'south' : 'north'}); height above the horizon`, { class: 'sfc-axis-title' }));
    svg.append(grid, axis);

    const layer = s('g', { 'clip-path': clip.url }) as SVGGElement;
    svg.append(layer);
    const boxes: Box[] = [];
    const screen = drawPaths(layer, data, project, boxes, shell.input.zone, { away: [0, H * 10], outward: false, seam: (W - 0) / 2, bounds: [x0, y0, x1, y1] });
    drawRiseSet(svg, data, project, shell.input.zone, boxes, 'across', null);
    svg.append(s('rect', { class: 'sfc-frame', x: x0 + 0.5, y: y0 + 0.5, width: x1 - x0 - 1, height: plotH - 1 }));
    return { svg, project, screen };
  }

  /** The envelope and today's path, hour dots and labels. Returns today's path on screen. */
  function drawPaths(
    parent: SVGElement,
    data: PathChartData,
    project: Projector,
    boxes: Box[],
    zone: Zone,
    options: { away: [number, number]; outward: boolean; seam?: number; centre?: [number, number]; bounds?: [number, number, number, number] },
  ): { p: SkyPoint; x: number; y: number }[] {
    const toPath = (run: readonly SkyPoint[]): string => {
      const pts: ([number, number] | null)[] = [];
      let prev: [number, number] | null = null;
      for (const p of run) {
        const q = project(p.az, p.alt);
        // Break across the picture's seam (the bearing axis wraps round).
        if (q && prev && options.seam !== undefined && Math.abs(q[0] - prev[0]) > options.seam) pts.push(null);
        pts.push(q);
        prev = q;
      }
      return linePath(pts);
    };
    /** A label kept inside the picture (x0, y0, x1, y1), when it has edges to respect. */
    const inside = (x: number, y: number, text: string, cls: string, size: number): ReturnType<typeof pill> => {
      let lp = pill(x, y, text, { size, cls });
      const b = options.bounds;
      if (b) {
        const cx = clamp(x, b[0] + lp.box.w / 2 + 2, b[2] - lp.box.w / 2 - 2);
        const cy = clamp(y, b[1] + lp.box.h / 2 + 2, b[3] - lp.box.h / 2 - 2);
        if (cx !== x || cy !== y) lp = pill(cx, cy, text, { size, cls });
      }
      return lp;
    };
    const env = s('g', { class: 'sfc-envelope' });
    for (const cur of data.path.envelope) {
      const d = cur.runs.map(toPath).join('');
      if (d) env.append(s('path', { class: ENVELOPE_CLASS[cur.kind] ?? 'sfc-env', d }));
    }
    parent.append(env);

    const today = data.path.today;
    const g = s('g', { class: 'sfc-sunpath' });
    const d = today.runs.map(toPath).join('');
    if (d) g.append(s('path', { class: 'sfc-sunpath-casing', d }), s('path', { class: 'sfc-sunpath-line', d }));
    const screen: { p: SkyPoint; x: number; y: number }[] = [];
    for (const run of today.runs) {
      for (const p of run) {
        const q = project(p.az, p.alt);
        if (q) screen.push({ p, x: q[0], y: q[1] });
      }
    }
    // Hour dots and labels.
    const marks: HourMark[] = [...data.path.hours];
    for (const m of marks) {
      const q = project(m.az, m.alt);
      if (!q) continue;
      g.append(s('circle', { class: 'sfc-hour-dot', cx: round(q[0]), cy: round(q[1]), r: 3.2 }));
    }
    for (const m of marks) {
      const q = project(m.az, m.alt);
      if (!q) continue;
      // Offset along the path's normal, on the side away from `away` (the celestial pole, or below).
      const i = screen.findIndex((x) => Math.abs(x.p.jd - m.jd) < 1e-7);
      const a = screen[Math.max(0, i - 1)] ?? { x: q[0], y: q[1] };
      const b = screen[Math.min(screen.length - 1, i + 1)] ?? { x: q[0], y: q[1] };
      let nx = -(b.y - a.y);
      let ny = b.x - a.x;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      if ((q[0] - options.away[0]) * nx + (q[1] - options.away[1]) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      if (!options.outward) {
        nx = 0;
        ny = -1;
      }
      const text = hourTag(m.hour);
      const lp = inside(q[0] + nx * 13, q[1] + ny * 13, text, 'sfc-pill--hour', 9.5);
      if (boxes.some((bx) => overlaps(bx, lp.box, 1))) continue;
      boxes.push(lp.box);
      const title = s('title');
      title.textContent = `${clock(m.jd, zone)}: ${bearing(m.az)}, ${m.alt.toFixed(1)}° high`;
      lp.el.prepend(title);
      g.append(lp.el);
    }
    parent.append(g);

    // The solstices' and equinoxes' names last: the day's hours have the first claim on room.
    const envLabels = s('g', { class: 'sfc-envelope-labels' });
    const envLabelled = new Set<string>();
    for (const cur of data.path.envelope) {
      const labelKind = cur.kind.endsWith('equinox') ? 'equinox' : cur.kind;
      if (envLabelled.has(labelKind) || !cur.peak || !cur.runs.length) continue;
      const p = project(cur.peak.az, cur.peak.alt);
      if (!p) continue;
      const text =
        labelKind === 'equinox'
          ? 'Equinoxes'
          : cur.seasonJd !== null
            ? dayMonth(localDateOf(cur.seasonJd, zone))
            : cur.kind === 'june_solstice'
              ? 'June solstice'
              : 'December solstice';
      // Beside the curve's highest point: toward the zenith from above, above it across.
      let dx = 0;
      let dy = -13;
      if (options.outward && options.centre) {
        const vx = options.centre[0] - p[0];
        const vy = options.centre[1] - p[1];
        const len = Math.hypot(vx, vy);
        if (len > 1) {
          dx = (vx / len) * 13;
          dy = (vy / len) * 13;
        }
      }
      for (const k of [1, 2, -1]) {
        const lp = inside(p[0] + dx * k, p[1] + dy * k, text, `sfc-pill--env sfc-pill--${labelKind}`, 10);
        if (boxes.some((b) => overlaps(b, lp.box))) continue;
        boxes.push(lp.box);
        envLabels.append(lp.el);
        envLabelled.add(labelKind);
        break;
      }
    }
    parent.append(envLabels);
    return screen;
  }

  function drawRiseSet(
    svg: SVGSVGElement,
    data: PathChartData,
    project: Projector,
    zone: Zone,
    boxes: Box[],
    kind: Variant,
    centre: [number, number] | null,
  ): void {
    const g = s('g', { class: 'sfc-riseset' });
    for (const ev of data.sun?.events ?? []) {
      if (ev.kind !== 'rise' && ev.kind !== 'set') continue;
      const p = project(ev.az_deg, 0);
      if (!p) continue;
      const r = 5.5;
      const up = ev.kind === 'rise';
      g.append(
        s('path', {
          class: `sfc-marker sfc-marker--${ev.kind}`,
          d: up
            ? `M${round(p[0])} ${round(p[1] - r * 1.15)}L${round(p[0] + r)} ${round(p[1] + r * 0.7)}L${round(p[0] - r)} ${round(p[1] + r * 0.7)}Z`
            : `M${round(p[0])} ${round(p[1] + r * 1.15)}L${round(p[0] + r)} ${round(p[1] - r * 0.7)}L${round(p[0] - r)} ${round(p[1] - r * 0.7)}Z`,
        }),
      );
      const text = `${up ? 'Rise' : 'Set'} ${clock(ev.jd_utc, zone)}`;
      // Inside the dome toward its middle (from above), or above the horizon (across).
      const tries: [number, number][] = [];
      if (kind === 'polar' && centre) {
        const vx = centre[0] - p[0];
        const vy = centre[1] - p[1];
        const len = Math.hypot(vx, vy) || 1;
        for (const d of [34, 52, 70]) tries.push([p[0] + (vx / len) * d, p[1] + (vy / len) * d - 12]);
      } else {
        // Before sunrise and after sunset the horizon is empty: the label goes there first.
        const side = up ? -1 : 1;
        tries.push([p[0] + side * 40, p[1] - 11], [p[0] + side * 40, p[1] - 28], [p[0], p[1] - 16], [p[0], p[1] - 32]);
      }
      for (const [x, y] of tries) {
        const lp = pill(x, y, text, { size: 10, cls: `sfc-pill--${ev.kind}` });
        if (boxes.some((b) => overlaps(b, lp.box))) continue;
        boxes.push(lp.box);
        g.append(lp.el);
        break;
      }
    }
    svg.append(g);
  }

  // --- words ------------------------------------------------------------------------------
  function summary(data: PathChartData, zone: Zone): string {
    const fmt = ctx.store.get().settings.angleFormat;
    const parts: string[] = [];
    const today = data.path.today;
    const rise = firstEvent(data.sun, 'rise');
    const set = data.sun?.events.filter((e) => e.kind === 'set').at(-1) ?? null;
    const transit = firstEvent(data.sun, 'transit');
    if (data.sun?.always_above || today.alwaysUp) parts.push('The Sun does not set today (midnight sun).');
    else if (data.sun?.always_below || !today.everUp) parts.push('The Sun does not rise today.');
    else {
      const bits: string[] = [];
      if (rise) bits.push(`rises at ${clock(rise.jd_utc, zone)} bearing ${bearing(rise.az_deg)}`);
      if (transit) {
        bits.push(
          `is highest at ${clock(transit.jd_utc, zone)}${data.transitAlt !== null ? `, ${altitude(data.transitAlt, fmt)} above the ${transit.az_deg > 90 && transit.az_deg < 270 ? 'south' : 'north'}ern horizon` : ''}`,
        );
      }
      if (set) bits.push(`sets at ${clock(set.jd_utc, zone)} bearing ${bearing(set.az_deg)}`);
      const len = data.sun?.day_length_h;
      parts.push(`Today the Sun ${bits.join(', ')}${len !== null && len !== undefined ? ` (${duration(len)} of daylight)` : ''}.`);
    }
    const env = data.path.envelope;
    const never = env.filter((e) => !e.everUp).map((e) => (e.kind === 'june_solstice' ? 'June' : e.kind === 'december_solstice' ? 'December' : 'equinox'));
    parts.push('The other lines are the paths on the June and December solstices and the equinoxes: every day’s path lies between the two solstices.');
    if (never.length) parts.push(`On the ${never.join(' and ')} solstice the Sun does not rise here.`);
    return parts.join(' ');
  }

  // --- table ------------------------------------------------------------------------------
  function tables(shell: Shell<SunPathInput, PathChartData>): HTMLElement[] {
    const data = shell.data!;
    const { day, zone } = shell.input;
    const fmt = ctx.store.get().settings.angleFormat;
    const hourly = table(`The Sun on ${dateLong(day.date)}, hour by hour (local times, ${zoneLabel(day.jd_start + 0.5, zone)}; heights negative below the horizon)`, [
      'Time',
      'Height above the horizon',
      'Bearing',
    ]);
    const points = data.path.raw.path.points;
    const perHour = Math.round(60 / data.path.raw.step_minutes);
    const now = ctx.store.get().time.jd_utc;
    for (let i = 0; i < points.length; i += perHour) {
      const p = points[i]!;
      if (p.jd_utc >= day.jd_end - 1e-9) break;
      hourly.body.append(
        h(
          'tr',
          { class: now >= p.jd_utc && now < p.jd_utc + 1 / 24 ? 'sfc-row-current' : '' },
          h('th', { scope: 'row' }, timeButton(p.jd_utc, zone)),
          h('td', { 'data-csv': p.alt_apparent_deg.toFixed(3) }, altitude(p.alt_apparent_deg, fmt)),
          h('td', { 'data-csv': p.az_deg.toFixed(2) }, bearing(p.az_deg)),
        ),
      );
    }
    const events = table(`Sunrise, solar noon and sunset, ${dateLong(day.date)}`, ['Event', 'Time', 'Bearing', 'Height']);
    for (const ev of data.sun?.events ?? []) {
      if (ev.kind !== 'rise' && ev.kind !== 'set' && ev.kind !== 'transit') continue;
      const alt = ev.kind === 'transit' ? data.transitAlt : null;
      events.body.append(
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, ev.kind === 'rise' ? 'Sunrise' : ev.kind === 'set' ? 'Sunset' : 'Solar noon (highest)'),
          h('td', {}, timeButton(ev.jd_utc, zone)),
          h('td', { 'data-csv': ev.az_deg.toFixed(2) }, bearing(ev.az_deg)),
          h('td', { 'data-csv': alt !== null ? alt.toFixed(3) : '' }, alt !== null ? altitude(alt, fmt) : 'on the horizon'),
        ),
      );
    }
    const env = data.path.envelope;
    const envHeaders = env.flatMap((e) => {
      const name = e.seasonJd !== null ? dayMonth(localDateOf(e.seasonJd, zone)) : e.kind.replace('_', ' ');
      return [`${name}: height`, `${name}: bearing`];
    });
    const envTable = table('The solstices and equinoxes, hour by hour (the same clock time as today; heights negative below the horizon)', ['Time', ...envHeaders]);
    for (let i = 0; i < points.length; i += perHour) {
      const p = points[i]!;
      if (p.jd_utc >= day.jd_end - 1e-9) break;
      const cells: HTMLElement[] = [];
      for (const e of data.path.raw.envelope) {
        const q = e.points[i];
        cells.push(
          h('td', { 'data-csv': q ? q.alt_apparent_deg.toFixed(3) : '' }, q ? altitude(q.alt_apparent_deg, fmt) : '—'),
          h('td', { 'data-csv': q ? q.az_deg.toFixed(2) : '' }, q ? bearing(q.az_deg) : '—'),
        );
      }
      envTable.body.append(h('tr', {}, h('th', { scope: 'row' }, clock(p.jd_utc, zone)), ...cells));
    }
    return [events.table, hourly.table, envTable.table];
  }
};

function legendItem(cls: string, text: string): HTMLElement {
  return h('span', { class: 'sfc-legend-item' }, h('span', { class: `sfc-key ${cls}`, 'aria-hidden': 'true' }), text);
}

export type { PathCurve };
