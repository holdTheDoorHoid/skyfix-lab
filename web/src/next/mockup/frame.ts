/**
 * DESIGN MOCKUP: the explorer's frame and panel content, built from the design-system
 * primitives with the hard-coded numbers of `data.ts` for one moment (`scenario.ts`).
 * The phase-2 shell builds the same markup from the store and the engine.
 */

import { h } from '../../dom.js';
import { formatLat, formatLon } from '../../format.js';
import type { SkyPhase } from '../engine/types.js';
import { bodyGlyph, moonPhaseName, phaseDisc } from '../theme/glyphs.js';
import { icon, type IconName } from '../theme/icons.js';
import {
  badge,
  button,
  chip,
  iconButton,
  kv,
  logoMark,
  phaseChip,
  readout,
  section,
  segmented,
  swatch,
  type Segmented,
} from '../theme/primitives.js';
import type { ThemeName } from '../theme/theme.js';
import { createRibbon, type Ribbon, type RibbonHour, type RibbonMark } from '../timebar/ribbon.js';
import { formatHours, formatOffset, msFromJd, UTC_ZONE, zoneOffsetMs, zoneShortName } from '../time.js';
import { at, DAY_END, DAY_START, NEXT_FULL_MOON_JD, PHASES, PLACE, PREVIOUS_NEW_MOON_JD, SUN_EVENTS, ZONE } from './data.js';
import type { MockBody } from './data.js';
import { bearing, dateLabel, dateLong, decl, dm0, dm1, hm, mag, point16 } from './fmt.js';
import type { Scenario } from './scenario.js';

export const HONESTY = 'Simulation and analysis workbench. Not a navigation instrument.';

export const VIEWS: { id: string; label: string; icon: IconName; tip: string }[] = [
  { id: 'map', label: 'Map', icon: 'map', tip: 'The place on a world map, with day and night' },
  { id: 'sky', label: 'Sky', icon: 'sky', tip: 'What you would see: the sky dome and the horizon' },
  { id: 'charts', label: 'Charts', icon: 'charts', tip: 'Heights through the day, twilight through the year' },
  { id: 'navigate', label: 'Navigate', icon: 'sextant', tip: 'Sights, corrections and the fix' },
  { id: 'almanac', label: 'Almanac', icon: 'almanac', tip: 'Printable daily almanac pages' },
  { id: 'events', label: 'Events', icon: 'events', tip: 'Eclipses, Moon phases, equinoxes and solstices' },
  { id: 'learn', label: 'Learn', icon: 'learn', tip: 'Guided demonstrations and the simulator' },
  { id: 'about', label: 'About', icon: 'about', tip: 'Accuracy, sources and the manual' },
];

export const PHASE_LABEL: Record<SkyPhase, string> = {
  day: 'Daylight',
  civil: 'Civil twilight',
  nautical: 'Nautical twilight',
  astronomical: 'Astronomical twilight',
  night: 'Night',
};

export const PHASE_TIP: Record<SkyPhase, string> = {
  day: 'The Sun is up.',
  civil: 'Bright twilight: the horizon is sharp; the brightest planets and stars appear.',
  nautical: 'Horizon and stars both visible: the time for star sights.',
  astronomical: 'Too dark to see the horizon; the sky is not yet fully dark.',
  night: 'Full darkness: stars are bright but the horizon cannot be seen.',
};

const PHASE_ICON: Record<SkyPhase, IconName> = {
  day: 'sun',
  civil: 'dusk',
  nautical: 'sextant',
  astronomical: 'moon',
  night: 'moon',
};

const EVENT_WORDS: Record<string, { rise: string; set: string }> = {
  Sun: { rise: 'Sunrise', set: 'Sunset' },
  Moon: { rise: 'Moonrise', set: 'Moonset' },
};

export interface Frame {
  root: HTMLElement;
  mapHost: HTMLElement;
  stage: HTMLElement;
  ribbon: Ribbon;
  theme: Segmented<ThemeName>;
  themeCycle: HTMLButtonElement;
  panelToggle: HTMLButtonElement;
  projection: Segmented<'flat' | 'globe'>;
  zoomIn: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
  recenter: HTMLButtonElement;
}

