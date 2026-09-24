/**
 * The Map and Globe views (EXPLORER_PLAN section 2): a full-screen offline world map where a
 * click (a long press on touch) sets the observer, with the SunCalc-style compass dial
 * centred exactly on the observer, day/night and twilight shading, the bodies' ground
 * points, circles of equal altitude, a graticule, a measuring tool, and overlays from other
 * views. OWNER: map agent. The look is the approved design (docs/design/map-light.png).
 *
 * One component serves both views: `view === 'globe'` switches MapLibre to its globe
 * projection, `'map'` to Mercator; any other view leaves the projection as it was.
 *
 * Needs the design system on the page (theme/index.ts: tokens, components, layout).
 *
 * Data flow: the store is read in the scheduler's frame (component contract). Per frame the
 * map asks the engine for one `sky_state` of every body (shared with other views through the
 * memoised engine) and redraws the terminator, ground points, circles and the dial's "now".
 * `sample_bodies` and `day_events` run only when the day, the observer or the selection
 * change (EXPLORER_PLAN 3.7).
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';
import { LngLat, Map as MapLibreMap, Marker, ScaleControl, setWorkerUrl, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { FeatureCollection } from 'geojson';
import { disposer, observerKey, type Component, type Ctx, type Mounted } from '../component.js';
import type { BodyState, LatLonDeg, SkyState } from '../engine/types.js';
import { basemapUrl } from '../geo/basemap.js';
import { formatLatLon } from '../geo/coords.js';
import { describeLocation, loadGazetteer, placesGeoJson, type Gazetteer } from '../geo/gazetteer.js';
import { loadRegionIndex, type RegionIndex } from '../geo/regions.js';
import { currentDayWindow, displayZone, engineObserver, eventOptions, type ExplorerState, type Layers, type ObserverState } from '../state.js';
import { dayWindow, formatTime, wallClock, type Zone } from '../time.js';
import { CompassDial, type DialDay, type DialEvent } from './compass.js';
import { createControls, createCredit, type LayerKey, type MapControls } from './controls.js';
import { registerMapFonts } from './fonts.js';
import { formatAngle, formatBearing } from './format.js';
import { angularDistanceDeg, emptyCollection, graticuleFeatures, graticuleStep, wrapLon } from './geometry.js';
import { GroundPoints } from './groundpoints.js';
import { measureFeatures, measure as measureBetween, measureText } from './measure.js';
import { OverlayDrawer } from './overlay-layers.js';
import { serviceImpl } from './overlays.js';
import { describePlace, sameZone } from './place.js';
import { COMPACT_WIDTH, aboveHorizonRuns, compassRadius, norm360, screenBearing, solsticeBand, type AltAz, type SkyRegion } from './skyproj.js';
import { DEFERRED_SOURCES, LAYER, LAYER_GROUPS, SRC, buildStyle, restyle, streetsLayer, streetsSource } from './style.js';
import { onThemeChange, readTokens, type MapTokens } from './style-tokens.js';
import { altitudeRingData, equalAltitudeFeatures, shadeFeatures, terminatorFeatures } from './world.js';

setWorkerUrl(workerUrl);

/** Opening zoom on the flat chart: a region around the observer. */
export const FLAT_ZOOM = 2.7;
/** Opening zoom on the globe: the hemisphere around the observer. */
export const GLOBE_ZOOM = 1.55;
/** How long a touch must be held to set the observer, ms. */
const LONG_PRESS_MS = 550;
/** Samples per hour of `sample_bodies` at the 5-minute step. */
const SAMPLES_PER_HOUR = 12;

export interface MapViewOptions {
  /** The map's own controls (projection, layers, zoom, your place, measuring, legend). Default true. */
  controls?: boolean;
  /** Called once the map has loaded (the developer page and tests). */
  onReady?: (map: MapLibreMap, api: MapViewApi) => void;
}

/** Actions the developer page and tests can drive without clicking. */
export interface MapViewApi {
  /** Open the measuring tool with these points (B may be null). */
  measure(a: LatLonDeg, b: LatLonDeg | null): void;
}

/** A map component; `mapView` is the default one the shell mounts for `map` and `globe`. */
export function createMapView(options: MapViewOptions = {}): Component {
  return (host, ctx) => mountMap(host, ctx, options);
}

