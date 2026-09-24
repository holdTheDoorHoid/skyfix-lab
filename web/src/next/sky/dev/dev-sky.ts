/**
 * DEVELOPER PAGE for the Sky view (`/next/dev-sky.html`). OWNER: sky agent.
 *
 * Boots the explorer exactly as `/next/` does (engine choice, store, scheduler, memoised
 * engine, playback, time keys) and mounts only the Sky view, with a thin strip of
 * controls. Nothing outside `sky/dev/` imports from here.
 *
 * Address parameters (for screenshots and benchmarks):
 *   engine=mock                 the mock engine (else the WebAssembly core)
 *   place=philadelphia|sydney|quito|tromso|greenwich|capetown   or lat=, lon=, label=, zone=
 *   t=2026-09-24T02:00:00Z      the instant (UTC); or local=2026-09-24T21:30 in the place's zone
 *   theme=light|dark|night
 *   mode=dome|panorama  south=1  az=180  fov=120  bottom=-5
 *   on=ecliptic,equator  off=starNames  stress=1 (every sky layer on)
 *   select=Jupiter  highlight=Vega,Arcturus  tip=Moon (hover tooltip)  focus=Jupiter
 *   bench=600 speed=3600        play for 600 frames and report frame times (#bench)
 *   bare=1                      hide the control strip (the honesty banner stays)
 *   menu=1                      open the Layers popover
 */

// The design system (fonts, tokens, components), as the shell loads it.
import '../../theme/index.js';
import './dev-sky.css';
import { applyTheme, systemTheme } from '../../theme/theme.js';
import { installTooltips } from '../../theme/primitives.js';
import { createScheduler, memoEngine, type Ctx } from '../../component.js';
import { selectEngine } from '../../engine/index.js';
import { createNotices } from '../../notices.js';
import { bindTimeKeys, goNow, setPlaying, setSpeed, startPlayback, stepTime } from '../../playback.js';
import { createExplorerStore, displayZone, type Layers, type Theme } from '../../state.js';
import { formatWithUtc, isValidIanaZone, jdFromIso, jdFromWallClock, resolveZone } from '../../time.js';
import { highlightBodies, mountSky, type SkyMounted } from '../index.js';

const BANNER = 'Simulation and analysis workbench. Not a navigation instrument.';

const PLACES: Record<string, { label: string; lat: number; lon: number; zone: string; height?: number }> = {
  philadelphia: { label: 'Philadelphia City Hall', lat: 39.9526, lon: -75.1652, zone: 'America/New_York' },
  sydney: { label: 'Sydney', lat: -33.8568, lon: 151.2153, zone: 'Australia/Sydney' },
  quito: { label: 'Quito', lat: -0.1807, lon: -78.4678, zone: 'America/Guayaquil', height: 2850 },
  tromso: { label: 'Tromsø', lat: 69.6492, lon: 18.9553, zone: 'Europe/Oslo' },
  greenwich: { label: 'Greenwich', lat: 51.4779, lon: -0.0015, zone: 'Europe/London' },
  capetown: { label: 'Cape Town', lat: -33.9249, lon: 18.4241, zone: 'Africa/Johannesburg' },
};

