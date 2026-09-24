/**
 * Small DOM primitives for the explorer: buttons, segmented controls, chips, badges,
 * sections, readouts, key/value rows, switches, menus, popovers and tooltips.
 * OWNER: shell-design agent. Styles: components.css. No framework; each function returns
 * plain elements, and anything that listens globally returns its clean-up function.
 *
 * Accessibility rules every primitive follows (EXPLORER_PLAN §3.6):
 * - an icon-only control always has an `aria-label`;
 * - state is exposed with ARIA (`aria-pressed`, `aria-checked`, `aria-expanded`), not
 *   only with colour;
 * - composite widgets (segmented control, menu) use roving focus and arrow keys;
 * - short explanations (`data-tip`) appear on hover and on keyboard focus.
 */

import { h, type Attrs } from '../../dom.js';
import { icon, type IconName } from './icons.js';

type Child = Node | string | number | null | undefined | false;

// ---------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------

export type ButtonVariant = 'secondary' | 'primary' | 'ghost' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonOptions {
  label?: string;
  icon?: IconName;
  /** Icon after the label (a caret, for example). */
  iconAfter?: IconName;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Toggle buttons: sets `aria-pressed`. */
  pressed?: boolean;
  /** Accessible name when the button has no visible label. */
  ariaLabel?: string;
  /** Short explanation shown on hover and focus (see `installTooltips`). */
  tip?: string;
  class?: string;
  attrs?: Attrs;
  onClick?: (event: MouseEvent) => void;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const variant = options.variant ?? 'secondary';
  const size = options.size ?? 'md';
  const iconOnly = !options.label;
  const classes = ['sf-btn', `sf-btn--${variant}`];
  if (size !== 'md') classes.push(`sf-btn--${size}`);
  if (iconOnly) classes.push('sf-btn--icon');
  if (options.class) classes.push(options.class);
  const el = h('button', {
    type: 'button',
    class: classes.join(' '),
    'aria-label': options.ariaLabel,
    'aria-pressed': options.pressed === undefined ? undefined : String(options.pressed),
    'data-tip': options.tip,
    ...options.attrs,
  });
  if (options.icon) el.appendChild(icon(options.icon));
  if (options.label) el.appendChild(h('span', { class: 'sf-btn__label' }, options.label));
  if (options.iconAfter) el.appendChild(icon(options.iconAfter));
  if (iconOnly && !options.ariaLabel && !options.attrs?.['aria-labelledby']) {
    throw new Error('button: an icon-only button needs ariaLabel');
  }
  if (options.onClick) el.addEventListener('click', options.onClick);
  return el;
}

export function iconButton(
  name: IconName,
  ariaLabel: string,
  options: Omit<ButtonOptions, 'icon' | 'label' | 'ariaLabel'> = {},
): HTMLButtonElement {
  return button({ variant: 'ghost', ...options, icon: name, ariaLabel });
}

/** Keep a toggle button's `aria-pressed` in step with a state. */
export function setPressed(el: HTMLElement, pressed: boolean): void {
  el.setAttribute('aria-pressed', String(pressed));
}

// ---------------------------------------------------------------------------------
// Segmented control: a radio group with roving focus
// ---------------------------------------------------------------------------------

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** Show only the icon (the label becomes the accessible name and the tooltip). */
  iconOnly?: boolean;
  tip?: string;
}

export interface SegmentedOptions<T extends string> {
  /** Accessible name of the group. */
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange?: (value: T) => void;
  size?: 'sm' | 'md';
  class?: string;
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  value(): T;
  set(value: T): void;
}

