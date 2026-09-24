/**
 * DEVELOPER PAGE for the Charts view (`/next/dev-charts.html`). OWNER: charts agent.
 *
 * Boots the explorer's engine, store and scheduler exactly as `main.ts` does and mounts the
 * Charts view alone, with a small toolbar for the place, time, zone and theme. Everything is
 * also settable from the address fragment, so screenshots are reproducible:
 *
 *   #place=tromso&date=2026-06-21T13:00&theme=dark&tab=year&mode=table&body=Vega&zone=utc
 *
 * `date` is a wall-clock time in the place's own zone. Nothing here is persisted: the store
 * gets no storage, so this page never touches the explorer's saved preferences.
 */

import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { h } from '../../../dom.js';
import { createScheduler, memoEngine, type Ctx } from '../../component.js';
import { selectEngine } from '../../engine/index.js';
import { createNotices } from '../../notices.js';
import { bindTimeKeys, goNow, setTime, startPlayback } from '../../playback.js';
import { createExplorerStore, type AngleFormat, type ExplorerState, type Theme } from '../../state.js';
import { formatWithUtc, jdFromWallClock, resolveZone, type ZoneChoice } from '../../time.js';
import { chartsView } from '../index.js';
import type { ChartMode, ChartTab } from '../frame.js';

// The design system's tokens when this branch has them; otherwise a dev-only snapshot.
const realTokens = import.meta.glob('../../theme/tokens.css', { eager: true });
if (Object.keys(realTokens).length === 0) {
  const preview = import.meta.glob('./theme-preview.css');
  for (const load of Object.values(preview)) void load();
}

interface Place {
  id: string;
  label: string;
  lat: number;
  lon: number;
  zone: ZoneChoice;
}

const PLACES: Place[] = [
  { id: 'philadelphia', label: 'Philadelphia City Hall', lat: 39.9526, lon: -75.1652, zone: { kind: 'iana', zone: 'America/New_York' } },
  { id: 'tromso', label: 'Tromsø', lat: 69.6492, lon: 18.9553, zone: { kind: 'iana', zone: 'Europe/Oslo' } },
  { id: 'sydney', label: 'Sydney Opera House', lat: -33.8568, lon: 151.2153, zone: { kind: 'iana', zone: 'Australia/Sydney' } },
  { id: 'quito', label: 'Quito', lat: -0.1807, lon: -78.4678, zone: { kind: 'iana', zone: 'America/Guayaquil' } },
  { id: 'greenwich', label: 'Royal Observatory Greenwich', lat: 51.4779, lon: -0.0015, zone: { kind: 'iana', zone: 'Europe/London' } },
  { id: 'santiago', label: 'Santiago (clocks change at midnight)', lat: -33.4489, lon: -70.6693, zone: { kind: 'iana', zone: 'America/Santiago' } },
  { id: 'longyearbyen', label: 'Longyearbyen, Svalbard', lat: 78.2232, lon: 15.6267, zone: { kind: 'iana', zone: 'Arctic/Longyearbyen' } },
  { id: 'atsea', label: 'Mid-Atlantic (nautical zone time)', lat: 30.0, lon: -40.0, zone: { kind: 'nautical' } },
];

const TABS: ChartTab[] = ['day', 'year', 'moon', 'planets'];
const THEMES: Theme[] = ['light', 'dark', 'night'];

