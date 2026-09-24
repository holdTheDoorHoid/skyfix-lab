/**
 * "How celestial navigation works": five short illustrated steps, each linked to the
 * demonstration that shows it with real numbers. OWNER: learn agent.
 *
 * The diagrams are drawn here, for this project, as small SVGs on the design tokens (no
 * third-party artwork). They are schematic: not to scale, and they say so.
 */

import { h, s } from '../../dom.js';
import { button } from '../theme/index.js';
import { candidateMark, gpMark, line } from './chart.js';
import type { LearnEnv } from './env.js';
import { r2 } from './project.js';
import type { StoryId, VariantId } from './stories.js';

type Svg = SVGSVGElement;

function svg(label: string, ...children: SVGElement[]): Svg {
  return s('svg', { class: 'sfl-dg', viewBox: '0 0 400 220', role: 'img', 'aria-label': label }, ...children) as Svg;
}

function text(x: number, y: number, value: string, cls = 'sfl-dg-text', anchor: 'start' | 'middle' | 'end' = 'start'): SVGElement {
  const t = s('text', { class: cls, x: r2(x), y: r2(y), 'text-anchor': anchor });
  t.textContent = value;
  return t;
}

/** Several lines of text, one below the other. */
function lines(x: number, y: number, values: string[], cls = 'sfl-dg-text', anchor: 'start' | 'middle' | 'end' = 'start'): SVGElement[] {
  return values.map((v, i) => text(x, y + i * 14, v, cls, anchor));
}

function star(x: number, y: number, r = 9): SVGElement {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / 5;
    const rr = i % 2 === 0 ? r : r * 0.42;
    pts.push(`${r2(x + rr * Math.cos(a))},${r2(y + rr * Math.sin(a))}`);
  }
  return s('polygon', { class: 'sfl-dg-star', points: pts.join(' ') });
}

function arc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number, cls = 'sfl-dg-arc'): SVGElement {
  const a0 = (fromDeg * Math.PI) / 180;
  const a1 = (toDeg * Math.PI) / 180;
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  const sweep = toDeg > fromDeg ? 1 : 0;
  return s('path', {
    class: cls,
    d: `M${r2(cx + r * Math.cos(a0))} ${r2(cy + r * Math.sin(a0))}A${r} ${r} 0 ${large} ${sweep} ${r2(cx + r * Math.cos(a1))} ${r2(cy + r * Math.sin(a1))}`,
  });
}

