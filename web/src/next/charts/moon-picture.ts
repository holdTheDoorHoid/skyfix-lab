/**
 * The Moon calendar as a picture (charts2 agent, expansion programme Q5): the same month as
 * the on-screen grid (which is HTML, for keyboard use), drawn as one SVG for "Save picture"
 * and sharing. OWNER: charts2 agent.
 *
 * Seven columns of days: the date, how much of the Moon is lit, its disc at local noon (north
 * up, or south up south of the equator), the phase, moonrise and moonset, and the perigee,
 * apogee, supermoon or micromoon of the day. Styled by class (charts.css), like every chart.
 */

import { s } from '../../dom.js';
import type { MoonApsides } from '../engine/types.js';
import type { Units } from '../state.js';
import { phaseDisc } from '../theme/glyphs.js';
import { fallbackLimbFromUp, limbFromUp } from './disc.js';
import { clockAt, offsetOn, percent, WEEKDAYS_SHORT } from './format.js';
import { round, svgText } from './frame.js';
import { apsidesOn, monthGrid, PHASE_NAMES, type MoonDay, type MoonMonth } from './moon-data.js';

export interface CalendarPictureOptions {
  readonly apsides: MoonApsides | null;
  readonly south: boolean;
  /** 0 = Sunday. */
  readonly firstWeekday: number;
  readonly units: Units;
  readonly title: string;
}

const CELL_W = 118;
const CELL_H = 118;
const GAP = 4;
const HEAD = 22;

export function calendarPicture(data: MoonMonth, options: CalendarPictureOptions): SVGSVGElement {
  const rows = monthGrid(data.days, options.firstWeekday);
  const W = 7 * CELL_W + 6 * GAP;
  const H = HEAD + rows.length * CELL_H + (rows.length - 1) * GAP;
  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': options.title }) as SVGSVGElement;
  const zone = data.input.zone;
  for (let i = 0; i < 7; i += 1) {
    svg.append(svgText(i * (CELL_W + GAP) + CELL_W / 2, 14, WEEKDAYS_SHORT[(options.firstWeekday + i) % 7]!.toUpperCase(), { 'text-anchor': 'middle', class: 'sfc-px-wd' }));
  }
  rows.forEach((row, r) => {
    row.forEach((md, k) => {
      const x = k * (CELL_W + GAP);
      const y = HEAD + r * (CELL_H + GAP);
      if (!md) {
        svg.append(s('rect', { class: 'sfc-px-blank', x, y, width: CELL_W, height: CELL_H, rx: 8 }));
        return;
      }
      svg.append(cell(md, x, y, zone, options));
    });
  });
  return svg;
}

function cell(md: MoonDay, x: number, y: number, zone: MoonMonth['input']['zone'], options: CalendarPictureOptions): SVGGElement {
  const g = s('g', { class: 'sfc-px-day' }) as SVGGElement;
  g.append(s('rect', { class: md.principal ? 'sfc-px-cell sfc-px-cell--principal' : 'sfc-px-cell', x, y, width: CELL_W, height: CELL_H, rx: 8 }));
  g.append(svgText(x + 8, y + 16, String(md.day.date.day), { class: 'sfc-px-num' }));
  if (md.illuminated !== null) g.append(svgText(x + CELL_W - 8, y + 15, percent(md.illuminated), { 'text-anchor': 'end', class: 'sfc-px-pct' }));
  const size = 40;
  const limb = md.brightLimbDeg !== null ? limbFromUp(md.brightLimbDeg, options.south) : fallbackLimbFromUp(md.waxing ?? true, options.south);
  const disc = phaseDisc({ illuminated: md.illuminated ?? 0, limbFromUpDeg: limb, size });
  disc.setAttribute('x', String(round(x + CELL_W / 2 - size / 2)));
  disc.setAttribute('y', String(round(y + 22)));
  g.append(disc);
  const name = md.principal ? PHASE_NAMES[md.principal.kind] : md.name;
  g.append(svgText(x + CELL_W / 2, y + 76, name, { 'text-anchor': 'middle', class: md.principal ? 'sfc-px-name sfc-px-name--principal' : 'sfc-px-name' }));
  const times: string[] = [];
  for (const jd of md.rises) times.push(`↑${clockAt(jd, offsetOn(md.day, jd, zone))}`);
  for (const jd of md.sets) times.push(`↓${clockAt(jd, offsetOn(md.day, jd, zone))}`);
  if (!times.length) times.push(md.alwaysAbove ? 'up all day' : md.alwaysBelow ? 'down all day' : '—');
  g.append(svgText(x + CELL_W / 2, y + 92, times.join('  '), { 'text-anchor': 'middle', class: 'sfc-px-times' }));
  const marks = apsidesOn(options.apsides, md.day);
  if (marks.length) {
    g.append(svgText(x + CELL_W / 2, y + 108, marks.map((m) => m.short).join(' · '), { 'text-anchor': 'middle', class: 'sfc-px-badge' }));
  }
  return g;
}
