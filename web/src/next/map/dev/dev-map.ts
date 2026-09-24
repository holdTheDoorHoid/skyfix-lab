/**
 * DEVELOPER PAGE for the map (`/next/dev-map.html`), until the shell mounts the map view.
 * OWNER: map agent. Nothing outside `map/dev/` imports this.
 *
 * Boots like `/next/` (engine, store, scheduler, playback, time keys) and mounts the map full
 * screen with a small strip of controls: theme, body, time. Address options for screenshots
 * and checks:
 *   #v=1&lat=…&lon=…&t=…&body=…&view=map|globe   a share link (state.ts), as on /next/
 *   ?engine=mock                                   the mock engine
 *   ?theme=light|dark|night                        the theme
 *   ?layers=graticule,circles,-twilight            switch layers on (or off with -)
 *   ?zoom=5                                        the opening zoom
 *   ?measure=lat,lon;lat,lon                       draw a measurement
 *   ?overlay=demo                                  a sample overlay through the map service
 *   ?bench=600                                     step time 2 min per frame and report timings
 *   ?bare=1                                        hide the developer strip (screenshots)
 */

import '../../theme/index.js';
import './dev-map.css';
import { applyTheme as applyDocumentTheme } from '../../theme/theme.js';
import { installTooltips } from '../../theme/primitives.js';
import { createScheduler, memoEngine, type Ctx } from '../../component.js';
import { selectEngine } from '../../engine/index.js';
import { createNotices } from '../../notices.js';
import { bindTimeKeys, goNow, PLAYBACK_SPEEDS, setPlaying, setSpeed, setTime, startPlayback, stepTime } from '../../playback.js';
import { createExplorerStore, currentDayWindow, displayZone, listenForShareLinks, type Layers, type Theme } from '../../state.js';
import { formatWithUtc, zoneLabel } from '../../time.js';
import { createMapView } from '../map-view.js';
import { capFeature, circleOfPositionFeature, ellipseFeature, mapServiceFor, pathFeature } from '../overlays.js';

const BANNER = 'Simulation and analysis workbench. Not a navigation instrument.';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

