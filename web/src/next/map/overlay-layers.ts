/**
 * Draws the map service's overlays (overlays.ts) into a running MapLibre map: one GeoJSON
 * source and up to six layers per overlay, stacked by `z` under the ground points. OWNER:
 * map agent.
 */

import type { ExpressionSpecification, LayerSpecification, Map as MapLibreMap, GeoJSONSource, UpdateImageOptions } from 'maplibre-gl';
import { MAP_FONTS } from './fonts.js';
import type { MapServiceImpl, OverlayEntry, OverlayEvent, OverlayStyle } from './overlays.js';
import { LAYER } from './style.js';
import { lineDash, parseColor, tokenValue, type MapTokens } from './style-tokens.js';

type PaintName = Parameters<MapLibreMap['setPaintProperty']>[1];

const POLYGON: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
const POINT: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]];
const NOT_POINT: ExpressionSpecification = ['!', POINT];

const SUFFIXES = ['fill', 'casing', 'line', 'point', 'label-line', 'label-point', 'raster'] as const;

const sourceId = (id: string) => `ov:${id}`;
const layerId = (id: string, part: (typeof SUFFIXES)[number]) => `ov:${id}:${part}`;

/** A colour given as a token name, `var(--token)` or a CSS colour, for the current theme. */
export function resolveColor(spec: string | undefined, fallback: string): string {
  if (!spec) return fallback;
  const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec(spec)?.[1] ?? (spec.startsWith('--') ? spec : null);
  if (token) {
    const v = tokenValue(token);
    return parseColor(v) ? v : fallback;
  }
  return spec;
}

function resolveDash(spec: OverlayStyle['dash'], width: number): number[] | undefined {
  if (!spec || spec === 'solid') return undefined;
  if (Array.isArray(spec)) return lineDash(spec as number[], width);
  const text = tokenValue(spec as string);
  if (!text || text === 'none') return undefined;
  return lineDash(text.split(/[\s,]+/).map(Number).filter(Number.isFinite), width);
}

function overlayLayers(e: OverlayEntry, t: MapTokens): LayerSpecification[] {
  const s = e.style;
  const color = resolveColor(s.color, t.accent);
  const fill = resolveColor(s.fill, color);
  const width = s.width ?? 2;
  const casing = s.casing ?? true;
  const dash = resolveDash(s.dash, width);
  const src = sourceId(e.id);
  const layers: LayerSpecification[] = [];
  const fillOpacity = s.fillOpacity ?? 0.15;
  if (fillOpacity > 0) {
    layers.push({ id: layerId(e.id, 'fill'), type: 'fill', source: src, filter: POLYGON, paint: { 'fill-color': fill, 'fill-opacity': fillOpacity } });
  }
  if (casing) {
    layers.push({
      id: layerId(e.id, 'casing'),
      type: 'line',
      source: src,
      filter: NOT_POINT,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': t.lineHalo, 'line-width': width + 2.5, 'line-opacity': 0.55 },
    });
  }
  layers.push({
    id: layerId(e.id, 'line'),
    type: 'line',
    source: src,
    filter: NOT_POINT,
    layout: { 'line-join': 'round', 'line-cap': dash ? 'butt' : 'round' },
    paint: { 'line-color': color, 'line-width': width, ...(dash ? { 'line-dasharray': dash } : {}) },
  });
  layers.push({
    id: layerId(e.id, 'point'),
    type: 'circle',
    source: src,
    filter: POINT,
    paint: {
      'circle-radius': s.pointRadius ?? 5,
      'circle-color': color,
      'circle-stroke-color': t.lineHalo,
      'circle-stroke-width': casing ? 1.5 : 0,
    },
  });
  if (s.labelProperty) {
    const text: ExpressionSpecification = ['to-string', ['get', s.labelProperty]];
    const paint = { 'text-color': t.stageInk, 'text-halo-color': t.labelHalo, 'text-halo-width': 1.6 };
    layers.push({
      id: layerId(e.id, 'label-line'),
      type: 'symbol',
      source: src,
      filter: NOT_POINT,
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 360, 'text-field': text, 'text-font': [...MAP_FONTS.semibold], 'text-size': 11, 'text-offset': [0, -0.9] },
      paint,
    });
    layers.push({
      id: layerId(e.id, 'label-point'),
      type: 'symbol',
      source: src,
      filter: POINT,
      layout: { 'text-field': text, 'text-font': [...MAP_FONTS.semibold], 'text-size': 11, 'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 0.8 },
      paint,
    });
  }
  return layers;
}

