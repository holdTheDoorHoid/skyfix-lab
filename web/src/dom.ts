/** Tiny DOM helpers. No framework: the whole interface is a few hundred lines of this. */

type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  class?: string;
  id?: string;
  title?: string;
  type?: string;
  value?: string | number;
  href?: string;
  for?: string;
  role?: string;
  step?: string | number;
  min?: string | number;
  max?: string | number;
  rows?: number;
  cols?: number;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  hidden?: boolean;
  list?: string;
  name?: string;
  /** Anything else is written through with `setAttribute` (data-*, aria-*, scope, colspan…). */
  [key: string]: string | number | boolean | undefined;
}

function appendChildren(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  appendChildren(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(
  tag: string,
  attrs: Record<string, string | number | undefined> = {},
  ...children: Child[]
): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    el.setAttribute(key, String(value));
  }
  appendChildren(el, children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** A labelled field: the label is always visible, never a placeholder-only input. */
export function field(labelText: string, control: HTMLElement, help?: string): HTMLElement {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id }, labelText),
    control,
    help ? h('p', { class: 'help' }, help) : null,
  );
}

export function numberInput(
  value: number,
  onChange: (v: number) => void,
  opts: { step?: string; min?: string; max?: string; id?: string } = {},
): HTMLInputElement {
  const input = h('input', {
    type: 'number',
    value: String(value),
    step: opts.step ?? 'any',
    min: opts.min,
    max: opts.max,
    id: opts.id,
  });
  input.addEventListener('change', () => {
    const v = Number(input.value);
    onChange(Number.isFinite(v) ? v : 0);
  });
  return input;
}

export function textInput(
  value: string,
  onChange: (v: string) => void,
  opts: { list?: string; placeholder?: string; id?: string } = {},
): HTMLInputElement {
  const input = h('input', {
    type: 'text',
    value,
    list: opts.list,
    placeholder: opts.placeholder,
    id: opts.id,
  });
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

export function select<T extends string>(
  value: T,
  options: readonly { value: T; label: string }[],
  onChange: (v: T) => void,
  opts: { id?: string } = {},
): HTMLSelectElement {
  const el = h('select', { id: opts.id });
  for (const option of options) {
    el.appendChild(
      h('option', { value: option.value, selected: option.value === value }, option.label),
    );
  }
  el.value = value;
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

export function checkbox(
  value: boolean,
  labelText: string,
  onChange: (v: boolean) => void,
): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: value });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'checkbox' }, input, h('span', {}, labelText));
}

export function button(
  labelText: string,
  onClick: () => void,
  opts: { class?: string; title?: string } = {},
): HTMLButtonElement {
  const el = h('button', { type: 'button', class: opts.class, title: opts.title }, labelText);
  el.addEventListener('click', onClick);
  return el;
}

/** A definition row: term on the left, value on the right, both selectable text. */
export function row(term: string, ...value: Child[]): HTMLElement {
  return h('div', { class: 'kv' }, h('dt', {}, term), h('dd', {}, ...value));
}
