/**
 * The Planets → Retrograde tab: when each planet seems to stop against the stars and turn
 * backwards, and when it turns forward again (`stations`, in ecliptic longitude, the
 * definition of retrograde motion), with a timeline of the year's retrograde loops and
 * which planets are retrograde at the explorer's time. OWNER: events2 agent.
 */

import { h, s as svgEl } from '../../dom.js';
import { isPlanetDetailEngine, type PlanetStation } from '../engine/types.js';
import { monthName } from '../shell/format.js';
import { msFromJd } from '../time.js';
import { gregorianDateOfMs } from '../time/index.js';
import { bodyGlyph, bodyColor } from '../theme/glyphs.js';
import type { TabComponent } from './env.js';
import { utcDate } from './items.js';
import { listTab } from './listtab.js';
import { YEAR_DAYS, type Direction } from './model.js';
import { PLANET_ORDER, retrogradeAt, retrogradePeriods, stationId, stationItem, type RetrogradePeriod } from './planet-model.js';

const words = (d: Direction): string => (d === 'upcoming' ? 'in the next 12 months' : 'in the last 12 months');

/** A loop can start up to this long before the list's months (Jupiter to Neptune: about five months). */
const LOOP_LEAD_DAYS = 170;

function periodsOf(found: readonly PlanetStation[]): RetrogradePeriod[] {
  const coordinate = 'ecliptic_longitude' as const;
  return retrogradePeriods(found, coordinate);
}

export const retrogradeTab: TabComponent = (host, env) => {
  const { ctx } = env;
  const pd = isPlanetDetailEngine(ctx.engine) ? ctx.engine : null;
  return listTab<PlanetStation>(host, env, {
    className: 'sfe-retro',
    unavailable: pd ? null : 'This build of the numerical core has no station search. Rebuild it with: npm run wasm --prefix web',
    what: 'Stations',
    search: {
      name: 'stations',
      key: () => '',
      spec: () => ({
        chunkDays: 61,
        // The explorer shows the ecliptic stations (EXPLORER_API `ui_coordinate`).
        compute: (span) => {
          const r = pd!.stations(span.start, span.end);
          return r.stations.filter((st) => st.coordinate === r.ui_coordinate);
        },
        key: (st) => stationId(st),
        time: (st) => st.jd_utc,
      }),
    },
    horizonDays: YEAR_DAYS,
    leadDays: 0,
    // Search the months before too, so a loop under way at the start is known.
    slackDays: LOOP_LEAD_DAYS,
    direction: {
      get: (u) => u.planetDirection,
      set: (ui, d) => ui.patch({ planetDirection: d }),
      labels: ['Next 12 months', 'Last 12 months'],
      label: 'Which months',
    },
    items: (found, w) => {
      const periods = periodsOf(found);
      return found.map((st) => {
        const period = periods.find((p) => p.begins === st || p.ends === st) ?? null;
        return stationItem(st, period, w);
      });
    },
    row: (item) => ({ glyph: bodyGlyph(item.body ?? 'Mars', { size: 22 }), data: { station: item.id } }),
    lead: (found, _shown, w, _s, u) => {
      const on = retrogradeAt(periodsOf(found), u.anchor).filter((p) => p.begins || p.ends);
      if (!on.length) return `On ${w.dateYear(u.anchor)} no planet is retrograde.`;
      const parts = on.map((p) => `${p.body}${p.ends ? ` (until ${w.date(p.ends.jd_utc)})` : ''}`);
      return `Retrograde on ${w.dateYear(u.anchor)}: ${parts.join(', ')}.`;
    },
    figure: (found, _shown, s, u) => timeline(found, u.anchor, u.planetDirection, s.time.jd_utc),
    count: (n, d) => `${n} ${n === 1 ? 'station' : 'stations'} ${words(d)}. Geocentric: the same everywhere.`,
    empty: (d) => `No stations ${words(d)}.`,
    notes: () => [
      'A station is when a planet’s place among the stars stops changing (its ecliptic longitude): it is then still for a few days before moving the other way. Between two stations the planet is retrograde, moving westward among the stars.',
    ],
    file: {
      title: (d) => `Planet stations, ${d === 'upcoming' ? 'next' : 'last'} 12 months`,
      parts: (anchor, d) => ['planet-stations', d === 'upcoming' ? 'next-12-months' : 'last-12-months', utcDate(anchor)],
      local: false,
    },
  });
};