const utc = (jd: number): string => hm(jd, UTC_ZONE);
const zoneName = (jd: number): string => zoneShortName(jd, ZONE);
const riseWord = (b: MockBody): string => EVENT_WORDS[b.body]?.rise ?? 'Rises';
const setWord = (b: MockBody): string => EVENT_WORDS[b.body]?.set ?? 'Sets';

// ---------------------------------------------------------------------------------
// App strip
// ---------------------------------------------------------------------------------

function appbar(
  theme: ThemeName,
  onTheme?: (theme: ThemeName) => void,
): { el: HTMLElement; theme: Segmented<ThemeName>; cycle: HTMLButtonElement } {
  const themeSeg = segmented<ThemeName>({
    label: 'Theme',
    value: theme,
    onChange: onTheme,
    size: 'sm',
    options: [
      { value: 'light', label: 'Light theme', icon: 'sun', iconOnly: true, tip: 'Light: light map, dark panel' },
      { value: 'dark', label: 'Dark theme', icon: 'moon', iconOnly: true, tip: 'Dark: navy map and panel' },
      {
        value: 'night',
        label: 'Night vision theme',
        icon: 'eye',
        iconOnly: true,
        tip: 'Night vision: red on black, keeps your eyes adapted to the dark',
      },
    ],
  });
  const cycle = iconButton(theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'eye', 'Change theme', {
    size: 'sm',
    class: 'sf-appbar__narrow',
  });
  const el = h(
    'header',
    { class: 'sf-appbar' },
    h('a', { class: 'sf-brand', href: '#', 'aria-label': 'SkyFix Lab' }, logoMark(20), h('span', { class: 'sf-brand__text' }, 'SkyFix Lab')),
    h('span', { class: 'sf-appbar__rule', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'sf-honesty', role: 'note' },
      h('span', { class: 'sf-honesty__text' }, icon('caution'), HONESTY),
      badge('mock', {
        text: 'Design mockup',
        short: 'Mockup',
        tip: 'A design mockup: every number on this page is illustrative, typed in from one run of the mock engine. Nothing here comes from the SkyFix Lab core.',
      }),
    ),
    h(
      'div',
      { class: 'sf-appbar__end' },
      h('span', { class: 'sf-appbar__wide' }, themeSeg.el),
      button({
        label: 'Share',
        icon: 'share',
        variant: 'ghost',
        size: 'sm',
        class: 'sf-appbar__wide sf-share-btn',
        tip: 'Make a link to this place and time. Nothing is put in a link until you ask.',
      }),
      iconButton('help', 'Help and keyboard shortcuts', { size: 'sm', class: 'sf-appbar__wide', tip: 'Help and keyboard shortcuts' }),
      cycle,
    ),
  );
  return { el, theme: themeSeg, cycle };
}

// ---------------------------------------------------------------------------------
// Time bar
// ---------------------------------------------------------------------------------

function ribbonHours(): RibbonHour[] {
  const out: RibbonHour[] = [];
  for (let hr = 0; hr <= 24; hr += 1) {
    out.push({ jd: at(hr), label: hr % 3 === 0 ? String(hr) : '', major: hr % 3 === 0 });
  }
  return out;
}

function ribbonMarks(s: Scenario): RibbonMark[] {
  const b = s.selected;
  const z = zoneName(s.jd);
  const marks: RibbonMark[] = [];
  const { rise, transit, set } = s.dayEvents;
  if (rise) marks.push({ kind: 'rise', jd: rise.jd, label: hm(rise.jd, ZONE), tip: `${riseWord(b)} ${hm(rise.jd, ZONE)} ${z}, ${bearing(rise.az!)}` });
  if (transit) marks.push({ kind: 'transit', jd: transit.jd, label: hm(transit.jd, ZONE), tip: `Highest (transit) ${hm(transit.jd, ZONE)} ${z}, ${dm0(transit.alt!)} up` });
  if (set) marks.push({ kind: 'set', jd: set.jd, label: hm(set.jd, ZONE), tip: `${setWord(b)} ${hm(set.jd, ZONE)} ${z}, ${bearing(set.az!)}` });
  return marks;
}

