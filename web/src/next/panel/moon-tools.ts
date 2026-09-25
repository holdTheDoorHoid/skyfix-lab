/**
 * The Moon card's details for astronomers (expansion programme Q8, photo agent): how big it
 * looks and how that compares with its average, which way it is tipped toward us
 * (libration) and how its axis leans (position angle), its next nearest and farthest
 * points (perigee and apogee) and the supermoon note, and the named features along the
 * shadow line (the terminator), where low sunlight shows relief best, with "See it up
 * close". Every number is the moondetail engine's (`moon_orientation`, `moon_features`,
 * `moon_apsides`), behind `isMoonDetailEngine`; an engine without it gets one sentence.
 *
 * Costs (measured with the real WebAssembly core in Node): `moon_orientation` about 1 ms,
 * `moon_features` 4 ms, `moon_apsides` 22 ms plus 1 ms a day. They are asked for a
 * quarter-hour, an hour and a fortnight at a time respectively (the memoised engine keeps
 * each answer), and while the time bar is dragged only once it settles (`Settler`).
 * The words are pure functions, tested in photo-tools.test.ts.
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import {
  isMoonDetailEngine,
  type BodyState,
  type LibrationAngles,
  type MoonApsides,
  type MoonApsis,
  type MoonFeatures,
  type MoonOrientation,
  type MoonSyzygy,
} from '../engine/types.js';
import { setTime } from '../playback.js';
import { clampToCoverage, setAttr, setText } from '../shell/derived.js';
import { dateShort, eventTime, formatDistance, relative } from '../shell/format.js';
import { displayZone, engineObserver, type ExplorerState } from '../state.js';
import { icon } from '../theme/icons.js';
import { kv } from '../theme/primitives.js';
import type { Zone } from '../time.js';
import { deltaTNote, SETTLE_MS, Settler } from './photo.js';
import { openUpClose } from '../sky/requests.js'; // sky2 agent: the Moon's close-up in the Sky view

/** The mean distance the engine compares sizes with (EXPLORER_API `moon_apsides.definitions`). */
export const MEAN_DISTANCE_KM = 384_400;
import { rangeWords } from '../time/tier.js';
import { INSTANT } from '../time/chip.js';

/** Below this total libration (degrees) the Moon faces us squarely enough to say so. */
const SQUARE_DEG = 0.75;

function pct(x: number): string {
  const a = Math.abs(x);
  return `${a < 10 ? a.toFixed(1) : Math.round(a)} %`;
}

/** `1.2 % farther than average` from a geocentric distance. */
export function distanceWords(km: number, meanKm = MEAN_DISTANCE_KM): string {
  const p = ((km - meanKm) / meanKm) * 100;
  if (Math.abs(p) < 0.05) return 'at its average distance';
  return `${pct(p)} ${p > 0 ? 'farther' : 'closer'} than average`;
}

/** `2.2 % smaller than average` from the diameter against the mean distance's. */
export function sizeWords(diameterVsMeanPercent: number): string {
  if (Math.abs(diameterVsMeanPercent) < 0.05) return 'its average size';
  return `${pct(diameterVsMeanPercent)} ${diameterVsMeanPercent > 0 ? 'larger' : 'smaller'} than average`;
}

/**
 * Which edge of the Moon is tipped toward us, in words. Libration in longitude is the east
 * (selenographic, IAU: toward Mare Crisium) longitude of the point at the disc's centre, so a
 * positive value shows more of the eastern edge; in latitude a positive value shows more of
 * the north pole (CONVENTIONS 13.12).
 */
export function librationWords(lib: Pick<LibrationAngles, 'lon_deg' | 'lat_deg'>): { sentence: string; tip: string } {
  const lon = lib.lon_deg;
  const lat = lib.lat_deg;
  const tip =
    'Libration: the Moon rocks as it orbits, so over a month we see about 59 % of its surface. ' +
    `Now the point at the centre of its face is ${Math.abs(lon).toFixed(1)}° ${lon >= 0 ? 'east' : 'west'} and ${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? 'north' : 'south'} of the Moon’s mean centre (as seen from here). ` +
    'East is the Mare Crisium side, as the IAU defines it: on the sky it is the edge toward the west.';
  if (Math.hypot(lon, lat) < SQUARE_DEG) return { sentence: 'It faces us almost squarely: little libration today.', tip };
  const parts: string[] = [];
  if (Math.abs(lon) >= 0.1) {
    parts.push(`more of its ${lon > 0 ? 'eastern edge (the Mare Crisium side)' : 'western edge (the Grimaldi side)'}, by ${Math.abs(lon).toFixed(1)}°`);
  }
  if (Math.abs(lat) >= 0.1) parts.push(`${parts.length ? 'and' : 'more'} of its ${lat > 0 ? 'north' : 'south'} pole, by ${Math.abs(lat).toFixed(1)}°`);
  return { sentence: `Tipped to show ${parts.join(', ')}.`, tip };
}

