/**
 * The Planets → Close approaches tab: planets passing each other, the Moon passing the
 * planets and the bright stars along its path, and planets passing those stars
 * (`conjunctions`: the closest approach in the sky, within 5°), each with how close, which
 * way, whether it is far enough from the Sun, and when it is best seen from the place (the
 * engine's `best`, with the direction to look). OWNER: events2 agent.
 *
 * A year of close approaches is about a second of WebAssembly: the search runs three
 * weeks at a time between frames.
 */

import { h } from '../../dom.js';
import { isPlanetDetailEngine, type Conjunction } from '../engine/types.js';
import { bodyGlyph } from '../theme/glyphs.js';
import { chip, switchRow } from '../theme/primitives.js';
import type { EventsUi, TabComponent, TabEnv } from './env.js';
import { utcDate } from './items.js';
import { listTab, observerOf } from './listtab.js';
import { YEAR_DAYS, type Direction } from './model.js';
import { moonPartner, occultedSomewhere } from './moon-model.js';
import { conjunctionId, conjunctionItem, conjunctionSeen, type ViewDirection } from './planet-model.js';
import type { Badge } from './rows.js';

const words = (d: Direction): string => (d === 'upcoming' ? 'in the next 12 months' : 'in the last 12 months');

type Kinds = EventsUi['conjunctionKinds'];

function kindShown(c: Conjunction, k: Kinds): boolean {
  switch (c.kind) {
    case 'planet_planet':
      return k.planets;
    case 'moon_planet':
      return k.moon;
    case 'moon_star':
      return k.moon && k.stars;
    case 'planet_star':
      return k.stars;
  }
}

/** Where to look at the best moment: the body's azimuth then (remembered per event and place). */
function bestDirection(env: TabEnv, c: Conjunction, cache: Map<string, ViewDirection | null>): ViewDirection | null {
  const best = c.local?.best;
  if (!best) return null;
  const { observer, key } = observerOf(env.ctx.store.get());
  const id = `${conjunctionId(c)}|${key}`;
  if (cache.has(id)) return cache.get(id)!;
  let out: ViewDirection | null = null;
  try {
    const b = env.ctx.engine.skyState(observer, best.jd_utc, [c.body]).bodies[0];
    if (b) out = { azDeg: b.az_deg };
  } catch {
    out = null;
  }
  cache.set(id, out);
  return out;
}