export function segmented<T extends string>(options: SegmentedOptions<T>): Segmented<T> {
  const iconsOnly = options.options.every((o) => o.iconOnly);
  const el = h('div', {
    class: ['sf-seg', options.size === 'sm' ? 'sf-seg--sm' : '', iconsOnly ? 'sf-seg--icons' : '', options.class ?? '']
      .filter(Boolean)
      .join(' '),
    role: 'radiogroup',
    'aria-label': options.label,
  });
  let current = options.value;
  const buttons = options.options.map((o) => {
    const b = h('button', {
      type: 'button',
      class: 'sf-seg__opt',
      role: 'radio',
      'aria-label': o.iconOnly ? o.label : undefined,
      'data-tip': o.tip ?? (o.iconOnly ? o.label : undefined),
      'data-value': o.value,
    });
    if (o.icon) b.appendChild(icon(o.icon));
    if (!o.iconOnly) b.appendChild(h('span', {}, o.label));
    b.addEventListener('click', () => choose(o.value, true));
    el.appendChild(b);
    return b;
  });
  const sync = (): void => {
    buttons.forEach((b, i) => {
      const on = options.options[i]!.value === current;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  const choose = (value: T, notify: boolean): void => {
    if (value === current) return;
    current = value;
    sync();
    if (notify) options.onChange?.(value);
  };
  el.addEventListener('keydown', (event) => {
    const index = buttons.findIndex((b) => b === document.activeElement);
    if (index < 0) return;
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    const target =
      event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : step ? (index + step + buttons.length) % buttons.length : -1;
    if (target < 0) return;
    event.preventDefault();
    buttons[target]!.focus();
    choose(options.options[target]!.value, true);
  });
  sync();
  return { el, value: () => current, set: (value) => choose(value, false) };
}

// ---------------------------------------------------------------------------------
// Chips, swatches, badges
// ---------------------------------------------------------------------------------

export interface ChipOptions {
  label: string;
  /** Leading element: a body glyph, an icon, a swatch. */
  lead?: Node;
  /** Render as a button (selectable) instead of a static label. */
  onClick?: () => void;
  selected?: boolean;
  /** Show a caret: the chip opens a chooser. */
  caret?: boolean;
  tip?: string;
  class?: string;
  attrs?: Attrs;
}

export function chip(options: ChipOptions): HTMLElement {
  const interactive = Boolean(options.onClick) || options.caret;
  const el = h(interactive ? 'button' : 'span', {
    type: interactive ? 'button' : undefined,
    class: `sf-chip${options.class ? ` ${options.class}` : ''}`,
    'aria-pressed': options.selected === undefined || options.caret ? undefined : String(options.selected),
    'aria-haspopup': options.caret ? 'listbox' : undefined,
    'data-tip': options.tip,
    ...options.attrs,
  });
  if (options.lead) el.appendChild(options.lead);
  el.appendChild(h('span', {}, options.label));
  if (options.caret) el.appendChild(icon('chevron-down', { class: 'sf-chip__caret' }));
  if (options.onClick) el.addEventListener('click', options.onClick);
  return el;
}

/** A colour swatch; always place its label next to it. */
export function swatch(color: string): HTMLElement {
  const el = h('span', { class: 'sf-swatch', 'aria-hidden': 'true' });
  el.style.background = color;
  return el;
}

export type BadgeKind = 'wasm' | 'hybrid' | 'mock' | 'simulated' | 'real' | 'soon';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The badge's shape mark: ■ core, ◨ partly mocked, △ mock, ◇ simulated, ● real (as in the workbench). */
function badgeMark(kind: BadgeKind): SVGSVGElement | null {
  const shapes: Partial<Record<BadgeKind, string>> = {
    wasm: 'M1 1h8v8H1Z',
    hybrid: 'M1 1h8v8H1Z',
    mock: 'M5 1.2 9.2 8.8H.8Z',
    simulated: 'M5 .8 9.2 5 5 9.2.8 5Z',
    real: 'M5 1a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
  };
  const d = shapes[kind];
  if (!d) return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  const hollow = kind === 'mock' || kind === 'simulated';
  p.setAttribute('fill', hollow ? 'none' : 'currentColor');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', hollow ? '1.4' : '0');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

const BADGE_TEXT: Record<BadgeKind, string> = {
  wasm: 'WASM core',
  hybrid: 'WASM core, partly mocked',
  mock: 'MOCK engine',
  simulated: 'Simulated',
  real: 'Real',
  soon: 'Soon',
};

/**
 * Engine and session badges, as in the workbench: ■ WASM core, △ MOCK engine,
 * ◇ SIMULATED, ● REAL. Shape and word carry the meaning; colour only reinforces it.
 */
export function badge(kind: BadgeKind, options: { text?: string; short?: string; tip?: string } = {}): HTMLElement {
  const el = h('span', { class: `sf-badge sf-badge--${kind}`, 'data-tip': options.tip, tabindex: options.tip ? 0 : undefined });
  const mark = badgeMark(kind);
  if (mark) el.appendChild(mark);
  const text = options.text ?? BADGE_TEXT[kind];
  if (options.short) {
    // Narrow screens show the short form; assistive technology always gets the full one.
    el.setAttribute('aria-label', text);
    el.append(
      h('span', { class: 'sf-badge__long', 'aria-hidden': 'true' }, text),
      h('span', { class: 'sf-badge__short', 'aria-hidden': 'true' }, options.short),
    );
  } else {
    el.appendChild(h('span', {}, text));
  }
  return el;
}

// ---------------------------------------------------------------------------------
// Layout helpers: sections, readouts, rows
// ---------------------------------------------------------------------------------

export interface SectionParts {
  el: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
}

/** A panel section with a small-caps title, an optional control on the right, and a body. */
export function section(title: string, options: { id?: string; class?: string; aside?: Child; icon?: IconName } = {}): SectionParts {
  const titleId = options.id ? `${options.id}-title` : undefined;
  const head = h(
    'div',
    { class: 'sf-section__head' },
    h('h2', { class: 'sf-section__title', id: titleId }, options.icon ? icon(options.icon) : null, title),
    options.aside ?? null,
  );
  const body = h('div', { class: 'sf-section__body' });
  const el = h(
    'section',
    { class: `sf-section${options.class ? ` ${options.class}` : ''}`, id: options.id, 'aria-labelledby': titleId },
    head,
    body,
  );
  return { el, head, body };
}

export interface ReadoutOptions {
  value: string;
  unit?: string;
  /** Plain words ("Height above horizon"). */
  label: string;
  /** The navigator's term ("altitude"); hidden when navigator terms are off. */
  term?: string;
  tip?: string;
}

/** A big number with its plain-words label and the navigator's term beneath. */
export function readout(options: ReadoutOptions): HTMLElement {
  return h(
    'div',
    { class: 'sf-readout', 'data-tip': options.tip },
    h(
      'div',
      { class: 'sf-readout__value' },
      h('span', { class: 'sf-num' }, options.value),
      options.unit ? h('span', { class: 'sf-readout__unit' }, options.unit) : null,
    ),
    h('div', { class: 'sf-readout__label' }, options.label),
    options.term ? h('div', { class: 'sf-readout__term', 'data-term': '' }, options.term) : null,
  );
}

/** A key/value row: icon, plain-words key, value (monospaced). */
export function kv(iconName: IconName | null, key: Child, value: Child, options: { tip?: string } = {}): HTMLElement {
  return h(
    'div',
    { class: 'sf-kv', 'data-tip': options.tip },
    iconName ? icon(iconName) : h('span', {}),
    h('span', { class: 'sf-kv__k' }, key),
    h('span', { class: 'sf-kv__v' }, value),
  );
}

/** A sky-phase chip: the phase's own colour AND its name. */
export function phaseChip(phase: string, label: string, lead?: Node): HTMLElement {
  return h('span', { class: 'sf-phase-chip', 'data-phase': phase }, lead ?? null, label);
}

// ---------------------------------------------------------------------------------
// Switch rows and menus
// ---------------------------------------------------------------------------------

export interface SwitchOptions {
  label: string;
  checked: boolean;
  note?: string;
  lead?: Node;
  onChange?: (checked: boolean) => void;
}

/** A labelled on/off switch (role="switch"). */
export function switchRow(options: SwitchOptions): HTMLButtonElement {
  const el = h(
    'button',
    { type: 'button', class: 'sf-switch', role: 'switch', 'aria-checked': String(options.checked) },
    options.lead ?? null,
    h(
      'span',
      { class: 'sf-switch__text' },
      options.label,
      options.note ? h('span', { class: 'sf-switch__note' }, options.note) : null,
    ),
    h('span', { class: 'sf-switch__track', 'aria-hidden': 'true' }),
  );
  el.addEventListener('click', () => {
    const next = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', String(next));
    options.onChange?.(next);
  });
  return el;
}

export interface MenuItem<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** A single-choice menu (role="menu" with menuitemradio items and arrow-key focus). */
export function menu<T extends string>(
  label: string,
  items: readonly MenuItem<T>[],
  value: T,
  onChoose: (value: T) => void,
): HTMLElement {
  const el = h('div', { class: 'sf-menu', role: 'menu', 'aria-label': label });
  const buttons = items.map((item) => {
    const b = h(
      'button',
      {
        type: 'button',
        class: 'sf-menu__item',
        role: 'menuitemradio',
        'aria-checked': String(item.value === value),
        tabindex: item.value === value ? 0 : -1,
      },
      h('span', {}, item.label),
      item.hint ? h('span', { class: 'sf-menu__hint' }, item.hint) : null,
      icon('check', { class: 'sf-menu__check' }),
    );
    b.addEventListener('click', () => onChoose(item.value));
    el.appendChild(b);
    return b;
  });
  el.addEventListener('keydown', (event) => {
    const index = buttons.findIndex((b) => b === document.activeElement);
    if (index < 0) return;
    const next =
      event.key === 'ArrowDown'
        ? (index + 1) % buttons.length
        : event.key === 'ArrowUp'
          ? (index - 1 + buttons.length) % buttons.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    buttons[next]!.focus();
  });
  return el;
}

// ---------------------------------------------------------------------------------
// Popovers
// ---------------------------------------------------------------------------------

export type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top-end' | 'top';

export interface PopoverOptions {
  /** Accessible name (the dialog's label). */
  label: string;
  placement?: Placement;
  /** `dialog` (default) or `menu`. */
  role?: 'dialog' | 'menu';
  /** Put the popover on the stage's colours instead of the chrome's. */
  onStage?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  /** Where the popover element lives. Default `document.body`. */
  container?: HTMLElement;
}

export interface Popover {
  el: HTMLElement;
  open(): void;
  close(options?: { returnFocus?: boolean }): void;
  toggle(): void;
  isOpen(): boolean;
  /** Recompute the position (after its content changed size). */
  place(): void;
  destroy(): void;
}

let popoverSeq = 0;

/**
 * A popover anchored to a button: toggles on click, closes on Escape (focus returns to
 * the button) and on a press outside, keeps inside the window, and flips above the
 * anchor when there is no room below.
 */
export function popover(anchor: HTMLElement, content: Node, options: PopoverOptions): Popover {
  const id = `sf-pop-${++popoverSeq}`;
  const el = h('div', {
    class: `sf-popover${options.onStage ? ' sf-on-stage' : ''}`,
    id,
    role: options.role === 'menu' ? undefined : 'dialog',
    'aria-label': options.label,
    hidden: true,
  });
  el.appendChild(content);
  (options.container ?? document.body).appendChild(el);
  anchor.setAttribute('aria-haspopup', options.role === 'menu' ? 'menu' : 'dialog');
  anchor.setAttribute('aria-expanded', 'false');
  anchor.setAttribute('aria-controls', id);

  let open = false;
  const place = (): void => {
    if (!open) return;
    const margin = 8;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const placement = options.placement ?? 'bottom-start';
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let top = placement.startsWith('top') ? a.top - r.height - 6 : a.bottom + 6;
    if (!placement.startsWith('top') && top + r.height > vh - margin && a.top - r.height - 6 > margin) {
      top = a.top - r.height - 6;
    } else if (placement.startsWith('top') && top < margin) {
      top = a.bottom + 6;
    }
    let left = placement.endsWith('end') ? a.right - r.width : placement.endsWith('start') ? a.left : a.left + a.width / 2 - r.width / 2;
    left = Math.max(margin, Math.min(left, vw - r.width - margin));
    top = Math.max(margin, Math.min(top, vh - r.height - margin));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  };
  const onDocPointer = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (target && (el.contains(target) || anchor.contains(target))) return;
    api.close({ returnFocus: false });
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      api.close();
    }
  };
  const onResize = (): void => place();
  const onAnchorClick = (): void => api.toggle();
  anchor.addEventListener('click', onAnchorClick);

  const api: Popover = {
    el,
    open() {
      if (open) return;
      open = true;
      el.hidden = false;
      anchor.setAttribute('aria-expanded', 'true');
      // Fill first (onOpen may draw the content), then measure, then focus.
      options.onOpen?.();
      place();
      requestAnimationFrame(() => el.setAttribute('data-open', ''));
      document.addEventListener('pointerdown', onDocPointer, true);
      el.addEventListener('keydown', onKey);
      window.addEventListener('resize', onResize);
      if (!el.contains(document.activeElement)) {
        const first = el.querySelector<HTMLElement>(
          '[aria-checked="true"], [aria-selected="true"], input:not([type="hidden"]), select, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        );
        first?.focus({ preventScroll: true });
      }
    },
    close({ returnFocus = true } = {}) {
      if (!open) return;
      open = false;
      el.removeAttribute('data-open');
      el.hidden = true;
      anchor.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onDocPointer, true);
      el.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      if (returnFocus) anchor.focus({ preventScroll: true });
      options.onClose?.();
    },
    toggle() {
      if (open) api.close();
      else api.open();
    },
    isOpen: () => open,
    place,
    destroy() {
      api.close({ returnFocus: false });
      anchor.removeEventListener('click', onAnchorClick);
      el.remove();
    },
  };
  return api;
}

// ---------------------------------------------------------------------------------
// Tooltips: one floating element for every [data-tip]
// ---------------------------------------------------------------------------------

export interface TooltipOptions {
  /** Hover delay, ms. Keyboard focus shows the tip at once. */
  delay?: number;
}

/**
 * Show `data-tip` text for any element under `root` on hover (after a short delay) and
 * on keyboard focus. The tip is linked with `aria-describedby` while shown. Returns the
 * clean-up function.
 */
export function installTooltips(root: HTMLElement = document.body, options: TooltipOptions = {}): () => void {
  const delay = options.delay ?? 380;
  const tip = h('div', { class: 'sf-tooltip', role: 'tooltip', id: 'sf-tooltip' });
  document.body.appendChild(tip);
  let target: HTMLElement | null = null;
  let timer = 0;

  const position = (el: HTMLElement): void => {
    const a = el.getBoundingClientRect();
    const r = tip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    let top = a.top - r.height - 8;
    if (top < 6) top = a.bottom + 8;
    let left = a.left + a.width / 2 - r.width / 2;
    left = Math.max(6, Math.min(left, vw - r.width - 6));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  };
  const show = (el: HTMLElement): void => {
    const text = el.dataset.tip;
    if (!text) return;
    target = el;
    tip.textContent = text;
    tip.setAttribute('data-open', '');
    position(el);
    const described = el.getAttribute('aria-describedby') ?? '';
    if (!described.split(' ').includes(tip.id)) el.setAttribute('aria-describedby', `${described} ${tip.id}`.trim());
  };
  const hide = (): void => {
    window.clearTimeout(timer);
    if (target) {
      const rest = (target.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .filter((x) => x && x !== tip.id)
        .join(' ');
      if (rest) target.setAttribute('aria-describedby', rest);
      else target.removeAttribute('aria-describedby');
    }
    target = null;
    tip.removeAttribute('data-open');
  };
  const tipOwner = (node: EventTarget | null): HTMLElement | null =>
    node instanceof Element ? (node.closest('[data-tip]') as HTMLElement | null) : null;

  const onOver = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    const el = tipOwner(event.target);
    if (!el || el === target) return;
    hide();
    timer = window.setTimeout(() => show(el), delay);
  };
  const onOut = (event: PointerEvent): void => {
    const el = tipOwner(event.target);
    if (!el) return;
    const to = event.relatedTarget as Node | null;
    if (to && el.contains(to)) return;
    hide();
  };
  const onFocusIn = (event: FocusEvent): void => {
    const el = tipOwner(event.target);
    if (el && (event.target as Element).matches(':focus-visible')) show(el);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && target) hide();
  };
  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', hide);
  root.addEventListener('pointerdown', hide);
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', hide, true);
  return () => {
    hide();
    root.removeEventListener('pointerover', onOver);
    root.removeEventListener('pointerout', onOut);
    root.removeEventListener('focusin', onFocusIn);
    root.removeEventListener('focusout', hide);
    root.removeEventListener('pointerdown', hide);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', hide, true);
    tip.remove();
  };
}

// ---------------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------------

/** The SkyFix Lab mark: a Sun on the horizon under a star, drawn for this project. */
export function logoMark(size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'sf-brand__mark');
  svg.setAttribute('aria-hidden', 'true');
  const parts: [string, Record<string, string>][] = [
    ['rect', { x: '0.5', y: '0.5', width: '23', height: '23', rx: '6.5', fill: 'var(--chrome-raised)' }],
    ['path', { d: 'M6.2 17.2a5.8 5.8 0 0 1 11.6 0Z', fill: 'var(--accent)' }],
    ['path', { d: 'M3.8 17.4h16.4', stroke: 'var(--chrome-ink)', 'stroke-width': '1.6', 'stroke-linecap': 'round' }],
    [
      'path',
      {
        d: 'M16.6 4.2l.72 1.98 1.98.72-1.98.72-.72 1.98-.72-1.98-1.98-.72 1.98-.72Z',
        fill: 'var(--chrome-ink)',
      },
    ],
  ];
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}
