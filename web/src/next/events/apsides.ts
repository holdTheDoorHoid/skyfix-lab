/**
 * The Moon → Perigee and supermoons tab: the Moon nearest and farthest on each orbit,
 * every full Moon with how big it looks, the supermoons and micromoons (Nolle's rule), and
 * the year's largest and smallest full Moon (`moon_apsides`). OWNER: events2 agent.
 *
 * A year of apsides costs a few hundred milliseconds of WebAssembly, most of it finding
 * the phases: the search runs in half-year pieces between frames (search.ts).
 */

import { isMoonDetailEngine, type MoonApsis, type MoonSyzygy } from '../engine/types.js';
import { bodyGlyph, phaseDisc } from '../theme/glyphs.js';
import type { TabComponent } from './env.js';
import { utcDate, type EventItem } from './items.js';
import { listTab } from './listtab.js';
import { YEAR_DAYS, type Direction } from './model.js';
import { apsidesItems, apsidesLead, syzygyItem } from './moon-model.js';
import type { Badge } from './rows.js';
import { listCoverage } from './deeptime.js';

type Found = { apsis: MoonApsis } | { syzygy: MoonSyzygy };

function timeOf(f: Found): number {
  return 'apsis' in f ? f.apsis.jd_utc : f.syzygy.jd_utc;
}

function keyOf(f: Found): string {
  return 'apsis' in f ? `a|${f.apsis.kind}|${Math.round(f.apsis.jd_utc * 24)}` : `s|${f.syzygy.kind}|${Math.round(f.syzygy.jd_utc * 24)}`;
}

const words = (d: Direction): string => (d === 'upcoming' ? 'in the next 12 months' : 'in the last 12 months');

export const apsidesTab: TabComponent = (host, env) => {
  const engine = env.ctx.engine;
  const md = isMoonDetailEngine(engine) ? engine : null;
  return listTab<Found>(host, env, {
    className: 'sfe-aps',
    unavailable: md ? null : 'This build of the numerical core has no Moon perigee search. Rebuild it with: npm run wasm --prefix web',
    what: 'Perigees and apogees',
    coverage: () => (md ? listCoverage(engine, 'moon-apsides', (t) => md.moonApsides(t, t + 1 / 24)) : null),
    search: {
      name: 'moon-apsides',
      key: () => '',
      spec: () => ({
        chunkDays: 183,
        compute: (span) => {
          const r = md!.moonApsides(span.start, span.end);
          return [...r.apsides.map((apsis): Found => ({ apsis })), ...r.syzygies.map((syzygy): Found => ({ syzygy }))];
        },
        key: keyOf,
        time: timeOf,
      }),
    },
    horizonDays: YEAR_DAYS,
    leadDays: 0,
    direction: {
      get: (u) => u.apsisDirection,
      set: (ui, d) => ui.patch({ apsisDirection: d }),
      labels: ['Next 12 months', 'Last 12 months'],
      label: 'Which months',
    },
    items: (found, w) => {
      const apsides = found.flatMap((f) => ('apsis' in f ? [f.apsis] : []));
      const syzygies = found.flatMap((f) => ('syzygy' in f ? [f.syzygy] : []));
      return apsidesItems({ apsides, syzygies }, w);
    },
    row: (item, found) => {
      const syz = found.find((f): f is { syzygy: MoonSyzygy } => 'syzygy' in f && syzygyItem(f.syzygy, noWords)?.id === item.id);
      const badges: Badge[] = [];
      if (syz) {
        const s = syz.syzygy;
        if (s.supermoon) badges.push({ text: 'Supermoon', tone: 'accent', tip: 'At least 90% of the way from apogee to perigee (Nolle’s rule)' });
        if (s.micromoon) badges.push({ text: 'Micromoon', tone: 'muted', tip: 'At most 10% of the way from apogee to perigee' });
        if (s.largest_of_year) badges.push({ text: 'Largest of the year', tone: 'accent' });
        if (s.smallest_of_year) badges.push({ text: 'Smallest of the year', tone: 'muted' });
        const full = s.kind === 'full_moon';
        return {
          badges,
          glyph: phaseDisc({ illuminated: full ? 1 : 0, size: 22 }),
          dim: !full,
        };
      }
      return { glyph: apsisGlyph(item) };
    },
    lead: (found, _shown, w, _s, u) => apsidesLead(found.flatMap((f) => ('syzygy' in f ? [f.syzygy] : [])), u.anchor, w),
    count: (n, d) => `${n} events ${words(d)}: perigees, apogees and full Moons. Geocentric: the same everywhere.`,
    empty: (d) => `No perigees or apogees ${words(d)}.`,
    notes: (found) => (found.length ? [DEFINITIONS] : []),
    file: {
      title: (d) => `Moon perigee, apogee and supermoons, ${d === 'upcoming' ? 'next' : 'last'} 12 months`,
      parts: (anchor, d) => ['moon-perigee', d === 'upcoming' ? 'next-12-months' : 'last-12-months', utcDate(anchor)],
      local: false,
    },
  });
};

/** Words that are never shown (to name a syzygy's item without formatting cost). */
const noWords = {
  time: () => '',
  seconds: () => '',
  date: () => '',
  dateYear: () => '',
  angle: () => '',
  altitude: () => '',
  direction: () => '',
  distance: () => '',
  magnitude: () => '',
};

function apsisGlyph(item: EventItem): SVGSVGElement {
  const g = bodyGlyph('Moon', { size: item.kind === 'Perigee' ? 24 : 16 });
  g.classList.add(item.kind === 'Perigee' ? 'sfe-aps__near' : 'sfe-aps__far');
  return g;
}

/** What the words mean (the engine's definitions, CONVENTIONS 13.10). */
const DEFINITIONS =
  'Supermoon here means a new or full Moon at least 90% of the way from apogee to perigee (Nolle, 1979): about a third of them qualify. Other sources use stricter rules, so their lists are shorter. Sizes are against the Moon’s average distance, 384 400 km, centre to centre.';
