/**
 * DESIGN MOCKUP: the explorer's frame and panel content, built from the design-system
 * primitives with the hard-coded numbers of `data.ts`. The phase-2 shell builds the same
 * markup from the store and the engine.
 */

import { h } from '../../dom.js';
import { formatLat, formatLon } from '../../format.js';
import { bodyGlyph, phaseDisc } from '../theme/glyphs.js';
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
import { createRibbon, type Ribbon, type RibbonHour } from '../timebar/ribbon.js';
import { formatHours, formatOffset, msFromJd, UTC_ZONE, zoneOffsetMs, zoneShortName } from '../time.js';
import {
  at,
  BODIES,
  DAY_END,
  DAY_START,
  MOON_EVENTS,
  NOW_JD,
  PHASES,
  PLACE,
  STARS_ABOVE,
  SUN_EVENTS,
  ZONE,
} from './data.js';
import { bearing, dateLabel, dateLong, decl, dm0, dm1, hm, mag, point16 } from './fmt.js';

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

const PHASE_LABEL = {
  day: 'Daylight',
  civil: 'Civil twilight',
  nautical: 'Nautical twilight',
  astronomical: 'Astronomical twilight',
  night: 'Night',
} as const;

const PHASE_TIP = {
  day: 'The Sun is up.',
  civil: 'Bright twilight: the horizon is sharp; the brightest planets and stars appear.',
  nautical: 'Horizon and stars both visible: the time for star sights.',
  astronomical: 'Too dark to see the horizon; the sky is not yet fully dark.',
  night: 'Full darkness: stars are bright but the horizon cannot be seen.',
} as const;

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
        class: 'sf-appbar__wide',
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

