/**
 * The print preview of Navigate's printables (worksheets, the plotting sheet, the star
 * finder): a dialog over the page showing the sheets as they will print, with Print and
 * Close. OWNER: navigate2 agent (expansion programme).
 *
 * On screen the sheets take the theme (the night theme stays red on black: no white
 * light); on paper print.css makes them black on white, one sheet per page, and hides
 * everything else (`<html data-print-view="navigate-sheet">` while the dialog is open, the
 * Almanac's mechanism). Keyboard: focus goes to Print, Tab stays in the dialog, Esc closes,
 * and focus returns to the button that opened it.
 */

import '../print.css';
import { h } from '../../../dom.js';
import { icon } from '../../theme/icons.js';
import { btn } from '../ui.js';

const PRINT_VIEW = 'navigate-sheet';

export interface PrintPreview {
  el: HTMLElement;
  close(): void;
}

let open: PrintPreview | null = null;

/** Open the preview of `pages` (each a `.sfn-sheet` element). Only one is open at a time. */
export function openPrintPreview(title: string, pages: HTMLElement[], note?: string): PrintPreview {
  open?.close();
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const html = document.documentElement;
  const previous = html.dataset.printView;
  html.dataset.printView = PRINT_VIEW;
  const titleId = `sfn-print-title-${Math.random().toString(36).slice(2, 8)}`;
  const print = btn('Print', () => window.print(), { variant: 'primary', tip: 'Black on white, one sheet per page (A4 or US Letter)' });
  const closeButton = btn('Close', () => preview.close(), { variant: 'ghost', icon: 'close' });
  const root = h(
    'div',
    { class: 'sfn-print-root', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h(
      'div',
      { class: 'sfn-print__toolbar' },
      h('h2', { class: 'sfn-print__title', id: titleId }, icon('list'), title),
      h('p', { class: 'sfn-print__note' }, note ?? `${pages.length} sheet${pages.length === 1 ? '' : 's'}; they print black on white, one to a page.`),
      h('div', { class: 'sfn-print__actions' }, print, closeButton),
    ),
    h('div', { class: 'sfn-print__pages' }, ...pages),
  );
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      preview.close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  root.addEventListener('keydown', onKey);
  document.body.append(root);
  const preview: PrintPreview = {
    el: root,
    close() {
      root.removeEventListener('keydown', onKey);
      root.remove();
      if (html.dataset.printView === PRINT_VIEW) {
        if (previous === undefined) delete html.dataset.printView;
        else html.dataset.printView = previous;
      }
      if (open === preview) open = null;
      opener?.focus({ preventScroll: true });
    },
  };
  open = preview;
  print.focus();
  return preview;
}

/** A sheet: one printed page with its heading and the honesty line at the foot. */
export function sheet(title: string, subtitle: string, kind: 'simulated' | 'real' | null, ...content: (Node | string | null)[]): HTMLElement {
  return h(
    'section',
    { class: 'sfn-sheet' },
    h(
      'header',
      { class: 'sfn-sheet__head' },
      h('h3', { class: 'sfn-sheet__title' }, title),
      h('p', { class: 'sfn-sheet__sub' }, subtitle, kind ? h('span', { class: 'sfn-sheet__kind' }, kind === 'simulated' ? 'SIMULATED' : 'REAL') : null),
    ),
    ...content.filter((c): c is Node | string => c !== null),
    h('footer', { class: 'sfn-sheet__foot' }, 'SkyFix Lab · Simulation and analysis workbench. Not a navigation instrument.'),
  );
}
