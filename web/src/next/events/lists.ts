/**
 * The Moon phases, Seasons and Planets highlights tabs of the Events view. OWNER: eclipse
 * agent; events2 agent (expansion programme Q4): the calendar buttons and Save menus, the
 * Earth's perihelion and aphelion beside the seasons, the coverage in words, the ±ΔT chip.
 *
 * Each list is built around the view's anchor (the explorer's time, see view.ts) and every
 * entry is a button that sets the explorer's time to it and selects the body concerned.
 * Engine calls: `moon_phases` for seven lunations, `seasons` and `earth_apsides` per year
 * (a year at a time, between frames), `planet_events` for a year, each cached while the
 * anchor moves within it.
 */

import { h } from '../../dom.js';
import { disposer } from '../component.js';
import {
  isEclipseEngine,
  isPlanetDetailEngine,
  isPlanetEventsEngine,
  type EarthApsisEvent,
  type Eclipse,
  type PhaseEvent,
  type PlanetEvent,
  type PlanetEventList,
  type SeasonEvent,
} from '../engine/types.js';
import { dateMedium, dateShort, eventTime, formatAngle, formatMagnitude, KM_PER_AU, monthName } from '../shell/format.js';
import { displayZone, type ExplorerState, type Units } from '../state.js';
import { roundToMinute, UTC_ZONE, wallClock, type Zone } from '../time.js';
import { scaleLabel, uncertaintyChip } from '../time/index.js';
import { bodyGlyph, phaseDisc } from '../theme/glyphs.js';
import { segmented } from '../theme/primitives.js';
import { chipsIn, coveredSentence, listUncertaintySentence, rowTimeInfo, truncatedNote, wireYear, yearText } from './deeptime.js';
import { errorText, watchAll, type TabComponent } from './env.js';
import { addToCalendarButton, exportMenu } from './export-ui.js';
import { utcDate, type EventItem } from './items.js';
import { coverageSpan } from './listtab.js';
import {
  clipSpan,
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
  YEAR_DAYS,
  type Direction,
  type PlanetRow,
  type Span,
} from './model.js';
import { earthApsisItem, phaseItem, planetEventItem, seasonItem } from './sky-model.js';

function zoneOf(s: ExplorerState): Zone {
  return displayZone(s);
}