function circlePath(cx: number, cy: number, r: number): string {
  return `M${r2(cx - r)} ${r2(cy)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

function dot(x: number, y: number, cls = 'sfl-dg-dot', r = 3.2): SVGElement {
  return s('circle', { class: cls, cx: r2(x), cy: r2(y), r });
}

/** A small fix symbol for the sketches (the chart's own is sized for a chart). */
function miniFix(x: number, y: number): SVGElement {
  return s(
    'g',
    { class: 'sfl-ch-fix' },
    s('circle', { class: 'sfl-ch-halo', cx: r2(x), cy: r2(y), r: 6 }),
    s('circle', { class: 'sfl-ch-ring', cx: r2(x), cy: r2(y), r: 4.5 }),
    s('circle', { class: 'sfl-ch-dot', cx: r2(x), cy: r2(y), r: 1.6 }),
  );
}

let clipSeq = 0;

// ---------------------------------------------------------------------------------------
// The five diagrams

function groundPoint(): Svg {
  const cx = 240;
  const cy = 170;
  const R = 62;
  const rays: SVGElement[] = [];
  for (const x of [240, 262, 284]) {
    const surface = cy - Math.sqrt(Math.max(0, R * R - (x - cx) ** 2));
    rays.push(s('path', { class: 'sfl-dg-ray', d: `M${x} 40V${r2(surface)}` }));
  }
  return svg(
    'Diagram: starlight arrives in parallel lines; the one aimed at the centre of the Earth meets the surface at the ground point, where the star is straight overhead.',
    s('circle', { class: 'sfl-dg-earth', cx, cy, r: R }),
    ...rays,
    s('path', { class: 'sfl-dg-dotted', d: `M${cx} ${cy - R}V${cy}` }),
    s('path', { class: 'sfl-dg-dotted', d: `M156 106L${cx - 6} ${cy - R}` }),
    dot(cx, cy, 'sfl-dg-centre', 2.5),
    text(cx, cy + 20, 'Earth’s centre', 'sfl-dg-small', 'middle'),
    star(cx, 22, 10),
    dot(cx, cy - R, 'sfl-dg-gp', 4.5),
    text(cx + 18, 27, 'A star, very far away', 'sfl-dg-strong'),
    ...lines(296, 62, ['Its light arrives', 'in parallel lines'], 'sfl-dg-small'),
    ...lines(150, 96, ['Ground point:'], 'sfl-dg-strong', 'end'),
    ...lines(150, 110, ['the star is straight', 'overhead here'], 'sfl-dg-text', 'end'),
  );
}

function heightCircle(): Svg {
  // Side view: the Earth, the ground point, and an observer 50 degrees of arc away.
  const cx = 140;
  const cy = 160;
  const R = 58;
  const z = 50;
  const zr = (z * Math.PI) / 180;
  const ox = cx + R * Math.sin(zr);
  const oy = cy - R * Math.cos(zr);
  const tx = Math.cos(zr);
  const ty = Math.sin(zr);
  const horizon = `M${r2(ox - 30 * tx)} ${r2(oy - 30 * ty)}L${r2(ox + 30 * tx)} ${r2(oy + 30 * ty)}`;
  // Top view: the ring of equal height round the ground point.
  const gx = 318;
  const gy = 112;
  const ring = 60;
  const at = (deg: number): [number, number] => [gx + ring * Math.cos((deg * Math.PI) / 180), gy + ring * Math.sin((deg * Math.PI) / 180)];
  const [yx, yy] = at(145);
  const [p1x, p1y] = at(20);
  const [p2x, p2y] = at(-70);
  return svg(
    'Diagram: from the side, a star 40 degrees high means you are 50 degrees of arc from its ground point; seen from above, that is a circle round the ground point.',
    s('circle', { class: 'sfl-dg-earth', cx, cy, r: R }),
    s('path', { class: 'sfl-dg-ray', d: `M${cx} 38V${cy - R}` }),
    s('path', { class: 'sfl-dg-ray', d: `M${r2(ox)} 38V${r2(oy)}` }),
    s('path', { class: 'sfl-dg-dotted', d: `M${cx} ${cy}V${cy - R}M${cx} ${cy}L${r2(ox)} ${r2(oy)}` }),
    arc(cx, cy, 16, -90, -90 + z),
    text(cx + 12, cy - 26, `${z}°`, 'sfl-dg-num', 'middle'),
    s('path', { class: 'sfl-dg-horizon', d: horizon }),
    arc(ox, oy, 18, -90 - (90 - z), -90),
    text(ox - 16, oy - 28, `${90 - z}°`, 'sfl-dg-num', 'middle'),
    star((cx + ox) / 2, 22, 8),
    dot(cx, cy - R, 'sfl-dg-gp', 4),
    dot(ox, oy, 'sfl-dg-you', 4.5),
    text(ox + 9, oy - 4, 'you', 'sfl-dg-strong'),
    text(8, 42, 'The star stands 40°', 'sfl-dg-strong'),
    ...lines(8, 56, ['above your horizon,', 'so you are 50° of arc', 'from its ground point'], 'sfl-dg-small'),
    // Top view
    s('path', { class: 'sfl-dg-ring-inner', d: circlePath(gx, gy, 26) }),
    line(circlePath(gx, gy, ring), 0),
    gpMark(gx, gy, 0),
    dot(p1x, p1y, 'sfl-dg-dot', 3),
    dot(p2x, p2y, 'sfl-dg-dot', 3),
    dot(yx, yy, 'sfl-dg-you', 4.5),
    text(yx - 9, yy + 4, 'you', 'sfl-dg-strong', 'end'),
    text(gx, 30, 'Seen from above', 'sfl-dg-strong', 'middle'),
    text(gx, gy + 20, '60° high', 'sfl-dg-small', 'middle'),
    text(gx, 192, '40° high everywhere on this circle', 'sfl-dg-text', 'middle'),
    text(gx, 206, 'round the ground point ★', 'sfl-dg-small', 'middle'),
  );
}

/** Intersections of two circles in the plane. */
function crossings(c1: { x: number; y: number; r: number }, c2: { x: number; y: number; r: number }): [number, number][] {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  const a = (c1.r * c1.r - c2.r * c2.r + d * d) / (2 * d);
  const hh = Math.sqrt(Math.max(0, c1.r * c1.r - a * a));
  const px = c1.x + (a * dx) / d;
  const py = c1.y + (a * dy) / d;
  return [
    [px + (hh * dy) / d, py - (hh * dx) / d],
    [px - (hh * dy) / d, py + (hh * dx) / d],
  ];
}

function twoCircles(): Svg {
  const c1 = { x: 160, y: 122, r: 72 };
  const c2 = { x: 250, y: 126, r: 64 };
  const pts = crossings(c1, c2);
  const [a, b] = pts[0]![1] < pts[1]![1] ? [pts[0]!, pts[1]!] : [pts[1]!, pts[0]!];
  const dr = { x: a[0] - 13, y: a[1] - 12 };
  return svg(
    'Diagram: two circles of equal height cross at two points, A and B; a rough idea of where you are picks A, but that is outside knowledge.',
    line(circlePath(c1.x, c1.y, c1.r), 0),
    line(circlePath(c2.x, c2.y, c2.r), 1),
    gpMark(c1.x, c1.y, 0),
    gpMark(c2.x, c2.y, 1),
    text(c1.x, c1.y + 22, 'star 1 overhead', 'sfl-dg-small', 'middle'),
    text(c2.x, c2.y + 22, 'star 2 overhead', 'sfl-dg-small', 'middle'),
    s('circle', { class: 'sfl-dg-dr', cx: r2(dr.x), cy: r2(dr.y), r: 13 }),
    s('path', { class: 'sfl-dg-dotted', d: `M132 34L${r2(dr.x - 10)} ${r2(dr.y - 8)}` }),
    text(8, 26, 'A rough idea of where', 'sfl-dg-strong'),
    text(8, 40, 'you are picks A', 'sfl-dg-small'),
    candidateMark(a[0], a[1]),
    candidateMark(b[0], b[1]),
    text(a[0] + 12, a[1] + 5, 'A', 'sfl-dg-strong'),
    text(b[0] + 12, b[1] + 5, 'B', 'sfl-dg-strong'),
    text(200, 212, 'Both crossings fit both sights exactly', 'sfl-dg-text', 'middle'),
  );
}

/** Three straight lines through (cx, cy) at the given angles, each nudged along its normal. */
function cockedHat(cx: number, cy: number, anglesDeg: number[], nudges: number[], len: number): SVGElement[] {
  return anglesDeg.map((deg, i) => {
    const a = (deg * Math.PI) / 180;
    const nx = -Math.sin(a) * nudges[i]!;
    const ny = Math.cos(a) * nudges[i]!;
    const x0 = cx + nx - Math.cos(a) * len;
    const y0 = cy + ny - Math.sin(a) * len;
    const x1 = cx + nx + Math.cos(a) * len;
    const y1 = cy + ny + Math.sin(a) * len;
    return line(`M${r2(x0)} ${r2(y0)}L${r2(x1)} ${r2(y1)}`, i);
  });
}

function thirdSight(): Svg {
  const id = `sfl-dg-clip-${++clipSeq}`;
  const left = { x: 8, y: 30, w: 186, h: 158 };
  const right = { x: 206, y: 30, w: 186, h: 158 };
  const lc = { x: left.x + left.w / 2, y: left.y + left.h / 2 };
  const rc = { x: right.x + right.w / 2, y: right.y + right.h / 2 };
  return svg(
    'Diagram: close up, circles look like straight lines. Three lines from stars spread round the sky cross in a small, round area; three from stars bunched together cross in a long, thin one.',
    s(
      'defs',
      {},
      s('clipPath', { id: `${id}-l` }, s('rect', { x: left.x, y: left.y, width: left.w, height: left.h, rx: 6 })),
      s('clipPath', { id: `${id}-r` }, s('rect', { x: right.x, y: right.y, width: right.w, height: right.h, rx: 6 })),
    ),
    s('rect', { class: 'sfl-dg-paper', x: left.x, y: left.y, width: left.w, height: left.h, rx: 6 }),
    s('rect', { class: 'sfl-dg-paper', x: right.x, y: right.y, width: right.w, height: right.h, rx: 6 }),
    s(
      'g',
      { 'clip-path': `url(#${id}-l)` },
      s('ellipse', { class: 'sfl-ch-ellipse', cx: lc.x, cy: lc.y, rx: 21, ry: 19 }),
      ...cockedHat(lc.x, lc.y, [0, 60, 120], [9, -9, 9], 110),
      miniFix(lc.x, lc.y),
    ),
    s(
      'g',
      { 'clip-path': `url(#${id}-r)` },
      s('ellipse', { class: 'sfl-ch-ellipse', cx: rc.x, cy: rc.y, rx: 78, ry: 10, transform: `rotate(-20 ${rc.x} ${rc.y})` }),
      ...cockedHat(rc.x, rc.y, [-12, -20, -28], [8, -8, 8], 120),
      miniFix(rc.x, rc.y),
    ),
    text(lc.x, 20, 'Stars spread round the sky', 'sfl-dg-strong', 'middle'),
    text(rc.x, 20, 'Stars bunched together', 'sfl-dg-strong', 'middle'),
    text(lc.x, 206, 'a small, round crossing', 'sfl-dg-text', 'middle'),
    text(rc.x, 206, 'a long, thin one', 'sfl-dg-text', 'middle'),
  );
}

