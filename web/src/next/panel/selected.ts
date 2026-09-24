/**
 * The panel's Selected section: the chosen body's height and direction in large type, its
 * rise, highest point and set around now (colours and icons matching the map's lines),
 * what is special about it (twilight for the Sun, the phase for the Moon), and the
 * navigator's figures. OWNER: shell-design agent.
 */

import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import { coverageGroupFor, offeredForSights } from '../engine/bodies.js';
import type { BodyInfo, BodyState, PhaseEvent, SkyEvent } from '../engine/types.js';
import { aroundToday, bodyError, bodyIn, covered, setAttr, setText, skyNow, sunToday } from '../shell/derived.js';
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
  otherDay,
} from '../shell/format.js';
import { passageAround, sunDay, type Passage } from '../shell/sky.js';
import { currentDayWindow, displayZone, placeZone, shallowEqual, type ExplorerState } from '../state.js';
import { bodyGlyph, moonPhaseName, phaseDisc } from '../theme/glyphs.js';
import { icon } from '../theme/icons.js';
import { kv, popover, section, swatch } from '../theme/primitives.js';
import { UTC_ZONE, formatHours, wallClock, zoneShortName, type Zone } from '../time.js';

const WORDS: Record<string, [string, string]> = { Sun: ['Sunrise', 'Sunset'], Moon: ['Moonrise', 'Moonset'] };

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
}

function card(kind: 'rise' | 'transit' | 'set'): Card {
  const title = h('span', {});
  const time = h('span', {});
  const day = h('span', { class: 'sf-evcard__day' });
  const utc = h('div', { class: 'sf-evcard__utc sf-num' });
  const where = h('div', { class: 'sf-evcard__where sf-num' });
  const el = h(
    'div',
    { class: 'sf-evcard', 'data-kind': kind },
    h('div', { class: 'sf-evcard__head' }, icon(kind), title),
    h('div', { class: 'sf-evcard__time sf-num' }, time, day),
    utc,
    where,
  );
  return { el, title, time, day, utc, where };
}

