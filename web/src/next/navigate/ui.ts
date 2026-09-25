/**
 * Form and layout helpers for the Navigate view, on top of the design system's primitives.
 * OWNER: navigate agent.
 *
 * Accessibility rules every field follows (EXPLORER_PLAN 3.6, task brief):
 * - a visible label, always (never a placeholder-only field), with the navigator's term
 *   beside the plain words;
 * - help text and the error message sit next to the field and are linked to it with
 *   `aria-describedby`; an invalid field carries `aria-invalid`;
 * - everything works from the keyboard: native inputs, selects and buttons only.
 *
 * A "parsed field" keeps the person's own text while they type, commits on change (blur or
 * Enter), prints the parser's sentence when the text is not understood, and re-reads the
 * state whenever it changes from elsewhere (an example loaded, a file opened) unless the
 * person is typing in it.
 */

import { h } from '../../dom.js';
import type { Warning } from '../../types.js';
import { WARNING_CODES, warningLabel, warningSentence, WARNING_SEVERITY } from '../../types.js';
import type { SightWarning } from '../engine/types.js';
import type { Store } from '../state.js';
import { icon, type IconName } from '../theme/icons.js';
import { button, type ButtonOptions } from '../theme/primitives.js';
import type { Parsed } from './parse.js';

type Child = Node | string | number | null | undefined | false;

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function btn(label: string, onClick: () => void, options: Omit<ButtonOptions, 'label' | 'onClick'> = {}): HTMLButtonElement {
  return button({ size: 'sm', ...options, label, onClick: () => onClick() });
}

export interface FieldParts {
  el: HTMLElement;
  setError(message: string | null): void;
  setHelp(text: string | null): void;
  /** Change the label's words (navigate2: "(UTC)" or "(UT)" after the clock's scale). */
  setLabel(text: string): void;
}

export interface FieldOptions {
  /** The navigator's term, shown after the plain words ("Hs"). */
  term?: string;
  help?: string | null;
  class?: string;
  /**
   * Shown beside the label, outside it (navigate2: the ±ΔT chip beside a time), so it is not
   * read as part of the control's name.
   */
  aside?: HTMLElement;
}

/** A labelled field around `control` with help and error text linked to it. */
export function field(labelText: string, control: HTMLElement, options: FieldOptions = {}): FieldParts {
  const id = control.id || uid('sfn-f');
  control.id = id;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const help = h('p', { class: 'sfn-help', id: helpId, hidden: !options.help }, options.help ?? '');
  const error = h('p', { class: 'sfn-error', id: errorId, hidden: true });
  control.setAttribute('aria-describedby', `${helpId} ${errorId}`);
  const words = document.createTextNode(labelText);
  const label = h('label', { for: id }, words, options.term ? h('span', { class: 'sfn-term' }, ` · ${options.term}`) : null);
  const el = h(
    'div',
    { class: `sfn-field${options.class ? ` ${options.class}` : ''}` },
    options.aside ? h('div', { class: 'sfn-field__head' }, label, options.aside) : label,
    control,
    help,
    error,
  );
  return {
    el,
    setLabel(text) {
      if (words.data !== text) words.data = text;
    },
    setError(message) {
      error.textContent = message ?? '';
      error.hidden = !message;
      if (message) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    },
    setHelp(text) {
      help.textContent = text ?? '';
      help.hidden = !text;
    },
  };
}

export function textInput(attrs: { value?: string; placeholder?: string; inputmode?: string; size?: number; class?: string } = {}): HTMLInputElement {
  const input = h('input', {
    type: 'text',
    class: `sf-input sfn-input${attrs.class ? ` ${attrs.class}` : ''}`,
    value: attrs.value ?? '',
    placeholder: attrs.placeholder,
    inputmode: attrs.inputmode,
    autocomplete: 'off',
    spellcheck: 'false',
    size: attrs.size,
  });
  return input;
}

export interface Option<T extends string> {
  value: T;
  label: string;
  group?: string;
}

export function selectInput<T extends string>(options: readonly Option<T>[], value: T): HTMLSelectElement {
  const el = h('select', { class: 'sf-input sfn-select' });
  let group: HTMLOptGroupElement | null = null;
  for (const o of options) {
    const option = h('option', { value: o.value }, o.label);
    if (o.group) {
      if (!group || group.label !== o.group) {
        group = h('optgroup', { label: o.group });
        el.appendChild(group);
      }
      group.appendChild(option);
    } else {
      group = null;
      el.appendChild(option);
    }
  }
  el.value = value;
  return el;
}

/** A check box with its label (and an optional note under it). */
export function checkbox(labelText: string, checked: boolean, onChange: (checked: boolean) => void, note?: string): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  const el = h(
    'label',
    { class: 'sf-check sfn-check' },
    input,
    h('span', {}, labelText, note ? h('span', { class: 'sfn-check__note' }, note) : null),
  );
  return { el, input };
}

export interface Card {
  el: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
}