function ellipsePromise(): Svg {
  const children: SVGElement[] = [];
  // Left: independent errors. 19 of 20 repeats put the truth inside; one does not.
  const cx = 100;
  const cy = 104;
  const rx = 66;
  const ry = 38;
  const rot = (-15 * Math.PI) / 180;
  children.push(s('ellipse', { class: 'sfl-ch-ellipse', cx, cy, rx, ry, transform: `rotate(-15 ${cx} ${cy})` }));
  for (let i = 0; i < 20; i++) {
    const out = i === 19;
    const rr = out ? 1.25 : Math.sqrt((i + 0.5) / 19) * 0.88;
    const t = out ? -0.35 : i * 2.39996;
    const u = rr * Math.cos(t) * rx;
    const v = rr * Math.sin(t) * ry;
    const x = cx + u * Math.cos(rot) - v * Math.sin(rot);
    const y = cy + u * Math.sin(rot) + v * Math.cos(rot);
    children.push(dot(x, y, out ? 'sfl-dg-dot sfl-dg-dot--out' : 'sfl-dg-dot', 3.2));
  }
  children.push(miniFix(cx, cy));
  // Right: a shared error. Every repeat misses the same way, far outside.
  const ex = 256;
  const ey = 78;
  children.push(s('ellipse', { class: 'sfl-ch-ellipse', cx: ex, cy: ey, rx: 26, ry: 15 }));
  children.push(miniFix(ex, ey));
  const tx = 344;
  const ty = 146;
  for (let i = 0; i < 20; i++) {
    const rr = Math.sqrt((i + 0.5) / 20) * 22;
    const t = i * 2.39996;
    children.push(dot(tx + rr * Math.cos(t), ty + rr * 0.75 * Math.sin(t), 'sfl-dg-dot sfl-dg-dot--out', 3));
  }
  children.push(s('path', { class: 'sfl-dg-dotted', d: `M${ex + 22} ${ey + 12}L${tx - 26} ${ty - 16}` }));
  children.push(s('path', { class: 'sfl-dg-move-head', d: `M${tx - 22} ${ty - 13}l-9 -1l5 -7Z` }));
  children.push(text(100, 20, 'Independent random errors', 'sfl-dg-strong', 'middle'));
  children.push(text(100, 172, 'about 19 in 20 inside', 'sfl-dg-text', 'middle'));
  children.push(text(300, 20, 'An error every sight shares', 'sfl-dg-strong', 'middle'));
  children.push(...lines(296, 134, ['the same shift', 'every time'], 'sfl-dg-small', 'end'));
  children.push(text(300, 188, 'all 20 outside; residuals still small', 'sfl-dg-text', 'middle'));
  children.push(text(200, 212, 'Each dot is where the truth was in one of 20 repeats', 'sfl-dg-small', 'middle'));
  return svg(
    'Diagram: with independent random errors, about 19 of 20 repeats put the truth inside the 95 per cent ellipse; with an error every sight shares, every repeat misses in the same direction.',
    ...children,
  );
}

