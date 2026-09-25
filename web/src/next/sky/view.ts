/**
 * The Sky view (EXPLORER_PLAN §2): what you would see from the chosen place at the
 * chosen time, as a zenith-centred dome or a horizon panorama. OWNER: sky agent; the
 * astronomy layers, search, info card, field of view, "Up close" and the picture are the
 * sky2 agent's (expansion Q3).
 *
 * Component contract (`component.ts`): `sky(host, ctx)` takes over `host` and returns
 * `{destroy}` plus the extras of `SkyMounted`. It draws only in the scheduler's frames,
 * never mutates engine results, and cleans up everything in `destroy`.
 *
 * Shared state it reads: place, time, selection, layers, theme, angle format and the sky's
 * darkness (the store). Shared state it writes: `selection.body` (click or Enter on a
 * canonical body) and `layers` and `settings.sky*` (the Layers menu). Its own view settings
 * — dome or panorama, south up, where the panorama looks, the field of view, the close-up's
 * orientation — live per explorer in memory, so leaving the view and coming back keeps
 * them; they are not persisted (state.ts privacy rules).
 *
 * Display-only data (CONVENTIONS 13.6): the star field, deep-sky objects, the Milky Way,
 * meteor radiants and every estimate here are drawn and described and nowhere feed
 * navigation. Only canonical bodies (the Sun, Moon, planets and the 58 navigational stars)
 * become the shared selection; anything else is pinned locally and described by the
 * view's own card.
 *
 * Budget (EXPLORER_PLAN §3.7, brief Q3): 9 000 stars plus the deep-sky objects and the
 * Milky Way in ≤ 10 ms a frame. Engine calls per frame: `sky_state` (Sun, Moon, planets),
 * `sidereal`, and `custom_body_states` when bodies were added; everything else is per
 * simulated hour (`starfield_apparent`, `dso_list`), per year (`meteor_showers`), per sky
 * setting (`extinction_table`), per night when the time settles (`tonight`), or on demand
 * (search, the card's best time, "Up close").
 */

import './sky.css';
import type { Component, Ctx, Mounted } from '../component.js';
import {
  isDeepSkyEngine,
  isPlanetDetailEngine,
  type BodyState,
  type CustomBodyInput,
  type DsoVisibility,
  type SearchHit,
  type ShowerYear,
  type SkyState,
  type Tonight,
} from '../engine/types.js';
import { saveBlob, fileName } from '../export/csv.js';
import { canShareFiles, shareFile } from '../export/png.js';
import { fastPlayback } from '../playback.js';
import { dateMedium, eventTime, otherDay } from '../shell/format.js';
import {
  currentDayWindow,
  displayZone,
  engineObserver,
  type AngleFormat,
  type ExplorerState,
  type Layers,
} from '../state.js';
import { wallClock, formatWithUtc } from '../time.js';
import { timeInfoAt, withUncertainty } from '../time/chip.js';
import { DEG, limitingMagnitude, nextRise, RAD, refractionArcmin } from './astro.js';
import { infoCard, type CardContent, type CardLine } from './card.js';
import { BORTLE_WORDS, milkyWayVisibility, skyConditions, skyModel, zenithLimit, extinctionAt, type SkyModel } from './conditions.js';
import { customBodies } from './custom.js';
import { dsoReach, DSO_TYPE_WORDS } from './deepsky.js';
import { compassPoint, formatAngle, formatBearing, formatDec, formatMagnitude, formatRa } from './format.js';
import { DEFAULT_FOV, FOV_PRESETS, fovLabel, fovOutline, cameraField, sensorOf, SENSORS, type FovPresetId, type FovSettings } from './fov.js';
import { skyHighlights } from './highlight.js';
import { layersMenu, type LayersMenu } from './layers-menu.js';
import { activeShowers, rateWords, tonightFor, yearsFor, type ActiveShower } from './meteors.js';
import {
  buildMilkyWayGrid,
  extinctionFade,
  horizonToGalactic,
  matrixDelta,
  rasterMilkyWay,
  type MilkyWayGrid,
  type RasterView,
} from './milkyway.js';
import {
  documentReadVar,
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
import {
  bodyKey,
  bodyToken,
  constellationKey,
  customKey,
  deepSkyKey,
  pointKey,
  radiantKey,
  SkyRenderer,
  starKey,
  type CustomMark,
  type FovOutline,
  type Frame,
  type MilkyWayImage,
  type PathData,
  type PointMark,
  type RadiantMark,
} from './render.js';
import { skyRequests, type SkyTarget } from './requests.js';
import { SkyScene } from './scene.js';
import { KIND_WORDS, skySearchBox, type SearchBox } from './search.js';
import { composeSnapshot, canvasBlob, type SnapshotCaption } from './snapshot.js';
import { fovIcon, kindSymbol, saveIcon } from './symbols.js';
import { upClosePanel, upCloseSupported, type UpClosePanel, type UpCloseSettings } from './upclose.js';
import { button, iconButton, phaseChip, popover, segmented, setPressed, type Popover } from '../theme/primitives.js';
import { bodyGlyph } from '../theme/glyphs.js';
import { currentTheme, onThemeChange } from '../theme/theme.js';
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
  /** The field-of-view outline (sky2 agent). */
  fov: FovSettings;
  /** How the "Up close" inset is turned (sky2 agent). */
  upClose: UpCloseSettings;
}

const viewSettings = new WeakMap<object, SkyViewSettings>();

/** This explorer's Sky view settings (kept in memory while the page is open). */
export function skyViewSettings(ctx: Pick<Ctx, 'store'>): SkyViewSettings {
  return settingsFor(ctx);
}

function settingsFor(ctx: Pick<Ctx, 'store'>): SkyViewSettings {
  let s = viewSettings.get(ctx.store);
  if (!s) {
    s = {
      mode: 'dome',
      southUp: false,
      panorama: { azimuth: 180, fov: 180, bottomAlt: -8 },
      aimed: false,
      fov: { ...DEFAULT_FOV },
      upClose: { orientation: 'seen', mirror: false },
    };
    viewSettings.set(ctx.store, s);
  }
  return s;
}

/** What the view draws now: for tests, the developer page and ui-check (sky2 agent). */
export interface SkyInfo {
  /** Faintest magnitude drawn at the zenith. */
  limit: number;
  dsoShown: number;
  /** Texels of the Milky Way raster carrying glow (0: none drawn). */
  milkyWayTexels: number;
  milkyWayVisibility: number;
  radiants: string[];
  custom: string[];
  /** The pinned (non-canonical) target's key, or null. */
  pinned: string | null;
  /** The card's title, or null. */
  card: string | null;
  upClose: string | null;
  fov: string;
  /** Milliseconds the last search took in the engine. */
  lastSearchMs: number;
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
   * star-field name, or (sky2) a deep-sky id such as "M31"), with `visible` false below
   * the horizon or outside the view.
   */
  locate(name: string): { x: number; y: number; visible: boolean } | null;
  // --- sky2 agent ---
  /** Show a sky object as `showInSky` does (pinned or selected, its card open, faced in the panorama). */
  show(target: SkyTarget, options?: { face?: boolean }): boolean;
  /** Open the "Up close" inset for the Moon or a planet. */
  openUpClose(body: string): void;
  /** Run a query in the Sky view's search box (opening it); the hits. */
  search(query: string): SearchHit[];
  /** Set the field of view (a preset id, or null to remove it), anchored as given. */
  setFov(preset: FovPresetId | null, anchor?: FovSettings['anchor']): void;
  /** The picture "Save as image" makes, without saving it. */
  snapshot(): HTMLCanvasElement | null;
  info(): SkyInfo;
}

/** Time steps up to this size (days) glide instead of jumping. */
const EASE_MAX_DAYS = 0.25;
const EASE_MS = 260;
/** The Milky Way's raster is made again when the sky has turned this far (radians of rotation, about 0.1°). */
const MW_TURN = 1.8e-3;
/** How many texels the Milky Way's raster may have (its cost per frame is about 40 ns each). */
const MW_TEXELS = 22_000;
/** How long the time must be still before the night's estimates are made again, ms. */
const SETTLE_MS = 350;

/** The Sky's Layers menu (the shell has none: every layer flag is offered by the map or here). */
export const SKY_LAYER_OPTIONS: readonly { key: keyof Layers; label: string; note?: string; group: 'sky' | 'lines' | 'dark' }[] = [
  { key: 'constellations', label: 'Constellation figures', group: 'sky' },
  { key: 'constellationNames', label: 'Constellation names', group: 'sky' },
  { key: 'constellationBoundaries', label: 'Constellation boundaries', note: 'IAU, as agreed in 1930', group: 'sky' },
  { key: 'starNames', label: 'Star names', group: 'sky' },
  { key: 'paths', label: 'Today’s path of the selected body', group: 'sky' },
  // sky2 agent: the astronomy layers.
  { key: 'milkyWay', label: 'Milky Way', note: 'its glow, where a dark sky shows it', group: 'sky' },
  { key: 'deepSky', label: 'Deep-sky objects', note: 'Messier and the brightest NGC and IC objects', group: 'sky' },
  { key: 'meteorRadiants', label: 'Meteor radiants', note: 'while a shower is active', group: 'sky' },
  { key: 'customBodies', label: 'Comets and asteroids you added', group: 'sky' },
  { key: 'altAzGrid', label: 'Height and bearing grid', group: 'lines' },
  { key: 'raDecGrid', label: 'Right ascension and declination grid', note: 'the sky’s own coordinates', group: 'lines' },
  { key: 'meridian', label: 'Meridian', note: 'north to south through the zenith', group: 'lines' },
  { key: 'equator', label: 'Celestial equator', group: 'lines' },
  { key: 'ecliptic', label: 'Ecliptic', note: 'the Sun’s yearly path', group: 'lines' },
  { key: 'extinction', label: 'Dimmer toward the horizon', note: 'the air’s extinction', group: 'dark' },
];

const PLANETS = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

/** The Milky Way's filled grid per engine: built once, kept across visits to the view. */
const milkyWayGrids = new WeakMap<object, MilkyWayGrid>();

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

/** A key's kind: `b` body, `s` star, `d` deep sky, `r` radiant, `c` added body, `k` constellation, `p` a named direction. */
function keyKind(key: string | null): string {
  return key ? key.slice(0, 1) : '';
}

