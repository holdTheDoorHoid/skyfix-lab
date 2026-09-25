/**
 * Small inline symbols for lists and cards, the same shapes the chart draws (deepsky.ts,
 * render.ts): so a search result for M13 shows the globular cluster's circle with a cross.
 * OWNER: sky2 agent. Stroked with `currentColor` on a 24-unit grid, like theme/icons.ts.
 */

import type { SearchHitKind } from '../engine/types.js';
import { DsoShape } from './deepsky.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

type Part = ['circle', number, number, number, string?] | ['path', string, string?] | ['ellipse', number, number, number, number];

const SHAPES: Record<string, Part[]> = {
  star: [['path', 'M12 3.5 13.9 10.1 20.5 12 13.9 13.9 12 20.5 10.1 13.9 3.5 12 10.1 10.1Z']],
  constellation: [
    ['path', 'M5 17 10 8.5 15.5 12 19.5 5.5'],
    ['circle', 5, 17, 1.8, 'fill'],
    ['circle', 10, 8.5, 1.8, 'fill'],
    ['circle', 15.5, 12, 1.8, 'fill'],
    ['circle', 19.5, 5.5, 1.8, 'fill'],
  ],
  shower: [
    ['circle', 12, 12, 3.2],
    ['path', 'M12 3.5v3.2M12 17.3v3.2M3.5 12h3.2M17.3 12h3.2M6 6l2.3 2.3M15.7 15.7 18 18M18 6l-2.3 2.3M8.3 15.7 6 18'],
  ],
  [`dso${DsoShape.Galaxy}`]: [['ellipse', 12, 12, 8.5, 4.2]],
  [`dso${DsoShape.OpenCluster}`]: [['circle', 12, 12, 7.5, 'dotted']],
  [`dso${DsoShape.Globular}`]: [['circle', 12, 12, 7.5], ['path', 'M4.5 12h15M12 4.5v15']],
  [`dso${DsoShape.Nebula}`]: [['path', 'M5.5 5.5h13v13h-13Z']],
  [`dso${DsoShape.Planetary}`]: [['circle', 12, 12, 4.5], ['path', 'M12 3v4.5M12 16.5V21M3 12h4.5M16.5 12H21']],
  [`dso${DsoShape.ClusterNebula}`]: [['path', 'M4.5 4.5h15v15h-15Z'], ['circle', 12, 12, 4.8, 'dotted']],
  [`dso${DsoShape.Other}`]: [['path', 'M12 4.5 19.5 12 12 19.5 4.5 12Z']],
  comet: [['circle', 8, 16, 2.6, 'fill'], ['path', 'M9.8 14.2 19.5 4.5M10.5 16.5l7.5-5M7.5 13.5l5-7.5']],
  asteroid: [['path', 'M12 7 17 12 12 17 7 12Z', 'fill']],
};

/** An inline symbol for a search hit's kind (a deep-sky object by its shape). */
export function kindSymbol(kind: SearchHitKind | 'comet' | 'asteroid', shape?: DsoShape): SVGSVGElement {
  const key = kind === 'deep_sky' ? `dso${shape ?? DsoShape.Other}` : kind === 'star' || kind === 'sun' ? 'star' : kind;
  const parts = SHAPES[key] ?? SHAPES.star!;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'sf-icon sky-sym');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const part of parts) {
    let el: SVGElement;
    if (part[0] === 'circle') {
      el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('cx', String(part[1]));
      el.setAttribute('cy', String(part[2]));
      el.setAttribute('r', String(part[3]));
      if (part[4] === 'fill') el.setAttribute('fill', 'currentColor');
      if (part[4] === 'dotted') el.setAttribute('stroke-dasharray', '1.2 2.6');
    } else if (part[0] === 'ellipse') {
      el = document.createElementNS(SVG_NS, 'ellipse');
      el.setAttribute('cx', String(part[1]));
      el.setAttribute('cy', String(part[2]));
      el.setAttribute('rx', String(part[3]));
      el.setAttribute('ry', String(part[4]));
    } else {
      el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', part[1]);
      if (part[2] === 'fill') el.setAttribute('fill', 'currentColor');
    }
    svg.appendChild(el);
  }
  return svg;
}

/** The Save picture icon: an arrow into a tray, the same as the charts' Save (charts/export-menu.ts). */
export function saveIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of [
    ['viewBox', '0 0 24 24'],
    ['fill', 'none'],
    ['stroke', 'currentColor'],
    ['stroke-width', '1.75'],
    ['stroke-linecap', 'round'],
    ['stroke-linejoin', 'round'],
    ['class', 'sf-icon'],
    ['aria-hidden', 'true'],
    ['focusable', 'false'],
  ] as const) {
    svg.setAttribute(k, v);
  }
  for (const d of ['M12 4v10.5', 'M7.5 10 12 14.5 16.5 10', 'M4.5 15.5v3.2c0 .7.6 1.3 1.3 1.3h12.4c.7 0 1.3-.6 1.3-1.3v-3.2']) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** The field-of-view icon: an eyepiece's circle with a small star inside. */
export function fovIcon(): SVGSVGElement {
  const svg = kindSymbol('star');
  svg.setAttribute('class', 'sf-icon');
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', '12');
  c.setAttribute('cy', '12');
  c.setAttribute('r', '9.5');
  svg.prepend(c);
  // A smaller star inside the circle.
  svg.querySelector('path')?.setAttribute('transform', 'translate(12 12) scale(0.55) translate(-12 -12)');
  return svg;
}
