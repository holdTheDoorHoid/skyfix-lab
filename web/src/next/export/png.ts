/**
 * A chart as a picture: an SVG drawn by a view, turned into a PNG with a caption strip
 * underneath (what the chart is, for where and when, how far to trust it, and where it came
 * from). OWNER: charts2 agent (expansion programme Q5); shared by any view that saves a
 * picture of an SVG.
 *
 *   const blob = await svgToPng(svg, { title, lines: [place, 'Clear-sky estimate; clouds not modelled.'] });
 *   saveBlob(blob, 'skyfix-solar-2026.png');           // export/csv.ts
 *   await shareFile(blob, 'skyfix-solar-2026.png', title);
 *
 * How: the SVG is copied into an off-screen holder that carries the **light** theme's design
 * tokens (read from the page's own stylesheet, so nothing is duplicated here), every mark's
 * computed paint and type is written onto the copy (an SVG drawn as an image cannot see the
 * page's stylesheets), the page's own Inter and JetBrains Mono files are embedded for the
 * characters used, and the result is drawn on a canvas at twice the size with the caption
 * below. Pictures are always in the light theme, whatever is on screen, so they read on
 * paper and in a message. No network: the fonts are the ones the page already loaded.
 */

// ---------------------------------------------------------------------------------------
// Pure parts (tested in node)

/** The SVG properties copied from the computed style onto each element of the copy. */
export const PAINT_PROPERTIES = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'opacity',
  'visibility',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant-numeric',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'text-decoration',
  'paint-order',
  'shape-rendering',
] as const;

/** Code point ranges of a CSS `unicode-range` value (`U+0000-00FF,U+0131,U+04??`). */
export function parseUnicodeRange(value: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of value.split(',')) {
    const m = /^\s*U\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
    if (!m) continue;
    const a = m[1]!;
    if (a.includes('?')) {
      out.push([Number.parseInt(a.replace(/\?/g, '0'), 16), Number.parseInt(a.replace(/\?/g, 'f'), 16)]);
    } else {
      const lo = Number.parseInt(a, 16);
      out.push([lo, m[2] ? Number.parseInt(m[2], 16) : lo]);
    }
  }
  return out;
}

/** Whether any of `codePoints` falls in `ranges` (an empty range list covers everything). */
export function rangeCovers(ranges: readonly [number, number][], codePoints: ReadonlySet<number>): boolean {
  if (ranges.length === 0) return true;
  for (const cp of codePoints) for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** The code points of some text. */
export function codePointsOf(...texts: string[]): Set<number> {
  const out = new Set<number>();
  for (const t of texts) for (const ch of t) out.add(ch.codePointAt(0)!);
  return out;
}

export interface CaptionLine {
  readonly text: string;
  readonly role: 'title' | 'line' | 'footer';
}

/** What a caption needs: the text of each line and how wide it may run. */
export interface CaptionInput {
  readonly title: string;
  readonly lines: readonly string[];
  readonly footer: string;
}

/** The caption's type, in CSS pixels (the canvas is scaled). */
export const CAPTION_TYPE = {
  title: { size: 15, weight: 620, lineHeight: 21, color: '--stage-ink' },
  line: { size: 12.5, weight: 430, lineHeight: 18, color: '--stage-ink-2' },
  footer: { size: 11, weight: 430, lineHeight: 16, color: '--stage-ink-3' },
} as const;

/**
 * Break the caption into lines no wider than `maxWidth`, by words (a word longer than the
 * width stands alone). `measure(text, role)` gives a line's width in the same units.
 */
export function layoutCaption(
  input: CaptionInput,
  maxWidth: number,
  measure: (text: string, role: CaptionLine['role']) => number,
): CaptionLine[] {
  const out: CaptionLine[] = [];
  const wrap = (text: string, role: CaptionLine['role']): void => {
    const words = text.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next, role) > maxWidth) {
        out.push({ text: line, role });
        line = word;
      } else line = next;
    }
    if (line) out.push({ text: line, role });
  };
  wrap(input.title, 'title');
  for (const l of input.lines) wrap(l, 'line');
  wrap(input.footer, 'footer');
  return out;
}