function timebar(s: Scenario): { el: HTMLElement; ribbon: Ribbon } {
  const localNow = hm(s.jd, ZONE);
  const z = zoneName(s.jd);
  const ribbon = createRibbon({
    window: [DAY_START, DAY_END],
    phases: PHASES,
    hours: ribbonHours(),
    marks: ribbonMarks(s),
    jd: s.jd,
    glyph: s.handleGlyph,
    valueText: `${localNow} ${z}, ${dateLong(s.jd, ZONE)}`,
    bubbleText: `${localNow} ${z}`,
    nowJd: s.live ? s.jd : null,
    phaseTip: (p) => `${PHASE_LABEL[p.phase]} ${hm(p.jd_start, ZONE)}–${p.jd_end >= DAY_END ? '24:00' : hm(p.jd_end, ZONE)}. ${PHASE_TIP[p.phase]}`,
  });

  const date = dateLabel(s.jd, ZONE, { year: false });
  const year = dateLabel(s.jd, ZONE).slice(date.length).trim();
  const nowButton = button({
    label: 'Now',
    variant: 'secondary',
    class: 'sf-tb-now',
    pressed: s.live,
    tip: s.live ? 'Following the clock (N)' : 'Back to now, and follow the clock (N)',
    attrs: { 'aria-label': s.live ? 'Now: following the clock' : 'Now: back to the present time' },
  });
  nowButton.prepend(h('span', { class: 'sf-live-dot', 'aria-hidden': 'true' }));
  const el = h(
    'div',
    { class: 'sf-timebar', role: 'region', 'aria-label': 'Date and time' },
    h(
      'div',
      { class: 'sf-tb-when' },
      h(
        'div',
        { class: 'sf-tb-date' },
        iconButton('chevron-left', 'One day earlier', { size: 'sm', tip: 'One day earlier (Alt+Left)' }),
        h(
          'button',
          { type: 'button', class: 'sf-tb-date__label', 'data-tip': 'Choose a date (PgUp/PgDn: a month)' },
          icon('calendar'),
          h('span', {}, date, h('span', { class: 'sf-tb-date__year' }, ` ${year}`)),
        ),
        iconButton('chevron-right', 'One day later', { size: 'sm', tip: 'One day later (Alt+Right)' }),
      ),
      h(
        'div',
        { class: 'sf-tb-clock' },
        h('output', { class: 'sf-tb-clock__local' }, localNow, h('span', { class: 'sf-tb-clock__sec' }, ':00')),
        h(
          'span',
          { class: 'sf-tb-clock__row' },
          h('span', { class: 'sf-tb-clock__zone', 'data-tip': `America/New_York, ${formatOffset(zoneOffsetMs(msFromJd(s.jd), ZONE))}` }, z),
          h('output', { class: 'sf-tb-clock__utc' }, `${utc(s.jd)} UTC`),
        ),
      ),
    ),
    ribbon.el,
    h(
      'div',
      { class: 'sf-tb-transport' },
      nowButton,
      button({ icon: 'play', variant: 'primary', class: 'sf-tb-play', ariaLabel: 'Play', tip: 'Play: run time forward (Space)' }),
      button({
        label: '1 h/s',
        icon: 'speed',
        iconAfter: 'chevron-down',
        variant: 'ghost',
        class: 'sf-tb-speed',
        tip: 'Playback speed: one hour of sky per second',
        attrs: { 'aria-label': 'Playback speed, 1 hour per second', 'aria-haspopup': 'menu' },
      }),
    ),
  );
  return { el, ribbon };
}

// ---------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------

