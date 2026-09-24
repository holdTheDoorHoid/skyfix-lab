/**
 * The Sky view (EXPLORER_PLAN §2): what you would see from the chosen place at the
 * chosen time, as a zenith-centred dome or a horizon panorama. OWNER: sky agent.
 *
 * Component contract (`component.ts`): `sky(host, ctx)` takes over `host` and returns
 * `{destroy}` plus the extras of `SkyMounted`. It draws only in the scheduler's frames,
 * never mutates engine results, and cleans up everything in `destroy`.
 *
 * Shared state it reads: place, time, selection, layers, theme and angle format (the
 * store). Shared state it writes: `selection.body` (click or Enter on a body) and
 * `layers` (the Layers menu). Its own view settings — dome or panorama, south up, where
 * the panorama looks — live per explorer in memory, so leaving the view and coming back
 * keeps them; they are not persisted (state.ts privacy rules).
 *
 * Display-only data (CONVENTIONS 13.6): the star field is drawn and described here and
 * nowhere feeds navigation. Only canonical bodies (the Sun, Moon, planets and the 58
 * navigational stars) become the shared selection; any other catalogue star is pinned
 * locally.
 */

import './sky.css';
import type { Component, Ctx, Mounted } from '../component.js';
import type { BodyState, SkyState } from '../engine/types.js';
import {
  currentDayWindow,
  displayZone,
  engineObserver,
  type AngleFormat,
  type ExplorerState,
  type Layers,
} from '../state.js';
import { wallClock } from '../time.js';
import { DEG, limitingMagnitude, RAD } from './astro.js';
import { compassPoint, formatAngle, formatBearing, formatMagnitude } from './format.js';
import { skyHighlights } from './highlight.js';
import {
  documentReadVar,
  documentTheme,
  readPalette,
  skyColours,
  type SkyPalette,
  type SkyTheme,
} from './palette.js';
import { FrameTimer, type FrameStats } from './perf.js';
import {
  DomeProjector,
  PANORAMA_LIMITS,
  PanoramaProjector,
  inverseMercator,
  mercator,
  type PanoramaView,
  type SkyMode,
} from './projection.js';
import { bodyKey, bodyToken, SkyRenderer, starKey, type Frame, type PathData } from './render.js';
import { SkyScene } from './scene.js';
import { starAlpha, starDesignation, starRadius, starTitle } from './stars.js';

// ---------------------------------------------------------------------------
// View settings kept per explorer
// ---------------------------------------------------------------------------

export interface SkyViewSettings {
  mode: SkyMode;
  southUp: boolean;
  panorama: PanoramaView;
  /** False until the person turns the panorama; it then faces the equator side by default. */
  aimed: boolean;
}

const viewSettings = new WeakMap<object, SkyViewSettings>();

function settingsFor(ctx: Pick<Ctx, 'store'>): SkyViewSettings {
  let s = viewSettings.get(ctx.store);
  if (!s) {
    s = { mode: 'dome', southUp: false, panorama: { azimuth: 180, fov: 180, bottomAlt: -5 }, aimed: false };
    viewSettings.set(ctx.store, s);
  }
  return s;
}

export interface SkyMounted extends Mounted {
  readonly canvas: HTMLCanvasElement;
  /** Ring these bodies (canonical or star-field names); `[]` clears. Same as `highlightBodies(ctx, …)`. */
  highlightBodies(names: readonly string[]): void;
  setMode(mode: SkyMode): void;
  setSouthUp(on: boolean): void;
  /** Point the panorama (azimuth and bottom altitude in degrees, field in degrees). */
  setPanorama(view: Partial<PanoramaView>): void;
  /** Draw frame times since the last reset. */
  stats(): FrameStats;
  resetStats(): void;
  /** Draw once, synchronously (benchmarks and tests). */
  drawNow(): void;
  /**
   * Where a body is drawn now, in CSS pixels relative to the canvas (canonical or
   * star-field name), with `visible` false below the horizon or outside the view.
   */
  locate(name: string): { x: number; y: number; visible: boolean } | null;
}

/** Time steps up to this size (days) glide instead of jumping. */
const EASE_MAX_DAYS = 0.25;
const EASE_MS = 260;

const LAYER_ITEMS: readonly { key: keyof Layers; label: string }[] = [
  { key: 'constellations', label: 'Constellation figures' },
  { key: 'constellationNames', label: 'Constellation names' },
  { key: 'constellationBoundaries', label: 'Constellation boundaries' },
  { key: 'starNames', label: 'Star names' },
  { key: 'paths', label: 'Path of the selected body today' },
  { key: 'altAzGrid', label: 'Height and bearing grid' },
  { key: 'meridian', label: 'Meridian' },
  { key: 'equator', label: 'Celestial equator' },
  { key: 'ecliptic', label: 'Ecliptic' },
];

