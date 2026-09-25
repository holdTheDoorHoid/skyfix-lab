/**
 * The Moon → Occultations tab: the bright stars and planets the Moon hides as seen from
 * the place (`occultations`, contacts at the Moon's mean limb), with the time each
 * disappears and reappears, at which edge (dark or bright), how high the Moon stands and
 * whether the sky is dark; grazes and near misses flagged. With "Also not seen from here",
 * the ones that happen with the Moon below the horizon here, and those seen only from
 * elsewhere on Earth (the Moon's close passes of planets and bright ecliptic stars, from
 * `conjunctions`, that meet the geometric test of `occultedSomewhere`). OWNER: events2.
 *
 * The card draws the Moon as the place sees it (zenith up, the lit side where it is) with
 * the points of the edge where the body goes in and comes out, and a table of the contacts.
 */

import { h } from '../../dom.js';
import { isMoonDetailEngine, isPlanetDetailEngine, type Conjunction, type Occultation } from '../engine/types.js';
import { clockSeconds, compassPoint, compassWords, dateLong, formatAngle } from '../shell/format.js';
import { displayZone } from '../state.js';
import { roundToMinute, UTC_ZONE, zoneShortName } from '../time.js';
import { scaleLabel } from '../time/index.js';
import { bodyGlyph, phaseDisc } from '../theme/glyphs.js';
import { switchRow } from '../theme/primitives.js';
import type { TabComponent, TabEnv } from './env.js';
import { addToCalendarButton } from './export-ui.js';
import { fileWords, screenWords, utcDate, type EventItem } from './items.js';
import { listTab, observerOf } from './listtab.js';
import { YEAR_DAYS, type Direction } from './model.js';
import {
  betterOccultation,
  clockPosition,
  elsewhereItem,
  moonPartner,
  occultationId,
  occultationItem,
  occultedSomewhere,
  skyWords,
  whereSeen,
  type ElsewhereOccultation,
} from './moon-model.js';
import type { Badge } from './rows.js';

/** Navigational stars the Moon can pass over: within its reach of the ecliptic (6.6°). */
export const OCCULTABLE_STARS = ['Aldebaran', 'Regulus', 'Spica', 'Antares', 'Nunki', 'Elnath', 'Zubenelgenubi'] as const;

const words = (d: Direction): string => (d === 'upcoming' ? 'in the next 12 months' : 'in the last 12 months');

function eventKey(o: Occultation): string {
  return occultationId(o);
}

interface Reach {
  hp: number;
  sd: number;
  sdBody: number;
}