/** A time button: the local date and time (rounded to the minute), UTC (or UT) on hover. */
function timeButton(jd: number, zone: Zone, label: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
  const r = roundToMinute(jd);
  const b = h(
    'button',
    {
      type: 'button',
      class: `sfe-when ${extraClass}`.trim(),
      'aria-label': `${label}, ${dateMedium(r, zone)} ${eventTime(r, zone)}. Set the explorer’s time to it.`,
      'data-tip': `${dateMedium(r, UTC_ZONE)} ${eventTime(r, UTC_ZONE)} ${scaleLabel(r)}`,
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
  const { ctx, ui } = env;
  const d = disposer();
  const summary = h('p', { class: 'sfe-lead' });
  const table = h('div', { class: 'sfe-moon' });
  // The file holds the next twelve months of phases from the list's anchor.
  const save = exportMenu(ctx, ui, {
    title: () => 'Moon phases, next 12 months',
    fileParts: () => ['moon-phases', utcDate(ui.get().anchor)],
    items: () => {
      const a = ui.get().anchor;
      const inside = clipSpan({ start: a, end: a + YEAR_DAYS }, coverage);
      return inside ? ctx.engine.moonPhases(inside.start, inside.end).map((p) => phaseItem(p)) : [];
    },
    local: false,
  });
  d.add(() => save.destroy());
  const root = h('div', { class: 'sfe-tabbody' }, h('div', { class: 'sfe-controls sfe-controls--end' }, save.el), summary, table);
  host.append(root);
  d.add(() => root.remove());

  // The engine refuses a window that runs past its coverage: ask only for the part inside.
  let coverage: Span = coverageSpan(env) ?? { start: -Infinity, end: Infinity };
  const phases = new SpanCache((s) => {
    const inside = clipSpan(s, coverage);
    return inside ? ctx.engine.moonPhases(inside.start, inside.end) : [];
  }, 30);
  const eclipses = isEclipseEngine(ctx.engine)
    ? new SpanCache((s) => {
        const inside = clipSpan(s, coverage);
        return inside && isEclipseEngine(ctx.engine) ? ctx.engine.eclipses(inside.start, inside.end).eclipses : [];
      }, 30)
    : null;
  let builtKey = '';
  let cells: { jd: number; el: HTMLButtonElement }[] = [];

  const render = (anchor: number): void => {
    const s = ctx.store.get();
    const zone = zoneOf(s);
    const cov = coverageSpan(env);
    if (cov && (cov.start !== coverage.start || cov.end !== coverage.end)) {
      // A data pack widened the coverage: ask again.
      coverage = cov;
      phases.clear();
      eclipses?.clear();
      builtKey = '';
    }
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
    const all = months.flatMap((m) => m.phases);
    const chips = all.length ? chipsIn(ctx.engine, all[0]!.jd_utc, all[all.length - 1]!.jd_utc) : false;
    const key = [JSON.stringify(zone), south, chips, s.settings.hourCycle, ...months.map((m) => m.start.jd_utc)].join('|');
    if (key !== builtKey) {
      builtKey = key;
      cells = [];
      if (!months.length) {
        table.replaceChildren(message(`No Moon phases here: ${coveredSentence(ctx.engine, 'Moon phases')}.`));
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
            const add = addToCalendarButton(ctx, ui, () => phaseItem(p), `${PHASE_NAMES[k]}, ${dateMedium(roundToMinute(p.jd_utc), zone)}`);
            return h(
              'td',
              {},
              h('span', { class: 'sfe-cell' }, b, uncertaintyChip(rowTimeInfo(ctx.engine, p.jd_utc, chips)), add),
              chip,
            );
          });
          const w = wallClock(roundToMinute(m.start.jd_utc), zone);
          return h('tr', {}, h('th', { scope: 'row', class: 'sfe-month' }, `${monthName(w.month).slice(0, 3)} ${yearText(w.year)}`), ...tds);
        });
        const unc = chips ? listUncertaintySentence(ctx.engine, all.map((p) => p.jd_utc)) : '';
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
          ...(unc ? [h('p', { class: 'sfe-note sfe-note--dt' }, unc)] : []),
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
// Equinoxes, solstices, and the Earth's perihelion and aphelion
// ---------------------------------------------------------------------------

type YearRow = { seasons: SeasonEvent[]; apsides: EarthApsisEvent[] } | string;

export const seasonsTab: TabComponent = (host, env) => {
  const { ctx, ui } = env;
  const d = disposer();
  const lead = h('div', { class: 'sfe-season-next' });
  const table = h('div', { class: 'sfe-seasons' });
  const status = h('p', { class: 'sfe-status', role: 'status', 'aria-live': 'polite' });
  const apsidesEngine = isPlanetDetailEngine(ctx.engine) ? ctx.engine : null;
  let shownYears: number[] = [];

  /** Everything in the years listed, for files. */
  const itemsOf = (): EventItem[] => {
    const lat = ctx.store.get().observer.lat_deg;
    const out: EventItem[] = [];
    for (const y of shownYears) {
      const v = years.get(y);
      if (!v || typeof v === 'string') continue;
      for (const e of v.seasons) out.push(seasonItem(e, lat));
      for (const a of v.apsides) out.push(earthApsisItem(a, v.apsides.find((b) => b !== a) ?? null));
    }
    return out.sort((a, b) => a.start - b.start);
  };
  const save = exportMenu(ctx, ui, {
    title: () => `Equinoxes, solstices, perihelion and aphelion, ${shownYears.length ? `${yearText(shownYears[0]!)} to ${yearText(shownYears[shownYears.length - 1]!)}` : ''}`,
    fileParts: () => ['seasons', shownYears[0] ?? '', shownYears[shownYears.length - 1] ?? ''],
    items: () => itemsOf(),
    local: false,
  });
  d.add(() => save.destroy());
  const root = h('div', { class: 'sfe-tabbody' }, h('div', { class: 'sfe-controls sfe-controls--end' }, save.el), lead, status, table);
  host.append(root);
  d.add(() => root.remove());

  // A year of seasons and apsides is tens of milliseconds of WebAssembly: one year per
  // piece of work, between frames, so the tab opens at once.
  const years = new Map<number, YearRow>();
  let coverKey = '';
  const yearOf = (y: number): YearRow | undefined => years.get(y);
  const computeYear = (y: number): void => {
    let v: YearRow;
    try {
      const seasons = ctx.engine.seasons(y);
      let apsides: EarthApsisEvent[] = [];
      try {
        apsides = apsidesEngine ? apsidesEngine.earthApsides(y).events : [];
      } catch {
        apsides = [];
      }
      v = { seasons, apsides };
    } catch (error) {
      v = errorText(error);
    }
    years.set(y, v);
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  d.add(() => {
    if (timer !== null) clearTimeout(timer);
  });
  const fill = (): void => {
    timer = null;
    const missing = shownYears.find((y) => !years.has(y));
    if (missing === undefined) return;
    const wait = env.pace();
    if (wait > 0) {
      timer = setTimeout(fill, wait);
      return;
    }
    computeYear(missing);
    ctx.scheduler.schedule(renderNow);
    if (shownYears.some((y) => !years.has(y))) timer = setTimeout(fill, 0);
  };

  let builtKey = '';
  let cells: { e: SeasonEvent | EarthApsisEvent; el: HTMLButtonElement }[] = [];
  let lastAnchor = ui.get().anchor;

  const render = (anchor: number): void => {
    lastAnchor = anchor;
    const s = ctx.store.get();
    const zone = zoneOf(s);
    const cov = coverageSpan(env);
    const ck = cov ? `${cov.start}|${cov.end}` : '';
    if (ck !== coverKey) {
      coverKey = ck;
      years.clear();
      builtKey = '';
    }
    const year = wireYear(anchor);
    const ys: number[] = [];
    for (let y = year - 1; y <= year + SEASON_YEARS_AHEAD; y++) ys.push(y);
    shownYears = ys;
    // The anchor's own year at once, so the lead is right from the first frame.
    if (!years.has(year)) computeYear(year);
    if (ys.some((y) => !years.has(y)) && timer === null) timer = setTimeout(fill, 0);
    const done = ys.filter((y) => years.has(y)).length;
    const statusText = done < ys.length ? `Computing the seasons… ${done} of ${ys.length} years` : '';
    if (status.textContent !== statusText) status.textContent = statusText;
    const all: number[] = [];
    for (const y of ys) {
      const v = yearOf(y);
      if (v && typeof v !== 'string') all.push(...v.seasons.map((e) => e.jd_utc));
    }
    const chips = all.length ? chipsIn(ctx.engine, Math.min(...all), Math.max(...all)) : false;
    const key = [JSON.stringify(zone), chips, s.settings.hourCycle, ...ys.map((y) => `${y}:${years.has(y) ? 1 : 0}`)].join('|');
    if (key !== builtKey) {
      builtKey = key;
      cells = [];
      const cellOf = (e: SeasonEvent | EarthApsisEvent, label: string, body: string, item: () => EventItem): HTMLElement => {
        const b = timeButton(e.jd_utc, zone, label, () => env.jump(e.jd_utc, { body }));
        cells.push({ e, el: b });
        return h(
          'td',
          {},
          h('span', { class: 'sfe-cell' }, b, uncertaintyChip(rowTimeInfo(ctx.engine, e.jd_utc, chips)), addToCalendarButton(ctx, ui, item, `${label}, ${dateMedium(roundToMinute(e.jd_utc), zone)}`)),
        );
      };
      const rows = ys.map((y) => {
        const v = yearOf(y);
        const yearCell = h('th', { scope: 'row' }, yearText(y));
        if (v === undefined) return h('tr', {}, yearCell, h('td', { colspan: 6, class: 'sfe-muted' }, 'Computing…'));
        if (typeof v === 'string') {
          return h('tr', {}, yearCell, h('td', { colspan: 6, class: 'sfe-muted' }, `Not computed for this year: ${coveredSentence(ctx.engine, 'Seasons')}.`));
        }
        const peri = v.apsides.find((a) => a.kind === 'perihelion') ?? null;
        const aph = v.apsides.find((a) => a.kind === 'aphelion') ?? null;
        const apsisCell = (a: EarthApsisEvent | null, other: EarthApsisEvent | null): HTMLElement =>
          a
            ? cellOf(a, a.kind === 'perihelion' ? 'Earth closest to the Sun (perihelion)' : 'Earth farthest from the Sun (aphelion)', 'Sun', () => earthApsisItem(a, other))
            : h('td', { class: 'sfe-muted' }, '—');
        return h(
          'tr',
          {},
          yearCell,
          ...SEASON_ORDER.map((k) => {
            const e = v.seasons.find((x) => x.kind === k);
            if (!e) return h('td', { class: 'sfe-muted' }, '—');
            return cellOf(e, SEASON_NAMES[k], 'Sun', () => seasonItem(e, ctx.store.get().observer.lat_deg));
          }),
          apsisCell(peri, aph),
          apsisCell(aph, peri),
        );
      });
      const unc = chips ? listUncertaintySentence(ctx.engine, all) : '';
      const notes: HTMLElement[] = [
        h(
          'p',
          { class: 'sfe-note' },
          'Perihelion and aphelion: the Earth nearest to and farthest from the Sun, about 3% apart in distance. The seasons come from the tilt of the Earth’s axis, not from this: perihelion falls in the northern winter.',
        ),
      ];
      if (unc) notes.push(h('p', { class: 'sfe-note sfe-note--dt' }, unc));
      table.replaceChildren(
        h(
          'div',
          { class: 'sfe-scroll' },
          h(
            'table',
            { class: 'sf-table sfe-season-table' },
            h('caption', { class: 'sfe-sr' }, 'Equinoxes, solstices, perihelion and aphelion by year'),
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', { scope: 'col' }, 'Year'),
                ...SEASON_ORDER.map((k) => h('th', { scope: 'col' }, SEASON_NAMES[k])),
                h('th', { scope: 'col' }, 'Closest to the Sun', h('span', { class: 'sfe-ev__term', 'data-term': '' }, 'perihelion')),
                h('th', { scope: 'col' }, 'Farthest from the Sun', h('span', { class: 'sfe-ev__term', 'data-term': '' }, 'aphelion')),
              ),
            ),
            h('tbody', {}, ...rows),
          ),
        ),
        ...notes,
      );
      save.refresh();
    }
    const now = s.time.jd_utc;
    const next = nextAfter(cells.map((c) => ({ jd_utc: c.e.jd_utc, c })), now);
    for (const c of cells) c.el.classList.toggle('sfe-when--next', c === next?.c);
    const e = next?.c.e;
    if (e) {
      const r = roundToMinute(e.jd_utc);
      if ('distance_au' in e) {
        const other = (yearOf(wireYear(e.jd_utc)) as { apsides: EarthApsisEvent[] } | undefined)?.apsides.find((a) => a !== e) ?? null;
        const item = earthApsisItem(e, other);
        lead.replaceChildren(
          h('p', { class: 'sfe-lead' }, `Next: ${item.title.toLowerCase().replace(/^earth/, 'the Earth')}, ${dateMedium(r, zone)} at ${eventTime(r, zone)}.`),
          h('p', { class: 'sfe-words' }, item.sentence),
        );
      } else {
        lead.replaceChildren(
          h('p', { class: 'sfe-lead' }, `Next: the ${SEASON_NAMES[e.kind]}, ${dateMedium(r, zone)} at ${eventTime(r, zone)}.`),
          h('p', { class: 'sfe-words' }, seasonWords(e.kind, s.observer.lat_deg)),
        );
      }
    } else lead.replaceChildren();
  };
  const renderNow = (): void => render(lastAnchor);

  d.add(
    watchAll(
      env,
      (s, u) => [u.anchor, s.time.jd_utc, s.settings.timeDisplay, s.observer.zone, s.observer.lat_deg < 0] as const,
      ([anchor]) => render(anchor),
    ),
  );
  d.add(() => ctx.scheduler.cancel(renderNow));
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
  let rowsNow: PlanetRow[] = [];
  const wordsFor = (s: ExplorerState) => {
    const zone = zoneOf(s);
    const format = s.settings.angleFormat;
    return {
      angle: (deg: number) => formatAngle(deg, format, 'coarse'),
      magnitude: (m: number | null) => formatMagnitude(m),
      distance: (km: number) => bigDistance(km, s.settings.units),
      date: (jd: number) => dateShort(roundToMinute(jd), zone),
    };
  };
  const save = exportMenu(ctx, ui, {
    title: () => `Planet events, ${ui.get().planetDirection === 'upcoming' ? 'next' : 'last'} 12 months`,
    fileParts: () => ['planet-events', ui.get().planetDirection === 'upcoming' ? 'next-12-months' : 'last-12-months', utcDate(ui.get().anchor)],
    items: () => rowsNow.map((r) => planetEventItem(r, wordsFor(ctx.store.get()))),
    local: false,
  });
  d.add(() => save.destroy());
  root.append(h('div', { class: 'sfe-controls' }, direction.el, save.el), status, list);

  const caches: Record<Direction, SpanCache<PlanetEventList>> = {
    upcoming: new SpanCache((s) => engine.planetEvents(s.start, s.end), 45),
    past: new SpanCache((s) => engine.planetEvents(s.start, s.end), 45),
  };
  let coverKey = '';
  let builtKey = '';
  let items: { row: PlanetRow; el: HTMLElement }[] = [];

  const render = (anchor: number, dir: Direction): void => {
    const s = ctx.store.get();
    const zone = zoneOf(s);
    const format = s.settings.angleFormat;
    const cov = coverageSpan(env);
    const ck = cov ? `${cov.start}|${cov.end}` : '';
    if (ck !== coverKey) {
      coverKey = ck;
      caches.upcoming.clear();
      caches.past.clear();
      builtKey = '';
    }
    let rowsData: PlanetRow[];
    let truncated = false;
    const need = neededSpan(anchor, dir, PLANET_HORIZON_DAYS, 12);
    try {
      const all = caches[dir].get(need);
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
    rowsNow = rowsData;
    direction.set(dir);
    const chips = rowsData.length ? chipsIn(ctx.engine, rowsData[0]!.event.jd_utc, rowsData[rowsData.length - 1]!.event.jd_utc) : false;
    const key = [dir, JSON.stringify(zone), format, s.settings.units, s.settings.hourCycle, chips, ...rowsData.map((r) => `${r.event.body}${r.event.kind}${r.event.jd_utc}`)].join('|');
    if (key !== builtKey) {
      builtKey = key;
      const w = wordsFor(s);
      items = rowsData.map((row) => {
        const e = row.event;
        const title = planetEventTitle(e);
        const words = e.transit
          ? `It passes between the Earth and the Sun and crosses the Sun’s face. What your place sees of it is in Planets → Transits.${row.approach ? ` Closest to the Earth on ${w.date(row.approach.jd_utc)}: ${w.distance(row.approach.distance_km)}.` : ''}`
          : planetEventWords(e, w, row.approach);
        const el = h(
          'li',
          { class: `sfe-pe${e.transit ? ' sfe-pe--transit' : ''}`, 'data-kind': e.kind, 'data-body': e.body },
          h('span', { class: 'sfe-pe__when' }, timeButton(e.jd_utc, zone, title, () => env.jump(e.jd_utc, { body: e.body })), uncertaintyChip(rowTimeInfo(ctx.engine, e.jd_utc, chips))),
          h('span', { class: 'sfe-pe__glyph' }, bodyGlyph(e.body, { size: 22 })),
          h(
            'div',
            { class: 'sfe-pe__main' },
            h('span', { class: 'sfe-pe__title' }, title, e.transit ? h('span', { class: 'sfe-pe__kind' }, KIND_WORD[e.kind]) : null),
            h('span', { class: 'sfe-pe__words' }, words),
            e.transit ? transitLink(env) : null,
          ),
          h('span', { class: 'sfe-ev2__add' }, addToCalendarButton(ctx, ui, () => planetEventItem(row, wordsFor(ctx.store.get())), `${title}, ${dateMedium(roundToMinute(e.jd_utc), zone)}`)),
        );
        return { row, el };
      });
      const notes: HTMLElement[] = [];
      if (!items.length) notes.push(message(`No planet events in these months: ${coveredSentence(ctx.engine, 'Planet events')}.`));
      if (truncated && items.length) notes.push(truncatedNote(ctx, 'Planet events', dir === 'upcoming' ? need.end : need.start));
      const unc = chips ? listUncertaintySentence(ctx.engine, rowsData.map((r) => r.event.jd_utc)) : '';
      if (unc) notes.push(h('p', { class: 'sfe-note sfe-note--dt' }, unc));
      list.replaceChildren(h('ol', { class: 'sfe-pe-list' }, ...items.map((i) => i.el)), ...notes);
      status.textContent = items.length
        ? `${items.length} events ${dir === 'upcoming' ? 'in the next 12 months' : 'in the last 12 months'}. Each is geocentric: the same for everyone.`
        : '';
      save.refresh();
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

/** A link from a transit in the highlights to the Transits list. */
function transitLink(env: Parameters<TabComponent>[1]): HTMLElement {
  const b = h('button', { type: 'button', class: 'sfe-link' }, 'See it from your place');
  b.addEventListener('click', () => env.ui.patch({ planetSub: 'transits' }));
  return b;
}