function timebar(): { el: HTMLElement; ribbon: Ribbon } {
  const localNow = hm(NOW_JD, ZONE);
  const zoneName = zoneShortName(NOW_JD, ZONE);
  const ribbon = createRibbon({
    window: [DAY_START, DAY_END],
    phases: PHASES,
    hours: ribbonHours(),
    marks: [
      { kind: 'rise', jd: at(SUN_EVENTS.rise.h), label: hm(at(SUN_EVENTS.rise.h), ZONE), tip: `Sunrise ${hm(at(SUN_EVENTS.rise.h), ZONE)} ${zoneName}` },
      {
        kind: 'transit',
        jd: at(SUN_EVENTS.transit.h),
        label: hm(at(SUN_EVENTS.transit.h), ZONE),
        tip: `Highest (transit) ${hm(at(SUN_EVENTS.transit.h), ZONE)} ${zoneName}`,
      },
      { kind: 'set', jd: at(SUN_EVENTS.set.h), label: hm(at(SUN_EVENTS.set.h), ZONE), tip: `Sunset ${hm(at(SUN_EVENTS.set.h), ZONE)} ${zoneName}` },
    ],
    jd: NOW_JD,
    glyph: 'sun',
    valueText: `${localNow} ${zoneName}, ${dateLong(NOW_JD, ZONE)}`,
    bubbleText: `${localNow} ${zoneName}`,
    nowJd: NOW_JD,
    phaseTip: (p) => `${PHASE_LABEL[p.phase]} ${hm(p.jd_start, ZONE)}–${p.jd_end >= DAY_END ? '24:00' : hm(p.jd_end, ZONE)}. ${PHASE_TIP[p.phase]}`,
  });

  const date = dateLabel(NOW_JD, ZONE, { year: false });
  const year = dateLabel(NOW_JD, ZONE).slice(date.length);
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
          h('span', {}, date),
          h('span', { class: 'sf-tb-date__year' }, year),
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
          h('span', { class: 'sf-tb-clock__zone', 'data-tip': `America/New_York, ${formatOffset(zoneOffsetMs(msFromJd(NOW_JD), ZONE))}` }, zoneName),
          h('output', { class: 'sf-tb-clock__utc' }, `${utc(NOW_JD)} UTC`),
        ),
      ),
    ),
    ribbon.el,
    h(
      'div',
      { class: 'sf-tb-transport' },
      button({
        label: 'Now',
        variant: 'secondary',
        class: 'sf-tb-now',
        pressed: true,
        tip: 'Following the clock. Press to come back to now at any time (N).',
        attrs: { 'aria-label': 'Now: follow the clock' },
      }),
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
  const nowButton = el.querySelector('.sf-tb-now')!;
  nowButton.prepend(h('span', { class: 'sf-live-dot', 'aria-hidden': 'true' }));
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

function placeSection(): HTMLElement {
  const s = section('Place', {
    class: 'sf-place',
    aside: button({ label: 'Edit', icon: 'edit', variant: 'ghost', size: 'sm', tip: 'Coordinates, time zone and height of eye' }),
  });
  const zoneName = zoneShortName(NOW_JD, ZONE);
  s.body.append(
    h('p', { class: 'sf-place__name' }, PLACE.label),
    h('p', { class: 'sf-place__coords' }, h('span', {}, formatLat(PLACE.lat_deg)), h('span', {}, formatLon(PLACE.lon_deg))),
    kv('clock', 'Time zone', h('span', {}, zoneName, ' ', h('small', {}, formatOffset(zoneOffsetMs(msFromJd(NOW_JD), ZONE)))), { tip: 'America/New_York, from the place. Times are shown here with UTC beside them.' }),
    kv('eyeheight', 'Height of eye', `${PLACE.height_of_eye_m} m`, {
      tip: 'Your eye above the sea: sets the dip of the horizon for sights',
    }),
  );
  return s.el;
}

function nowSection(): HTMLElement {
  const s = section('Now', {
    class: 'sf-now',
    aside: h('span', { class: 'sf-section__meta' }, `${dateLabel(NOW_JD, ZONE, { year: false })}, ${hm(NOW_JD, ZONE)}`),
  });
  const naut0 = hm(at(SUN_EVENTS.civil_dusk.h), ZONE);
  const naut1 = hm(at(SUN_EVENTS.nautical_dusk.h), ZONE);
  s.body.append(
    h('div', { class: 'sf-now__phase' }, phaseChip('day', 'Daylight', icon('sun'))),
    h(
      'p',
      { class: 'sf-now__meaning' },
      'The Sun is up: Sun sights are possible now. Stars stay hidden until ',
      h('strong', {}, `nautical twilight, ${naut0}–${naut1}`),
      ', the time for star sights.',
    ),
  );
  return s.el;
}

function eventCard(kind: 'rise' | 'transit' | 'set', title: string, term: string, jd: number, where: string, whereTip: string): HTMLElement {
  return h(
    'div',
    { class: 'sf-evcard', 'data-kind': kind, 'data-tip': whereTip },
    h('div', { class: 'sf-evcard__head' }, icon(kind), h('span', {}, title)),
    h('div', { class: 'sf-evcard__time sf-num' }, hm(jd, ZONE)),
    h('div', { class: 'sf-evcard__utc sf-num' }, `${utc(jd)} UTC`),
    h('div', { class: 'sf-evcard__where sf-num' }, where),
    h('div', { class: 'sf-evcard__term', 'data-term': '' }, term),
  );
}

function selectedSection(): HTMLElement {
  const sun = BODIES.find((b) => b.body === 'Sun')!;
  const s = section('Selected', {
    class: 'sf-selected',
    aside: chip({ label: 'Sun', lead: bodyGlyph('Sun'), caret: true, tip: 'Choose another body: Moon, planets, stars' }),
  });
  const shadow = 1 / Math.tan((sun.alt * Math.PI) / 180);
  const twilightRow = (name: string, phase: string, dawn: number, dusk: number, highlight: boolean, tip: string): HTMLElement =>
    h(
      'tr',
      { 'data-highlight': highlight ? '' : undefined, 'data-tip': tip },
      h('th', { scope: 'row' }, swatch(`var(--phase-${phase})`), name, highlight ? icon('sextant', { class: 'sf-twilight__mark' }) : null),
      h('td', { class: 'sf-num-r' }, hm(at(dawn), ZONE)),
      h('td', { class: 'sf-num-r' }, hm(at(dusk), ZONE)),
    );
  s.body.append(
    h(
      'div',
      { class: 'sf-readouts' },
      readout({
        value: dm0(sun.alt),
        label: 'Height above horizon',
        term: 'altitude',
        tip: 'How high the Sun’s centre looks above a sea-level horizon (refraction included)',
      }),
      readout({
        value: dm0(sun.az),
        label: `Direction · ${point16(sun.az)}`,
        term: 'azimuth, Zn',
        tip: 'Bearing from true north, clockwise: 90° east, 180° south, 270° west',
      }),
    ),
    h(
      'div',
      { class: 'sf-evcards' },
      eventCard('rise', 'Sunrise', 'rise', at(SUN_EVENTS.rise.h), `${bearing(SUN_EVENTS.rise.az)} ${point16(SUN_EVENTS.rise.az)}`, 'Where the Sun rises: its direction along the horizon'),
      eventCard('transit', 'Highest', 'transit', at(SUN_EVENTS.transit.h), `${dm0(SUN_EVENTS.transit.alt)} S`, 'Highest in the sky, due south: local noon, the moment for a noon sight'),
      eventCard('set', 'Sunset', 'set', at(SUN_EVENTS.set.h), `${bearing(SUN_EVENTS.set.az)} ${point16(SUN_EVENTS.set.az)}`, 'Where the Sun sets: its direction along the horizon'),
    ),
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
          twilightRow('Civil', 'civil', SUN_EVENTS.civil_dawn.h, SUN_EVENTS.civil_dusk.h, false, PHASE_TIP.civil),
          twilightRow('Nautical', 'nautical', SUN_EVENTS.nautical_dawn.h, SUN_EVENTS.nautical_dusk.h, true, PHASE_TIP.nautical),
          twilightRow('Astronomical', 'astronomical', SUN_EVENTS.astronomical_dawn.h, SUN_EVENTS.astronomical_dusk.h, false, PHASE_TIP.astronomical),
        ),
      ),
    ),
    kv('daylength', 'Length of day', formatHours(SUN_EVENTS.day_length_h)),
    kv('shadow', 'Shadow of a 1 m pole', `${shadow.toFixed(2)} m`, { tip: `Pointing ${bearing(sun.az - 180)}, away from the Sun` }),
    h(
      'details',
      { class: 'sf-details' },
      h('summary', {}, 'Navigator’s details', icon('chevron-down')),
      h(
        'div',
        { class: 'sf-details__grid' },
        kv(null, 'GHA', dm1(sun.gha)),
        kv(null, 'Declination', decl(sun.dec)),
        kv(null, 'Hc (tables)', dm1(sun.hc!)),
        kv(null, 'Zn (tables)', `${sun.zn!.toFixed(1)}°`),
        kv(null, 'Semi-diameter', `${sun.sd_arcmin!.toFixed(1)}′`),
        kv(null, 'Distance', `${(sun.distance_km! / 149597870.7).toFixed(4)} AU`),
      ),
    ),
  );
  return s.el;
}

