/**
 * The map's controls on the stage, as approved in docs/design/map-light.png: flat chart /
 * globe and the layer list top right; zoom, back to your place, place at the map centre
 * (for keyboard users) and the measuring tool on the right; the shading legend bottom left;
 * the data credit bottom right. OWNER: map agent. Built from the design system's primitives.
 */

import { h } from '../../dom.js';
import type { Layers } from '../state.js';
import { button, iconButton, popover, segmented, setPressed, switchRow, type Popover, type Segmented } from '../theme/primitives.js';
import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL } from './style.js';

export type LayerKey = keyof Layers;

/** Map layers offered in the layer list, plain words first (EXPLORER_PLAN section 1). */
export const MAP_LAYER_OPTIONS: readonly { key: LayerKey; label: string; note?: string }[] = [
  { key: 'compass', label: 'Compass at your place', note: 'Where the selected body rises, sets and is now' },
  { key: 'paths', label: 'Path across the sky', note: 'Rise to set, the pass shown in the panel; for the Sun, also the band between its solstice paths' },
  { key: 'terminator', label: 'Day and night' },
  { key: 'twilight', label: 'Twilight shading', note: 'Civil, nautical and astronomical' },
  { key: 'groundPoints', label: 'Where each body is overhead', note: 'Ground points (GP)' },
  { key: 'circles', label: 'Same height as here', note: 'Circle of equal altitude (circle of position)' },
  { key: 'altitudeRings', label: 'Height rings', note: 'Every 10° of altitude round the ground point' },
  { key: 'graticule', label: 'Latitude and longitude lines' },
  { key: 'scaleBar', label: 'Scale bar' },
  { key: 'streets', label: 'Street map (online)', note: 'OpenStreetMap tiles from the internet' },
];

const PHASE_NOTES = {
  day: 'The Sun is up.',
  civil: 'Civil twilight: Sun 0°50′ to 6° below the horizon.',
  nautical: 'Nautical twilight: 6° to 12° below; horizon and stars both visible.',
  astronomical: 'Astronomical twilight: 12° to 18° below.',
  night: 'Night: the Sun more than 18° below the horizon.',
};

export interface ControlHandlers {
  zoomIn(): void;
  zoomOut(): void;
  recentre(): void;
  placeAtCentre(): void;
  toggleMeasure(): void;
  setProjection(projection: 'map' | 'globe'): void;
  setLayer(key: LayerKey, on: boolean): void;
}

export interface ControlState {
  layers: Layers;
  measuring: boolean;
  projection: 'map' | 'globe';
}

export interface MapControls {
  /** Overlays to append to the map's root, in order. */
  elements: HTMLElement[];
  update(state: ControlState): void;
  destroy(): void;
}

function legend(): HTMLElement {
  const band = (name: string, token: string | null, tip: string): HTMLElement =>
    h(
      'span',
      { class: 'sf-legend__band', 'data-tip': tip },
      h('span', {
        class: 'sf-legend__swatch',
        style: `background:${token ? `color-mix(in srgb, var(--map-shade) calc(var(${token}) * 100%), var(--map-land))` : 'var(--map-land)'}`,
      }),
      h('span', { class: 'sf-legend__name' }, name),
    );
  return h(
    'div',
    { class: 'sf-legend sf-float', role: 'note', 'aria-label': 'Map shading: day, civil, nautical and astronomical twilight, night' },
    h('span', { class: 'sf-legend__title' }, 'Shading'),
    h(
      'span',
      { class: 'sf-legend__scale' },
      band('Day', null, PHASE_NOTES.day),
      band('Civil', '--shade-civil', PHASE_NOTES.civil),
      band('Nautical', '--shade-nautical', PHASE_NOTES.nautical),
      band('Astro.', '--shade-astronomical', PHASE_NOTES.astronomical),
      band('Night', '--shade-night', PHASE_NOTES.night),
    ),
  );
}

