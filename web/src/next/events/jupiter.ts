/**
 * The Planets → Jupiter's moons tab: the transits, shadow transits, eclipses and
 * occultations of Io, Europa, Ganymede and Callisto (`galilean_events`), night by night for
 * a week, each with whether the place can see it (Jupiter up, the sky dark) and why not.
 * OWNER: events2 agent.
 *
 * A night is local noon to local noon in the display zone. The search runs a day at a
 * time between frames; Jupiter's and the Sun's heights come from `sky_state` at each
 * start and end (remembered), the night's rise, set and darkness from `day_events_batch`.
 */

import { h } from '../../dom.js';
import { disposer } from '../component.js';
import { isPlanetDetailEngine, type DayEvents, type GalileanPhenomenon } from '../engine/types.js';
import { dateShort, eventTime } from '../shell/format.js';
import { displayZone, type ExplorerState } from '../state.js';
import { jdFromWallClock, wallClock, type Zone } from '../time.js';
import { bodyGlyph } from '../theme/glyphs.js';
import { switchRow } from '../theme/primitives.js';
import { chipsIn, rowTimeInfo, truncatedNote } from './deeptime.js';
import { errorText, watchAll, type TabComponent, type TabEnv } from './env.js';
import { addToCalendarButton, exportMenu } from './export-ui.js';
import { fileWords, screenWords, utcDate, type EventItem, type Words } from './items.js';
import { coverageKey, coverageSpan, observerOf } from './listtab.js';
import { nextAfter } from './model.js';
import { galileanId, galileanItem, galileanSeen, JUPITER_MIN_ELONGATION, type JupiterSky } from './planet-model.js';
import { eventRow, searchStatus, type Badge, type Row } from './rows.js';
import type { SearchState } from './search.js';

/** How many nights the list shows. */
export const NIGHTS = 7;

/** The local noon that starts the night an instant belongs to (the afternoon before it, before noon). */
export function nightStart(jd: number, zone: Zone): number {
  const w = wallClock(jd, zone);
  const noon = jdFromWallClock({ year: w.year, month: w.month, day: w.day, hour: 12, calendar: w.calendar }, zone);
  return w.hour < 12 ? jdFromWallClock({ year: w.year, month: w.month, day: w.day - 1, hour: 12, calendar: w.calendar }, zone) : noon;
}

/** The starts of `n` nights from the one `jd` belongs to, and the end of the last. */
export function nightStarts(jd: number, zone: Zone, n = NIGHTS): number[] {
  const out = [nightStart(jd, zone)];
  for (let k = 1; k <= n; k += 1) out.push(nightStart(out[k - 1]! + 1.25, zone));
  return out;
}

interface Night {
  start: number;
  end: number;
  events: DayEvents | null;
}

function skyAt(env: TabEnv, jd: number, cache: Map<number, JupiterSky | null>): JupiterSky | null {
  const key = Math.round(jd * 1440);
  if (cache.has(key)) return cache.get(key)!;
  let out: JupiterSky | null = null;
  try {
    const { observer } = observerOf(env.ctx.store.get());
    const st = env.ctx.engine.skyState(observer, jd, ['Jupiter', 'Sun']);
    const j = st.bodies.find((b) => b.body === 'Jupiter');
    const sun = st.bodies.find((b) => b.body === 'Sun');
    if (j && sun) out = { jupiterAlt: j.alt_apparent_deg, jupiterAz: j.az_deg, sunAlt: sun.alt_deg };
  } catch {
    out = null;
  }
  if (cache.size > 2000) cache.clear();
  cache.set(key, out);
  return out;
}

/** "Jupiter up 21:10–05:40 · dark 20:15–05:50", from the night's events. */
function nightWords(n: Night, zone: Zone): string {
  const ev = n.events;
  if (!ev) return '';
  const jup = ev.bodies.find((b) => b.body === 'Jupiter');
  const sun = ev.bodies.find((b) => b.body === 'Sun');
  const parts: string[] = [];
  if (jup) {
    if (jup.always_above) parts.push('Jupiter up all night');
    else if (jup.always_below) parts.push('Jupiter below the horizon all night');
    else {
      const rise = jup.events.find((e) => e.kind === 'rise');
      const set = jup.events.find((e) => e.kind === 'set');
      if (rise && set) parts.push(rise.jd_utc < set.jd_utc ? `Jupiter up ${eventTime(rise.jd_utc, zone)}–${eventTime(set.jd_utc, zone)}` : `Jupiter sets ${eventTime(set.jd_utc, zone)}, rises ${eventTime(rise.jd_utc, zone)}`);
      else if (rise) parts.push(`Jupiter rises ${eventTime(rise.jd_utc, zone)}`);
      else if (set) parts.push(`Jupiter sets ${eventTime(set.jd_utc, zone)}`);
    }
  }
  if (sun) {
    const dusk = sun.events.find((e) => e.kind === 'nautical_dusk');
    const dawn = sun.events.find((e) => e.kind === 'nautical_dawn');
    if (dusk && dawn) parts.push(`dark ${eventTime(dusk.jd_utc, zone)}–${eventTime(dawn.jd_utc, zone)}`);
  }
  return parts.join(' · ');
}

