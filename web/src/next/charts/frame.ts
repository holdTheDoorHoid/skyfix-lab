/**
 * Pieces every chart shares: the card with its header and navigation, the chart/table
 * switch, width tracking, the hover tooltip, time buttons that move the whole app, and
 * small SVG builders. OWNER: charts agent.
 *
 * Text from outside (place names, body names, engine messages) always goes in with
 * `textContent`; nothing here builds markup from strings.
 */

import { h, s } from '../../dom.js';
import type { Ctx } from '../component.js';
import type { BodyKind, PhaseEvent } from '../engine/types.js';
import { setTime } from '../playback.js';
import type { Store } from '../state.js';
import { bodyGlyph, drawGlyph, phaseDisc, type GlyphName } from '../theme/glyphs.js';
import { badge, iconButton } from '../theme/primitives.js';
import type { Zone } from '../time.js';
import { fallbackLimbFromUp } from './disc.js';
import { clockUtc, clockZoned } from './format.js';

export type ChartMode = 'chart' | 'table';
export type ChartTab = 'day' | 'year' | 'moon' | 'planets';

/** The Charts view's own interface state (not part of the app's store). */
export interface ChartUi {
  tab: ChartTab;
  mode: ChartMode;
}

export type ChartComponent = (host: HTMLElement, ctx: Ctx, ui: Store<ChartUi>) => { destroy(): void };

// ---------------------------------------------------------------------------------------
// SVG

export function svgEl(tag: string, attrs: Record<string, string | number | undefined> = {}): SVGElement {
  return s(tag, attrs);
}

export function svgText(
  x: number,
  y: number,
  text: string,
  attrs: Record<string, string | number | undefined> = {},
): SVGTextElement {
  const el = s('text', { x: round(x), y: round(y), ...attrs }) as SVGTextElement;
  el.textContent = text;
  return el;
}

export function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Rough text width for layout before the text is in the document (Inter/system UI at `size` px). */
export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += /[ilIj.,:;'’|!]/.test(ch) ? 0.3 : /[mwMW@]/.test(ch) ? 0.9 : /[0-9]/.test(ch) ? 0.6 : 0.58;
  return w * size;
}

/**
 * A label with a surface-coloured pill behind it, legible on any sky colour, optionally led
 * by a body's glyph (in the body's colour: give the pill the body's class in `cls`).
 * `anchor` is the text anchor; returns the group and its box.
 */