export class OverlayDrawer {
  private readonly drawn = new Map<string, { styleKey: string }>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly map: MapLibreMap,
    private readonly service: MapServiceImpl,
    private readonly tokens: () => MapTokens,
  ) {
    this.unsubscribe = service.subscribe((e) => this.onEvent(e));
    for (const entry of service.overlays()) this.draw(entry);
  }

  /** Recolour after a theme change. */
  restyle(): void {
    for (const entry of this.service.overlays()) {
      // A raster's colours are in its pixels; its publisher redraws it for a new theme.
      if (entry.image) continue;
      for (const layer of overlayLayers(entry, this.tokens())) {
        if (!this.map.getLayer(layer.id) || !('paint' in layer) || !layer.paint) continue;
        for (const [k, v] of Object.entries(layer.paint)) this.map.setPaintProperty(layer.id, k as PaintName, v);
      }
    }
  }

  destroy(): void {
    this.unsubscribe();
  }

  private onEvent(e: OverlayEvent): void {
    if (e.kind === 'remove') this.remove(e.id);
    else this.draw(e.entry);
  }

  private remove(id: string): void {
    for (const part of SUFFIXES) if (this.map.getLayer(layerId(id, part))) this.map.removeLayer(layerId(id, part));
    if (this.map.getSource(sourceId(id))) this.map.removeSource(sourceId(id));
    this.drawn.delete(id);
  }

  private draw(entry: OverlayEntry): void {
    if (entry.image) {
      this.drawImage(entry, entry.image);
      return;
    }
    const styleKey = JSON.stringify(entry.style);
    const existing = this.drawn.get(entry.id);
    const source = this.map.getSource(sourceId(entry.id)) as GeoJSONSource | undefined;
    if (existing && existing.styleKey === styleKey && source) {
      source.setData(entry.data);
      return;
    }
    this.remove(entry.id);
    this.map.addSource(sourceId(entry.id), { type: 'geojson', data: entry.data, tolerance: 0.3 });
    const before = this.beforeId(entry.id);
    for (const layer of overlayLayers(entry, this.tokens())) this.map.addLayer(layer, before);
    this.drawn.set(entry.id, { styleKey });
  }

  /** An image overlay: one image source and one raster layer (addition by the misfit agent). */
  private drawImage(entry: OverlayEntry, image: NonNullable<OverlayEntry['image']>): void {
    const styleKey = JSON.stringify({ raster: true, ...entry.style, opacity: image.opacity });
    const source = this.map.getSource(sourceId(entry.id)) as { updateImage?: (o: UpdateImageOptions) => unknown } | undefined;
    if (this.drawn.get(entry.id)?.styleKey === styleKey && typeof source?.updateImage === 'function') {
      source.updateImage({ url: image.url, coordinates: image.coordinates });
      return;
    }
    this.remove(entry.id);
    this.map.addSource(sourceId(entry.id), { type: 'image', url: image.url, coordinates: image.coordinates });
    this.map.addLayer(
      {
        id: layerId(entry.id, 'raster'),
        type: 'raster',
        source: sourceId(entry.id),
        paint: { 'raster-opacity': image.opacity ?? 0.7, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
      },
      this.beforeId(entry.id),
    );
    this.drawn.set(entry.id, { styleKey });
  }

  /** The first layer of the next overlay above this one that is drawn, else the ground points. */
  private beforeId(id: string): string {
    const order = this.service.overlays().map((e) => e.id);
    for (let i = order.indexOf(id) + 1; i < order.length; i++) {
      const next = order[i]!;
      if (!this.drawn.has(next)) continue;
      for (const part of SUFFIXES) if (this.map.getLayer(layerId(next, part))) return layerId(next, part);
    }
    return LAYER.overlaysBefore;
  }
}
