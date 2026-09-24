/**
 * DEVELOPER PAGE for the Navigate view (`/next/dev-navigate.html`). OWNER: navigate agent.
 *
 * Boots the explorer's engine, store and scheduler exactly as `main.ts` does, and mounts
 * the Navigate view on the stage with a chrome-coloured side column holding "Tonight's star
 * sights", the way the shell's side panel will. Everything is settable from the address
 * fragment, so screenshots are reproducible:
 *
 *   #example=dusk-stars&method=fix&theme=night&place=philadelphia&date=2026-09-24T19:00
 *   &angles=dm&panel=0&autosave=0&open=obs-3&scroll=.sfn-chart&view=map
 *
 * `date` is a wall-clock time in the place's own zone (it sets the time bar, which the
 * planner uses). Nothing is kept: the working session is not saved unless `autosave=1`,
 * and the explorer's preferences are never touched.
 */

import { h } from '../../../dom.js';
import { createScheduler, memoEngine, type Ctx } from '../../component.js';
import { selectEngine } from '../../engine/index.js';
import { createNotices } from '../../notices.js';
import { bindTimeKeys, goNow, setTime, startPlayback } from '../../playback.js';
import { createExplorerStore, type AngleFormat, type Theme } from '../../state.js';
import { applyTheme, installTooltips, section } from '../../theme/index.js';
import { formatWithUtc, jdFromWallClock, resolveZone, type ZoneChoice } from '../../time.js';
import { EXAMPLES } from '../examples.js';
import { navigateView, tonight } from '../index.js';
import { METHODS, type MethodId } from '../text.js';

interface Place {
  id: string;
  label: string;
  lat: number;
  lon: number;
  zone: ZoneChoice;
}

const PLACES: Place[] = [
  { id: 'philadelphia', label: 'Philadelphia City Hall', lat: 39.9526, lon: -75.1652, zone: { kind: 'iana', zone: 'America/New_York' } },
  { id: 'atsea', label: 'Mid-Atlantic (nautical zone time)', lat: 30.0, lon: -40.0, zone: { kind: 'nautical' } },
  { id: 'timor', label: 'Timor Sea', lat: -12.2, lon: 128.5, zone: { kind: 'nautical' } },
  { id: 'greenwich', label: 'Royal Observatory Greenwich', lat: 51.4779, lon: -0.0015, zone: { kind: 'iana', zone: 'Europe/London' } },
  { id: 'tromso', label: 'Tromsø', lat: 69.6492, lon: 18.9553, zone: { kind: 'iana', zone: 'Europe/Oslo' } },
];
const THEMES: Theme[] = ['light', 'dark', 'night'];

