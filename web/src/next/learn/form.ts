/**
 * Labelled form fields for the Simulator, on the design system's inputs. OWNER: learn
 * agent.
 *
 * Every field has a visible label (never a placeholder alone) and optional help text tied
 * to it with `aria-describedby`. Numbers commit on `change` (Enter or leaving the field),
 * not on every keystroke, and a value outside the allowed range is clamped and written
 * back, so what the field shows is always what will be used.
 */

import { h } from '../../dom.js';

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${++seq}`;

export interface FieldBase {
  label: string;
  help?: string;
  /** Stable id (so focus can be restored after a rebuild). */
  id?: string;
}

function wrap(base: FieldBase, control: HTMLElement, id: string, extra?: HTMLElement | null, cls = ''): HTMLElement {
  const helpId = base.help ? `${id}-help` : undefined;
  if (helpId) control.setAttribute('aria-describedby', helpId);
  return h(
    'div',
    { class: `sfl-field ${cls}`.trim() },
    h('label', { class: 'sf-label', for: id }, base.label),
    extra ? h('div', { class: 'sfl-field__row' }, control, extra) : control,
    base.help ? h('p', { class: 'sfl-help', id: helpId }, base.help) : null,
  );
}

export function numberField(
  base: FieldBase & { value: number; step?: number | 'any'; min?: number; max?: number; unit?: string; integer?: boolean },
  onCommit: (value: number) => void,
): HTMLElement {
  const id = base.id ?? nextId('sfl-num');
  const input = h('input', {
    id,
    class: 'sf-input sfl-input sf-num',
    type: 'number',
    inputmode: base.integer ? 'numeric' : 'decimal',
    value: String(base.value),
    step: base.step === undefined ? 'any' : String(base.step),
    min: base.min,
    max: base.max,
  });
  input.addEventListener('change', () => {
    let v = Number(input.value);
    if (input.value.trim() === '' || !Number.isFinite(v)) v = base.value;
    if (base.integer) v = Math.round(v);
    if (base.min !== undefined) v = Math.max(base.min, v);
    if (base.max !== undefined) v = Math.min(base.max, v);
    input.value = String(v);
    onCommit(v);
  });
  return wrap(base, input, id, base.unit ? h('span', { class: 'sfl-unit' }, base.unit) : null);
}

export function textField(base: FieldBase & { value: string; pattern?: RegExp; invalid?: string }, onCommit: (value: string) => void): HTMLElement {
  const id = base.id ?? nextId('sfl-text');
  const input = h('input', { id, class: 'sf-input sfl-input', type: 'text', value: base.value, spellcheck: 'false' });
  const error = h('p', { class: 'sfl-help sfl-help--error', role: 'alert', hidden: true });
  input.addEventListener('change', () => {
    const v = input.value.trim();
    if (base.pattern && !base.pattern.test(v)) {
      input.setAttribute('aria-invalid', 'true');
      error.textContent = base.invalid ?? 'Not a valid value; the previous one is kept.';
      error.hidden = false;
      return;
    }
    input.removeAttribute('aria-invalid');
    error.hidden = true;
    onCommit(v);
  });
  const field = wrap(base, input, id);
  field.append(error);
  return field;
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function selectField<T extends string>(base: FieldBase & { value: T; options: readonly Choice<T>[] }, onChange: (value: T) => void): HTMLElement {
  const id = base.id ?? nextId('sfl-select');
  const select = h('select', { id, class: 'sf-input sfl-input sfl-select' });
  for (const o of base.options) select.append(h('option', { value: o.value, selected: o.value === base.value, disabled: o.disabled }, o.label));
  select.value = base.value;
  select.addEventListener('change', () => onChange(select.value as T));
  return wrap(base, select, id, null, 'sfl-field--select');
}

export function checkField(base: FieldBase & { checked: boolean }, onChange: (checked: boolean) => void): HTMLElement {
  const id = base.id ?? nextId('sfl-check');
  const input = h('input', { id, type: 'checkbox', checked: base.checked });
  const helpId = base.help ? `${id}-help` : undefined;
  if (helpId) input.setAttribute('aria-describedby', helpId);
  input.addEventListener('change', () => onChange(input.checked));
  return h(
    'div',
    { class: 'sfl-field sfl-field--check' },
    h('label', { class: 'sf-check', for: id }, input, h('span', {}, base.label)),
    base.help ? h('p', { class: 'sfl-help', id: helpId }, base.help) : null,
  );
}

/** A titled group of fields (open by default), with a sentence saying what it is. */
export function fieldGroup(title: string, lede: string, tone: 'truth' | 'reported' | 'sky' | 'solver', ...fields: (HTMLElement | null)[]): HTMLElement {
  return h(
    'details',
    { class: `sfl-group-box sfl-group-box--${tone}`, open: true },
    h('summary', {}, h('span', { class: 'sfl-group-box__title' }, title)),
    h('p', { class: 'sfl-help sfl-group-box__lede' }, lede),
    h('div', { class: 'sfl-fields' }, ...fields.filter((f): f is HTMLElement => f !== null)),
  );
}
