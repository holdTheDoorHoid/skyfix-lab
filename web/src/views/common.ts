/** Pieces shared by more than one view. */

import { button, h } from '../dom.js';
import type { Warning } from '../types.js';
import { warningLabel, warningSentence, WARNING_SEVERITY } from '../types.js';

/**
 * Warnings as sentences, each tagged Caution or Note in words as well as colour.
 * `emptyText` is shown rather than an empty box, so "no warnings" is a statement.
 */
export function warningList(warnings: Warning[], emptyText: string | null = null): HTMLElement {
  if (warnings.length === 0) {
    return emptyText ? h('p', { class: 'muted' }, emptyText) : h('div', { class: 'empty' });
  }
  const list = h('ul', { class: 'warnings' });
  for (const w of warnings) {
    const severity = WARNING_SEVERITY[w.code];
    list.appendChild(
      h(
        'li',
        { class: `warning warning-${severity}` },
        h('span', { class: 'warning-tag' }, warningLabel(w)),
        h('span', { class: 'warning-code' }, w.code),
        h('span', { class: 'warning-text' }, warningSentence(w)),
      ),
    );
  }
  return list;
}

export function panel(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return h('section', { class: 'panel' }, h('h2', {}, title), ...children.filter(Boolean));
}

export function subPanel(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return h('div', { class: 'subpanel' }, h('h3', {}, title), ...children.filter(Boolean));
}

/** A short explanatory sentence under a heading. Never a tooltip-only explanation. */
export function note(text: string): HTMLElement {
  return h('p', { class: 'note' }, text);
}

export function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url }) as HTMLAnchorElement;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept: string, onLoad: (name: string, text: string) => void): void {
  const input = h('input', { type: 'file', accept, hidden: true }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    file.text().then((text) => onLoad(file.name, text));
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

export function toolbar(...children: (Node | null)[]): HTMLElement {
  return h('div', { class: 'toolbar' }, ...children.filter(Boolean));
}

export { button };