function views(): HTMLElement {
  return h(
    'nav',
    { class: 'sf-views', 'aria-label': 'Views' },
    ...VIEWS.map((v) =>
      h(
        'button',
        { type: 'button', class: 'sf-views__tab', 'aria-current': v.id === 'map' ? 'page' : undefined, 'data-tip': v.tip },
        icon(v.icon),
        h('span', {}, v.label),
      ),
    ),
  );
}

function search(): HTMLElement {
  return h(
    'div',
    { class: 'sf-search', role: 'search' },
    h(
      'label',
      { class: 'sf-field' },
      icon('search'),
      h('input', {
        class: 'sf-input',
        type: 'search',
        placeholder: 'Place name or coordinates',
        'aria-label': 'Search a place, or type coordinates such as 39 57.2 N 75 09.9 W',
        'data-tip': 'A place name, or coordinates such as 39°57.2′N 75°09.9′W',
      }),
    ),
    iconButton('locate', 'Use my location', {
      variant: 'outline',
      tip: 'Use my location: asked from your browser, used only in this page, never sent anywhere',
    }),
  );
}

function placeSection(s: Scenario): HTMLElement {
  const sec = section('Place', {
    class: 'sf-place',
    aside: button({ label: 'Edit', icon: 'edit', variant: 'ghost', size: 'sm', tip: 'Coordinates, time zone and height of eye' }),
  });
  sec.body.append(
    h('p', { class: 'sf-place__name' }, PLACE.label),
    h('p', { class: 'sf-place__coords' }, h('span', {}, formatLat(PLACE.lat_deg)), h('span', {}, formatLon(PLACE.lon_deg))),
    kv('clock', 'Time zone', h('span', {}, zoneName(s.jd), ' ', h('small', {}, formatOffset(zoneOffsetMs(msFromJd(s.jd), ZONE)))), {
      tip: 'America/New_York, from the place. Times are shown here with UTC beside them.',
    }),
    kv('eyeheight', 'Height of eye', `${PLACE.height_of_eye_m} m`, {
      tip: 'Your eye above the sea: sets the dip of the horizon for sights',
    }),
  );
  return sec.el;
}

function nowSection(s: Scenario): HTMLElement {
  const sec = section('Now', {
    class: 'sf-now',
    aside: h('span', { class: 'sf-section__meta' }, `${dateLabel(s.jd, ZONE, { year: false })}, ${hm(s.jd, ZONE)}`),
  });
  const nautStart = hm(at(SUN_EVENTS.civil_dusk.h), ZONE);
  const nautEnd = hm(at(SUN_EVENTS.nautical_dusk.h), ZONE);
  const minutesLeft = Math.round((at(SUN_EVENTS.nautical_dusk.h) - s.jd) * 1440);
  const meaning =
    s.phase === 'day'
      ? [
          'The Sun is up: Sun sights are possible now. Stars stay hidden until ',
          h('strong', {}, `nautical twilight, ${nautStart}–${nautEnd}`),
          ', the time for star sights.',
        ]
      : [
          h('strong', {}, 'Horizon and stars both visible: the time for star sights.'),
          ` Nautical twilight ends at ${nautEnd}, in ${minutesLeft} minutes.`,
        ];
  sec.body.append(
    h('div', { class: 'sf-now__phase' }, phaseChip(s.phase, PHASE_LABEL[s.phase], icon(PHASE_ICON[s.phase]))),
    h('p', { class: 'sf-now__meaning' }, ...meaning),
  );
  return sec.el;
}

function eventCard(
  kind: 'rise' | 'transit' | 'set',
  title: string,
  jd: number,
  where: string,
  tip: string,
  dayNote?: string,
): HTMLElement {
  return h(
    'div',
    { class: 'sf-evcard', 'data-kind': kind, 'data-tip': tip },
    h('div', { class: 'sf-evcard__head' }, icon(kind), h('span', {}, title)),
    h('div', { class: 'sf-evcard__time sf-num' }, hm(jd, ZONE), dayNote ? h('span', { class: 'sf-evcard__day' }, dayNote) : null),
    h('div', { class: 'sf-evcard__utc sf-num' }, `${utc(jd)} UTC`),
    h('div', { class: 'sf-evcard__where sf-num' }, where),
  );
}

