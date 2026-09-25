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

import { h } from '../../../dom.js';
import { createScheduler, memoEngine, type Ctx } from '../../component.js';
import { selectEngine } from '../../engine/index.js';
import { createNotices } from '../../notices.js';
import { bindTimeKeys, goNow, setTime, startPlayback } from '../../playback.js';
import { createExplorerStore, type AngleFormat, type ExplorerState } from '../../state.js';
import { formatWithUtc, jdFromWallClock, resolveZone, type ZoneChoice } from '../../time.js';
import { applyTheme as applyThemeToDocument, installTooltips, type ThemeName } from '../../theme/index.js';
import { chartsView } from '../index.js';
import { computeDay } from '../day-data.js';
import { dayBodies } from '../day-chart.js';
import type { ChartMode, ChartTab } from '../frame.js';
import { computeMoonMonth } from '../moon-data.js';
import { ALL_PLANETS, planetYearJob } from '../planet-data.js';
import { localDay, zoneKey } from '../windows.js';
import { computeYear, computeYearSky } from '../year-data.js';
import { NO_PACKS } from '../../packs/service.js';

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
const THEMES: ThemeName[] = ['light', 'dark', 'night'];

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

function applyTheme(theme: ThemeName): void {
  applyThemeToDocument(theme);
}