// ---------------------------------------------------------------------------------------

interface Step {
  n: number;
  title: string;
  text: string[];
  diagram: () => Svg;
  links: { story: StoryId; variant?: VariantId; label: string }[];
  simulator?: string;
}

export const STEPS: readonly Step[] = [
  {
    n: 1,
    title: 'Every star is straight overhead somewhere',
    text: [
      'Draw a line from a star to the centre of the Earth. Where it crosses the surface is the star’s ground point: stand there and the star is directly above your head.',
      'An almanac gives the ground point of every navigational star for any moment. It slides west about 15° of longitude an hour as the Earth turns, which is why a sight needs an accurate time.',
    ],
    diagram: groundPoint,
    links: [{ story: 'clock-offset', label: 'What a wrong clock does' }],
  },
  {
    n: 2,
    title: 'Its height puts you on a circle',
    text: [
      'Anywhere else the star stands lower in the sky: the farther you are from its ground point, the lower it is. Measure its height above the horizon with a sextant, take it from 90°, and that is your distance from the ground point, where each minute of arc is one nautical mile.',
      'So one sight says you are somewhere on a circle round the ground point, and nothing about where on it.',
    ],
    diagram: heightCircle,
    links: [{ story: 'single-sight', label: 'See it: one sight' }],
  },
  {
    n: 3,
    title: 'Two circles cross in two places',
    text: [
      'A second star gives a second circle. Two circles cross twice, usually thousands of kilometres apart, and both crossings fit the two sights exactly.',
      'A navigator picks the right one with a rough idea of where the ship is. That is outside knowledge, not something the sights say, so this tool reports both.',
    ],
    diagram: twoCircles,
    links: [{ story: 'two-sight-ambiguous', label: 'See it: two sights' }],
  },
  {
    n: 4,
    title: 'A third star settles it, and checks the others',
    text: [
      'A third circle from another direction passes through only one of the crossings. Close up, the circles are so big that they look like straight lines, called lines of position.',
      'With small measuring errors, three lines make a small triangle rather than a point. Stars spread round the sky give lines that cross squarely; stars bunched in one direction give nearly parallel lines and a long, thin crossing.',
    ],
    diagram: thirdSight,
    links: [
      { story: 'two-sight-ambiguous', variant: 'third-star', label: 'Add a third star' },
      { story: 'good-geometry', label: 'Stars all round' },
      { story: 'clustered-geometry', label: 'Stars bunched together' },
    ],
  },
  {
    n: 5,
    title: 'The ellipse is a promise, with conditions',
    text: [
      'The solver finds the point that best fits all the lines and draws a 95 % ellipse round it. The promise: if the only errors are independent random ones of the stated size, the truth falls inside the ellipse about 95 times in 100.',
      'An error every sight shares, such as a fast watch or an instrument that reads high, breaks that promise. The numbers can then look perfectly healthy while the fix is kilometres out.',
    ],
    diagram: ellipsePromise,
    links: [
      { story: 'philadelphia-stars', label: 'A healthy fix' },
      { story: 'shared-bias', label: 'The same error on every sight' },
    ],
    simulator: 'Test the promise 50 times',
  },
];

