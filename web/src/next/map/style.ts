/**
 * The map's MapLibre style, built in code from the offline Natural Earth files and the
 * theme's tokens. OWNER: map agent.
 *
 * Sources are GeoJSON under data/basemap/ (web/public/data, Natural Earth, public domain;
 * see geo/basemap.ts), the gazetteer's places, and the map's own live layers (terminator and
 * twilight, ground points, circles, measuring lines). The optional street layer is an
 * OpenStreetMap raster source added only while `layers.streets` is on.
 *
 * Natural Earth's `minzoom` values are for 256-pixel tiles, one level above MapLibre's
 * 512-pixel zoom, so a feature is shown when `minzoom <= zoom + 1`.
 *
 * Draw order (bottom to top): water, land, ice, built-up areas, lakes, rivers, coasts,
 * borders, [streets], day/night and twilight shading, graticule and reference lines,
 * terminator, place and sea labels, altitude rings, circle of equal altitude, [overlays
 * from other views], ground points, measuring lines.
 */

import type { FeatureCollection } from 'geojson';
import type {
  ExpressionSpecification,
  LayerSpecification,
  Map as MapLibreMap,
  RasterLayerSpecification,
  RasterSourceSpecification,
  SourceSpecification,
  StyleSpecification,
} from 'maplibre-gl';
import { basemapUrl, type BasemapLayer } from '../geo/basemap.js';
import { MAP_FONTS } from './fonts.js';
import { emptyCollection } from './geometry.js';
import { lineDash, withAlpha, type MapTokens } from './style-tokens.js';


/** Source ids. */
export const SRC = {
  land110: 'bm-land110',
  coast110: 'bm-coast110',
  land50: 'bm-land50',
  coast50: 'bm-coast50',
  lakes: 'bm-lakes',
  rivers: 'bm-rivers',
  boundaries: 'bm-boundaries',
  urban: 'bm-urban',
  glaciers: 'bm-glaciers',
  iceShelves: 'bm-ice-shelves',
  geolines: 'bm-geolines',
  marine: 'bm-marine',
  physical: 'bm-physical',
  places: 'places',
  graticule: 'graticule',
  shade: 'shade',
  terminator: 'terminator',
  groundPoints: 'ground-points',
  equalAltitude: 'equal-altitude',
  rings: 'altitude-rings',
  measure: 'measure',
  streets: 'streets',
} as const;

/** Basemap files loaded with the style (small, for the first picture). */
const INITIAL: Partial<Record<string, BasemapLayer>> = {
  [SRC.land110]: 'land110m',
  [SRC.coast110]: 'coastline110m',
  [SRC.marine]: 'marineLabels',
  [SRC.physical]: 'physicalLabels',
  [SRC.geolines]: 'geolines',
};

/** Basemap files loaded once the first picture is on screen (about 3.5 MB, 1 MB gzipped). */
export const DEFERRED_SOURCES: Readonly<Record<string, BasemapLayer>> = {
  [SRC.land50]: 'land50m',
  [SRC.coast50]: 'coastline50m',
  [SRC.lakes]: 'lakes',
  [SRC.rivers]: 'rivers',
  [SRC.boundaries]: 'boundaries',
  [SRC.urban]: 'urban',
  [SRC.glaciers]: 'glaciers',
  [SRC.iceShelves]: 'iceShelves',
};

/** Below this zoom the 1:110m land and coast are drawn, above it the 1:50m ones. */
export const DETAIL_ZOOM = 2;

/** Layer ids other code refers to. */
export const LAYER = {
  /** The street layer goes under everything the map draws on top of the basemap. */
  streetsBefore: 'shade',
  /** Overlays from other views go under the ground points and the measuring lines. */
  overlaysBefore: 'gp-halo',
  groundPoints: 'gp-circle',
  groundPointLabels: 'gp-label',
} as const;

/** Which layers each `layers.*` switch shows. */
export const LAYER_GROUPS = {
  shade: ['shade'],
  terminator: ['terminator'],
  graticule: ['graticule', 'graticule-label', 'geolines', 'geolines-label'],
  groundPoints: ['gp-halo', 'gp-circle', 'gp-label'],
  circles: ['equal-altitude-halo', 'equal-altitude', 'equal-altitude-label'],
  altitudeRings: ['rings', 'rings-label'],
} as const;

function geojson(data: FeatureCollection | string, maxzoom = 10): SourceSpecification {
  return { type: 'geojson', data, maxzoom, tolerance: 0.45, buffer: 64 };
}

/** Natural Earth's zoom for 256-pixel tiles against MapLibre's: shown when minzoom <= zoom + 1. */
function byMinzoom(slack = 1): ExpressionSpecification {
  return ['<=', ['get', 'minzoom'], ['+', ['zoom'], slack]];
}