async function boot(root: HTMLElement): Promise<void> {
  const p = params();
  const place = placeFrom(p);
  const theme = (THEMES as string[]).includes(p.get('theme') ?? '') ? (p.get('theme') as ThemeName) : 'light';
  const tab = (TABS as string[]).includes(p.get('tab') ?? '') ? (p.get('tab') as ChartTab) : 'day';
  const mode: ChartMode = p.get('mode') === 'table' ? 'table' : 'chart';
  const zoneParam = p.get('zone');
  const zone: ZoneChoice = zoneParam === 'utc' ? { kind: 'utc' } : zoneParam === 'nautical' ? { kind: 'nautical' } : place.zone;
  applyTheme(theme);

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
  const ctx: Ctx = { store, engine, notices, scheduler, packs: NO_PACKS };
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
    applyTheme(themeSelect.value as ThemeName);
    store.patch({ settings: { theme: themeSelect.value as ThemeName } });
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
    #app { display: flex; flex-direction: column; height: 100vh; }
    .dev-bar { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; padding:8px 16px;
      background: var(--chrome-bg); color: var(--chrome-ink); font: 12px/1.4 var(--font-ui); }
    .dev-bar select, .dev-bar input, .dev-bar button { font: inherit; background: var(--chrome-raised);
      color: inherit; border: 1px solid var(--chrome-line-strong); border-radius: 6px; padding: 3px 6px; }
    .dev-engine { padding: 1px 8px; border-radius: 999px; font-weight: 600; }
    .dev-engine--mock { background: var(--caution); color: var(--on-caution); }
    .dev-engine--wasm { background: var(--ok); color: var(--chrome-bg-0); }
    .dev-timings, .dev-bar output { font-family: var(--font-num); color: var(--chrome-ink-2); }
    .dev-notices p { margin: 0; padding: 4px 16px; font: 12px/1.4 var(--font-ui);
      background: var(--caution); color: var(--on-caution); }
    .dev-stage { flex: 1; min-height: 0; background: var(--stage-bg); }
  `;
  document.head.append(style);

  installTooltips(document.body);
  if (p.get('bench') === '1') {
    await bench(stage, ctx, selection.engine);
    return;
  }
  const view = chartsView({ tab, mode })(stage, ctx);
  void view;

  // "Ready" for screenshots (scripts in charts/dev): fonts loaded and the chart drawn in
  // full, including every night of the planet chart.
  const markReady = (): void => {
    const card = stage.querySelector<HTMLElement>('.sfc-card');
    const drawn = card?.dataset.ready === '1';
    if (drawn && document.fonts.status === 'loaded') document.documentElement.dataset.ready = '1';
    else setTimeout(markReady, 100);
  };
  void document.fonts.ready.then(markReady);

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

/**
 * `#bench=1`: time each chart's computation on the unmemoised engine, first on a cold page
 * and then again for the next period (warm), and print the numbers. Development only.
 */
async function bench(stage: HTMLElement, ctx: Ctx, engine: Ctx['engine']): Promise<void> {
  const out = h('pre', { class: 'dev-bench' });
  stage.replaceChildren(out);
  const lines: string[] = [`engine: ${engine.kind}`, `user agent: ${navigator.userAgent}`, ''];
  const print = (): void => {
    out.textContent = lines.join('\n');
  };
  const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
  const s = ctx.store.get();
  const zone = resolveZone(s.observer.zone, s.observer.lon_deg);
  const observer = { lat_deg: s.observer.lat_deg, lon_deg: s.observer.lon_deg, height_m: s.observer.height_m };
  const options = { horizon: s.settings.horizon, height_of_eye_m: s.settings.height_of_eye_m };
  const bodies = dayBodies(ctx, 'Vega');
  lines.push(`place: ${s.observer.label} (${zoneKey(zone)}); bodies for the day chart: ${bodies.length}`);
  const stats = (xs: number[]): string => {
    const sorted = [...xs].sort((a, b) => a - b);
    return `min ${sorted[0]!.toFixed(0)}, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms`;
  };
  const REPS = 7;
  for (const [label, run] of [
    ['day chart (sample_bodies + day_events)', (i: number) => computeDay(engine, { observer, zone, day: localDay(zone, { year: 2026, month: 9, day: 1 + i }), bodies, options }).timing],
    ['year chart (one day_events_batch of the year + shaping)', (i: number) => computeYear(engine, { observer, zone, year: 2020 + i, options }).timing],
    ['year Moon phases + seasons (after the first drawing)', (i: number) => ({ totalMs: computeYearSky(engine, zone, 2020 + i).engineMs, engineMs: 0 })],
    ['Moon calendar month', (i: number) => computeMoonMonth(engine, { observer, zone, year: 2026, month: 1 + i, options }).timing],
  ] as const) {
    const total: number[] = [];
    const eng: number[] = [];
    for (let i = 0; i < REPS; i += 1) {
      const t = run(i) as { totalMs: number; engineMs: number; batchMs?: number };
      total.push(t.totalMs);
      eng.push(t.batchMs ?? t.engineMs);
      await pause();
    }
    lines.push(`${label}: first ${total[0]!.toFixed(0)} ms; then ${stats(total.slice(1))} (engine ${stats(eng.slice(1))})`);
    print();
  }
  for (let i = 0; i < 2; i += 1) {
    const year = computeYear(engine, { observer, zone, year: 2026 + i, options });
    let first = -1;
    let primary = -1;
    const t0 = performance.now();
    const job = planetYearJob(engine, { observer, zone, year: 2026 + i, options, planets: ALL_PLANETS }, year);
    while (!job.step(45)) {
      if (first < 0) first = performance.now() - t0;
      if (primary < 0 && job.has('Saturn')) primary = performance.now() - t0;
      await pause();
    }
    const total = performance.now() - t0 - 0;
    lines.push(
      `planet chart ${2026 + i}${i ? ' (warm)' : ' (cold)'}: first piece ${first.toFixed(0)} ms, Venus-Saturn done ${primary.toFixed(0)} ms, all ${total.toFixed(0)} ms wall (engine ${job.data.timing.engineMs.toFixed(0)} ms)`,
    );
    print();
  }
  document.documentElement.dataset.ready = '1';
}

const app = document.getElementById('app');
if (app) {
  boot(app).catch((error: unknown) => {
    console.error(error);
    app.textContent = `The charts developer page could not start: ${error instanceof Error ? error.message : String(error)}`;
  });
}
