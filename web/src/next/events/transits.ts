/**
 * The Planets → Transits tab: Mercury and Venus crossing the Sun's face in the next (or
 * last) hundred years, with what the place sees (`transits` with the observer): a card
 * with the planet's path across the Sun drawn, the contacts' times and the Sun's height at
 * each, the circumstances seen from the Earth's centre, and the eye-safety note.
 * OWNER: events2 agent.
 *
 * The search runs two years at a time between frames: a century with local circumstances
 * is a second or two of WebAssembly (about 7 ms a year to scan, 70 ms per transit found).
 */

import { h, s as svgEl } from '../../dom.js';
import { isPlanetDetailEngine, type PlanetTransit, type PlanetTransitLocalEvent } from '../engine/types.js';
import { clockSeconds, compassPoint, compassWords, dateLong, formatAngle } from '../shell/format.js';
import { displayZone } from '../state.js';
import { roundToMinute, UTC_ZONE, zoneShortName } from '../time.js';
import { scaleLabel } from '../time/index.js';
import { bodyGlyph } from '../theme/glyphs.js';
import type { TabComponent, TabEnv } from './env.js';
import { addToCalendarButton } from './export-ui.js';
import { fileWords, screenWords, utcDate, type EventItem } from './items.js';
import { listTab, observerOf } from './listtab.js';
import { formatDuration, type Direction } from './model.js';
import { transitEventName, transitHere, transitItem, transitPosition, transitSummary } from './planet-model.js';
import type { Badge } from './rows.js';
import { listCoverage } from './deeptime.js';

/** A century of transits. */
export const TRANSIT_HORIZON_DAYS = 100 * 365.25;

const words = (d: Direction): string => (d === 'upcoming' ? 'in the next 100 years' : 'in the last 100 years');

export const transitsTab: TabComponent = (host, env) => {
  const { ctx } = env;
  const pd = isPlanetDetailEngine(ctx.engine) ? ctx.engine : null;
  let found: readonly PlanetTransit[] = [];
  return listTab<PlanetTransit>(host, env, {
    className: 'sfe-transits',
    unavailable: pd ? null : 'This build of the numerical core has no transit search. Rebuild it with: npm run wasm --prefix web',
    what: 'Transits of Mercury and Venus',
    coverage: () => (pd ? listCoverage(ctx.engine, 'transits', (t) => pd.transits(t, t + 1 / 24)) : null),
    search: {
      name: 'transits',
      key: (s) => observerOf(s).key,
      spec: (s) => {
        const { observer } = observerOf(s);
        return {
          chunkDays: 730.5,
          compute: (span) => pd!.transits(span.start, span.end, observer).transits,
          key: (t) => t.id,
          time: (t) => t.contacts[0]?.jd_utc ?? 0,
        };
      },
    },
    horizonDays: TRANSIT_HORIZON_DAYS,
    leadDays: 0.5,
    slackDays: 0,
    direction: {
      get: (u) => u.transitDirection,
      set: (ui, d) => ui.patch({ transitDirection: d }),
      labels: ['Next 100 years', 'Last 100 years'],
      label: 'Which years',
    },
    items: (all, w) => {
      found = all;
      return all.map((t) => transitItem(t, w));
    },
    row: (item, _found, s) => {
      const t = found.find((x) => `transit-${x.id}` === item.id);
      const badges: Badge[] = [];
      let dim = false;
      if (t) {
        const here = transitHere(t, screenWords(s));
        badges.push({ text: here.seen ? (here.tone === 'central' ? 'Seen here' : 'Partly seen here') : 'Not seen here', tone: here.seen ? 'accent' : 'muted' });
        if (t.grazing) badges.push({ text: 'Grazing', tone: 'muted', tip: 'The planet never lies wholly inside the Sun’s disc' });
        dim = !here.seen;
      }
      return { badges, glyph: bodyGlyph(item.body ?? 'Mercury', { size: 22 }), dim, showEnd: true, data: { transit: item.id } };
    },
    lead: (all, _shown, w, _s, u) => {
      if (u.transitDirection !== 'upcoming') return '';
      const next = all.filter((t) => (t.contacts[0]?.jd_utc ?? 0) >= u.anchor).sort((a, b) => a.contacts[0]!.jd_utc - b.contacts[0]!.jd_utc);
      const seen = next.find((t) => transitHere(t, w).seen);
      if (!next.length) return '';
      const first = next[0]!;
      const g = (t: PlanetTransit): number => t.contacts.find((c) => c.kind === 'greatest')?.jd_utc ?? t.contacts[0]!.jd_utc;
      return seen && seen !== first
        ? `Next transit: ${first.planet}, ${w.dateYear(g(first))} (not seen from here). The next one seen from here: ${seen.planet}, ${w.dateYear(g(seen))}.`
        : `Next transit: ${first.planet}, ${w.dateYear(g(first))}${seen === first ? ', seen from here' : ''}.`;
    },
    count: (n, d) => `${n} ${n === 1 ? 'transit' : 'transits'} ${words(d)}.`,
    empty: (d) => `No transit of Mercury or Venus ${words(d)} within the years computed. Mercury crosses the Sun about 13 times a century, in May or November; Venus in pairs eight years apart, more than a century between pairs.`,
    notes: () => [
      'Contacts are the planet’s disc touching the Sun’s edge (I and IV from outside, II and III from inside); the times are for your place, with the Sun’s own height. No allowance for the “black drop” that blurs contacts II and III to the eye.',
    ],
    file: {
      title: (d) => `Transits of Mercury and Venus, ${d === 'upcoming' ? 'next' : 'last'} 100 years`,
      parts: (anchor, d) => ['transits', d === 'upcoming' ? 'next-100-years' : 'last-100-years', utcDate(anchor)],
      local: true,
    },
    card: {
      selected: (u) => u.transit,
      select: (ui, id) => ui.patch({ transit: id }),
      empty: 'Choose a transit to see its path across the Sun from your place, when it begins and ends, and how high the Sun is.',
      build: (item, all, e) => {
        const t = all.find((x) => `transit-${x.id}` === item.id);
        return t ? transitCard(t, item, e) : null;
      },
    },
  });
};

