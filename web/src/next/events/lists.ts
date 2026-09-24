/**
 * The Moon phases, Seasons and Planets tabs of the Events view. OWNER: eclipse agent.
 *
 * Each list is built around the view's anchor (the explorer's time, see view.ts) and every
 * entry is a button that sets the explorer's time to it and selects the body concerned.
 * Engine calls: `moon_phases` for seven lunations, `seasons` per year, `planet_events` for
 * a year, each cached while the anchor moves within it.
 */

import { h } from '../../dom.js';
import { disposer } from '../component.js';
import {
  isEclipseEngine,
  isPlanetEventsEngine,
  type Eclipse,
  type PhaseEvent,
  type PlanetEvent,
  type PlanetEventList,
  type SeasonEvent,
} from '../engine/types.js';
import { dateMedium, dateShort, eventTime, formatAngle, formatMagnitude, KM_PER_AU, monthName } from '../shell/format.js';
import { displayZone, type ExplorerState, type Units } from '../state.js';
import { roundToMinute, UTC_ZONE, wallClock, type Zone } from '../time.js';
import { bodyGlyph, phaseDisc } from '../theme/glyphs.js';
import { segmented } from '../theme/primitives.js';
import { errorText, watchAll, type TabComponent } from './env.js';
import {
  eclipseAtPhase,
  eclipseTitle,
  LUNATIONS,
  lunations,
  lunationSpan,
  nextAfter,
  PHASE_NAMES,
  PHASE_ORDER,
  phaseLook,
  PLANET_HORIZON_DAYS,
  planetEventTitle,
  planetEventWords,
  planetRows,
  neededSpan,
  SEASON_NAMES,
  SEASON_ORDER,
  SEASON_YEARS_AHEAD,
  seasonWords,
  SpanCache,
  type Direction,
  type PlanetRow,
} from './model.js';

function zoneOf(s: ExplorerState): Zone {
  return displayZone(s);
}

/** A time button: the local date and time (rounded to the minute), UTC on hover. */
function timeButton(jd: number, zone: Zone, label: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
  const r = roundToMinute(jd);
  const b = h(
    'button',
    {
      type: 'button',
      class: `sfe-when ${extraClass}`.trim(),
      'aria-label': `${label}, ${dateMedium(r, zone)} ${eventTime(r, zone)}. Set the explorer’s time to it.`,
      'data-tip': `${dateMedium(r, UTC_ZONE)} ${eventTime(r, UTC_ZONE)} UTC`,
    },
    h('span', { class: 'sfe-when__date' }, dateShort(r, zone)),
    h('span', { class: 'sfe-when__time' }, eventTime(r, zone)),
  );
  b.addEventListener('click', onClick);
  return b;
}

function message(text: string, alert = false): HTMLElement {
  return h('p', { class: 'sfe-message', role: alert ? 'alert' : undefined }, text);
}

// ---------------------------------------------------------------------------
// Moon phases
// ---------------------------------------------------------------------------

