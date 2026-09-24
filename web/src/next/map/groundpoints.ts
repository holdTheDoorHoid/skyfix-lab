/**
 * Ground points on the map: where each body is straight overhead now (its GP, latitude =
 * declination, longitude = -GHA; EXPLORER_API `gp`). OWNER: map agent.
 *
 * Drawn as the approved design shows them (docs/design/map-light.png): the body's glyph with
 * a label "Venus overhead". Markers, not WebGL, so they use the design system's glyphs;
 * there are at most eleven. A click on one selects that body. Labels that would overlap a
 * more important one are hidden (the glyph stays).
 */

import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import type { BodyState } from '../engine/types.js';
import { bodyGlyph } from '../theme/glyphs.js';
import { wrapLon } from './geometry.js';
import { moonLitPath } from './skyproj.js';

/** Label priority after the selected body. */
const ORDER: Record<string, number> = { Sun: 1, Moon: 2, Venus: 3, Jupiter: 4, Mars: 5, Saturn: 6, Mercury: 7, Uranus: 8, Neptune: 9 };

const SVG_NS = 'http://www.w3.org/2000/svg';

interface Entry {
  marker: Marker;
  el: HTMLElement;
  label: HTMLElement;
  glyphKey: string;
  body: string;
}

function moonDisc(fraction: number, limbFromUpDeg: number | null): SVGSVGElement {
  // limbFromUpDeg: degrees counter-clockwise from up; default lit on the right.
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '-12 -12 24 24');
  s.setAttribute('class', 'sfm-gp__moon');
  s.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attrs: Record<string, string>) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    s.appendChild(n);
  };
  add('circle', { r: '11', class: 'sfm-gp__moon-halo' });
  add('circle', { r: '9.5', class: 'sfm-gp__moon-dark' });
  const lit = moonLitPath(fraction, 9.5);
  // As seen from the ground point looking up with north at the top: the bright limb's
  // position angle counts from north towards east, which is to the left on the sky
  // (the design system's phaseDisc convention: counter-clockwise from up).
  if (lit) add('path', { d: lit, class: 'sfm-gp__moon-lit', transform: `rotate(${(-90 - (limbFromUpDeg ?? 270)).toFixed(1)})` });
  return s;
}

export class GroundPoints {
  private readonly entries = new Map<string, Entry>();
  private visible = true;

  constructor(
    private readonly map: MapLibreMap,
    private readonly onSelect: (body: string) => void,
  ) {}

  /** Show the ground points of these bodies (Sun, Moon, planets, and a selected star). */
  update(bodies: readonly BodyState[], selected: string | null, visible: boolean): void {
    this.visible = visible;
    const keep = new Set<string>();
    for (const b of bodies) {
      if (!visible) break;
      if (b.kind === 'star' && b.body !== selected) continue;
      keep.add(b.body);
      const e = this.entries.get(b.body) ?? this.create(b);
      e.marker.setLngLat([wrapLon(b.gp.lon_deg), b.gp.lat_deg]);
      e.el.classList.toggle('is-selected', b.body === selected);
      // The Moon's disc follows its phase; redraw only when it visibly changes.
      if (b.kind === 'moon' && b.illuminated_fraction !== null) {
        const limb = b.bright_limb_angle_deg;
        const key = `${Math.round(b.illuminated_fraction * 200)}|${limb === null ? '' : Math.round(limb / 3)}`;
        if (key !== e.glyphKey) {
          e.glyphKey = key;
          e.el.firstChild?.replaceWith(moonDisc(b.illuminated_fraction, limb));
        }
      }
    }
    for (const [body, e] of this.entries) {
      if (!keep.has(body)) {
        e.marker.remove();
        this.entries.delete(body);
      }
    }
    this.declutter(selected);
  }

  /** Hide labels that would cover a more important one (glyphs always stay). */
  private declutter(selected: string | null): void {
    if (!this.visible) return;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const list = [...this.entries.values()].sort(
      (a, b) => (a.body === selected ? 0 : (ORDER[a.body] ?? 20)) - (b.body === selected ? 0 : (ORDER[b.body] ?? 20)),
    );
    for (const e of list) {
      const p = this.map.project(e.marker.getLngLat());
      const width = 16 + 6.4 * (e.body.length + 9);
      const rect = { x0: p.x - 12, y0: p.y - 11, x1: p.x + 14 + width, y1: p.y + 11 };
      const hit = placed.some((r) => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0);
      e.el.classList.toggle('sfm-gp--nolabel', hit);
      if (!hit) placed.push(rect);
    }
  }

  destroy(): void {
    for (const e of this.entries.values()) e.marker.remove();
    this.entries.clear();
  }

  private create(b: BodyState): Entry {
    const el = document.createElement('div');
    el.className = 'sfm-gp';
    el.dataset.body = b.body;
    el.title = `Ground point: ${b.body} is straight overhead here. Click to select it.`;
    const glyph =
      b.kind === 'moon'
        ? moonDisc(b.illuminated_fraction ?? 1, b.bright_limb_angle_deg)
        : bodyGlyph(b.body, { kind: b.kind, halo: true, class: 'sfm-gp__glyph' });
    const label = document.createElement('span');
    label.className = 'sfm-gp__label';
    const small = document.createElement('small');
    small.textContent = 'overhead';
    label.append(document.createTextNode(`${b.body} `), small);
    el.append(glyph, label);
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onSelect(b.body);
    });
    const marker = new Marker({ element: el, anchor: 'center', opacityWhenCovered: 0 }).setLngLat([wrapLon(b.gp.lon_deg), b.gp.lat_deg]).addTo(this.map);
    const entry: Entry = { marker, el, label, glyphKey: '', body: b.body };
    this.entries.set(b.body, entry);
    return entry;
  }
}
