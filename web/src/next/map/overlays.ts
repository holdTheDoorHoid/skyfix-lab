/**
 * The map service: how other views draw on the map (eclipse paths from Events; circles of
 * position and the fix ellipse from Navigate) and move its camera. OWNER: map agent. See
 * map/README.md for the contract.
 *
 * One service per page, found from the page's `Ctx` with `mapServiceFor(ctx)`. It exists
 * whether or not a map is on screen: overlays added while the map view is hidden are kept
 * and drawn when it mounts, and camera requests made with no map are remembered and applied
 * when one mounts.
 */

import type { Feature, FeatureCollection, GeoJSON, Geometry, MultiLineString, MultiPolygon, Point } from 'geojson';
import type { Ctx } from '../component.js';
import type { LatLonDeg } from '../engine/types.js';
import { capPolygon, circleLine, ellipseRing, polygonPieces, splitLine, wrapLon } from './geometry.js';

export interface OverlayStyle {
  /**
   * Line and point colour: a design token (`'--body-moon'`, `'var(--event-set)'`) or any CSS
   * colour. Tokens follow the theme. Default `'--accent'`.
   */
  color?: string;
  /** Line width, pixels. Default 2. */
  width?: number;
  /** A dash token (`'--dash-circle'`), dash lengths in pixels, or `'solid'` (default). */
  dash?: string | readonly number[];
  /** Polygon fill colour, same forms as `color`. Default: the line colour. */
  fill?: string;
  /** Polygon fill opacity, 0-1. Default 0.15; 0 draws outlines only. */
  fillOpacity?: number;
  /** Radius of Point features, pixels. Default 5. */
  pointRadius?: number;
  /** Feature property whose value labels the feature (along lines, beside points). */
  labelProperty?: string;
  /** Dark casing under lines and points so they read on any map colour. Default true. */
  casing?: boolean;
  /** Stacking among overlays: higher is drawn on top. Default 0. */
  z?: number;
}

export interface OverlayEntry {
  readonly id: string;
  readonly data: FeatureCollection;
  readonly style: Readonly<OverlayStyle>;
  /** Increases on every change, so a drawer can tell a replaced overlay from an unchanged one. */
  readonly revision: number;
}

export type OverlayEvent = { kind: 'set'; entry: OverlayEntry } | { kind: 'remove'; id: string };

export interface CameraRequest {
  kind: 'fly' | 'fit';
  position?: LatLonDeg;
  zoom?: number;
  /** [west, south, east, north] */
  bounds?: [number, number, number, number];
  padding?: number;
  maxZoom?: number;
}

/** What the mounted map does with camera requests. */
export interface MapCamera {
  apply(request: CameraRequest): void;
}

export interface MapService {
  /** Draw (or replace) an overlay. `id`: letters, digits, `-` and `_`. */
  addOverlay(id: string, data: GeoJSON, style?: OverlayStyle): void;
  removeOverlay(id: string): void;
  hasOverlay(id: string): boolean;
  /** Current overlays, bottom to top. */
  overlays(): readonly OverlayEntry[];
  /** Move the map so the whole overlay is in view (on the next mount if no map is shown). */
  fitOverlay(id: string, options?: { padding?: number; maxZoom?: number }): void;
  /** Centre the map on a position (and zoom, if given). */
  flyTo(position: LatLonDeg, zoom?: number): void;
  /** Called on every overlay change. */
  subscribe(listener: (event: OverlayEvent) => void): () => void;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Any GeoJSON object as a FeatureCollection (a copy of the outer structure only). */
export function toFeatureCollection(data: GeoJSON): FeatureCollection {
  switch (data.type) {
    case 'FeatureCollection':
      return { type: 'FeatureCollection', features: [...data.features] };
    case 'Feature':
      return { type: 'FeatureCollection', features: [data] };
    default:
      return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: data as Geometry }] };
  }
}

/** Bounds [west, south, east, north] of a collection, taking the short way across the antimeridian. */
export function collectionBounds(fc: FeatureCollection): [number, number, number, number] | null {
  const lons: number[] = [];
  let south = Infinity;
  let north = -Infinity;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      lons.push(wrapLon(c[0]));
      south = Math.min(south, c[1]);
      north = Math.max(north, c[1]);
      return;
    }
    for (const x of c) visit(x);
  };
  const geom = (g: Geometry | null): void => {
    if (!g) return;
    if (g.type === 'GeometryCollection') g.geometries.forEach(geom);
    else visit(g.coordinates);
  };
  for (const f of fc.features) geom(f.geometry);
  if (!lons.length) return null;
  // The smallest arc of longitude containing every point: cut at the widest empty gap.
  const sorted = [...new Set(lons)].sort((a, b) => a - b);
  let gap = 360 - (sorted[sorted.length - 1]! - sorted[0]!);
  let west = sorted[0]!;
  let east = sorted[sorted.length - 1]!;
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i]! - sorted[i - 1]!;
    if (g > gap) {
      gap = g;
      west = sorted[i]!;
      east = sorted[i - 1]! + 360;
    }
  }
  return [west, south, east, north];
}

