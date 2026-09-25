/**
 * The panel's Selected section: the chosen body's height and direction in large type (the
 * direction also on a magnetic compass), its rise, highest point and set around now
 * (colours and icons matching the map's lines), what is special about it (twilight and
 * golden and blue hour for the Sun; the phase, size, libration, perigee and apogee and the
 * features on the terminator for the Moon), its place among the stars (right ascension and
 * declination), the tools ("When is it at…?", the alignment finder, the Milky Way planner)
 * and the navigator's figures with the predicted sextant reading. OWNER: photo agent
 * (expansion programme Q8; first written by the shell-design agent).
 */

import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import { coverageGroupFor, offeredForSights } from '../engine/bodies.js';
import { isPlanetDetailEngine, type BodyInfo, type BodyState, type PhaseEvent, type PredictedSight, type SightLimb, type SkyEvent } from '../engine/types.js';
import { bodyError, bodyIn, covered, dayOf, passNow, setAttr, setText, skyNow, skySelected, sunToday } from '../shell/derived.js';
import {
  bearing3,
  compassPoint,
  compassWords,
  dateShort,
  eventTime,
  formatAngle,
  formatAzimuth,
  formatDeclination,
  formatDistance,
  formatLength,
  formatMagnitude,
  formatZn,
  lengthToMetres,
  metresToUnits,
  otherDay,
} from '../shell/format.js';
import { sunDay } from '../shell/sky.js';
import { displayZone, engineObserver, placeZone, shallowEqual, type ExplorerState } from '../state.js';
import { bodyGlyph, moonPhaseName, phaseDisc } from '../theme/glyphs.js';
import { icon } from '../theme/icons.js';
import { kv, popover, section, swatch } from '../theme/primitives.js';
import { UTC_ZONE, formatHours, wallClock, zoneShortName, type Zone } from '../time.js';
import { scaleLabel, setUncertaintyChip, sightsOffered, sightsOnlyText, timeInfoAt, uncertaintyChip, type ChipInfo } from '../time/index.js';
import { alignmentTool } from './alignment.js';
import { distanceWords, moonTools } from './moon-tools.js';
import { coordRow, lightTableView, magneticLine, milkyWayTool, Motion, outsideWords, Settler } from './photo.js';
import { shadowOf } from './sun-tools.js';
import { whenTool } from './when.js';

const WORDS: Record<string, [string, string]> = { Sun: ['Sunrise', 'Sunset'], Moon: ['Moonrise', 'Moonset'] };

/** The object whose shadow the Sun's card gives, metres, per explorer page (not stored). */
const objectHeights = new WeakMap<object, number>();

function objectHeightM(ctx: Pick<Ctx, 'store'>): number {
  return objectHeights.get(ctx.store) ?? 1;
}

function words(body: string): [string, string] {
  return WORDS[body] ?? ['Rises', 'Sets'];
}

interface Card {
  el: HTMLElement;
  title: HTMLElement;
  time: HTMLElement;
  day: HTMLElement;
  utc: HTMLElement;
  where: HTMLElement;
  /** The ±ΔT chip under the time, hidden unless the time carries an uncertainty (polish2). */
  dt: HTMLElement;
}

function card(kind: 'rise' | 'transit' | 'set'): Card {
  const title = h('span', {});
  const time = h('span', {});
  const day = h('span', { class: 'sf-evcard__day' });
  const utc = h('div', { class: 'sf-evcard__utc sf-num' });
  const where = h('div', { class: 'sf-evcard__where sf-num' });
  const dt = uncertaintyChip(null);
  const el = h(
    'div',
    { class: 'sf-evcard', 'data-kind': kind },
    h('div', { class: 'sf-evcard__head' }, icon(kind), title),
    h('div', { class: 'sf-evcard__time sf-num' }, time, day),
    h('div', { class: 'sf-evcard__dt', hidden: true }, dt),
    utc,
    where,
  );
  return { el, title, time, day, utc, where, dt };
}