export function createControls(handlers: ControlHandlers, container: HTMLElement): MapControls {
  // Top right: projection and layers.
  const projection: Segmented<'map' | 'globe'> = segmented({
    label: 'Map projection',
    value: 'map',
    size: 'sm',
    class: 'sf-float',
    onChange: handlers.setProjection,
    options: [
      { value: 'map', label: 'Chart', icon: 'map', tip: 'Flat chart (Mercator)' },
      { value: 'globe', label: 'Globe', icon: 'globe', tip: 'Globe' },
    ],
  });
  const layersBtn = button({
    label: 'Layers',
    icon: 'layers',
    variant: 'secondary',
    size: 'sm',
    class: 'sf-float sf-layers-btn',
    tip: 'Twilight, ground points, circles of position, grid, street map',
  });
  const switches = new Map<LayerKey, HTMLButtonElement>();
  const list = h('div', { class: 'sf-layers sfm-layers' }, h('p', { class: 'sfm-layers__title' }, 'On the map'));
  for (const opt of MAP_LAYER_OPTIONS) {
    const sw = switchRow({
      label: opt.label,
      checked: false,
      ...(opt.note ? { note: opt.note } : {}),
      onChange: (on) => handlers.setLayer(opt.key, on),
    });
    switches.set(opt.key, sw);
    list.appendChild(sw);
  }
  const pop: Popover = popover(layersBtn, list, { label: 'Map layers', placement: 'bottom-end', onStage: true, container });
  const topRight = h('div', { class: 'sf-overlay sf-overlay--tr sf-on-stage sfm-controls' }, projection.el, layersBtn);

  // Right: zoom, your place, measuring.
  const zoomIn = iconButton('plus', 'Zoom in', { variant: 'secondary', onClick: handlers.zoomIn });
  const zoomOut = iconButton('minus', 'Zoom out', { variant: 'secondary', onClick: handlers.zoomOut });
  const recentre = iconButton('locate', 'Centre the map on your place', {
    variant: 'secondary',
    class: 'sf-float',
    tip: 'Centre on your place',
    onClick: handlers.recentre,
  });
  const here = iconButton('target', 'Set your place to the centre of the map', {
    variant: 'secondary',
    class: 'sf-float sfm-here',
    tip: 'Set your place to the map centre (for the keyboard: move the map with the arrow keys first)',
    onClick: handlers.placeAtCentre,
  });
  const measure = iconButton('ruler', 'Measure distance and course', {
    variant: 'secondary',
    class: 'sf-float',
    pressed: false,
    tip: 'Measure: click two points for the great-circle and rhumb-line distance and course',
    onClick: handlers.toggleMeasure,
  });
  const right = h('div', { class: 'sf-overlay sf-overlay--r sf-on-stage sfm-controls' }, h('div', { class: 'sf-btn-group' }, zoomIn, zoomOut), recentre, here, measure);

  // Bottom left: the shading legend.
  const legendEl = legend();
  const bottomLeft = h('div', { class: 'sf-overlay sf-overlay--bl sf-on-stage sfm-controls' }, legendEl);

  return {
    elements: [topRight, right, bottomLeft],
    update({ layers, measuring, projection: p }) {
      for (const [key, sw] of switches) sw.setAttribute('aria-checked', String(Boolean(layers[key])));
      setPressed(measure, measuring);
      if (projection.value() !== p) projection.set(p);
      legendEl.hidden = !(layers.twilight || layers.terminator);
    },
    destroy() {
      pop.destroy();
      for (const el of [topRight, right, bottomLeft]) el.remove();
    },
  };
}

export interface Credit {
  element: HTMLElement;
  /** The OpenStreetMap credit is shown exactly while its tiles are (OSMF tile policy). */
  setStreets(on: boolean): void;
}

/** The data credit, bottom right. Always on, whether or not the map's own controls are. */
export function createCredit(): Credit {
  const osm = h('a', { href: OSM_COPYRIGHT_URL, target: '_blank', rel: 'noopener noreferrer' }, OSM_ATTRIBUTION);
  const osmPart = h('span', { class: 'sfm-osm', hidden: true }, ' · ', osm);
  const credit = h('span', { class: 'sf-attribution' }, 'Map data: Natural Earth', osmPart);
  const element = h('div', { class: 'sf-overlay sf-overlay--br sf-on-stage sfm-credit' }, credit);
  return {
    element,
    setStreets(on) {
      osmPart.hidden = !on;
    },
  };
}