export function pill(
  x: number,
  y: number,
  text: string,
  options: { anchor?: 'start' | 'middle' | 'end'; size?: number; cls?: string; glyph?: GlyphName } = {},
): { el: SVGGElement; box: Box } {
  const size = options.size ?? 11;
  const g0 = options.glyph ? size + 3 : 0;
  const w = textWidth(text, size) + 10 + g0;
  const hgt = size + 7;
  const anchor = options.anchor ?? 'middle';
  const left = anchor === 'start' ? x - 5 : anchor === 'end' ? x - w + 5 : x - w / 2;
  const top = y - hgt / 2;
  const g = s('g', { class: `sfc-pill ${options.cls ?? ''}`.trim() }) as SVGGElement;
  g.append(s('rect', { x: round(left), y: round(top), width: round(w), height: round(hgt), rx: hgt / 2 }));
  if (options.glyph) drawGlyph(g, options.glyph, left + 5 + size / 2, y, size);
  g.append(
    svgText(left + 5 + g0, y + size * 0.36, text, {
      'text-anchor': 'start',
      style: `font-size:${size}px`,
    }),
  );
  return { el: g, box: { x: left, y: top, w, h: hgt } };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function overlaps(a: Box, b: Box, pad = 2): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** Keep a box inside `[minX, maxX]` by shifting it. */
export function clampBox(box: Box, minX: number, maxX: number): number {
  if (box.x < minX) return minX - box.x;
  if (box.x + box.w > maxX) return maxX - (box.x + box.w);
  return 0;
}

// ---------------------------------------------------------------------------------------
// Moon glyphs

/**
 * The design system's Moon disc for a principal phase, `2r` across, centred on (x, y) when
 * placed inside a chart's SVG.
 */
export function phaseGlyph(kind: PhaseEvent['kind'], x: number, y: number, r: number, southUp: boolean): SVGSVGElement {
  const k = kind === 'new_moon' ? 0 : kind === 'full_moon' ? 1 : 0.5;
  const el = phaseDisc({ illuminated: k, limbFromUpDeg: fallbackLimbFromUp(kind === 'first_quarter', southUp), size: 2 * r });
  el.setAttribute('x', String(round(x - r)));
  el.setAttribute('y', String(round(y - r)));
  return el;
}

/** A body's glyph in its colour (design system), for legends, readouts and tooltips. */
export function glyph(body: string, kind?: BodyKind, size = 14): SVGSVGElement {
  return bodyGlyph(body, { size, ...(kind ? { kind } : {}) });
}

// ---------------------------------------------------------------------------------------
// Card

export interface Card {
  readonly root: HTMLElement;
  readonly title: HTMLElement;
  readonly subtitle: HTMLElement;
  readonly nav: HTMLElement;
  readonly legend: HTMLElement;
  readonly figure: HTMLElement;
  readonly plot: HTMLElement;
  readonly caption: HTMLElement;
  readonly tableWrap: HTMLElement;
  readonly notes: HTMLElement;
  readonly status: HTMLElement;
}

let idCounter = 0;

export function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function card(kind: string, headingText: string): Card {
  const titleId = uid('sfc-title');
  const title = h('h2', { class: 'sfc-title', id: titleId }, headingText);
  const subtitle = h('p', { class: 'sfc-sub' });
  const nav = h('div', { class: 'sfc-nav', role: 'group', 'aria-label': 'Move through time' });
  const legend = h('div', { class: 'sfc-legend' });
  const plot = h('div', { class: 'sfc-plot' });
  const caption = h('figcaption', { class: 'sfc-caption' });
  const figure = h('figure', { class: 'sfc-figure' }, plot, caption);
  const tableWrap = h('div', { class: 'sfc-table-wrap', hidden: true });
  const notes = h('div', { class: 'sfc-notes' });
  const status = h('p', { class: 'sfc-status', role: 'status', 'aria-live': 'polite' });
  const root = h(
    'section',
    { class: `sfc-card sfc-card--${kind}`, 'aria-labelledby': titleId },
    h('header', { class: 'sfc-head' }, h('div', { class: 'sfc-titles' }, title, subtitle), nav),
    legend,
    figure,
    tableWrap,
    status,
    notes,
  );
  return { root, title, subtitle, nav, legend, figure, plot, caption, tableWrap, notes, status };
}

/**
 * ◀ label ▶ in the card's header, with the design system's buttons. The label is not a live
 * region: during playback it changes every frame. Returns the label element.
 */
export function stepperNav(nav: HTMLElement, prevLabel: string, nextLabel: string, onStep: (dir: -1 | 1) => void): HTMLElement {
  const label = h('span', { class: 'sfc-nav-label' });
  nav.replaceChildren(
    iconButton('chevron-left', prevLabel, { size: 'sm', variant: 'secondary', tip: prevLabel, onClick: () => onStep(-1) }),
    label,
    iconButton('chevron-right', nextLabel, { size: 'sm', variant: 'secondary', tip: nextLabel, onClick: () => onStep(1) }),
  );
  return label;
}

/** The engine badge for a title, when the numbers are not the real core's. */
export function mockBadge(description: string): HTMLElement {
  return badge('mock', { tip: description });
}

/** Show the chart or the table. */
export function applyMode(c: Card, mode: ChartMode): void {
  c.figure.hidden = mode !== 'chart';
  c.tableWrap.hidden = mode !== 'table';
  c.legend.hidden = mode !== 'chart';
}

// ---------------------------------------------------------------------------------------
// Width

/** Call `onWidth` with the element's content width now and whenever it changes. */
export function observeWidth(el: HTMLElement, onWidth: (width: number) => void): () => void {
  let last = -1;
  const report = (w: number): void => {
    const width = Math.floor(w);
    if (width !== last && width > 0) {
      last = width;
      onWidth(width);
    }
  };
  if (typeof ResizeObserver === 'undefined') {
    const handler = (): void => report(el.clientWidth);
    window.addEventListener('resize', handler);
    handler();
    return () => window.removeEventListener('resize', handler);
  }
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) report(entry.contentRect.width);
  });
  ro.observe(el);
  report(el.clientWidth);
  return () => ro.disconnect();
}