export interface StyleOptions {
  projection: 'mercator' | 'globe';
}

export function buildSources(pageUrl?: string): Record<string, SourceSpecification> {
  const out: Record<string, SourceSpecification> = {};
  for (const id of Object.values(SRC)) {
    if (id === SRC.streets) continue;
    const initial = INITIAL[id];
    const maxzoom = id.startsWith('bm-') || id === SRC.places ? 9 : 12;
    out[id] = geojson(initial ? basemapUrl(initial, pageUrl) : emptyCollection(), maxzoom);
  }
  return out;
}

const lineWidth = (at2: number, at8: number): ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], 2, at2, 8, at8];

/** Every layer, coloured for `t`. Rebuilt on theme change and applied with `restyle`. */
export function buildLayers(t: MapTokens): LayerSpecification[] {
  const halo = t.lineHalo;
  const labelFont = [...MAP_FONTS.regular];
  const labelBold = [...MAP_FONTS.semibold];
  const italic = [...MAP_FONTS.italic];
  return [
    { id: 'background', type: 'background', paint: { 'background-color': t.water } },
    { id: 'land-110', type: 'fill', source: SRC.land110, maxzoom: DETAIL_ZOOM, paint: { 'fill-color': t.land, 'fill-antialias': true } },
    { id: 'land-50', type: 'fill', source: SRC.land50, minzoom: DETAIL_ZOOM, paint: { 'fill-color': t.land, 'fill-antialias': true } },
    { id: 'glaciers', type: 'fill', source: SRC.glaciers, paint: { 'fill-color': t.ice, 'fill-antialias': false } },
    { id: 'ice-shelves', type: 'fill', source: SRC.iceShelves, paint: { 'fill-color': t.ice, 'fill-opacity': 0.85, 'fill-antialias': false } },
    { id: 'urban', type: 'fill', source: SRC.urban, minzoom: 3.5, filter: byMinzoom(1.5), paint: { 'fill-color': t.urban, 'fill-antialias': false } },
    { id: 'lakes', type: 'fill', source: SRC.lakes, minzoom: 1.5, paint: { 'fill-color': t.water, 'fill-outline-color': withAlpha(t.coast, 0.8) } },
    {
      id: 'rivers',
      type: 'line',
      source: SRC.rivers,
      minzoom: 2,
      filter: byMinzoom(1),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': t.river, 'line-width': lineWidth(0.5, 1.6) },
    },
    { id: 'coast-110', type: 'line', source: SRC.coast110, maxzoom: DETAIL_ZOOM, paint: { 'line-color': t.coast, 'line-width': 0.7 } },
    { id: 'coast-50', type: 'line', source: SRC.coast50, minzoom: DETAIL_ZOOM, paint: { 'line-color': t.coast, 'line-width': lineWidth(0.7, 1.3) } },
    {
      id: 'boundaries',
      type: 'line',
      source: SRC.boundaries,
      minzoom: 1,
      filter: ['==', ['get', 'kind'], 'international'],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': t.border, 'line-width': lineWidth(0.6, 1.4) },
    },
    {
      id: 'boundaries-other',
      type: 'line',
      source: SRC.boundaries,
      minzoom: 1,
      filter: ['!=', ['get', 'kind'], 'international'],
      paint: { 'line-color': t.border, 'line-width': lineWidth(0.6, 1.4), 'line-dasharray': [3, 2] },
    },
    // Day, night and twilight: stacked translucent caps (geometry.ts twilightFeatures).
    {
      id: 'shade',
      type: 'fill',
      source: SRC.shade,
      paint: { 'fill-color': t.shade, 'fill-opacity': ['get', 'alpha'], 'fill-antialias': false },
    },
    {
      id: 'graticule',
      type: 'line',
      source: SRC.graticule,
      paint: { 'line-color': t.graticule, 'line-width': ['case', ['get', 'major'], 1.1, 0.7] },
    },
    {
      id: 'graticule-label',
      type: 'symbol',
      source: SRC.graticule,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 420,
        'text-field': ['get', 'label'],
        'text-font': labelFont,
        'text-size': 10.5,
        'text-letter-spacing': 0.04,
        'text-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': t.labelInk, 'text-halo-color': t.labelHalo, 'text-halo-width': 1.2, 'text-opacity': 0.85 },
    },
    {
      id: 'geolines',
      type: 'line',
      source: SRC.geolines,
      paint: { 'line-color': withAlpha(t.labelInk, 0.45), 'line-width': 1, 'line-dasharray': [4, 3] },
    },
    {
      id: 'geolines-label',
      type: 'symbol',
      source: SRC.geolines,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 600,
        'text-field': ['get', 'name'],
        'text-font': italic,
        'text-size': 10.5,
        'text-letter-spacing': 0.05,
      },
      paint: { 'text-color': t.labelInk, 'text-halo-color': t.labelHalo, 'text-halo-width': 1.2, 'text-opacity': 0.9 },
    },
    {
      id: 'terminator',
      type: 'line',
      source: SRC.terminator,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': withAlpha(t.stageInk2, t.theme === 'light' ? 0.55 : 0.7), 'line-width': 1.2 },
    },
    {
      id: 'places-dot',
      type: 'circle',
      source: SRC.places,
      filter: byMinzoom(1),
      paint: {
        'circle-radius': ['case', ['==', ['get', 'capital'], 2], 3, 2.2],
        'circle-color': t.labelInk,
        'circle-stroke-color': t.labelHalo,
        'circle-stroke-width': 1,
      },
    },
    {
      id: 'places-label',
      type: 'symbol',
      source: SRC.places,
      filter: byMinzoom(1),
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['case', ['any', ['==', ['get', 'capital'], 2], ['<=', ['get', 'minzoom'], 3]], ['literal', labelBold], ['literal', labelFont]],
        'text-size': ['case', ['==', ['get', 'capital'], 2], 12.5, ['<=', ['get', 'minzoom'], 4], 12, 11],
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
        'text-radial-offset': 0.55,
        'text-justify': 'auto',
        'text-max-width': 8,
        'symbol-sort-key': ['-', 0, ['get', 'population']],
        'text-padding': 3,
      },
      paint: { 'text-color': t.labelInk, 'text-halo-color': t.labelHalo, 'text-halo-width': 1.4 },
    },
    {
      id: 'marine-label',
      type: 'symbol',
      source: SRC.marine,
      filter: byMinzoom(1),
      layout: {
        'text-field': ['get', 'name'],
        'text-font': italic,
        'text-size': ['match', ['get', 'kind'], 'ocean', 14, 'sea', 12, 11],
        'text-letter-spacing': ['match', ['get', 'kind'], 'ocean', 0.18, 0.08],
        'text-max-width': 7,
        'symbol-sort-key': ['get', 'rank'],
        'text-padding': 4,
      },
      paint: { 'text-color': t.waterInk, 'text-halo-color': t.waterHalo, 'text-halo-width': 1 },
    },
    {
      id: 'physical-label',
      type: 'symbol',
      source: SRC.physical,
      filter: byMinzoom(0.5),
      layout: {
        'text-field': ['get', 'name'],
        'text-font': italic,
        'text-size': 10.5,
        'text-max-width': 7,
        'symbol-sort-key': ['get', 'rank'],
        'text-optional': true,
      },
      paint: { 'text-color': t.labelInk, 'text-halo-color': t.labelHalo, 'text-halo-width': 1.2, 'text-opacity': 0.9 },
    },
    // Altitude rings round the selected body's ground point.
    {
      id: 'rings',
      type: 'line',
      source: SRC.rings,
      paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.7, 'line-dasharray': [1.5, 2.5] },
    },
    {
      id: 'rings-label',
      type: 'symbol',
      source: SRC.rings,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 300,
        'text-field': ['get', 'label'],
        'text-font': labelBold,
        'text-size': 10.5,
      },
      paint: { 'text-color': t.stageInk, 'text-halo-color': t.labelHalo, 'text-halo-width': 1.4 },
    },
    // Where the selected body stands at the same altitude as at the observer now.
    {
      id: 'equal-altitude-halo',
      type: 'line',
      source: SRC.equalAltitude,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': halo, 'line-width': 4.2, 'line-opacity': 0.55 },
    },
    {
      id: 'equal-altitude',
      type: 'line',
      source: SRC.equalAltitude,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2, ...dashPaint(t.dash.circle, 2) },
    },
    {
      id: 'equal-altitude-label',
      type: 'symbol',
      source: SRC.equalAltitude,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 480,
        'text-field': ['get', 'label'],
        'text-font': labelBold,
        'text-size': 11,
        'text-offset': [0, -0.9],
      },
      paint: { 'text-color': t.stageInk, 'text-halo-color': t.labelHalo, 'text-halo-width': 1.6 },
    },
    // Ground points of the bodies.
    {
      id: 'gp-halo',
      type: 'circle',
      source: SRC.groundPoints,
      filter: ['==', ['get', 'selected'], true],
      paint: { 'circle-radius': ['+', ['get', 'radius'], 4.5], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': t.accent, 'circle-stroke-width': 2 },
    },
    {
      id: 'gp-circle',
      type: 'circle',
      source: SRC.groundPoints,
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': halo,
        'circle-stroke-width': 1.5,
      },
    },
    {
      id: 'gp-label',
      type: 'symbol',
      source: SRC.groundPoints,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': labelBold,
        'text-size': 11.5,
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
        'text-radial-offset': 0.9,
        'text-allow-overlap': false,
        'symbol-sort-key': ['get', 'order'],
      },
      paint: { 'text-color': t.stageInk, 'text-halo-color': t.labelHalo, 'text-halo-width': 1.6 },
    },
    // The measuring tool.
    {
      id: 'measure-halo',
      type: 'line',
      source: SRC.measure,
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': halo, 'line-width': 4.5, 'line-opacity': 0.6 },
    },
    {
      id: 'measure-gc',
      type: 'line',
      source: SRC.measure,
      filter: ['==', ['get', 'kind'], 'great-circle'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': t.accent, 'line-width': 2.4 },
    },
    {
      id: 'measure-rhumb',
      type: 'line',
      source: SRC.measure,
      filter: ['==', ['get', 'kind'], 'rhumb'],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': t.accent, 'line-width': 2, 'line-dasharray': [3, 2] },
    },
    {
      id: 'measure-label',
      type: 'symbol',
      source: SRC.measure,
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: {
        'symbol-placement': 'line-center',
        'text-field': ['get', 'label'],
        'text-font': labelBold,
        'text-size': 11,
        'text-offset': [0, -0.9],
      },
      paint: { 'text-color': t.stageInk, 'text-halo-color': t.labelHalo, 'text-halo-width': 1.6 },
    },
    {
      id: 'measure-points',
      type: 'circle',
      source: SRC.measure,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': t.accent, 'circle-stroke-color': halo, 'circle-stroke-width': 1.5 },
    },
  ];
}