export class MapServiceImpl implements MapService {
  private readonly entries = new Map<string, OverlayEntry>();
  private readonly order: string[] = [];
  private readonly listeners = new Set<(event: OverlayEvent) => void>();
  private camera: MapCamera | null = null;
  private pending: CameraRequest | null = null;
  private revision = 0;

  addOverlay(id: string, data: GeoJSON, style: OverlayStyle = {}): void {
    if (!ID.test(id)) throw new Error(`overlay id ${JSON.stringify(id)}: use 1-64 letters, digits, '-' or '_'`);
    if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') {
      throw new Error(`overlay ${id}: expected GeoJSON`);
    }
    const entry: OverlayEntry = { id, data: toFeatureCollection(data), style: { ...style }, revision: ++this.revision };
    if (!this.entries.has(id)) this.order.push(id);
    this.entries.set(id, entry);
    this.emit({ kind: 'set', entry });
  }

  removeOverlay(id: string): void {
    if (!this.entries.delete(id)) return;
    this.order.splice(this.order.indexOf(id), 1);
    this.emit({ kind: 'remove', id });
  }

  hasOverlay(id: string): boolean {
    return this.entries.has(id);
  }

  overlays(): readonly OverlayEntry[] {
    const list = this.order.map((id) => this.entries.get(id)!);
    return list
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (a.e.style.z ?? 0) - (b.e.style.z ?? 0) || a.i - b.i)
      .map(({ e }) => e);
  }

  fitOverlay(id: string, options: { padding?: number; maxZoom?: number } = {}): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const bounds = collectionBounds(entry.data);
    if (!bounds) return;
    this.request({ kind: 'fit', bounds, padding: options.padding ?? 48, maxZoom: options.maxZoom ?? 8 });
  }

  flyTo(position: LatLonDeg, zoom?: number): void {
    this.request({ kind: 'fly', position: { ...position }, ...(zoom === undefined ? {} : { zoom }) });
  }

  subscribe(listener: (event: OverlayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** For the map view: connect (or disconnect with null) the mounted map's camera. */
  attachCamera(camera: MapCamera | null): void {
    this.camera = camera;
    if (camera && this.pending) {
      const request = this.pending;
      this.pending = null;
      camera.apply(request);
    }
  }

  private request(request: CameraRequest): void {
    if (this.camera) this.camera.apply(request);
    else this.pending = request;
  }

  private emit(event: OverlayEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('map overlay listener failed', error);
      }
    }
  }
}

const services = new WeakMap<object, MapServiceImpl>();

/** The map service of the page `ctx` belongs to (one per store). */
export function mapServiceFor(ctx: Pick<Ctx, 'store'>): MapService {
  return serviceImpl(ctx);
}

/** @internal The implementation, for the map view. */
export function serviceImpl(ctx: Pick<Ctx, 'store'>): MapServiceImpl {
  let s = services.get(ctx.store);
  if (!s) {
    s = new MapServiceImpl();
    services.set(ctx.store, s);
  }
  return s;
}

// ---------------------------------------------------------------------------------------
// Feature builders for overlays (antimeridian and poles handled; see geometry.ts)

type Props = Record<string, unknown>;

/** A circle of position: everywhere at `zenithDistanceDeg` from the ground point `gp`. */
export function circleOfPositionFeature(gp: LatLonDeg, zenithDistanceDeg: number, properties: Props = {}): Feature<MultiLineString> {
  return { type: 'Feature', properties, geometry: { type: 'MultiLineString', coordinates: circleLine(gp, zenithDistanceDeg) } };
}

/** A path through points (densify great circles first, e.g. with geo/greatcircle.ts). */
export function pathFeature(points: readonly LatLonDeg[], properties: Props = {}): Feature<MultiLineString> {
  return { type: 'Feature', properties, geometry: { type: 'MultiLineString', coordinates: splitLine(points) } };
}

/** An area bounded by a ring that does not enclose a pole (an eclipse path's outline). */
export function areaFeature(ring: readonly LatLonDeg[], properties: Props = {}): Feature<MultiPolygon> {
  return { type: 'Feature', properties, geometry: { type: 'MultiPolygon', coordinates: polygonPieces(ring) } };
}

/** Everywhere within `radiusDeg` of `center` (poles and antimeridian handled). */
export function capFeature(center: LatLonDeg, radiusDeg: number, properties: Props = {}): Feature<MultiPolygon> {
  return { type: 'Feature', properties, geometry: { type: 'MultiPolygon', coordinates: capPolygon(center, radiusDeg) } };
}

/** A fix's error ellipse: semi-axes in nautical miles, major axis on true bearing `orientationDeg`. */
export function ellipseFeature(
  center: LatLonDeg,
  semiMajorNm: number,
  semiMinorNm: number,
  orientationDeg: number,
  properties: Props = {},
): Feature<MultiPolygon> {
  return areaFeature(ellipseRing(center, semiMajorNm, semiMinorNm, orientationDeg), properties);
}

export function pointFeature(position: LatLonDeg, properties: Props = {}): Feature<Point> {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates: [wrapLon(position.lon_deg), position.lat_deg] } };
}