function sunExtras(sun: MockBody): HTMLElement[] {
  const shadow = 1 / Math.tan((sun.alt * Math.PI) / 180);
  const twilightRow = (name: string, phase: SkyPhase, dawn: number, dusk: number, highlight: boolean): HTMLElement =>
    h(
      'tr',
      { 'data-highlight': highlight ? '' : undefined, 'data-tip': `${PHASE_LABEL[phase]}. ${PHASE_TIP[phase]}` },
      h('th', { scope: 'row' }, swatch(`var(--phase-${phase})`), name, highlight ? icon('sextant', { class: 'sf-twilight__mark' }) : null),
      h('td', { class: 'sf-num-r' }, hm(at(dawn), ZONE)),
      h('td', { class: 'sf-num-r' }, hm(at(dusk), ZONE)),
    );
  return [
    h(
      'div',
      { class: 'sf-twilight' },
      h(
        'table',
        { class: 'sf-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Twilight'), h('th', { class: 'sf-num-r' }, 'Dawn'), h('th', { class: 'sf-num-r' }, 'Dusk'))),
        h(
          'tbody',
          {},
          twilightRow('Civil', 'civil', SUN_EVENTS.civil_dawn.h, SUN_EVENTS.civil_dusk.h, false),
          twilightRow('Nautical', 'nautical', SUN_EVENTS.nautical_dawn.h, SUN_EVENTS.nautical_dusk.h, true),
          twilightRow('Astronomical', 'astronomical', SUN_EVENTS.astronomical_dawn.h, SUN_EVENTS.astronomical_dusk.h, false),
        ),
      ),
    ),
    kv('daylength', 'Length of day', formatHours(SUN_EVENTS.day_length_h)),
    kv('shadow', 'Shadow of a 1 m pole', `${shadow.toFixed(2)} m`, { tip: `Pointing ${bearing(sun.az - 180)}, away from the Sun` }),
  ];
}

function moonExtras(moon: MockBody, s: Scenario): HTMLElement[] {
  const k = moon.illuminated ?? 0;
  const age = s.jd - PREVIOUS_NEW_MOON_JD;
  const full = NEXT_FULL_MOON_JD;
  return [
    h(
      'div',
      { class: 'sf-moon' },
      phaseDisc({
        illuminated: k,
        limbFromUpDeg: moon.limbFromUp ?? 270,
        size: 56,
        label: `${moonPhaseName(k, true)}, ${Math.round(k * 100)} percent lit, as seen from here now`,
      }),
      h(
        'div',
        { class: 'sf-moon__text' },
        h('p', { class: 'sf-moon__name' }, moonPhaseName(k, true)),
        h('p', { class: 'sf-moon__lit' }, h('span', { class: 'sf-num' }, `${Math.round(k * 100)}%`), ' lit · ', h('span', { class: 'sf-num' }, age.toFixed(1)), ' days old'),
        h(
          'p',
          { class: 'sf-moon__next' },
          'Full Moon ',
          h('span', { class: 'sf-num' }, `${dateLabel(full, ZONE, { year: false })}, ${hm(full, ZONE)}`),
        ),
      ),
    ),
    kv('target', 'Distance', h('span', {}, `${Math.round(moon.distance_km! / 10) * 10} `.replace(/\B(?=(\d{3})+(?!\d))/g, ' '), h('small', {}, 'km'))),
  ];
}

