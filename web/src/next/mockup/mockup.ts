/**
 * DESIGN MOCKUP entry (`/next/mockup.html`): a static, high-fidelity picture of the
 * explorer's Map view, time bar and side panel in the three themes, with a real map.
 * Every number is hard-coded (data.ts). Not the explorer: the real shell lives in
 * `src/next/shell/` and reads the engine.
 *
 * Address options (fragment, so nothing reaches a server):
 *   #theme=light|dark|night     default: follow the system
 *   #moment=afternoon|evening   16:30 EDT with the Sun, or 19:35 EDT with the Moon
 *   #screen=map|kit             the Map view (default) or the design kit
 *   #sheet=min|peek|full        phones: bottom-sheet position (default peek)
 *   #panel=closed               desktop: start with the panel hidden
 *   #scroll=<px>                desktop: scroll the panel (for screenshots of its lower half)
 */

import '../theme/index.js';
import '../timebar/timebar.css';
import '../panel/panel.css';
import './mockup.css';
import { h } from '../../dom.js';
import { bodyGlyph, phaseDisc } from '../theme/glyphs.js';
import { icon } from '../theme/icons.js';
import { installTooltips } from '../theme/primitives.js';
import { applyTheme, systemTheme, type ThemeName } from '../theme/theme.js';
import { drawCompass } from './compass.js';
import { PLACE, ZONE } from './data.js';
import { hm } from './fmt.js';
import { buildFrame } from './frame.js';
import { renderKit } from './kit.js';
import { createMockMap, type MockMap } from './map.js';
import { wirePopovers } from './popovers.js';
import { SCENARIOS, type Moment } from './scenario.js';

const THEMES: ThemeName[] = ['light', 'dark', 'night'];