export const mapView: Component = createMapView();

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

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const positionKey = (lat: number, lon: number) => `${round6(lat)},${round6(lon)}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** The words for a body's rise and set: "Sunrise", "Moonset", "Venus rises". */
function eventWords(body: string, kind: 'rise' | 'set' | 'transit'): string {
  if (kind === 'transit') return 'Highest';
  if (body === 'Sun' || body === 'Moon') return `${body}${kind}`;
  return kind === 'rise' ? `${body} rises` : `${body} sets`;
}

function mountMap(host: HTMLElement, ctx: Ctx, options: MapViewOptions): Mounted {
  const { store, engine, notices, scheduler } = ctx;
  const d = disposer();
  const service = serviceImpl(ctx);
  void registerMapFonts();

  // --- DOM ----------------------------------------------------------------------------
  const root = el('div', 'sfm', { role: 'region', 'aria-label': 'Map' });
  const mapEl = el('div', 'sfm-map');
  const dialLayer = el('div', 'sfm-dial-layer', { 'aria-hidden': 'true' });
  const crosshair = el('div', 'sfm-crosshair', { 'aria-hidden': 'true' });
  const readout = el('div', 'sfm-readout sf-float sf-on-stage', { role: 'status' });
  readout.hidden = true;
  const live = el('p', 'sfm-sr', { 'aria-live': 'polite' });
  const uid = Math.random().toString(36).slice(2, 8);
  const summary = el('p', 'sfm-sr', { id: `sfm-summary-${uid}` });
  const help = el('p', 'sfm-sr', { id: `sfm-help-${uid}` });
  help.textContent =
    'Click the map, or press and hold on a touch screen, to set your place; drag the marker to move it. ' +
    'With the keyboard: move the map with the arrow keys, then use "Set your place to the centre of the map".';
  // A red-only filter for the online street layer in the night theme.
  const filterSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  filterSvg.setAttribute('class', 'sfm-filters');
  filterSvg.setAttribute('aria-hidden', 'true');
  filterSvg.innerHTML =
    '<filter id="sfm-red-only" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0.3 0.59 0.11 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter>';
  const credit = createCredit();
  root.append(mapEl, dialLayer, crosshair, readout, credit.element, live, summary, help, filterSvg);
  host.appendChild(root);
  d.add(() => root.remove());

  let tokens: MapTokens = readTokens();
  let tokensVersion = 0;

  const s0 = store.get();
  let currentView: 'map' | 'globe' = s0.view === 'globe' ? 'globe' : 'map';
  root.classList.toggle('sfm--globe', currentView === 'globe');

  let map: MapLibreMap;
  try {
    map = new MapLibreMap({
      container: mapEl,
      style: buildStyle(tokens, { projection: currentView === 'globe' ? 'globe' : 'mercator' }),
      center: [s0.observer.lon_deg, s0.observer.lat_deg],
      zoom: currentView === 'globe' ? GLOBE_ZOOM : FLAT_ZOOM,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      maxZoom: 19,
      renderWorldCopies: true,
      fadeDuration: 0,
      cancelPendingTileRequestsWhileZooming: true,
      locale: {
        'Map.Title': 'World map. Click to set your place.',
        'ScaleControl.NauticalMiles': 'NM',
      },
    });
  } catch (error) {
    const fail = el('p', 'sfm-fail', { role: 'alert' });
    fail.textContent = `The map could not start in this browser (${errorText(error)}). It needs WebGL; the other views still work.`;
    root.replaceChildren(fail);
    return { destroy: () => d.dispose() };
  }
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.getCanvas().setAttribute('aria-describedby', `${help.id} ${summary.id}`);
  let destroyed = false;
  d.add(() => {
    destroyed = true;
    map.remove();
  });

  let loaded = false;
  /** The map's size in CSS pixels, read on resize only (reading it each frame forces a layout). */
  let viewW = mapEl.clientWidth;
  let viewH = mapEl.clientHeight;
  const dial = new CompassDial(dialLayer);
  d.add(() => dial.destroy());
  const groundPoints = new GroundPoints(map, (body) => {
    store.patch({ selection: { body } });
    live.textContent = `${body} selected.`;
  });
  d.add(() => groundPoints.destroy());

  // --- Scheduling -----------------------------------------------------------------------
  const renderTask = (): void => render();
  const requestRender = (): void => scheduler.schedule(renderTask);
  d.add(store.subscribe(requestRender));
  d.add(() => scheduler.cancel(renderTask));

  const setData = (id: string, data: FeatureCollection | string): void => {
    (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
  };

  /** Engine calls with a failure shown once, as a keyed notice. */
  function attempt<T>(key: string, what: string, fn: () => T): T | null {
    try {
      const v = fn();
      notices.dismissKey(key);
      return v;
    } catch (error) {
      notices.push('error', `Map: ${what}: ${errorText(error)}`, { key });
      return null;
    }
  }

  // --- Places: gazetteer and country polygons, for names and time zones -----------------
  let gazetteer: Gazetteer | null = null;
  let regions: RegionIndex | null = null;
  /** The last position the map itself put the observer on (its zone may be re-guessed). */
  let lastMapSet: string | null = null;
  let labelledWithRegions = false;

  /** Name an unnamed observer, and finish a guess made before the data had loaded. */
  function relabel(): void {
    if (!gazetteer) return;
    const o = store.get().observer;
    const mapSet = lastMapSet === positionKey(o.lat_deg, o.lon_deg);
    if (o.label && (!mapSet || labelledWithRegions)) return;
    const info = describePlace(gazetteer, regions, o.lat_deg, o.lon_deg, o.zone);
    const patch: Partial<ObserverState> = {};
    if (!o.label || mapSet) patch.label = info.label;
    // A zone that came with the place (a share link) is kept; one the map guessed is refined.
    if (mapSet && info.zone && !sameZone(info.zone, o.zone)) patch.zone = info.zone;
    labelledWithRegions = mapSet && regions !== null;
    if (Object.keys(patch).length) store.patch({ observer: patch });
  }

  // --- Setting the observer ---------------------------------------------------------------
  let dragPending: LatLonDeg | null = null;
  const applyDrag = (): void => {
    if (!dragPending) return;
    const p = dragPending;
    dragPending = null;
    setObserverAt(p.lat_deg, p.lon_deg, 'drag');
  };

  function setObserverAt(lat: number, lon: number, phase: 'drag' | 'final'): void {
    const la = round6(Math.max(-90, Math.min(90, lat)));
    const lo = round6(wrapLon(lon));
    const current = store.get().observer;
    const patch: Partial<ObserverState> = { lat_deg: la, lon_deg: lo, height_m: 0 };
    if (gazetteer && phase === 'final') {
      const info = describePlace(gazetteer, regions, la, lo, current.zone);
      patch.label = info.label;
      if (info.zone && !sameZone(info.zone, current.zone)) patch.zone = info.zone;
      labelledWithRegions = regions !== null;
    } else {
      patch.label = gazetteer ? describeLocation(gazetteer, la, lo).text : '';
      labelledWithRegions = false;
    }
    lastMapSet = positionKey(la, lo);
    store.patch({ observer: patch });
    if (phase === 'final') {
      const where = patch.label ? `, ${patch.label}` : '';
      live.textContent = `Your place is now ${formatLatLon({ lat_deg: la, lon_deg: lo })}${where}.`;
    }
  }

  // --- The observer marker ------------------------------------------------------------------
  const markerEl = el('div', 'sfm-observer', { 'aria-hidden': 'true', title: 'Your place: drag to move it' });
  const marker = new Marker({ element: markerEl, draggable: true, anchor: 'center', opacityWhenCovered: 0 })
    .setLngLat([s0.observer.lon_deg, s0.observer.lat_deg])
    .addTo(map);
  marker.on('dragstart', () => root.classList.add('sfm--dragging'));
  marker.on('drag', () => {
    const ll = marker.getLngLat();
    dragPending = { lat_deg: ll.lat, lon_deg: ll.lng };
    scheduler.schedule(applyDrag);
  });
  marker.on('dragend', () => {
    root.classList.remove('sfm--dragging');
    scheduler.cancel(applyDrag);
    dragPending = null;
    const ll = marker.getLngLat();
    setObserverAt(ll.lat, ll.lng, 'final');
  });
  d.add(() => marker.remove());

  // --- Measuring ----------------------------------------------------------------------------
  const measuring = { active: false, a: null as LatLonDeg | null, b: null as LatLonDeg | null };
  const measureMarkers: Marker[] = [];
  const readoutText = el('div', 'sfm-readout__text');
  const readoutButtons = el('div', 'sfm-readout__buttons');
  const clearBtn = el('button', 'sf-btn sf-btn--secondary sf-btn--sm', { type: 'button' });
  clearBtn.textContent = 'Clear';
  const doneBtn = el('button', 'sf-btn sf-btn--secondary sf-btn--sm', { type: 'button' });
  doneBtn.textContent = 'Done';
  readoutButtons.append(clearBtn, doneBtn);
  readout.append(readoutText, readoutButtons);
  clearBtn.addEventListener('click', () => {
    measuring.a = null;
    measuring.b = null;
    syncMeasure();
  });
  doneBtn.addEventListener('click', () => toggleMeasure(false));

  function measureMarker(label: string, which: 'a' | 'b'): Marker {
    const e = el('div', 'sfm-measure-pin', { 'aria-hidden': 'true' });
    e.textContent = label;
    const m = new Marker({ element: e, draggable: true, anchor: 'center' });
    m.on('drag', () => {
      const ll = m.getLngLat();
      measuring[which] = { lat_deg: ll.lat, lon_deg: wrapLon(ll.lng) };
      syncMeasure();
    });
    return m;
  }
  measureMarkers.push(measureMarker('A', 'a'), measureMarker('B', 'b'));
  d.add(() => measureMarkers.forEach((m) => m.remove()));

  function syncMeasure(): void {
    if (!loaded) return;
    const { a, b } = measuring;
    setData(SRC.measure, measuring.active ? measureFeatures(a, b) : emptyCollection());
    [a, b].forEach((p, i) => {
      const m = measureMarkers[i]!;
      if (measuring.active && p) m.setLngLat([p.lon_deg, p.lat_deg]).addTo(map);
      else m.remove();
    });
    readout.hidden = !measuring.active;
    root.classList.toggle('sfm--measuring', measuring.active);
    if (!measuring.active) return;
    readoutText.replaceChildren();
    const title = el('p', 'sfm-readout__title');
    if (a && b) {
      const t = measureText(measureBetween(a, b), store.get().settings.units);
      title.textContent = 'From A to B';
      const gc = el('p', 'sfm-readout__line');
      gc.textContent = t.greatCircle;
      const rh = el('p', 'sfm-readout__line');
      rh.textContent = t.rhumb;
      readoutText.append(title, gc, rh);
    } else {
      title.textContent = a ? 'Now click the second point (B).' : 'Measuring: click the first point (A).';
      readoutText.append(title);
    }
  }

  function toggleMeasure(on = !measuring.active): void {
    measuring.active = on;
    if (!on) {
      measuring.a = null;
      measuring.b = null;
    }
    syncMeasure();
    requestRender();
  }

  // --- Picking on the map ------------------------------------------------------------------
  function pick(lngLat: LngLat): void {
    const ll = lngLat.wrap();
    if (measuring.active) {
      const p = { lat_deg: ll.lat, lon_deg: ll.lng };
      if (!measuring.a || measuring.b) {
        measuring.a = p;
        measuring.b = null;
      } else {
        measuring.b = p;
      }
      syncMeasure();
      return;
    }
    setObserverAt(ll.lat, ll.lng, 'final');
  }

  let lastPointerType = 'mouse';
  let longPress: { id: number; x: number; y: number; timer: number } | null = null;
  const cancelLongPress = (): void => {
    if (longPress) clearTimeout(longPress.timer);
    longPress = null;
  };
  const onPointerDown = (e: PointerEvent): void => {
    lastPointerType = e.pointerType;
    if (e.pointerType !== 'touch') return;
    if (longPress) {
      cancelLongPress(); // a second finger: a pinch, not a press
      return;
    }
    const start = { id: e.pointerId, x: e.clientX, y: e.clientY };
    longPress = {
      ...start,
      timer: window.setTimeout(() => {
        longPress = null;
        const rect = mapEl.getBoundingClientRect();
        pick(map.unproject([start.x - rect.left, start.y - rect.top]));
        navigator.vibrate?.(12);
      }, LONG_PRESS_MS),
    };
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (longPress && e.pointerId === longPress.id && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > 10) cancelLongPress();
  };
  const onContextMenu = (e: Event): void => {
    if (lastPointerType === 'touch') e.preventDefault();
  };
  mapEl.addEventListener('pointerdown', onPointerDown, true);
  mapEl.addEventListener('pointermove', onPointerMove, true);
  mapEl.addEventListener('pointerup', cancelLongPress, true);
  mapEl.addEventListener('pointercancel', cancelLongPress, true);
  mapEl.addEventListener('contextmenu', onContextMenu);
  d.add(() => {
    cancelLongPress();
    mapEl.removeEventListener('pointerdown', onPointerDown, true);
    mapEl.removeEventListener('pointermove', onPointerMove, true);
    mapEl.removeEventListener('pointerup', cancelLongPress, true);
    mapEl.removeEventListener('pointercancel', cancelLongPress, true);
    mapEl.removeEventListener('contextmenu', onContextMenu);
  });

  map.on('click', (e: MapMouseEvent) => {
    if (lastPointerType === 'touch') return; // on touch a long press sets the place
    pick(e.lngLat);
  });

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && measuring.active) {
      toggleMeasure(false);
      e.preventDefault();
    }
  };
  root.addEventListener('keydown', onKey);
  d.add(() => root.removeEventListener('keydown', onKey));

  // --- Camera ---------------------------------------------------------------------------------
  const duration = (ms: number) => (reducedMotion() ? 0 : ms);

  /**
   * On the globe, whether a location is on the far side: project it, read the map back at
   * that pixel, and compare (the near surface answers for a hidden point). Public API only.
   */
  function occluded(ll: LngLat, p: { x: number; y: number }): boolean {
    if (currentView !== 'globe') return false;
    if (p.x < -1e4 || p.y < -1e4 || p.x > viewW + 1e4 || p.y > viewH + 1e4) return true;
    const back = map.unproject([p.x, p.y]);
    return angularDistanceDeg({ lat_deg: back.lat, lon_deg: back.lng }, { lat_deg: ll.lat, lon_deg: ll.lng }) > 0.5;
  }

  /** The longitude of the world copy nearest the map's centre (Mercator draws copies side by side). */
  function nearestCopy(lon: number): number {
    if (currentView === 'globe') return lon;
    const c = map.getCenter().lng;
    return lon + 360 * Math.round((c - lon) / 360);
  }

  function viewportContains(lat: number, lon: number, marginPx = 40): boolean {
    const ll = new LngLat(nearestCopy(lon), lat);
    const p = map.project(ll);
    if (occluded(ll, p)) return false;
    return p.x >= marginPx && p.y >= marginPx && p.x <= viewW - marginPx && p.y <= viewH - marginPx;
  }

  function recentre(): void {
    const o = store.get().observer;
    const p = map.project(new LngLat(nearestCopy(o.lon_deg), o.lat_deg));
    const centred = Math.hypot(p.x - viewW / 2, p.y - viewH / 2) < 4;
    map.easeTo({
      center: [o.lon_deg, o.lat_deg],
      zoom: centred ? (currentView === 'globe' ? GLOBE_ZOOM : FLAT_ZOOM) : map.getZoom(),
      duration: duration(500),
    });
  }

  function placeAtCentre(): void {
    const c = map.getCenter().wrap();
    setObserverAt(c.lat, c.lng, 'final');
  }

  let lastObserverKey = positionKey(s0.observer.lat_deg, s0.observer.lon_deg);
  function followObserver(o: ObserverState): void {
    const key = positionKey(o.lat_deg, o.lon_deg);
    if (key === lastObserverKey) return;
    lastObserverKey = key;
    if (key === lastMapSet) return; // the map put it there: it is in view
    if (!viewportContains(o.lat_deg, o.lon_deg)) map.easeTo({ center: [o.lon_deg, o.lat_deg], duration: duration(600) });
  }

  // --- Controls ---------------------------------------------------------------------------
  let controls: MapControls | null = null;
  if (options.controls ?? true) {
    controls = createControls(
      {
        zoomIn: () => map.zoomIn({ duration: duration(250) }),
        zoomOut: () => map.zoomOut({ duration: duration(250) }),
        recentre,
        placeAtCentre,
        toggleMeasure: () => toggleMeasure(),
        setProjection: (view) => store.patch({ view }),
        setLayer: (key: LayerKey, on: boolean) => store.patch({ layers: { [key]: on } }),
      },
      root,
    );
    root.append(...controls.elements);
    d.add(() => controls?.destroy());
  }

  // --- Layers -----------------------------------------------------------------------------
  let appliedLayers: Layers | null = null;
  function syncLayers(L: Layers): void {
    if (appliedLayers === L) return;
    appliedLayers = L;
    const vis = (ids: readonly string[], on: boolean) => {
      for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    };
    vis(LAYER_GROUPS.shade, L.terminator || L.twilight);
    vis(LAYER_GROUPS.terminator, L.terminator);
    vis(LAYER_GROUPS.graticule, L.graticule);
    vis(LAYER_GROUPS.circles, L.circles);
    vis(LAYER_GROUPS.altitudeRings, L.altitudeRings);
    syncStreets(L.streets);
    if (L.graticule) syncGraticule();
  }

  function syncStreets(on: boolean): void {
    const has = Boolean(map.getSource(SRC.streets));
    if (on && !has) {
      map.addSource(SRC.streets, streetsSource());
      map.addLayer(streetsLayer(tokens), LAYER.streetsBefore);
    } else if (!on && has) {
      if (map.getLayer(SRC.streets)) map.removeLayer(SRC.streets);
      map.removeSource(SRC.streets);
    }
    credit.setStreets(on);
    root.classList.toggle('sfm--red-streets', on && tokens.theme === 'night');
  }

  let scale: ScaleControl | null = null;
  let scaleUnit = '';
  function syncScale(on: boolean, units: ExplorerState['settings']['units']): void {
    if (!on) {
      if (scale) map.removeControl(scale);
      scale = null;
      return;
    }
    if (!scale) {
      scale = new ScaleControl({ maxWidth: 110, unit: units });
      map.addControl(scale, 'bottom-right');
      scaleUnit = units;
    } else if (scaleUnit !== units) {
      scale.setUnit(units);
      scaleUnit = units;
    }
  }

  let graticuleKey = '';
  function syncGraticule(): void {
    if (!loaded || !store.get().layers.graticule) return;
    const zoom = map.getZoom();
    const span = Math.min(360, (360 * Math.max(viewW, 1)) / (512 * 2 ** zoom));
    const step = graticuleStep(span);
    let key = `g${step}`;
    let bounds: { west: number; south: number; east: number; north: number } | undefined;
    if (step < 5) {
      const b = map.getBounds();
      const q = (v: number) => Math.round(v / step) * step;
      bounds = { west: q(b.getWest()), south: Math.max(-89, q(b.getSouth())), east: q(b.getEast()), north: Math.min(89, q(b.getNorth())) };
      key += `|${bounds.west}|${bounds.south}|${bounds.east}|${bounds.north}`;
    }
    if (key === graticuleKey) return;
    graticuleKey = key;
    setData(SRC.graticule, graticuleFeatures(step, bounds));
  }

  // --- Projection -------------------------------------------------------------------------
  function syncView(view: ExplorerState['view']): void {
    const want = view === 'globe' ? 'globe' : view === 'map' ? 'map' : currentView;
    if (want === currentView) return;
    currentView = want;
    root.classList.toggle('sfm--globe', want === 'globe');
    map.setProjection({ type: want === 'globe' ? 'globe' : 'mercator' });
    const z = map.getZoom();
    if (want === 'globe' && z > GLOBE_ZOOM + 0.6) map.easeTo({ zoom: GLOBE_ZOOM, duration: duration(500) });
    if (want === 'map' && z < FLAT_ZOOM - 1.2) map.easeTo({ zoom: FLAT_ZOOM - 1, duration: duration(500) });
    graticuleKey = '';
  }

  // --- World layers -----------------------------------------------------------------------
  const keys = { shade: '', terminator: '', circle: '', rings: '' };
  function syncWorld(s: ExplorerState, sky: SkyState | null): void {
    const L = s.layers;
    const sun = sky?.bodies.find((b) => b.body === 'Sun');
    const selected = s.selection.body;
    const body = selected ? sky?.bodies.find((b) => b.body === selected) : undefined;
    const v = tokensVersion;

    const shadeKey = sun && (L.terminator || L.twilight) ? `${sun.gp.lat_deg}|${sun.gp.lon_deg}|${L.twilight}|${L.terminator}|${v}` : 'off';
    if (shadeKey !== keys.shade) {
      keys.shade = shadeKey;
      setData(SRC.shade, sun && shadeKey !== 'off' ? shadeFeatures(sun.gp, L, tokens) : emptyCollection());
    }
    const termKey = sun && L.terminator ? `${sun.gp.lat_deg}|${sun.gp.lon_deg}` : 'off';
    if (termKey !== keys.terminator) {
      keys.terminator = termKey;
      setData(SRC.terminator, sun && L.terminator ? terminatorFeatures(sun.gp) : emptyCollection());
    }
    groundPoints.update(sky?.bodies ?? [], selected, L.groundPoints && sky !== null);
    const circleKey = body && L.circles ? `${body.gp.lat_deg}|${body.gp.lon_deg}|${body.hc_deg}|${s.settings.angleFormat}|${v}` : 'off';
    if (circleKey !== keys.circle) {
      keys.circle = circleKey;
      setData(SRC.equalAltitude, L.circles ? equalAltitudeFeatures(body, tokens, s.settings.angleFormat) : emptyCollection());
    }
    const ringsKey = body && L.altitudeRings ? `${body.gp.lat_deg}|${body.gp.lon_deg}|${v}` : 'off';
    if (ringsKey !== keys.rings) {
      keys.rings = ringsKey;
      setData(SRC.rings, L.altitudeRings ? altitudeRingData(body, tokens) : emptyCollection());
    }
  }

  // --- The compass dial -------------------------------------------------------------------
  let dayKey = '';
  let bandKey = '';
  let band: { region: SkyRegion; runs: AltAz[][][] } | null = null;
  let summaryText = '';

  function zoneKeyOf(z: Zone): string {
    return z.kind === 'iana' ? z.zone : `${z.name}|${z.offsetMs}`;
  }

  /** `currentDayWindow`, kept while the time stays inside the same local day (it costs Intl calls). */
  let dayMemo: { zone: string; start: number; end: number } | null = null;
  function dayWindowOf(s: ExplorerState): [number, number] {
    const zone = displayZone(s);
    const key = zoneKeyOf(zone);
    const jd = s.time.jd_utc;
    if (dayMemo && dayMemo.zone === key && jd >= dayMemo.start && jd < dayMemo.end) return [dayMemo.start, dayMemo.end];
    const [start, end] = currentDayWindow(s);
    dayMemo = { zone: key, start, end };
    return [start, end];
  }

  function solsticeData(s: ExplorerState, zone: Zone): { region: SkyRegion; runs: AltAz[][][] } | null {
    const obs = engineObserver(s);
    const year = wallClock(s.time.jd_utc, zone).year;
    const key = `${observerKey(obs)}|${year}|${zoneKeyOf(zone)}`;
    if (key === bandKey) return band;
    bandKey = key;
    band = attempt('map-solstice', 'the Sun’s solstice paths could not be computed', () => {
      const seasons = engine.seasons(year);
      const june = seasons.find((e) => e.kind === 'june_solstice');
      const december = seasons.find((e) => e.kind === 'december_solstice');
      if (!june || !december) return null;
      const track = (jd: number) => {
        const [a, b] = dayWindow(jd, zone);
        const t = engine.sampleBodies(obs, ['Sun'], a, b, 5).bodies[0];
        return t ? { alt: t.alt_apparent_deg, az: t.az_deg } : null;
      };
      const j = track(june.jd_utc);
      const dcm = track(december.jd_utc);
      if (!j || !dcm) return null;
      return { region: solsticeBand(j, dcm, obs.lat_deg), runs: [aboveHorizonRuns(j, true), aboveHorizonRuns(dcm, true)] };
    });
    return band;
  }

  function buildDay(s: ExplorerState, body: string, info: BodyState | undefined): DialDay | null {
    const obs = engineObserver(s);
    const [start, end] = dayWindowOf(s);
    const zone = displayZone(s);
    const kind = info?.kind ?? engine.bodies().find((b) => b.body === body)?.kind ?? 'star';
    const data = attempt('map-day', `today’s path of ${body} could not be computed`, () => ({
      sampled: engine.sampleBodies(obs, [body], start, end, 5),
      events: engine.dayEvents(obs, start, end, [body], eventOptions(s)),
    }));
    if (!data) return null;
    const track = data.sampled.bodies[0];
    const bodyEvents = data.events.bodies[0];
    const path = track && s.layers.paths ? aboveHorizonRuns({ alt: track.alt_apparent_deg, az: track.az_deg }) : [];
    const hours: AltAz[] = [];
    if (track && s.layers.paths) {
      // Whole hours of the display clock: the day window starts on one.
      for (let i = SAMPLES_PER_HOUR; i < track.alt_apparent_deg.length - 1; i += SAMPLES_PER_HOUR) {
        const alt = track.alt_apparent_deg[i]!;
        if (alt > 0.5) hours.push({ alt, az: track.az_deg[i]! });
      }
    }
    const events: DialEvent[] = (bodyEvents?.events ?? [])
      .filter((e) => e.kind === 'rise' || e.kind === 'set' || e.kind === 'transit')
      .map((e) => {
        const kind = e.kind as DialEvent['kind'];
        const time = formatTime(e.jd_utc, zone);
        return { kind, alt: e.alt_deg, az: e.az_deg, label: `${eventWords(body, kind)} ${time}`, time };
      });
    let note = '';
    if (bodyEvents?.always_above) note = `${body} up all day`;
    else if (bodyEvents?.always_below) note = `${body} down all day`;
    const sun = kind === 'sun' && s.layers.paths ? solsticeData(s, zone) : null;
    summaryText = daySummary(body, events, note, s);
    return { body, kind, path, hours, events, note, band: sun?.region ?? null, solstices: sun?.runs ?? [] };
  }

  function daySummary(body: string, events: DialEvent[], note: string, s: ExplorerState): string {
    if (note) return `${note}.`;
    const parts = events.map((e) =>
      e.kind === 'transit'
        ? `highest ${e.time} at ${formatAngle(e.alt, s.settings.angleFormat)}`
        : `${e.label}, bearing ${formatBearing(e.az)}`,
    );
    return parts.length ? `${body} today: ${parts.join('; ')}.` : '';
  }

  function syncDial(s: ExplorerState, sky: SkyState | null): void {
    const L = s.layers;
    dial.setRadius(compassRadius(viewW, viewH));
    dial.setCompact(viewW < COMPACT_WIDTH);
    root.classList.toggle('sfm--compact', viewW < COMPACT_WIDTH);
    dial.setDialVisible(L.compass);
    root.classList.toggle('sfm--bare', !L.compass);
    const o = s.observer;
    dial.setPlaceLabel(o.label || formatLatLon({ lat_deg: o.lat_deg, lon_deg: o.lon_deg }));
    const body = L.compass ? s.selection.body : null;
    const info = body ? sky?.bodies.find((b) => b.body === body) : undefined;
    const [start, end] = dayWindowOf(s);
    const opts = eventOptions(s);
    const key = body
      ? `${observerKey(engineObserver(s))}|${start}|${end}|${body}|${opts.horizon}|${opts.height_of_eye_m}|${zoneKeyOf(displayZone(s))}|${L.paths}|${s.settings.angleFormat}`
      : 'none';
    if (key !== dayKey) {
      dayKey = key;
      summaryText = '';
      dial.setDay(body ? buildDay(s, body, info) : null);
      summary.textContent = summaryText;
    }
    dial.setNow(
      info
        ? {
            alt: info.alt_apparent_deg,
            az: info.az_deg,
            phase:
              info.kind === 'moon' && info.illuminated_fraction !== null
                ? {
                    fraction: info.illuminated_fraction,
                    limbFromZenithDeg: info.bright_limb_angle_deg === null ? null : info.bright_limb_angle_deg - info.parallactic_angle_deg,
                  }
                : null,
          }
        : null,
    );
    placeDial();
  }

  function placeDial(): void {
    if (!loaded) return;
    const o = store.get().observer;
    const ll = new LngLat(nearestCopy(o.lon_deg), o.lat_deg);
    const p = map.project(ll);
    const R = compassRadius(viewW, viewH) + 80;
    const visible = !occluded(ll, p) && p.x > -R && p.y > -R && p.x < viewW + R && p.y < viewH + R;
    let rotation = 0;
    if (currentView === 'globe' && visible) {
      // The dial's north follows the local meridian on the globe.
      const dLat = o.lat_deg > 89.9 ? -0.02 : 0.02;
      const q = map.project(new LngLat(ll.lng, o.lat_deg + dLat));
      rotation = screenBearing(q.x - p.x, q.y - p.y);
      if (dLat < 0) rotation = norm360(rotation + 180);
      if (rotation > 180) rotation -= 360;
    }
    dial.place(p.x, p.y, rotation, visible);
  }

  // --- The frame ----------------------------------------------------------------------------
  let lastMarker = '';
  let controlsLayers: Layers | null = null;
  let controlsState = '';
  function render(): void {
    if (!loaded || destroyed) return;
    // Mounted but not shown (a hidden tab or panel): nothing to draw until it is resized in.
    if (viewW === 0 || viewH === 0) return;
    const s = store.get();
    syncView(s.view);
    syncLayers(s.layers);
    syncScale(s.layers.scaleBar, s.settings.units);
    const o = s.observer;
    const mk = positionKey(o.lat_deg, o.lon_deg);
    if (mk !== lastMarker && !root.classList.contains('sfm--dragging')) {
      lastMarker = mk;
      marker.setLngLat([o.lon_deg, o.lat_deg]);
    }
    followObserver(o);
    const sky = attempt('map-sky', 'positions could not be computed', () => engine.skyState(engineObserver(s), s.time.jd_utc, 'all'));
    syncWorld(s, sky);
    syncDial(s, sky);
    const controlsKey = `${measuring.active}|${currentView}`;
    if (controls && (s.layers !== controlsLayers || controlsKey !== controlsState)) {
      controlsLayers = s.layers;
      controlsState = controlsKey;
      controls.update({ layers: s.layers, measuring: measuring.active, projection: currentView });
    }
    if (measuring.active && measuring.a && measuring.b) syncMeasure();
  }

  // --- Theme --------------------------------------------------------------------------------
  let overlays: OverlayDrawer | null = null;
  d.add(
    onThemeChange(() => {
      tokens = readTokens();
      tokensVersion += 1;
      if (loaded) {
        restyle(map, tokens);
        overlays?.restyle();
        root.classList.toggle('sfm--red-streets', store.get().layers.streets && tokens.theme === 'night');
      }
      requestRender();
    }),
  );

  // --- Loading --------------------------------------------------------------------------------
  let pendingDetail = new Set<string>();
  map.on('error', (e) => {
    const message = errorText((e as { error?: unknown }).error ?? e);
    console.warn('map:', message);
    notices.push('caution', `Map: some map data could not be loaded (${message}).`, { key: 'map-data' });
  });
  map.on('sourcedata', (e) => {
    if (!pendingDetail.size || !e.sourceId || !pendingDetail.has(e.sourceId) || !map.isSourceLoaded(e.sourceId)) return;
    pendingDetail.delete(e.sourceId);
    if (!pendingDetail.size) root.dataset.detail = '1';
  });
  map.on('move', placeDial);
  map.on('moveend', syncGraticule);
  map.on('resize', () => {
    const wasHidden = viewW === 0 || viewH === 0;
    viewW = mapEl.clientWidth;
    viewH = mapEl.clientHeight;
    if (wasHidden) requestRender();
    dial.setRadius(compassRadius(viewW, viewH));
    dial.setCompact(viewW < COMPACT_WIDTH);
    root.classList.toggle('sfm--compact', viewW < COMPACT_WIDTH);
    placeDial();
    graticuleKey = '';
    syncGraticule();
  });

  map.once('load', () => {
    if (destroyed) return;
    loaded = true;
    viewW = mapEl.clientWidth;
    viewH = mapEl.clientHeight;
    overlays = new OverlayDrawer(map, service, () => tokens);
    d.add(() => overlays?.destroy());
    service.attachCamera({
      apply(request) {
        if (request.kind === 'fly' && request.position) {
          map.easeTo({ center: [request.position.lon_deg, request.position.lat_deg], zoom: request.zoom ?? map.getZoom(), duration: duration(600) });
        } else if (request.kind === 'fit' && request.bounds) {
          const [w, so, e, n] = request.bounds;
          map.fitBounds(
            [
              [w, so],
              [e, n],
            ],
            { padding: request.padding ?? 48, maxZoom: request.maxZoom ?? 8, duration: duration(600) },
          );
        }
      },
    });
    d.add(() => service.attachCamera(null));
    render();
    syncGraticule();
    options.onReady?.(map, {
      measure(a, b) {
        measuring.active = true;
        measuring.a = a;
        measuring.b = b;
        syncMeasure();
        requestRender();
      },
    });
  });

  map.once('idle', () => {
    if (destroyed) return;
    // The heavier 1:50m layers, once the first picture is on screen.
    root.dataset.detail = 'loading';
    pendingDetail = new Set(Object.keys(DEFERRED_SOURCES));
    for (const [id, layer] of Object.entries(DEFERRED_SOURCES)) setData(id, basemapUrl(layer));
    loadGazetteer()
      .then((g) => {
        if (destroyed) return;
        gazetteer = g;
        setData(SRC.places, placesGeoJson(g) as FeatureCollection);
        relabel();
        root.dataset.places = '1';
        return loadRegionIndex().then((r) => {
          if (destroyed) return;
          regions = r;
          relabel();
        });
      })
      .catch((error: unknown) => {
        notices.push('caution', `Map: place names could not be loaded (${errorText(error)}); places are shown as coordinates.`, { key: 'map-places' });
      });
  });

  requestRender();
  return {
    destroy() {
      d.dispose();
    },
  };
}