export const moonTab: TabComponent = (host, env) => {
  const { ctx } = env;
  const d = disposer();
  const summary = h('p', { class: 'sfe-lead' });
  const table = h('div', { class: 'sfe-moon' });
  const root = h('div', { class: 'sfe-tabbody' }, summary, table);
  host.append(root);
  d.add(() => root.remove());

  const phases = new SpanCache((s) => ctx.engine.moonPhases(s.start, s.end), 30);
  const eclipses = isEclipseEngine(ctx.engine)
    ? new SpanCache((s) => (isEclipseEngine(ctx.engine) ? ctx.engine.eclipses(s.start, s.end).eclipses : []), 30)
    : null;
  let builtKey = '';
  let cells: { jd: number; el: HTMLButtonElement }[] = [];

  const render = (anchor: number): void => {
    const s = ctx.store.get();
    const zone = zoneOf(s);
    let list: PhaseEvent[];
    try {
      list = phases.get(lunationSpan(anchor));
      ctx.notices.dismissKey('events-moon');
    } catch (error) {
      const text = `Moon phases could not be computed: ${errorText(error)}`;
      ctx.notices.push('error', text, { key: 'events-moon' });
      table.replaceChildren(message(text, true));
      builtKey = '';
      return;
    }
    const months = lunations(list, anchor, LUNATIONS);
    let near: Eclipse[] = [];
    try {
      near = eclipses?.get(lunationSpan(anchor)) ?? [];
    } catch {
      near = [];
    }
    const south = s.observer.lat_deg < 0;
    const key = [JSON.stringify(zone), south, ...months.map((m) => m.start.jd_utc)].join('|');
    if (key !== builtKey) {
      builtKey = key;
      cells = [];
      if (!months.length) {
        table.replaceChildren(message('No Moon phases here: they are computed for 1990 to 2060.'));
      } else {
        const head = h(
          'tr',
          {},
          h('th', { scope: 'col' }, h('span', { class: 'sfe-sr' }, 'Lunation beginning')),
          ...PHASE_ORDER.map((k) => h('th', { scope: 'col' }, PHASE_NAMES[k])),
        );
        const rows = months.map((m) => {
          const tds = PHASE_ORDER.map((k) => {
            const p = m.phases.find((x) => x.kind === k);
            if (!p) return h('td', { class: 'sfe-muted' }, '—');
            const look = phaseLook(k);
            const disc = phaseDisc({
              illuminated: look.illuminated,
              // The lit side as seen from the observer's hemisphere: right when waxing in the north.
              limbFromUpDeg: look.waxing !== south ? 270 : 90,
              size: 22,
            });
            const b = timeButton(p.jd_utc, zone, PHASE_NAMES[k], () => env.jump(p.jd_utc, { body: 'Moon' }), 'sfe-when--phase');
            b.prepend(disc);
            cells.push({ jd: p.jd_utc, el: b });
            const ecl = eclipseAtPhase(p, near);
            const chip = ecl
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'sfe-eclipse-chip',
                    'data-tip': 'Open it in the Eclipses tab',
                    'aria-label': `${eclipseTitle(ecl)}: open it in the Eclipses tab`,
                  },
                  eclipseTitle(ecl).replace(' eclipse', ''),
                )
              : null;
            chip?.addEventListener('click', () => env.ui.patch({ tab: 'eclipses', selected: ecl!.id }));
            return h('td', {}, b, chip);
          });
          const w = wallClock(roundToMinute(m.start.jd_utc), zone);
          return h('tr', {}, h('th', { scope: 'row', class: 'sfe-month' }, `${monthName(w.month).slice(0, 3)} ${w.year}`), ...tds);
        });
        table.replaceChildren(
          h(
            'div',
            { class: 'sfe-scroll' },
            h(
              'table',
              { class: 'sf-table sfe-phases' },
              h('caption', { class: 'sfe-sr' }, 'Moon phases: each row is one lunation, from new Moon to new Moon'),
              h('thead', {}, head),
              h('tbody', {}, ...rows),
            ),
          ),
          h(
            'p',
            { class: 'sfe-note' },
            south
              ? 'Drawn as seen from the southern hemisphere: the waxing Moon is lit on the left.'
              : 'Drawn as seen from the northern hemisphere: the waxing Moon is lit on the right.',
          ),
        );
      }
    }
    // Mark the next phase after the explorer's time.
    const now = s.time.jd_utc;
    const next = nextAfter(cells.map((c) => ({ jd_utc: c.jd, c })), now);
    for (const c of cells) c.el.classList.toggle('sfe-when--next', next?.c === c);
    const upcoming = nextAfter(list, now);
    if (upcoming) {
      const r = roundToMinute(upcoming.jd_utc);
      summary.textContent = `Next: ${PHASE_NAMES[upcoming.kind]}, ${dateMedium(r, zone)} at ${eventTime(r, zone)}.`;
    } else summary.textContent = '';
  };

  d.add(
    watchAll(
      env,
      (s, u) => [u.anchor, s.time.jd_utc, s.settings.timeDisplay, s.observer.zone, s.observer.lat_deg < 0] as const,
      ([anchor]) => render(anchor),
    ),
  );
  return { destroy: () => d.dispose() };
};

// ---------------------------------------------------------------------------
// Equinoxes and solstices
// ---------------------------------------------------------------------------