function selectedSection(s: Scenario): HTMLElement {
  const b = s.selected;
  const sec = section('Selected', {
    class: 'sf-selected',
    aside: chip({ label: b.body, lead: bodyGlyph(b.body, { kind: b.kind }), caret: true, tip: 'Choose another body: Sun, Moon, planets, stars' }),
  });
  const p = s.passage;
  const setDay = p.setNextDay ? dateLabel(p.set.jd, ZONE, { year: false }).split(' ')[0] : undefined;
  const details: [string, string][] = [
    ['GHA', dm1(b.gha)],
    ['Declination', decl(b.dec)],
    ...(b.hc !== undefined ? ([['Hc (tables)', dm1(b.hc)]] as [string, string][]) : []),
    ...(b.zn !== undefined ? ([['Zn (tables)', `${b.zn.toFixed(1)}°`]] as [string, string][]) : []),
    ...(b.sd_arcmin !== undefined ? ([['Semi-diameter', `${b.sd_arcmin.toFixed(1)}′`]] as [string, string][]) : []),
    ...(b.hp_arcmin !== undefined && b.kind === 'moon' ? ([['Horizontal parallax', `${b.hp_arcmin.toFixed(1)}′`]] as [string, string][]) : []),
    ...(b.kind === 'sun' ? ([['Distance', `${(b.distance_km! / 149597870.7).toFixed(4)} AU`]] as [string, string][]) : []),
  ];
  sec.body.append(
    h(
      'div',
      { class: 'sf-readouts' },
      readout({
        value: dm0(b.alt),
        label: 'Height above horizon',
        term: 'altitude',
        tip: `How high the ${b.body}’s centre looks above a sea-level horizon (refraction included)`,
      }),
      readout({
        value: dm0(b.az),
        label: `Direction · ${point16(b.az)}`,
        term: 'azimuth, Zn',
        tip: 'Bearing from true north, clockwise: 90° east, 180° south, 270° west',
      }),
    ),
    h(
      'div',
      { class: 'sf-evcards' },
      eventCard('rise', riseWord(b), p.rise.jd, `${bearing(p.rise.az!)} ${point16(p.rise.az!)}`, `Where the ${b.body} rises: its direction along the horizon`),
      eventCard(
        'transit',
        'Highest',
        p.transit.jd,
        `${dm0(p.transit.alt!)} S`,
        b.kind === 'sun' ? 'Highest in the sky, due south: local noon, the moment for a noon sight' : `Highest in the sky, due south (the ${b.body}’s transit)`,
      ),
      eventCard(
        'set',
        setWord(b),
        p.set.jd,
        `${bearing(p.set.az!)} ${point16(p.set.az!)}`,
        `Where the ${b.body} sets: its direction along the horizon`,
        setDay,
      ),
    ),
    ...(b.kind === 'sun' ? sunExtras(b) : b.kind === 'moon' ? moonExtras(b, s) : []),
    kv('eye', 'Brightness (magnitude)', mag(b.magnitude), { tip: 'Magnitude: the lower the number, the brighter. Sirius is −1.5; the faintest stars you can see are about 6.' }),
    h(
      'details',
      { class: 'sf-details' },
      h('summary', {}, 'Navigator’s details', icon('chevron-down')),
      h('div', { class: 'sf-details__grid' }, ...details.map(([k, v]) => kv(null, k, v))),
    ),
  );
  return sec.el;
}