function params(): URLSearchParams {
  return new URLSearchParams(location.hash.replace(/^#/, ''));
}

async function boot(root: HTMLElement): Promise<void> {
  const p = params();
  const place = PLACES.find((x) => x.id === p.get('place')) ?? PLACES[0]!;
  const theme = (THEMES as string[]).includes(p.get('theme') ?? '') ? (p.get('theme') as Theme) : 'light';
  const method = METHODS.some((m) => m.id === p.get('method')) ? (p.get('method') as MethodId) : undefined;
  const example = p.get('example') ?? undefined;
  const angles = (['dm', 'dms', 'decimal'] as AngleFormat[]).includes(p.get('angles') as AngleFormat) ? (p.get('angles') as AngleFormat) : 'dm';
  const showPanel = p.get('panel') !== '0';
  applyTheme(theme);

  const selection = await selectEngine();
  const notices = createNotices();
  selection.notices.forEach((n, i) => notices.push(n.level, n.text, { key: `engine-${i}`, persistent: n.level !== 'info' }));
  const zone = resolveZone(place.zone, place.lon);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(p.get('date') ?? '');
  const jd = m ? jdFromWallClock({ year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: m[4] ? +m[4] : 12, minute: m[5] ? +m[5] : 0 }, zone) : null;
  const store = createExplorerStore({
    storage: null,
    initial: {
      observer: { lat_deg: place.lat, lon_deg: place.lon, height_m: 0, label: place.label, zone: place.zone },
      ...(jd !== null ? { time: { jd_utc: jd, live: false, playing: false } } : {}),
      settings: { theme, angleFormat: angles, height_of_eye_m: 2.5, index_correction_arcmin: -1.2 },
      view: 'navigate',
    },
  });
  const scheduler = createScheduler();
  const engine = memoEngine(selection.engine, { freeze: import.meta.env.DEV });
  const ctx: Ctx = { store, engine, notices, scheduler };
  startPlayback(store, scheduler);
  bindTimeKeys(window, store);

  // --- The developer bar ------------------------------------------------------------------
  const exampleSelect = h('select', { 'aria-label': 'Example' });
  exampleSelect.append(h('option', { value: '' }, '(no example)'), ...EXAMPLES.map((e) => h('option', { value: e.id, selected: e.id === example }, e.title)));
  exampleSelect.addEventListener('change', () => {
    const q = params();
    if (exampleSelect.value) q.set('example', exampleSelect.value);
    else q.delete('example');
    q.delete('method');
    location.hash = q.toString();
    location.reload();
  });
  const themeSelect = h('select', { 'aria-label': 'Theme' });
  for (const t of THEMES) themeSelect.append(h('option', { value: t, selected: t === theme }, t));
  themeSelect.addEventListener('change', () => {
    applyTheme(themeSelect.value as Theme);
    store.patch({ settings: { theme: themeSelect.value as Theme } });
  });
  const placeSelect = h('select', { 'aria-label': 'Place' });
  for (const x of PLACES) placeSelect.append(h('option', { value: x.id, selected: x.id === place.id }, x.label));
  placeSelect.addEventListener('change', () => {
    const x = PLACES.find((y) => y.id === placeSelect.value)!;
    store.patch({ observer: { lat_deg: x.lat, lon_deg: x.lon, height_m: 0, label: x.label, zone: x.zone } });
  });
  const nowButton = h('button', { type: 'button' }, 'Now');
  nowButton.addEventListener('click', () => goNow(store));
  const dateInput = h('input', { type: 'datetime-local', 'aria-label': 'Time bar (place’s zone)' });
  dateInput.addEventListener('change', () => {
    const d = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(dateInput.value);
    if (!d) return;
    const s = store.get();
    setTime(store, jdFromWallClock({ year: +d[1]!, month: +d[2]!, day: +d[3]!, hour: +d[4]!, minute: +d[5]! }, resolveZone(s.observer.zone, s.observer.lon_deg)));
  });
  const timeOut = h('output', {});
  const viewOut = h('output', {});
  const bar = h(
    'div',
    { class: 'dev-bar' },
    h('strong', {}, 'Navigate · developer page'),
    h('span', { class: `dev-engine dev-engine--${selection.engine.kind}` }, selection.engine.kind === 'mock' ? 'MOCK engine (illustrative)' : 'WASM core'),
    exampleSelect,
    placeSelect,
    dateInput,
    nowButton,
    themeSelect,
    timeOut,
    viewOut,
  );
  const noticeList = h('div', { class: 'dev-notices' });
  const renderNotices = (): void => {
    noticeList.replaceChildren(...notices.list().map((n) => h('p', { class: `dev-notice dev-notice--${n.level}` }, n.text)));
  };
  notices.subscribe(renderNotices);
  renderNotices();

  const panel = h('aside', { class: 'dev-panel', 'aria-label': 'Side panel (as the shell will show it)' });
  const tonightSection = section('Tonight’s star sights', { icon: 'sextant' });
  panel.append(tonightSection.el);
  const stage = h('main', { class: 'dev-stage' });
  root.replaceChildren(bar, noticeList, h('div', { class: `dev-frame${showPanel ? '' : ' dev-frame--nopanel'}` }, panel, stage));

  const style = document.createElement('style');
  style.textContent = `
    #app { display: flex; flex-direction: column; height: 100vh; }
    .dev-bar { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; padding:8px 16px;
      background: var(--chrome-bg-0); color: var(--chrome-ink); font: 12px/1.4 var(--font-ui); }
    .dev-bar select, .dev-bar input, .dev-bar button { font: inherit; background: var(--chrome-raised);
      color: inherit; border: 1px solid var(--chrome-line-strong); border-radius: 6px; padding: 3px 6px; }
    .dev-engine { padding: 1px 8px; border-radius: 999px; font-weight: 600; }
    .dev-engine--mock { background: var(--caution); color: var(--on-caution); }
    .dev-engine--wasm { background: var(--ok); color: var(--chrome-bg-0); }
    .dev-bar output { font-family: var(--font-num); color: var(--chrome-ink-2); }
    .dev-notices p { margin: 0; padding: 4px 16px; font: 12px/1.4 var(--font-ui); background: var(--caution); color: var(--on-caution); }
    .dev-frame { flex: 1; min-height: 0; display: grid; grid-template-columns: var(--panel-width) minmax(0, 1fr); }
    .dev-frame--nopanel { grid-template-columns: minmax(0, 1fr); }
    .dev-frame--nopanel .dev-panel { display: none; }
    .dev-panel { overflow-y: auto; background: var(--chrome-bg); color: var(--chrome-ink); border-right: 1px solid var(--chrome-line); }
    .dev-stage { min-height: 0; min-width: 0; background: var(--stage-bg); }
    @media (max-width: 767px) {
      .dev-frame { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
      .dev-panel { order: 2; max-height: 40vh; border-right: 0; border-top: 1px solid var(--chrome-line); }
    }
  `;
  document.head.append(style);
  installTooltips(document.body);

  const autosave = p.get('autosave') === '1';
  const navigateMount = navigateView({ storage: autosave ? undefined : null, ...(method ? { method } : {}), ...(example ? { example } : {}) });
  // "Show on the map" switches the explorer's view to the map: mount the map agent's view
  // here then (with the Navigate view's overlays on it), and come back with the dev bar.
  let mounted: { destroy(): void } | null = null;
  let mountedView = '';
  const back = h('button', { type: 'button', hidden: true }, '← Back to Navigate');
  back.addEventListener('click', () => store.patch({ view: 'navigate' }));
  bar.append(back);
  const mountView = async (v: string): Promise<void> => {
    const want = v === 'map' || v === 'globe' ? 'map' : 'navigate';
    if (want === mountedView) return;
    mountedView = want;
    mounted?.destroy();
    stage.replaceChildren();
    back.hidden = want !== 'map';
    if (want === 'map') {
      const { mapView } = await import('../../map/index.js');
      mounted = mapView(stage, ctx);
    } else {
      mounted = navigateMount(stage, ctx);
    }
  };
  void mountView(p.get('view') === 'map' ? 'map' : 'navigate');
  store.select((st) => st.view, (v) => void mountView(v));
  if (p.get('view') === 'map') store.patch({ view: 'map' });
  if (showPanel) tonight(tonightSection.body, ctx);

  const sync = (): void => {
    const s = store.get();
    timeOut.textContent = formatWithUtc(s.time.jd_utc, resolveZone(s.observer.zone, s.observer.lon_deg));
    viewOut.textContent = s.view === 'navigate' ? '' : `view: ${s.view}`;
  };
  sync();
  store.subscribe(sync);

  // "Ready" for screenshots: fonts loaded and the method's first answer (or status) drawn.
  const markReady = (): void => {
    const results = stage.querySelector('.sfn-method__results');
    const status = stage.querySelector('.sfn-method__status');
    const busy = stage.querySelector('.sfn-busy');
    const drawn = (results && results.childElementCount > 0) || (status && status.childElementCount > 0 && !busy);
    if (drawn && document.fonts.status === 'loaded') {
      // `open=<sight id>`: expand that sight's workings (for screenshots).
      const openId = p.get('open');
      if (openId) (stage.querySelector(`[data-toggle="${CSS.escape(openId)}"]`) as HTMLButtonElement | null)?.click();
      // `scroll=<selector>`: bring a part of the view to the top (for screenshots).
      const target = p.get('scroll');
      if (target) setTimeout(() => stage.querySelector(target)?.scrollIntoView({ block: 'start' }), 150);
      document.documentElement.dataset.ready = '1';
    } else setTimeout(markReady, 100);
  };
  void document.fonts.ready.then(markReady);
  if (import.meta.env.DEV) (globalThis as { __navigate?: unknown }).__navigate = { ctx, store };
}

const app = document.getElementById('app');
if (app) {
  boot(app).catch((error: unknown) => {
    console.error(error);
    app.textContent = `The Navigate developer page could not start: ${error instanceof Error ? error.message : String(error)}`;
  });
}
