/**
 * The map's own buttons: zoom, back to your place, put your place at the map centre (for
 * keyboard users), the measuring tool, the layer list, and flat chart / globe. OWNER: map
 * agent. Plain DOM; every button has a visible label on hover and an accessible name.
 */

import type { Layers } from '../state.js';

export type LayerKey = keyof Layers;

/** Map layers offered in the layer list, plain words first (EXPLORER_PLAN section 1). */
export const MAP_LAYER_OPTIONS: readonly { key: LayerKey; label: string; hint?: string }[] = [
  { key: 'compass', label: 'Compass at your place', hint: 'Where the selected body rises, sets and is now' },
  { key: 'paths', label: "Today's path", hint: 'And, for the Sun, the band between the solstice paths' },
  { key: 'terminator', label: 'Day and night' },
  { key: 'twilight', label: 'Twilight bands', hint: 'Civil, nautical and astronomical' },
  { key: 'groundPoints', label: 'Where each body is overhead', hint: 'Ground points (GP)' },
  { key: 'circles', label: 'Same altitude as here', hint: 'Circle of equal altitude (circle of position)' },
  { key: 'altitudeRings', label: 'Altitude rings', hint: 'Every 10° round the selected body’s ground point' },
  { key: 'graticule', label: 'Latitude and longitude lines' },
  { key: 'scaleBar', label: 'Scale bar' },
  { key: 'streets', label: 'Street map (online)', hint: 'OpenStreetMap tiles from the internet; off by default' },
];

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS: Record<string, string> = {
  zoomIn: 'M12 5v14M5 12h14',
  zoomOut: 'M5 12h14',
  recentre: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
  centre: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11ZM12 8v4M10 10h4',
  measure: 'M3.5 16.5 16.5 3.5l4 4-13 13Zm4-4 1.8 1.8M10.5 9.5l1.8 1.8M13.5 6.5l1.8 1.8',
  layers: 'M12 3.5 21 8.5l-9 5-9-5ZM3 12.5l9 5 9-5M3 16.5l9 5 9-5',
  flat: 'M3 6.5 9 4.5l6 2 6-2v13l-6 2-6-2-6 2ZM9 4.5v13M15 6.5v13',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9s1.2-6.4 3.8-9Z',
};

export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('sfm-icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]!);
  svg.appendChild(path);
  return svg;
}

function button(label: string, iconName: keyof typeof ICONS, onClick: () => void, extra = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `sfm-btn ${extra}`.trim();
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(icon(iconName));
  b.addEventListener('click', onClick);
  return b;
}

export interface ControlHandlers {
  zoomIn(): void;
  zoomOut(): void;
  recentre(): void;
  placeAtCentre(): void;
  toggleMeasure(): void;
  setProjection(projection: 'map' | 'globe'): void;
  setLayer(key: LayerKey, on: boolean): void;
}

export interface MapControls {
  element: HTMLElement;
  update(state: { layers: Layers; measuring: boolean; projection: 'map' | 'globe' }): void;
  destroy(): void;
}

export function createControls(h: ControlHandlers): MapControls {
  const root = document.createElement('div');
  root.className = 'sfm-controls';

  const zoom = document.createElement('div');
  zoom.className = 'sfm-group';
  zoom.append(button('Zoom in', 'zoomIn', h.zoomIn), button('Zoom out', 'zoomOut', h.zoomOut));

  const place = document.createElement('div');
  place.className = 'sfm-group';
  const recentre = button('Back to your place', 'recentre', h.recentre);
  const centre = button('Put your place at the centre of the map', 'centre', h.placeAtCentre, 'sfm-btn--centre');
  place.append(recentre, centre);

  const tools = document.createElement('div');
  tools.className = 'sfm-group';
  const measure = button('Measure distance and course', 'measure', h.toggleMeasure);
  measure.setAttribute('aria-pressed', 'false');

  // Layer list: a disclosure button and a panel of switches.
  const layersBtn = button('Map layers', 'layers', () => setOpen(Boolean(panel.hidden)));
  layersBtn.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div');
  panel.className = 'sfm-layers';
  panel.hidden = true;
  panel.id = `sfm-layers-${Math.random().toString(36).slice(2, 8)}`;
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Map layers');
  layersBtn.setAttribute('aria-controls', panel.id);
  const heading = document.createElement('p');
  heading.className = 'sfm-layers-title';
  heading.textContent = 'Map layers';
  panel.appendChild(heading);
  const boxes = new Map<LayerKey, HTMLInputElement>();
  for (const opt of MAP_LAYER_OPTIONS) {
    const label = document.createElement('label');
    label.className = 'sfm-layer';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => h.setLayer(opt.key, input.checked));
    const text = document.createElement('span');
    text.className = 'sfm-layer-text';
    text.textContent = opt.label;
    if (opt.hint) {
      const hint = document.createElement('span');
      hint.className = 'sfm-layer-hint';
      hint.textContent = opt.hint;
      text.appendChild(hint);
    }
    label.append(input, text);
    panel.appendChild(label);
    boxes.set(opt.key, input);
  }
  function setOpen(open: boolean): void {
    panel.hidden = !open;
    layersBtn.setAttribute('aria-expanded', String(open));
    if (open) boxes.values().next().value?.focus();
  }
  const onDocPointer = (e: PointerEvent): void => {
    if (!panel.hidden && !root.contains(e.target as Node)) setOpen(false);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      layersBtn.focus();
      e.preventDefault();
    }
  };
  document.addEventListener('pointerdown', onDocPointer, true);
  root.addEventListener('keydown', onKey);
  tools.append(measure, layersBtn);

  // Flat chart / globe.
  const proj = document.createElement('div');
  proj.className = 'sfm-group sfm-group--projection';
  proj.setAttribute('role', 'group');
  proj.setAttribute('aria-label', 'Projection');
  const flat = button('Flat chart', 'flat', () => h.setProjection('map'));
  const globe = button('Globe', 'globe', () => h.setProjection('globe'));
  proj.append(flat, globe);

  root.append(zoom, place, tools, panel, proj);

  return {
    element: root,
    update({ layers, measuring, projection }) {
      for (const [key, box] of boxes) box.checked = Boolean(layers[key]);
      measure.setAttribute('aria-pressed', String(measuring));
      measure.classList.toggle('is-on', measuring);
      flat.setAttribute('aria-pressed', String(projection === 'map'));
      globe.setAttribute('aria-pressed', String(projection === 'globe'));
    },
    destroy() {
      document.removeEventListener('pointerdown', onDocPointer, true);
      root.remove();
    },
  };
}