function fillCard(c: Card, title: string, e: SkyEvent | null, jd: number, zone: Zone, place: Zone, where: string, tip: string, none: string, dt: ChipInfo | null = null): void {
  setText(c.title, title);
  setText(c.time, e ? eventTime(e.jd_utc, zone) : '—');
  setUncertaintyChip(c.dt, e ? dt : null);
  (c.dt.parentElement as HTMLElement).hidden = c.dt.hidden;
  setText(c.day, e ? otherDay(e.jd_utc, jd, zone) : '');
  // The second clock: UTC (UT outside 1972-2035, time-ui's scaleLabel), or the place's own
  // when UTC is already the first. Its day is named when it differs (Tokyo's 05:31 is 20:31
  // UTC the day before).
  const utcFirst = zone.kind === 'fixed' && zone.offsetMs === 0;
  const second = utcFirst ? place : UTC_ZONE;
  const secondDay = e ? otherDayOf(e.jd_utc, zone, second) : '';
  const secondName = utcFirst ? zoneShortName(e?.jd_utc ?? jd, place) : scaleLabel(e?.jd_utc ?? jd);
  setText(c.utc, e ? `${eventTime(e.jd_utc, second)} ${secondName}${secondDay ? ` ${secondDay}` : ''}` : none);
  setText(c.where, e ? where : '');
  setAttr(c.el, 'data-tip', tip);
  c.el.classList.toggle('sf-evcard--none', !e);
}

/** The weekday of an instant on `other`'s clock when it differs from its day on `zone`'s, else ''. */
function otherDayOf(jd: number, zone: Zone, other: Zone): string {
  const a = wallClock(jd + 30 / 86_400, other);
  const b = wallClock(jd + 30 / 86_400, zone);
  return a.day === b.day && a.month === b.month ? '' : (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][a.weekday] ?? '');
}

function moonStory(phases: readonly PhaseEvent[], jd: number): { waxing: boolean; age: number | null; next: PhaseEvent | null } {
  const next = phases.find((p) => p.jd_utc > jd) ?? null;
  const lastNew = [...phases].reverse().find((p) => p.kind === 'new_moon' && p.jd_utc <= jd) ?? null;
  const waxing = next ? next.kind === 'first_quarter' || next.kind === 'full_moon' : true;
  return { waxing, age: lastNew ? jd - lastNew.jd_utc : null, next };
}

const PHASE_WORDS: Record<PhaseEvent['kind'], string> = {
  new_moon: 'New Moon',
  first_quarter: 'First quarter',
  full_moon: 'Full Moon',
  last_quarter: 'Last quarter',
};

