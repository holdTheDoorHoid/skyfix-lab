/**
 * The Map and Globe views (EXPLORER_PLAN section 2): a full-screen offline world map where a
 * click (a long press on touch) sets the observer, with the SunCalc-style compass dial at
 * the observer, day/night and twilight, the bodies' ground points, circles of equal
 * altitude, a graticule, a measuring tool, and overlays from other views. OWNER: map agent.
 *
 * One component serves both views: `view === 'globe'` switches MapLibre to its globe
 * projection, `'map'` to Mercator; any other view leaves the projection as it was.
 *
 * Data flow: the store is read in the scheduler's frame (component contract). Per frame the
 * map asks the engine for one `sky_state` of every body (shared with other views through the
 * memoised engine) and redraws the terminator, ground points, circles and the dial's "now".
 * `sample_bodies` and `day_events` run only when the day, the observer or the selection
 * changes (EXPLORER_PLAN 3.7).
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';
import { LngLat, Map as MapLibreMap, Marker, ScaleControl, setWorkerUrl, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { FeatureCollection } from 'geojson';
import { disposer, observerKey, type Component, type Ctx, type Mounted } from '../component.js';
import type { BodyState, LatLonDeg, SkyState } from '../engine/types.js';
import { formatLatLon } from '../geo/coords.js';
import { describeLocation, loadGazetteer, placesGeoJson, type Gazetteer } from '../geo/gazetteer.js';
import { loadRegionIndex, type RegionIndex } from '../geo/regions.js';
import { basemapUrl } from '../geo/basemap.js';
import { currentDayWindow, displayZone, engineObserver, eventOptions, type ExplorerState, type Layers, type ObserverState } from '../state.js';
import { dayWindow, formatTime, wallClock, type Zone } from '../time.js';
import { CompassDial, type DialDay, type DialEvent } from './compass.js';
import { createControls, type LayerKey, type MapControls } from './controls.js';
import { registerMapFonts } from './fonts.js';
import { formatAngle, formatBearing } from './format.js';
import { angularDistanceDeg, emptyCollection, graticuleFeatures, graticuleStep, wrapLon } from './geometry.js';
import { measureFeatures, measure as measureBetween, measureText } from './measure.js';
import { OverlayDrawer } from './overlay-layers.js';
import { serviceImpl } from './overlays.js';
import { describePlace, sameZone } from './place.js';
import { aboveHorizonRuns, compassRadius, norm360, screenBearing, solsticeBand, type AltAz, type SkyRegion } from './skyproj.js';
import {
  DEFERRED_SOURCES,
  LAYER,
  LAYER_GROUPS,
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  SRC,
  buildStyle,
  restyle,
  streetsLayer,
  streetsSource,
} from './style.js';
import { applyCssTokens, onThemeChange, readTokens, type MapTokens } from './style-tokens.js';
import { altitudeRingData, equalAltitudeFeatures, groundPointFeatures, shadeFeatures, terminatorFeatures } from './world.js';

setWorkerUrl(workerUrl);

/** Opening zoom on the flat chart: a region around the observer. */
export const FLAT_ZOOM = 3.4;
/** Opening zoom on the globe: the hemisphere around the observer. */
export const GLOBE_ZOOM = 1.55;
/** How long a touch must be held to set the observer, ms. */
const LONG_PRESS_MS = 550;

export interface MapViewOptions {
  /** The map's own buttons (zoom, your place, measure, layers, flat/globe). Default true. */
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
  const readout = el('div', 'sfm-readout', { role: 'status' });
  readout.hidden = true;
  const attribution = el('div', 'sfm-attrib');
  attribution.hidden = true;
  const link = el('a', '', { href: OSM_COPYRIGHT_URL, target: '_blank', rel: 'noopener noreferrer' });
  link.textContent = OSM_ATTRIBUTION;
  attribution.append(link);
  const live = el('p', 'sfm-sr', { 'aria-live': 'polite' });
  const summary = el('p', 'sfm-sr', { id: `sfm-summary-${Math.random().toString(36).slice(2, 8)}` });
  const help = el('p', 'sfm-sr', { id: `sfm-help-${Math.random().toString(36).slice(2, 8)}` });
  help.textContent =
    'Click the map, or press and hold on a touch screen, to set your place; drag the marker to move it. ' +
    'With the keyboard: move the map with the arrow keys and use "Put your place at the centre of the map".';
  // A red-only colour filter for the online street layer in the night theme.
  const filterSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  filterSvg.setAttribute('class', 'sfm-filters');
  filterSvg.setAttribute('aria-hidden', 'true');
  filterSvg.innerHTML =
    '<filter id="sfm-red-only" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0.3 0.59 0.11 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter>';
  root.append(mapEl, dialLayer, crosshair, readout, attribution, live, summary, help, filterSvg);
  host.appendChild(root);
  d.add(() => root.remove());