type Target = { key: string; kind: 'body'; name: string } | { key: string; kind: 'star'; index: number };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/** Mount the Sky view. `sky` below is the same with the plain component signature. */
export function mountSky(host: HTMLElement, ctx: Ctx): SkyMounted {
  const { store, engine, notices, scheduler } = ctx;
  const view = settingsFor(ctx);
  const highlights = skyHighlights(ctx);
  const cleanups: (() => void)[] = [];
  let destroyed = false;

  // --- DOM ---------------------------------------------------------------------------
  const root = el('div', { class: 'sky' });
  const toolbar = el('div', { class: 'sky-toolbar', role: 'toolbar', 'aria-label': 'Sky view' });
  const modeGroup = el('div', { class: 'sky-seg', role: 'radiogroup', 'aria-label': 'Projection' });
  const modeButtons: Record<SkyMode, HTMLButtonElement> = {
    dome: el('button', { type: 'button', role: 'radio', 'data-mode': 'dome', title: 'The whole sky, zenith in the middle' }, 'Dome'),
    panorama: el('button', { type: 'button', role: 'radio', 'data-mode': 'panorama', title: 'Looking toward the horizon' }, 'Panorama'),
  };
  modeGroup.append(modeButtons.dome, modeButtons.panorama);
  const southUp = el('button', { type: 'button', class: 'sky-btn', 'aria-pressed': 'false', title: 'Turn the chart so south is at the top' }, 'South up');
  const look = el('div', { class: 'sky-look', role: 'group', 'aria-label': 'Look toward' });
  const lookButtons = (['N', 'E', 'S', 'W'] as const).map((d, k) => {
    const b = el('button', { type: 'button', class: 'sky-btn sky-btn-compact', title: `Look ${['north', 'east', 'south', 'west'][k]}` }, d);
    b.addEventListener('click', () => {
      view.aimed = true;
      view.panorama.azimuth = k * 90;
      requestDraw();
    });
    return b;
  });
  const zoomOut = el('button', { type: 'button', class: 'sky-btn sky-btn-compact', 'aria-label': 'Wider field', title: 'Wider field' }, '−');
  const zoomIn = el('button', { type: 'button', class: 'sky-btn sky-btn-compact', 'aria-label': 'Narrower field', title: 'Narrower field' }, '+');
  const fovText = el('output', { class: 'sky-fov', 'aria-live': 'off' });
  look.append(...lookButtons, zoomOut, fovText, zoomIn);
  const layersMenu = el('details', { class: 'sky-layers' });
  const layersSummary = el('summary', { class: 'sky-btn' }, 'Layers');
  const layersList = el('div', { class: 'sky-layers-list', role: 'group', 'aria-label': 'Sky layers' });
  const layerBoxes = new Map<keyof Layers, HTMLInputElement>();
  for (const item of LAYER_ITEMS) {
    const box = el('input', { type: 'checkbox' });
    box.addEventListener('change', () => store.patch({ layers: { [item.key]: box.checked } as Partial<Layers> }));
    layerBoxes.set(item.key, box);
    layersList.append(el('label', { class: 'sky-check' }, box, ` ${item.label}`));
  }
  layersMenu.append(layersSummary, layersList);
  toolbar.append(modeGroup, southUp, look, layersMenu);

  const stage = el('div', { class: 'sky-stage' });
  const canvas = el('canvas', { class: 'sky-canvas', tabindex: '0', role: 'img' });
  const tooltip = el('div', { class: 'sky-tip', role: 'status', 'aria-live': 'off' });
  tooltip.hidden = true;
  const live = el('p', { class: 'sky-sr', 'aria-live': 'polite' });
  const hint = el('p', { class: 'sky-sr', id: `sky-hint-${Math.random().toString(36).slice(2, 8)}` },
    'Up and down arrow keys move between the Sun, Moon, planets and navigational stars above the horizon; Enter selects; Escape clears.');
  canvas.setAttribute('aria-describedby', hint.id);
  stage.append(canvas, tooltip, live, hint);
  root.append(toolbar, stage);
  host.replaceChildren(root);
  cleanups.push(() => root.remove());

  const g2 = canvas.getContext('2d', { alpha: false });
  if (!g2) throw new Error('The Sky view needs a 2D canvas, which this browser did not provide.');
  const renderer = new SkyRenderer(g2);
  const scene = new SkyScene();
  const timer = new FrameTimer();
  const dome = new DomeProjector();
  const pano = new PanoramaProjector();

  // --- the catalogue, once -----------------------------------------------------------
  try {
    const catalog = engine.starfieldCatalog();
    let boundaries: ReturnType<typeof engine.constellationBoundaries> = [];
    try {
      boundaries = engine.constellationBoundaries();
    } catch {
      boundaries = [];
    }
    scene.setCatalog(catalog, boundaries);
    notices.dismissKey('sky-catalog');
  } catch (error) {
    notices.push('error', `Star field: ${errorText(error)}. The Sun, Moon and planets are still drawn.`, { key: 'sky-catalog' });
  }

  // --- local state -------------------------------------------------------------------
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let palette: SkyPalette | null = null;
  let paletteTheme: SkyTheme | null = null;
  let displayJd = store.get().time.jd_utc;
  let ease: { from: number; to: number; t0: number } | null = null;
  let hoverKey: string | null = null;
  let hoverAt: { x: number; y: number } | null = null;
  let focusKey: string | null = null;
  let pinnedStar: number | null = null;
  /** The shared selection when the star was pinned; a new selection unpins it. */
  let pinnedFor: string | null = store.get().selection.body;
  let lastFrame: Frame | null = null;
  let sky: SkyState | null = null;
  let path: PathData | null = null;
  let pathKey = '';
  let dayWindowCache: { zone: string; a: number; b: number } | null = null;
  let tipText = '';
  let liveText = '';

  const highlightKeys = new Set<string>();
  const resolveHighlights = (): void => {
    highlightKeys.clear();
    const data = scene.stars;
    for (const name of highlights.get()) {
      const lower = name.toLowerCase();
      const body = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'].indexOf(lower);
      if (body >= 0) {
        highlightKeys.add(bodyKey(name[0]!.toUpperCase() + lower.slice(1)));
        continue;
      }
      const i = data?.byName.get(lower);
      if (i !== undefined) highlightKeys.add(starKey(i));
    }
  };
  resolveHighlights();

  // --- drawing -----------------------------------------------------------------------
  const drawTask = (): void => {
    if (!destroyed) draw();
  };
  function requestDraw(): void {
    if (!destroyed) scheduler.schedule(drawTask);
  }

  function resizeCanvas(): boolean {
    const rect = stage.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const d = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
    if (w === cssW && h === cssH && d === dpr) return false;
    cssW = w;
    cssH = h;
    dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    return true;
  }

  function currentPalette(state: ExplorerState): SkyPalette {
    const theme = documentTheme(state.settings.theme);
    if (!palette || paletteTheme !== theme) {
      palette = readPalette(theme, documentReadVar());
      paletteTheme = theme;
      renderer.setPalette(palette);
    }
    return palette;
  }

  function selectedKey(state: ExplorerState): string | null {
    if (pinnedStar !== null) return starKey(pinnedStar);
    const body = state.selection.body;
    if (!body) return null;
    const star = scene.stars?.navByName.get(body);
    if (star !== undefined) return starKey(star);
    return bodyKey(body);
  }

  function updatePath(state: ExplorerState, frameJd: number): void {
    const body = state.selection.body;
    if (!state.layers.paths || !body) {
      path = null;
      pathKey = '';
      return;
    }
    const zone = displayZone(state);
    const zoneKey = `${state.observer.lon_deg}|${JSON.stringify(state.observer.zone)}|${state.settings.timeDisplay}`;
    // The local day changes rarely; time-zone arithmetic (Intl) is not free, so the
    // window is recomputed only when the shown instant leaves it.
    if (!dayWindowCache || dayWindowCache.zone !== zoneKey || frameJd < dayWindowCache.a || frameJd >= dayWindowCache.b) {
      const [wa, wb] = currentDayWindow({ ...state, time: { ...state.time, jd_utc: frameJd } });
      dayWindowCache = { zone: zoneKey, a: wa, b: wb };
    }
    const { a, b } = dayWindowCache;
    const o = state.observer;
    const key = `${body}|${o.lat_deg}|${o.lon_deg}|${o.height_m}|${a}|${b}`;
    if (key === pathKey) return;
    pathKey = key;
    try {
      const sampled = engine.sampleBodies(engineObserver(state), [body], a, b, 10);
      const track = sampled.bodies[0];
      if (!track) {
        path = null;
        return;
      }
      const n = track.alt_apparent_deg.length;
      const alt = new Float64Array(n);
      const az = new Float64Array(n);
      const hourIndex: number[] = [];
      const hourLabel: string[] = [];
      for (let k = 0; k < n; k += 1) {
        alt[k] = track.alt_apparent_deg[k]! * DEG;
        az[k] = track.az_deg[k]! * DEG;
        const w = wallClock(sampled.jd_utc[k]!, zone);
        if (w.minute === 0 && w.second === 0 && k < n - 1) {
          hourIndex.push(k);
          hourLabel.push(String(w.hour).padStart(2, '0'));
        }
      }
      path = { body, bodyKey: bodyToken(body), alt, az, hourIndex, hourLabel };
      notices.dismissKey('sky-path');
    } catch (error) {
      path = null;
      notices.push('caution', `Path of ${body}: ${errorText(error)}`, { key: 'sky-path' });
    }
  }

  function configureProjector(): DomeProjector | PanoramaProjector {
    if (view.mode === 'dome') {
      const margin = 30;
      const radius = Math.max(20, Math.min(cssW, cssH) / 2 - margin);
      dome.configure(cssW / 2, cssH / 2, radius, view.southUp);
      return dome;
    }
    const applied = pano.configure(cssW, cssH, view.panorama);
    view.panorama.fov = applied.fov;
    view.panorama.bottomAlt = applied.bottomAlt;
    return pano;
  }

  function zoomFactor(p: DomeProjector | PanoramaProjector): number {
    // Star sizes grow gently with the scale (pixels per degree near the horizon).
    const pxPerDeg = p instanceof DomeProjector ? (p.radius / 2) * DEG * 1.6 : p.s * DEG;
    return Math.min(1.6, Math.max(0.75, Math.pow(pxPerDeg / 5, 0.3)));
  }

  function draw(): void {
    const t0 = performance.now();
    const state = store.get();
    resizeCanvas();
    if (ease) {
      const u = (t0 - ease.t0) / EASE_MS;
      if (u >= 1) {
        displayJd = ease.to;
        ease = null;
      } else {
        const e = 1 - (1 - u) ** 3;
        displayJd = ease.from + (ease.to - ease.from) * e;
      }
    } else {
      displayJd = state.time.jd_utc;
    }
    const pal = currentPalette(state);
    const observer = engineObserver(state);

    try {
      // The Sun, Moon and planets each frame; the 58 stars come from the star field
      // (a navigational star's own sky_state is fetched only when it is described).
      sky = engine.skyState(observer, displayJd, 'solar_system');
      notices.dismissKey('sky-state');
    } catch (error) {
      sky = null;
      notices.push(
        'caution',
        `Sun, Moon and planets are not available at this time (${errorText(error)}). Stars are still drawn; the sky is shown dark.`,
        { key: 'sky-state' },
      );
    }
    // A pinned catalogue star gives way when the shared selection changes.
    if (pinnedStar !== null && pinnedFor !== state.selection.body) pinnedStar = null;

    const layers = state.layers;
    try {
      scene.update(engine, observer, displayJd, {
        boundaries: layers.constellationBoundaries,
        constellationLabels: layers.constellationNames,
        equator: layers.equator,
        ecliptic: layers.ecliptic,
        daily: state.time.playing && Math.abs(state.time.speed) >= 43_200,
      });
      if (scene.error) notices.push('caution', `Star field: ${scene.error}`, { key: 'sky-stars' });
      else notices.dismissKey('sky-stars');
    } catch (error) {
      notices.push('error', `Sky: ${errorText(error)}`, { key: 'sky-stars' });
    }
    updatePath(state, displayJd);

    const projector = configureProjector();
    scene.project(projector, cssW, cssH);
    const sunAlt = sky ? sky.sun_altitude_deg : Number.NaN;
    const colours = skyColours(Number.isFinite(sunAlt) ? sunAlt : -90, pal);
    const frame: Frame = {
      width: cssW,
      height: cssH,
      projector,
      scene,
      sky,
      layers,
      palette: pal,
      colours,
      limitMag: limitingMagnitude(sunAlt),
      zoom: zoomFactor(projector),
      selectedKey: selectedKey(state),
      highlightKeys,
      focusKey: document.activeElement === canvas ? focusKey : null,
      hoverKey,
      path: path && path.body === state.selection.body ? path : null,
      navigatorTerms: state.settings.navigatorTerms,
    };
    const t1 = performance.now();
    g2!.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderer.draw(frame);
    const t2 = performance.now();
    timer.record(t1 - t0, t2 - t1);
    lastFrame = frame;
    syncChrome(state);
    updateTooltip(state);
    if (ease) requestDraw();
  }

  // --- toolbar and accessible text -----------------------------------------------------
  let chromeKey = '';
  function syncChrome(state: ExplorerState): void {
    const p = view.panorama;
    const key = `${view.mode}|${view.southUp}|${Math.round(p.fov)}|${state.observer.label}|${state.observer.lat_deg}|${state.observer.lon_deg}|${Object.values(state.layers).join('')}`;
    if (key === chromeKey) return;
    chromeKey = key;
    root.dataset.mode = view.mode;
    for (const m of ['dome', 'panorama'] as const) {
      modeButtons[m].setAttribute('aria-checked', String(view.mode === m));
      modeButtons[m].tabIndex = view.mode === m ? 0 : -1;
    }
    southUp.setAttribute('aria-pressed', String(view.southUp));
    southUp.hidden = view.mode !== 'dome';
    look.hidden = view.mode !== 'panorama';
    fovText.textContent = `${Math.round(p.fov)}° wide`;
    zoomIn.disabled = p.fov <= PANORAMA_LIMITS.minFov + 0.5;
    zoomOut.disabled = p.fov >= PANORAMA_LIMITS.maxFov - 0.5;
    for (const [k, box] of layerBoxes) box.checked = state.layers[k];
    const place = state.observer.label || `${formatAngle(state.observer.lat_deg, 'decimal')}, ${formatAngle(state.observer.lon_deg, 'decimal')}`;
    canvas.setAttribute(
      'aria-label',
      view.mode === 'dome'
        ? `Sky chart of the whole sky from ${place}, zenith in the centre, ${view.southUp ? 'south' : 'north'} at the top.`
        : `Panorama of the sky from ${place}, looking ${compassPoint(p.azimuth)}.`,
    );
  }

  // --- targets: hit-testing, focus order, descriptions --------------------------------
  function hitTest(x: number, y: number): Target | null {
    const f = lastFrame;
    if (!f) return null;
    let best: Target | null = null;
    let bestScore = Infinity;
    for (const m of renderer.bodies) {
      if (!m.drawn) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d > m.r + 10) continue;
      const score = d - 6;
      if (score < bestScore) {
        bestScore = score;
        best = { key: m.key, kind: 'body', name: m.name };
      }
    }
    const data = scene.stars;
    if (data && scene.starsOk) {
      const xs = scene.x;
      const ys = scene.y;
      const on = scene.onScreen;
      for (let i = 0; i < scene.n; i += 1) {
        if (on[i] === 0) continue;
        const dx = xs[i]! - x;
        if (dx > 14 || dx < -14) continue;
        const dy = ys[i]! - y;
        if (dy > 14 || dy < -14) continue;
        const m = data.vmag[i]!;
        if (starAlpha(m, f.limitMag) <= 0.01 && data.isNav[i] === 0) continue;
        const d = Math.hypot(dx, dy);
        if (d > starRadius(m) * f.zoom + 8) continue;
        const score = d - 1.2 * Math.max(0, 4 - m);
        if (score < bestScore) {
          bestScore = score;
          best = { key: starKey(i), kind: 'star', index: i };
        }
      }
    }
    return best;
  }

  /** The bright bodies above the horizon, by bearing from north: the keyboard's focus ring. */
  function focusables(): string[] {
    const items: { key: string; az: number }[] = [];
    for (const m of renderer.bodies) if (m.drawn) items.push({ key: m.key, az: m.az });
    const data = scene.stars;
    if (data && scene.starsOk) {
      for (const [, i] of data.navByName) if (scene.onScreen[i] === 1) items.push({ key: starKey(i), az: scene.starAz(i) });
    }
    if (pinnedStar !== null && scene.onScreen[pinnedStar] === 1 && !items.some((t) => t.key === starKey(pinnedStar!))) {
      items.push({ key: starKey(pinnedStar), az: scene.starAz(pinnedStar) });
    }
    return items.sort((a, b) => a.az - b.az).map((t) => t.key);
  }

  function bodyState(name: string, state: ExplorerState): BodyState | null {
    const found = sky?.bodies.find((b) => b.body === name);
    if (found) return found;
    try {
      // A navigational star: its sight-grade place, as the rest of the explorer shows it.
      return engine.skyState(engineObserver(state), displayJd, [name]).bodies[0] ?? null;
    } catch {
      return null;
    }
  }

  function constellationName(abbr: string | null): string | null {
    if (!abbr) return null;
    return scene.catalog?.constellations.find((c) => c.abbr === abbr)?.name ?? abbr;
  }

  interface Description {
    title: string;
    sub: string;
    lines: string[];
    speech: string;
  }

  function describe(key: string, state: ExplorerState): Description | null {
    const fmt: AngleFormat = state.settings.angleFormat;
    const terms = state.settings.navigatorTerms;
    const heightWord = terms ? 'Height above horizon · altitude' : 'Height above horizon';
    const bearingWord = terms ? 'Bearing · azimuth' : 'Bearing';
    const lines: string[] = [];
    let title = '';
    let sub = '';
    let alt = Number.NaN;
    let az = Number.NaN;
    let mag: number | null = null;
    const data = scene.stars;
    let starIndex = -1;
    if (key.startsWith('s:')) starIndex = Number(key.slice(2));
    const canonical = key.startsWith('b:') ? key.slice(2) : starIndex >= 0 && data?.isNav[starIndex] ? data.nameOf.get(starIndex)! : null;
    const b = canonical ? bodyState(canonical, state) : null;
    if (b) {
      title = b.body;
      alt = b.alt_apparent_deg;
      az = b.az_deg;
      mag = b.magnitude;
      const con = constellationName(b.constellation);
      const kind = b.kind === 'star' ? 'Navigational star' : b.kind === 'planet' ? 'Planet' : '';
      sub = [kind, con ? `in ${con}` : ''].filter(Boolean).join(' ');
      if (starIndex >= 0 && data) sub = [starDesignation(data, starIndex), sub].filter(Boolean).join(' · ');
    } else if (starIndex >= 0 && data && starIndex < scene.n) {
      title = starTitle(data, starIndex);
      alt = scene.starAlt(starIndex) * RAD;
      az = scene.starAz(starIndex) * RAD;
      mag = data.vmag[starIndex]!;
      let con: string | null = null;
      try {
        const { ra, dec } = scene.starRaDecDeg(starIndex);
        con = constellationName(engine.constellationAt(ra, dec, displayJd));
      } catch {
        con = null;
      }
      const designation = starDesignation(data, starIndex);
      sub = [title === designation ? '' : designation, con ? `in ${con}` : ''].filter(Boolean).join(' · ');
    } else {
      return null;
    }
    const up = alt >= 0;
    lines.push(`${heightWord}: ${formatAngle(alt, fmt)}${up ? '' : ' (below the horizon)'}`);
    lines.push(`${bearingWord}: ${formatBearing(az, fmt)} (${compassPoint(az)})`);
    if (mag !== null && Number.isFinite(mag)) {
      lines.push(`Magnitude ${formatMagnitude(mag)}${b && b.kind !== 'star' ? '' : ' (catalogue)'}`);
    }
    if (b?.illuminated_fraction !== null && b?.illuminated_fraction !== undefined && b.kind !== 'star') {
      lines.push(`${Math.round(b.illuminated_fraction * 100)} % lit`);
    }
    if (starIndex >= 0 && data && !data.isNav[starIndex]) lines.push('Catalogue star, display only (not used for sights)');
    const speech = `${title}. ${lines.slice(0, 2).join('. ')}.`;
    return { title, sub, lines, speech };
  }

  function updateTooltip(state: ExplorerState): void {
    const f = lastFrame;
    const key = hoverKey ?? (document.activeElement === canvas ? focusKey : null) ?? (pinnedStar !== null ? starKey(pinnedStar) : null);
    if (!f || !key) {
      if (!tooltip.hidden) tooltip.hidden = true;
      tipText = '';
      return;
    }
    const at = renderer.locate(f, key);
    const d = describe(key, state);
    if (!at || !d || Number.isNaN(at.x)) {
      tooltip.hidden = true;
      tipText = '';
      return;
    }
    const text = `${d.title}\n${d.sub}\n${d.lines.join('\n')}`;
    if (text !== tipText) {
      tipText = text;
      tooltip.replaceChildren(
        el('strong', { class: 'sky-tip-title' }, d.title),
        ...(d.sub ? [el('span', { class: 'sky-tip-sub' }, d.sub)] : []),
        ...d.lines.map((line) => el('span', { class: 'sky-tip-line' }, line)),
      );
    }
    tooltip.hidden = false;
    // Beside the body, kept inside the stage.
    const w = tooltip.offsetWidth;
    const h = tooltip.offsetHeight;
    const ax = hoverKey && hoverAt ? hoverAt.x : at.x;
    const ay = hoverKey && hoverAt ? hoverAt.y : at.y;
    let x = ax + 16;
    let y = ay + 14;
    if (x + w > cssW - 6) x = ax - 16 - w;
    if (y + h > cssH - 6) y = ay - 14 - h;
    tooltip.style.transform = `translate(${Math.max(6, Math.round(x))}px, ${Math.max(6, Math.round(y))}px)`;
    if (key === focusKey && document.activeElement === canvas && d.speech !== liveText) {
      liveText = d.speech;
      live.textContent = d.speech;
    }
  }

  // --- selection -----------------------------------------------------------------------
  function select(key: string | null): void {
    if (!key) {
      pinnedStar = null;
      requestDraw();
      return;
    }
    if (key.startsWith('b:')) {
      pinnedStar = null;
      store.patch({ selection: { body: key.slice(2) } });
    } else {
      const i = Number(key.slice(2));
      const nav = scene.stars?.isNav[i] ? scene.stars.nameOf.get(i) : undefined;
      if (nav) {
        pinnedStar = null;
        store.patch({ selection: { body: nav } });
      } else {
        pinnedStar = i;
        pinnedFor = store.get().selection.body;
      }
    }
    requestDraw();
  }

  // --- pointer -------------------------------------------------------------------------
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; az: number; bottom: number; moved: boolean } | null = null;
  let pinch: { dist: number; fov: number } | null = null;

  function local(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e: PointerEvent): void {
    const p = local(e);
    pointers.set(e.pointerId, p);
    canvas.setPointerCapture?.(e.pointerId);
    if (pointers.size === 2 && view.mode === 'panorama') {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), fov: view.panorama.fov };
      drag = null;
      return;
    }
    drag = { x: p.x, y: p.y, az: view.panorama.azimuth, bottom: view.panorama.bottomAlt, moved: false };
  }

  function onPointerMove(e: PointerEvent): void {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (dist > 10) {
        view.panorama.fov = Math.min(PANORAMA_LIMITS.maxFov, Math.max(PANORAMA_LIMITS.minFov, (pinch.fov * pinch.dist) / dist));
        view.aimed = true;
        requestDraw();
      }
      return;
    }
    if (drag && pointers.has(e.pointerId)) {
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved && view.mode === 'panorama') {
        // The sky follows the pointer.
        view.panorama.azimuth = (((drag.az - (dx / pano.s) * RAD) % 360) + 360) % 360;
        view.panorama.bottomAlt = inverseMercator(mercator(drag.bottom * DEG) + dy / pano.s) * RAD;
        view.aimed = true;
        hoverKey = null;
        requestDraw();
      }
      if (drag.moved) return;
    }
    const hit = hitTest(p.x, p.y);
    const key = hit?.key ?? null;
    hoverAt = p;
    canvas.style.cursor = key ? 'pointer' : view.mode === 'panorama' ? 'grab' : 'default';
    if (key !== hoverKey || key) {
      hoverKey = key;
      requestDraw();
    }
  }

  function onPointerUp(e: PointerEvent): void {
    const wasDrag = drag?.moved ?? false;
    const wasPinch = pinch !== null;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) drag = null;
    if (wasDrag || wasPinch || e.type === 'pointercancel') return;
    const p = local(e);
    const hit = hitTest(p.x, p.y);
    select(hit?.key ?? null);
  }

  function onPointerLeave(): void {
    if (pointers.size > 0) return;
    hoverKey = null;
    hoverAt = null;
    requestDraw();
  }

  function zoomBy(factor: number, at?: { x: number; y: number }): void {
    if (view.mode !== 'panorama') return;
    const before = view.panorama.fov;
    const next = Math.min(PANORAMA_LIMITS.maxFov, Math.max(PANORAMA_LIMITS.minFov, before * factor));
    if (next === before) return;
    if (at) {
      // Keep the direction under the pointer where it is.
      pano.unproject(at.x, at.y);
      const az = pano.az;
      const alt = pano.alt;
      const s2 = pano.s * (before / next);
      view.panorama.azimuth = (((az * RAD - ((at.x - cssW / 2) / s2) * RAD) % 360) + 360) % 360;
      const yH = at.y + s2 * mercator(alt);
      view.panorama.bottomAlt = inverseMercator((yH - cssH) / s2) * RAD;
    }
    view.panorama.fov = next;
    view.aimed = true;
    requestDraw();
  }

  function onWheel(e: WheelEvent): void {
    if (view.mode !== 'panorama') return;
    e.preventDefault();
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomBy(Math.exp(step * 0.0015), local(e));
  }

  // --- keyboard ------------------------------------------------------------------------
  function onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = focusables();
      if (list.length === 0) return;
      const at = focusKey ? list.indexOf(focusKey) : -1;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      focusKey = list[(at + step + list.length) % list.length] ?? null;
      if (at < 0 && step < 0) focusKey = list[list.length - 1]!;
      hoverKey = null;
      e.preventDefault();
      requestDraw();
    } else if (e.key === 'Enter') {
      if (focusKey) {
        select(focusKey);
        e.preventDefault();
      }
    } else if (e.key === 'Escape') {
      focusKey = null;
      hoverKey = null;
      pinnedStar = null;
      live.textContent = '';
      liveText = '';
      requestDraw();
    } else if (e.key === '+' || e.key === '=') {
      zoomBy(1 / 1.25);
      e.preventDefault();
    } else if (e.key === '-' || e.key === '_') {
      zoomBy(1.25);
      e.preventDefault();
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('focus', requestDraw);
  canvas.addEventListener('blur', requestDraw);
  cleanups.push(() => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('focus', requestDraw);
    canvas.removeEventListener('blur', requestDraw);
  });

  // --- toolbar -------------------------------------------------------------------------
  function setMode(mode: SkyMode): void {
    if (view.mode === mode) return;
    view.mode = mode;
    if (mode === 'panorama' && !view.aimed) {
      view.panorama.azimuth = store.get().observer.lat_deg >= 0 ? 180 : 0;
    }
    hoverKey = null;
    requestDraw();
  }
  for (const m of ['dome', 'panorama'] as const) {
    modeButtons[m].addEventListener('click', () => setMode(m));
  }
  modeGroup.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const next: SkyMode = view.mode === 'dome' ? 'panorama' : 'dome';
      setMode(next);
      modeButtons[next].focus();
      e.preventDefault();
    }
  });
  southUp.addEventListener('click', () => {
    view.southUp = !view.southUp;
    requestDraw();
  });
  zoomIn.addEventListener('click', () => zoomBy(1 / 1.25));
  zoomOut.addEventListener('click', () => zoomBy(1.25));

  // --- store, theme, size --------------------------------------------------------------
  cleanups.push(
    store.select(
      (s) => s.time.jd_utc,
      (jd) => {
        const t = store.get().time;
        const now = performance.now();
        const shown = displayJd; // mid-glide, where the sky is now
        const step = Math.abs(jd - shown);
        if (!t.playing && !reducedMotion() && Number.isFinite(shown) && step > 0 && step <= EASE_MAX_DAYS) {
          ease = { from: shown, to: jd, t0: now };
        } else {
          ease = null;
          displayJd = jd;
        }
        requestDraw();
      },
    ),
  );
  cleanups.push(
    store.select(
      (s) => [s.observer, s.layers, s.settings, s.selection] as const,
      () => requestDraw(),
      { equals: (a, b) => a.every((v, i) => Object.is(v, b[i])) },
    ),
  );
  cleanups.push(
    highlights.subscribe(() => {
      resolveHighlights();
      requestDraw();
    }),
  );
  if (typeof MutationObserver === 'function') {
    // Re-read the tokens only when the theme really changes (writing the same value
    // again still produces a mutation record).
    const mo = new MutationObserver(() => {
      if (documentTheme(store.get().settings.theme) !== paletteTheme) {
        palette = null;
        requestDraw();
      }
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    cleanups.push(() => mo.disconnect());
  }
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => requestDraw());
    ro.observe(stage);
    cleanups.push(() => ro.disconnect());
  }
  const onWindowResize = (): void => requestDraw();
  globalThis.addEventListener?.('resize', onWindowResize);
  cleanups.push(() => globalThis.removeEventListener?.('resize', onWindowResize));
  const onFonts = (): void => {
    palette = null;
    requestDraw();
  };
  document.fonts?.addEventListener?.('loadingdone', onFonts);
  cleanups.push(() => document.fonts?.removeEventListener?.('loadingdone', onFonts));

  requestDraw();

  return {
    canvas,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      scheduler.cancel(drawTask);
      while (cleanups.length) {
        try {
          cleanups.pop()!();
        } catch (error) {
          console.error('sky clean-up failed', error);
        }
      }
    },
    highlightBodies(names) {
      highlights.set(names);
    },
    setMode,
    setSouthUp(on) {
      view.southUp = on;
      requestDraw();
    },
    setPanorama(v) {
      if (v.azimuth !== undefined && Number.isFinite(v.azimuth)) view.panorama.azimuth = ((v.azimuth % 360) + 360) % 360;
      if (v.fov !== undefined && Number.isFinite(v.fov)) view.panorama.fov = v.fov;
      if (v.bottomAlt !== undefined && Number.isFinite(v.bottomAlt)) view.panorama.bottomAlt = v.bottomAlt;
      view.aimed = true;
      requestDraw();
    },
    stats: () => timer.stats(),
    resetStats: () => timer.reset(),
    drawNow() {
      if (!destroyed) {
        scheduler.cancel(drawTask);
        draw();
      }
    },
    locate(name) {
      const f = lastFrame;
      if (!f) return null;
      const lower = name.trim().toLowerCase();
      const body = renderer.bodies.find((m) => m.name.toLowerCase() === lower);
      const star = scene.stars?.byName.get(lower);
      const key = body ? body.key : star !== undefined ? starKey(star) : null;
      if (!key) return null;
      const at = renderer.locate(f, key);
      if (!at || Number.isNaN(at.x)) return null;
      const visible = at.alt >= 0 && at.x >= 0 && at.x <= cssW && at.y >= 0 && at.y <= cssH;
      return { x: at.x, y: at.y, visible };
    },
  };
}

/** The Sky view as a plain component (`Component = (host, ctx) => {destroy}`). */
export const sky: Component = (host, ctx) => mountSky(host, ctx);