// ---------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------

const SAFETY =
  'Eye safety: never look at the Sun without a certified solar filter (ISO 12312-2 for the eye; a full-aperture filter made for the purpose on binoculars or a telescope), or project its image. Mercury is too small to see without a telescope; Venus is just visible through eclipse glasses.';

/** The planet's path across the Sun as the place sees it, north up and east to the left. */
function pathDrawing(t: PlanetTransit, zoneTime: (jd: number) => string): { el: SVGSVGElement; setNow(jd: number): void } {
  const path = t.local?.path.length ? t.local.path : t.path;
  const R = t.sun_semidiameter_arcsec;
  const pad = R * 0.2;
  const size = R + pad;
  const svg = svgEl('svg', {
    viewBox: `${-size} ${-size} ${2 * size} ${2 * size}`,
    class: 'sfe-tr__svg',
    role: 'img',
  }) as SVGSVGElement;
  svg.append(svgEl('circle', { cx: 0, cy: 0, r: R, class: 'sfe-tr__sun' }));
  const X = (east: number): number => -east;
  const Y = (north: number): number => -north;
  const d = path.map((p, i) => `${i ? 'L' : 'M'}${X(p.east_arcsec).toFixed(1)} ${Y(p.north_arcsec).toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { d, class: 'sfe-tr__path' }));
  // The planet drawn true to size, but never smaller than a visible dot.
  const r = Math.max(t.planet_semidiameter_arcsec, R * 0.018);
  const enlarged = r > t.planet_semidiameter_arcsec * 1.05;
  const contacts = t.local ? t.local.events.filter((e) => /^c[1-4]$/.test(e.kind)) : t.contacts.filter((c) => /^c[1-4]$/.test(c.kind));
  const roman: Record<string, string> = { c1: 'I', c2: 'II', c3: 'III', c4: 'IV' };
  const described: string[] = [];
  for (const c of contacts) {
    const at = transitPosition(path, c.jd_utc);
    if (!at) continue;
    svg.append(svgEl('circle', { cx: X(at.east).toFixed(1), cy: Y(at.north).toFixed(1), r: r.toFixed(1), class: 'sfe-tr__contact' }));
    // I and IV above the path, II and III below it: a small planet's contacts I and II (and
    // III and IV) are only a minute or two apart, so their labels would sit on each other.
    const outer = c.kind === 'c1' || c.kind === 'c4';
    const label = svgEl('text', {
      x: X(at.east).toFixed(1),
      y: (outer ? Y(at.north) - r - R * 0.05 : Y(at.north) + r + R * 0.14).toFixed(1),
      class: 'sfe-tr__label',
      'text-anchor': 'middle',
    });
    label.textContent = roman[c.kind] ?? '';
    svg.append(label);
    described.push(`contact ${roman[c.kind]} at ${zoneTime(c.jd_utc)}`);
  }
  const n = svgEl('text', { x: 0, y: (-R - pad * 0.45).toFixed(1), class: 'sfe-tr__compass', 'text-anchor': 'middle' });
  n.textContent = 'N';
  const e = svgEl('text', { x: (-R - pad * 0.5).toFixed(1), y: (R * 0.04).toFixed(1), class: 'sfe-tr__compass', 'text-anchor': 'middle' });
  e.textContent = 'E';
  svg.append(n, e);
  const now = svgEl('circle', { cx: 0, cy: 0, r: (r * 1.3).toFixed(1), class: 'sfe-tr__now', visibility: 'hidden' });
  svg.append(now);
  svg.setAttribute(
    'aria-label',
    `${t.planet}’s path across the Sun as seen from ${t.local ? 'your place' : 'the Earth’s centre'}, north up and east to the left: ${described.join(', ')}.${enlarged ? ` ${t.planet} is drawn larger than it is.` : ''}`,
  );
  return {
    el: svg,
    setNow(jd) {
      const at = transitPosition(path, jd);
      now.setAttribute('visibility', at ? 'visible' : 'hidden');
      if (at) {
        now.setAttribute('cx', X(at.east).toFixed(1));
        now.setAttribute('cy', Y(at.north).toFixed(1));
      }
    },
  };
}

function transitCard(t: PlanetTransit, item: EventItem, env: TabEnv): { el: HTMLElement; setNow(jd: number): void } {
  const { ctx, ui } = env;
  const s = ctx.store.get();
  const zone = displayZone(s);
  const w = screenWords(s);
  const format = s.settings.angleFormat;
  const greatest = t.contacts.find((c) => c.kind === 'greatest');
  const title = h('h3', { class: 'sfe-card__title', id: `sfe-tr-${t.id}` }, dateLong(roundToMinute(greatest?.jd_utc ?? item.start), zone));
  const kicker = h('p', { class: 'sfe-card__kicker' }, bodyGlyph(t.planet, { size: 16 }), h('span', {}, `Transit of ${t.planet}`));
  const parts: Element[] = [];
  parts.push(h('div', { class: 'sfe-summary' }, ...transitSummary(t, w).map((p) => h('p', {}, p))));
  const drawing = pathDrawing(t, (jd) => w.time(jd));
  parts.push(
    h(
      'figure',
      { class: 'sfe-tr__figure' },
      drawing.el,
      h('figcaption', { class: 'sfe-note' }, 'The Sun as it appears with north up and east to the left; the dots are the planet at contacts I to IV, the ring the time shown.'),
    ),
  );
  const events: PlanetTransitLocalEvent[] = t.local?.events ?? [];
  if (events.length) {
    const rows = events.map((ev) => {
      const n = transitEventName(ev.kind, t.planet);
      const time = h(
        'button',
        { type: 'button', class: 'sfe-time', 'aria-label': `Go to ${n.name.toLowerCase()}, ${clockSeconds(ev.jd_utc, zone)}`, 'data-tip': 'Set the explorer’s time to this moment' },
        clockSeconds(ev.jd_utc, zone),
      );
      time.addEventListener('click', () => env.jump(ev.jd_utc, { body: t.planet }));
      return h(
        'tr',
        { class: ev.visible ? '' : 'sfe-row-hidden' },
        h('th', { scope: 'row' }, h('span', { class: 'sfe-ev__name' }, n.name), n.term ? h('span', { class: 'sfe-ev__term', 'data-term': '' }, n.term) : null),
        h('td', {}, time, h('span', { class: 'sfe-utc' }, `${clockSeconds(ev.jd_utc, UTC_ZONE)} ${scaleLabel(ev.jd_utc)}`)),
        h(
          'td',
          { class: 'sf-num-r' },
          formatAngle(ev.sun_alt_deg, format, 'coarse'),
          ev.visible ? h('span', { class: 'sfe-utc' }, h('abbr', { title: compassWords(ev.sun_az_deg) }, compassPoint(ev.sun_az_deg))) : h('span', { class: 'sfe-below' }, 'below the horizon'),
        ),
      );
    });
    parts.push(
      h(
        'div',
        { class: 'sfe-contacts' },
        h(
          'table',
          { class: 'sf-table' },
          h('caption', { class: 'sfe-sr' }, `Transit of ${t.planet}: what happens at ${s.observer.label || 'your place'}, and when`),
          h(
            'thead',
            {},
            h('tr', {}, h('th', { scope: 'col' }, 'What happens'), h('th', { scope: 'col' }, `Time (${zoneShortName(item.start, zone)})`), h('th', { scope: 'col', class: 'sf-num-r' }, 'Sun’s height')),
          ),
          h('tbody', {}, ...rows),
        ),
      ),
    );
  }
  if (greatest) {
    parts.push(
      h(
        'p',
        { class: 'sfe-global' },
        `Seen from the Earth’s centre: greatest transit at ${w.dateYear(greatest.jd_utc)} ${w.time(greatest.jd_utc)} (${clockSeconds(greatest.jd_utc, UTC_ZONE).slice(0, 5)} ${scaleLabel(greatest.jd_utc)}), ${Math.round(t.min_separation_arcsec)}″ from the Sun’s centre, ${formatDuration(t.duration_s)} from first to last contact${t.grazing ? '; a grazing transit' : ''}.`,
      ),
    );
  }
  parts.push(h('p', { class: 'sfe-safety', role: 'note' }, SAFETY));
  const add = addToCalendarButton(ctx, ui, () => transitItem(t, fileWords(ctx.store.get())), `${item.title}, ${w.dateYear(item.start)}`);
  parts.push(h('div', { class: 'sfe-actions' }, add, h('span', { class: 'sfe-note' }, 'Add to a calendar')));
  const el = h(
    'article',
    { class: 'sfe-card sfe-card--transit', 'aria-labelledby': `sfe-tr-${t.id}`, 'data-transit': t.id },
    h('header', { class: 'sfe-card__head' }, kicker, title),
    ...parts,
  );
  drawing.setNow(ctx.store.get().time.jd_utc);
  return { el, setNow: drawing.setNow };
}