export function selectedSection(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const { store, engine } = ctx;
  const d = disposer();
  const infos: BodyInfo[] = engine.bodies();
  const coverage = engine.coverage();

  // --- head: the chooser ---------------------------------------------------------------
  const chooserLead = h('span', { class: 'sf-chooser__lead' });
  const chooserName = h('span', {});
  const chooser = h(
    'button',
    { type: 'button', class: 'sf-chip', 'data-tip': 'Choose another body: the Sun, the Moon, the planets or a navigational star' },
    chooserLead,
    chooserName,
    icon('chevron-down', { class: 'sf-chip__caret' }),
  );
  const sec = section('Selected', { class: 'sf-selected', aside: chooser });

  // --- body ----------------------------------------------------------------------------
  const status = h('p', { class: 'sf-selected__status', hidden: true });
  const altValue = h('span', { class: 'sf-num' });
  const altLabel = h('div', { class: 'sf-readout__label' }, 'Height above horizon');
  const azValue = h('span', { class: 'sf-num' });
  const azLabel = h('div', { class: 'sf-readout__label' });
  const mag = magneticLine(ctx);
  const readouts = h(
    'div',
    { class: 'sf-readouts' },
    h(
      'div',
      { class: 'sf-readout', 'data-tip': 'How high it looks above a sea-level horizon (refraction included)' },
      h('div', { class: 'sf-readout__value' }, altValue),
      altLabel,
      h('div', { class: 'sf-readout__term', 'data-term': '' }, 'altitude'),
    ),
    h(
      'div',
      { class: 'sf-readout', 'data-tip': 'Bearing from true north, clockwise: 90° east, 180° south, 270° west' },
      h('div', { class: 'sf-readout__value' }, azValue),
      azLabel,
      h('div', { class: 'sf-readout__term', 'data-term': '' }, 'azimuth, Zn'),
      // The same direction on a magnetic compass, when the geomag engine answers (photo agent).
      mag.el,
    ),
  );
  const cards = { rise: card('rise'), transit: card('transit'), set: card('set') };
  const cardRow = h('div', { class: 'sf-evcards' }, cards.rise.el, cards.transit.el, cards.set.el);
  const extras = h('div', { class: 'sf-selected__extras' });
  const magValue = h('span', {});
  const magRow = kv('eye', 'Brightness (magnitude)', magValue, {
    tip: 'Magnitude: the lower the number, the brighter. Sirius is −1.5; the faintest stars you can see are about 6.',
  });
  const sights = h('p', { class: 'sf-selected__sights' });
  const detailsGrid = h('div', { class: 'sf-details__grid' });
  // Two families of altitude (CONVENTIONS 13.2): say which is which, so nobody compares them.
  const detailsNote = h(
    'p',
    { class: 'sf-details__note' },
    'Hc and Zn are what sight-reduction tables give: seen from the Earth’s centre, with no refraction and no parallax. The height above the horizon at the top is what you would see from here; for the Moon the two differ by up to a degree.',
  );
  // What the sextant would read now (predict_sextant), for the instrument in Settings (photo agent).
  const predictValue = h('span', {});
  const predictRow = h(
    'div',
    { class: 'sf-kv sf-photo-predict__row' },
    icon('sextant'),
    h('span', { class: 'sf-kv__k' }, 'Your sextant would read'),
    h('span', { class: 'sf-kv__v' }, predictValue),
  );
  const predictNote = h('p', { class: 'sf-photo__sub' });
  const predictBox = h('div', { class: 'sf-photo-predict' }, predictRow, predictNote);
  const details = h(
    'details',
    { class: 'sf-details', 'data-term': '' },
    h('summary', {}, 'Navigator’s details', icon('chevron-down')),
    detailsGrid,
    predictBox,
    detailsNote,
  ) as HTMLDetailsElement;
  const when = whenTool(ctx);
  // Photographers' and astronomers' tools (expansion programme Q8, photo agent).
  const coords = coordRow();
  const align = alignmentTool(ctx);
  const milky = milkyWayTool(ctx);
  const light = lightTableView(ctx);
  const moon = moonTools(ctx);
  const motion = new Motion();
  /** The last render's `moving`, for the extras' own settlers. */
  let currentMoving = false;
  for (const tool of [when, align, milky, light, moon]) d.add(() => tool.destroy());
  sec.body.append(status, readouts, cardRow, extras, magRow, coords.el, sights, when.el, align.el, milky.el, details);

  // --- extras per kind, rebuilt when the body or the day changes ----------------------
  let extrasKey = '';
  /** The body state last drawn, for redrawing the extras when the object height is typed. */
  let lastBody: BodyState | null = null;
  let updateExtras: (b: BodyState, s: ExplorerState) => void = () => undefined;

  const buildSunExtras = (s: ExplorerState): void => {
    const zone = displayZone(s);
    const today = sunToday(ctx, s);
    const day = today ? sunDay(today.sun?.events ?? [], today.window[0], today.window[1]) : null;
    const row = (name: string, phase: 'civil' | 'nautical' | 'astronomical', pair: [SkyEvent | null, SkyEvent | null] | undefined, highlight: boolean): HTMLElement =>
      h(
        'tr',
        { 'data-highlight': highlight ? '' : undefined },
        h('th', { scope: 'row' }, swatch(`var(--phase-${phase})`), name, highlight ? icon('sextant', { class: 'sf-twilight__mark' }) : null),
        h('td', { class: 'sf-num-r' }, pair?.[0] ? eventTime(pair[0].jd_utc, zone) : '—'),
        h('td', { class: 'sf-num-r' }, pair?.[1] ? eventTime(pair[1].jd_utc, zone) : '—'),
      );
    // SunCalc's shadow: of an upright object of the height typed here (1 m to start).
    const units = s.settings.units;
    const objectInput = h('input', {
      class: 'sf-input sf-num sf-shadow__input',
      type: 'text',
      inputmode: 'decimal',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': `Height of the object, ${units === 'imperial' ? 'feet' : 'metres'}`,
      value: String(Number(metresToUnits(objectHeightM(ctx), units).toFixed(2))),
    });
    const shadowValue = h('span', {});
    const shadowRow = h(
      'div',
      { class: 'sf-kv sf-shadow' },
      icon('shadow'),
      h('span', { class: 'sf-kv__k sf-shadow__k' }, 'Shadow of a', objectInput, `${units === 'imperial' ? 'ft' : 'm'} object`),
      h('span', { class: 'sf-kv__v' }, shadowValue),
    );
    objectInput.addEventListener('input', () => {
      const m = lengthToMetres(Number(objectInput.value.replace(',', '.')), units);
      const ok = Number.isFinite(m) && m > 0 && m <= 10_000;
      objectInput.toggleAttribute('aria-invalid', !ok);
      if (!ok) return;
      objectHeights.set(store, m);
      if (lastBody) updateExtras(lastBody, store.get());
    });
    const length = today?.sun?.day_length_h;
    extras.replaceChildren(
      h(
        'div',
        { class: 'sf-twilight', 'data-tip': 'Twilight begins in the morning (dawn) and ends in the evening (dusk). Nautical twilight is the time for star sights.' },
        h(
          'table',
          { class: 'sf-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Twilight'), h('th', { class: 'sf-num-r' }, 'Dawn'), h('th', { class: 'sf-num-r' }, 'Dusk'))),
          h('tbody', {}, row('Civil', 'civil', day?.civil, false), row('Nautical', 'nautical', day?.nautical, true), row('Astronomical', 'astronomical', day?.astronomical, false)),
        ),
      ),
      light.el,
      kv('daylength', 'Length of day', length === null || length === undefined ? '—' : formatHours(length)),
      shadowRow,
    );
    updateExtras = (b, st) => {
      const shadow = shadowOf(objectHeightM(ctx), b.alt_apparent_deg);
      if (shadow.kind === 'length') {
        setText(shadowValue, formatLength(shadow.m, st.settings.units, 2));
        setAttr(shadowRow, 'data-tip', `On level ground, pointing ${bearing3(b.az_deg + 180)} (${compassPoint(b.az_deg + 180)}), away from the Sun`);
      } else if (shadow.kind === 'long') {
        setText(shadowValue, 'Very long');
        setAttr(shadowRow, 'data-tip', 'The Sun is on the horizon: the shadow is more than a hundred times the object’s height');
      } else {
        setText(shadowValue, 'No shadow');
        setAttr(shadowRow, 'data-tip', 'The Sun is below the horizon');
      }
    };
  };

  const buildMoonExtras = (s: ExplorerState): void => {
    const zone = displayZone(s);
    const [a] = dayOf(s);
    const phases = (() => {
      try {
        return engine.moonPhases(a - 32, a + 32);
      } catch {
        return [];
      }
    })();
    const disc = h('span', { class: 'sf-moon__disc' });
    const name = h('p', { class: 'sf-moon__name' });
    const lit = h('p', { class: 'sf-moon__lit' });
    const next = h('p', { class: 'sf-moon__next' });
    const distValue = h('span', {});
    const distWords = h('p', { class: 'sf-photo__sub' });
    extras.replaceChildren(
      h('div', { class: 'sf-moon' }, disc, h('div', { class: 'sf-moon__text' }, name, lit, next)),
      kv('target', 'Distance', distValue, { tip: 'From the Earth’s centre to the Moon’s, as almanacs give it. The average is 384 400 km.' }),
      distWords,
      moon.el,
    );
    updateExtras = (b, st) => {
      const k = b.illuminated_fraction ?? 0;
      const story = moonStory(phases, st.time.jd_utc);
      const limb = b.bright_limb_angle_deg === null ? 270 : b.bright_limb_angle_deg - b.parallactic_angle_deg;
      const phaseName = moonPhaseName(k, story.waxing);
      disc.replaceChildren(
        phaseDisc({ illuminated: k, limbFromUpDeg: limb, size: 56, label: `${phaseName}, ${Math.round(k * 100)} percent lit, as it looks from here` }),
      );
      setText(name, phaseName);
      lit.replaceChildren(
        h('span', { class: 'sf-num' }, `${Math.round(k * 100)}%`),
        ' lit',
        ...(story.age !== null ? [' · ', h('span', { class: 'sf-num' }, story.age.toFixed(1)), ' days old'] : []),
      );
      next.replaceChildren(
        ...(story.next ? [`${PHASE_WORDS[story.next.kind]} `, h('span', { class: 'sf-num' }, `${dateShort(story.next.jd_utc, zone)}, ${eventTime(story.next.jd_utc, zone)}`)] : []),
      );
      setText(distValue, formatDistance(b.distance_km, st.settings.units));
      setText(distWords, b.distance_km === null ? '' : `${distanceWords(b.distance_km).replace(/^./, (c) => c.toUpperCase())}.`);
    };
  };

  // A planet's disc (planetdetail's planet_disc, under a millisecond): asked a quarter-hour
  // at a time, and while the time is dragged only once it settles (photo agent).
  const discSettler = new Settler();
  d.add(() => discSettler.cancel());

  const buildOtherExtras = (b0: BodyState): void => {
    const rows: [string, HTMLElement, string?][] = [];
    const cell = (): HTMLElement => h('span', {});
    const lit = cell();
    const elong = cell();
    const dist = cell();
    const con = cell();
    const size = cell();
    const sizeTip = 'How wide the planet looks: its apparent diameter across the equator, in seconds of arc (3600″ make a degree). The Moon is about 1 900″ across.';
    const planetDisc = b0.kind === 'planet' && isPlanetDetailEngine(engine);
    if (b0.kind === 'planet') {
      rows.push(['Lit', lit], ['Angle from the Sun', elong], ['Distance', dist]);
      if (planetDisc) rows.push(['Size in the sky', size, sizeTip]);
    }
    rows.push(['Constellation', con]);
    const els = rows.map(([k, v, tip]) => kv(null, k, v, tip ? { tip } : {}));
    extras.replaceChildren(...els);
    const sizeRow = planetDisc ? els[3] : undefined;
    updateExtras = (b, st) => {
      setText(lit, b.illuminated_fraction === null ? '—' : `${Math.round(b.illuminated_fraction * 100)}%`);
      setText(elong, b.elongation_deg === null ? '—' : `${Math.round(b.elongation_deg)}°`);
      setText(dist, formatDistance(b.distance_km, st.settings.units));
      setText(con, b.constellation ?? '—');
      if (!planetDisc || !sizeRow || !isPlanetDetailEngine(engine)) return;
      const q = Math.floor(st.time.jd_utc * 96) / 96;
      discSettler.request(
        `${b.body}|${q}`,
        currentMoving,
        () => {
          sizeRow.removeAttribute('data-stale');
          try {
            const disc = engine.planetDisc(b.body, q);
            setText(size, `${disc.equatorial_diameter_arcsec.toFixed(1)}″`);
            setAttr(
              sizeRow,
              'data-tip',
              `${sizeTip} Now ${disc.equatorial_diameter_arcsec.toFixed(1)}″ across the equator and ${disc.polar_diameter_arcsec.toFixed(1)}″ pole to pole, ${disc.distance_au.toFixed(3)} AU away (light takes ${Math.round(disc.light_time_s / 60)} min).`,
            );
          } catch {
            setText(size, '—');
          }
        },
        () => sizeRow.setAttribute('data-stale', ''),
      );
    };
  };

  /**
   * The height the Highest card gives: as it looks, refraction included, like the readout
   * above it (an event's `alt_deg` is geometric, CONVENTIONS 13.3), so at the moment of
   * transit the two agree. Asked of the engine at the transit instant, once per pass.
   */
  let transitMemo: { key: string; value: number } | null = null;
  const transitHeight = (e: SkyEvent): number => {
    const s = store.get();
    const body = s.selection.body ?? 'Sun';
    const key = `${body}|${e.jd_utc}|${s.observer.lat_deg}|${s.observer.lon_deg}|${s.observer.height_m}`;
    if (transitMemo?.key === key) return transitMemo.value;
    let value = e.alt_deg;
    try {
      value = bodyIn(engine.skyState(engineObserver(s), e.jd_utc, [body]), body)?.alt_apparent_deg ?? e.alt_deg;
    } catch {
      value = e.alt_deg;
    }
    transitMemo = { key, value };
    return value;
  };

  /**
   * The predicted sextant reading (`predict_sextant`): the correction chain run backwards
   * from the computed altitude, for the height of eye and index correction in Settings and a
   * sea horizon. Offered only for the bodies and years sights are offered for.
   */
  const predict = (b: BodyState, info: BodyInfo | undefined, s: ExplorerState): void => {
    const nav = engine.nav;
    const say = (value: string, note: string, tip: string | null = null): void => {
      setText(predictValue, value);
      setText(predictNote, note);
      setAttr(predictBox, 'data-tip', tip);
    };
    if (!nav || typeof nav.predictSextant !== 'function') return say('—', 'Predicted readings are not available in this engine.');
    if (!info || !offeredForSights(info, coverage)) {
      return say('—', info && !info.navigational ? `Not offered for sights: navigators do not use ${b.body}.` : 'Not offered for sights: its positions are not validated.');
    }
    if (!sightsOffered(ctx, s.time.jd_utc)) return say('—', sightsOnlyText(ctx));
    // The Sun's lower limb; the Moon's lit limb (its bright side up or down, seen from here); the centre otherwise.
    const fromZenith = b.bright_limb_angle_deg === null ? 180 : b.bright_limb_angle_deg - b.parallactic_angle_deg;
    const limb: SightLimb = b.kind === 'sun' ? 'lower' : b.kind === 'moon' ? (Math.cos((fromZenith * Math.PI) / 180) > 0 ? 'upper' : 'lower') : 'center';
    let p: PredictedSight;
    try {
      p = nav.predictSextant(
        { lat_deg: s.observer.lat_deg, lon_deg: s.observer.lon_deg, height_of_eye_m: s.settings.height_of_eye_m },
        { index_correction_arcmin: s.settings.index_correction_arcmin, horizon: 'sea' },
        b.body,
        limb,
        s.time.jd_utc,
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return say('—', /below the visible horizon/.test(text) ? 'Below the sea horizon now: no reading.' : `No reading: ${text.replace(/^predict_sextant: /, '')}.`);
    }
    const f = s.settings.angleFormat;
    const limbWord = p.limb === 'center' ? 'centre' : `${p.limb} limb`;
    const chain = p.corrections.steps
      .filter((st) => st.applied && Math.abs(st.delta_arcmin) >= 0.05)
      .map((st) => `${st.kind.replace(/_/g, ' ')} ${st.delta_arcmin >= 0 ? '+' : '−'}${Math.abs(st.delta_arcmin).toFixed(1)}′`)
      .join(', ');
    say(
      formatAngle(p.hs_deg, f),
      `Hs, ${limbWord}, from a height of eye of ${s.settings.height_of_eye_m} m with an index correction of ${s.settings.index_correction_arcmin.toFixed(1)}′ on a sea horizon (Settings).`,
      `The reading the correction chain turns into Hc ${formatAngle(p.hc_deg, f)} at Zn ${p.zn_deg.toFixed(1)}°: ${chain}.${p.earth_shape_arcmin ? ` Hc includes the Earth’s shape, ${p.earth_shape_arcmin.toFixed(2)}′.` : ''}`,
    );
  };

  // --- render -----------------------------------------------------------------------------
  const render = (): void => {
    const s = store.get();
    const name = s.selection.body ?? 'Sun';
    const info = infos.find((i) => i.body === name);
    const zone = displayZone(s);
    const placeZ = placeZone(s);
    const jd = s.time.jd_utc;
    const f = s.settings.angleFormat;
    // The time bar being dragged, or playing: the heavier rows wait for it to settle.
    const moving = motion.note(jd);
    currentMoving = moving;

    // Head
    const leadKey = `${name}`;
    if (chooserLead.dataset.body !== leadKey) {
      chooserLead.dataset.body = leadKey;
      chooserLead.replaceChildren(bodyGlyph(name, info ? { kind: info.kind } : {}));
      setText(chooserName, name);
      setAttr(chooser, 'aria-label', `Selected body: ${name}. Choose another`);
    }

    const sky = skySelected(ctx, s);
    const b = bodyIn(sky, name);
    const missing = bodyError(sky, name);

    if (!b) {
      status.hidden = false;
      setText(
        status,
        !covered(ctx, jd) ? `Not computed: ${outsideWords(ctx, 'this moment')}` : missing ? `Not computed: ${missing}.` : 'Not computed at this time.',
      );
      readouts.hidden = true;
      cardRow.hidden = true;
      extras.hidden = true;
      magRow.hidden = true;
      details.hidden = true;
      sights.hidden = true;
      when.el.hidden = true;
      coords.el.hidden = true;
      align.el.hidden = true;
      milky.el.hidden = true;
      return;
    }
    when.el.hidden = false;
    coords.el.hidden = false;
    milky.el.hidden = false;
    readouts.hidden = false;
    cardRow.hidden = false;
    extras.hidden = false;
    magRow.hidden = false;
    details.hidden = false;
    sights.hidden = false;

    // The pass around now: the same one the map's compass dial draws (shell/derived.ts).
    const { passage, up } = passNow(ctx, s, name, b.above_horizon);
    status.hidden = up;
    if (!up) setText(status, 'Below the horizon now.');

    setText(altValue, formatAngle(b.alt_apparent_deg, f, 'coarse'));
    setText(azValue, formatAzimuth(b.az_deg, f, 'coarse'));
    // With seconds the readouts step down a size (components.css) instead of wrapping.
    for (const v of [altValue, azValue]) setAttr(v.parentElement!, 'data-long', f === 'dms' ? '' : null);
    setText(azLabel, `Direction · ${compassPoint(b.az_deg)}`);
    setAttr(azValue, 'aria-label', `${formatAzimuth(b.az_deg, f, 'coarse')}, ${compassWords(b.az_deg)}`);

    // Cards: the passage around now
    const [riseWord, setWord] = words(name);
    const alwaysUp = passage.kind === 'always-up';
    const alwaysDown = passage.kind === 'always-down';
    fillCard(
      cards.rise,
      riseWord,
      passage.rise,
      jd,
      zone,
      placeZ,
      passage.rise ? `${bearing3(passage.rise.az_deg)} ${compassPoint(passage.rise.az_deg)}` : '',
      `Where the ${name} rises: its direction along the horizon`,
      alwaysUp ? 'Stays up' : alwaysDown ? 'Does not rise' : '—',
      passage.rise ? timeInfoAt(ctx, passage.rise.jd_utc) : null,
    );
    fillCard(
      cards.transit,
      'Highest',
      passage.transit,
      jd,
      zone,
      placeZ,
      passage.transit ? `${formatAngle(transitHeight(passage.transit), f, 'coarse')} ${compassPoint(passage.transit.az_deg)}` : '',
      name === 'Sun' ? 'Highest in the sky, on the meridian: local noon, the moment for a noon sight' : `Highest in the sky, on the meridian (the ${name}’s transit)`,
      '—',
      passage.transit ? timeInfoAt(ctx, passage.transit.jd_utc) : null,
    );
    fillCard(
      cards.set,
      setWord,
      passage.set,
      jd,
      zone,
      placeZ,
      passage.set ? `${bearing3(passage.set.az_deg)} ${compassPoint(passage.set.az_deg)}` : '',
      `Where the ${name} sets: its direction along the horizon`,
      alwaysUp ? 'Stays up' : alwaysDown ? 'Does not rise' : '—',
      passage.set ? timeInfoAt(ctx, passage.set.jd_utc) : null,
    );

    // Extras
    const [a] = dayOf(s);
    const key = `${name}|${b.kind}|${a}|${s.settings.timeDisplay}|${s.settings.hourCycle}|${s.settings.units}|${s.observer.lat_deg}|${s.observer.lon_deg}|${s.settings.horizon}|${s.settings.height_of_eye_m}`;
    if (key !== extrasKey) {
      extrasKey = key;
      if (b.kind === 'sun') buildSunExtras(s);
      else if (b.kind === 'moon') buildMoonExtras(s);
      else buildOtherExtras(b);
    }
    lastBody = b;
    updateExtras(b, s);
    if (b.kind === 'sun') light.update(s, moving);
    if (b.kind === 'moon') moon.update(b, s, moving);
    when.update(s, name, moving);
    align.el.hidden = b.kind !== 'sun' && b.kind !== 'moon';
    if (!align.el.hidden) align.update(s, name);
    milky.update(s, moving);
    coords.update(b, s);
    mag.update(b, s, a);

    setText(magValue, formatMagnitude(b.magnitude));

    // Offered for sights, and why
    if (info) {
      const group = coverageGroupFor(info, coverage);
      const offered = offeredForSights(info, coverage);
      setText(
        sights,
        offered
          ? `Offered for sights: its positions are validated${group?.accuracy_arcmin ? ` to ${group.accuracy_arcmin}′` : ''}.`
          : !info.navigational
            ? 'Shown only: navigators do not use it for sights.'
            : 'Shown only: its positions are not yet validated for sights.',
      );
      sights.classList.toggle('sf-selected__sights--no', !offered);
    }

    // Navigator's details
    const rows: [string, string][] = [
      ['GHA', formatAngle(b.gha_deg, f)],
      ['Declination', formatDeclination(b.dec_deg, f)],
      ...(b.kind === 'star' ? ([['SHA', formatAngle(b.sha_deg, f)]] as [string, string][]) : []),
      ['Hc (tables)', formatAngle(b.hc_deg, f)],
      ['Zn (tables)', formatZn(b.zn_deg)],
      ...(b.semidiameter_arcmin ? ([['Semi-diameter', `${b.semidiameter_arcmin.toFixed(1)}′`]] as [string, string][]) : []),
      ...(b.kind === 'moon' ? ([['Horizontal parallax', `${b.horizontal_parallax_arcmin.toFixed(1)}′`]] as [string, string][]) : []),
      ...(b.kind === 'sun' ? ([['Distance', formatDistance(b.distance_km, s.settings.units)]] as [string, string][]) : []),
      ...(b.kind !== 'star' && b.kind !== 'planet' && b.constellation ? ([['Constellation', b.constellation]] as [string, string][]) : []),
    ];
    if (details.open) predict(b, info, s);
    const cells = detailsGrid.children;
    if (cells.length !== rows.length || rows.some(([k], i) => cells[i]?.querySelector('.sf-kv__k')?.textContent !== k)) {
      detailsGrid.replaceChildren(...rows.map(([k, v]) => kv(null, k, v)));
    } else {
      rows.forEach(([, v], i) => {
        const cell = cells[i]?.querySelector('.sf-kv__v');
        if (cell) setText(cell, v);
      });
    }
  };

  d.add(
    watch(
      ctx,
      (s) => [s.time.jd_utc, s.observer, s.selection.body, s.settings, dayOf(s)[0]] as const,
      render,
      { equals: shallowEqual },
    ),
  );
  details.addEventListener('toggle', () => {
    if (details.open) ctx.scheduler.schedule(render);
  });

  // --- the chooser's popover ---------------------------------------------------------------
  const filter = h('input', {
    class: 'sf-input',
    type: 'search',
    placeholder: 'Filter: Moon, Venus, Sirius…',
    'aria-label': 'Filter the bodies',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const listbox = h('div', { class: 'sf-chooser__list', role: 'listbox', 'aria-label': 'Bodies' });
  const chooserPanel = h('div', { class: 'sf-chooser' }, filter, listbox);
  const groups: [string, (i: BodyInfo) => boolean][] = [
    ['Sun and Moon', (i) => i.kind === 'sun' || i.kind === 'moon'],
    ['Planets', (i) => i.kind === 'planet'],
    ['Navigational stars', (i) => i.kind === 'star'],
  ];
  const fillList = (): void => {
    const q = filter.value.trim().toLowerCase();
    const s = store.get();
    const sky = skyNow(ctx, s);
    const current = s.selection.body;
    const out: HTMLElement[] = [];
    for (const [title, test] of groups) {
      const members = infos
        .filter(test)
        .filter((i) => !q || i.body.toLowerCase().includes(q))
        .sort((x, y) => (x.kind === 'star' ? x.body.localeCompare(y.body) : 0));
      if (!members.length) continue;
      out.push(h('div', { class: 'sf-chooser__group', role: 'presentation' }, title));
      for (const i of members) {
        const st = bodyIn(sky, i.body);
        const opt = h(
          'div',
          {
            class: 'sf-chooser__opt',
            role: 'option',
            tabindex: -1,
            'aria-selected': String(i.body === current),
            'data-body': i.body,
          },
          bodyGlyph(i.body, { kind: i.kind }),
          h('span', { class: 'sf-chooser__name' }, i.body),
          h(
            'span',
            { class: `sf-chooser__alt${st && !st.above_horizon ? ' sf-chooser__alt--down' : ''}` },
            st ? `${Math.round(st.alt_apparent_deg)}°` : '',
          ),
        );
        opt.addEventListener('click', () => pick(i.body));
        out.push(opt);
      }
    }
    if (!out.length) out.push(h('p', { class: 'sf-chooser__empty' }, 'No body by that name.'));
    listbox.replaceChildren(...out);
  };
  const pick = (body: string): void => {
    store.patch({ selection: { body } });
    pop.close();
  };
  const options = (): HTMLElement[] => [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
  filter.addEventListener('input', fillList);
  const onKeys = (e: KeyboardEvent): void => {
    const opts = options();
    const at = opts.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? (at < 0 ? 0 : Math.min(opts.length - 1, at + 1)) : at <= 0 ? -1 : at - 1;
      if (next < 0) filter.focus();
      else opts[next]?.focus();
    } else if (e.key === 'Enter') {
      const target = at >= 0 ? opts[at] : opts[0];
      if (target?.dataset.body) {
        e.preventDefault();
        pick(target.dataset.body);
      }
    }
  };
  chooserPanel.addEventListener('keydown', onKeys);
  const pop = popover(chooser, chooserPanel, {
    label: 'Choose a body',
    placement: 'bottom-end',
    onOpen: () => {
      filter.value = '';
      fillList();
      filter.focus();
    },
  });
  d.add(() => pop.destroy());

  return { el: sec.el, destroy: () => d.dispose() };
}