/**
 * The year's retrograde loops as bars, one row per planet, with the months along the
 * bottom and the explorer's time as a line. Words carry the same facts (the list below).
 */
function timeline(found: readonly PlanetStation[], anchor: number, dir: Direction, now: number): { el: Element; setNow(jd: number): void } {
  const t0 = dir === 'upcoming' ? anchor : anchor - YEAR_DAYS;
  const t1 = t0 + YEAR_DAYS;
  const W = 720;
  const rowH = 22;
  const left = 78;
  const right = 10;
  const top = 6;
  const H = top + PLANET_ORDER.length * rowH + 26;
  const x = (jd: number): number => left + ((Math.min(t1, Math.max(t0, jd)) - t0) / (t1 - t0)) * (W - left - right);
  const periods = periodsOf(found);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sfe-retro__svg', role: 'img' }) as SVGSVGElement;
  const described: string[] = [];
  PLANET_ORDER.forEach((body, i) => {
    const y = top + i * rowH;
    svg.append(svgEl('rect', { x: left, y: y + 3, width: W - left - right, height: rowH - 6, rx: 3, class: 'sfe-retro__lane' }));
    const label = svgEl('text', { x: left - 8, y: y + rowH / 2 + 4, class: 'sfe-retro__name', 'text-anchor': 'end' });
    label.textContent = body;
    svg.append(label);
    for (const p of periods.filter((q) => q.body === body)) {
      const a = p.begins?.jd_utc ?? t0 - 1;
      const b = p.ends?.jd_utc ?? t1 + 1;
      if (b < t0 || a > t1) continue;
      const bar = svgEl('rect', { x: x(a), y: y + 4, width: Math.max(2, x(b) - x(a)), height: rowH - 8, rx: 3, class: 'sfe-retro__bar' });
      (bar as SVGElement).style.fill = bodyColor(body);
      svg.append(bar);
      const from = p.begins ? monthDay(p.begins.jd_utc) : 'before';
      const to = p.ends ? monthDay(p.ends.jd_utc) : 'after';
      described.push(`${body} retrograde ${from} to ${to}`);
    }
  });
  // Month ticks (UTC, Gregorian: the engine's calendar).
  const w0 = gregorianDateOfMs(msFromJd(t0));
  for (let k = 0; k <= 12; k += 1) {
    const jd = monthStartJd(w0.year, w0.month + k);
    if (jd < t0 || jd > t1) continue;
    const xx = x(jd);
    svg.append(svgEl('line', { x1: xx, x2: xx, y1: top, y2: top + PLANET_ORDER.length * rowH, class: 'sfe-retro__tick' }));
    const month = ((w0.month + k - 1) % 12) + 1;
    const t = svgEl('text', { x: xx + 3, y: H - 8, class: 'sfe-retro__month' });
    t.textContent = monthName(month).slice(0, 3);
    svg.append(t);
  }
  const nowLine = svgEl('line', { x1: 0, x2: 0, y1: top - 2, y2: top + PLANET_ORDER.length * rowH + 2, class: 'sfe-retro__now' });
  svg.append(nowLine);
  svg.setAttribute('aria-label', described.length ? `Retrograde loops: ${described.join('; ')}.` : 'No retrograde loops in these months.');
  const setNow = (jd: number): void => {
    const inside = jd >= t0 && jd <= t1;
    nowLine.setAttribute('visibility', inside ? 'visible' : 'hidden');
    if (inside) {
      const xx = x(jd).toFixed(1);
      nowLine.setAttribute('x1', xx);
      nowLine.setAttribute('x2', xx);
    }
  };
  setNow(now);
  const legend = h('p', { class: 'sfe-note sfe-retro__legend' }, bodyGlyph('Mars', { size: 12 }), ' Bars: each planet’s retrograde loops in these 12 months; the line is the time shown.');
  const el = h('figure', { class: 'sfe-retro-fig' }, svg, h('figcaption', {}, legend));
  return { el, setNow };
}

function monthDay(jd: number): string {
  const w = gregorianDateOfMs(msFromJd(jd));
  return `${w.day} ${monthName(w.month).slice(0, 3)}`;
}

/** The UTC Julian date of the 1st of a month (months may run past 12). */
function monthStartJd(year: number, month: number): number {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((month - 1) % 12 + 12) % 12 + 1;
  const d = new Date(0);
  d.setUTCFullYear(y, m - 1, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() / 86_400_000 + 2_440_587.5;
}
