/**
 * The Eclipses tab of the Events view: the list (upcoming or past, solar or lunar, "seen
 * from here") and the card of the chosen eclipse — what the place sees, as a timeline of
 * the contacts with the Sun's or Moon's height at each, the magnitude and obscuration, a
 * plain-language account, and the eclipse on the map. OWNER: eclipse agent.
 *
 * Engine calls: `eclipses` for ten years at a time (cached while the anchor moves), then
 * `eclipse_local` for each listed eclipse in the background, a few per frame, so the list
 * appears at once and learns what can be seen from here as it goes; `eclipse_path` only
 * when the eclipse is put on the map.
 */

import { h } from '../../dom.js';
import { disposer, observerKey } from '../component.js';
import {
  isEclipseEngine,
  type Eclipse,
  type EclipseEngine,
  type EclipseLocal,
  type EclipseLocalEvent,
  type LunarEclipse,
  type LunarEclipseLocal,
  type Observer,
  type SolarEclipse,
} from '../engine/types.js';
import { mapServiceFor } from '../map/overlays.js';
import {
  clockSeconds,
  compassPoint,
  compassWords,
  dateLong,
  dateMedium,
  dateShort,
  eventTime,
  formatAngle,
  formatLat,
  formatLon,
  otherDay,
} from '../shell/format.js';
import { displayZone, engineObserver, type AngleFormat, type ExplorerState } from '../state.js';
import { jdFromIso, roundToMinute, UTC_ZONE, zoneShortName, type Zone } from '../time.js';
import { scaleLabel, uncertaintyChip } from '../time/index.js';
import { bodyGlyph } from '../theme/glyphs.js';
import { button, readout, segmented, switchRow } from '../theme/primitives.js';
import { calendarNote, chipsIn, coveredSentence, listUncertaintySentence, rowTimeInfo, truncatedNote, wireYear, yearText } from './deeptime.js';
import { errorText, watchAll, type EclipseYears, type TabComponent, type TabEnv } from './env.js';
import { addToCalendarButton, exportMenu } from './export-ui.js';
import { fileWords, utcDate } from './items.js';
import { coverageKey, coverageSpan } from './listtab.js';
import { progressText, type SearchState } from './search.js';
import { eclipseItem } from './sky-model.js';
import { clearEclipse, eclipseOnMap, lunarOverlays, showEclipse, solarOverlays } from './mapping.js';
import {
  centralPhase,
  eclipsesAround,
  eclipseTitle,
  eclipseTypeWords,
  eventOf,
  formatDuration,
  formatEclipseMagnitude,
  formatPercent,
  hereLabel,
  inProgress,
  localEventName,
  lunarSummary,
  neededSpan,
  seenHere,
  solarSummary,
  paddedSpan,
  YEAR_DAYS,
  type Direction,
  type EclipseKindFilter,
  type Words,
} from './model.js';

/** Background work per slice, milliseconds (one `eclipse_local` is 3-5 ms in WebAssembly). */
const SLICE_MS = 12;
/** The eclipse search's piece: ten years (about 0.1 s of WebAssembly). */
const ECLIPSE_CHUNK_DAYS = 10 * YEAR_DAYS;
/** Rows drawn at a time. */
const ROWS_PER_PAGE = 120;
/** Below this width the card opens inside the list, under its row. */
const INLINE_CARD_PX = 820;

/**
 * An eclipse by id: `2024-04-08-solar` names the UTC date of greatest eclipse; outside the
 * years 0000-9999 the date has an ISO expanded year (`-0584-05-28-lunar`, the wire's form).
 */
export function eclipseIdDate(id: string): number | null {
  const m = /^([+-]\d{4,6}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2})-(solar|lunar)$/.exec(id);
  return m ? jdFromIso(`${m[1]}T00:00:00Z`) : null;
}

function bodyOf(e: Eclipse): 'Sun' | 'Moon' {
  return e.kind === 'solar' ? 'Sun' : 'Moon';
}

/** Where a click on the eclipse takes the explorer's time: the most the place sees of it, else greatest eclipse. */
export function jumpTarget(e: Eclipse, local: EclipseLocal | null): number {
  if (local && seenHere(local)) {
    if (local.kind === 'solar' && local.visible_max) return local.visible_max.jd_utc;
    if (local.kind === 'lunar') {
      const max = eventOf(local, 'max');
      if (max?.visible) return max.jd_utc;
      const firstSeen = local.events.find((ev) => ev.visible);
      if (firstSeen) return firstSeen.jd_utc;
    }
  }
  return e.greatest.jd_utc;
}

interface Settings {
  zone: Zone;
  format: AngleFormat;
  place: string;
}

function settingsOf(s: ExplorerState): Settings {
  return { zone: displayZone(s), format: s.settings.angleFormat, place: s.observer.label || 'your place' };
}

function words(st: Settings): Words {
  return {
    // The place's label can be anything ("near Philadelphia, Pennsylvania, United States",
    // "At sea, 32 NM SE of …"), so the sentences say "your place"; the card names it above them.
    place: 'your place',
    time: (jd) => eventTime(jd, st.zone),
    altitude: (deg) => `${Math.round(deg)}°`,
    direction: (az) => compassWords(az),
    position: (lat, lon) => `${formatLat(lat, st.format)}, ${formatLon(lon, st.format)}`,
  };
}

function isUtc(zone: Zone): boolean {
  return zone.kind === 'fixed' && zone.offsetMs === 0;
}