/** Libration in short, as the row's value: `4.8° W, 0.8° N` (selenographic, IAU east). */
export function librationValue(lib: Pick<LibrationAngles, 'lon_deg' | 'lat_deg'>): string {
  const lon = `${Math.abs(lib.lon_deg).toFixed(1)}° ${lib.lon_deg >= 0 ? 'E' : 'W'}`;
  const lat = `${Math.abs(lib.lat_deg).toFixed(1)}° ${lib.lat_deg >= 0 ? 'N' : 'S'}`;
  return `${lon}, ${lat}`;
}

/**
 * The Moon's axis in words: from celestial north (`axis_position_angle_deg`, P), and as it
 * looks from here with the zenith up (`north_pole_disc`, x right and y up).
 */
export function axisWords(o: Pick<MoonOrientation, 'axis_position_angle_deg' | 'north_pole_disc' | 'alt_deg'>): { value: string; tip: string } {
  const p = ((o.axis_position_angle_deg % 360) + 360) % 360;
  const fromNorth = p <= 180 ? `${Math.round(p)}° east of north` : `${Math.round(360 - p)}° west of north`;
  const np = o.north_pole_disc;
  const up = (Math.atan2(np.x, np.y) * 180) / Math.PI;
  const seen =
    o.alt_deg === null
      ? ''
      : Math.abs(up) < 2
        ? ' Seen from here its north pole points straight up.'
        : ` Seen from here its north pole points ${Math.round(Math.abs(up))}° ${up > 0 ? 'right' : 'left'} of straight up${o.alt_deg < 0 ? ' (the Moon is below the horizon now)' : ''}.`;
  return {
    value: fromNorth,
    tip: `The position angle of the Moon’s axis: ${p.toFixed(1)}°, from celestial north through east.${seen}`,
  };
}

export interface ApsisLines {
  perigee: MoonApsis | null;
  apogee: MoonApsis | null;
  /** The next full Moon in the window, with its supermoon flags. */
  full: MoonSyzygy | null;
}

/** The next perigee, apogee and full Moon after `jd`. */
export function nextApsides(a: MoonApsides, jd: number): ApsisLines {
  const next = <T extends { jd_utc: number }>(list: readonly T[], test: (x: T) => boolean): T | null =>
    list.filter((x) => x.jd_utc > jd && test(x)).sort((p, q) => p.jd_utc - q.jd_utc)[0] ?? null;
  return {
    perigee: next(a.apsides, (x) => x.kind === 'perigee'),
    apogee: next(a.apsides, (x) => x.kind === 'apogee'),
    full: next(a.syzygies, (x) => x.kind === 'full_moon'),
  };
}

/**
 * The supermoon note for the next full Moon, or null when it is an ordinary one. A full
 * Moon within a day and a half of `jd` is "this full Moon".
 */
export function supermoonNote(full: MoonSyzygy | null, jd: number, zone: Zone): string | null {
  if (!full) return null;
  const when = full.jd_utc - jd < 1.5 ? 'This full Moon' : `The full Moon of ${dateShort(full.jd_utc, zone)}`;
  const size = `${full.diameter_arcmin.toFixed(1)}′ across, ${sizeWords(full.diameter_vs_mean_percent)}`;
  const year = full.largest_of_year ? ', the largest of the year' : full.smallest_of_year ? ', the smallest of the year' : '';
  if (full.supermoon) return `${when} is a supermoon: ${size}${year}.`;
  if (full.micromoon) return `${when} is a micromoon: ${size}${year}.`;
  if (year) return `${when} is${year.slice(1)}: ${size}.`;
  return null;
}

/** How many named features to list along the terminator. */
const FEATURES_SHOWN = 6;

export interface MoonTools {
  el: HTMLElement;
  update(b: BodyState, s: ExplorerState, moving: boolean): void;
  destroy(): void;
}