function hashParams(): URLSearchParams {
  return new URLSearchParams(globalThis.location.hash.replace(/^#/, ''));
}

function writeHash(key: string, value: string): void {
  const p = hashParams();
  p.set(key, value);
  history.replaceState(null, '', `#${p.toString()}`);
}

const params = hashParams();
const requested = params.get('theme') as ThemeName | null;
let theme: ThemeName = requested && THEMES.includes(requested) ? requested : systemTheme();
applyTheme(theme);

const app = document.getElementById('app')!;
const markReady = (): void => {
  void document.fonts.ready.then(() =>
    requestAnimationFrame(() => requestAnimationFrame(() => (document.documentElement.dataset.ready = '1'))),
  );
};

if (params.get('screen') === 'kit') {
  renderKit(app, theme, (t) => {
    theme = t;
    applyTheme(t);
    writeHash('theme', t);
  });
  installTooltips(document.body);
  markReady();
} else {
  mountMapMockup();
}

function mountMapMockup(): void {
  const moment: Moment = params.get('moment') === 'evening' ? 'evening' : 'afternoon';
  const scenario = SCENARIOS[moment];
  let mock: MockMap | null = null;
  const setTheme = (t: ThemeName): void => {
    theme = t;
    applyTheme(t);
    frame.theme.set(t);
    frame.themeCycle.replaceChildren(icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'eye'));
    writeHash('theme', t);
    mock?.restyle();
  };
  const frame = buildFrame(theme, scenario, {
    onTheme: setTheme,
    onProjection: (v) => mock?.map.setProjection({ type: v === 'globe' ? 'globe' : 'mercator' }),
  });
  app.replaceChildren(frame.root);
  const sheet = params.get('sheet');
  if (sheet === 'min' || sheet === 'full' || sheet === 'peek') frame.root.dataset.sheet = sheet;
  if (params.get('panel') === 'closed') frame.root.dataset.panel = 'closed';
  installTooltips(document.body);

  const phone = matchMedia('(max-width: 767px)').matches;
  const timebar = frame.root.querySelector<HTMLElement>('.sf-timebar')!;
  const panel = frame.root.querySelector<HTMLElement>('.sf-panel')!;
  const sheetTop = (): void => frame.root.style.setProperty('--sheet-top', `${Math.round(timebar.getBoundingClientRect().bottom)}px`);
  sheetTop();
  const scroll = Number(params.get('scroll'));
  if (scroll > 0) panel.querySelector<HTMLElement>('.sf-panel__scroll')!.scrollTop = scroll;

  // The bottom sheet: the grab bar cycles min -> peek -> full on phones.
  const grab = panel.querySelector<HTMLElement>('.sf-panel__grab')!;
  grab.addEventListener('click', () => {
    const order = ['min', 'peek', 'full'];
    const next = order[(order.indexOf(frame.root.dataset.sheet ?? 'peek') + 1) % order.length]!;
    frame.root.dataset.sheet = next;
  });

  const visibleSheet = phone ? Math.round(innerHeight * 0.46) : 0;
  const stageRect = frame.stage.getBoundingClientRect();
  mock = createMockMap({
    container: frame.mapHost,
    center: phone ? [-80, 32] : [-61, 23.5],
    zoom: phone ? 1.3 : 2.4,
    subsolar: scenario.subsolar,
    padding: phone ? { bottom: Math.max(0, visibleSheet - (innerHeight - stageRect.bottom)) } : {},
  });
  const map = mock.map;

  // Compass at the place
  const s = scenario;
  const b = s.selected;
  const words = b.kind === 'moon' ? ['Moonrise', 'Moonset'] : ['Sunrise', 'Sunset'];
  const radius = phone ? 84 : 136;
  const compass = drawCompass({
    radius,
    colorToken: s.colorToken,
    glyph: s.glyph,
    path: { alt: s.path.alt, az: s.path.az },
    hourMarks: s.path.alt
      .map((alt, i) => ({ alt, az: s.path.az[i]! }))
      .filter((_, i) => i % s.path.stepsPerHour === 0),
    ...(s.band ? { band: s.band } : {}),
    // Phones have room only for the times; the icons and the panel carry the words.
    rise: { az: s.passage.rise.az!, label: `${phone ? '' : `${words[0]} `}${hm(s.passage.rise.jd, ZONE)}` },
    set: { az: s.passage.set.az!, label: `${phone ? '' : `${words[1]} `}${hm(s.passage.set.jd, ZONE)}` },
    transit: { alt: s.passage.transit.alt!, az: 180, label: `Highest ${hm(s.passage.transit.jd, ZONE)}` },
    now: { alt: b.alt, az: b.az, label: 'Now' },
    ...(b.kind === 'moon' && b.illuminated !== undefined
      ? { phase: { illuminated: b.illuminated, limbFromUpDeg: b.limbFromUp ?? 270 } }
      : {}),
    labels: true,
  });
  const place = h('span', { class: 'mk-compass__place', style: `top:calc(50% + ${radius + 12}px)` }, icon('pin'), PLACE.label);
  if (!phone) compass.appendChild(place);
  mock.addMarker([PLACE.lon_deg, PLACE.lat_deg], compass);

  // Ground points: where each body is straight overhead
  for (const gp of s.groundPoints) {
    const el = h(
      'div',
      { class: 'mk-gp', 'data-tip': `Ground point: the ${gp.body} is straight overhead here` },
      gp.kind === 'moon' && gp.illuminated !== undefined
        ? phaseDisc({ illuminated: gp.illuminated, limbFromUpDeg: gp.limbFromUp ?? 270, size: 20 })
        : bodyGlyph(gp.body, { kind: gp.kind, halo: true }),
      h('span', { class: 'mk-gp__label' }, gp.body, ' ', h('small', {}, 'overhead')),
    );
    mock.addMarker([gp.gp[1], gp.gp[0]], el);
  }

  frame.zoomIn.addEventListener('click', () => map.zoomIn());
  frame.zoomOut.addEventListener('click', () => map.zoomOut());
  frame.recenter.addEventListener('click', () => map.easeTo({ center: [PLACE.lon_deg, PLACE.lat_deg] }));
  frame.panelToggle.addEventListener('click', () => {
    const closed = frame.root.dataset.panel !== 'closed';
    frame.root.dataset.panel = closed ? 'closed' : 'open';
    frame.panelToggle.setAttribute('aria-expanded', String(!closed));
    frame.panelToggle.setAttribute('aria-label', closed ? 'Show the panel' : 'Hide the panel');
    frame.panelToggle.dataset.tip = closed ? 'Show the panel' : 'Hide the panel';
    frame.panelToggle.replaceChildren(icon(closed ? 'chevron-right' : 'chevron-left'));
  });
  frame.root.addEventListener('transitionend', (e) => {
    if (e.target === frame.root) map.resize();
  });
  frame.themeCycle.addEventListener('click', () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!));
  addEventListener('resize', sheetTop);

  const pops = wirePopovers(frame.root, { year: 2026, month: 9, day: 24 }, true);
  const open = params.get('open');
  const which = ['speed', 'calendar', 'layers', 'share'].indexOf(open ?? '');

  void mock.ready.then(() => {
    if (which >= 0) pops[which]?.open();
    markReady();
  });
}