async function boot(app: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const selection = await selectEngine();
  const notices = createNotices();
  selection.notices.forEach((n, i) => notices.push(n.level, n.text, { key: `engine-${i}`, persistent: n.level !== 'info' }));
  const store = createExplorerStore({ storage: null });
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark' || theme === 'night') store.patch({ settings: { theme } });
  const layerPatch: Partial<Layers> = {};
  for (const item of (params.get('layers') ?? '').split(',').filter(Boolean)) {
    const off = item.startsWith('-');
    layerPatch[item.replace(/^[-+]/, '') as keyof Layers] = !off;
  }
  store.patch({ layers: layerPatch });
  const stopShare = listenForShareLinks(store);
  const scheduler = createScheduler();
  const engine = memoEngine(selection.engine, { freeze: import.meta.env.DEV });
  const ctx: Ctx = { store, engine, notices, scheduler };
  startPlayback(store, scheduler);
  bindTimeKeys(window, store);

  // Theme on the document, as the shell will do.
  const applyTheme = (t: Theme) => {
    applyDocumentTheme(t);
  };
  installTooltips();
  applyTheme(store.get().settings.theme);
  store.select((s) => s.settings.theme, applyTheme);

  // --- Layout -------------------------------------------------------------------------------
  const banner = h('p', { class: 'dm-banner', role: 'note' }, BANNER);
  const bar = h('div', { class: 'dm-bar' });
  const stage = h('main', { class: 'dm-stage' });
  const noticeList = h('ul', { class: 'dm-notices', 'aria-live': 'polite' });
  app.replaceChildren(banner, bar, stage, noticeList);
  if (params.get('bare') === '1') app.classList.add('dm-bare');

  const themeSel = h('select', { 'aria-label': 'Theme' });
  for (const t of ['light', 'dark', 'night']) themeSel.append(h('option', { value: t }, t[0]!.toUpperCase() + t.slice(1)));
  themeSel.addEventListener('change', () => store.patch({ settings: { theme: themeSel.value as Theme } }));

  const bodySel = h('select', { 'aria-label': 'Body' });
  bodySel.append(h('option', { value: '' }, '(none)'));
  for (const b of engine.bodies()) bodySel.append(h('option', { value: b.body }, b.body));
  bodySel.addEventListener('change', () => store.patch({ selection: { body: bodySel.value || null } }));

  const slider = h('input', { type: 'range', min: '0', max: '1440', step: '1', 'aria-label': 'Time of day' });
  slider.addEventListener('input', () => {
    const [start, end] = currentDayWindow(store.get());
    setTime(store, start + (Number(slider.value) / 1440) * (end - start));
  });
  const btn = (label: string, fn: () => void, title = label) => {
    const b = h('button', { type: 'button', title }, label);
    b.addEventListener('click', fn);
    return b;
  };
  const play = btn('Play', () => setPlaying(store, !store.get().time.playing));
  const speedSel = h('select', { 'aria-label': 'Speed' });
  for (const s of PLAYBACK_SPEEDS) speedSel.append(h('option', { value: String(s.speed) }, s.label));
  speedSel.addEventListener('change', () => setSpeed(store, Number(speedSel.value)));
  const clock = h('output', { class: 'dm-clock' });
  const place = h('output', { class: 'dm-place' });
  bar.append(
    themeSel,
    bodySel,
    btn('−1 d', () => stepTime(store, { unit: 'day', count: -1 }), 'One day earlier'),
    btn('−1 h', () => stepTime(store, { unit: 'hour', count: -1 }), 'One hour earlier'),
    slider,
    btn('+1 h', () => stepTime(store, { unit: 'hour', count: 1 }), 'One hour later'),
    btn('+1 d', () => stepTime(store, { unit: 'day', count: 1 }), 'One day later'),
    btn('Now', () => goNow(store)),
    play,
    speedSel,
    clock,
    place,
  );

  const renderBar = (): void => {
    const s = store.get();
    themeSel.value = s.settings.theme;
    bodySel.value = s.selection.body ?? '';
    speedSel.value = String(s.time.speed);
    play.textContent = s.time.playing ? 'Pause' : 'Play';
    const [start, end] = currentDayWindow(s);
    slider.value = String(Math.round(((s.time.jd_utc - start) / (end - start)) * 1440));
    clock.textContent = formatWithUtc(s.time.jd_utc, displayZone(s));
    const o = s.observer;
    place.textContent = `${o.label || 'Unnamed place'} · ${zoneLabel(s.time.jd_utc, displayZone(s))}`;
  };
  const barTask = () => renderBar();
  store.subscribe(() => scheduler.schedule(barTask));
  renderBar();

  const renderNotices = (): void => {
    noticeList.replaceChildren(...notices.list().map((n) => h('li', { class: `dm-notice dm-${n.level}` }, n.text)));
  };
  notices.subscribe(renderNotices);
  renderNotices();

  // --- The map --------------------------------------------------------------------------------
  const zoom = Number(params.get('zoom'));
  const measure = (params.get('measure') ?? '')
    .split(';')
    .map((p) => p.split(',').map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite));
  const view = createMapView({
    onReady(map, api) {
      if (Number.isFinite(zoom) && zoom > 0) map.jumpTo({ zoom });
      if (measure.length === 2) {
        api.measure({ lat_deg: measure[0]![0]!, lon_deg: measure[0]![1]! }, { lat_deg: measure[1]![0]!, lon_deg: measure[1]![1]! });
      }
      document.documentElement.dataset.mapReady = '1';
      (globalThis as { __map?: unknown }).__map = map;
      const bench = Number(params.get('bench'));
      if (bench > 0) map.once('idle', () => runBench(ctx, bench));
    },
  });
  view(stage, ctx);

  if (params.get('overlay') === 'demo') {
    const service = mapServiceFor(ctx);
    const o = store.get().observer;
    service.addOverlay(
      'demo-cop',
      { type: 'FeatureCollection', features: [circleOfPositionFeature({ lat_deg: -5, lon_deg: -40 }, 50, { label: 'demo circle of position' })] },
      { color: '--body-venus', dash: '--dash-circle', labelProperty: 'label' },
    );
    service.addOverlay('demo-ellipse', ellipseFeature({ lat_deg: o.lat_deg, lon_deg: o.lon_deg + 8 }, 180, 60, 60, { label: 'fix ellipse' }), {
      color: '--accent',
      fillOpacity: 0.2,
      labelProperty: 'label',
    });
    service.addOverlay(
      'demo-path',
      pathFeature(
        Array.from({ length: 41 }, (_, i) => ({ lat_deg: 10 + 20 * Math.sin(i / 6), lon_deg: 140 + i * 2 })),
        { label: 'demo path across the antimeridian' },
      ),
      { color: '--event-set', width: 3, labelProperty: 'label' },
    );
    service.addOverlay('demo-cap', capFeature({ lat_deg: -80, lon_deg: 0 }, 15), { color: '--body-moon', fillOpacity: 0.25 });
  }

  (globalThis as { __skyfix?: unknown }).__skyfix = { ctx, stop: stopShare };
}

/** Step time by two minutes per frame and report how long the map's work took. */
function runBench(ctx: Ctx, frames: number): void {
  const { store, scheduler } = ctx;
  const start = store.get().time.jd_utc;
  const syncMs: number[] = [];
  const frameMs: number[] = [];
  let i = 0;
  let last = performance.now();
  const step = (): void => {
    const now = performance.now();
    if (i > 0) frameMs.push(now - last);
    last = now;
    if (i >= frames) {
      report();
      return;
    }
    setTime(store, start + (i * 2) / 1440);
    const t0 = performance.now();
    scheduler.flush();
    syncMs.push(performance.now() - t0);
    i++;
    requestAnimationFrame(step);
  };
  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
    return { mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), p50: q(0.5), p95: q(0.95), max: s[s.length - 1] ?? NaN };
  };
  const report = (): void => {
    const result = { frames, sync: stats(syncMs), frame: stats(frameMs), fps: 1000 / stats(frameMs).mean, engine: ctx.engine.kind };
    console.info('map bench', JSON.stringify(result));
    (globalThis as { __mapBench?: unknown }).__mapBench = result;
    const pre = document.createElement('pre');
    pre.id = 'bench-result';
    pre.className = 'dm-bench';
    pre.textContent = JSON.stringify(result, null, 1);
    document.body.appendChild(pre);
  };
  requestAnimationFrame(step);
}

const app = document.getElementById('app');
if (app) {
  boot(app).catch((error: unknown) => {
    console.error(error);
    app.textContent = `The map page could not start: ${error instanceof Error ? error.message : String(error)}`;
  });
}