/** The Moon's parallax and size, and the body's size, at a close pass (geocentric; remembered). */
function reachAt(env: TabEnv, c: Conjunction, body: string, cache: Map<string, Reach>): Reach {
  const key = `${body}|${c.jd_utc}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // The mean values, if the engine cannot say: the test only sorts close passes.
  let r: Reach = { hp: 57 / 60, sd: 15.5 / 60, sdBody: 0 };
  try {
    const st = env.ctx.engine.skyState({ lat_deg: 0, lon_deg: 0 }, c.jd_utc, ['Moon', ...(c.kind === 'moon_planet' ? [body] : [])]);
    const moon = st.bodies.find((b) => b.body === 'Moon');
    const other = st.bodies.find((b) => b.body === body);
    r = {
      hp: moon ? moon.horizontal_parallax_arcmin / 60 : r.hp,
      sd: moon ? moon.semidiameter_arcmin / 60 : r.sd,
      sdBody: other ? other.semidiameter_arcmin / 60 : 0,
    };
  } catch {
    // keep the mean values
  }
  cache.set(key, r);
  return r;
}

/** The Moon's close passes that hide a body somewhere on Earth but not from here. */
function elsewhere(env: TabEnv, conj: readonly Conjunction[], local: readonly Occultation[], cache: Map<string, Reach>): ElsewhereOccultation[] {
  const out: ElsewhereOccultation[] = [];
  for (const c of conj) {
    const body = moonPartner(c);
    if (!body) continue;
    // Already in the list for this place (seen, or with the Moon below the horizon here)?
    if (local.some((o) => o.body === body && o.occulted && Math.abs(o.closest.jd_utc - c.jd_utc) < 0.5)) continue;
    const r = reachAt(env, c, body, cache);
    if (occultedSomewhere(c.separation_deg, r.hp, r.sd, r.sdBody)) out.push({ conjunction: c, where: whereSeen(c.separation_deg, c.position_angle_deg, r.sd) });
  }
  return out;
}

export const occultationsTab: TabComponent = (host, env) => {
  const { ctx, ui } = env;
  const md = isMoonDetailEngine(ctx.engine) ? ctx.engine : null;
  const pd = isPlanetDetailEngine(ctx.engine) ? ctx.engine : null;
  const all = switchRow({
    label: 'Also not seen from here',
    checked: ui.get().occultationsAll,
    note: 'With the Moon below the horizon here, or seen elsewhere on Earth',
    onChange: (v) => ui.patch({ occultationsAll: v }),
  });
  all.classList.add('sfe-seen');
  let lastLocal: readonly Occultation[] = [];
  const reach = new Map<string, Reach>();

  return listTab<Occultation>(host, env, {
    className: 'sfe-occ',
    unavailable: md ? null : 'This build of the numerical core has no occultation search. Rebuild it with: npm run wasm --prefix web',
    what: 'Occultations',
    search: {
      name: 'occultations',
      key: (s) => observerOf(s).key,
      spec: (s) => {
        const { observer } = observerOf(s);
        return {
          chunkDays: 61,
          compute: (span) => {
            const r = md!.occultations(observer, span.start, span.end, { include_below_horizon: true });
            return r.events;
          },
          key: eventKey,
          time: (o) => o.disappearance?.jd_utc ?? o.closest.jd_utc,
          better: betterOccultation,
        };
      },
    },
    aux: pd
      ? {
          name: 'occultations-elsewhere',
          key: () => '',
          enabled: (u) => u.occultationsAll,
          spec: () => ({
            chunkDays: 30,
            compute: (span) =>
              pd.conjunctions(span.start, span.end, { moon: true, stars: [...OCCULTABLE_STARS], max_separation_deg: 1.5 }).conjunctions.filter(
                (c) => moonPartner(c) !== null,
              ),
            key: (c) => `${(c as Conjunction).body}|${(c as Conjunction).other}|${Math.round((c as Conjunction).jd_utc * 24)}`,
            time: (c) => (c as Conjunction).jd_utc,
          }),
        }
      : undefined,
    horizonDays: YEAR_DAYS,
    leadDays: 0.1,
    direction: {
      get: (u) => u.occultationDirection,
      set: (ui2, d) => ui2.patch({ occultationDirection: d }),
      labels: ['Next 12 months', 'Last 12 months'],
      label: 'Which months',
    },
    controls: [all],
    watch: (u) => [u.occultationsAll],
    items: (found, w, _s, u, aux) => {
      lastLocal = found;
      const local = found.filter((o) => (u.occultationsAll ? true : o.visible)).map((o) => occultationItem(o, w));
      if (!u.occultationsAll || !aux) return local;
      const s = ctx.store.get();
      const zoneWords = screenWords({ ...s, settings: { ...s.settings, timeDisplay: 'utc' } });
      const far = elsewhere(env, aux as Conjunction[], found, reach).map((e) => elsewhereItem(e, w, (jd) => zoneWords.time(jd)));
      return [...local, ...far];
    },
    row: (item) => {
      const o = lastLocal.find((x) => occultationId(x) === item.id) ?? null;
      const badges: Badge[] = [];
      if (o) {
        if (o.graze) badges.push({ text: 'Graze', tone: 'accent', tip: 'Passes within 1′ of the Moon’s mean edge: it may blink among the lunar mountains' });
        if (!o.occulted) badges.push({ text: 'Near miss', tone: 'muted' });
        if (!o.visible) badges.push({ text: 'Moon below the horizon', tone: 'muted' });
        else if (o.disappearance?.sky_phase === 'day' && (o.reappearance?.sky_phase ?? 'day') === 'day') badges.push({ text: 'Daylight', tone: 'muted', tip: 'The Sun is up: a telescope is needed' });
        if (o.kind === 'planet') badges.push({ text: 'Planet', tone: 'plain' });
      } else {
        badges.push({ text: 'Not seen from here', tone: 'muted' });
      }
      return {
        badges,
        glyph: o?.kind === 'planet' || (!o && item.body && ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'].includes(item.body)) ? bodyGlyph(item.body ?? 'Moon', { size: 22 }) : bodyGlyph('Moon', { size: 22 }),
        dim: !o || !o.visible,
        showEnd: !!o && o.occulted && !!o.disappearance && !!o.reappearance,
        data: { occultation: item.id },
      };
    },
    lead: (found, shown, w, _s, u) => {
      const seen = found.filter((o) => o.visible && o.occulted);
      if (!seen.length) return '';
      const next = seen.find((o) => (o.disappearance?.jd_utc ?? o.closest.jd_utc) >= u.anchor);
      if (!next || u.occultationDirection !== 'upcoming') return '';
      void shown;
      return `Next seen from here: ${occultationItem(next, w).title.replace(/^The Moon hides /, 'the Moon hides ')}, ${w.dateYear(next.disappearance?.jd_utc ?? next.closest.jd_utc)} at ${w.time(next.disappearance?.jd_utc ?? next.closest.jd_utc)}.`;
    },
    count: (n, d) => `${n} ${n === 1 ? 'occultation' : 'occultations'} ${words(d)}, for stars brighter than magnitude 3.5 and the planets.`,
    empty: (d) =>
      `No occultations of bright stars or planets seen from here ${words(d)}. The Moon passes over a given bright star only in some years; turn on “Also not seen from here” to see those elsewhere.`,
    notes: () => [LIMB_NOTE],
    file: {
      title: (d) => `Lunar occultations, ${d === 'upcoming' ? 'next' : 'last'} 12 months`,
      parts: (anchor, d) => ['occultations', d === 'upcoming' ? 'next-12-months' : 'last-12-months', utcDate(anchor)],
      local: true,
    },
    card: {
      selected: (u) => u.occultation,
      select: (ui2, id) => ui2.patch({ occultation: id }),
      empty: 'Choose an occultation to see the Moon as it will look, where on its edge the star or planet goes in and comes out, and the times to the second.',
      build: (item, found, e) => {
        const o = found.find((x) => occultationId(x) === item.id);
        return o ? occultationCard(o, item, e) : null;
      },
    },
  });
};

const LIMB_NOTE =
  'Times are for the Moon’s mean edge: its mountains and valleys move a contact by seconds, and by up to a minute where the body meets the edge at a slant near the Moon’s poles. Stars brighter than magnitude 3.5 and the planets are searched.';

// ---------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------

/** The Moon's disc as the place sees it (zenith up), with the contacts on its edge. */
function moonDrawing(o: Occultation, env: TabEnv): SVGSVGElement | null {
  const ctx = env.ctx;
  const first = o.disappearance ?? o.reappearance;
  if (!first) return null;
  let limbFromUp = 270;
  try {
    const { observer } = observerOf(ctx.store.get());
    const m = ctx.engine.skyState(observer, first.jd_utc, ['Moon']).bodies.find((b) => b.body === 'Moon');
    if (m && m.bright_limb_angle_deg !== null) limbFromUp = m.bright_limb_angle_deg - m.parallactic_angle_deg;
  } catch {
    // draw it lit from the right
  }
  const svg = phaseDisc({
    illuminated: o.moon_illuminated_fraction,
    limbFromUpDeg: limbFromUp,
    size: 168,
    label: `The Moon as seen from here at ${first.kind}, ${Math.round(o.moon_illuminated_fraction * 100)}% lit, up toward the zenith, with where ${o.body} goes in and comes out`,
    class: 'sfe-occ__disc',
  });
  svg.setAttribute('viewBox', '-15 -15 30 30');
  const NS = 'http://www.w3.org/2000/svg';
  const up = document.createElementNS(NS, 'text');
  up.setAttribute('x', '-14.6');
  up.setAttribute('y', '-13.2');
  up.setAttribute('class', 'sfe-occ__up');
  up.textContent = '↑ up (zenith)';
  svg.append(up);
  for (const c of [o.disappearance, o.reappearance]) {
    if (!c) continue;
    const v = (c.vertex_angle_deg * Math.PI) / 180;
    const x = -10 * Math.sin(v);
    const y = -10 * Math.cos(v);
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', x.toFixed(2));
    dot.setAttribute('cy', y.toFixed(2));
    dot.setAttribute('r', '1.05');
    dot.setAttribute('class', `sfe-occ__point sfe-occ__point--${c.kind}`);
    svg.append(dot);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', (x * 1.27).toFixed(2));
    t.setAttribute('y', (y * 1.27 + 0.9).toFixed(2));
    t.setAttribute('class', 'sfe-occ__label');
    t.textContent = c.kind === 'disappearance' ? 'In' : 'Out';
    svg.append(t);
  }
  return svg;
}

function occultationCard(o: Occultation, item: EventItem, env: TabEnv): { el: HTMLElement } {
  const { ctx, ui } = env;
  const s = ctx.store.get();
  const zone = displayZone(s);
  const w = screenWords(s);
  const format = s.settings.angleFormat;
  const first = o.disappearance ?? o.reappearance;
  const at = first?.jd_utc ?? o.closest.jd_utc;
  const title = h('h3', { class: 'sfe-card__title', id: `sfe-occ-${item.id}` }, dateLong(roundToMinute(at), zone));
  const kicker = h('p', { class: 'sfe-card__kicker' }, bodyGlyph(o.kind === 'planet' ? o.body : 'Moon', { size: 16 }), h('span', {}, item.title));
  const parts: (Element | null)[] = [];
  parts.push(h('div', { class: 'sfe-summary' }, h('p', {}, item.sentence)));
  const drawing = moonDrawing(o, env);
  const rows = [o.disappearance, o.reappearance].filter((c): c is NonNullable<typeof c> => c !== null);
  if (rows.length) {
    const table = h(
      'table',
      { class: 'sf-table' },
      h('caption', { class: 'sfe-sr' }, `${item.title}: the contacts seen from ${s.observer.label || 'your place'}`),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, 'What happens'),
          h('th', { scope: 'col' }, `Time (${zoneShortName(at, zone)})`),
          h('th', { scope: 'col' }, 'Where on the edge'),
          h('th', { scope: 'col', class: 'sf-num-r' }, 'Moon’s height'),
        ),
      ),
      h(
        'tbody',
        {},
        ...rows.map((c) => {
          const time = h(
            'button',
            { type: 'button', class: 'sfe-time', 'aria-label': `Go to the ${c.kind}, ${clockSeconds(c.jd_utc, zone)}`, 'data-tip': 'Set the explorer’s time to this moment' },
            clockSeconds(c.jd_utc, zone),
          );
          time.addEventListener('click', () => env.jump(c.jd_utc, { body: o.body }));
          const cusp = Math.abs(c.cusp_angle_deg);
          return h(
            'tr',
            { class: c.moon_above_horizon ? '' : 'sfe-row-hidden' },
            h(
              'th',
              { scope: 'row' },
              h('span', { class: 'sfe-ev__name' }, c.kind === 'disappearance' ? `${o.body} disappears` : `${o.body} reappears`),
              h('span', { class: 'sfe-ev__term', 'data-term': '' }, c.kind === 'disappearance' ? 'disappearance (D)' : 'reappearance (R)'),
              h('span', { class: 'sfe-ev__extra' }, skyWords(c.sky_phase)),
            ),
            h('td', {}, time, h('span', { class: 'sfe-utc' }, `${clockSeconds(c.jd_utc, UTC_ZONE)} ${scaleLabel(c.jd_utc)}`)),
            h(
              'td',
              {},
              h('span', { class: 'sfe-ev__name' }, `${c.limb === 'dark' ? 'Dark' : 'Bright'} edge, ${clockPosition(c.vertex_angle_deg)} o’clock`),
              h('span', { class: 'sfe-ev__term', 'data-term': '' }, `position angle ${Math.round(c.position_angle_deg)}°, ${Math.round(cusp)}° from the ${c.cusp} cusp`),
            ),
            h(
              'td',
              { class: 'sf-num-r' },
              formatAngle(c.moon_alt_deg, format, 'coarse'),
              c.moon_above_horizon
                ? h('span', { class: 'sfe-utc' }, h('abbr', { title: compassWords(c.moon_az_deg) }, compassPoint(c.moon_az_deg)))
                : h('span', { class: 'sfe-below' }, 'below the horizon'),
            ),
          );
        }),
      ),
    );
    parts.push(h('div', { class: 'sfe-occ__figure' }, drawing, h('div', { class: 'sfe-contacts' }, table)));
    parts.push(
      h(
        'p',
        { class: 'sfe-note' },
        'A star at the dark edge winks out at once, the easiest to time; at the bright edge it is harder to see against the glare. “O’clock” is the edge as you see it, with 12 toward the point overhead.',
      ),
    );
  } else if (drawing) {
    parts.push(drawing);
  }
  parts.push(h('p', { class: 'sfe-note' }, LIMB_NOTE));
  const add = addToCalendarButton(ctx, ui, () => occultationItem(o, fileWords(ctx.store.get())), `${item.title}, ${w.dateYear(at)}`);
  const actions = h('div', { class: 'sfe-actions' }, add, h('span', { class: 'sfe-note' }, 'Add to a calendar'));
  const el = h(
    'article',
    { class: 'sfe-card sfe-card--occ', 'aria-labelledby': `sfe-occ-${item.id}`, 'data-occultation': item.id },
    h('header', { class: 'sfe-card__head' }, kicker, title),
    ...parts.filter((p): p is Element => p !== null),
    actions,
  );
  return { el };
}

