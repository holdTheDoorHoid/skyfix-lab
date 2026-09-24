/**
 * The Map and Globe views and the map service. OWNER: map agent. See README.md.
 *
 *   mapView            the component the shell mounts for `view === 'map'` and `'globe'`
 *   createMapView      the same with options (no built-in controls, a ready callback)
 *   mapServiceFor(ctx) add and remove overlays, move the camera (for Navigate, Events, …)
 *   feature builders   circles of position, paths, areas, caps and ellipses, antimeridian-safe
 */

export { createMapView, mapView, FLAT_ZOOM, GLOBE_ZOOM, type MapViewOptions } from './map-view.js';
export {
  areaFeature,
  capFeature,
  circleOfPositionFeature,
  ellipseFeature,
  mapServiceFor,
  pathFeature,
  pointFeature,
  type MapService,
  type OverlayEntry,
  type OverlayEvent,
  type OverlayStyle,
} from './overlays.js';
export { MAP_LAYER_OPTIONS } from './controls.js';
