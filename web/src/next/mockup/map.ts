/**
 * DESIGN MOCKUP: a real MapLibre map of Natural Earth's 110 m land and lakes (public
 * domain, `web/next/mockup-assets/`), with twilight shading and ground points. The map
 * agent builds the real map (`src/next/map/`) on the map-data agent's basemap; this is
 * only here so the mockup shows a real map in each theme.
 *
 * The shading is computed from the Sun's ground point in the mockup data, one pixel at a
 * time, with exactly the bands of CONVENTIONS 13.4 (-50′, -6°, -12°, -18°).
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import { Map as MapLibre, Marker, setWorkerUrl, type ImageSource, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import bordersUrl from '../../../next/mockup-assets/ne_110m_admin_0_boundary_lines_land.geojson?url';
import lakesUrl from '../../../next/mockup-assets/ne_110m_lakes.geojson?url';
import landUrl from '../../../next/mockup-assets/ne_110m_land.geojson?url';
import { tokenColor, tokenNumber, parseColor } from '../theme/tokens.js';

setWorkerUrl(workerUrl);

const MERC_LAT = 85.051129;

export interface MockMapOptions {
  container: HTMLElement;
  center: [number, number];
  zoom: number;
  /** The Sun's ground point, [lat, lon]. */
  subsolar: [number, number];
  padding?: { top?: number; bottom?: number; left?: number; right?: number };
}

export interface MockMap {
  map: MapLibre;
  /** Re-read the theme tokens (after `data-theme` changed). */
  restyle(): void;
  addMarker(lngLat: [number, number], element: HTMLElement): Marker;
  ready: Promise<void>;
}

/** Twilight shading as an RGBA image over the whole Web Mercator square. */
function shadingImage(subsolar: [number, number], width = 1536, height = 1536): ImageData {
  const shade = parseColor(tokenColor('--map-shade', '#000000')) ?? [0, 0, 0, 1];
  const alphas = [
    tokenNumber('--shade-civil', 0.1),
    tokenNumber('--shade-nautical', 0.2),
    tokenNumber('--shade-astronomical', 0.3),
    tokenNumber('--shade-night', 0.4),
  ];
  const thresholds = [-50 / 60, -6, -12, -18];
  const steps = alphas.map((a, i) => a - (i ? alphas[i - 1]! : 0));
  const img = new ImageData(width, height);
  const data = img.data;
  const d2r = Math.PI / 180;
  const sd = Math.sin(subsolar[0] * d2r);
  const cd = Math.cos(subsolar[0] * d2r);
  const cosDl = new Float64Array(width);
  for (let x = 0; x < width; x += 1) {
    const lon = ((x + 0.5) / width) * 360 - 180;
    cosDl[x] = Math.cos((lon - subsolar[1]) * d2r);
  }
  const w = 0.14; // half-width of the anti-aliased band edge, degrees
  for (let y = 0; y < height; y += 1) {
    const my = Math.PI * (1 - (2 * (y + 0.5)) / height);
    const lat = Math.atan(Math.sinh(my));
    const sl = Math.sin(lat);
    const cl = Math.cos(lat);
    for (let x = 0; x < width; x += 1) {
      const hDeg = Math.asin(Math.max(-1, Math.min(1, sl * sd + cl * cd * cosDl[x]!))) / d2r;
      let a = 0;
      for (let i = 0; i < 4; i += 1) {
        const t = (thresholds[i]! - hDeg) / w; // > 0 below the threshold
        const s = t <= -1 ? 0 : t >= 1 ? 1 : 0.5 + 0.75 * t - 0.25 * t * t * t;
        a += steps[i]! * s;
      }
      const o = (y * width + x) * 4;
      data[o] = shade[0];
      data[o + 1] = shade[1];
      data[o + 2] = shade[2];
      data[o + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  return img;
}

function shadingDataUrl(subsolar: [number, number]): string {
  const img = shadingImage(subsolar);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

function style(subsolar: [number, number]): StyleSpecification {
  return {
    version: 8,
    sources: {
      land: { type: 'geojson', data: landUrl },
      lakes: { type: 'geojson', data: lakesUrl },
      borders: { type: 'geojson', data: bordersUrl },
      shading: {
        type: 'image',
        url: shadingDataUrl(subsolar),
        coordinates: [
          [-180, MERC_LAT],
          [180, MERC_LAT],
          [180, -MERC_LAT],
          [-180, -MERC_LAT],
        ],
      },
    },
    layers: [
      { id: 'water', type: 'background', paint: { 'background-color': tokenColor('--map-water') } },
      { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': tokenColor('--map-land'), 'fill-antialias': true } },
      { id: 'lakes', type: 'fill', source: 'lakes', paint: { 'fill-color': tokenColor('--map-water') } },
      {
        id: 'borders',
        type: 'line',
        source: 'borders',
        paint: { 'line-color': tokenColor('--map-border'), 'line-width': 0.8 },
      },
      {
        id: 'coast',
        type: 'line',
        source: 'land',
        paint: { 'line-color': tokenColor('--map-coast'), 'line-width': 0.9 },
      },
      {
        id: 'lake-shore',
        type: 'line',
        source: 'lakes',
        paint: { 'line-color': tokenColor('--map-coast'), 'line-width': 0.7 },
      },
      {
        id: 'shading',
        type: 'raster',
        source: 'shading',
        paint: { 'raster-opacity': 1, 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
      },
    ],
  };
}

export function createMockMap(options: MockMapOptions): MockMap {
  const map = new MapLibre({
    container: options.container,
    style: style(options.subsolar),
    center: options.center,
    zoom: options.zoom,
    minZoom: 0.8,
    maxZoom: 6,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    fadeDuration: 0,
    renderWorldCopies: true,
  });
  map.touchZoomRotate.disableRotation();
  if (options.padding) map.setPadding({ top: 0, bottom: 0, left: 0, right: 0, ...options.padding });

  const ready = new Promise<void>((resolve) => {
    map.once('idle', () => resolve());
  });

  return {
    map,
    ready,
    addMarker(lngLat, element) {
      return new Marker({ element, anchor: 'center' }).setLngLat(lngLat).addTo(map);
    },
    restyle() {
      if (!map.isStyleLoaded()) {
        map.once('idle', () => this.restyle());
        return;
      }
      map.setPaintProperty('water', 'background-color', tokenColor('--map-water'));
      map.setPaintProperty('land', 'fill-color', tokenColor('--map-land'));
      map.setPaintProperty('lakes', 'fill-color', tokenColor('--map-water'));
      map.setPaintProperty('borders', 'line-color', tokenColor('--map-border'));
      map.setPaintProperty('coast', 'line-color', tokenColor('--map-coast'));
      map.setPaintProperty('lake-shore', 'line-color', tokenColor('--map-coast'));
      const source = map.getSource<ImageSource>('shading');
      source?.updateImage({ url: shadingDataUrl(options.subsolar) });
    },
  };
}