function skyNowSection(s: Scenario): HTMLElement {
  const moon = [...s.up, ...s.below].find((b) => b.body === 'Moon');
  const sec = section('In the sky now', {
    class: 'sf-skynow',
    aside: h('span', { class: 'sf-section__meta' }, `${s.up.filter((b) => b.kind !== 'star').length} bodies · ${s.starsUp} stars`),
  });
  const hidden = s.phase === 'day';
  sec.body.append(
    h(
      'div',
      { class: 'sf-bodylist__head', 'aria-hidden': 'true' },
      h('span', {}),
      h('span', {}, 'Body'),
      h('span', {}, 'Height'),
      h('span', {}, 'Direction'),
      h('span', { 'data-tip': 'Brightness (magnitude): lower is brighter' }, 'Mag.'),
    ),
    h(
      'ul',
      { class: 'sf-bodylist' },
      ...s.up.map((b) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'sf-bodyrow',
              'data-kind': b.kind,
              'aria-pressed': String(b.body === s.selected.body),
              'aria-label': `${b.body}: ${Math.round(b.alt)} degrees up, direction ${Math.round(b.az)} degrees`,
            },
            b.kind === 'moon' && b.illuminated !== undefined
              ? phaseDisc({ illuminated: b.illuminated, limbFromUpDeg: b.limbFromUp ?? 270, size: 18 })
              : bodyGlyph(b.body, { kind: b.kind }),
            h('span', { class: 'sf-bodyrow__name' }, b.body),
            h('span', { class: 'sf-bodyrow__alt' }, `${Math.round(b.alt)}°`),
            h('span', { class: 'sf-bodyrow__dir' }, `${bearing(b.az)} ${point16(b.az)}`),
            h('span', { class: 'sf-bodyrow__mag' }, mag(b.magnitude)),
          ),
        ),
      ),
    ),
    h(
      'p',
      { class: 'sf-skynow__foot' },
      bodyGlyph('Star', { kind: 'star' }),
      h(
        'span',
        {},
        hidden
          ? `${s.starsUp} of the 58 navigational stars are above the horizon, hidden by daylight.`
          : `${s.starsUp} of the 58 navigational stars are up; the ${s.starsListed} brightest are listed.`,
      ),
    ),
    h(
      'p',
      { class: 'sf-skynow__foot' },
      moon && moon.alt <= 0
        ? phaseDisc({ illuminated: moon.illuminated!, limbFromUpDeg: moon.limbFromUp!, size: 16 })
        : icon('set'),
      h(
        'span',
        {},
        'Below the horizon: ',
        ...s.below.flatMap((b, i) => [
          i ? ', ' : '',
          b.body === 'Moon'
            ? h('span', {}, h('strong', {}, 'Moon'), ` (${Math.round(b.illuminated! * 100)}% lit, rises ${hm(at(17.9114), ZONE)})`)
            : b.body,
        ]),
        '.',
      ),
    ),
  );
  return sec.el;
}

function sightsSection(s: Scenario): HTMLElement {
  const sec = section('Tonight’s star sights', { class: 'sf-sights', aside: badge('soon', { text: 'Coming' }) });
  const start = hm(at(SUN_EVENTS.civil_dusk.h), ZONE);
  const end = hm(at(SUN_EVENTS.nautical_dusk.h), ZONE);
  const z = zoneName(s.jd);
  sec.body.append(
    h(
      'div',
      { class: 'sf-card sf-card--dashed sf-sights__card' },
      icon('sextant'),
      h(
        'div',
        {},
        h('strong', {}, s.phase === 'nautical' ? `Now, until ${end} ${z}` : `Nautical twilight ${start}–${end} ${z}`),
        'Horizon and bright stars both visible. The best stars to shoot, with predicted sextant readings and bearings, will be listed here.',
      ),
    ),
  );
  return sec.el;
}

