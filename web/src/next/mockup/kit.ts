/**
 * DESIGN KIT (`/next/mockup.html#screen=kit`): every token and primitive of the
 * explorer's design system in the current theme, for review and for the agents building
 * views. Static; nothing here reads the engine.
 */

import { h } from '../../dom.js';
import { bodyGlyph, moonPhaseName, phaseDisc } from '../theme/glyphs.js';
import { ICON_NAMES, icon } from '../theme/icons.js';
import {
  badge,
  button,
  chip,
  iconButton,
  kv,
  logoMark,
  menu,
  phaseChip,
  readout,
  segmented,
  switchRow,
} from '../theme/primitives.js';
import type { ThemeName } from '../theme/theme.js';
import { calendar } from '../timebar/calendar.js';
import { HONESTY } from './frame.js';

const COLOR_GROUPS: [string, string[]][] = [
  ['Chrome (bars and panel)', ['chrome-bg-0', 'chrome-bg', 'chrome-raised', 'chrome-raised-2', 'chrome-line', 'chrome-line-strong', 'chrome-ink', 'chrome-ink-2', 'chrome-ink-3', 'accent', 'accent-ink', 'focus']],
  ['Stage (map controls, content)', ['stage-bg', 'stage-surface', 'stage-surface-2', 'stage-line', 'stage-line-strong', 'stage-ink', 'stage-ink-2', 'stage-ink-3', 'stage-accent-ink', 'stage-focus']],
  ['Map', ['map-water', 'map-land', 'map-coast', 'map-border', 'map-shade', 'compass-ring', 'compass-label', 'observer']],
  ['Sky phases', ['phase-day', 'phase-civil', 'phase-nautical', 'phase-astronomical', 'phase-night']],
  ['Bodies', ['body-sun', 'body-moon', 'body-mercury', 'body-venus', 'body-mars', 'body-jupiter', 'body-saturn', 'body-uranus', 'body-neptune', 'body-star']],
  ['Events', ['event-rise', 'event-transit', 'event-set']],
  ['Status', ['caution', 'danger', 'ok', 'info']],
];

const BODIES: [string, 'sun' | 'moon' | 'planet' | 'star'][] = [
  ['Sun', 'sun'],
  ['Moon', 'moon'],
  ['Mercury', 'planet'],
  ['Venus', 'planet'],
  ['Mars', 'planet'],
  ['Jupiter', 'planet'],
  ['Saturn', 'planet'],
  ['Uranus', 'planet'],
  ['Neptune', 'planet'],
  ['Sirius', 'star'],
];

function block(title: string, note: string | null, ...children: (Node | null)[]): HTMLElement {
  return h(
    'section',
    { class: 'kit-block' },
    h('h2', { class: 'kit-block__title' }, title),
    note ? h('p', { class: 'kit-block__note' }, note) : null,
    ...children,
  );
}

function row(...children: (Node | string | null)[]): HTMLElement {
  return h('div', { class: 'kit-row' }, ...children);
}

function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

function colors(): HTMLElement {
  const wrap = h('div', { class: 'kit-colors' });
  const fill = (): void => {
    wrap.replaceChildren(
      ...COLOR_GROUPS.map(([title, names]) =>
        h(
          'div',
          { class: 'kit-colors__group' },
          h('h3', {}, title),
          h(
            'div',
            { class: 'kit-colors__grid' },
            ...names.map((n) =>
              h(
                'div',
                { class: 'kit-color' },
                h('span', { class: 'kit-color__chip', style: `background:var(--${n})` }),
                h('span', { class: 'kit-color__name' }, `--${n}`),
                h('span', { class: 'kit-color__value' }, tokenValue(n)),
              ),
            ),
          ),
        ),
      ),
    );
  };
  fill();
  new MutationObserver(fill).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return wrap;
}

function lines(): HTMLElement {
  const svgNs = 'http://www.w3.org/2000/svg';
  const items: [string, string, string, number][] = [
    ['Body now (solid)', 'var(--body-sun)', 'none', 3],
    ['Today’s path (solid)', 'var(--body-moon)', 'none', 2.6],
    ['Rise and dawn (dashed)', 'var(--event-rise)', 'var(--dash-rise)', 2.2],
    ['Set and dusk (dotted)', 'var(--event-set)', 'var(--dash-set)', 2.6],
    ['Below the horizon (thin, dashed)', 'var(--body-venus)', 'var(--dash-below)', 1.5],
    ['Circle of position (dash-dot)', 'var(--body-jupiter)', 'var(--dash-circle)', 2],
  ];
  return h(
    'div',
    { class: 'kit-lines' },
    ...items.map(([label, color, dash, width]) => {
      const svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('viewBox', '0 0 160 16');
      svg.setAttribute('width', '160');
      svg.setAttribute('height', '16');
      for (const [stroke, w] of [
        ['var(--line-halo)', width + 3],
        [color, width],
      ] as const) {
        const p = document.createElementNS(svgNs, 'path');
        p.setAttribute('d', 'M6 8H154');
        p.setAttribute('stroke', stroke);
        p.setAttribute('stroke-width', String(w));
        p.setAttribute('stroke-linecap', label.startsWith('Below') ? 'butt' : 'round');
        p.setAttribute('fill', 'none');
        if (dash !== 'none') p.setAttribute('style', `stroke-dasharray:${dash}`);
        svg.appendChild(p);
      }
      return h('div', { class: 'kit-line' }, svg, h('span', {}, label));
    }),
  );
}