export function primerTab(env: LearnEnv): { el: HTMLElement; destroy(): void } {
  const steps = STEPS.map((step) => {
    const actions = step.links.map((l) =>
      button({
        label: l.label,
        icon: 'chevron-right',
        size: 'sm',
        variant: 'outline',
        onClick: () => {
          env.selectTab('stories');
          void env.runStory(l.story, l.variant ?? null, { scroll: true });
        },
      }),
    );
    if (step.simulator) {
      actions.push(
        button({
          label: step.simulator,
          icon: 'speed',
          size: 'sm',
          variant: 'outline',
          tip: 'Opens the Simulator with the healthy-fix scenario and runs it 50 times',
          onClick: () => void env.openSimulator({ story: 'philadelphia-stars', experiment: 50 }),
        }),
      );
    }
    const titleId = `sfl-step-${step.n}-title`;
    return h(
      'li',
      { class: 'sfl-step', 'aria-labelledby': titleId },
      h('div', { class: 'sfl-step__n', 'aria-hidden': 'true' }, String(step.n)),
      h(
        'div',
        { class: 'sfl-step__body' },
        h('h2', { class: 'sfl-step__title', id: titleId }, h('span', { class: 'sf-sr' }, `Step ${step.n}: `), step.title),
        h(
          'div',
          { class: 'sfl-step__grid' },
          h('figure', { class: 'sfl-step__fig' }, step.diagram()),
          h('div', { class: 'sfl-step__text' }, ...step.text.map((p) => h('p', {}, p)), h('div', { class: 'sfl-actions' }, ...actions)),
        ),
      ),
    );
  });
  const el = h(
    'div',
    { class: 'sfl-primer' },
    h(
      'div',
      { class: 'sfl-primer__intro' },
      h('h2', { class: 'sfl-h2' }, 'How celestial navigation works'),
      h('p', { class: 'sfl-lede' }, 'Five steps from one star to a position you can trust, or know not to. The drawings are sketches, not to scale; each step links to a demonstration with real numbers.'),
    ),
    h('ol', { class: 'sfl-steps-list' }, ...steps),
  );
  queueMicrotask(() => env.markReady());
  return { el, destroy: () => el.remove() };
}