/** The height of a laid-out caption, CSS pixels. */
export function captionHeight(lines: readonly CaptionLine[]): number {
  let hgt = 0;
  lines.forEach((l, i) => {
    hgt += CAPTION_TYPE[l.role].lineHeight;
    // A little air before the footer.
    if (l.role === 'footer' && i > 0 && lines[i - 1]!.role !== 'footer') hgt += 6;
  });
  return hgt;
}

/** The line every picture ends with. */
export const PICTURE_FOOTER =
  'SkyFix Lab · holdthedoorhoid.github.io/skyfix-lab · a simulation and analysis workbench, not a navigation instrument';

/** Base64 of bytes, in chunks (no stack overflow on large fonts). */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------------------
// The light theme's tokens, read from the page's stylesheets

const LIGHT_SELECTOR = /\[data-theme=["']?light["']?\]/;

function eachRule(doc: Document, visit: (rule: CSSRule) => void): void {
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      visit(rule);
      const inner = (rule as CSSGroupingRule).cssRules;
      if (inner) walk(inner);
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a stylesheet from another origin
    }
    walk(rules);
  }
}

/**
 * Every custom property the light theme sets (`--stage-ink: #17202a`, …), from the rule
 * `:root[data-theme='light']` of the design tokens. Empty when the stylesheets cannot be read.
 */
export function lightTokens(doc: Document = document): Map<string, string> {
  const out = new Map<string, string>();
  eachRule(doc, (rule) => {
    const style = (rule as CSSStyleRule).style;
    const selector = (rule as CSSStyleRule).selectorText;
    if (!style || typeof selector !== 'string' || !LIGHT_SELECTOR.test(selector)) return;
    for (let i = 0; i < style.length; i += 1) {
      const name = style[i]!;
      if (name.startsWith('--')) out.set(name, style.getPropertyValue(name).trim());
    }
  });
  return out;
}

/** Give an element the light theme's tokens (its descendants resolve `var(--…)` to them). */
export function applyTokens(el: HTMLElement, tokens: ReadonlyMap<string, string>): void {
  for (const [name, value] of tokens) el.style.setProperty(name, value);
  el.style.setProperty('color-scheme', 'light');
}

// ---------------------------------------------------------------------------------------
// Fonts

const FONT_FAMILIES = /Inter Variable|JetBrains Mono Variable/i;
const fontCache = new Map<string, Promise<string | null>>();

async function fontDataUrl(url: string): Promise<string | null> {
  let hit = fontCache.get(url);
  if (!hit) {
    hit = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        return `data:font/woff2;base64,${base64(bytes)}`;
      } catch {
        return null;
      }
    })();
    fontCache.set(url, hit);
  }
  return hit;
}

/**
 * `@font-face` rules with the page's own font files embedded, for the subsets that hold
 * any of `codePoints`. Empty when the files cannot be read (the picture then uses the
 * system's sans-serif: the same words, a different face).
 */
export async function embeddedFontCss(codePoints: ReadonlySet<number>, doc: Document = document): Promise<string> {
  const faces: { family: string; style: string; weight: string; range: string; url: string }[] = [];
  eachRule(doc, (rule) => {
    if (!(typeof CSSFontFaceRule !== 'undefined' && rule instanceof CSSFontFaceRule)) return;
    const st = rule.style;
    const family = st.getPropertyValue('font-family').trim();
    if (!FONT_FAMILIES.test(family)) return;
    const range = st.getPropertyValue('unicode-range').trim();
    if (!rangeCovers(parseUnicodeRange(range), codePoints)) return;
    const m = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(st.getPropertyValue('src'));
    if (!m) return;
    const base = rule.parentStyleSheet?.href ?? doc.baseURI;
    faces.push({
      family,
      style: st.getPropertyValue('font-style').trim() || 'normal',
      weight: st.getPropertyValue('font-weight').trim() || '400',
      range,
      url: new URL(m[1]!, base).href,
    });
  });
  const css: string[] = [];
  for (const f of faces) {
    const data = await fontDataUrl(f.url);
    if (!data) continue;
    css.push(
      `@font-face{font-family:${f.family};font-style:${f.style};font-weight:${f.weight};` +
        `src:url(${data}) format("woff2");${f.range ? `unicode-range:${f.range};` : ''}}`,
    );
  }
  return css.join('\n');
}