const SKY_LAYERS: (keyof Layers)[] = [
  'constellations',
  'constellationNames',
  'constellationBoundaries',
  'starNames',
  'paths',
  'altAzGrid',
  'meridian',
  'equator',
  'ecliptic',
];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...kids);
  return node;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function boot(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const selection = await selectEngine();
  const notices = createNotices();
  selection.notices.forEach((n, i) => notices.push(n.level, n.text, { key: `engine-${i}`, persistent: n.level !== 'info' }));
  const store = createExplorerStore({ storage: null });

  // --- the scene from the address ----------------------------------------------------
  const preset = PLACES[(params.get('place') ?? 'philadelphia').toLowerCase()] ?? PLACES.philadelphia!;
  const lat = Number(params.get('lat') ?? preset.lat);
  const lon = Number(params.get('lon') ?? preset.lon);
  const zoneName = params.get('zone') ?? preset.zone;
  store.patch({
    observer: {
      lat_deg: Number.isFinite(lat) ? lat : preset.lat,
      lon_deg: Number.isFinite(lon) ? lon : preset.lon,
      height_m: Number(params.get('height') ?? preset.height ?? 0) || 0,
      label: params.get('label') ?? (params.has('lat') ? '' : preset.label),
      zone: isValidIanaZone(zoneName) ? { kind: 'iana', zone: zoneName } : { kind: 'nautical' },
    },
  });
  const t = params.get('t');
  const localTime = params.get('local');
  if (t && jdFromIso(t) !== null) {
    store.patch({ time: { jd_utc: jdFromIso(t)!, live: false, playing: false } });
  } else if (localTime) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localTime);
    if (m) {
      const zone = resolveZone(store.get().observer.zone, store.get().observer.lon_deg);
      const jd = jdFromWallClock({ year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]! }, zone);
      store.patch({ time: { jd_utc: jd, live: false, playing: false } });
    }
  }
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark' || theme === 'night') store.patch({ settings: { theme } });
  const layerPatch: Partial<Layers> = {};
  if (params.get('stress') === '1') for (const k of SKY_LAYERS) layerPatch[k] = true;
  for (const k of (params.get('on') ?? '').split(',').filter(Boolean)) if (k in store.get().layers) layerPatch[k as keyof Layers] = true;
  for (const k of (params.get('off') ?? '').split(',').filter(Boolean)) if (k in store.get().layers) layerPatch[k as keyof Layers] = false;
  store.patch({ layers: layerPatch });
  if (params.has('select')) store.patch({ selection: { body: params.get('select') || null } });

  const scheduler = createScheduler();
  const engine = memoEngine(selection.engine, { freeze: import.meta.env.DEV });
  const ctx: Ctx = { store, engine, notices, scheduler };
  startPlayback(store, scheduler);
  bindTimeKeys(window, store);

  // --- page ---------------------------------------------------------------------------
  const bare = params.get('bare') === '1';
  const banner = h('p', { class: 'dv-banner', role: 'note' }, BANNER);
  const engineLine = h('span', { class: `dv-engine dv-${engine.kind}` }, engine.kind === 'mock' ? 'MOCK engine' : 'WASM core');
  const clock = h('output', { class: 'dv-clock' });
  const stats = h('output', { class: 'dv-stats' });
  const placeSelect = h('select', { 'aria-label': 'Place' });
  for (const [key, p] of Object.entries(PLACES)) placeSelect.append(h('option', { value: key }, p.label));
  placeSelect.value = Object.entries(PLACES).find(([, p]) => p === preset)?.[0] ?? 'philadelphia';
  placeSelect.addEventListener('change', () => {
    const p = PLACES[placeSelect.value]!;
    store.patch({ observer: { lat_deg: p.lat, lon_deg: p.lon, height_m: p.height ?? 0, label: p.label, zone: { kind: 'iana', zone: p.zone } } });
  });
  const themeSelect = h('select', { 'aria-label': 'Theme' });
  for (const th of ['light', 'dark', 'night']) themeSelect.append(h('option', { value: th }, th));
  themeSelect.addEventListener('change', () => store.patch({ settings: { theme: themeSelect.value as Theme } }));
  const btn = (label: string, fn: () => void): HTMLButtonElement => {
    const b = h('button', { type: 'button' }, label);
    b.addEventListener('click', fn);
    return b;
  };
  const play = btn('Play', () => setPlaying(store, !store.get().time.playing));
  const controls = h(
    'div',
    { class: 'dv-controls' },
    engineLine,
    placeSelect,
    btn('−1 h', () => stepTime(store, { unit: 'hour', count: -1 })),
    btn('−10 min', () => stepTime(store, { unit: 'minute', count: -10 })),
    btn('Now', () => goNow(store)),
    btn('+10 min', () => stepTime(store, { unit: 'minute', count: 10 })),
    btn('+1 h', () => stepTime(store, { unit: 'hour', count: 1 })),
    play,
    themeSelect,
    clock,
    stats,
  );
  const noticeList = h('ul', { class: 'dv-notices', 'aria-live': 'polite' });
  const host = h('div', { class: 'dv-sky' });
  const benchOut = h('pre', { id: 'bench', class: 'dv-bench' });
  root.replaceChildren(banner, ...(bare ? [] : [controls]), noticeList, host, benchOut);

  const renderNotices = (): void => {
    noticeList.replaceChildren(...notices.list().map((n) => h('li', { class: `dv-notice dv-${n.level}` }, n.text)));
  };
  renderNotices();
  notices.subscribe(renderNotices);
  const syncChrome = (): void => {
    const s = store.get();
    applyTheme(s.settings.theme === 'system' ? systemTheme() : s.settings.theme);
    themeSelect.value = s.settings.theme;
    play.textContent = s.time.playing ? 'Pause' : 'Play';
  };
  // The clock text needs time-zone arithmetic: twice a second is plenty.
  setInterval(() => {
    const s = store.get();
    clock.textContent = formatWithUtc(s.time.jd_utc, displayZone(s));
  }, 500);
  syncChrome();
  store.subscribe(syncChrome);

  installTooltips(document.body);
  const handle: SkyMounted = mountSky(host, ctx);
  const mode = params.get('mode');
  if (mode === 'dome' || mode === 'panorama') handle.setMode(mode);
  if (params.get('south') === '1') handle.setSouthUp(true);
  const pano: { azimuth?: number; fov?: number; bottomAlt?: number } = {};
  if (params.has('az')) pano.azimuth = Number(params.get('az'));
  if (params.has('fov')) pano.fov = Number(params.get('fov'));
  if (params.has('bottom')) pano.bottomAlt = Number(params.get('bottom'));
  if (Object.keys(pano).length) handle.setPanorama(pano);
  if (params.has('highlight')) highlightBodies(ctx, (params.get('highlight') ?? '').split(',').filter(Boolean));
  (globalThis as { __sky?: unknown }).__sky = { ctx, handle };

  setInterval(() => {
    const st = handle.stats();
    if (st.frames) stats.textContent = `draw ${st.mean.toFixed(1)} ms (p95 ${st.p95.toFixed(1)})`;
  }, 700);

  // Hover or keyboard focus for screenshots: wait for the first frames, then act like a person.
  const tip = params.get('tip');
  const focus = params.get('focus');
  if (tip || focus) {
    await nextFrame();
    await nextFrame();
    if (tip) {
      const at = handle.locate(tip);
      if (at) {
        const r = handle.canvas.getBoundingClientRect();
        handle.canvas.dispatchEvent(
          new PointerEvent('pointermove', { clientX: r.left + at.x, clientY: r.top + at.y, bubbles: true, pointerId: 1 }),
        );
      }
    }
    if (focus) {
      handle.canvas.focus();
      for (let k = 0; k < 80; k += 1) {
        handle.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        handle.drawNow();
        const active = document.querySelector('.sky-tip-title')?.textContent;
        if (active?.toLowerCase() === focus.toLowerCase()) break;
      }
    }
  }

  if (params.get('menu') === '1') {
    await nextFrame();
    document.querySelector<HTMLButtonElement>('.sky [aria-haspopup="dialog"]')?.click();
  }

  // Benchmark: play and measure.
  const bench = Number(params.get('bench') ?? 0);
  if (bench > 0) {
    await nextFrame();
    await nextFrame();
    handle.resetStats();
    setSpeed(store, Number(params.get('speed') ?? 3600));
    setPlaying(store, true);
    const intervals: number[] = [];
    let last = await nextFrame();
    for (let k = 0; k < bench; k += 1) {
      const now = await nextFrame();
      intervals.push(now - last);
      last = now;
    }
    setPlaying(store, false);
    const st = handle.stats();
    intervals.sort((a, b) => a - b);
    const q = (p: number): number => intervals[Math.min(intervals.length - 1, Math.floor(p * (intervals.length - 1)))]!;
    const result = {
      frames: st.frames,
      drawMeanMs: +st.mean.toFixed(2),
      drawP50Ms: +st.p50.toFixed(2),
      drawP95Ms: +st.p95.toFixed(2),
      drawMaxMs: +st.max.toFixed(2),
      computeMeanMs: +st.computeMean.toFixed(2),
      paintMeanMs: +st.paintMean.toFixed(2),
      frameIntervalP50Ms: +q(0.5).toFixed(2),
      frameIntervalP95Ms: +q(0.95).toFixed(2),
      canvas: `${handle.canvas.width}x${handle.canvas.height}`,
      dpr: devicePixelRatio,
      engine: engine.kind,
    };
    benchOut.textContent = JSON.stringify(result);
    document.title = `BENCH ${JSON.stringify(result)}`;
    console.info('sky bench', result);
  }
}

const app = document.getElementById('app');
if (app) {
  boot(app).catch((error: unknown) => {
    console.error(error);
    app.textContent = `The Sky developer page could not start: ${error instanceof Error ? error.message : String(error)}`;
  });
}