function dashPaint(pattern: readonly number[], width: number): { 'line-dasharray'?: number[] } {
  const d = lineDash(pattern, width);
  return d ? { 'line-dasharray': d } : {};
}

type PaintName = Parameters<MapLibreMap['setPaintProperty']>[1];
type PaintValue = Parameters<MapLibreMap['setPaintProperty']>[2];

/** Recolour a running map for new tokens (theme change): every paint property is set again. */
export function restyle(map: MapLibreMap, t: MapTokens): void {
  for (const layer of buildLayers(t)) {
    if (!map.getLayer(layer.id)) continue;
    const paint = (layer as { paint?: Record<string, unknown> }).paint;
    if (!paint) continue;
    for (const [key, value] of Object.entries(paint)) map.setPaintProperty(layer.id, key as PaintName, value as PaintValue);
  }
  if (map.getLayer(SRC.streets)) {
    for (const [key, value] of Object.entries(streetsPaint(t))) map.setPaintProperty(SRC.streets, key as PaintName, value);
  }
}

export function buildStyle(t: MapTokens, opts: StyleOptions, pageUrl?: string): StyleSpecification {
  return {
    version: 8,
    name: 'SkyFix Lab offline world',
    projection: { type: opts.projection },
    sky: { 'atmosphere-blend': 0 },
    sources: buildSources(pageUrl),
    layers: buildLayers(t),
  };
}