function panel(s: Scenario): HTMLElement {
  return h(
    'aside',
    { class: 'sf-panel', 'aria-label': 'Place, time and sky' },
    h('div', { class: 'sf-panel__grab', 'aria-hidden': 'true' }),
    views(),
    search(),
    h(
      'div',
      { class: 'sf-panel__scroll' },
      placeSection(s),
      nowSection(s),
      selectedSection(s),
      skyNowSection(s),
      sightsSection(s),
      h(
        'p',
        { class: 'sf-panel__end' },
        'Design mockup: every number here was produced once by the mock engine for 24 September 2026 and typed in. The explorer reads the SkyFix Lab core instead.',
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------------

function legend(): HTMLElement {
  // A joined scale, so neighbouring bands show their difference; every band is named.
  const band = (name: string, token: string | null, tip: string): HTMLElement =>
    h(
      'span',
      { class: 'sf-legend__band', 'data-tip': tip },
      h('span', {
        class: 'sf-legend__swatch',
        style: `background:${token ? `color-mix(in srgb, var(--map-shade) calc(var(${token}) * 100%), var(--map-land))` : 'var(--map-land)'}`,
      }),
      h('span', { class: 'sf-legend__name' }, name),
    );
  return h(
    'div',
    { class: 'sf-legend sf-float', role: 'note', 'aria-label': 'Map shading: day, civil, nautical and astronomical twilight, night' },
    h('span', { class: 'sf-legend__title' }, 'Shading'),
    h(
      'span',
      { class: 'sf-legend__scale' },
      band('Day', null, PHASE_TIP.day),
      band('Civil', '--shade-civil', `Civil twilight. ${PHASE_TIP.civil}`),
      band('Nautical', '--shade-nautical', `Nautical twilight. ${PHASE_TIP.nautical}`),
      band('Astro.', '--shade-astronomical', `Astronomical twilight. ${PHASE_TIP.astronomical}`),
      band('Night', '--shade-night', PHASE_TIP.night),
    ),
  );
}

function stage(onProjection?: (value: 'flat' | 'globe') => void): {
  el: HTMLElement;
  mapHost: HTMLElement;
  toggle: HTMLButtonElement;
  projection: Segmented<'flat' | 'globe'>;
  zoomIn: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
  recenter: HTMLButtonElement;
} {
  const mapHost = h('div', { class: 'sf-stage__map', id: 'map', 'aria-label': 'World map', role: 'region' });
  const toggle = h(
    'button',
    { type: 'button', class: 'sf-panel-toggle', 'aria-label': 'Hide the panel', 'aria-expanded': 'true', 'data-tip': 'Hide the panel' },
    icon('chevron-left'),
  );
  const projection = segmented<'flat' | 'globe'>({
    label: 'Map projection',
    value: 'flat',
    onChange: onProjection,
    size: 'sm',
    class: 'sf-float',
    options: [
      { value: 'flat', label: 'Chart', icon: 'map', tip: 'Flat chart (Mercator)' },
      { value: 'globe', label: 'Globe', icon: 'globe', tip: 'Globe' },
    ],
  });
  const zoomIn = iconButton('plus', 'Zoom in', { variant: 'secondary' });
  const zoomOut = iconButton('minus', 'Zoom out', { variant: 'secondary' });
  const recenter = iconButton('locate', 'Centre the map on the place', {
    variant: 'secondary',
    class: 'sf-float',
    tip: 'Centre on the place',
  });
  const el = h(
    'main',
    { class: 'sf-stage', id: 'stage' },
    h('div', { class: 'sf-stage__fill' }, mapHost),
    toggle,
    h(
      'div',
      { class: 'sf-overlay sf-overlay--tr sf-on-stage' },
      projection.el,
      button({ label: 'Layers', icon: 'layers', variant: 'secondary', size: 'sm', class: 'sf-float sf-layers-btn', tip: 'Twilight, ground points, circles of position, grid, street map' }),
    ),
    h('div', { class: 'sf-overlay sf-overlay--r sf-on-stage' }, h('div', { class: 'sf-btn-group' }, zoomIn, zoomOut), recenter),
    h('div', { class: 'sf-overlay sf-overlay--bl sf-on-stage' }, legend()),
    h('div', { class: 'sf-overlay sf-overlay--br sf-on-stage' }, h('span', { class: 'sf-attribution' }, 'Map data: Natural Earth')),
  );
  return { el, mapHost, toggle, projection, zoomIn, zoomOut, recenter };
}

export interface FrameHandlers {
  onTheme?: (theme: ThemeName) => void;
  onProjection?: (value: 'flat' | 'globe') => void;
}

export function buildFrame(theme: ThemeName, scenario: Scenario, handlers: FrameHandlers = {}): Frame {
  const bar = appbar(theme, handlers.onTheme);
  const tb = timebar(scenario);
  const st = stage(handlers.onProjection);
  const root = h('div', { class: 'sf-app', 'data-panel': 'open', 'data-sheet': 'peek' }, bar.el, tb.el, panel(scenario), st.el);
  return {
    root,
    mapHost: st.mapHost,
    stage: st.el,
    ribbon: tb.ribbon,
    theme: bar.theme,
    themeCycle: bar.cycle,
    panelToggle: st.toggle,
    projection: st.projection,
    zoomIn: st.zoomIn,
    zoomOut: st.zoomOut,
    recenter: st.recenter,
  };
}