/** The Moon card's rows below the phase and the distance. */
export function moonTools(ctx: Ctx): MoonTools {
  const { store, engine } = ctx;
  const sizeValue = h('span', {});
  const sizeRow = kv('eye', 'Size in the sky', sizeValue);
  const sizeWordsEl = h('span', {});
  const sizeTermEl = h('span', { 'data-term': '' });
  const sizeTerm = h('p', { class: 'sf-photo__sub' }, sizeWordsEl, sizeTermEl);
  const libValue = h('span', {});
  const libRow = kv('moon', 'Tipped toward us', libValue);
  const libWordsEl = h('span', {});
  const lib = h('p', { class: 'sf-photo__sub sf-photo-moon__lib', tabindex: 0 }, libWordsEl, h('span', { 'data-term': '' }, ' · libration'));
  const axisValue = h('span', {});
  const axisRow = kv('compass', 'Axis (north pole)', axisValue);
  const perigeeValue = h('span', {});
  const apogeeValue = h('span', {});
  const perigeeRow = kv('target', 'Nearest (perigee)', perigeeValue);
  const apogeeRow = kv('target', 'Farthest (apogee)', apogeeValue);
  const superNote = h('p', { class: 'sf-photo__note sf-photo-moon__super' });
  const featList = h('ul', { class: 'sf-photo-moon__feats', 'aria-label': 'Features along the shadow line' });
  const upClose = h('button', { type: 'button', class: 'sf-btn sf-btn--secondary sf-btn--sm' }, icon('sky'), h('span', { class: 'sf-btn__label' }, 'See it up close'));
  // sky2 agent: the Sky view's close-up of the Moon, with the features listed here marked on it.
  let shownFeatures: string[] = [];
  upClose.addEventListener('click', () => openUpClose(ctx, 'Moon', { features: shownFeatures }));
  const feats = h(
    'div',
    { class: 'sf-photo-moon__terminator' },
    h('p', { class: 'sf-photo__subhead' }, 'Along the shadow line now, where low sunlight shows relief best'),
    featList,
    upClose,
  );
  const status = h('p', { class: 'sf-photo__note', hidden: true });
  const el = h('div', { class: 'sf-photo-moon' }, status, sizeRow, sizeTerm, libRow, lib, axisRow, perigeeRow, apogeeRow, superNote, feats);

  const orientSettler = new Settler();
  const featSettler = new Settler();
  // A fortnight's apsides are tens of milliseconds: never while the time moves.
  const apsisSettler = new Settler(undefined, SETTLE_MS, Infinity);
  let apsides: MoonApsides | null = null;

  if (!isMoonDetailEngine(engine)) {
    for (const part of [sizeRow, sizeTerm, libRow, lib, axisRow, perigeeRow, apogeeRow, superNote, feats]) part.hidden = true;
    status.hidden = false;
    status.textContent = 'Libration, the Moon’s size and its nearest and farthest points are not available in this engine: rebuild the WebAssembly package.';
  }

  const fail = (what: string, error: unknown): void => {
    status.hidden = false;
    const text = error instanceof Error ? error.message : String(error);
    // An engine that answers fewer years than the explorer, in plain words (polish2).
    const years = rangeWords(text);
    setText(status, years ? `${what}: worked out only for ${years}.` : `${what}: not computed (${text}).`);
  };

  const drawOrientation = (s: ExplorerState, jd: number): void => {
    for (const r of [sizeRow, libRow, lib, axisRow]) r.removeAttribute('data-stale');
    if (!isMoonDetailEngine(engine)) return;
    let o: MoonOrientation;
    try {
      o = engine.moonOrientation(engineObserver(s), jd);
    } catch (error) {
      fail('The Moon’s orientation', error);
      return;
    }
    status.hidden = true;
    const u = s.settings.units;
    setText(sizeValue, `${o.apparent_diameter_arcmin.toFixed(1)}′`);
    setAttr(
      sizeRow,
      'data-tip',
      `How wide the Moon looks from here, in minutes of arc (60′ make a degree): ${sizeWords(o.diameter_vs_mean_percent)}, the size at its mean distance of 384 400 km being 31.1′. It is ${formatDistance(o.distance_km, u)} from you, ${formatDistance(Math.abs(o.distance_km - o.geocentric_distance_km), u)} ${o.distance_km < o.geocentric_distance_km ? 'nearer than' : 'farther than'} from the Earth’s centre: nearer when high in the sky.`,
    );
    setText(sizeWordsEl, `${sizeWords(o.diameter_vs_mean_percent).replace(/^./, (c) => c.toUpperCase())} seen from here`);
    setText(sizeTermEl, ` · apparent diameter; semi-diameter ${o.semidiameter_arcmin.toFixed(1)}′`);
    const words = librationWords(o.libration);
    setText(libValue, librationValue(o.libration));
    setText(libWordsEl, words.sentence);
    setAttr(lib, 'data-tip', words.tip);
    setAttr(libRow, 'data-tip', words.tip);
    const axis = axisWords(o);
    setText(axisValue, axis.value);
    setAttr(axisRow, 'data-tip', axis.tip);
  };

  const drawFeatures = (s: ExplorerState, jd: number): void => {
    feats.removeAttribute('data-stale');
    if (!isMoonDetailEngine(engine)) return;
    let f: MoonFeatures;
    try {
      f = engine.moonFeatures(engineObserver(s), jd);
    } catch (error) {
      feats.hidden = true;
      fail('The Moon’s named features', error);
      return;
    }
    const names = f.tonight.slice(0, FEATURES_SHOWN);
    shownFeatures = names; // sky2 agent
    feats.hidden = names.length === 0;
    featList.replaceChildren(
      ...names.map((name) => {
        const info = f.features.find((x) => x.name === name);
        const tip = info ? `${info.description} ${info.morning ? 'Sunrise' : 'Sunset'} there: the Sun ${Math.abs(info.sun_altitude_deg).toFixed(0)}° ${info.sun_altitude_deg >= 0 ? 'up' : 'down'}.` : undefined;
        return h('li', { class: 'sf-photo-moon__feat', 'data-tip': tip, tabindex: tip ? 0 : undefined }, name);
      }),
    );
    setAttr(featList, 'data-count', String(names.length));
  };

  const drawApsides = (s: ExplorerState, from: number, to: number): void => {
    for (const r of [perigeeRow, apogeeRow]) r.removeAttribute('data-stale');
    if (!isMoonDetailEngine(engine)) return;
    const span = clampToCoverage(ctx, from, to);
    try {
      apsides = span ? engine.moonApsides(span[0], span[1]) : null;
    } catch (error) {
      apsides = null;
      fail('The Moon’s perigee and apogee', error);
    }
    fillApsides(s);
  };

  /** Cheap: picks the next ones after the time shown from the fortnight's list. */
  const fillApsides = (s: ExplorerState): void => {
    const zone = displayZone(s);
    const jd = s.time.jd_utc;
    const next = apsides ? nextApsides(apsides, jd) : { perigee: null, apogee: null, full: null };
    // The ± chip's text after each time: a perigee or apogee is an instant of the Moon's own
    // motion, so it carries the whole σ(ΔT) (chip2: `INSTANT`, through deltaTNote).
    const dt = deltaTNote(ctx, jd, INSTANT);
    const line = (x: MoonApsis | null, row: HTMLElement, value: HTMLElement): void => {
      row.hidden = !x;
      if (!x) return;
      setText(value, `${dateShort(x.jd_utc, zone)} ${eventTime(x.jd_utc, zone)}${dt}`);
      setAttr(
        row,
        'data-tip',
        `${formatDistance(x.distance_km, s.settings.units)} from the Earth’s centre, ${relative(jd, x.jd_utc)}; ${x.diameter_arcmin.toFixed(1)}′ across (${sizeWords(x.diameter_vs_mean_percent)}). Press to show it.`,
      );
    };
    line(next.perigee, perigeeRow, perigeeValue);
    line(next.apogee, apogeeRow, apogeeValue);
    const note = supermoonNote(next.full, jd, zone);
    superNote.hidden = !note;
    setText(superNote, note ?? '');
    if (apsides) setAttr(superNote, 'data-tip', apsides.definitions.supermoon);
    setAttr(perigeeRow, 'data-jd', next.perigee ? String(next.perigee.jd_utc) : '');
    setAttr(apogeeRow, 'data-jd', next.apogee ? String(next.apogee.jd_utc) : '');
  };

  for (const row of [perigeeRow, apogeeRow]) {
    row.classList.add('sf-photo__press');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    const go = (): void => {
      const jd = Number(row.dataset.jd);
      if (Number.isFinite(jd) && row.dataset.jd) setTime(store, jd);
    };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  }

  return {
    el,
    update(_b, s, moving) {
      if (!isMoonDetailEngine(engine)) return;
      const jd = s.time.jd_utc;
      const place = `${s.observer.lat_deg}|${s.observer.lon_deg}|${s.observer.height_m}`;
      // A quarter of an hour: the size and the libration change by less than the digits shown.
      const q = Math.floor(jd * 96) / 96;
      orientSettler.request(`${q}|${place}`, moving, () => drawOrientation(store.get(), Math.floor(store.get().time.jd_utc * 96) / 96), () => {
        for (const r of [sizeRow, libRow, lib, axisRow]) r.setAttribute('data-stale', '');
      });
      // An hour: the terminator moves half a degree an hour on the Moon.
      const hr = Math.floor(jd * 24) / 24;
      featSettler.request(`${hr}|${place}`, moving, () => drawFeatures(store.get(), Math.floor(store.get().time.jd_utc * 24) / 24), () => feats.setAttribute('data-stale', ''));
      // A fortnight's list reaching 45 days ahead holds the next perigee, apogee and full Moon.
      const f0 = Math.floor(jd / 14) * 14;
      apsisSettler.request(`${f0}`, moving, () => drawApsides(store.get(), f0 - 1, f0 + 45), () => {
        perigeeRow.setAttribute('data-stale', '');
        apogeeRow.setAttribute('data-stale', '');
      });
      fillApsides(s);
    },
    destroy() {
      orientSettler.cancel();
      featSettler.cancel();
      apsisSettler.cancel();
    },
  };
}