function params(): URLSearchParams {
  return new URLSearchParams(location.hash.replace(/^#/, ''));
}

function placeFrom(p: URLSearchParams): Place {
  return PLACES.find((x) => x.id === p.get('place')) ?? PLACES[0]!;
}

function jdFrom(p: URLSearchParams, place: Place): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(p.get('date') ?? '');
  if (!m) return null;
  const zone = resolveZone(place.zone, place.lon);
  return jdFromWallClock(
    { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: m[4] ? Number(m[4]) : 12, minute: m[5] ? Number(m[5]) : 0 },
    zone,
  );
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

async function boot(root: HTMLElement): Promise<void> {
  const p = params();
  const place = placeFrom(p);
  const theme = (THEMES as string[]).includes(p.get('theme') ?? '') ? (p.get('theme') as Theme) : 'light';
  const tab = (TABS as string[]).includes(p.get('tab') ?? '') ? (p.get('tab') as ChartTab) : 'day';
  const mode: ChartMode = p.get('mode') === 'table' ? 'table' : 'chart';
  const zoneParam = p.get('zone');
  const zone: ZoneChoice = zoneParam === 'utc' ? { kind: 'utc' } : zoneParam === 'nautical' ? { kind: 'nautical' } : place.zone;
  applyTheme(theme);
  document.body.style.margin = '0';
  document.body.style.background = 'var(--stage-bg, #eef1f3)';

  const selection = await selectEngine();
  const notices = createNotices();
  selection.notices.forEach((n, i) => notices.push(n.level, n.text, { key: `engine-${i}`, persistent: n.level !== 'info' }));
  const jd = jdFrom(p, place);
  const store = createExplorerStore({
    storage: null,
    initial: {
      observer: { lat_deg: place.lat, lon_deg: place.lon, height_m: 0, label: place.label, zone },
      ...(jd !== null ? { time: { jd_utc: jd, live: false, playing: false } } : {}),
      selection: { body: p.get('body') ?? 'Sun' },
      settings: {
        theme,
        angleFormat: (['dm', 'dms', 'decimal'] as AngleFormat[]).includes(p.get('angles') as AngleFormat)
          ? (p.get('angles') as AngleFormat)
          : 'dm',
      },
      view: 'charts',
    },
  });
  const scheduler = createScheduler();
  const engine = memoEngine(selection.engine, { freeze: import.meta.env.DEV });
  const ctx: Ctx = { store, engine, notices, scheduler };
  startPlayback(store, scheduler);
  bindTimeKeys(window, store);

  // --- toolbar -------------------------------------------------------------------------
  const placeSelect = h('select', { 'aria-label': 'Place' });
  for (const x of PLACES) placeSelect.append(h('option', { value: x.id, selected: x.id === place.id }, x.label));
  placeSelect.addEventListener('change', () => {
    const x = PLACES.find((y) => y.id === placeSelect.value)!;
    store.patch({ observer: { lat_deg: x.lat, lon_deg: x.lon, height_m: 0, label: x.label, zone: x.zone } });
  });
  const themeSelect = h('select', { 'aria-label': 'Theme' });
  for (const t of THEMES) themeSelect.append(h('option', { value: t, selected: t === theme }, t));
  themeSelect.addEventListener('change', () => {
    applyTheme(themeSelect.value as Theme);
    store.patch({ settings: { theme: themeSelect.value as Theme } });
  });
  const zoneSelect = h('select', { 'aria-label': 'Time zone' });
  for (const [v, label] of [
    ['place', 'Place’s zone'],
    ['nautical', 'Nautical zone'],
    ['utc', 'UTC'],
  ] as const) {
    zoneSelect.append(h('option', { value: v, selected: (zoneParam ?? 'place') === v }, label));
  }
  zoneSelect.addEventListener('change', () => {
    const x = PLACES.find((y) => y.id === placeSelect.value)!;
    const z: ZoneChoice = zoneSelect.value === 'utc' ? { kind: 'utc' } : zoneSelect.value === 'nautical' ? { kind: 'nautical' } : x.zone;
    store.patch({ observer: { zone: z } });
  });
  const dateInput = h('input', { type: 'datetime-local', 'aria-label': 'Date and time (place’s zone)' });
  dateInput.addEventListener('change', () => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(dateInput.value);
    if (!m) return;
    const s = store.get();
    const z = resolveZone(s.observer.zone, s.observer.lon_deg);
    setTime(store, jdFromWallClock({ year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]! }, z));
  });
  const nowButton = h('button', { type: 'button' }, 'Now');
  nowButton.addEventListener('click', () => goNow(store));
  const timeOut = h('output', {});
  const timings = h('output', { class: 'dev-timings' });
  const engineLabel = h(
    'span',
    { class: `dev-engine dev-engine--${selection.engine.kind}` },
    selection.engine.kind === 'mock' ? 'MOCK engine (illustrative numbers)' : 'WASM core',
  );
  const bar = h(
    'div',
    { class: 'dev-bar' },
    h('strong', {}, 'Charts · developer page'),
    engineLabel,
    placeSelect,
    zoneSelect,
    dateInput,
    nowButton,
    themeSelect,
    timeOut,
    timings,
  );
  const noticeList = h('div', { class: 'dev-notices' });
  const renderNotices = (): void => {
    noticeList.replaceChildren(...notices.list().map((n) => h('p', { class: `dev-notice dev-notice--${n.level}` }, n.text)));
  };
  notices.subscribe(renderNotices);
  renderNotices();
  const stage = h('main', { class: 'dev-stage' });
  root.replaceChildren(bar, noticeList, stage);

  const style = document.createElement('style');
  style.textContent = `
    .dev-bar { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; padding:8px 16px;
      background: var(--chrome-bg, #1c242d); color: var(--chrome-ink, #f1f4f7);
      font: 12px/1.4 var(--font-ui, system-ui, sans-serif); }
    .dev-bar select, .dev-bar input, .dev-bar button { font: inherit; background: var(--chrome-raised, #26303b);
      color: inherit; border: 1px solid var(--chrome-line-strong, #6f7f90); border-radius: 6px; padding: 3px 6px; }
    .dev-engine { padding: 1px 8px; border-radius: 999px; font-weight: 600; }
    .dev-engine--mock { background: var(--caution, #f2d04b); color: var(--on-caution, #1e1800); }
    .dev-engine--wasm { background: var(--ok, #62d096); color: #04210f; }
    .dev-timings, .dev-bar output { font-family: var(--font-num, monospace); color: var(--chrome-ink-2, #b6c2cd); }
    .dev-notices p { margin: 0; padding: 4px 16px; font: 12px/1.4 var(--font-ui, system-ui);
      background: var(--caution, #f2d04b); color: var(--on-caution, #1e1800); }
    .dev-stage { min-height: calc(100vh - 44px); }
  `;
  document.head.append(style);

  const view = chartsView({ tab, mode })(stage, ctx);
  void view;

  const syncTime = (s: ExplorerState): void => {
    const z = resolveZone(s.observer.zone, s.observer.lon_deg);
    timeOut.textContent = formatWithUtc(s.time.jd_utc, z);
  };
  syncTime(store.get());
  store.select((s) => s.time.jd_utc, () => syncTime(store.get()));
  store.select((s) => s.observer.zone, () => syncTime(store.get()));

  // Timings the charts publish on their cards (data-compute-ms).
  const showTimings = (): void => {
    const parts = [...stage.querySelectorAll<HTMLElement>('[data-compute]')].map((el) => el.dataset.compute ?? '');
    timings.textContent = parts.join(' · ');
  };
  new MutationObserver(showTimings).observe(stage, { subtree: true, attributes: true, attributeFilter: ['data-compute'] });

  if (import.meta.env.DEV) (globalThis as { __charts?: unknown }).__charts = { ctx, store };
}

const app = document.getElementById('app');
if (app) {
  boot(app).catch((error: unknown) => {
    console.error(error);
    app.textContent = `The charts developer page could not start: ${error instanceof Error ? error.message : String(error)}`;
  });
}