// ---------------------------------------------------------------------------------------
// The optional OpenStreetMap layer (EXPLORER_PLAN 3.4: off by default, attributed while
// shown, no bulk caching; OSMF tile usage policy)

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

export function streetsSource(): RasterSourceSpecification {
  return {
    type: 'raster',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 19,
  };
}

export function streetsLayer(t: MapTokens): RasterLayerSpecification {
  return { id: SRC.streets, type: 'raster', source: SRC.streets, paint: streetsPaint(t) };
}

/** Raster adjustments per theme; night also gets a red-only filter on the canvas (map.css). */
export function streetsPaint(t: MapTokens): NonNullable<RasterLayerSpecification['paint']> {
  switch (t.theme) {
    case 'light':
      return { 'raster-opacity': 0.92, 'raster-saturation': -0.15, 'raster-brightness-max': 1, 'raster-brightness-min': 0, 'raster-contrast': 0 };
    case 'dark':
      return { 'raster-opacity': 0.85, 'raster-saturation': -0.55, 'raster-brightness-max': 0.62, 'raster-brightness-min': 0, 'raster-contrast': 0.1 };
    case 'night':
      return { 'raster-opacity': 0.8, 'raster-saturation': -1, 'raster-brightness-max': 0.5, 'raster-brightness-min': 0, 'raster-contrast': 0 };
  }
}