function fillCard(c: Card, title: string, e: SkyEvent | null, jd: number, zone: Zone, place: Zone, where: string, tip: string, none: string): void {
  setText(c.title, title);
  setText(c.time, e ? eventTime(e.jd_utc, zone) : '—');
  setText(c.day, e ? otherDay(e.jd_utc, jd, zone) : '');
  // The second clock: UTC, or the place's own when UTC is already the first. Its day is
  // named when it differs (Tokyo's 05:31 is 20:31 UTC the day before).
  const utcFirst = zone.kind === 'fixed' && zone.offsetMs === 0;
  const second = utcFirst ? place : UTC_ZONE;
  const secondDay = e ? otherDayOf(e.jd_utc, zone, second) : '';
  const secondName = utcFirst ? zoneShortName(e?.jd_utc ?? jd, place) : 'UTC';
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

/** Up or down now, by the body's own rise and set events (consistent with the cards). */
function isUp(events: readonly SkyEvent[], jd: number, fallback: boolean): boolean {
  let last: SkyEvent | null = null;
  for (const e of events) if ((e.kind === 'rise' || e.kind === 'set') && e.jd_utc <= jd) last = e;
  return last ? last.kind === 'rise' : fallback;
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
  const details = h(
    'details',
    { class: 'sf-details', 'data-term': '' },
    h('summary', {}, 'Navigator’s details', icon('chevron-down')),
    detailsGrid,
  );
  sec.body.append(status, readouts, cardRow, extras, magRow, sights, details);

  // --- extras per kind, rebuilt when the body or the day changes ----------------------
  let extrasKey = '';
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
    const shadowValue = h('span', {});
    const shadowRow = kv('shadow', 'Shadow of a 1 m pole', shadowValue);
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
      kv('daylength', 'Length of day', length === null || length === undefined ? '—' : formatHours(length)),
      shadowRow,
    );
    updateExtras = (b, st) => {
      if (b.alt_apparent_deg > 0.5) {
        const m = 1 / Math.tan((b.alt_apparent_deg * Math.PI) / 180);
        setText(shadowValue, formatLength(m, st.settings.units, 2));
        setAttr(shadowRow, 'data-tip', `Pointing ${bearing3(b.az_deg + 180)} (${compassPoint(b.az_deg + 180)}), away from the Sun`);
      } else {
        setText(shadowValue, b.alt_apparent_deg > 0 ? 'very long' : 'none: the Sun is down');
      }
    };
  };

  const buildMoonExtras = (s: ExplorerState): void => {
    const zone = displayZone(s);
    const [a] = currentDayWindow(s);
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
    extras.replaceChildren(
      h('div', { class: 'sf-moon' }, disc, h('div', { class: 'sf-moon__text' }, name, lit, next)),
      kv('target', 'Distance', distValue),
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
    };
  };

  const buildOtherExtras = (b0: BodyState): void => {
    const rows: [string, HTMLElement][] = [];
    const cell = (): HTMLElement => h('span', {});
    const lit = cell();
    const elong = cell();
    const dist = cell();
    const con = cell();
    if (b0.kind === 'planet') {
      rows.push(['Lit', lit], ['Angle from the Sun', elong], ['Distance', dist]);
    }
    rows.push(['Constellation', con]);
    extras.replaceChildren(...rows.map(([k, v]) => kv(null, k, v)));
    updateExtras = (b, st) => {
      setText(lit, b.illuminated_fraction === null ? '—' : `${Math.round(b.illuminated_fraction * 100)}%`);
      setText(elong, b.elongation_deg === null ? '—' : `${Math.round(b.elongation_deg)}°`);
      setText(dist, formatDistance(b.distance_km, st.settings.units));
      setText(con, b.constellation ?? '—');
    };
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

    // Head
    const leadKey = `${name}`;
    if (chooserLead.dataset.body !== leadKey) {
      chooserLead.dataset.body = leadKey;
      chooserLead.replaceChildren(bodyGlyph(name, info ? { kind: info.kind } : {}));
      setText(chooserName, name);
      setAttr(chooser, 'aria-label', `Selected body: ${name}. Choose another`);
    }

    const sky = skyNow(ctx, s);
    const b = bodyIn(sky, name);
    const missing = bodyError(sky, name);
    const around = aroundToday(ctx, s, name);
    const events = around?.bodies.find((x) => x.body === name)?.events ?? [];

    if (!b) {
      status.hidden = false;
      setText(
        status,
        !covered(ctx, jd) ? 'Not computed: this moment is outside the years the core covers.' : missing ? `Not computed: ${missing}.` : 'Not computed at this time.',
      );
      readouts.hidden = true;
      cardRow.hidden = true;
      extras.hidden = true;
      magRow.hidden = true;
      details.hidden = true;
      sights.hidden = true;
      return;
    }
    readouts.hidden = false;
    cardRow.hidden = false;
    extras.hidden = false;
    magRow.hidden = false;
    details.hidden = false;
    sights.hidden = false;

    const up = isUp(events, jd, b.above_horizon);
    status.hidden = up;
    if (!up) setText(status, 'Below the horizon now.');

    setText(altValue, formatAngle(b.alt_apparent_deg, f, 'coarse'));
    setText(azValue, formatAzimuth(b.az_deg, f, 'coarse'));
    setText(azLabel, `Direction · ${compassPoint(b.az_deg)}`);
    setAttr(azValue, 'aria-label', `${formatAzimuth(b.az_deg, f, 'coarse')}, ${compassWords(b.az_deg)}`);

    // Cards: the passage around now
    const flags = around?.bodies.find((x) => x.body === name);
    const passage: Passage = flags?.always_above
      ? passageAround(events, jd, true)
      : flags?.always_below
        ? passageAround(events, jd, false)
        : passageAround(events, jd, up);
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
    );
    fillCard(
      cards.transit,
      'Highest',
      passage.transit,
      jd,
      zone,
      placeZ,
      passage.transit ? `${formatAngle(passage.transit.alt_deg, f, 'coarse')} ${compassPoint(passage.transit.az_deg)}` : '',
      name === 'Sun' ? 'Highest in the sky, on the meridian: local noon, the moment for a noon sight' : `Highest in the sky, on the meridian (the ${name}’s transit)`,
      '—',
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
    );

    // Extras
    const [a] = currentDayWindow(s);
    const key = `${name}|${b.kind}|${a}|${s.settings.timeDisplay}|${s.observer.lat_deg}|${s.observer.lon_deg}|${s.settings.horizon}|${s.settings.height_of_eye_m}`;
    if (key !== extrasKey) {
      extrasKey = key;
      if (b.kind === 'sun') buildSunExtras(s);
      else if (b.kind === 'moon') buildMoonExtras(s);
      else buildOtherExtras(b);
    }
    updateExtras(b, s);

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
      (s) => [s.time.jd_utc, s.observer, s.selection.body, s.settings, currentDayWindow(s)[0]] as const,
      render,
      { equals: shallowEqual },
    ),
  );

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