function skyNowSection(): HTMLElement {
  const up = BODIES.filter((b) => b.alt > 0).sort((a, b) => b.alt - a.alt);
  const below = BODIES.filter((b) => b.alt <= 0);
  const moon = BODIES.find((b) => b.body === 'Moon')!;
  const s = section('In the sky now', {
    class: 'sf-skynow',
    aside: h('span', { class: 'sf-section__meta' }, `${up.length} up · ${STARS_ABOVE} stars`),
  });
  s.body.append(
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
      ...up.map((b) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'sf-bodyrow',
              'aria-pressed': String(b.body === 'Sun'),
              'aria-label': `${b.body}: ${Math.round(b.alt)} degrees up, direction ${Math.round(b.az)} degrees`,
            },
            bodyGlyph(b.body, { kind: b.kind }),
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
      h('span', {}, `${STARS_ABOVE} of the 58 navigational stars are above the horizon, hidden by daylight.`),
    ),
    h(
      'p',
      { class: 'sf-skynow__foot' },
      phaseDisc({ illuminated: moon.illuminated!, limbFromUpDeg: moon.limbFromUp!, size: 16 }),
      h(
        'span',
        {},
        'Below the horizon: ',
        h('strong', {}, 'Moon'),
        ` (${Math.round(moon.illuminated! * 100)}% lit, rises ${hm(at(MOON_EVENTS.rise.h), ZONE)})`,
        ...below.filter((b) => b.body !== 'Moon').map((b) => `, ${b.body}`),
        '.',
      ),
    ),
  );
  return s.el;
}

function sightsSection(): HTMLElement {
  const s = section('Tonight’s star sights', { class: 'sf-sights', aside: badge('soon', { text: 'Coming' }) });
  s.body.append(
    h(
      'div',
      { class: 'sf-card sf-card--dashed sf-sights__card' },
      icon('sextant'),
      h(
        'div',
        {},
        h('strong', {}, `Nautical twilight ${hm(at(SUN_EVENTS.civil_dusk.h), ZONE)}–${hm(at(SUN_EVENTS.nautical_dusk.h), ZONE)} ${zoneShortName(NOW_JD, ZONE)}`),
        'Horizon and bright stars both visible. The best stars to shoot, with predicted sextant readings and bearings, will be listed here.',
      ),
    ),
  );
  return s.el;
}

function panel(): HTMLElement {
  return h(
    'aside',
    { class: 'sf-panel', 'aria-label': 'Place, time and sky' },
    h('div', { class: 'sf-panel__grab', 'aria-hidden': 'true' }),
    views(),
    search(),
    h(
      'div',
      { class: 'sf-panel__scroll' },
      placeSection(),
      nowSection(),
      selectedSection(),
      skyNowSection(),
      sightsSection(),
      h(
        'p',
        { class: 'sf-panel__end' },
        'Design mockup: every number here was produced once by the mock engine for 24 September 2026, 16:30 EDT, and typed in. The explorer reads the SkyFix Lab core instead.',
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
      button({ label: 'Layers', icon: 'layers', variant: 'secondary', size: 'sm', class: 'sf-float', tip: 'Twilight, ground points, circles of position, grid, street map' }),
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

export function buildFrame(theme: ThemeName, handlers: FrameHandlers = {}): Frame {
  const bar = appbar(theme, handlers.onTheme);
  const tb = timebar();
  const st = stage(handlers.onProjection);
  const root = h('div', { class: 'sf-app', 'data-panel': 'open', 'data-sheet': 'peek' }, bar.el, tb.el, panel(), st.el);
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

export { PHASE_LABEL, PHASE_TIP };
