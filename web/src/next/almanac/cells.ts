/**
 * Table cells shared by the Almanac view's pages: angles aligned as the printed almanac
 * aligns them, times, headings and screen-reader text. OWNER: almanac agents (the daily
 * pages' cells, moved here by almanac2 so the tables share them).
 *
 * Every cell shows the engine's `printed` text; nothing here rounds a number.
 */

import { h } from '../../dom.js';
import type { AlmanacTime } from '../engine/types.js';
import { decParts, ghaParts, timeCellClass, timeCellTitle } from './layout.js';

export type Child = Node | string | null | undefined | false;

export const BANNER = 'Simulation and analysis workbench. Not a navigation instrument.';

export function srOnly(text: string): HTMLElement {
  return h('span', { class: 'alm-sr' }, text);
}

/** `183 12.4` with the degrees right-aligned and the minutes aligned on the point. */
export function ghaCell(printed: string, extra = ''): HTMLTableCellElement {
  const p = ghaParts(printed);
  return h(
    'td',
    { class: `alm-a${extra}` },
    h('span', { class: 'alm-deg' }, p.deg),
    h('span', { class: 'alm-min' }, p.min),
  );
}

/** `N 12 34.5`; with `showDeg` false only the minutes (the printed almanac's style). */
export function decCell(printed: string, showDeg: boolean): HTMLTableCellElement {
  const p = decParts(printed);
  return h(
    'td',
    { class: 'alm-a alm-dec' },
    showDeg ? null : srOnly(`${p.hemisphere} ${p.deg}° `),
    h('span', { class: 'alm-hemi', 'aria-hidden': showDeg ? undefined : 'true' }, showDeg ? p.hemisphere : ''),
    h('span', { class: 'alm-deg', 'aria-hidden': showDeg ? undefined : 'true' }, showDeg ? p.deg : ''),
    h('span', { class: 'alm-min' }, p.min),
  );
}

export function numCell(text: string, cls = 'alm-n'): HTMLTableCellElement {
  return h('td', { class: cls }, text);
}

export function timeCell(t: AlmanacTime): HTMLTableCellElement {
  return h('td', { class: timeCellClass(t), title: timeCellTitle(t) }, t.printed);
}

export function th(text: Child, attrs: Record<string, string | number> = {}): HTMLTableCellElement {
  return h('th', attrs, text);
}

export function caption(text: string): HTMLTableCaptionElement {
  return h('caption', { class: 'alm-sr' }, text);
}

/** The honesty line and page footer every sheet prints. */
export function pageFooter(text: string): HTMLElement {
  return h('footer', { class: 'alm-foot' }, h('span', {}, 'SkyFix Lab'), h('span', {}, BANNER), h('span', {}, text));
}

/** A printed page (one sheet): a heading, the content, the footer. */
export function sheet(
  options: { heading: string; side?: string; right?: Child; label: string; footer: string; mock?: boolean; extraClass?: string },
  ...content: Child[]
): HTMLElement {
  return h(
    'article',
    { class: `alm-page${options.extraClass ? ` ${options.extraClass}` : ''}`, 'aria-label': options.label },
    h(
      'header',
      { class: 'alm-head' },
      h('span', { class: 'alm-head-side' }, options.side ?? ''),
      h('h3', { class: 'alm-head-date' }, options.heading),
      h('span', { class: 'alm-head-ut' }, options.right ?? ''),
      options.mock
        ? h(
            'p',
            { class: 'alm-mock', role: 'note' },
            'MOCK ENGINE: illustrative numbers for interface development, not from the SkyFix Lab numerical core.',
          )
        : null,
    ),
    ...content,
    pageFooter(options.footer),
  );
}

/** A "how to use" paragraph and worked examples, as the view shows them above a table. */
export function howTo(how: string | string[], examples: { title: string; text: string }[] = []): HTMLElement {
  const lines = Array.isArray(how) ? how : [how];
  return h(
    'div',
    { class: 'alm-howto' },
    h('p', {}, h('b', {}, 'How to use. '), lines.join(' ')),
    ...examples.map((e) => h('p', { class: 'alm-example' }, h('b', {}, `${e.title}. `), e.text)),
  );
}

/** The notes a table prints under it. */
export function notesList(notes: readonly string[]): HTMLElement {
  return h('div', { class: 'alm-notes' }, h('ul', {}, ...notes.map((n) => h('li', {}, n))));
}
