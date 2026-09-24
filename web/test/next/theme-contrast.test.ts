/**
 * WCAG AA contrast of the explorer's design tokens, in every theme (EXPLORER_PLAN §3.6).
 *
 * Parses `src/next/theme/tokens.css` and checks the pairs the interface actually draws:
 * text on its backgrounds at 4.5:1, and essential graphics (focus rings, control
 * borders, body and event lines, the compass ring) at 3:1 (WCAG 2.2, 1.4.3 and 1.4.11).
 * Semi-transparent tokens are composited over what they sit on.
 *
 * The night theme is also checked for what it promises: no blue light at all and a low
 * green channel, so it does not spoil dark adaptation.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(resolve(import.meta.dirname, '../../src/next/theme/tokens.css'), 'utf8');

type Rgba = [number, number, number, number];
type Theme = 'light' | 'dark' | 'night';
const THEMES: Theme[] = ['light', 'dark', 'night'];

function parseBlocks(css: string): Record<Theme | 'shared', Map<string, string>> {
  const out = {
    shared: new Map<string, string>(),
    light: new Map<string, string>(),
    dark: new Map<string, string>(),
    night: new Map<string, string>(),
  };
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1]!.trim();
    const target = /data-theme='dark'/.test(selector)
      ? out.dark
      : /data-theme='night'/.test(selector)
        ? out.night
        : /data-theme='light'/.test(selector)
          ? out.light
          : selector === ':root'
            ? out.shared
            : null;
    if (!target) continue;
    for (const d of m[2]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) target.set(d[1]!, d[2]!.trim());
  }
  return out;
}

const BLOCKS = parseBlocks(CSS);

function token(theme: Theme, name: string): string {
  const value = BLOCKS[theme].get(`--${name}`) ?? BLOCKS.shared.get(`--${name}`);
  if (value === undefined) throw new Error(`token --${name} is not defined for the ${theme} theme`);
  return value;
}

function parseColor(text: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`not a colour: ${text}`);
}

/** `top` painted over an opaque `bottom`. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A colour expression: a token name, or `top>bottom` (top composited over bottom, left to right). */
function resolveColor(theme: Theme, expr: string): Rgba {
  const layers = expr.split('>').map((n) => parseColor(token(theme, n.trim())));
  let color = layers[layers.length - 1]!;
  if (color[3] < 1) throw new Error(`the bottom of ${expr} must be opaque`);
  for (let i = layers.length - 2; i >= 0; i -= 1) color = over(layers[i]!, color);
  return color;
}

const BODIES = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'star'];
const EVENTS = ['rise', 'transit', 'set'];
const PHASES = ['night', 'astronomical', 'nautical', 'civil', 'day'];

/** Text: 4.5:1. */
const TEXT_PAIRS: [string, string][] = [
  ...['chrome-ink', 'chrome-ink-2', 'chrome-ink-3', 'accent-ink'].flatMap((fg): [string, string][] =>
    ['chrome-bg', 'chrome-bg-0', 'chrome-raised'].map((bg): [string, string] => [fg, bg]),
  ),
  ['chrome-ink', 'chrome-raised-2'],
  ['chrome-ink-2', 'chrome-raised-2'],
  ['chrome-ink', 'accent-soft>chrome-bg'],
  ['accent-ink', 'accent-soft>chrome-bg'],
  ['on-accent', 'accent'],
  ['on-caution', 'caution'],
  ['danger', 'chrome-bg'],
  ['ok', 'chrome-bg'],
  ['info', 'chrome-bg'],
  ...['stage-ink', 'stage-ink-2', 'stage-ink-3', 'stage-accent-ink'].flatMap((fg): [string, string][] =>
    ['stage-bg', 'stage-surface', 'stage-surface-2'].map((bg): [string, string] => [fg, bg]),
  ),
  ...PHASES.map((p): [string, string] => [`phase-${p}-ink`, `phase-${p}`]),
  ['compass-label', 'compass-fill>map-land'],
  ['compass-label', 'compass-fill>map-water'],
];

/** Essential graphics: 3:1. */
const GRAPHIC_PAIRS: [string, string][] = [
  ['accent', 'chrome-bg'],
  ['accent', 'chrome-bg-0'],
  ['accent', 'chrome-raised'],
  ['focus', 'chrome-bg'],
  ['focus', 'chrome-bg-0'],
  ['focus', 'chrome-raised'],
  ['stage-focus', 'stage-surface'],
  ['stage-focus', 'stage-bg'],
  ['chrome-line-strong', 'chrome-bg'],
  ['stage-line-strong', 'stage-surface'],
  ['compass-ring', 'compass-fill>map-land'],
  ['compass-ring', 'compass-fill>map-water'],
  ['observer', 'observer-ring'],
  // The lit part of a drawn Moon against its dark part (the panel draws that in chrome-bg-0).
  ['moon-disc', 'chrome-bg-0'],
  ['moon-disc', 'chrome-bg'],
  ...[...BODIES.map((b) => `body-${b}`), ...EVENTS.map((e) => `event-${e}`)].flatMap((fg): [string, string][] => [
    [fg, 'chrome-bg'],
    // On the map and the compass every line is drawn over a halo (casing).
    [fg, 'line-halo>map-land'],
    [fg, 'line-halo>map-water'],
    [fg, 'line-halo>compass-fill>map-land'],
  ]),
];

describe('design tokens: contrast (WCAG 2.2 AA)', () => {
  for (const theme of THEMES) {
    describe(theme, () => {
      it('text reaches 4.5:1 on every background it is drawn on', () => {
        const failures = TEXT_PAIRS.map(([fg, bg]) => ({
          pair: `${fg} on ${bg}`,
          ratio: contrast(resolveColor(theme, fg), resolveColor(theme, bg)),
        })).filter((r) => r.ratio < 4.5);
        expect(failures.map((f) => `${f.pair}: ${f.ratio.toFixed(2)}`)).toEqual([]);
      });

      it('focus rings, control borders, body and event lines reach 3:1', () => {
        const failures = GRAPHIC_PAIRS.map(([fg, bg]) => ({
          pair: `${fg} on ${bg}`,
          ratio: contrast(resolveColor(theme, fg), resolveColor(theme, bg)),
        })).filter((r) => r.ratio < 3);
        expect(failures.map((f) => `${f.pair}: ${f.ratio.toFixed(2)}`)).toEqual([]);
      });

      it('sky phases get lighter from night to day, so their order reads without hue', () => {
        const l = PHASES.map((p) => luminance(resolveColor(theme, `phase-${p}`)));
        for (let i = 1; i < l.length; i += 1) expect(l[i]!).toBeGreaterThan(l[i - 1]!);
      });
    });
  }

  it('night vision: no colour in the night theme emits blue, and green stays low', () => {
    const offenders: string[] = [];
    for (const [name, value] of BLOCKS.night) {
      if (!/^#|^rgba?\(/.test(value)) continue;
      const [r, g, b] = parseColor(value);
      if (b !== 0 || g > 0x50 || g > r) offenders.push(`${name}: ${value}`);
    }
    expect(offenders).toEqual([]);
  });

  it('every theme defines the same colour tokens', () => {
    const names = (t: Theme): string[] => [...BLOCKS[t].keys()].sort();
    expect(names('dark')).toEqual(names('light'));
    expect(names('night')).toEqual(names('light'));
  });
});
