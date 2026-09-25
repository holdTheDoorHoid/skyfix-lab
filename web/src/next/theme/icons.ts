/**
 * The explorer's icon set: drawn for this project on a 24-unit grid, stroked with
 * `currentColor` (1.75 units, round caps and joins) so an icon takes the colour of its
 * text. OWNER: shell-design agent. No icon font, no third-party artwork.
 *
 * `icon(name)` returns a fresh `<svg>`. Icons are decorative by default
 * (`aria-hidden`); pass `label` when the icon is the only thing that names a control's
 * meaning to a screen reader — but prefer an `aria-label` on the control itself.
 */

type Shape =
  | ['path', string]
  | ['circle', number, number, number]
  | ['dot', number, number, number]
  | ['rect', number, number, number, number, number]
  | ['fill', string];

const ICONS = {
  // Views
  map: [
    ['path', 'M3.5 6.2 9 4l6 2.4 5.5-2.2v13.6L15 20l-6-2.4-5.5 2.2Z'],
    ['path', 'M9 4v13.6M15 6.4V20'],
  ],
  globe: [
    ['circle', 12, 12, 8.5],
    ['path', 'M3.5 12h17'],
    ['path', 'M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5S9.4 5.9 12 3.5Z'],
  ],
  sky: [
    ['path', 'M3 19.5h18'],
    ['path', 'M12 4.2l1.5 4.4 4.4 1.5-4.4 1.5L12 16l-1.5-4.4-4.4-1.5 4.4-1.5Z'],
    ['path', 'M18.5 3v3.6M16.7 4.8h3.6'],
  ],
  charts: [
    ['path', 'M4 4v16h16'],
    ['path', 'M7.5 15.5 11 11l3 2.5 5-6.5'],
  ],
  sextant: [
    ['path', 'M12 3.8 5.4 16.1a10.2 10.2 0 0 0 13.2 0Z'],
    ['path', 'M12 3.8l2.7 14.6'],
    ['dot', 12, 3.8, 1.5],
  ],
  almanac: [
    ['path', 'M12 6.8C9.8 5.3 7 4.8 3.5 5.2v13c3.5-.4 6.3.1 8.5 1.6 2.2-1.5 5-2 8.5-1.6v-13c-3.5-.4-6.3.1-8.5 1.6Z'],
    ['path', 'M12 6.8v13M6.2 9.2h3.3M6.2 12.4h3.3M14.5 9.2h3.3M14.5 12.4h3.3'],
  ],
  events: [
    ['circle', 10, 12, 6.5],
    ['path', 'M12 5.8a6.5 6.5 0 1 1 0 12.4'],
  ],
  learn: [
    ['path', 'M2.5 9.2 12 5l9.5 4.2-9.5 4.2Z'],
    ['path', 'M6.5 11.2v4.3c1.6 1.4 3.4 2.1 5.5 2.1s3.9-.7 5.5-2.1v-4.3M21.5 9.2v5.3'],
  ],
  about: [
    ['circle', 12, 12, 8.5],
    ['path', 'M12 11v5.5'],
    ['dot', 12, 7.8, 1.1],
  ],
  // Actions
  search: [
    ['circle', 10.5, 10.5, 6],
    ['path', 'm15 15 5 5'],
  ],
  locate: [
    ['circle', 12, 12, 6.5],
    ['dot', 12, 12, 2.1],
    ['path', 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3'],
  ],
  pin: [
    ['path', 'M12 21c-3.8-3.8-6.5-7.4-6.5-10.8a6.5 6.5 0 0 1 13 0c0 3.4-2.7 7-6.5 10.8Z'],
    ['circle', 12, 10.2, 2.3],
  ],
  edit: [
    ['path', 'M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16Z'],
    ['path', 'm13.5 6.5 4 4'],
  ],
  calendar: [
    ['rect', 3.5, 5, 17, 15, 2.5],
    ['path', 'M3.5 10h17M8 3v4M16 3v4'],
    ['dot', 8, 14, 1],
    ['dot', 12, 14, 1],
    ['dot', 16, 14, 1],
    ['dot', 8, 17, 1],
    ['dot', 12, 17, 1],
  ],
  'chevron-left': [['path', 'm14.5 6-6 6 6 6']],
  'chevron-right': [['path', 'm9.5 6 6 6-6 6']],
  'chevron-down': [['path', 'm6 9.5 6 6 6-6']],
  'chevron-up': [['path', 'm6 14.5 6-6 6 6']],
  'chevrons-left': [['path', 'm12.5 6-6 6 6 6M18.5 6l-6 6 6 6']],
  'chevrons-right': [['path', 'm11.5 6 6 6-6 6M5.5 6l6 6-6 6']],
  play: [['fill', 'M8 5.3v13.4c0 .8.9 1.3 1.6.9l10.3-6.7c.6-.4.6-1.3 0-1.7L9.6 4.4C8.9 4 8 4.5 8 5.3Z']],
  pause: [
    ['fill', 'M8 5.5h1.6a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z'],
    ['fill', 'M14.4 5.5H16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-1.6a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z'],
  ],
  clock: [
    ['circle', 12, 12, 8.5],
    ['path', 'M12 7.5V12l3 2'],
  ],
  speed: [
    ['path', 'M4.2 16.5a8.5 8.5 0 1 1 15.6 0'],
    ['path', 'm12 13.5 4.2-4.2'],
    ['dot', 12, 13.5, 1.4],
  ],
  share: [
    ['path', 'M12 3.5v11M8 7.5l4-4 4 4'],
    ['path', 'M5.5 12v7.5h13V12'],
  ],
  settings: [
    ['path', 'M4 7h9M17 7h3M4 17h3M11 17h9'],
    ['circle', 15, 7, 2],
    ['circle', 9, 17, 2],
  ],
  layers: [
    ['path', 'm12 3.8 8.8 4.8-8.8 4.8-8.8-4.8Z'],
    ['path', 'm3.2 12.8 8.8 4.8 8.8-4.8'],
  ],
  close: [['path', 'M6 6l12 12M18 6 6 18']],
  check: [['path', 'm5 12.5 4.5 4.5L19 7.5']],
  plus: [['path', 'M12 5v14M5 12h14']],
  minus: [['path', 'M5 12h14']],
  panel: [
    ['rect', 3.5, 4.5, 17, 15, 2.5],
    ['path', 'M9.5 4.5v15'],
  ],
  ruler: [
    ['path', 'M3.5 15.5 15.5 3.5l5 5-12 12Z'],
    ['path', 'm7.2 11.8 2 2M10.2 8.8l2 2M13.2 5.8l2 2'],
  ],
  external: [['path', 'M14 4h6v6M20 4l-9 9M18 14v5.5H4.5V6H10']],
  help: [
    ['circle', 12, 12, 8.5],
    ['path', 'M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6'],
    ['dot', 12, 16.9, 1.05],
  ],
  info: [
    ['circle', 12, 12, 8.5],
    ['path', 'M12 11v5.5'],
    ['dot', 12, 7.8, 1.1],
  ],
  caution: [
    ['path', 'M10.3 4.6 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0Z'],
    ['path', 'M12 9.5v4.5'],
    ['dot', 12, 17.2, 1.05],
  ],
  // Themes
  auto: [
    ['circle', 12, 12, 8.5],
    ['fill', 'M12 3.5a8.5 8.5 0 0 1 0 17Z'],
  ],
  more: [
    ['dot', 5.5, 12, 1.6],
    ['dot', 12, 12, 1.6],
    ['dot', 18.5, 12, 1.6],
  ],
  copy: [
    ['rect', 8.5, 8.5, 11.5, 11.5, 2],
    ['path', 'M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5'],
  ],
  sun: [
    ['circle', 12, 12, 4],
    ['path', 'M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6'],
  ],
  moon: [['path', 'M19.5 14.8A8 8 0 0 1 9.2 4.5a8 8 0 1 0 10.3 10.3Z']],
  eye: [
    ['path', 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z'],
    ['circle', 12, 12, 3],
  ],
  // Sky events and quantities
  // A Sun on the horizon with rays, and an arrow up (rise) or down (set).
  rise: [
    ['path', 'M2.5 19.5h19'],
    ['path', 'M7.8 19.5a4.2 4.2 0 0 1 8.4 0'],
    ['path', 'M4.2 15.2l1.6.9M19.8 15.2l-1.6.9'],
    ['path', 'M12 12.4V3.6M9.6 6 12 3.6 14.4 6'],
  ],
  set: [
    ['path', 'M2.5 19.5h19'],
    ['path', 'M7.8 19.5a4.2 4.2 0 0 1 8.4 0'],
    ['path', 'M4.2 15.2l1.6.9M19.8 15.2l-1.6.9'],
    ['path', 'M12 3.6v8.8M9.6 10 12 12.4 14.4 10'],
  ],
  // The Sun at the top of its arc: highest in the sky (transit).
  transit: [
    ['path', 'M2.5 19.5h19'],
    ['path', 'M4.5 19.5C6.3 13.6 8.9 10.6 12 10.6s5.7 3 7.5 8.9'],
    ['dot', 12, 7.2, 3],
  ],
  dawn: [
    ['path', 'M3 19h18'],
    ['path', 'M6.5 15.6c1.5-1.2 3.4-1.8 5.5-1.8s4 .6 5.5 1.8'],
    ['path', 'M12 11V4.5M9.5 7 12 4.5 14.5 7'],
  ],
  dusk: [
    ['path', 'M3 19h18'],
    ['path', 'M6.5 15.6c1.5-1.2 3.4-1.8 5.5-1.8s4 .6 5.5 1.8'],
    ['path', 'M12 4.5V11M9.5 8.5 12 11l2.5-2.5'],
  ],
  daylength: [['path', 'M7 3.5h10M7 20.5h10M8 3.5c0 4 4 5 4 8.5s-4 4.5-4 8.5M16 3.5c0 4-4 5-4 8.5s4 4.5 4 8.5']],
  shadow: [
    ['path', 'M7 4.5v13.5'],
    ['path', 'M7 18h12.5'],
    ['circle', 18, 6.5, 2.2],
  ],
  eyeheight: [
    ['path', 'M3 18.5c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0'],
    ['path', 'M12 14.5V4.5M9.5 7 12 4.5 14.5 7'],
  ],
  compass: [
    ['circle', 12, 12, 8.5],
    ['path', 'm12 6.5 2 5.5-2 5.5-2-5.5Z'],
  ],
  target: [
    ['circle', 12, 12, 8.5],
    ['circle', 12, 12, 4.5],
    ['dot', 12, 12, 1.3],
  ],
  list: [['path', 'M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01']],
  // photo agent (expansion Q8): high and low water (the Place section's tides line).
  tide: [
    ['path', 'M3 18.5c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0'],
    ['path', 'M12 3.5v9M9.5 6 12 3.5 14.5 6M9.5 10 12 12.5 14.5 10'],
  ],
  // tonight agent (expansion programme Q2): the Tonight tab, a crescent under a star.
  tonight: [
    ['path', 'M16.4 17.9A6.9 6.9 0 0 1 7.5 9a6.9 6.9 0 1 0 8.9 8.9Z'],
    ['path', 'M17.4 3.4v4.4M15.2 5.6h4.4'],
    ['dot', 12.6, 8.4, 1],
  ],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgChild(shape: Shape): SVGElement {
  switch (shape[0]) {
    case 'path': {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', shape[1]);
      return el;
    }
    case 'fill': {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', shape[1]);
      el.setAttribute('fill', 'currentColor');
      el.setAttribute('stroke', 'none');
      return el;
    }
    case 'circle':
    case 'dot': {
      const el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('cx', String(shape[1]));
      el.setAttribute('cy', String(shape[2]));
      el.setAttribute('r', String(shape[3]));
      if (shape[0] === 'dot') {
        el.setAttribute('fill', 'currentColor');
        el.setAttribute('stroke', 'none');
      }
      return el;
    }
    case 'rect': {
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', String(shape[1]));
      el.setAttribute('y', String(shape[2]));
      el.setAttribute('width', String(shape[3]));
      el.setAttribute('height', String(shape[4]));
      el.setAttribute('rx', String(shape[5]));
      return el;
    }
  }
}

export interface IconOptions {
  /** Pixel size (width = height). Default: 1em via CSS (`.sf-icon`). */
  size?: number;
  /** Accessible name; without it the icon is hidden from assistive technology. */
  label?: string;
  class?: string;
}

/** A fresh `<svg>` for the named icon. */
export function icon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', options.class ? `sf-icon ${options.class}` : 'sf-icon');
  svg.dataset.icon = name;
  if (options.size) {
    svg.setAttribute('width', String(options.size));
    svg.setAttribute('height', String(options.size));
  }
  if (options.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  for (const shape of ICONS[name] as Shape[]) svg.appendChild(svgChild(shape));
  return svg;
}