// ---------------------------------------------------------------------------------------
// The SVG copy

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An off-screen holder with the light theme's tokens, for computing styles on copies. */
function holder(doc: Document, width: number): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'sfc sf-on-stage sfx-export-holder';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = `position:fixed;left:-100000px;top:0;width:${Math.max(1, Math.ceil(width))}px;height:auto;overflow:visible;padding:0;pointer-events:none;contain:layout style;`;
  applyTokens(el, lightTokens(doc));
  doc.body.append(el);
  return el;
}

/**
 * A standalone copy of `svg` in the light theme: every element's computed paint and type
 * written onto it, marks the reader cannot see (hover layers, hidden tooltips) left out.
 * Returns the copy's markup and its size.
 */
export async function standaloneSvg(
  svg: SVGSVGElement,
  options: { extraText?: string } = {},
): Promise<{ markup: string; width: number; height: number }> {
  const doc = svg.ownerDocument;
  const box = svg.getBoundingClientRect();
  const width = Number(svg.getAttribute('width')) || box.width || 600;
  const height = Number(svg.getAttribute('height')) || box.height || 400;
  const hold = holder(doc, width);
  try {
    const copy = svg.cloneNode(true) as SVGSVGElement;
    hold.append(copy);
    const elements = ([copy, ...Array.from(copy.querySelectorAll('*'))] as Element[]).filter(
      (el): el is SVGElement => el instanceof SVGElement,
    );
    // Read every computed style first, then write: a class taken off a parent would change
    // what its children compute (`--c` on a series group, for example).
    const gone: Element[] = [];
    const styles: [SVGElement, string[]][] = [];
    for (const el of elements) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none') {
        gone.push(el);
        continue;
      }
      styles.push([el, PAINT_PROPERTIES.map((prop) => cs.getPropertyValue(prop))]);
    }
    for (const [el, values] of styles) {
      PAINT_PROPERTIES.forEach((prop, i) => {
        if (values[i]) el.style.setProperty(prop, values[i]!);
      });
    }
    for (const [el] of styles) {
      el.removeAttribute('tabindex');
      el.removeAttribute('class');
      el.removeAttribute('role');
    }
    for (const el of gone) el.remove();
    copy.setAttribute('xmlns', SVG_NS);
    copy.setAttribute('width', String(width));
    copy.setAttribute('height', String(height));
    if (!copy.getAttribute('viewBox')) copy.setAttribute('viewBox', `0 0 ${width} ${height}`);
    copy.style.setProperty('overflow', 'hidden');
    const fonts = await embeddedFontCss(codePointsOf(copy.textContent ?? '', options.extraText ?? ''), doc);
    if (fonts) {
      const style = doc.createElementNS(SVG_NS, 'style');
      style.textContent = fonts;
      copy.insertBefore(style, copy.firstChild);
    }
    return { markup: new XMLSerializer().serializeToString(copy), width, height };
  } finally {
    hold.remove();
  }
}

async function loadImage(markup: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    img.src = url;
    await img.decode();
    // Embedded fonts can finish a moment after decoding in some engines.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return img;
  } finally {
    // Safe once decoded: the canvas draws from the decoded image.
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }
}