export const seasonsTab: TabComponent = (host, env) => {
  const { ctx } = env;
  const d = disposer();
  const lead = h('div', { class: 'sfe-season-next' });
  const table = h('div', { class: 'sfe-seasons' });
  const root = h('div', { class: 'sfe-tabbody' }, lead, table);
  host.append(root);
  d.add(() => root.remove());

  const years = new Map<number, SeasonEvent[] | string>();
  const yearOf = (y: number): SeasonEvent[] | string => {
    let v = years.get(y);
    if (v === undefined) {
      try {
        v = ctx.engine.seasons(y);
      } catch (error) {
        v = errorText(error);
      }
      years.set(y, v);
    }
    return v;
  };
  let builtKey = '';
  let cells: { e: SeasonEvent; el: HTMLButtonElement }[] = [];

  const render = (anchor: number): void => {
    const s = ctx.store.get();
    const zone = zoneOf(s);
    const year = wallClock(anchor, UTC_ZONE).year;
    const ys: number[] = [];
    for (let y = year - 1; y <= year + SEASON_YEARS_AHEAD; y++) ys.push(y);
    const key = [JSON.stringify(zone), ...ys].join('|');
    if (key !== builtKey) {
      builtKey = key;
      cells = [];
      const rows = ys.map((y) => {
        const v = yearOf(y);
        if (typeof v === 'string') {
          return h('tr', {}, h('th', { scope: 'row' }, String(y)), h('td', { colspan: 4, class: 'sfe-muted' }, 'Not computed for this year (1990 to 2060 only)'));
        }
        return h(
          'tr',
          {},
          h('th', { scope: 'row' }, String(y)),
          ...SEASON_ORDER.map((k) => {
            const e = v.find((x) => x.kind === k);
            if (!e) return h('td', { class: 'sfe-muted' }, '—');
            const b = timeButton(e.jd_utc, zone, SEASON_NAMES[k], () => env.jump(e.jd_utc, { body: 'Sun' }));
            cells.push({ e, el: b });
            return h('td', {}, b);
          }),
        );
      });
      table.replaceChildren(
        h(
          'div',
          { class: 'sfe-scroll' },
          h(
            'table',
            { class: 'sf-table sfe-season-table' },
            h('caption', { class: 'sfe-sr' }, 'Equinoxes and solstices by year'),
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Year'), ...SEASON_ORDER.map((k) => h('th', { scope: 'col' }, SEASON_NAMES[k])))),
            h('tbody', {}, ...rows),
          ),
        ),
      );
    }
    const now = s.time.jd_utc;
    const next = nextAfter(cells.map((c) => c.e), now);
    for (const c of cells) c.el.classList.toggle('sfe-when--next', c.e === next);
    if (next) {
      const r = roundToMinute(next.jd_utc);
      lead.replaceChildren(
        h('p', { class: 'sfe-lead' }, `Next: the ${SEASON_NAMES[next.kind]}, ${dateMedium(r, zone)} at ${eventTime(r, zone)}.`),
        h('p', { class: 'sfe-words' }, seasonWords(next.kind, s.observer.lat_deg)),
      );
    } else lead.replaceChildren();
  };

  d.add(
    watchAll(
      env,
      (s, u) => [u.anchor, s.time.jd_utc, s.settings.timeDisplay, s.observer.zone, s.observer.lat_deg < 0] as const,
      ([anchor]) => render(anchor),
    ),
  );
  return { destroy: () => d.dispose() };
};

// ---------------------------------------------------------------------------
// Planets
// ---------------------------------------------------------------------------

/** `0.273 AU, 40.8 million km` (miles or nautical miles as the units say). */
export function bigDistance(km: number, units: Units): string {
  const au = km / KM_PER_AU;
  const [value, unit] = units === 'imperial' ? [km / 1.609344, 'miles'] : units === 'nautical' ? [km / 1.852, 'nautical miles'] : [km, 'km'];
  const size = value >= 1e9 ? `${(value / 1e9).toFixed(2)} billion` : `${(value / 1e6).toFixed(1)} million`;
  return `${au.toFixed(au < 10 ? 3 : 2)} AU, ${size} ${unit}`;
}

const KIND_WORD: Record<PlanetEvent['kind'], string> = {
  opposition: 'Opposition',
  conjunction: 'Conjunction',
  inferior_conjunction: 'Inferior conjunction',
  superior_conjunction: 'Superior conjunction',
  greatest_elongation_east: 'Greatest elongation east',
  greatest_elongation_west: 'Greatest elongation west',
  perigee: 'Closest approach',
};