// ---------------------------------------------------------------------------------------
// Tooltip

export interface Tooltip {
  show(x: number, y: number, content: Node[]): void;
  hide(): void;
  readonly el: HTMLElement;
}

/** One floating box per plot, placed beside the pointer and kept inside the plot. */
export function tooltip(container: HTMLElement): Tooltip {
  const el = h('div', { class: 'sfc-tip', 'aria-hidden': 'true', hidden: true });
  container.append(el);
  return {
    el,
    show(x, y, content) {
      el.replaceChildren(...content);
      el.hidden = false;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const tw = el.offsetWidth;
      const th = el.offsetHeight;
      let left: number;
      let top: number;
      if (x + 14 + tw <= cw - 4 || x - 14 - tw >= 4) {
        // Beside the pointer.
        left = x + 14 + tw <= cw - 4 ? x + 14 : x - 14 - tw;
        top = Math.max(4, Math.min(ch - th - 4, y - th / 2));
      } else {
        // Too narrow: above the pointer, or below it, so it never hides what is pointed at.
        left = Math.max(4, Math.min(cw - tw - 4, x - tw / 2));
        top = y - 16 - th >= 4 ? y - 16 - th : y + 16;
      }
      el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    },
    hide() {
      el.hidden = true;
    },
  };
}

/** A tooltip row: the body's glyph (or nothing), the value first (strong), then the label. */
export function tipRow(value: string, label: string, lead?: Node | null, extra?: string): HTMLElement {
  return h(
    'div',
    { class: 'sfc-tip-row' },
    lead ?? h('span', { 'aria-hidden': 'true' }),
    h('strong', {}, value),
    h('span', { class: 'sfc-tip-label' }, label),
    extra ? h('span', { class: 'sfc-tip-extra' }, extra) : null,
  );
}

export function tipHead(text: string, sub?: string): HTMLElement {
  return h('div', { class: 'sfc-tip-head' }, h('strong', {}, text), sub ? h('span', {}, sub) : null);
}

// ---------------------------------------------------------------------------------------
// Times that move the app

/**
 * A time in a table: a button that sets the app's time to that instant, showing the local
 * clock with the UTC time as its tooltip and in its accessible name.
 */
export function timeButton(jd: number, zone: Zone, text?: string): HTMLButtonElement {
  const local = clockZoned(jd, zone);
  return timeButtonText(jd, text ?? local.split(' ')[0]!, local, clockUtc(jd));
}

/** `timeButton` with the texts already made (`shown` on the button, both clocks in its name). */
export function timeButtonText(jd: number, shown: string, local: string, utc: string): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'sfc-time',
      'data-jd': String(jd),
      title: `${local} · ${utc} — show this moment`,
      'aria-label': `${local}, ${utc}. Show this moment.`,
    },
    shown,
  );
}

/** One delegated click handler for every `timeButton` inside `root`. */
export function bindTimeButtons(root: HTMLElement, ctx: Ctx): () => void {
  const onClick = (event: Event): void => {
    const target = (event.target as Element | null)?.closest?.('[data-jd]');
    if (!target || !root.contains(target)) return;
    const jd = Number(target.getAttribute('data-jd'));
    if (Number.isFinite(jd)) setTime(ctx.store, jd);
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}

/** A plain table with a caption and a header row. */
export function table(captionText: string, headers: string[], cls = ''): { table: HTMLTableElement; body: HTMLTableSectionElement } {
  const body = h('tbody');
  const t = h(
    'table',
    { class: `sf-table sfc-table ${cls}`.trim() },
    h('caption', {}, captionText),
    h('thead', {}, h('tr', {}, ...headers.map((text) => h('th', { scope: 'col' }, text)))),
    body,
  );
  return { table: t, body };
}

/** Bring the table row for the app's current time into view (when a table is opened). */
export function scrollToCurrent(c: Card): void {
  const row = c.tableWrap.querySelector<HTMLElement>('.sfc-row-current');
  if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
}

/** An in-chart message instead of a picture (engine fault, outside coverage). */
export function message(plot: HTMLElement, text: string): void {
  plot.replaceChildren(h('p', { class: 'sfc-message', role: 'alert' }, text));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