export interface PictureOptions {
  /** The chart's name: the caption's first line. */
  readonly title: string;
  /** Place and time, what the numbers are, how far to trust them. */
  readonly lines: readonly string[];
  /** Default `PICTURE_FOOTER`. */
  readonly footer?: string;
  /** Device pixels per CSS pixel (default 2). */
  readonly scale?: number;
}

/** The chart `svg` as a PNG in the light theme, with the caption strip underneath. */
export async function svgToPng(svg: SVGSVGElement, options: PictureOptions): Promise<Blob> {
  const doc = svg.ownerDocument;
  const footer = options.footer ?? PICTURE_FOOTER;
  const captionText = [options.title, ...options.lines, footer].join(' ');
  const { markup, width, height } = await standaloneSvg(svg, { extraText: captionText });
  const img = await loadImage(markup);
  const tokens = lightTokens(doc);
  const token = (name: string, fallback: string): string => tokens.get(name) || fallback;
  const scale = options.scale ?? 2;
  const pad = 16;
  const W = width + 2 * pad;

  const canvas = doc.createElement('canvas');
  const measureCtx = canvas.getContext('2d');
  if (!measureCtx) throw new Error('This browser cannot draw pictures (no canvas).');
  const uiFont = getComputedStyle(doc.documentElement).getPropertyValue('--font-ui').trim() || 'system-ui, sans-serif';
  const fontOf = (role: CaptionLine['role']): string => {
    const t = CAPTION_TYPE[role];
    return `${t.weight} ${t.size}px ${uiFont}`;
  };
  try {
    await Promise.all((['title', 'line', 'footer'] as const).map((r) => doc.fonts?.load(fontOf(r), captionText)));
  } catch {
    // The system font will do.
  }
  const lines = layoutCaption({ title: options.title, lines: options.lines, footer }, W - 2 * pad, (text, role) => {
    measureCtx.font = fontOf(role);
    return measureCtx.measureText(text).width;
  });
  const capH = captionHeight(lines);
  const H = pad + height + 14 + capH + pad;
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = token('--stage-surface', '#ffffff');
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, pad, pad, width, height);

  // The caption strip: a rule, then the lines.
  let y = pad + height + 8;
  ctx.fillStyle = token('--stage-line', '#d4dbe1');
  ctx.fillRect(pad, y, W - 2 * pad, 1);
  y += 6;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    const t = CAPTION_TYPE[line.role];
    if (line.role === 'footer' && i > 0 && lines[i - 1]!.role !== 'footer') y += 6;
    y += t.lineHeight;
    ctx.font = fontOf(line.role);
    ctx.fillStyle = token(t.color, '#17202a');
    ctx.fillText(line.text, pad, y - (t.lineHeight - t.size) / 2 - 1);
  });

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The picture could not be made.'))), 'image/png');
  });
}

// ---------------------------------------------------------------------------------------
// Sharing

type ShareNavigator = Navigator & {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
};

/** Whether this device can hand a PNG file to its share sheet (Web Share with files). */
export function canShareFiles(nav: ShareNavigator | undefined = globalThis.navigator as ShareNavigator | undefined): boolean {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  try {
    const probe = new File([new Uint8Array(8)], 'probe.png', { type: 'image/png' });
    return nav.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * Hand a file to the device's share sheet. `shared`, `cancelled` (the person closed the
 * sheet: not a failure) or `unsupported`; other failures throw.
 */
export async function shareFile(
  blob: Blob,
  name: string,
  title: string,
  nav: ShareNavigator | undefined = globalThis.navigator as ShareNavigator | undefined,
): Promise<'shared' | 'cancelled' | 'unsupported'> {
  if (!nav || typeof nav.share !== 'function') return 'unsupported';
  const file = new File([blob], name, { type: blob.type || 'image/png' });
  if (typeof nav.canShare === 'function' && !nav.canShare({ files: [file] })) return 'unsupported';
  try {
    await nav.share({ files: [file], title });
    return 'shared';
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
    throw error;
  }
}