export function renderKit(root: HTMLElement, theme: ThemeName, onTheme: (t: ThemeName) => void): void {
  const themeSeg = segmented<ThemeName>({
    label: 'Theme',
    value: theme,
    onChange: onTheme,
    options: [
      { value: 'light', label: 'Light', icon: 'sun' },
      { value: 'dark', label: 'Dark', icon: 'moon' },
      { value: 'night', label: 'Night vision', icon: 'eye' },
    ],
  });
  const speeds = menu(
    'Playback speed',
    [
      { value: '1', label: 'Real time', hint: '×1' },
      { value: '60', label: '1 minute per second', hint: '1 min/s' },
      { value: '600', label: '10 minutes per second', hint: '10 min/s' },
      { value: '3600', label: '1 hour per second', hint: '1 h/s' },
      { value: '86400', label: '1 day per second', hint: '1 d/s' },
      { value: '2629746', label: '1 month per second', hint: '1 mo/s' },
    ],
    '3600',
    () => undefined,
  );

  const page = h(
    'div',
    { class: 'kit' },
    h(
      'header',
      { class: 'sf-appbar kit-bar' },
      h('span', { class: 'sf-brand' }, logoMark(20), h('span', { class: 'sf-brand__text' }, 'SkyFix Lab · design kit')),
      h('span', { class: 'sf-appbar__rule' }),
      h(
        'div',
        { class: 'sf-honesty', role: 'note' },
        h('span', { class: 'sf-honesty__text' }, icon('caution'), HONESTY),
        badge('mock', { text: 'Design kit', tip: 'A design reference: every number on this page is a sample.' }),
      ),
      h('div', { class: 'sf-appbar__end' }, themeSeg.el),
    ),
    h(
      'main',
      { class: 'kit-main' },
      block('Colour tokens', 'One token per role; every theme defines the same set. Values shown for the current theme.', colors()),
      block(
        'Type',
        'Inter for words, JetBrains Mono for numbers, coordinates and times (tabular figures).',
        h(
          'div',
          { class: 'kit-type' },
          h('div', { class: 'kit-type__ui', style: 'font-size:var(--text-3xl)' }, 'Height above horizon · 30 px'),
          h('div', { class: 'kit-type__ui', style: 'font-size:var(--text-xl);font-weight:620' }, 'Nautical twilight · 19 px semibold'),
          h('div', { class: 'kit-type__ui', style: 'font-size:var(--text-base)' }, 'The horizon and the brightest stars are both visible. · 14 px'),
          h('div', { class: 'kit-type__ui', style: 'font-size:var(--text-md)' }, 'Panel text, rows and tables · 13 px'),
          h('div', { class: 'kit-type__ui kit-caps' }, 'Section title · 11 px caps'),
          h('div', { class: 'sf-num', style: 'font-size:var(--text-3xl);font-weight:560' }, '26° 02′  244° 44′'),
          h('div', { class: 'sf-num', style: 'font-size:var(--text-md)' }, '39° 57.2′ N · 075° 09.9′ W · 16:30:00 EDT · 20:30 UTC · 0123456789'),
        ),
      ),
      block(
        'Icons',
        'Drawn for this project on a 24-unit grid, stroked in the current text colour.',
        h(
          'div',
          { class: 'kit-icons' },
          ...ICON_NAMES.map((n) => h('div', { class: 'kit-icon' }, icon(n), h('span', {}, n))),
        ),
      ),
      block(
        'Bodies',
        'One colour and one glyph per body, everywhere; the name always goes with them.',
        row(...BODIES.map(([name, kind]) => chip({ label: name, lead: bodyGlyph(name, { kind }) }))),
        row(
          ...[0.03, 0.25, 0.5, 0.75, 0.96, 1].map((k, i) =>
            h(
              'span',
              { class: 'kit-phase' },
              phaseDisc({ illuminated: k, limbFromUpDeg: 270, size: 34 }),
              h('span', {}, moonPhaseName(k, i < 5)),
            ),
          ),
        ),
        row(...BODIES.map(([name, kind]) => h('span', { class: 'kit-glyph-halo' }, bodyGlyph(name, { kind, halo: true, size: 30 })))),
      ),
      block(
        'Lines on the map, the sky and the charts',
        'Colour and dash together; every line also carries a label where it is drawn.',
        lines(),
      ),
      block(
        'Controls on the chrome',
        null,
        h(
          'div',
          { class: 'kit-surface kit-surface--chrome' },
          row(
            button({ label: 'Primary', variant: 'primary' }),
            button({ label: 'Secondary' }),
            button({ label: 'Ghost', variant: 'ghost' }),
            button({ label: 'Outline', variant: 'outline' }),
            button({ label: 'Pressed', pressed: true }),
            button({ label: 'Disabled', attrs: { disabled: true } }),
          ),
          row(
            button({ label: 'Small', size: 'sm', icon: 'share' }),
            button({ label: 'Large', size: 'lg', icon: 'layers' }),
            iconButton('chevron-left', 'Previous'),
            iconButton('calendar', 'Calendar', { variant: 'secondary' }),
            button({ icon: 'play', variant: 'primary', ariaLabel: 'Play', class: 'sf-tb-play' }),
            button({ label: '1 h/s', icon: 'speed', iconAfter: 'chevron-down', variant: 'ghost', class: 'sf-tb-speed' }),
          ),
          row(
            segmented({
              label: 'Projection',
              value: 'flat',
              options: [
                { value: 'flat', label: 'Chart', icon: 'map' },
                { value: 'globe', label: 'Globe', icon: 'globe' },
              ],
            }).el,
            segmented({
              label: 'Theme',
              value: 'dark',
              size: 'sm',
              options: [
                { value: 'light', label: 'Light', icon: 'sun', iconOnly: true },
                { value: 'dark', label: 'Dark', icon: 'moon', iconOnly: true },
                { value: 'night', label: 'Night', icon: 'eye', iconOnly: true },
              ],
            }).el,
            chip({ label: 'Sun', lead: bodyGlyph('Sun'), caret: true }),
            chip({ label: 'Venus', lead: bodyGlyph('Venus'), selected: true, onClick: () => undefined }),
          ),
          row(
            h('label', { class: 'sf-field', style: 'width:280px' }, icon('search'), h('input', { class: 'sf-input', type: 'search', placeholder: 'Search a place or type coordinates' })),
            h('input', { class: 'sf-input sf-num', style: 'width:140px', value: '39° 57.2′ N' }),
          ),
          row(
            badge('wasm'),
            badge('hybrid'),
            badge('mock'),
            badge('simulated'),
            badge('real'),
            badge('soon', { text: 'Coming' }),
          ),
          row(
            phaseChip('day', 'Daylight', icon('sun')),
            phaseChip('civil', 'Civil twilight'),
            phaseChip('nautical', 'Nautical twilight', icon('sextant')),
            phaseChip('astronomical', 'Astronomical twilight'),
            phaseChip('night', 'Night', icon('moon')),
          ),
          h(
            'div',
            { class: 'kit-notices' },
            h('div', { class: 'sf-notice' }, icon('info'), h('span', {}, 'This build has no constellation boundaries yet, so boundary lines are not drawn.'), null),
            h('div', { class: 'sf-notice sf-notice--caution' }, icon('caution'), h('span', {}, 'Mock engine: every number on this page is illustrative.'), null),
            h('div', { class: 'sf-notice sf-notice--error' }, icon('caution'), h('span', {}, 'sky_state: the time is outside the coverage window (1990 to 2060).'), iconButton('close', 'Dismiss', { size: 'sm' })),
          ),
        ),
      ),
      block(
        'Panel content',
        null,
        h(
          'div',
          { class: 'kit-surface kit-surface--chrome kit-panel' },
          h(
            'div',
            { class: 'sf-readouts' },
            readout({ value: '26° 02′', label: 'Height above horizon', term: 'altitude' }),
            readout({ value: '244° 44′', unit: 'WSW', label: 'Direction', term: 'azimuth, Zn' }),
          ),
          kv('daylength', 'Length of day', '12 h 04 min'),
          kv('shadow', 'Shadow of a 1 m pole', '2.05 m'),
          kv('clock', 'Time zone', h('span', {}, 'EDT ', h('small', {}, 'UTC−4'))),
          h('div', { style: 'margin-top:8px' }, switchRow({ label: 'Day and night', checked: true }), switchRow({ label: 'Street map', note: 'online', checked: false })),
        ),
      ),
      block(
        'Popovers',
        'The calendar and the speed menu, as they open from the time bar.',
        row(
          h('div', { class: 'sf-popover kit-static', 'data-open': '' }, calendar({ view: { year: 2026, month: 9 }, selected: { year: 2026, month: 9, day: 24 }, today: { year: 2026, month: 9, day: 24 } })),
          h('div', { class: 'sf-popover kit-static', 'data-open': '' }, h('div', { class: 'sf-popover__title' }, 'Playback speed'), speeds),
          h('div', { class: 'sf-tooltip kit-static', 'data-open': '' }, 'Nautical twilight 19:21–19:53. Horizon and stars both visible: the time for star sights.'),
        ),
      ),
    ),
  );
  root.replaceChildren(page);
}