/** Mount the Sky view. `sky` below is the same with the plain component signature. */
export function mountSky(host: HTMLElement, ctx: Ctx): SkyMounted {
  const { store, engine, notices, scheduler } = ctx;
  const view = settingsFor(ctx);
  const highlights = skyHighlights(ctx);
  const requests = skyRequests(ctx);
  const added = customBodies(ctx);
  const cleanups: (() => void)[] = [];
  let destroyed = false;

  // --- DOM: the canvas, with the controls floating over it as on the map --------------
  const root = el('div', { class: 'sky' });
  const canvas = el('canvas', { class: 'sky-canvas', tabindex: '0', role: 'img' });
  const tooltip = el('div', { class: 'sky-tip sf-on-stage', role: 'status', 'aria-live': 'off' });
  tooltip.hidden = true;
  const live = el('p', { class: 'sky-sr', 'aria-live': 'polite' });
  const hint = el(
    'p',
    { class: 'sky-sr', id: `sky-hint-${Math.random().toString(36).slice(2, 8)}` },
    'Up and down arrow keys move between the Sun, Moon, planets and navigational stars above the horizon; ' +
      'Enter selects, and Enter again on the Moon or a planet opens its close-up; Escape clears. ' +
      'In the panorama, plus and minus zoom. The Search button finds any star, deep-sky object, constellation or meteor shower by name.',
  );
  canvas.setAttribute('aria-describedby', hint.id);

  const modeControl = segmented<SkyMode>({
    label: 'Sky view',
    value: view.mode,
    size: 'sm',
    class: 'sf-float',
    onChange: (mode) => setMode(mode),
    options: [
      { value: 'dome', label: 'Dome', icon: 'sky', tip: 'The whole sky, with the zenith in the middle' },
      { value: 'panorama', label: 'Panorama', icon: 'compass', tip: 'Toward the horizon: drag to turn, scroll to zoom' },
    ],
  });
  const southUp = button({
    label: 'South up',
    size: 'sm',
    class: 'sf-float',
    pressed: view.southUp,
    tip: 'Turn the chart so south is at the top',
    onClick: () => {
      view.southUp = !view.southUp;
      requestDraw();
    },
  });
  const layersButton = button({
    label: 'Layers',
    icon: 'layers',
    size: 'sm',
    class: 'sf-float',
    tip: 'Constellations, the Milky Way, deep-sky objects, grids, and how dark your sky is',
  });
  const menu: LayersMenu = layersMenu(ctx, SKY_LAYER_OPTIONS);
  cleanups.push(() => menu.destroy());
  let menuOpen = false;
  const layersPopover = popover(layersButton, menu.el, {
    label: 'Sky layers',
    placement: 'bottom-end',
    onStage: true,
    onOpen: () => {
      menuOpen = true;
      syncMenu();
    },
    onClose: () => {
      menuOpen = false;
    },
  });
  cleanups.push(() => layersPopover.destroy());

  const zoomIn = iconButton('plus', 'Zoom in: a narrower field', { variant: 'secondary', tip: 'Zoom in', onClick: () => zoomBy(1 / 1.25) });
  const zoomOut = iconButton('minus', 'Zoom out: a wider field', { variant: 'secondary', tip: 'Zoom out', onClick: () => zoomBy(1.25) });
  const lookButtons = (['N', 'E', 'S', 'W'] as const).map((d, k) =>
    button({
      label: d,
      size: 'sm',
      tip: `Look ${['north', 'east', 'south', 'west'][k]}`,
      ariaLabel: `Look ${['north', 'east', 'south', 'west'][k]}`,
      onClick: () => {
        view.aimed = true;
        view.panorama.azimuth = k * 90;
        requestDraw();
      },
    }),
  );
  const face = iconButton('target', 'Face the selected body', {
    variant: 'secondary',
    class: 'sf-float',
    tip: 'Face the selected body',
    onClick: () => faceSelected(),
  });
  const panoControls = el(
    'div',
    { class: 'sky-ov sky-ov--r sf-on-stage' },
    el('div', { class: 'sf-btn-group' }, zoomIn, zoomOut),
    el('div', { class: 'sf-btn-group sky-look', role: 'group', 'aria-label': 'Look toward' }, ...lookButtons),
    face,
  );
  const statusText = el('span', { class: 'sky-status__text' });
  const status = el('div', { class: 'sky-ov sky-ov--tl sf-on-stage' }, el('div', { class: 'sky-status sf-float' }, statusText));
  const topRight = el('div', { class: 'sky-ov sky-ov--tr sf-on-stage' }, southUp, modeControl.el, layersButton);

  // --- sky2: the tools (search, tonight's best, field of view, picture) --------------
  const searchButton = iconButton('search', 'Find in the sky', { variant: 'secondary', class: 'sf-float', tip: 'Find a star, planet, deep-sky object or shower by name' });
  const tonightButton = iconButton('list', 'Tonight’s best deep-sky objects', { variant: 'secondary', class: 'sf-float', tip: 'Tonight’s best deep-sky objects for this sky' });
  const fovButton = button({ ariaLabel: 'Field of view', variant: 'secondary', class: 'sf-float', tip: 'Binoculars, a telescope or a camera: how much of the sky they take in' });
  fovButton.prepend(fovIcon());
  const saveButton = button({ ariaLabel: 'Save the sky as a picture', variant: 'secondary', class: 'sf-float', tip: 'Save the sky as a picture, with the place and time' });
  saveButton.prepend(saveIcon());
  const tools = el('div', { class: 'sky-ov sky-ov--tools sf-on-stage', role: 'toolbar', 'aria-label': 'Sky tools', 'aria-orientation': 'vertical' }, searchButton, tonightButton, fovButton, saveButton);

  let lastSearchMs = 0;
  const searchBox: SearchBox = skySearchBox({
    engine,
    where: () => ({ observer: engineObserver(store.get()), jd: displayJd }),
    shapeOf: (id) => {
      const i = scene.dso.indexOf(id);
      return i >= 0 ? (scene.dso.shape[i] as never) : undefined;
    },
    onChoose: (hit) => {
      searchPopover.close({ returnFocus: false });
      applyHit(hit);
      canvas.focus({ preventScroll: true });
    },
    onSearched: (_q, ms) => {
      lastSearchMs = ms;
    },
  });
  cleanups.push(() => searchBox.destroy());
  const searchPopover: Popover = popover(searchButton, searchBox.el, {
    label: 'Find in the sky',
    placement: 'bottom-start',
    onStage: true,
    onOpen: () => {
      requestAnimationFrame(() => searchBox.input.focus({ preventScroll: true }));
    },
  });
  cleanups.push(() => searchPopover.destroy());

  const rankingList = el('ol', { class: 'sky-rank__list' });
  const rankingNote = el('p', { class: 'sky-rank__note' });
  const rankingBox = el('div', { class: 'sky-rank' }, el('div', { class: 'sf-popover__title' }, 'Tonight’s best deep-sky objects'), rankingList, rankingNote);
  const rankingPopover: Popover = popover(tonightButton, rankingBox, {
    label: 'Tonight’s best deep-sky objects',
    placement: 'bottom-start',
    onStage: true,
    onOpen: () => renderRanking(true),
  });
  cleanups.push(() => rankingPopover.destroy());

  const fovBox = buildFovBox();
  const fovPopover: Popover = popover(fovButton, fovBox.el, { label: 'Field of view', placement: 'bottom-start', onStage: true, onOpen: () => fovBox.sync() });
  cleanups.push(() => fovPopover.destroy());

  saveButton.addEventListener('click', () => {
    void saveImage();
  });

  // --- sky2: the info card and the close-up ------------------------------------------
  const card = infoCard(
    (id) => onCardAction(id),
    () => {
      cardKey = null;
      pinnedKey = null;
      foundConstellation = -1;
      requestDraw();
      canvas.focus({ preventScroll: true });
    },
  );
  cleanups.push(() => card.destroy());
  let cardOpener: HTMLElement | null = null;
  const upClose: UpClosePanel = upClosePanel(ctx, view.upClose, () => closeUpClose());
  cleanups.push(() => upClose.destroy());

  root.append(canvas, tooltip, topRight, panoControls, status, tools, card.el, upClose.el, live, hint);
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
  /**
   * A local target the shared selection cannot hold: a catalogue star (`s:`), a deep-sky
   * object (`d:`), a radiant (`r:`), an added body (`c:`), a constellation (`k:`).
   */
  let pinnedKey: string | null = null;
  /** The shared selection when the target was pinned; a new selection unpins it. */
  let pinnedFor: string | null = store.get().selection.body;
  /** The card on show is for this key (null: none). */
  let cardKey: string | null = null;
  /** A constellation the search found: its figure is drawn brighter. */
  let foundConstellation = -1;
  /** A named direction another view asked for (`point`): its J2000 unit vector. */
  let pointTarget: { label: string; ra2000: number; dec2000: number; j2000: Float64Array } | null = null;
  let pointMark: PointMark | null = null;
  let lastFrame: Frame | null = null;
  let sky: SkyState | null = null;
  let path: PathData | null = null;
  let pathKey = '';
  let dayWindowCache: { zone: string; a: number; b: number } | null = null;
  let tipText = '';
  let tipSize = { w: 0, h: 0 };
  let liveText = '';

  // sky2: the sky's darkness, the Milky Way, showers, the night's estimates.
  let model: SkyModel | null = null;
  let zenith = 6.5;
  let dsoShown = 0;
  let mwGrid: MilkyWayGrid | null = milkyWayGrids.get(engine) ?? null;
  let mwError: string | null = null;
  let mwPending = false;
  let mwCanvas: HTMLCanvasElement | null = null;
  let mwImageData: ImageData | null = null;
  let mwKey = '';
  const mwMatrix = new Float64Array(9);
  let mwTexels = 0;
  let mwVisible = 0;
  let mwFade: Float32Array | null = null;
  let mwFadeFor: Float32Array | null = null;
  let mwLastRaster = 0;
  const showerYears = new Map<number, ShowerYear | null>();
  const showerPending = new Set<number>();
  let active: ActiveShower[] = [];
  let radiantMarks: RadiantMark[] = [];
  let customMarks: CustomMark[] = [];
  let customError = '';
  let tonight: Tonight | null = null;
  let tonightKey = '';
  let tonightTimer: ReturnType<typeof setTimeout> | null = null;
  let tonightError = '';
  const dsoVisibility = new Map<string, DsoVisibility | string>();
  const fovPoints = new Float64Array(3 * 200);

  const highlightKeys = new Set<string>();
  const resolveHighlights = (): void => {
    highlightKeys.clear();
    const data = scene.stars;
    for (const name of highlights.get()) {
      const lower = name.toLowerCase();
      const body = PLANETS.map((b) => b.toLowerCase()).indexOf(lower);
      if (body >= 0) {
        highlightKeys.add(bodyKey(PLANETS[body]!));
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

  /** The host's size from the ResizeObserver (no layout read per frame); null until known. */
  let observed: { w: number; h: number } | null = null;

  function resizeCanvas(): boolean {
    if (!observed) {
      const rect = root.getBoundingClientRect();
      observed = { w: rect.width, h: rect.height };
    }
    const w = Math.max(1, Math.round(observed.w));
    const h = Math.max(1, Math.round(observed.h));
    const d = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
    if (w === cssW && h === cssH && d === dpr) return false;
    cssW = w;
    cssH = h;
    dpr = d;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    return true;
  }

  function currentPalette(): SkyPalette {
    // The theme on screen (<html data-theme>, applied by the shell), never the setting: the
    // setting may be 'system', and the device's preference can change under it.
    const theme: SkyTheme = currentTheme();
    if (!palette || paletteTheme !== theme) {
      palette = readPalette(theme, documentReadVar);
      paletteTheme = theme;
      renderer.setPalette(palette);
      mwKey = '';
    }
    return palette;
  }

  function selectedKey(state: ExplorerState): string | null {
    if (pinnedKey !== null) return pinnedKey;
    const body = state.selection.body;
    if (!body) return null;
    const star = scene.stars?.navByName.get(body);
    if (star !== undefined) return starKey(star);
    return bodyKey(body);
  }

  function updatePath(state: ExplorerState, frameJd: number, fast: boolean): void {
    const body = state.selection.body;
    // While time runs at weeks a second and more, a "today" changes every frame: no path.
    if (!state.layers.paths || !body || fast) {
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

  /** Pixels per degree near the middle of the view (the dome's zenith, the panorama's horizon). */
  function pxPerDeg(p: DomeProjector | PanoramaProjector): number {
    return p instanceof DomeProjector ? (p.radius / 2) * DEG : p.s * DEG;
  }

  function zoomFactor(p: DomeProjector | PanoramaProjector): number {
    // Star sizes grow gently with the scale (pixels per degree near the horizon).
    const px = p instanceof DomeProjector ? (p.radius / 2) * DEG * 1.6 : p.s * DEG;
    return Math.min(1.6, Math.max(0.75, Math.pow(px / 5, 0.3)));
  }

  /** The engine's answer for the sky's darkness, asked once per setting. */
  function currentModel(state: ExplorerState): SkyModel {
    const key = JSON.stringify(skyConditions(state.settings));
    if (!model || model.key !== key) {
      model = skyModel(engine, state.settings);
      tonightKey = '';
      dsoVisibility.clear();
    }
    return model;
  }

  // --- sky2: the Milky Way's raster --------------------------------------------------
  function milkyWayImage(p: DomeProjector | PanoramaProjector, pal: SkyPalette, ext: Float32Array | null, fast: boolean): MilkyWayImage | null {
    mwVisible = milkyWayVisibility(zenith);
    if (mwVisible <= 0 || typeof document === 'undefined') {
      mwTexels = 0;
      return null;
    }
    if (!mwGrid && !mwError && !mwPending) {
      if (!isDeepSkyEngine(engine)) mwError = 'The Milky Way is not available in this engine.';
      else {
        // Filling the rings takes a few milliseconds, once: away from the frame.
        mwPending = true;
        setTimeout(() => {
          mwPending = false;
          if (destroyed || !isDeepSkyEngine(engine)) return;
          try {
            mwGrid = milkyWayGrids.get(engine) ?? buildMilkyWayGrid(engine.milkyWayOutline());
            milkyWayGrids.set(engine, mwGrid);
          } catch (error) {
            mwError = errorText(error);
          }
          requestDraw();
        }, 0);
      }
    }
    if (!mwGrid) return null;
    const cell = Math.max(4, Math.ceil(Math.sqrt((cssW * cssH) / MW_TEXELS)));
    const w = Math.ceil(cssW / cell);
    const h = Math.ceil(cssH / cell);
    if (!mwCanvas) mwCanvas = document.createElement('canvas');
    if (!mwImageData || mwImageData.width !== w || mwImageData.height !== h) {
      mwCanvas.width = w;
      mwCanvas.height = h;
      const g = mwCanvas.getContext('2d');
      if (!g) return null;
      mwImageData = g.createImageData(w, h);
      mwKey = '';
    }
    const m = horizonToGalactic(scene.hm, scene.frame);
    const rv: RasterView =
      p instanceof DomeProjector
        ? { kind: 'dome', cx: p.cx, cy: p.cy, radius: p.radius, southUp: p.southUp }
        : { kind: 'panorama', width: cssW, az0: p.az0, s: p.s, yHorizon: p.yHorizon };
    if (ext !== mwFadeFor) {
      mwFade = ext ? extinctionFade(ext) : null;
      mwFadeFor = ext;
      mwKey = '';
    }
    const key = `${w}x${h}|${cell}|${JSON.stringify(rv)}|${mwVisible.toFixed(2)}|${pal.theme}|${ext ? 1 : 0}`;
    const now = performance.now();
    const stale = key !== mwKey || matrixDelta(m, mwMatrix) > MW_TURN;
    // Spinning at weeks a second, a new raster ten times a second is plenty.
    if (stale && !(fast && key === mwKey && now - mwLastRaster < 100)) {
      mwTexels = rasterMilkyWay(mwGrid, { data: mwImageData!.data, width: w, height: h, cell }, rv, m, {
        r: pal.milkyWay.r,
        g: pal.milkyWay.g,
        b: pal.milkyWay.b,
        alpha: 0.32 * mwVisible,
        fade: mwFade,
      });
      mwCanvas.getContext('2d')!.putImageData(mwImageData!, 0, 0);
      mwKey = key;
      mwMatrix.set(m);
      mwLastRaster = now;
    }
    return mwTexels > 0 ? { source: mwCanvas, width: w, height: h, cell } : null;
  }

  // --- sky2: meteor radiants -----------------------------------------------------------
  function showerYear(year: number, fast: boolean): ShowerYear | null {
    if (showerYears.has(year)) return showerYears.get(year) ?? null;
    if (fast || showerPending.has(year) || !isDeepSkyEngine(engine)) return null;
    showerPending.add(year);
    // A year of showers takes tens of milliseconds: away from the frame.
    setTimeout(() => {
      showerPending.delete(year);
      if (destroyed || !isDeepSkyEngine(engine)) return;
      try {
        showerYears.set(year, engine.meteorShowers(year));
      } catch {
        showerYears.set(year, null);
      }
      requestDraw();
    }, 0);
    return null;
  }

  /** Apparent altitude and azimuth (radians) of a unit vector of date, through the scene's horizon matrix. */
  function horizonOf(v: ArrayLike<number>): { alt: number; az: number } {
    const m = scene.hm;
    const e = m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!;
    const n = m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!;
    const u = Math.max(-1, Math.min(1, m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!));
    const h = Math.asin(u);
    const alt = h + (refractionArcmin(h * RAD, scene.refraction) / 60) * DEG;
    let az = Math.atan2(e, n);
    if (az < 0) az += 2 * Math.PI;
    return { alt, az };
  }

  function updateRadiants(state: ExplorerState, fast: boolean): void {
    if (!state.layers.meteorRadiants && keyKind(pinnedKey) !== 'r') {
      active = [];
      radiantMarks = [];
      return;
    }
    const years = yearsFor(displayJd).map((y) => showerYear(y, fast));
    active = activeShowers(years, displayJd, scene.frame);
    const pinnedCode = keyKind(pinnedKey) === 'r' ? pinnedKey!.slice(2) : null;
    const marks: RadiantMark[] = [];
    const list = state.layers.meteorRadiants ? active : active.filter((a) => a.dates.shower.code === pinnedCode);
    for (const a of list) {
      const { alt, az } = horizonOf(a.unit);
      const nightly = tonightFor(tonight?.showers, a.dates.shower.code);
      marks.push({
        key: radiantKey(a.dates.shower.code),
        code: a.dates.shower.code,
        name: a.dates.shower.name,
        alt,
        az,
        rate: nightly ? rateWords(nightly.expected_rate_per_hour) : '',
        strength: Math.min(1, Math.max(0, Math.log10(Math.max(1, a.dates.shower.zhr)) / 2)),
        x: 0,
        y: 0,
        drawn: false,
      });
    }
    radiantMarks = marks;
  }

  // --- sky2: comets and asteroids --------------------------------------------------------
  function updateCustom(state: ExplorerState): void {
    const list = added.get();
    if (!list.length || (!state.layers.customBodies && keyKind(pinnedKey) !== 'c') || !isPlanetDetailEngine(engine)) {
      customMarks = [];
      return;
    }
    try {
      const states = engine.customBodyStates(engineObserver(state), displayJd, list as CustomBodyInput[]);
      const sun = sky?.bodies.find((b) => b.body === 'Sun') ?? null;
      customMarks = states.bodies.map((b) => {
        let sunward: { alt: number; az: number } | null = null;
        if (b.kind === 'comet' && sun) {
          // A point a degree from the comet toward the Sun, along the great circle.
          const c = unit(b.ra_deg, b.dec_deg);
          const s = unit(sun.ra_deg, sun.dec_deg);
          const dot = c[0]! * s[0]! + c[1]! * s[1]! + c[2]! * s[2]!;
          const t = [s[0]! - dot * c[0]!, s[1]! - dot * c[1]!, s[2]! - dot * c[2]!];
          const len = Math.hypot(t[0]!, t[1]!, t[2]!);
          if (len > 1e-9) {
            const k = Math.sin(DEG) / len;
            const cc = Math.cos(DEG);
            sunward = horizonOf([cc * c[0]! + k * t[0]!, cc * c[1]! + k * t[1]!, cc * c[2]! + k * t[2]!]);
          }
        }
        return {
          key: customKey(b.body),
          name: b.body,
          kind: b.kind,
          alt: b.alt_apparent_deg * DEG,
          az: b.az_deg * DEG,
          magnitude: b.magnitude,
          sunward,
          x: 0,
          y: 0,
          drawn: false,
        };
      });
      customError = states.errors.map((e) => `${e.body}: ${e.message}`).join(' ');
    } catch (error) {
      customMarks = [];
      customError = errorText(error);
    }
    if (customError) notices.push('caution', `Comets and asteroids: ${customError}`, { key: 'sky-custom' });
    else notices.dismissKey('sky-custom');
  }

  function unit(raDeg: number, decDeg: number): number[] {
    const c = Math.cos(decDeg * DEG);
    return [c * Math.cos(raDeg * DEG), c * Math.sin(raDeg * DEG), Math.sin(decDeg * DEG)];
  }

  // --- sky2: the night's estimates (tonight), made when the time settles -------------------
  function nightKey(state: ExplorerState): string {
    const o = state.observer;
    // The engine's night runs from local mean noon; a key per local mean day and place.
    const day = Math.floor(displayJd + o.lon_deg / 360);
    return `${o.lat_deg.toFixed(4)}|${o.lon_deg.toFixed(4)}|${model?.key ?? ''}|${day}`;
  }

  function ensureTonight(state: ExplorerState): void {
    if (!isDeepSkyEngine(engine)) return;
    const key = nightKey(state);
    if (key === tonightKey) return;
    if (tonightTimer) clearTimeout(tonightTimer);
    const moving = state.time.playing || ease !== null;
    tonightTimer = setTimeout(
      () => {
        tonightTimer = null;
        if (destroyed || !isDeepSkyEngine(engine)) return;
        const s = store.get();
        if (s.time.playing) {
          tonightKey = '';
          return;
        }
        tonightKey = nightKey(s);
        try {
          tonight = engine.tonight(engineObserver(s), s.time.jd_utc, { ...skyConditions(s.settings), limit: 12 });
          tonightError = '';
        } catch (error) {
          tonight = null;
          tonightError = errorText(error);
        }
        if (rankingPopover.isOpen()) renderRanking(false);
        requestDraw();
      },
      moving ? SETTLE_MS * 2 : SETTLE_MS,
    );
  }

  // --- sky2: the field of view ------------------------------------------------------------
  /** The apparent direction (radians) of a key this frame, from the scene's own data. */
  function directionOf(key: string): { alt: number; az: number } | null {
    const k = keyKind(key);
    if (k === 'b') {
      const b = sky?.bodies.find((x) => x.body === key.slice(2));
      return b ? { alt: b.alt_apparent_deg * DEG, az: b.az_deg * DEG } : null;
    }
    if (k === 's') {
      const i = Number(key.slice(2));
      return i >= 0 && i < scene.n && scene.starsOk ? { alt: scene.starAlt(i), az: scene.starAz(i) } : null;
    }
    if (k === 'd') {
      const i = Number(key.slice(2));
      if (!(i >= 0 && i < scene.dso.n)) return null;
      const h = scene.dso.h;
      let az = Math.atan2(h.sinAz[i]!, h.cosAz[i]!);
      if (az < 0) az += 2 * Math.PI;
      return { alt: h.alt[i]!, az };
    }
    if (k === 'r') {
      const m = radiantMarks.find((r) => r.key === key);
      return m ? { alt: m.alt, az: m.az } : null;
    }
    if (k === 'c') {
      const m = customMarks.find((c) => c.key === key);
      return m ? { alt: m.alt, az: m.az } : null;
    }
    if (k === 'k') {
      const c = Number(key.slice(2));
      const ch = scene.ch;
      if (!(c >= 0 && c < ch.alt.length)) return null;
      let az = Math.atan2(ch.sinAz[c]!, ch.cosAz[c]!);
      if (az < 0) az += 2 * Math.PI;
      return { alt: ch.alt[c]!, az };
    }
    if (k === 'p') return pointMark ? { alt: pointMark.alt, az: pointMark.az } : null;
    return null;
  }

  /** The named direction this frame: J2000 carried to the frame of date (the star field's matrix), then to the horizon. */
  function updatePoint(): void {
    if (!pointTarget || keyKind(pinnedKey) !== 'p') {
      pointMark = null;
      return;
    }
    const f = scene.frame;
    const v = pointTarget.j2000;
    const d = [0, 1, 2].map((i) => f[3 * i]! * v[0]! + f[3 * i + 1]! * v[1]! + f[3 * i + 2]! * v[2]!);
    const { alt, az } = horizonOf(d);
    pointMark = { key: pointKey, label: pointTarget.label, alt, az };
  }

  function fovNow(state: ExplorerState, p: DomeProjector | PanoramaProjector): FovOutline | null {
    const fs = view.fov;
    if (!fs.preset) return null;
    let dir: { alt: number; az: number } | null = null;
    const key = selectedKey(state);
    if (fs.anchor === 'target' && key) dir = directionOf(key);
    if (!dir) {
      p.unproject(cssW / 2, cssH / 2);
      dir = { alt: p.alt, az: p.az };
    }
    const c = Math.cos(dir.alt);
    const d = [c * Math.sin(dir.az), c * Math.cos(dir.az), Math.sin(dir.alt)];
    const preset = FOV_PRESETS.find((x) => x.id === fs.preset);
    if (!preset) return null;
    const shape = preset.diameterDeg !== null ? { diameterDeg: preset.diameterDeg } : cameraField(fs.focalMm, sensorOf(fs.sensorId));
    const count = fovOutline(d, shape, fovPoints);
    return { points: fovPoints, count, label: fovLabel(fs) };
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
    const pal = currentPalette();
    const observer = engineObserver(state);
    const fast = fastPlayback(state);

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
    // A pinned target gives way when the shared selection changes.
    if (pinnedKey !== null && pinnedFor !== state.selection.body) {
      if (cardKey === pinnedKey) cardKey = null;
      pinnedKey = null;
      foundConstellation = -1;
    }

    const layers = state.layers;
    try {
      scene.update(engine, observer, displayJd, {
        boundaries: layers.constellationBoundaries,
        constellationLabels: layers.constellationNames || keyKind(pinnedKey) === 'k',
        equator: layers.equator,
        ecliptic: layers.ecliptic,
        daily: state.time.playing && Math.abs(state.time.speed) >= 43_200,
        raDecGrid: layers.raDecGrid,
        deepSky: layers.deepSky || keyKind(pinnedKey) === 'd',
        frozen: fast,
      });
      if (scene.error) notices.push('caution', `Star field: ${scene.error}`, { key: 'sky-stars' });
      else notices.dismissKey('sky-stars');
    } catch (error) {
      notices.push('error', `Sky: ${errorText(error)}`, { key: 'sky-stars' });
    }
    updatePath(state, displayJd, fast);

    const projector = configureProjector();
    const sunAlt = sky ? sky.sun_altitude_deg : Number.NaN;
    const m = currentModel(state);
    zenith = zenithLimit(sunAlt, state.settings.skyQuality, m.nelm);
    const ext = layers.extinction ? m.extinction : null;
    scene.project(projector, cssW, cssH, 24, ext);
    dsoShown = 0;
    const dsoOn = (layers.deepSky || keyKind(pinnedKey) === 'd') && scene.dso.n > 0;
    if (dsoOn) {
      // A pinned object is drawn whatever its magnitude.
      const limit = layers.deepSky ? zenith + dsoReach(pxPerDeg(projector)) : -99;
      dsoShown = scene.dso.project(projector, cssW, cssH, limit, ext);
      if (keyKind(pinnedKey) === 'd') {
        const i = Number(pinnedKey!.slice(2));
        if (scene.dso.on[i] === 0 && scene.dso.h.alt[i]! >= 0 && !Number.isNaN(scene.dso.x[i]!)) scene.dso.on[i] = 1;
      }
    }
    const mw = layers.milkyWay ? milkyWayImage(projector, pal, ext, fast) : null;
    if (!layers.milkyWay) mwTexels = 0;
    updateRadiants(state, fast);
    updateCustom(state);
    updatePoint();
    if (!fast && (layers.meteorRadiants || cardKey !== null || rankingPopover.isOpen())) ensureTonight(state);
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
      limitMag: zenith,
      zoom: zoomFactor(projector),
      selectedKey: selectedKey(state),
      highlightKeys,
      focusKey: document.activeElement === canvas ? focusKey : null,
      hoverKey,
      path: path && path.body === state.selection.body ? path : null,
      dso: dsoOn ? scene.dso : null,
      milkyWay: mw,
      radiants: radiantMarks,
      custom: customMarks,
      fov: fovNow(state, projector),
      constellation: foundConstellation,
      point: pointMark,
    };
    const t1 = performance.now();
    g2!.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderer.draw(frame);
    const t2 = performance.now();
    timer.record(t1 - t0, t2 - t1);
    lastFrame = frame;
    syncChrome(state);
    updateTooltip(state);
    updateCard(state);
    if (upClose.body()) {
      const b = sky?.bodies.find((x) => x.body === upClose.body());
      upClose.update({
        jd: displayJd,
        observer,
        parallacticDeg: b ? b.parallactic_angle_deg : null,
        palette: pal,
        moving: state.time.playing || ease !== null,
      });
    }
    if (menuOpen) syncMenu();
    if (ease) requestDraw();
  }

  // --- controls and accessible text ----------------------------------------------------
  const PHASE_WORDS: Record<string, string> = {
    day: 'Day',
    civil: 'Civil twilight',
    nautical: 'Nautical twilight',
    astronomical: 'Astronomical twilight',
    night: 'Night',
  };
  let chromeKey = '';
  let statusKey = '';
  function syncChrome(state: ExplorerState): void {
    const p = view.panorama;
    const key = `${view.mode}|${view.southUp}|${Math.round(p.fov)}|${Math.round(p.azimuth)}|${state.observer.label}|${state.observer.lat_deg}|${state.observer.lon_deg}|${Object.values(state.layers).join('')}|${view.fov.preset}`;
    if (key !== chromeKey) {
      chromeKey = key;
      root.dataset.mode = view.mode;
      modeControl.set(view.mode);
      setPressed(southUp, view.southUp);
      southUp.hidden = view.mode !== 'dome';
      panoControls.hidden = view.mode !== 'panorama';
      zoomIn.disabled = p.fov <= PANORAMA_LIMITS.minFov + 0.5;
      zoomOut.disabled = p.fov >= PANORAMA_LIMITS.maxFov - 0.5;
      setPressed(fovButton, view.fov.preset !== null);
      const place =
        state.observer.label ||
        `${formatAngle(state.observer.lat_deg, 'decimal')}, ${formatAngle(state.observer.lon_deg, 'decimal')}`;
      canvas.setAttribute(
        'aria-label',
        view.mode === 'dome'
          ? `Chart of the whole sky from ${place}, zenith in the centre, ${view.southUp ? 'south' : 'north'} at the top.`
          : `Panorama of the sky from ${place}, looking ${compassPoint(p.azimuth)}.`,
      );
    }
    // Status: the sky phase (its colour and its name) and, in the panorama, where it looks.
    const phase = sky?.sky_phase ?? null;
    const sun = sky ? sky.sun_altitude_deg : Number.NaN;
    const sunText = Number.isFinite(sun)
      ? `Sun ${formatAngle(Math.abs(sun), 'dm').replace(/\.\d′$/, '′')} ${sun >= 0 ? 'up' : 'below the horizon'}`
      : '';
    const lookText = view.mode === 'panorama' ? `Looking ${compassPoint(p.azimuth)} · ${Math.round(p.fov)}° wide` : '';
    const q = state.settings;
    const darkText = q.skyQuality === 'bortle' ? `Bortle ${q.skyBortle}` : q.skyQuality === 'nelm' ? `Sky to ${q.skyNelm.toFixed(1)}` : '';
    const nextStatus = `${phase}|${sunText}|${lookText}|${darkText}`;
    if (nextStatus !== statusKey) {
      statusKey = nextStatus;
      statusText.replaceChildren(
        ...(phase ? [phaseChip(phase, PHASE_WORDS[phase] ?? phase)] : []),
        ...[sunText, lookText, darkText].filter(Boolean).map((t) => el('span', {}, t)),
      );
    }
  }

  function syncMenu(): void {
    const ext = store.get().layers.extinction ? model?.extinction : null;
    const at20 = zenith - (ext ? extinctionAt(ext, 20 * DEG) : 0);
    const dsoNote =
      !scene.dso.n && scene.dso.error
        ? scene.dso.error
        : dsoShown === 0 && zenith < 4
          ? 'Deep-sky objects show once the sky is dark enough.'
          : '';
    menu.sync({ zenith, at20, milkyWay: mwVisible, error: model?.error ?? null, dsoShown, dsoNote });
  }

  // --- targets: hit-testing, focus order, descriptions --------------------------------
  function hitTest(x: number, y: number): string | null {
    const f = lastFrame;
    if (!f) return null;
    let best: string | null = null;
    let bestScore = Infinity;
    const consider = (key: string, score: number): void => {
      if (score < bestScore) {
        bestScore = score;
        best = key;
      }
    };
    for (const m of renderer.bodies) {
      if (!m.drawn) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d > m.r + 10) continue;
      consider(m.key, d - 6);
    }
    for (const m of customMarks) {
      if (!m.drawn) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d <= 12) consider(m.key, d - 5);
    }
    for (const m of radiantMarks) {
      if (!m.drawn) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d <= 14) consider(m.key, d - 4);
    }
    if (pointMark) {
      const at = renderer.locate(f, pointKey);
      if (at && !Number.isNaN(at.x)) {
        const d = Math.hypot(at.x - x, at.y - y);
        if (d <= 14) consider(pointKey, d - 5);
      }
    }
    if (f.dso) {
      const hit = f.dso.hit(x, y);
      if (hit) consider(deepSkyKey(hit.index), hit.distance * 8 - 2);
    }
    const data = scene.stars;
    if (data && scene.starsOk) {
      const xs = scene.x;
      const ys = scene.y;
      const on = scene.onScreen;
      const eff = scene.effMag;
      for (let i = 0; i < scene.n; i += 1) {
        if (on[i] === 0) continue;
        const dx = xs[i]! - x;
        if (dx > 14 || dx < -14) continue;
        const dy = ys[i]! - y;
        if (dy > 14 || dy < -14) continue;
        const m = eff[i]!;
        if (starAlpha(m, f.limitMag) <= 0.01 && data.isNav[i] === 0) continue;
        const d = Math.hypot(dx, dy);
        if (d > starRadius(m) * f.zoom + 8) continue;
        consider(starKey(i), d - 1.2 * Math.max(0, 4 - m));
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
    if (pinnedKey !== null && !items.some((t) => t.key === pinnedKey)) {
      const d = directionOf(pinnedKey);
      if (d && d.alt >= 0) items.push({ key: pinnedKey, az: d.az });
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
    /** [label, value]; value in the number font, or '' for a plain note. */
    lines: [string, string][];
    speech: string;
    /** Apparent altitude and azimuth, degrees (NaN when unknown). */
    alt: number;
    az: number;
    /** Right ascension and declination of date, degrees (NaN when unknown). */
    ra: number;
    dec: number;
  }

  function words(state: ExplorerState): { height: string; bearing: string; fmt: AngleFormat } {
    const terms = state.settings.navigatorTerms;
    return {
      height: terms ? 'Height above horizon · altitude' : 'Height above horizon',
      bearing: terms ? 'Bearing · azimuth' : 'Bearing',
      fmt: state.settings.angleFormat,
    };
  }

  function describe(key: string, state: ExplorerState): Description | null {
    const { height: heightWord, bearing: bearingWord, fmt } = words(state);
    const lines: [string, string][] = [];
    let title = '';
    let sub = '';
    let alt = Number.NaN;
    let az = Number.NaN;
    let ra = Number.NaN;
    let dec = Number.NaN;
    let mag: number | null = null;
    let magWord = 'Magnitude';
    const data = scene.stars;
    const kind = keyKind(key);
    let starIndex = -1;
    if (kind === 's') starIndex = Number(key.slice(2));
    const canonical = kind === 'b' ? key.slice(2) : starIndex >= 0 && data?.isNav[starIndex] ? data.nameOf.get(starIndex)! : null;
    const b = canonical ? bodyState(canonical, state) : null;
    if (b) {
      title = b.body;
      alt = b.alt_apparent_deg;
      az = b.az_deg;
      ra = b.ra_deg;
      dec = b.dec_deg;
      mag = b.magnitude;
      if (b.kind === 'star') magWord = 'Magnitude (catalogue)';
      const con = constellationName(b.constellation);
      const kindWord = b.kind === 'star' ? 'Navigational star' : b.kind === 'planet' ? 'Planet' : '';
      sub = [kindWord, con ? `in ${con}` : ''].filter(Boolean).join(' ');
      if (starIndex >= 0 && data) sub = [starDesignation(data, starIndex), sub].filter(Boolean).join(' · ');
    } else if (kind === 's' && data && starIndex < scene.n) {
      title = starTitle(data, starIndex);
      alt = scene.starAlt(starIndex) * RAD;
      az = scene.starAz(starIndex) * RAD;
      mag = data.vmag[starIndex]!;
      magWord = 'Magnitude (catalogue)';
      const rd = scene.starRaDecDeg(starIndex);
      ra = rd.ra;
      dec = rd.dec;
      let con: string | null = null;
      try {
        con = constellationName(engine.constellationAt(rd.ra, rd.dec, displayJd));
      } catch {
        con = null;
      }
      const designation = starDesignation(data, starIndex);
      sub = [title === designation ? '' : designation, con ? `in ${con}` : ''].filter(Boolean).join(' · ');
    } else if (kind === 'd') {
      const i = Number(key.slice(2));
      const o = scene.dso.catalog[i];
      if (!o) return null;
      title = o.name ?? o.label;
      sub = [o.name ? o.label : '', `${DSO_TYPE_WORDS[o.type]} in ${constellationName(o.constellation) ?? o.constellation}`].filter(Boolean).join(' · ');
      const d = directionOf(key)!;
      alt = d.alt * RAD;
      az = d.az * RAD;
      const rd = scene.dso.raDec(i);
      ra = rd.ra;
      dec = rd.dec;
      mag = o.magnitude;
      magWord = 'Magnitude (whole object)';
    } else if (kind === 'r') {
      const m = radiantMarks.find((r) => r.key === key);
      const a = active.find((x) => radiantKey(x.dates.shower.code) === key);
      if (!m || !a) return null;
      title = `${a.dates.shower.name} radiant`;
      sub = `Meteor shower · ${a.dates.shower.code} · peak rate ${a.dates.shower.zhr} an hour in a perfect sky`;
      alt = m.alt * RAD;
      az = m.az * RAD;
    } else if (kind === 'c') {
      const m = customMarks.find((c) => c.key === key);
      if (!m) return null;
      title = m.name;
      sub = m.kind === 'comet' ? 'Comet (from your elements)' : 'Asteroid (from your elements)';
      alt = m.alt * RAD;
      az = m.az * RAD;
      mag = m.magnitude;
      magWord = 'Magnitude (estimate)';
    } else if (kind === 'k') {
      const c = Number(key.slice(2));
      const con = scene.catalog?.constellations[c];
      const d = directionOf(key);
      if (!con || !d) return null;
      title = con.name;
      sub = `Constellation · ${con.abbr}`;
      alt = d.alt * RAD;
      az = d.az * RAD;
    } else if (kind === 'p') {
      const d = directionOf(key);
      if (!pointTarget || !d) return null;
      title = pointTarget.label;
      let con: string | null = null;
      const f = scene.frame;
      const v = pointTarget.j2000;
      const u = [0, 1, 2].map((i) => f[3 * i]! * v[0]! + f[3 * i + 1]! * v[1]! + f[3 * i + 2]! * v[2]!);
      ra = ((Math.atan2(u[1]!, u[0]!) * RAD) % 360 + 360) % 360;
      dec = Math.asin(Math.max(-1, Math.min(1, u[2]!))) * RAD;
      try {
        con = constellationName(engine.constellationAt(ra, dec, displayJd));
      } catch {
        con = null;
      }
      sub = con ? `In ${con}` : 'A direction on the sky';
      alt = d.alt * RAD;
      az = d.az * RAD;
    } else {
      return null;
    }
    const up = alt >= 0;
    lines.push([heightWord, `${formatAngle(alt, fmt)}${up ? '' : ' (below the horizon)'}`]);
    lines.push([bearingWord, `${formatBearing(az, fmt)} ${compassPoint(az)}`]);
    if (mag !== null && Number.isFinite(mag)) lines.push([magWord, formatMagnitude(mag)]);
    if (b?.illuminated_fraction !== null && b?.illuminated_fraction !== undefined && b.kind !== 'star') {
      lines.push(['Lit', `${Math.round(b.illuminated_fraction * 100)} %`]);
    }
    if (starIndex >= 0 && data && !data.isNav[starIndex]) lines.push(['Catalogue star, display only (not used for sights)', '']);
    const speech = `${title}. ${lines
      .slice(0, 2)
      .map(([k, v]) => `${k} ${v}`)
      .join('. ')}.`;
    return { title, sub, lines, speech, alt, az, ra, dec };
  }

  function updateTooltip(state: ExplorerState): void {
    const f = lastFrame;
    const key = hoverKey ?? (document.activeElement === canvas ? focusKey : null);
    if (!f || !key || key === cardKey) {
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
    const text = `${d.title}\n${d.sub}\n${d.lines.map((l) => l.join(':')).join('\n')}`;
    const wasHidden = tooltip.hidden;
    tooltip.hidden = false;
    if (text !== tipText || wasHidden) {
      tipText = text;
      tooltip.replaceChildren(
        el('strong', { class: 'sky-tip-title' }, d.title),
        ...(d.sub ? [el('span', { class: 'sky-tip-sub' }, d.sub)] : []),
        ...d.lines.map(([k, v]) => el('span', { class: 'sky-tip-line' }, ...(v ? [`${k} `, el('b', {}, v)] : [k]))),
      );
      // Measured only when the text changed (a layout read).
      tipSize = { w: tooltip.offsetWidth, h: tooltip.offsetHeight };
    }
    // Beside the body, kept inside the stage.
    const { w, h } = tipSize;
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

  // --- sky2: the info card ----------------------------------------------------------------
  /** "Rises at 21:14 (Fri)" for a key below the horizon, or ''. */
  function riseWords(key: string, d: Description, state: ExplorerState): { text: string; jd: number | null } {
    if (d.alt >= 0) return { text: '', jd: null };
    const zone = displayZone(state);
    let jd: number | null = null;
    const kind = keyKind(key);
    const canonical = kind === 'b' ? key.slice(2) : null;
    if (canonical) {
      try {
        const ev = engine.dayEvents(engineObserver(state), displayJd, displayJd + 1.1, [canonical]);
        jd = ev.bodies[0]?.events.find((e) => e.kind === 'rise' && e.jd_utc >= displayJd)?.jd_utc ?? null;
        if (jd === null && ev.bodies[0]?.always_below) return { text: 'Does not rise here today.', jd: null };
      } catch {
        jd = null;
      }
    } else if (Number.isFinite(d.ra) && Number.isFinite(d.dec)) {
      const r = nextRise(d.ra, d.dec, state.observer.lat_deg, scene.lst);
      if (r === 'never') return { text: 'Never rises at this latitude.', jd: null };
      if (r !== 'always') jd = displayJd + r.dtDays;
    }
    if (jd === null) return { text: '', jd: null };
    const day = otherDay(jd, displayJd, zone);
    return { text: `${eventTime(jd, zone)}${day ? ` ${day}` : ''}`, jd };
  }

  function dsoVisibilityFor(i: number, state: ExplorerState): DsoVisibility | string | null {
    if (!isDeepSkyEngine(engine)) return null;
    const o = scene.dso.catalog[i];
    if (!o) return null;
    const key = `${o.id}|${nightKey(state)}`;
    const hit = dsoVisibility.get(key);
    if (hit !== undefined) return hit;
    if (state.time.playing) return null;
    let v: DsoVisibility | string;
    try {
      v = engine.dsoVisibility(o.id, engineObserver(state), displayJd, skyConditions(state.settings));
    } catch (error) {
      v = errorText(error);
    }
    if (dsoVisibility.size > 64) dsoVisibility.clear();
    dsoVisibility.set(key, v);
    return v;
  }

  function cardFor(key: string, state: ExplorerState): CardContent | null {
    const d = describe(key, state);
    if (!d) return null;
    const { fmt } = words(state);
    const zone = displayZone(state);
    const lines: CardLine[] = d.lines.filter(([, v]) => v).map(([label, value]) => ({ label, value }));
    const notes: string[] = [];
    const actions: CardContent['actions'] = [];
    let source: string | undefined;
    let symbol: (() => Element) | undefined;
    const kind = keyKind(key);
    if (Number.isFinite(d.ra)) {
      lines.push({ label: state.settings.navigatorTerms ? 'Right ascension · declination' : 'Right ascension, declination', value: `${formatRa(d.ra)}, ${formatDec(d.dec, fmt)}`, tip: 'The sky’s own coordinates, true equator and equinox of date' });
    }
    const rise = riseWords(key, d, state);
    if (rise.text) {
      const info = rise.jd !== null ? timeInfoAt(engine, rise.jd) : null;
      lines.push(rise.jd !== null ? { label: 'Rises', value: rise.text, chip: info } : { label: rise.text, value: '' });
    }
    if (kind === 'b') {
      const name = key.slice(2);
      symbol = () => bodyGlyph(name, { size: 18 });
      if (upCloseSupported(name)) actions.push({ id: 'upclose', label: 'See it up close', icon: 'eye', primary: true });
    } else if (kind === 's') {
      symbol = () => kindSymbol('star');
    } else if (kind === 'd') {
      const i = Number(key.slice(2));
      const o = scene.dso.catalog[i]!;
      symbol = () => kindSymbol('deep_sky', scene.dso.shape[i] as never);
      lines.push({ label: 'Size', value: o.major_arcmin >= 60 ? `${(o.major_arcmin / 60).toFixed(1)}° × ${(o.minor_arcmin / 60).toFixed(1)}°` : `${o.major_arcmin}′ × ${o.minor_arcmin}′` });
      const v = dsoVisibilityFor(i, state);
      if (typeof v === 'string') notes.push(`Tonight’s estimate: ${v}`);
      else if (v) {
        const best = v.visibility.best;
        if (best) {
          const day = otherDay(best.jd_utc, displayJd, zone);
          lines.push({ label: 'Best tonight', value: `${eventTime(best.jd_utc, zone)}${day ? ` ${day}` : ''}, ${Math.round(best.alt_deg)}° up in the ${best.direction}`, chip: timeInfoAt(engine, best.jd_utc) });
        } else lines.push({ label: 'Not up in the dark tonight', value: '' });
        if (v.visibility.instrument) {
          const inst = { eye: 'the naked eye', binoculars: 'binoculars', telescope: 'a small telescope', camera: 'a camera' }[v.visibility.instrument];
          lines.push({ label: 'To see it', value: inst });
        }
        const q = state.settings;
        const skyWords = q.skyQuality === 'bortle' ? `a Bortle ${q.skyBortle} sky (${BORTLE_WORDS[q.skyBortle - 1]?.toLowerCase()})` : q.skyQuality === 'nelm' ? `a sky showing stars to magnitude ${q.skyNelm.toFixed(1)}` : 'a dark sky';
        notes.push(`Best time and instrument are estimates for ${skyWords}, with the Moon’s light; set your sky under Layers.`);
      }
      if (o.description) notes.unshift(o.description);
      if (o.cross_ids.length) lines.push({ label: 'Also', value: o.cross_ids.join(', ') });
      actions.push({ id: 'ranking', label: 'Tonight’s ranking', icon: 'list' });
      actions.push({ id: 'fov', label: view.fov.preset ? 'Field of view here' : 'Binocular view here', tip: 'Draw the field of view around it' });
      source = scene.dso.source;
    } else if (kind === 'r') {
      const a = active.find((x) => radiantKey(x.dates.shower.code) === key);
      if (a) {
        const sh = a.dates.shower;
        symbol = () => kindSymbol('shower');
        const peakDay = dateMedium(a.dates.peak.jd_utc, zone);
        lines.push({ label: 'Active', value: `${dateMedium(a.dates.start.jd_utc, zone)} to ${dateMedium(a.dates.end.jd_utc, zone)}` });
        lines.push({ label: 'Peak', value: peakDay });
        const nightly = tonightFor(tonight?.showers, sh.code);
        if (nightly) {
          if (nightly.best) {
            const day = otherDay(nightly.best.jd_utc, displayJd, zone);
            lines.push({ label: 'Tonight', value: `${rateWords(nightly.expected_rate_per_hour)} at best, ${eventTime(nightly.best.jd_utc, zone)}${day ? ` ${day}` : ''}`, chip: timeInfoAt(engine, nightly.best.jd_utc) });
          }
          notes.push(nightly.reason);
        } else if (tonightError) notes.push(`Tonight’s rate: ${tonightError}`);
        notes.push(`Meteors appear anywhere in the sky; traced back, their paths meet here. Rates are an estimate by the engine’s stated rule, for the sky set under Layers.${sh.parent ? ` Parent body: ${sh.parent}.` : ''}`);
      }
    } else if (kind === 'c') {
      const body = added.get().find((b) => customKey(b.name) === key);
      symbol = () => kindSymbol(body?.class === 'comet' ? 'comet' : 'asteroid');
      if (body && isPlanetDetailEngine(engine)) {
        try {
          const st = engine.customBodyStates(engineObserver(state), displayJd, [body]).bodies[0];
          if (st) {
            lines.push({ label: 'Distance', value: `${st.distance_au.toFixed(3)} AU from Earth, ${st.heliocentric_distance_au.toFixed(3)} AU from the Sun` });
            notes.push(...st.warnings);
          }
        } catch {
          /* described by the notice */
        }
        const credit = added.creditOf(body);
        if (credit) source = credit;
      }
      notes.push('Worked out from your orbital elements, without the planets’ pull: good for finding it, not for timing it.');
    } else if (kind === 'k') {
      symbol = () => kindSymbol('constellation');
      notes.push('Its figure is drawn brighter while this card is open.');
    } else if (kind === 'p' && pointTarget && /galactic/i.test(pointTarget.label)) {
      notes.push('The centre of our galaxy lies behind the dust of Sagittarius: what the eye and a camera see is the bright star clouds around it, the Milky Way’s core.');
    }
    return { key, title: d.title, sub: d.sub, lines, notes, actions, ...(source ? { source } : {}), ...(symbol ? { symbol } : {}) };
  }

  function updateCard(state: ExplorerState): void {
    if (!cardKey) {
      card.show(null);
      return;
    }
    const c = cardFor(cardKey, state);
    card.show(c);
    root.dataset.card = c ? '1' : '';
  }

  function onCardAction(id: string): void {
    const key = cardKey;
    if (!key) return;
    if (id === 'upclose' && keyKind(key) === 'b') {
      cardOpener = card.el.querySelector<HTMLElement>('[data-action="upclose"]');
      openUpClose(key.slice(2));
    } else if (id === 'ranking') {
      rankingPopover.open();
    } else if (id === 'fov') {
      if (!view.fov.preset) view.fov.preset = 'bino10x50';
      view.fov.anchor = 'target';
      requestDraw();
    }
  }

  // --- sky2: tonight's ranking ------------------------------------------------------------
  function renderRanking(fresh: boolean): void {
    const state = store.get();
    if (!isDeepSkyEngine(engine)) {
      rankingList.replaceChildren();
      rankingNote.textContent = 'Tonight’s ranking is not available in this engine.';
      return;
    }
    if (fresh && nightKey(state) !== tonightKey && !state.time.playing) {
      // Asked for now: make it at once rather than waiting for the time to settle.
      if (tonightTimer) clearTimeout(tonightTimer);
      tonightTimer = null;
      tonightKey = nightKey(state);
      try {
        tonight = engine.tonight(engineObserver(state), state.time.jd_utc, { ...skyConditions(state.settings), limit: 12 });
        tonightError = '';
      } catch (error) {
        tonight = null;
        tonightError = errorText(error);
      }
    }
    const zone = displayZone(state);
    if (!tonight) {
      rankingList.replaceChildren();
      rankingNote.textContent = tonightError || 'Tonight’s ranking is made when the time stops.';
      return;
    }
    rankingList.replaceChildren(
      ...tonight.deep_sky.map((o) => {
        const i = scene.dso.indexOf(o.id);
        const day = otherDay(o.best.jd_utc, state.time.jd_utc, zone);
        const b = button({
          label: '',
          ariaLabel: `${o.name ?? o.label}, best at ${eventTime(o.best.jd_utc, zone)}, ${Math.round(o.best.alt_deg)} degrees up in the ${o.best.direction}`,
          variant: 'ghost',
          class: 'sky-rank__item',
          onClick: () => {
            rankingPopover.close({ returnFocus: false });
            show({ kind: 'deep_sky', id: o.id });
            canvas.focus({ preventScroll: true });
          },
        });
        b.replaceChildren(
          el('span', { class: 'sky-rank__sym' }, kindSymbol('deep_sky', i >= 0 ? (scene.dso.shape[i] as never) : undefined)),
          el('span', { class: 'sky-rank__name' }, o.name ? `${o.name} (${o.label})` : o.label),
          el('span', { class: 'sky-rank__when' }, withUncertainty(`${eventTime(o.best.jd_utc, zone)}${day ? ` ${day}` : ''} · ${Math.round(o.best.alt_deg)}° ${o.best.direction}`, timeInfoAt(engine, o.best.jd_utc))),
          el('span', { class: 'sky-rank__how' }, { eye: 'naked eye', binoculars: 'binoculars', telescope: 'telescope', camera: 'camera' }[o.instrument]),
        );
        return el('li', {}, b);
      }),
    );
    const q = state.settings;
    rankingNote.textContent = `An estimate by the engine’s stated rule: height in the dark, hours above 20°, the Moon’s light and what shows it, for ${q.skyQuality === 'bortle' ? `a Bortle ${q.skyBortle} sky` : q.skyQuality === 'nelm' ? `a sky to magnitude ${q.skyNelm.toFixed(1)}` : 'a dark sky'}. Choose one to see it on the chart.`;
  }

  // --- sky2: the field-of-view popover ------------------------------------------------------
  function buildFovBox(): { el: HTMLElement; sync(): void } {
    const radios = el('div', { class: 'sf-menu sky-fov__presets', role: 'radiogroup', 'aria-label': 'Field of view' });
    const choices: { id: FovPresetId | null; label: string; note: string }[] = [
      { id: null, label: 'None', note: '' },
      ...FOV_PRESETS.map((p) => ({ id: p.id, label: p.label, note: p.note })),
    ];
    const buttons = choices.map((c) => {
      const b = el('button', { type: 'button', class: 'sf-menu__item', role: 'radio', 'aria-checked': 'false' }, el('span', {}, c.label), ...(c.note ? [el('span', { class: 'sf-menu__hint sky-fov__hint' }, c.note)] : []));
      b.addEventListener('click', () => {
        view.fov.preset = c.id;
        sync();
        requestDraw();
      });
      return b;
    });
    radios.append(...buttons);
    radios.addEventListener('keydown', (e) => {
      const i = buttons.findIndex((b) => b === document.activeElement);
      if (i < 0) return;
      const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : e.key === 'ArrowUp' ? (i - 1 + buttons.length) % buttons.length : -1;
      if (next < 0) return;
      e.preventDefault();
      buttons[next]!.focus();
      buttons[next]!.click();
    });
    const focal = el('input', { class: 'sf-input sky-fov__input', type: 'number', min: '4', max: '3000', step: '1', inputmode: 'numeric', 'aria-label': 'Focal length, millimetres' });
    focal.addEventListener('change', () => {
      const v = Number(focal.value);
      if (Number.isFinite(v) && v >= 4 && v <= 3000) {
        view.fov.focalMm = v;
        requestDraw();
        sync();
      }
    });
    const sensor = el('select', { class: 'sf-input sky-fov__input', 'aria-label': 'Sensor size' });
    for (const s of SENSORS) sensor.append(el('option', { value: s.id }, s.label));
    sensor.addEventListener('change', () => {
      view.fov.sensorId = sensor.value;
      requestDraw();
      sync();
    });
    const camera = el(
      'div',
      { class: 'sky-fov__camera' },
      el('label', { class: 'sky-quality__row' }, el('span', {}, 'Lens focal length, mm'), focal),
      el('label', { class: 'sky-quality__row' }, el('span', {}, 'Sensor'), sensor),
    );
    const cameraNote = el('p', { class: 'sky-fov__note' });
    const anchor = segmented<FovSettings['anchor']>({
      label: 'Around',
      value: view.fov.anchor,
      size: 'sm',
      onChange: (v) => {
        view.fov.anchor = v;
        requestDraw();
      },
      options: [
        { value: 'target', label: 'Selected object', tip: 'Around the selected or pinned object, following it' },
        { value: 'centre', label: 'Middle of the view', tip: 'Around the middle of the chart' },
      ],
    });
    const box = el(
      'div',
      { class: 'sky-fov' },
      el('div', { class: 'sf-popover__title' }, 'Field of view'),
      radios,
      camera,
      cameraNote,
      el('div', { class: 'sf-popover__title' }, 'Around'),
      anchor.el,
      el('p', { class: 'sky-fov__note' }, 'Typical fields: the one printed on your binoculars, or your eyepiece’s, is the one to trust.'),
    );
    function sync(): void {
      buttons.forEach((b, i) => {
        const on = choices[i]!.id === view.fov.preset;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      camera.hidden = view.fov.preset !== 'camera';
      cameraNote.hidden = view.fov.preset !== 'camera';
      if (document.activeElement !== focal) focal.value = String(view.fov.focalMm);
      sensor.value = view.fov.sensorId;
      anchor.set(view.fov.anchor);
      if (view.fov.preset === 'camera') {
        const f = cameraField(view.fov.focalMm, sensorOf(view.fov.sensorId));
        cameraNote.textContent = `${f.widthDeg.toFixed(1)}° × ${f.heightDeg.toFixed(1)}° with the camera level; a rectilinear lens.`;
      }
      setPressed(fovButton, view.fov.preset !== null);
    }
    return { el: box, sync };
  }

  // --- sky2: saving a picture ---------------------------------------------------------------
  function snapshotCaption(state: ExplorerState): SnapshotCaption {
    const o = state.observer;
    const ns = o.lat_deg >= 0 ? 'N' : 'S';
    const ew = o.lon_deg >= 0 ? 'E' : 'W';
    const place = o.label || `${Math.abs(o.lat_deg).toFixed(1)}° ${ns}, ${Math.abs(o.lon_deg).toFixed(1)}° ${ew}`;
    const zone = displayZone(state);
    const time = withUncertainty(`${formatWithUtc(displayJd, zone)}`, timeInfoAt(engine, displayJd));
    const p = view.panorama;
    const what = view.mode === 'dome' ? `The whole sky, ${view.southUp ? 'south' : 'north'} at the top` : `Looking ${compassPoint(p.azimuth)}, ${Math.round(p.fov)}° wide`;
    const q = state.settings;
    const dark = q.skyQuality === 'bortle' ? `a Bortle ${q.skyBortle} sky` : q.skyQuality === 'nelm' ? `a sky to magnitude ${q.skyNelm.toFixed(1)}` : 'a dark sky';
    return {
      title: `The sky from ${place}`,
      lines: [time, `${what}; stars drawn to magnitude ${zenith.toFixed(1)} overhead for ${dark} (an estimate). Star field: Yale Bright Star Catalogue (NASA HEASARC).`],
    };
  }

  function snapshot(): HTMLCanvasElement | null {
    if (typeof document === 'undefined') return null;
    scheduler.cancel(drawTask);
    draw();
    const pal = currentPalette();
    return composeSnapshot(canvas, dpr, snapshotCaption(store.get()), pal);
  }

  async function saveImage(): Promise<void> {
    try {
      const pic = snapshot();
      if (!pic) return;
      const blob = await canvasBlob(pic);
      const name = fileName(['sky', new Date((displayJd - 2_440_587.5) * 86_400_000).toISOString().slice(0, 16).replace(':', '')], 'png');
      if (canShareFiles() && matchMedia('(pointer: coarse)').matches) {
        const r = await shareFile(blob, name, 'The sky, from SkyFix Lab');
        if (r !== 'unsupported') return;
      }
      saveBlob(blob, name);
      live.textContent = 'The picture was saved.';
    } catch (error) {
      notices.push('caution', `The picture could not be made: ${errorText(error)}`, { key: 'sky-picture' });
    }
  }

  // --- selection -----------------------------------------------------------------------
  /** Pin a local target (not a canonical body) and open its card. */
  function pin(key: string, withCard = true): void {
    pinnedKey = key;
    pinnedFor = store.get().selection.body;
    foundConstellation = keyKind(key) === 'k' ? Number(key.slice(2)) : -1;
    if (withCard) cardKey = key;
  }

  function select(key: string | null): void {
    if (!key) {
      pinnedKey = null;
      cardKey = null;
      foundConstellation = -1;
      requestDraw();
      return;
    }
    const kind = keyKind(key);
    if (kind === 'b') {
      const name = key.slice(2);
      const already = store.get().selection.body === name && pinnedKey === null;
      pinnedKey = null;
      foundConstellation = -1;
      // A second click on the selected Moon or planet opens its close-up.
      if (already && cardKey === key && upCloseSupported(name)) openUpClose(name);
      cardKey = key;
      store.patch({ selection: { body: name } });
    } else if (kind === 's') {
      const i = Number(key.slice(2));
      const nav = scene.stars?.isNav[i] ? scene.stars.nameOf.get(i) : undefined;
      if (nav) {
        pinnedKey = null;
        cardKey = null;
        store.patch({ selection: { body: nav } });
      } else {
        pin(key);
      }
    } else {
      pin(key);
    }
    requestDraw();
  }

  /** Carry out a search hit or a request: select or pin it, face it, open its card. */
  function show(target: SkyTarget, options: { face?: boolean } = {}): boolean {
    const state = store.get();
    let key: string | null = null;
    const id = target.id.trim();
    switch (target.kind) {
      case 'body': {
        const lower = id.toLowerCase();
        const planet = PLANETS.find((b) => b.toLowerCase() === lower);
        const nav = scene.stars ? [...scene.stars.navByName.keys()].find((n) => n.toLowerCase() === lower) : undefined;
        const name = planet ?? nav;
        if (!name) break;
        pinnedKey = null;
        foundConstellation = -1;
        cardKey = planet ? bodyKey(planet) : null;
        store.patch({ selection: { body: name } });
        key = planet ? bodyKey(planet) : starKey(scene.stars!.navByName.get(nav!)!);
        break;
      }
      case 'star': {
        const data = scene.stars;
        if (!data) break;
        let i = /^\d+$/.test(id) ? Number(id) : -1;
        const hr = /^HR\s*(\d+)$/i.exec(id);
        if (hr) i = data.hr.indexOf(Number(hr[1]));
        if (i < 0) i = data.byName.get(id.toLowerCase()) ?? -1;
        if (!(i >= 0 && i < data.count)) break;
        const nav = data.isNav[i] ? data.nameOf.get(i) : undefined;
        if (nav) {
          pinnedKey = null;
          cardKey = null;
          store.patch({ selection: { body: nav } });
        } else pin(starKey(i));
        key = starKey(i);
        break;
      }
      case 'deep_sky': {
        if (!scene.dso.load(engine)) break;
        const i = scene.dso.indexOf(id);
        if (i < 0) break;
        pin(deepSkyKey(i));
        key = deepSkyKey(i);
        break;
      }
      case 'constellation': {
        const c = scene.catalog?.constellations.findIndex((x) => x.abbr.toLowerCase() === id.toLowerCase() || x.name.toLowerCase() === id.toLowerCase()) ?? -1;
        if (c < 0) break;
        pin(constellationKey(c));
        key = constellationKey(c);
        break;
      }
      case 'shower': {
        pin(radiantKey(id.toUpperCase()));
        key = radiantKey(id.toUpperCase());
        break;
      }
      case 'custom': {
        const b = added.get().find((x) => x.name.toLowerCase() === id.toLowerCase());
        if (!b) break;
        pin(customKey(b.name));
        key = customKey(b.name);
        break;
      }
      case 'point': {
        const ra = target.ra_j2000_deg;
        const dec = target.dec_j2000_deg;
        if (ra === undefined || dec === undefined || !Number.isFinite(ra) || !Number.isFinite(dec) || Math.abs(dec) > 90) break;
        const c = Math.cos(dec * DEG);
        pointTarget = { label: id || 'Here', ra2000: ra, dec2000: dec, j2000: Float64Array.of(c * Math.cos(ra * DEG), c * Math.sin(ra * DEG), Math.sin(dec * DEG)) };
        pin(pointKey);
        key = pointKey;
        break;
      }
      default:
    }
    if (!key) {
      notices.push('caution', `The Sky view does not know “${id}”.`, { key: 'sky-show' });
      return false;
    }
    notices.dismissKey('sky-show');
    scheduler.cancel(drawTask);
    draw();
    if ((options.face ?? true) && view.mode === 'panorama') faceKey(key);
    // A shower not active now has no radiant to show: the card says when it is.
    if (keyKind(key) === 'r' && !radiantMarks.some((m) => m.key === key)) {
      const code = key.slice(2);
      const year = [...showerYears.values()].flatMap((y) => y?.showers ?? []).find((s) => s.shower.code === code);
      notices.push(
        'info',
        year
          ? `The ${year.shower.name} are not active now: they run from ${dateMedium(year.start.jd_utc, displayZone(state))} to ${dateMedium(year.end.jd_utc, displayZone(state))}, peaking ${dateMedium(year.peak.jd_utc, displayZone(state))}.`
          : `That shower is not active at the time shown.`,
        { key: 'sky-show' },
      );
      pinnedKey = null;
      cardKey = null;
    }
    requestDraw();
    return true;
  }

  function applyHit(hit: SearchHit): void {
    const kind = hit.kind === 'sun' || hit.kind === 'moon' || hit.kind === 'planet' ? 'body' : hit.kind;
    const id = hit.kind === 'star' ? (hit.index !== null ? String(hit.index) : hit.id) : kind === 'body' ? hit.label : hit.id;
    show({ kind: kind as SkyTarget['kind'], id });
    live.textContent = `${hit.label}: ${KIND_WORDS[hit.kind]}.`;
  }

  // --- sky2: the close-up -----------------------------------------------------------------
  function openUpClose(body: string, features: readonly string[] = []): void {
    if (!upCloseSupported(body)) return;
    if (!cardOpener) cardOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    upClose.open(body, { features });
    root.dataset.upclose = body;
    requestDraw();
    requestAnimationFrame(() => upClose.el.querySelector<HTMLElement>('.sky-upclose__close')?.focus({ preventScroll: true }));
  }

  function closeUpClose(): void {
    upClose.close();
    delete root.dataset.upclose;
    const back = cardOpener;
    cardOpener = null;
    (back && root.contains(back) ? back : canvas).focus({ preventScroll: true });
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
    const key = hitTest(p.x, p.y);
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
    select(hitTest(p.x, p.y));
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
      pinnedKey = null;
      cardKey = null;
      foundConstellation = -1;
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
  /** Turn the panorama toward a target (and tilt up to it if needed). */
  function faceKey(key: string): void {
    const d = directionOf(key);
    if (!d) return;
    view.mode = 'panorama';
    view.aimed = true;
    view.panorama.azimuth = (d.az * RAD + 360) % 360;
    const alt = d.alt * RAD;
    if (alt > pano.topAlt - 5 || alt < pano.bottomAlt + 2) view.panorama.bottomAlt = Math.max(-8, alt - 20);
    requestDraw();
  }
  /** Turn the panorama toward the selected body. */
  function faceSelected(): void {
    const key = selectedKey(store.get());
    if (key) faceKey(key);
  }

  // --- requests from other views (showInSky, openUpClose) ---------------------------------
  function takeRequest(): void {
    const r = requests.take();
    if (!r) return;
    // The first frame gives the scene its places; carry the request out after it.
    scheduler.schedule(() => {
      if (destroyed) return;
      if (r.target) show(r.target, { face: r.face });
      if (r.upClose) openUpClose(r.upClose, r.features ?? []);
    });
  }
  cleanups.push(requests.subscribe(takeRequest));

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
      (s) => [s.observer, s.layers, s.settings, s.selection, s.time.playing] as const,
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
  cleanups.push(added.subscribe(() => requestDraw()));
  // The shell applies the theme to <html>; re-read the tokens when it really changes.
  cleanups.push(
    onThemeChange((theme) => {
      if (theme !== paletteTheme) {
        palette = null;
        requestDraw();
      }
    }),
  );
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) observed = { w: box.width, h: box.height };
      requestDraw();
    });
    ro.observe(root);
    cleanups.push(() => ro.disconnect());
  }
  const onWindowResize = (): void => {
    if (typeof ResizeObserver !== 'function') observed = null;
    requestDraw();
  };
  globalThis.addEventListener?.('resize', onWindowResize);
  cleanups.push(() => globalThis.removeEventListener?.('resize', onWindowResize));
  const onFonts = (): void => {
    palette = null;
    requestDraw();
  };
  document.fonts?.addEventListener?.('loadingdone', onFonts);
  cleanups.push(() => document.fonts?.removeEventListener?.('loadingdone', onFonts));
  cleanups.push(() => {
    if (tonightTimer) clearTimeout(tonightTimer);
  });

  requestDraw();
  takeRequest();

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
      const dso = scene.dso.n ? scene.dso.indexOf(name) : -1;
      const key = body ? body.key : star !== undefined ? starKey(star) : dso >= 0 ? deepSkyKey(dso) : null;
      if (!key) return null;
      const at = renderer.locate(f, key);
      if (!at || Number.isNaN(at.x)) return null;
      const visible = at.alt >= 0 && at.x >= 0 && at.x <= cssW && at.y >= 0 && at.y <= cssH;
      return { x: at.x, y: at.y, visible };
    },
    show,
    openUpClose,
    search(query) {
      if (!searchPopover.isOpen()) searchPopover.open();
      return searchBox.search(query);
    },
    setFov(preset, anchorTo) {
      view.fov.preset = preset;
      if (anchorTo) view.fov.anchor = anchorTo;
      fovBox.sync();
      requestDraw();
    },
    snapshot,
    info: () => ({
      limit: zenith,
      dsoShown,
      milkyWayTexels: mwTexels,
      milkyWayVisibility: mwVisible,
      radiants: radiantMarks.map((m) => m.name),
      custom: customMarks.map((m) => m.name),
      pinned: pinnedKey,
      card: card.current()?.title ?? null,
      upClose: upClose.body(),
      fov: fovLabel(view.fov),
      lastSearchMs,
    }),
  };
}

/** The Sky view as a plain component (`Component = (host, ctx) => {destroy}`). */
export const sky: Component = (host, ctx) => mountSky(host, ctx);

/** Kept for the tests of the magnitude limit (`limitingMagnitude`, the automatic sky). */
export { limitingMagnitude };