  let tokens: MapTokens = readTokens();
  let tokensVersion = 0;
  applyCssTokens(root, tokens);

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
    root.replaceChildren(
      Object.assign(el('p', 'sfm-fail', { role: 'alert' }), {
        textContent: `The map could not start in this browser (${errorText(error)}). It needs WebGL; the other views still work.`,
      }),
    );
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
  const dial = new CompassDial(dialLayer);
  d.add(() => dial.destroy());

  // --- Scheduling -----------------------------------------------------------------------
  const renderTask = (): void => render();
  const requestRender = (): void => scheduler.schedule(renderTask);
  d.add(store.subscribe(requestRender));
  d.add(() => scheduler.cancel(renderTask));

  const setData = (id: string, data: FeatureCollection | string): void => {
    const src = map.getSource(id) as GeoJSONSource | undefined;
    src?.setData(data);
  };

  // --- Engine calls with failures shown once --------------------------------------------
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

  // --- Places: gazetteer and country polygons (for names and time zones) ----------------
  let gazetteer: Gazetteer | null = null;
  let regions: RegionIndex | null = null;
  /** The last position the map itself put the observer on (so it can relabel it). */
  let lastMapSet: string | null = null;
  let labelledWithRegions = false;

  function relabelMapPosition(): void {
    const o = store.get().observer;
    if (!gazetteer || lastMapSet !== positionKey(o.lat_deg, o.lon_deg)) return;
    if (o.label && labelledWithRegions) return;
    const info = describePlace(gazetteer, regions, o.lat_deg, o.lon_deg, o.zone);
    labelledWithRegions = regions !== null;
    const patch: Partial<ObserverState> = { label: info.label };
    if (info.zone && !sameZone(info.zone, o.zone)) patch.zone = info.zone;
    store.patch({ observer: patch });
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
    } else if (gazetteer) {
      patch.label = describeLocation(gazetteer, la, lo).text;
      labelledWithRegions = false;
    } else {
      patch.label = '';
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
  const markerEl = el('div', 'sfm-observer', { 'aria-hidden': 'true' });
  markerEl.append(el('span', 'sfm-observer-dot'));
  const marker = new Marker({ element: markerEl, draggable: true, anchor: 'center' })
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
  const readoutText = el('div', 'sfm-readout-text');
  const readoutButtons = el('div', 'sfm-readout-buttons');
  const clearBtn = el('button', 'sfm-textbtn', { type: 'button' });
  clearBtn.textContent = 'Clear';
  const doneBtn = el('button', 'sfm-textbtn', { type: 'button' });
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
    const title = el('p', 'sfm-readout-title');
    const units = store.get().settings.units;
    if (a && b) {
      const m = measureBetween(a, b);
      const t = measureText(m, units);
      title.textContent = 'From A to B';
      const gc = el('p', 'sfm-readout-line');
      gc.textContent = t.greatCircle;
      const rh = el('p', 'sfm-readout-line sfm-readout-line--rhumb');
      rh.textContent = t.rhumb;
      readoutText.append(title, gc, rh);
    } else {
      title.textContent = a ? 'Click the second point (B).' : 'Measure: click the first point (A).';
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
  function pick(lngLat: LngLat, point: { x: number; y: number }): void {
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
    // A click on a ground point selects that body.
    if (store.get().layers.groundPoints && map.getLayer(LAYER.groundPoints)) {
      const hits = map.queryRenderedFeatures(
        [
          [point.x - 7, point.y - 7],
          [point.x + 7, point.y + 7],
        ],
        { layers: [LAYER.groundPoints, LAYER.groundPointLabels] },
      );
      const body = hits[0]?.properties?.body;
      if (typeof body === 'string') {
        store.patch({ selection: { body } });
        live.textContent = `${body} selected.`;
        return;
      }
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
        const point = { x: start.x - rect.left, y: start.y - rect.top };
        pick(map.unproject([point.x, point.y]), point);
        navigator.vibrate?.(12);
      }, LONG_PRESS_MS),
    };
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (longPress && e.pointerId === longPress.id && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > 10) cancelLongPress();
  };
  mapEl.addEventListener('pointerdown', onPointerDown, true);
  mapEl.addEventListener('pointermove', onPointerMove, true);
  mapEl.addEventListener('pointerup', cancelLongPress, true);
  mapEl.addEventListener('pointercancel', cancelLongPress, true);
  const onContextMenu = (e: Event): void => {
    if (lastPointerType === 'touch') e.preventDefault();
  };
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
    if (lastPointerType === 'touch') return; // touch sets the place with a long press only
    pick(e.lngLat, e.point);
  });
  for (const layer of [LAYER.groundPoints, LAYER.groundPointLabels]) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }

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
   * On the globe, whether a location is on the far side: project it, read the map back at that
   * pixel, and compare (the front surface answers for a hidden point). Public API only.
   */
  function occluded(ll: LngLat, p: { x: number; y: number }): boolean {
    if (currentView !== 'globe') return false;
    const c = map.getContainer();
    if (p.x < -1e4 || p.y < -1e4 || p.x > c.clientWidth + 1e4 || p.y > c.clientHeight + 1e4) return true;
    const back = map.unproject([p.x, p.y]);
    return angularDistanceDeg({ lat_deg: back.lat, lon_deg: back.lng }, { lat_deg: ll.lat, lon_deg: ll.lng }) > 0.5;
  }

  function viewportContains(lat: number, lon: number, marginPx = 40): boolean {
    const ll = new LngLat(nearestCopy(lon), lat);
    const p = map.project(ll);
    if (occluded(ll, p)) return false;
    const c = map.getContainer();
    return p.x >= marginPx && p.y >= marginPx && p.x <= c.clientWidth - marginPx && p.y <= c.clientHeight - marginPx;
  }

  /** The longitude of the world copy nearest the map's centre (Mercator draws copies side by side). */
  function nearestCopy(lon: number): number {
    if (currentView === 'globe') return lon;
    const c = map.getCenter().lng;
    return lon + 360 * Math.round((c - lon) / 360);
  }

  function recentre(): void {
    const o = store.get().observer;
    const p = map.project(new LngLat(nearestCopy(o.lon_deg), o.lat_deg));
    const c = map.getContainer();
    const centred = Math.hypot(p.x - c.clientWidth / 2, p.y - c.clientHeight / 2) < 4;
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
    controls = createControls({
      zoomIn: () => map.zoomIn({ duration: duration(250) }),
      zoomOut: () => map.zoomOut({ duration: duration(250) }),
      recentre,
      placeAtCentre,
      toggleMeasure: () => toggleMeasure(),
      setProjection: (view) => store.patch({ view }),
      setLayer: (key: LayerKey, on: boolean) => store.patch({ layers: { [key]: on } }),
    });
    root.appendChild(controls.element);
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
    vis(LAYER_GROUPS.groundPoints, L.groundPoints);
    vis(LAYER_GROUPS.circles, L.circles);
    vis(LAYER_GROUPS.altitudeRings, L.altitudeRings);
    syncStreets(L.streets);
    syncScale(L.scaleBar, store.get().settings.units);
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
    attribution.hidden = !on;
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
      scale = new ScaleControl({ maxWidth: 120, unit: units });
      map.addControl(scale, 'bottom-left');
      scaleUnit = units;
    } else if (scaleUnit !== units) {
      scale.setUnit(units);
      scaleUnit = units;
    }
  }

  let graticuleKey = '';
  function syncGraticule(): void {
    if (!loaded || !store.get().layers.graticule) return;
    const c = map.getContainer();
    const zoom = map.getZoom();
    const span = Math.min(360, (360 * Math.max(c.clientWidth, 1)) / (512 * 2 ** zoom));
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
  const keys = { shade: '', terminator: '', gp: '', circle: '', rings: '' };
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
    const gpKey = sky && L.groundPoints ? `${sky.jd_utc}|${selected}|${v}` : 'off';
    if (gpKey !== keys.gp) {
      keys.gp = gpKey;
      setData(SRC.groundPoints, sky && L.groundPoints ? groundPointFeatures(sky.bodies, selected, tokens) : emptyCollection());
    }
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
    const [start, end] = currentDayWindow(s);
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
    const words: Record<string, string> = { rise: 'Rise', set: 'Set', transit: 'Highest' };
    const events: DialEvent[] = (bodyEvents?.events ?? [])
      .filter((e) => e.kind === 'rise' || e.kind === 'set' || e.kind === 'transit')
      .map((e) => ({ kind: e.kind as DialEvent['kind'], alt: e.alt_deg, az: e.az_deg, label: `${words[e.kind]} ${formatTime(e.jd_utc, zone)}` }));
    let note = '';
    if (bodyEvents?.always_above) note = body === 'Sun' ? 'Sun up all day (midnight Sun)' : `${body} up all day`;
    else if (bodyEvents?.always_below) note = body === 'Sun' ? 'Sun below the horizon all day (polar night)' : `${body} below the horizon all day`;
    const sun = kind === 'sun' && s.layers.paths ? solsticeData(s, zone) : null;
    summaryText = daySummary(body, events, note, s);
    return { body, kind, path, events, note, band: sun?.region ?? null, solstices: sun?.runs ?? [] };
  }

  function daySummary(body: string, events: DialEvent[], note: string, s: ExplorerState): string {
    if (note) return `${note}.`;
    const parts = events.map((e) =>
      e.kind === 'transit' ? `highest at ${e.label.split(' ').pop()} (${formatAngle(e.alt, s.settings.angleFormat)} up)` : `${e.label.toLowerCase()}, bearing ${formatBearing(e.az)}`,
    );
    return parts.length ? `${body} today: ${parts.join('; ')}.` : '';
  }

  function syncDial(s: ExplorerState, sky: SkyState | null): void {
    const L = s.layers;
    if (!L.compass) {
      dial.place(0, 0, 0, false);
      return;
    }
    const c = map.getContainer();
    dial.setRadius(compassRadius(c.clientWidth, c.clientHeight));
    const body = s.selection.body;
    const info = body ? sky?.bodies.find((b) => b.body === body) : undefined;
    const [start, end] = currentDayWindow(s);
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
    const s = store.get();
    if (!loaded || !s.layers.compass) {
      dial.place(0, 0, 0, false);
      return;
    }
    const o = s.observer;
    const ll = new LngLat(nearestCopy(o.lon_deg), o.lat_deg);
    const p = map.project(ll);
    const c = map.getContainer();
    const R = compassRadius(c.clientWidth, c.clientHeight);
    const visible = !occluded(ll, p) && p.x > -R && p.y > -R && p.x < c.clientWidth + R && p.y < c.clientHeight + R;
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
  function render(): void {
    if (!loaded || destroyed) return;
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
    controls?.update({ layers: s.layers, measuring: measuring.active, projection: currentView });
    if (measuring.active && measuring.a && measuring.b) syncMeasure();
  }

  // --- Theme --------------------------------------------------------------------------------
  d.add(
    onThemeChange(() => {
      tokens = readTokens();
      tokensVersion += 1;
      applyCssTokens(root, tokens);
      if (loaded) {
        restyle(map, tokens);
        overlays?.restyle();
        root.classList.toggle('sfm--red-streets', store.get().layers.streets && tokens.theme === 'night');
      }
      requestRender();
    }),
  );

  // --- Loading --------------------------------------------------------------------------------
  let overlays: OverlayDrawer | null = null;
  map.on('error', (e) => {
    const message = errorText((e as { error?: unknown }).error ?? e);
    console.warn('map:', message);
    notices.push('caution', `Map: some map data could not be loaded (${message}).`, { key: 'map-data' });
  });
  map.on('move', placeDial);
  map.on('moveend', syncGraticule);
  map.on('resize', () => {
    const c = map.getContainer();
    dial.setRadius(compassRadius(c.clientWidth, c.clientHeight));
    placeDial();
    graticuleKey = '';
    syncGraticule();
  });

  map.once('load', () => {
    if (destroyed) return;
    loaded = true;
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
    for (const [id, layer] of Object.entries(DEFERRED_SOURCES)) setData(id, basemapUrl(layer));
    loadGazetteer()
      .then((g) => {
        if (destroyed) return;
        gazetteer = g;
        setData(SRC.places, placesGeoJson(g) as FeatureCollection);
        relabelMapPosition();
        return loadRegionIndex().then((r) => {
          if (destroyed) return;
          regions = r;
          relabelMapPosition();
        });
      })
      .catch((error: unknown) => {
        notices.push('caution', `Map: place names could not be loaded (${errorText(error)}); positions are shown as coordinates.`, { key: 'map-places' });
      });
  });

  requestRender();
  return {
    destroy() {
      d.dispose();
    },
  };
}