/** `Mon 8 Apr 2024, 13:17 CDT (18:17 UTC)`; the UTC date too when it differs; UT outside 1972-2035. */
function whenWithUtc(jd: number, zone: Zone): string {
  const r = roundToMinute(jd);
  const clock = scaleLabel(r);
  if (isUtc(zone)) return `${dateMedium(r, UTC_ZONE)}, ${eventTime(r, UTC_ZONE)} ${clock}`;
  const sameDay = dateMedium(r, zone) === dateMedium(r, UTC_ZONE);
  return `${dateMedium(r, zone)}, ${eventTime(r, zone)} ${zoneShortName(r, zone)} (${sameDay ? '' : `${dateShort(r, UTC_ZONE)} `}${eventTime(r, UTC_ZONE)} ${clock})`;
}

// ---------------------------------------------------------------------------
// The timeline strip
// ---------------------------------------------------------------------------

const SHORT: Record<string, string> = {
  c1: 'C1',
  c2: 'C2',
  max: 'Max',
  c3: 'C3',
  c4: 'C4',
  p1: 'P1',
  u1: 'U1',
  u2: 'U2',
  u3: 'U3',
  u4: 'U4',
  p4: 'P4',
  sunrise: 'Sunrise',
  sunset: 'Sunset',
  moonrise: 'Moonrise',
  moonset: 'Moonset',
};

interface Timeline {
  el: HTMLElement;
  setNow(jd: number): void;
}