export const planetsTab: TabComponent = (host, env) => {
  const { ctx, ui } = env;
  const d = disposer();
  const root = h('div', { class: 'sfe-tabbody' });
  host.append(root);
  d.add(() => root.remove());

  const engine = ctx.engine;
  if (!isPlanetEventsEngine(engine)) {
    root.append(
      message(
        engine.kind === 'mock'
          ? 'The mock engine does not compute planet events. They come from the SkyFix Lab numerical core.'
          : 'This build of the numerical core has no planet events. Rebuild it with: npm run wasm --prefix web',
        true,
      ),
    );
    return { destroy: () => d.dispose() };
  }

  const direction = segmented<Direction>({
    label: 'Which planet events',
    size: 'sm',
    value: ui.get().planetDirection,
    options: [
      { value: 'upcoming', label: 'Next 12 months' },
      { value: 'past', label: 'Last 12 months' },
    ],
    onChange: (v) => ui.patch({ planetDirection: v }),
  });
  const status = h('p', { class: 'sfe-status', role: 'status', 'aria-live': 'polite' });
  const list = h('div', { class: 'sfe-planets' });
  root.append(h('div', { class: 'sfe-controls' }, direction.el), status, list);

  const caches: Record<Direction, SpanCache<PlanetEventList>> = {
    upcoming: new SpanCache((s) => engine.planetEvents(s.start, s.end), 45),
    past: new SpanCache((s) => engine.planetEvents(s.start, s.end), 45),
  };
  let builtKey = '';
  let items: { row: PlanetRow; el: HTMLElement }[] = [];

  const render = (anchor: number, dir: Direction): void => {
    const s = ctx.store.get();
    const zone = zoneOf(s);
    const format = s.settings.angleFormat;
    let rowsData: PlanetRow[];
    let truncated = false;
    try {
      const all = caches[dir].get(neededSpan(anchor, dir, PLANET_HORIZON_DAYS, 12));
      truncated = all.truncated;
      rowsData = planetRows(all.events, anchor, dir);
      ctx.notices.dismissKey('events-planets');
    } catch (error) {
      const text = `Planet events could not be computed: ${errorText(error)}`;
      ctx.notices.push('error', text, { key: 'events-planets' });
      list.replaceChildren(message(text, true));
      status.textContent = '';
      builtKey = '';
      return;
    }
    direction.set(dir);
    const key = [dir, JSON.stringify(zone), format, s.settings.units, ...rowsData.map((r) => `${r.event.body}${r.event.kind}${r.event.jd_utc}`)].join('|');
    if (key !== builtKey) {
      builtKey = key;
      const w = {
        angle: (deg: number) => formatAngle(deg, format, 'coarse'),
        magnitude: (m: number | null) => formatMagnitude(m),
        distance: (km: number) => bigDistance(km, s.settings.units),
        date: (jd: number) => dateShort(roundToMinute(jd), zone),
      };
      items = rowsData.map((row) => {
        const e = row.event;
        const title = planetEventTitle(e);
        const el = h(
          'li',
          { class: `sfe-pe${e.transit ? ' sfe-pe--transit' : ''}`, 'data-kind': e.kind, 'data-body': e.body },
          timeButton(e.jd_utc, zone, title, () => env.jump(e.jd_utc, { body: e.body })),
          h('span', { class: 'sfe-pe__glyph' }, bodyGlyph(e.body, { size: 22 })),
          h(
            'div',
            { class: 'sfe-pe__main' },
            h('span', { class: 'sfe-pe__title' }, title, e.transit ? h('span', { class: 'sfe-pe__kind' }, KIND_WORD[e.kind]) : null),
            h('span', { class: 'sfe-pe__words' }, planetEventWords(e, w, row.approach)),
          ),
        );
        return { row, el };
      });
      const notes: HTMLElement[] = [];
      if (!items.length) notes.push(message('No planet events in these months: they are computed for 1990 to 2060.'));
      if (truncated && items.length) notes.push(h('p', { class: 'sfe-note' }, 'Planet events are computed for 1990 to 2060; the list stops there.'));
      list.replaceChildren(h('ol', { class: 'sfe-pe-list' }, ...items.map((i) => i.el)), ...notes);
      status.textContent = items.length
        ? `${items.length} events ${dir === 'upcoming' ? 'in the next 12 months' : 'in the last 12 months'}. Each is geocentric: the same for everyone.`
        : '';
    }
    const now = s.time.jd_utc;
    const next = nextAfter(items.map((i) => ({ jd_utc: i.row.event.jd_utc, i })), now);
    for (const i of items) i.el.classList.toggle('sfe-pe--next', next?.i === i);
  };

  d.add(
    watchAll(
      env,
      (s, u) => [u.anchor, u.planetDirection, s.time.jd_utc, s.settings.timeDisplay, s.observer.zone, s.settings.angleFormat, s.settings.units] as const,
      ([anchor, dir]) => render(anchor, dir),
    ),
  );
  return { destroy: () => d.dispose() };
};