export const jupiterTab: TabComponent = (host, env) => {
  const { ctx, ui } = env;
  const d = disposer();
  const root = h('div', { class: 'sfe-tabbody sfe-list2 sfe-jup' });
  host.append(root);
  d.add(() => root.remove());
  const pd = isPlanetDetailEngine(ctx.engine) ? ctx.engine : null;
  if (!pd) {
    root.append(h('p', { class: 'sfe-message', role: 'alert' }, 'This build of the numerical core has no Galilean moon events. Rebuild it with: npm run wasm --prefix web'));
    return { destroy: () => d.dispose() };
  }

  const seenSwitch = switchRow({
    label: 'Seen from here',
    checked: ui.get().jupiterSeenOnly,
    note: 'Only what can be seen with Jupiter up and the sky dark',
    onChange: (v) => ui.patch({ jupiterSeenOnly: v }),
  });
  seenSwitch.classList.add('sfe-seen');
  const status = h('p', { class: 'sfe-status', role: 'status', 'aria-live': 'polite' });
  const lead = h('p', { class: 'sfe-lead sfe-lead2' });
  const listHost = h('div', { class: 'sfe-list2__rows' });
  const notes = h('div', { class: 'sfe-notes' });

  const skyCache = new Map<number, JupiterSky | null>();
  let nights: Night[] = [];
  let state: SearchState<GalileanPhenomenon> | null = null;

  const itemsFor = (w: Words, _s: ExplorerState): EventItem[] => {
    if (!state || !nights.length) return [];
    const t0 = nights[0]!.start;
    const t1 = nights[nights.length - 1]!.end;
    const seenOnly = ui.get().jupiterSeenOnly;
    return state.items
      .filter((p) => p.end.jd_utc >= t0 && p.start.jd_utc < t1)
      .map((p) => ({ p, sky: { start: skyAt(env, p.start.jd_utc, skyCache), end: skyAt(env, p.end.jd_utc, skyCache) } }))
      .filter(({ p, sky }) => !seenOnly || galileanSeen(p, sky))
      .map(({ p, sky }) => galileanItem(p, w, sky));
  };

  const save = exportMenu(ctx, ui, {
    title: () => `Jupiter’s moons, ${NIGHTS} nights`,
    fileParts: () => ['jupiter-moons', utcDate(nights[0]?.start ?? ctx.store.get().time.jd_utc)],
    items: (w) => itemsFor(w, ctx.store.get()),
    local: true,
    notes: () => [NOTE],
  });
  d.add(() => save.destroy());
  root.append(h('div', { class: 'sfe-controls' }, seenSwitch, save.el), status, lead, listHost, notes);

  let subscribed: object | null = null;
  let stopSub: (() => void) | null = null;
  d.add(() => stopSub?.());
  const searchFor = () => {
    const search = env.shared.search<GalileanPhenomenon>('galilean', coverageKey(env), (pace) => ({
      chunkDays: 1,
      compute: (span) => pd.galileanEvents(span.start, span.end).phenomena,
      key: (p) => galileanId(p),
      time: (p) => p.start.jd_utc,
      pace,
      coverage: () => coverageSpan(env),
    }));
    if (search !== subscribed) {
      stopSub?.();
      subscribed = search;
      stopSub = search.subscribe(() => ctx.scheduler.schedule(render));
    }
    return search;
  };

  let rows: { item: EventItem; row: Row }[] = [];
  let builtKey = '';
  let nightsKey = '';
  const render = (): void => {
    const s = ctx.store.get();
    const u = ui.get();
    const zone = displayZone(s);
    const starts = nightStarts(u.anchor, zone);
    const { observer, key: obsKey } = observerOf(s);
    const nk = `${starts[0]}|${obsKey}|${JSON.stringify(zone)}`;
    if (nk !== nightsKey) {
      nightsKey = nk;
      skyCache.clear();
      let batch: DayEvents[] = [];
      try {
        batch = ctx.engine.dayEventsBatch(
          observer,
          starts.slice(0, -1).map((a, i) => [a, starts[i + 1]!] as [number, number]),
          ['Sun', 'Jupiter'],
        );
      } catch {
        batch = [];
      }
      nights = starts.slice(0, -1).map((a, i) => ({ start: a, end: starts[i + 1]!, events: batch[i] ?? null }));
    }
    try {
      state = searchFor().get({ start: starts[0]!, end: starts[starts.length - 1]! });
    } catch (error) {
      listHost.replaceChildren(h('p', { class: 'sfe-message', role: 'alert' }, `Jupiter’s moons could not be computed: ${errorText(error)}`));
      builtKey = '';
      return;
    }
    const w = screenWords(s);
    const items = itemsFor(w, s);
    const chips = items.length ? chipsIn(ctx.engine, items[0]!.start, items[items.length - 1]!.start) : false;
    const key = JSON.stringify([nk, u.jupiterSeenOnly, s.settings.hourCycle, s.settings.angleFormat, chips, state.items.length, items.map((i) => i.id + i.sentence)]);
    if (key !== builtKey) {
      builtKey = key;
      rows = [];
      const groups: HTMLElement[] = [];
      nights.forEach((n, i) => {
        const mine = items.filter((it) => it.start >= n.start && it.start < n.end);
        const title = `${i === 0 ? 'Night of ' : ''}${dateShort(n.start, zone)} to ${dateShort(n.end, zone)}`;
        const detail = nightWords(n, zone);
        const ol = h('ol', { class: 'sfe-ev2-list', 'aria-label': title });
        for (const item of mine) {
          const p = state!.items.find((x) => galileanId(x) === item.id)!;
          const badges: Badge[] = [];
          if (p.jupiter_elongation_deg < JUPITER_MIN_ELONGATION) badges.push({ text: 'Too near the Sun', tone: 'muted' });
          const row = eventRow({
            item,
            zone,
            glyph: bodyGlyph('Jupiter', { size: 20 }),
            badges,
            showEnd: true,
            timeInfo: rowTimeInfo(ctx.engine, item.start, chips),
            onJump: () => env.jump(item.jump, { body: 'Jupiter' }),
            add: addToCalendarButton(ctx, ui, () => fileItem(item.id) ?? item, `${item.title}, ${w.dateYear(item.start)}`),
            dim: !galileanSeen(p, { start: skyAt(env, p.start.jd_utc, skyCache), end: skyAt(env, p.end.jd_utc, skyCache) }),
            data: { galilean: item.id },
          });
          ol.append(row.el);
          rows.push({ item, row });
        }
        groups.push(
          h('h3', { class: 'sfe-night' }, h('span', { class: 'sfe-night__date' }, title), detail ? h('span', { class: 'sfe-night__sky' }, detail) : null),
          mine.length ? ol : h('p', { class: 'sfe-note sfe-night__none' }, state!.done || state!.searched ? (u.jupiterSeenOnly ? 'Nothing to see from here this night.' : 'No events this night.') : 'Searching…'),
        );
      });
      listHost.replaceChildren(...groups);
      const noteEls: HTMLElement[] = [h('p', { class: 'sfe-note' }, NOTE)];
      if (state.truncated && state.done) noteEls.push(truncatedNote(ctx, 'Jupiter’s moons', starts[starts.length - 1]!));
      if (state.error) noteEls.push(h('p', { class: 'sfe-message', role: 'alert' }, `Jupiter’s moons could not be computed: ${state.error}`));
      notes.replaceChildren(...noteEls);
      save.refresh();
    }
    const first = nights[0];
    const leadText = first ? leadFor(first, zone) : '';
    if (lead.textContent !== leadText) lead.textContent = leadText;
    lead.hidden = !leadText;
    const text = searchStatus(state, `${items.length} ${items.length === 1 ? 'event' : 'events'} in the next ${NIGHTS} nights${u.jupiterSeenOnly ? ' that can be seen from here' : ''}.`);
    if (status.textContent !== text) status.textContent = text;
    root.dataset.state = state.done ? 'done' : 'searching';
    markNext();
  };
  const fileItem = (id: string): EventItem | null => itemsFor(fileWords(ctx.store.get()), ctx.store.get()).find((i) => i.id === id) ?? null;
  const markNext = (): void => {
    const now = ctx.store.get().time.jd_utc;
    const next = nextAfter(rows.map((r) => ({ jd_utc: r.item.start, r })), now);
    for (const r of rows) r.row.setNext(next?.r === r);
  };
  const leadFor = (n: Night, zone: Zone): string => {
    const words = nightWords(n, zone);
    return words ? `${dateShort(n.start, zone)}: ${words}.` : '';
  };

  d.add(
    watchAll(
      env,
      (s, u) => [u.anchor, u.jupiterSeenOnly, s.observer.lat_deg, s.observer.lon_deg, s.observer.height_m, s.observer.zone, s.settings.timeDisplay, s.settings.hourCycle, s.settings.angleFormat] as const,
      () => render(),
    ),
  );
  d.add(ctx.store.select((s) => s.time.jd_utc, () => ctx.scheduler.schedule(markNext)));
  d.add(() => {
    ctx.scheduler.cancel(render);
    ctx.scheduler.cancel(markNext);
  });
  return { destroy: () => d.dispose() };
};

const NOTE =
  'Times are when the Earth sees each moment (light-time included). Seen from here: Jupiter at least 5° up with the Sun at least 6° down; a telescope shows the transits and shadows, binoculars the eclipses and occultations of the brighter moons. The times are good to about half a minute (Io) to a minute and a half (Ganymede).';