export const conjunctionsTab: TabComponent = (host, env) => {
  const { ctx, ui } = env;
  const pd = isPlanetDetailEngine(ctx.engine) ? ctx.engine : null;
  const dirCache = new Map<string, ViewDirection | null>();
  let found: readonly Conjunction[] = [];
  const reach = new Map<string, boolean>();
  /** The Moon passes over the body as seen from somewhere on Earth (moon-model `occultedSomewhere`). */
  const hiddenSomewhere = (c: Conjunction): boolean => {
    const body = moonPartner(c);
    if (!body || c.separation_deg > 1.6) return false;
    const key = conjunctionId(c);
    const hit = reach.get(key);
    if (hit !== undefined) return hit;
    let yes = false;
    try {
      const st = ctx.engine.skyState({ lat_deg: 0, lon_deg: 0 }, c.jd_utc, ['Moon', ...(c.kind === 'moon_planet' ? [body] : [])]);
      const moon = st.bodies.find((b) => b.body === 'Moon');
      const other = st.bodies.find((b) => b.body === body);
      if (moon) yes = occultedSomewhere(c.separation_deg, moon.horizontal_parallax_arcmin / 60, moon.semidiameter_arcmin / 60, other ? other.semidiameter_arcmin / 60 : 0);
    } catch {
      yes = false;
    }
    reach.set(key, yes);
    return yes;
  };

  const kindChip = (key: keyof Kinds, label: string, tip: string): HTMLElement => {
    const el = chip({
      label,
      selected: ui.get().conjunctionKinds[key],
      tip,
      onClick: () => {
        const k = ui.get().conjunctionKinds;
        ui.patch({ conjunctionKinds: { ...k, [key]: !k[key] } });
      },
      class: 'sfe-filter',
    });
    return el;
  };
  const chips = [
    kindChip('planets', 'Planet pairs', 'Two planets passing each other'),
    kindChip('moon', 'With the Moon', 'The Moon passing a planet or a bright star'),
    kindChip('stars', 'With bright stars', 'Aldebaran, Regulus, Spica and Antares, the bright stars on the planets’ path'),
  ];
  const filterGroup = h('div', { class: 'sfe-filters', role: 'group', 'aria-label': 'Which close approaches' }, ...chips);
  const seen = switchRow({
    label: 'Seen from here',
    checked: ui.get().conjunctionsSeenOnly,
    note: 'Only those up in a dark enough sky at your place',
    onChange: (v) => ui.patch({ conjunctionsSeenOnly: v }),
  });
  seen.classList.add('sfe-seen');
  // Keep the chips' pressed state in step with the view's state.
  const unsub = ui.select(
    (u) => u.conjunctionKinds,
    (k) => {
      chips[0]!.setAttribute('aria-pressed', String(k.planets));
      chips[1]!.setAttribute('aria-pressed', String(k.moon));
      chips[2]!.setAttribute('aria-pressed', String(k.stars));
    },
  );

  const mounted = listTab<Conjunction>(host, env, {
    className: 'sfe-conj',
    unavailable: pd ? null : 'This build of the numerical core has no conjunction search. Rebuild it with: npm run wasm --prefix web',
    what: 'Close approaches',
    search: {
      name: 'conjunctions',
      key: (s) => observerOf(s).key,
      spec: (s) => {
        const { observer } = observerOf(s);
        return {
          chunkDays: 21,
          compute: (span) => pd!.conjunctions(span.start, span.end, { observer }).conjunctions,
          key: (c) => conjunctionId(c),
          time: (c) => c.jd_utc,
        };
      },
    },
    horizonDays: YEAR_DAYS,
    leadDays: 0.5,
    direction: {
      get: (u) => u.conjunctionDirection,
      set: (ui2, d) => ui2.patch({ conjunctionDirection: d }),
      labels: ['Next 12 months', 'Last 12 months'],
      label: 'Which months',
    },
    controls: [filterGroup, seen],
    watch: (u) => [u.conjunctionKinds.planets, u.conjunctionKinds.moon, u.conjunctionKinds.stars, u.conjunctionsSeenOnly],
    items: (all, w, _s, u) => {
      found = all;
      return all
        .filter((c) => kindShown(c, u.conjunctionKinds) && (!u.conjunctionsSeenOnly || conjunctionSeen(c)))
        .map((c) => conjunctionItem(c, w, bestDirection(env, c, dirCache)));
    },
    row: (item) => {
      const c = found.find((x) => conjunctionId(x) === item.id);
      const badges: Badge[] = [];
      if (c) {
        if (hiddenSomewhere(c)) badges.push({ text: 'Hidden from some places', tone: 'accent', tip: 'The Moon passes in front of it as seen from part of the Earth: see Moon → Occultations' });
        else if (c.separation_deg < 0.5) badges.push({ text: 'Very close', tone: 'accent', tip: 'Closer than the width of the full Moon' });
        if (!c.visible) badges.push({ text: 'Too near the Sun', tone: 'muted' });
        else if (c.local && !c.local.best) badges.push({ text: 'Not seen from here', tone: 'muted' });
      }
      return {
        badges,
        glyph: pairGlyph(c ?? null),
        dim: !!c && !conjunctionSeen(c),
        data: { conjunction: item.id },
      };
    },
    lead: (all, shown, w, _s, u) => {
      if (u.conjunctionDirection !== 'upcoming') return '';
      const next = all
        .filter((c) => c.kind === 'planet_planet' && conjunctionSeen(c) && c.jd_utc >= u.anchor && c.jd_utc <= u.anchor + YEAR_DAYS)
        .sort((a, b) => a.separation_deg - b.separation_deg)[0];
      void shown;
      return next ? `The closest pair of planets you can see in the next 12 months: ${conjunctionItem(next, w).title}, ${w.dateYear(next.jd_utc)}.` : '';
    },
    count: (n, d) => `${n} close ${n === 1 ? 'approach' : 'approaches'} within 5° ${words(d)}. The time is when they are closest, the same everywhere; “best seen” is for your place.`,
    empty: (d) => `No close approaches of the kinds chosen ${words(d)}.`,
    notes: () => [
      'A close approach is the moment two bodies are nearest in the sky (the almanac’s conjunction in longitude can be hours to days away). “Best seen” is the moment within 12 hours when the lower of the two stands highest with the Sun at least 6° down.',
    ],
    file: {
      title: (d) => `Close approaches, ${d === 'upcoming' ? 'next' : 'last'} 12 months`,
      parts: (anchor, d) => ['close-approaches', d === 'upcoming' ? 'next-12-months' : 'last-12-months', utcDate(anchor)],
      local: true,
    },
  });
  return {
    destroy: () => {
      unsub();
      mounted.destroy();
    },
  };
};

/** The two bodies' glyphs, overlapping. */
function pairGlyph(c: Conjunction | null): HTMLElement | null {
  if (!c) return null;
  return h('span', { class: 'sfe-pair' }, bodyGlyph(c.body, { size: 18 }), bodyGlyph(c.other, { size: 14, kind: c.kind.endsWith('star') ? 'star' : undefined }));
}