/** A strip from the first local event to the last: the phases as bands, the body below the horizon hatched, the explorer's time as a line. */
function timeline(e: Eclipse, local: EclipseLocal, zone: Zone): Timeline | null {
  const events = [...local.events].sort((a, b) => a.jd_utc - b.jd_utc);
  if (events.length < 2) return null;
  const t0 = events[0]!.jd_utc;
  const t1 = events[events.length - 1]!.jd_utc;
  const span = t1 - t0;
  if (!(span > 0)) return null;
  const x = (jd: number): number => Math.min(100, Math.max(0, ((jd - t0) / span) * 100));
  const at = (kind: string): EclipseLocalEvent | null => events.find((ev) => ev.kind === kind) ?? null;

  const track = h('div', { class: 'sfe-tl__track' });
  const band = (from: EclipseLocalEvent | null, to: EclipseLocalEvent | null, cls: string, label: string): void => {
    if (!from || !to) return;
    const el = h('div', { class: `sfe-tl__band ${cls}`, title: label });
    el.style.left = `${x(from.jd_utc)}%`;
    el.style.width = `${Math.max(0.6, x(to.jd_utc) - x(from.jd_utc))}%`;
    track.append(el);
  };
  if (e.kind === 'solar') {
    band(at('c1'), at('c4'), 'sfe-tl__band--partial', 'Partial eclipse');
    const central = local.kind === 'solar' ? centralPhase(local) : null;
    band(at('c2'), at('c3'), 'sfe-tl__band--central', central === 'annular' ? 'Annular phase' : 'Totality');
  } else {
    band(at('p1'), at('p4'), 'sfe-tl__band--penumbral', 'Penumbral eclipse');
    band(at('u1'), at('u4'), 'sfe-tl__band--partial', 'Partial eclipse');
    band(at('u2'), at('u3'), 'sfe-tl__band--central', 'Total eclipse');
  }
  // Below the horizon: before a rise, after a set, or all of it.
  const rise = at(e.kind === 'solar' ? 'sunrise' : 'moonrise');
  const set = at(e.kind === 'solar' ? 'sunset' : 'moonset');
  const below = (from: number, to: number): void => {
    const el = h('div', { class: 'sfe-tl__below', title: `The ${bodyOf(e)} is below the horizon` });
    el.style.left = `${x(from)}%`;
    el.style.width = `${x(to) - x(from)}%`;
    track.append(el);
  };
  if (local.visibility === 'below_horizon') below(t0, t1);
  if (rise) below(t0, rise.jd_utc);
  if (set) below(set.jd_utc, t1);

  // Marks and labels, staggered on two rows so close events do not collide.
  const labels = h('div', { class: 'sfe-tl__labels', 'aria-hidden': 'true' });
  const axis = h('div', { class: 'sfe-tl__axis', 'aria-hidden': 'true' });
  const lastLabel = [-100, -100];
  const lastTime = [-100, -100];
  for (const ev of events) {
    const pos = x(ev.jd_utc);
    const mark = h('div', { class: `sfe-tl__mark${ev.kind === 'max' ? ' sfe-tl__mark--max' : ''}${ev.visible ? '' : ' sfe-tl__mark--hidden'}` });
    mark.style.left = `${pos}%`;
    track.append(mark);
    const row = pos - lastLabel[0]! >= 9 ? 0 : pos - lastLabel[1]! >= 9 ? 1 : -1;
    if (row >= 0) {
      const lab = h('span', { class: `sfe-tl__label sfe-tl__label--${row}` }, SHORT[ev.kind] ?? ev.kind);
      lab.style.left = `${pos}%`;
      labels.append(lab);
      lastLabel[row] = pos;
    }
    // Times under the strip for the beginning, the greatest and the end (and a rise or
    // set); the table below has all of them.
    const timed = ev === events[0] || ev === events[events.length - 1] || ev.kind === 'max' || ev.kind.endsWith('rise') || ev.kind.endsWith('set');
    const trow = !timed ? -1 : pos - lastTime[0]! >= 11 ? 0 : pos - lastTime[1]! >= 11 ? 1 : -1;
    if (trow >= 0) {
      const t = h('span', { class: `sfe-tl__time sfe-tl__time--${trow}` }, eventTime(ev.jd_utc, zone));
      t.style.left = `${pos}%`;
      axis.append(t);
      lastTime[trow] = pos;
    }
  }
  const now = h('div', { class: 'sfe-tl__now', hidden: true, title: 'The explorer’s time' });
  track.append(now);

  const describe = events
    .map((ev) => `${localEventName(ev.kind).name} ${eventTime(ev.jd_utc, zone)}${ev.visible ? '' : ' (below the horizon)'}`)
    .join(', ');
  const el = h(
    'div',
    { class: 'sfe-tl', role: 'img', 'aria-label': `Timeline: ${describe}` },
    labels,
    track,
    axis,
  );
  return {
    el,
    setNow(jd: number): void {
      const inside = jd >= t0 && jd <= t1;
      if (now.hidden === inside) now.hidden = !inside;
      if (inside) {
        const left = `${x(jd).toFixed(2)}%`;
        if (now.style.left !== left) now.style.left = left;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

interface CardParts {
  el: HTMLElement;
  setNow(jd: number): void;
}

function contactsTable(
  e: Eclipse,
  local: EclipseLocal,
  st: Settings,
  jump: (jd: number) => void,
  engine: TabEnv['ctx']['engine'],
): HTMLElement {
  const body = bodyOf(e);
  const central = local.kind === 'solar' ? centralPhase(local) : null;
  const max = eventOf(local, 'max');
  const ref = max?.jd_utc ?? e.greatest.jd_utc;
  const chips = local.events.length ? chipsIn(engine, local.events[0]!.jd_utc, local.events[local.events.length - 1]!.jd_utc) : false;
  const rows = local.events.map((ev) => {
    const n = localEventName(ev.kind, central);
    const extra: string[] = [];
    if (ev.magnitude !== null) extra.push(`magnitude ${formatEclipseMagnitude(ev.magnitude)}`);
    if (ev.obscuration !== null) extra.push(`${formatPercent(ev.obscuration)} of the Sun covered`);
    const day = otherDay(ev.jd_utc, ref, st.zone);
    const time = h(
      'button',
      {
        type: 'button',
        class: 'sfe-time',
        'aria-label': `Go to ${n.name.toLowerCase()}, ${clockSeconds(ev.jd_utc, st.zone)}`,
        'data-tip': 'Set the explorer’s time to this moment',
      },
      day ? h('span', { class: 'sfe-time__day' }, `${day} `) : null,
      clockSeconds(ev.jd_utc, st.zone),
    );
    time.addEventListener('click', () => jump(ev.jd_utc));
    const alt = formatAngle(ev.alt_deg, st.format, 'coarse');
    return h(
      'tr',
      { class: ev.visible ? '' : 'sfe-row-hidden' },
      h(
        'th',
        { scope: 'row' },
        h('span', { class: 'sfe-ev__name' }, n.name),
        n.term ? h('span', { class: 'sfe-ev__term', 'data-term': '' }, n.term) : null,
        extra.length ? h('span', { class: 'sfe-ev__extra' }, extra.join(' · ')) : null,
      ),
      h(
        'td',
        {},
        time,
        uncertaintyChip(rowTimeInfo(engine, ev.jd_utc, chips)),
        h('span', { class: 'sfe-utc' }, `${clockSeconds(ev.jd_utc, UTC_ZONE)} ${scaleLabel(ev.jd_utc)}`),
      ),
      h('td', { class: 'sf-num-r' }, alt, ev.visible ? null : h('span', { class: 'sfe-below' }, 'below the horizon')),
      h('td', {}, h('abbr', { title: compassWords(ev.az_deg) }, compassPoint(ev.az_deg))),
    );
  });
  return h(
    'div',
    { class: 'sfe-contacts' },
    h(
      'table',
      { class: 'sf-table' },
      h('caption', { class: 'sfe-sr' }, `${eclipseTitle(e)}: what happens at ${st.place}, and when`),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, 'What happens'),
          h('th', { scope: 'col' }, `Time (${zoneShortName(ref, st.zone)})`),
          h('th', { scope: 'col', class: 'sf-num-r' }, `${body}’s height`),
          h('th', { scope: 'col' }, 'Direction'),
        ),
      ),
      h('tbody', {}, ...rows),
    ),
  );
}

function readoutsFor(e: Eclipse, local: EclipseLocal, st: Settings): HTMLElement | null {
  const items: HTMLElement[] = [];
  const max = eventOf(local, 'max');
  if (e.kind === 'solar' && local.kind === 'solar') {
    if (local.visibility === 'none') return null;
    const central = centralPhase(local);
    items.push(
      readout({ value: formatPercent(local.obscuration), label: 'of the Sun’s area covered at the greatest', term: 'obscuration' }),
      readout({ value: formatEclipseMagnitude(local.magnitude), label: 'of its diameter covered', term: 'magnitude' }),
      central
        ? readout({
            value: formatDuration(local.central_duration_s),
            label: central === 'total' ? 'of totality here' : 'of the ring of sunlight here',
            term: central === 'total' ? 'duration of totality' : 'duration of annularity',
          })
        : readout({ value: formatDuration(local.duration_s), label: 'from beginning to end', term: 'first to fourth contact' }),
    );
  } else if (e.kind === 'lunar') {
    items.push(
      readout({
        value: formatEclipseMagnitude(e.type === 'penumbral' ? e.penumbral_magnitude : e.umbral_magnitude),
        label: e.type === 'penumbral' ? 'of the Moon’s diameter in the faint shadow' : 'of the Moon’s diameter in the dark shadow',
        term: e.type === 'penumbral' ? 'penumbral magnitude' : 'umbral magnitude',
      }),
      readout({
        value: formatDuration(e.total_duration_s ?? e.partial_duration_s ?? e.penumbral_duration_s),
        label: e.total_duration_s !== null ? 'of totality' : e.partial_duration_s !== null ? 'of the partial eclipse' : 'of the penumbral eclipse',
        term: 'the same everywhere',
      }),
    );
  }
  if (max && seenHere(local)) {
    items.push(
      readout({
        value: formatAngle(max.alt_deg, st.format, 'coarse'),
        label: max.visible ? `${bodyOf(e)}’s height at the greatest, ${compassWords(max.az_deg)}` : `${bodyOf(e)} below the horizon at the greatest`,
        term: 'altitude',
      }),
    );
  }
  return items.length ? h('div', { class: 'sf-readouts sfe-readouts' }, ...items) : null;
}

function globalLine(e: Eclipse, st: Settings): HTMLElement {
  const g = e.greatest;
  const where = `${formatLat(g.lat_deg, st.format)}, ${formatLon(g.lon_deg, st.format)}`;
  const parts: string[] = [];
  if (e.kind === 'solar') {
    parts.push(`Greatest eclipse: ${whenWithUtc(g.jd_utc, st.zone)}, at ${where}, with the Sun ${Math.round(e.greatest.sun_alt_deg)}° up.`);
    if (e.path_width_km !== null && e.central_duration_s !== null) {
      parts.push(`There the path is ${Math.round(e.path_width_km)} km wide and the central phase lasts ${formatDuration(e.central_duration_s)}.`);
    }
    parts.push(`Magnitude ${formatEclipseMagnitude(e.magnitude)}, gamma ${e.gamma.toFixed(4).replace('-', '−')}, saros ${e.saros}.`);
  } else {
    parts.push(`Greatest eclipse: ${whenWithUtc(g.jd_utc, st.zone)}, with the Moon overhead at ${where}.`);
    parts.push(
      `Umbral magnitude ${formatEclipseMagnitude(e.umbral_magnitude)}, penumbral ${formatEclipseMagnitude(e.penumbral_magnitude)}, gamma ${e.gamma.toFixed(4).replace('-', '−')}, saros ${e.saros}.`,
    );
  }
  return h('p', { class: 'sfe-global' }, parts.join(' '));
}

function card(e: Eclipse, local: EclipseLocal | null, localError: string | null, st: Settings, env: TabEnv): CardParts {
  const body = bodyOf(e);
  const jumpHere = (jd: number): void => env.jump(jd, { body });
  const title = h('h3', { class: 'sfe-card__title', id: `sfe-card-${e.id}` }, dateLong(roundToMinute(e.greatest.jd_utc), st.zone));
  const kicker = h(
    'p',
    { class: 'sfe-card__kicker' },
    bodyGlyph(body, { size: 16 }),
    h('span', {}, eclipseTitle(e)),
  );
  const typeWords = h('p', { class: 'sfe-card__type' }, eclipseTypeWords(e));

  const parts: (HTMLElement | null)[] = [];
  let tl: Timeline | null = null;
  if (local) {
    const w = words(st);
    const sentences =
      e.kind === 'solar' && local.kind === 'solar'
        ? solarSummary(e as SolarEclipse, local, w)
        : lunarSummary(e as LunarEclipse, local as LunarEclipseLocal, w);
    parts.push(h('h4', { class: 'sfe-card__sub' }, `Seen from ${st.place}`));
    parts.push(h('div', { class: 'sfe-summary' }, ...sentences.map((t) => h('p', {}, t))));
    parts.push(readoutsFor(e, local, st));
    tl = timeline(e, local, st.zone);
    if (tl && local.events.length) {
      parts.push(h('h4', { class: 'sfe-card__sub' }, 'Timeline'));
      parts.push(tl.el);
      parts.push(contactsTable(e, local, st, jumpHere, env.ctx.engine));
      const unc = listUncertaintySentence(env.ctx.engine, local.events.map((ev) => ev.jd_utc));
      parts.push(
        h(
          'p',
          { class: 'sfe-note' },
          unc ||
            'Times to the second as computed. The Earth’s rotation is not perfectly predictable (Delta-T), so a future contact may come a few seconds earlier or later.',
        ),
      );
    }
  } else if (localError) {
    parts.push(h('p', { class: 'sfe-message', role: 'alert' }, `What ${st.place} sees could not be computed: ${localError}`));
  }

  // Greatest eclipse, globally: a place and a time.
  const goThere = button({
    label: 'Go there',
    size: 'sm',
    variant: 'ghost',
    icon: 'pin',
    tip: e.kind === 'solar' ? 'Move your place to the point of greatest eclipse, at that moment' : 'Move your place to where the Moon is overhead at greatest eclipse, at that moment',
    onClick: () => {
      const date = dateMedium(e.greatest.jd_utc, UTC_ZONE);
      env.jump(e.greatest.jd_utc, {
        body,
        observer: {
          lat_deg: Math.round(e.greatest.lat_deg * 1e4) / 1e4,
          lon_deg: Math.round(e.greatest.lon_deg * 1e4) / 1e4,
          height_m: 0,
          label: e.kind === 'solar' ? `Greatest eclipse, ${date}` : `Moon overhead, ${date}`,
        },
      });
    },
  });
  parts.push(h('div', { class: 'sfe-global-row' }, globalLine(e, st), goThere));

  // The map.
  const map = mapServiceFor(env.ctx);
  const actions = h('div', { class: 'sfe-actions' });
  const renderActions = (): void => {
    const onMap = eclipseOnMap(map) === e.id;
    const show = button({
      label: onMap ? 'Show it on the map again' : e.kind === 'solar' ? 'Show the path on the map' : 'Show where it is seen on the map',
      icon: 'map',
      size: 'sm',
      variant: 'primary',
      tip: e.kind === 'solar' ? 'The central line, the limits of the total or annular and of the partial eclipse' : 'Where the Moon is up at greatest eclipse, and its horizon at the start and the end',
      onClick: () => showOnMap(e, env),
    });
    actions.replaceChildren(show);
    if (onMap) {
      actions.append(
        button({
          label: 'Remove from the map',
          size: 'sm',
          variant: 'ghost',
          icon: 'close',
          onClick: () => {
            clearEclipse(map);
            renderActions();
          },
        }),
      );
    }
  };
  renderActions();
  parts.push(actions);
  const add = addToCalendarButton(env.ctx, env.ui, () => eclipseItem(e, local, fileWords(env.ctx.store.get())), `${eclipseTitle(e)}, ${dateMedium(roundToMinute(e.greatest.jd_utc), st.zone)}`);
  parts.push(h('div', { class: 'sfe-actions sfe-actions--add' }, add, h('span', { class: 'sfe-note' }, 'Add to a calendar')));
  if (e.kind === 'solar') {
    parts.push(
      h(
        'p',
        { class: 'sfe-safety', role: 'note' },
        'Eye safety: never look at the Sun, even when mostly covered, without certified eclipse glasses (ISO 12312-2) or a pinhole projector. Only during totality itself is it safe to look with the naked eye.',
      ),
    );
  }

  const el = h(
    'article',
    { class: 'sfe-card', 'aria-labelledby': `sfe-card-${e.id}`, 'data-eclipse': e.id },
    h('header', { class: 'sfe-card__head' }, kicker, title, typeWords),
    ...parts.filter((p): p is HTMLElement => p !== null),
  );
  return { el, setNow: (jd) => tl?.setNow(jd) };
}

/** Put the eclipse on the map, then switch to the map view (which fits it). */
function showOnMap(e: Eclipse, env: TabEnv): void {
  const engine = env.ctx.engine;
  if (!isEclipseEngine(engine)) return;
  let specs;
  try {
    const path = engine.eclipsePath(e.id);
    specs =
      path.kind === 'solar'
        ? solarOverlays(path, { greatest: `Greatest eclipse ${eventTime(e.greatest.jd_utc, UTC_ZONE)} ${scaleLabel(e.greatest.jd_utc)}` })
        : lunarOverlays(path, { overhead: `Moon overhead ${eventTime(e.greatest.jd_utc, UTC_ZONE)} ${scaleLabel(e.greatest.jd_utc)}` });
  } catch (error) {
    env.ctx.notices.push('error', `The eclipse could not be drawn: ${errorText(error)}`, { key: 'events-map' });
    return;
  }
  env.ctx.notices.dismissKey('events-map');
  const map = mapServiceFor(env.ctx);
  const fit = showEclipse(map, specs);
  if (fit) map.fitOverlay(fit, { padding: 48, maxZoom: 5 });
  // Keep a time inside the eclipse if one was chosen; otherwise show greatest eclipse.
  if (!inProgress(e, env.ctx.store.get().time.jd_utc)) env.jump(e.greatest.jd_utc, { body: bodyOf(e) });
  // Last: switching views destroys this one.
  env.ctx.store.patch({ view: 'map' });
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

interface Row {
  item: HTMLLIElement;
  button: HTMLButtonElement;
  date: HTMLElement;
  here: HTMLElement;
  now: HTMLElement;
}

type LocalResult = { ok: EclipseLocal } | { error: string };

export const eclipsesTab: TabComponent = (host, env) => {
  const { ctx, ui } = env;
  const d = disposer();
  const root = h('div', { class: 'sfe-eclipses' });
  host.append(root);
  d.add(() => root.remove());

  const engine: EclipseEngine | null = isEclipseEngine(ctx.engine) ? ctx.engine : null;
  if (!engine) {
    root.append(
      h(
        'p',
        { class: 'sfe-message', role: 'alert' },
        ctx.engine.kind === 'mock'
          ? 'The mock engine does not compute eclipses. They come from the SkyFix Lab numerical core.'
          : 'This build of the numerical core has no eclipses. Rebuild it with: npm run wasm --prefix web',
      ),
    );
    return { destroy: () => d.dispose() };
  }

  // --- Controls ------------------------------------------------------------------------
  const u0 = ui.get();
  const direction = segmented<Direction>({
    label: 'Which eclipses',
    size: 'sm',
    value: u0.eclipseDirection,
    options: [
      { value: 'upcoming', label: 'Upcoming', tip: 'From the explorer’s time on' },
      { value: 'past', label: 'Past', tip: 'Before the explorer’s time' },
    ],
    onChange: (v) => ui.patch({ eclipseDirection: v }),
  });
  const reach = segmented<'10' | '100' | '1000'>({
    label: 'How far',
    size: 'sm',
    value: String(u0.eclipseYears) as '10' | '100' | '1000',
    options: [
      { value: '10', label: '10 years' },
      { value: '100', label: '100', tip: 'A century: searched ten years at a time, as the list fills in' },
      { value: '1000', label: '1000', tip: 'A millennium, where the engine covers it: a few seconds, searched ten years at a time' },
    ],
    onChange: (v) => ui.patch({ eclipseYears: Number(v) as EclipseYears }),
  });
  const kind = segmented<EclipseKindFilter>({
    label: 'Kind of eclipse',
    size: 'sm',
    value: u0.eclipseKind,
    options: [
      { value: 'all', label: 'All' },
      { value: 'solar', label: 'Solar', tip: 'The Moon in front of the Sun' },
      { value: 'lunar', label: 'Lunar', tip: 'The Moon in the Earth’s shadow' },
    ],
    onChange: (v) => ui.patch({ eclipseKind: v }),
  });
  const seen = switchRow({
    label: 'Seen from here',
    checked: u0.seenOnly,
    note: 'Only eclipses you could see from your place',
    onChange: (v) => ui.patch({ seenOnly: v }),
  });
  seen.classList.add('sfe-seen');
  const status = h('p', { class: 'sfe-status', role: 'status', 'aria-live': 'polite' });
  const list = h('div', { class: 'sfe-list' });
  const aside = h('div', { class: 'sfe-cardcol' });
  // The file holds the eclipses listed, with what the place sees of each when it is known.
  const save = exportMenu(ctx, ui, {
    title: () => `Eclipses, ${ui.get().eclipseDirection === 'upcoming' ? 'next' : 'last'} ${ui.get().eclipseYears} years`,
    fileParts: () => ['eclipses', `${ui.get().eclipseDirection === 'upcoming' ? 'next' : 'last'}-${ui.get().eclipseYears}-years`, utcDate(ui.get().anchor)],
    items: (w) =>
      visibleRows().map((e) => {
        const r = localOf(e.id);
        return eclipseItem(e, r && 'ok' in r ? r.ok : null, w);
      }),
    local: true,
  });
  d.add(() => save.destroy());
  root.append(
    h('div', { class: 'sfe-controls' }, direction.el, reach.el, kind.el, seen, save.el),
    h('div', { class: 'sfe-split' }, h('div', { class: 'sfe-listcol' }, status, list), aside),
  );

  // --- Data --------------------------------------------------------------------------------
  // Ten years a piece (about 0.1 s of WebAssembly), between frames, kept per window: a
  // millennium is a hundred pieces and fills in as it goes (search.ts).
  let subscribed: object | null = null;
  let stopSub: (() => void) | null = null;
  d.add(() => stopSub?.());
  const eclipseSearch = () => {
    const search = env.shared.search<Eclipse>('eclipses', coverageKey(env), (pace) => ({
      chunkDays: ECLIPSE_CHUNK_DAYS,
      compute: (span) => engine.eclipses(span.start, span.end).eclipses,
      key: (e) => e.id,
      time: (e) => e.greatest.jd_utc,
      pace,
      coverage: () => coverageSpan(env),
    }));
    if (search !== subscribed) {
      stopSub?.();
      subscribed = search;
      stopSub = search.subscribe(() => ctx.scheduler.schedule(refresh));
    }
    return search;
  };
  const locals = new Map<string, LocalResult>();
  let localsFor = '';
  let observer: Observer = engineObserver(ctx.store.get());

  /** The eclipse for an id: from the lists, else asked of the engine around its date. */
  const found = new Map<string, Eclipse>();
  const findEclipse = (id: string): Eclipse | null => {
    const hit = found.get(id);
    if (hit) return hit;
    const jd = eclipseIdDate(id);
    if (jd === null) return null;
    try {
      const e = engine.eclipses(jd - 1, jd + 2).eclipses.find((x) => x.id === id) ?? null;
      if (e) found.set(id, e);
      return e;
    } catch {
      return null;
    }
  };

  const localOf = (id: string): LocalResult | null => locals.get(id) ?? null;
  const computeLocal = (id: string): LocalResult => {
    let r: LocalResult;
    try {
      r = { ok: engine.eclipseLocal(id, observer) };
    } catch (error) {
      r = { error: errorText(error) };
    }
    locals.set(id, r);
    return r;
  };

  // --- Background: what each listed eclipse looks like from here ---------------------------
  let job = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string[] = [];
  const stopJob = (): void => {
    job += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = [];
  };
  d.add(stopJob);
  const startJob = (ids: string[]): void => {
    stopJob();
    pending = ids.filter((id) => !locals.has(id));
    if (!pending.length) return;
    const mine = job;
    const slice = (): void => {
      timer = null;
      if (mine !== job) return;
      const t0 = performance.now();
      while (pending.length && performance.now() - t0 < SLICE_MS) computeLocal(pending.shift()!);
      paint();
      if (pending.length) timer = setTimeout(slice, 0);
      else if (searchState?.done !== false) root.dataset.local = 'done';
    };
    root.dataset.local = 'pending';
    timer = setTimeout(slice, 0);
  };

  // --- The list ------------------------------------------------------------------------------
  let shown: Eclipse[] = [];
  let truncated = false;
  let listError: string | null = null;
  let searchState: SearchState<Eclipse> | null = null;
  /** Rows drawn: a page at a time, so a millennium's list stays quick. */
  let limit = ROWS_PER_PAGE;
  let limitFor = '';
  const rows = new Map<string, Row>();
  let builtKey = '';
  let st: Settings = settingsOf(ctx.store.get());
  let narrow = false;

  const select = (e: Eclipse): void => {
    shown.forEach((x) => found.set(x.id, x));
    found.set(e.id, e);
    ui.patch({ selected: e.id });
    const r = localOf(e.id) ?? computeLocal(e.id);
    env.jump(jumpTarget(e, 'ok' in r ? r.ok : null), { body: bodyOf(e) });
    // On a narrow stage the card opens under the row: bring the row to the top.
    if (narrow) {
      ctx.scheduler.schedule(() => {
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        rows.get(e.id)?.item.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      });
    }
  };

  const buildRow = (e: Eclipse): Row => {
    const here = h('span', { class: 'sfe-row__here' });
    const now = h('span', { class: 'sfe-row__now', hidden: true }, 'Under way');
    const date = h(
      'span',
      { class: 'sfe-row__date', 'data-tip': `Greatest eclipse: ${whenWithUtc(e.greatest.jd_utc, st.zone)}` },
      dateMedium(roundToMinute(e.greatest.jd_utc), st.zone),
    );
    const b = h(
      'button',
      { type: 'button', class: 'sfe-row', 'data-eclipse': e.id, 'data-kind': e.kind, 'data-type': e.type },
      h('span', { class: 'sfe-row__glyph' }, bodyGlyph(bodyOf(e), { size: 22 })),
      h('span', { class: 'sfe-row__main' }, h('span', { class: 'sfe-row__title' }, eclipseTitle(e), now), date),
      here,
    );
    b.addEventListener('click', () => select(e));
    const item = h('li', { class: 'sfe-item' }, b);
    return { item, button: b, date, here, now };
  };

  const visibleRows = (): Eclipse[] => {
    if (!ui.get().seenOnly) return shown;
    return shown.filter((e) => {
      const r = localOf(e.id);
      return !!r && 'ok' in r && seenHere(r.ok);
    });
  };

  const buildList = (): void => {
    const all = visibleRows();
    const items = all.slice(0, limit);
    const key = [ui.get().eclipseDirection, ui.get().seenOnly, JSON.stringify(st.zone), limit, all.length, ...items.map((e) => e.id)].join('|');
    if (key === builtKey) return;
    builtKey = key;
    rows.clear();
    const groups: HTMLElement[] = [];
    let year = '';
    let ol: HTMLOListElement | null = null;
    for (const e of items) {
      const y = dateMedium(roundToMinute(e.greatest.jd_utc), st.zone).replace(/^\S+ \S+ \S+ /, '');
      if (y !== year || !ol) {
        year = y;
        ol = h('ol', { class: 'sfe-rows', 'aria-label': `Eclipses of ${y}` });
        groups.push(h('h3', { class: 'sfe-year' }, y), ol);
      }
      const row = buildRow(e);
      rows.set(e.id, row);
      ol.append(row.item);
    }
    const notes: HTMLElement[] = [];
    if (all.length > items.length) {
      const more = h(
        'button',
        { type: 'button', class: 'sf-btn sf-btn--secondary sf-btn--sm sfe-more' },
        all.length - items.length <= ROWS_PER_PAGE ? `Show the other ${all.length - items.length}` : `Show ${ROWS_PER_PAGE} more of ${all.length - items.length}`,
      );
      more.addEventListener('click', () => {
        limit += ROWS_PER_PAGE;
        paint();
      });
      notes.push(more);
    }
    if (listError) notes.push(h('p', { class: 'sfe-message', role: 'alert' }, listError));
    else if (!shown.length && searchState?.done !== false) {
      notes.push(
        h(
          'p',
          { class: 'sfe-message' },
          `No eclipses in these years. ${coveredSentence(ctx.engine, 'Eclipses')}: move the explorer’s time inside that span.`,
        ),
      );
    } else if (!items.length && !pending.length) {
      notes.push(
        h('p', { class: 'sfe-message' }, `None of these eclipses can be seen from ${st.place}. Turn off “Seen from here” to list them all.`),
      );
    }
    const cal = calendarNote(items.map((e) => e.greatest.jd_utc).slice(0, 1).concat(items.map((e) => e.greatest.jd_utc).slice(-1)), st.zone);
    if (cal) notes.push(h('p', { class: 'sfe-note' }, cal));
    if (truncated) {
      const a = ui.get().anchor;
      const days = ui.get().eclipseYears * YEAR_DAYS;
      notes.push(truncatedNote(ctx, 'Eclipses', ui.get().eclipseDirection === 'upcoming' ? a + days : a - days));
    }
    list.replaceChildren(...groups, ...notes);
    placeCard();
  };

  const paint = (): void => {
    buildList();
    const now = ctx.store.get().time.jd_utc;
    const selected = ui.get().selected;
    let seenCount = 0;
    let known = 0;
    for (const e of shown) {
      const r = localOf(e.id);
      if (r) {
        known += 1;
        if ('ok' in r && seenHere(r.ok)) seenCount += 1;
      }
    }
    for (const e of shown) {
      const row = rows.get(e.id);
      if (!row) continue;
      const r = localOf(e.id);
      const label =
        r && 'ok' in r
          ? hereLabel(e, r.ok, (jd) => eventTime(jd, st.zone))
          : r
            ? { text: 'Could not be computed here', tone: 'none' }
            : { text: 'Checking…', tone: 'pending' };
      if (row.here.textContent !== label.text) row.here.textContent = label.text;
      // The date the place sees it on (its local maximum), else that of greatest eclipse.
      const day = dateMedium(roundToMinute(r && 'ok' in r && seenHere(r.ok) ? jumpTarget(e, r.ok) : e.greatest.jd_utc), st.zone);
      if (row.date.textContent !== day) row.date.textContent = day;
      if (row.here.dataset.tone !== label.tone) row.here.dataset.tone = label.tone;
      const current = String(e.id === selected);
      if (row.button.getAttribute('aria-current') !== current) row.button.setAttribute('aria-current', current);
      const under = !inProgress(e, now);
      if (row.now.hidden !== under) row.now.hidden = under;
    }
    const years = ui.get().eclipseYears;
    const sp = searchState?.span ?? null;
    const span =
      truncated && sp
        ? `from ${yearText(wireYear(sp.start))} to ${yearText(wireYear(sp.end))} (the years computed)`
        : ui.get().eclipseDirection === 'upcoming'
          ? `in the next ${years} years`
          : `in the last ${years} years`;
    const text =
      listError
        ? ''
        : searchState && !searchState.done
          ? `${progressText(searchState, 'Searching')}${shown.length ? ` · ${shown.length} eclipses so far` : ''}`
          : !shown.length
            ? ''
            : known < shown.length
              ? `${shown.length} eclipses ${span}. Checking which can be seen from ${st.place}…`
              : `${shown.length} eclipses ${span}; ${seenCount} can be seen from ${st.place}.`;
    if (status.textContent !== text) status.textContent = text;
  };

  // --- The card --------------------------------------------------------------------------------
  let cardParts: CardParts | null = null;
  let cardEl: HTMLElement | null = null;
  let cardKey = '';
  const renderCard = (): void => {
    const id = ui.get().selected;
    const e = id ? (shown.find((x) => x.id === id) ?? findEclipse(id)) : null;
    const key = [id ?? '', localsFor, JSON.stringify(st), eclipseOnMap(mapServiceFor(ctx)) === id].join('|');
    if (key === cardKey && cardEl) {
      placeCard();
      return;
    }
    cardKey = key;
    cardEl?.remove();
    if (!e) {
      cardParts = null;
      cardEl = h(
        'div',
        { class: 'sfe-card sfe-card--empty' },
        h(
          'p',
          {},
          'Choose an eclipse to see what it looks like from your place: when it begins and ends, how much of the Sun or Moon is covered, and how high it is in the sky.',
        ),
      );
    } else {
      const r = localOf(e.id) ?? computeLocal(e.id);
      cardParts = card(e, 'ok' in r ? r.ok : null, 'error' in r ? r.error : null, st, env);
      cardEl = cardParts.el;
      cardParts.setNow(ctx.store.get().time.jd_utc);
    }
    placeCard();
  };

  /** Beside the list on a wide stage; under the selected row on a narrow one. */
  const placeCard = (): void => {
    if (!cardEl) return;
    const id = ui.get().selected;
    const row = id ? rows.get(id) : undefined;
    const inline = narrow && row !== undefined && !cardEl.classList.contains('sfe-card--empty');
    const target = inline ? row.item : aside;
    if (cardEl.parentElement !== target) target.append(cardEl);
    if (aside.hidden !== narrow) aside.hidden = narrow;
  };

  // Layout: the card moves under its row when the stage is narrow.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      const next = root.clientWidth < INLINE_CARD_PX;
      if (next === narrow) return;
      narrow = next;
      root.classList.toggle('sfe--narrow', narrow);
      placeCard();
    });
    ro.observe(root);
    d.add(() => ro.disconnect());
  }

  // --- Wiring --------------------------------------------------------------------------------
  const refresh = (): void => {
    const u = ui.get();
    update(u.anchor, u.eclipseDirection, u.eclipseKind);
  };
  d.add(() => ctx.scheduler.cancel(refresh));
  const update = (anchor: number, dir: Direction, k: EclipseKindFilter): void => {
        const s = ctx.store.get();
        const nextSettings = settingsOf(s);
        if (JSON.stringify(nextSettings) !== JSON.stringify(st)) builtKey = '';
        st = nextSettings;
        observer = engineObserver(s);
        const key = observerKey(observer);
        if (key !== localsFor) {
          locals.clear();
          localsFor = key;
          builtKey = '';
          stopJob();
        }
        const years = ui.get().eclipseYears;
        const horizon = years * YEAR_DAYS;
        const lk = [dir, years, k, ui.get().seenOnly].join('|');
        if (lk !== limitFor) {
          limitFor = lk;
          limit = ROWS_PER_PAGE;
        }
        try {
          searchState = eclipseSearch().get(paddedSpan(neededSpan(anchor, dir, horizon, 1), 120), dir === 'upcoming' ? 'forward' : 'backward');
          shown = eclipsesAround(searchState.items, anchor, dir, k, horizon);
          truncated = searchState.truncated && searchState.done;
          listError = searchState.error ? `Eclipses could not be listed: ${searchState.error}` : null;
          if (listError) ctx.notices.push('error', listError, { key: 'events-eclipses' });
          else ctx.notices.dismissKey('events-eclipses');
        } catch (error) {
          searchState = null;
          shown = [];
          truncated = false;
          listError = `Eclipses could not be listed: ${errorText(error)}`;
          ctx.notices.push('error', listError, { key: 'events-eclipses' });
        }
        root.dataset.search = searchState?.done === false ? 'searching' : 'done';
        direction.set(dir);
        reach.set(String(years) as '10' | '100' | '1000');
        kind.set(k);
        const checked = String(ui.get().seenOnly);
        if (seen.getAttribute('aria-checked') !== checked) seen.setAttribute('aria-checked', checked);
        // Only what is not known yet; a job already working through the same list goes on.
        const missing = shown.map((e) => e.id).filter((id) => !locals.has(id));
        if (missing.join() !== pending.join()) startJob(missing);
        paint();
        renderCard();
        if (!pending.length && searchState?.done !== false && root.dataset.local !== 'done') root.dataset.local = 'done';
        if (searchState?.done === false) root.dataset.local = 'pending';
  };
  d.add(
    watchAll(
      env,
      (s, u) =>
        [
          u.anchor,
          u.eclipseDirection,
          u.eclipseYears,
          u.eclipseKind,
          u.seenOnly,
          s.observer.lat_deg,
          s.observer.lon_deg,
          s.observer.height_m,
          s.observer.label,
          s.observer.zone,
          s.settings.timeDisplay,
          s.settings.angleFormat,
        ] as const,
      ([anchor, dir, , k]) => update(anchor, dir, k),
    ),
  );
  d.add(
    watchAll(
      env,
      (s, u) => [s.time.jd_utc, u.selected] as const,
      ([now]) => {
        paint();
        renderCard();
        cardParts?.setNow(now);
      },
    ),
  );
  // The map's overlays change when this card (or another view) adds or removes them.
  d.add(mapServiceFor(ctx).subscribe(() => ctx.scheduler.schedule(renderCard)));
  d.add(() => ctx.scheduler.cancel(renderCard));

  return { destroy: () => d.dispose() };
};