export function card(title: string, options: { term?: string; aside?: Child; class?: string; level?: 2 | 3; iconName?: IconName } = {}): Card {
  const tag = options.level === 3 ? 'h3' : 'h2';
  const titleId = uid('sfn-card');
  const head = h(
    'div',
    { class: 'sfn-card__head' },
    h(tag, { class: 'sfn-card__title', id: titleId }, options.iconName ? icon(options.iconName) : null, title, options.term ? h('span', { class: 'sfn-term' }, ` · ${options.term}`) : null),
    options.aside ?? null,
  );
  const body = h('div', { class: 'sfn-card__body' });
  const el = h('section', { class: `sf-card sfn-card${options.class ? ` ${options.class}` : ''}`, 'aria-labelledby': titleId }, head, body);
  return { el, head, body };
}

/** Key/value rows (a description list). */
export function facts(rows: readonly (readonly [Child, Child] | null | false)[]): HTMLElement {
  const dl = h('dl', { class: 'sfn-facts' });
  for (const row of rows) {
    if (!row) continue;
    dl.appendChild(h('div', { class: 'sfn-facts__row' }, h('dt', {}, row[0]), h('dd', {}, row[1])));
  }
  return dl;
}

export function para(text: Child, cls = 'sfn-note'): HTMLElement {
  return h('p', { class: cls }, text);
}

/** A notice block (info, caution or error) with its icon: never colour alone. */
export function notice(level: 'info' | 'caution' | 'error', ...content: Child[]): HTMLElement {
  const name: IconName = level === 'info' ? 'info' : 'caution';
  return h('div', { class: `sf-notice sf-notice--${level} sfn-notice`, role: level === 'error' ? 'alert' : 'note' }, icon(name), h('div', {}, ...content));
}

function isKnownWarning(w: SightWarning | Warning): w is Warning {
  return (WARNING_CODES as readonly string[]).includes(w.code);
}

/** Warnings as sentences, each tagged Caution or Note in words, with its code. */
export function warningList(warnings: readonly (Warning | SightWarning)[], emptyText: string | null = null): HTMLElement {
  const unique: (Warning | SightWarning)[] = [];
  const seen = new Set<string>();
  for (const w of warnings) {
    const key = JSON.stringify(w);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(w);
    }
  }
  if (unique.length === 0) return h('p', { class: 'sfn-note sfn-muted' }, emptyText ?? '');
  const list = h('ul', { class: 'sfn-warnings' });
  for (const w of unique) {
    const known = isKnownWarning(w);
    const severity = known ? WARNING_SEVERITY[w.code] : 'note';
    list.appendChild(
      h(
        'li',
        { class: `sfn-warning sfn-warning--${severity}` },
        h('span', { class: 'sfn-warning__tag' }, known ? warningLabel(w) : 'Note'),
        h('span', { class: 'sfn-warning__text' }, known ? warningSentence(w) : JSON.stringify(w)),
        h('code', { class: 'sfn-warning__code' }, w.code),
      ),
    );
  }
  return list;
}

export interface ParsedFieldOptions<T> extends FieldOptions {
  placeholder?: string;
  inputmode?: string;
  size?: number;
  parse: (text: string) => Parsed<T>;
  format: (value: T) => string;
  /** The current value in the state. */
  read: () => T;
  /** Store a parsed value. */
  commit: (value: T) => void;
}

export interface ParsedField {
  el: HTMLElement;
  input: HTMLInputElement;
  parts: FieldParts;
  /** Re-read the state (skipped while the person is typing in it). */
  refresh(force?: boolean): void;
}

export function parsedField<T>(labelText: string, options: ParsedFieldOptions<T>): ParsedField {
  const input = textInput({ value: options.format(options.read()), placeholder: options.placeholder, inputmode: options.inputmode, size: options.size });
  const parts = field(labelText, input, options);
  input.addEventListener('change', () => {
    const result = options.parse(input.value);
    if (!result.ok) {
      parts.setError(result.error);
      return;
    }
    parts.setError(null);
    options.commit(result.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.dispatchEvent(new Event('change'));
  });
  return {
    el: parts.el,
    input,
    parts,
    refresh(force = false) {
      if (!force && document.activeElement === input) return;
      const text = options.format(options.read());
      if (input.value !== text || force) {
        input.value = text;
        parts.setError(null);
      }
    },
  };
}

/** Call `fn` whenever `selector(state)` changes; returns the unsubscribe. */
export function onChange<S extends object, T>(store: Store<S>, selector: (s: S) => T, fn: (value: T) => void): () => void {
  return store.select(selector, (value) => fn(value));
}

/** Debounce a function (the engine runs after typing pauses, not on every key). */
export function debounce(fn: () => void, ms: number): { run(): void; now(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    run() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    now() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      fn();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Download text as a file (never uploaded anywhere). */
export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url });
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Ask for a file and read it as text. */
export function pickFile(accept: string, onLoad: (name: string, text: string) => void): void {
  const input = h('input', { type: 'file', accept, hidden: true });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) void file.text().then((text) => onLoad(file.name, text));
  });
  document.body.appendChild(input);
  input.click();
}

/** Children without the empty ones, for `append` and `replaceChildren`. */
export function kids(...children: (Node | string | null | undefined | false)[]): (Node | string)[] {
  return children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
}
