/**
 * Printing one chart (charts2 agent, expansion programme Q5). OWNER: charts2 agent.
 *
 * A copy of the card goes into a print-only holder at the end of `<body>`, carrying the
 * light theme's design tokens (paper is white whatever the screen shows); while printing,
 * `html.sfc-printing` hides everything else (charts.css, "Print"). The chart scales to the
 * page's width and keeps to one page; a wide chart asks for landscape. The holder is removed
 * after printing (`afterprint`), and before the next print in any case.
 */

import { applyTokens, lightTokens } from '../export/png.js';

const ROOT_CLASS = 'sfc-print-root';
const PRINTING_CLASS = 'sfc-printing';

/** Whether a chart this wide for its height prints better across the page. */
export function wantsLandscape(width: number, height: number): boolean {
  return height > 0 && width / height > 1.15;
}

/** Everything a printed copy must not carry: controls, tooltips, live readouts. */
export const NOT_PRINTED = [
  '.sfc-head-tools',
  '.sfc-tip',
  '.sfc-hover',
  '.sfc-status',
  '.sfc-subtabs',
  '.sfc-controls',
  'select',
  'input',
];

/** Print the card as it is on screen (its chart, or its table), alone. */
export function printCard(card: HTMLElement, options: { landscape?: boolean; title?: string } = {}): void {
  const doc = card.ownerDocument;
  const win = doc.defaultView;
  if (!win || typeof win.print !== 'function') return;
  for (const old of doc.querySelectorAll(`.${ROOT_CLASS}, style[data-sfc-print]`)) old.remove();

  const root = doc.createElement('div');
  // `sf-on-stage`: the design system's --ui-* tokens take the stage's colours, as on screen.
  root.className = `sfc sf-on-stage ${ROOT_CLASS}`;
  root.setAttribute('aria-hidden', 'true');
  applyTokens(root, lightTokens(doc));
  const copy = card.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll(NOT_PRINTED.join(','))) el.remove();
  // Ids must stay unique in the document; the copy is never focused or labelled by id.
  for (const el of copy.querySelectorAll('[id]')) el.removeAttribute('id');
  copy.removeAttribute('aria-labelledby');
  root.append(copy);
  doc.body.append(root);

  const page = doc.createElement('style');
  page.setAttribute('data-sfc-print', '');
  page.textContent = `@page { size: ${options.landscape ? 'landscape' : 'portrait'}; margin: 12mm; }`;
  doc.head.append(page);

  const title = doc.title;
  if (options.title) doc.title = options.title;
  doc.documentElement.classList.add(PRINTING_CLASS);
  const done = (): void => {
    win.removeEventListener('afterprint', done);
    doc.documentElement.classList.remove(PRINTING_CLASS);
    doc.title = title;
    root.remove();
    page.remove();
  };
  win.addEventListener('afterprint', done);
  win.print();
}
