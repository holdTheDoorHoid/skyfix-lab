/**
 * The pieces every new Events list is built from: a time button (the date and time; a
 * click sets the explorer's time and selects the body), an event row (the time, a glyph,
 * the title with its badges, the plain sentence, the ±ΔT chip and the calendar button),
 * the list-and-card layout, and a search's status line. OWNER: events2 agent.
 * Styles: events.css (`.sfe-ev2*`, `.sfe-split`, `.sfe-status`).
 */

import { h } from '../../dom.js';
import type { TimeInfo } from '../engine/types.js';
import { dateMedium, dateShort, eventTime } from '../shell/format.js';
import { roundToMinute, UTC_ZONE, type Zone } from '../time.js';
import { uncertaintyChip } from '../time/index.js';
import type { EventItem } from './items.js';
import { progressText, type SearchState } from './search.js';

/** Below this width a card opens under its row instead of beside the list. */
export const INLINE_CARD_PX = 820;

export interface Badge {
  text: string;
  /** `accent` stands out (a supermoon, a graze); `muted` is a quiet fact; default plain. */
  tone?: 'accent' | 'muted' | 'plain';
  tip?: string;
}

/** A date-and-time button: the local date and time (to the minute), UTC on hover. */
export function timeButton(
  jd: number,
  zone: Zone,
  label: string,
  onClick: () => void,
  options: { end?: number | null; className?: string } = {},
): HTMLButtonElement {
  const r = roundToMinute(jd);
  const end = options.end ?? null;
  const span = end !== null ? `${eventTime(jd, zone)}–${eventTime(end, zone)}` : eventTime(jd, zone);
  const b = h(
    'button',
    {
      type: 'button',
      class: `sfe-when ${options.className ?? ''}`.trim(),
      'aria-label': `${label}, ${dateMedium(r, zone)} ${span}. Set the explorer’s time to it.`,
      'data-tip': `${dateMedium(r, UTC_ZONE)} ${eventTime(r, UTC_ZONE)} UTC`,
    },
    h('span', { class: 'sfe-when__date' }, dateShort(r, zone)),
    h('span', { class: 'sfe-when__time' }, span),
  );
  b.addEventListener('click', onClick);
  return b;
}

export interface RowOptions {
  item: EventItem;
  zone: Zone;
  /** A body glyph or an icon. */
  glyph?: Node | null;
  badges?: readonly Badge[];
  /** Show the end time beside the start (an occultation, a transit). */
  showEnd?: boolean;
  onJump(): void;
  /** The ±ΔT chip's information for the event's time (null: no chip). */
  timeInfo?: TimeInfo | null;
  /** The calendar button (addToCalendarButton). */
  add?: HTMLButtonElement | null;
  /** A second line of quiet detail under the sentence. */
  detail?: string | null;
  /** Opens a card: the row's main part is a button that selects it. */
  onSelect?: (() => void) | null;
  /** Greys the row (not seen from here, too near the Sun). */
  dim?: boolean;
  /** `data-*` for tests and screenshots. */
  data?: Record<string, string>;
}

export interface Row {
  el: HTMLLIElement;
  /** The part a card opens under on a narrow stage. */
  anchor: HTMLElement;
  setNext(on: boolean): void;
  setSelected(on: boolean): void;
}

/** One event in a list. */
export function eventRow(o: RowOptions): Row {
  const { item } = o;
  const title = h(
    'span',
    { class: 'sfe-ev2__title' },
    h('span', { class: 'sfe-ev2__name' }, item.title),
    ...(o.badges ?? []).map((b) =>
      h('span', { class: `sfe-badge sfe-badge--${b.tone ?? 'plain'}`, 'data-tip': b.tip, tabindex: b.tip ? 0 : undefined }, b.text),
    ),
  );
  const words = h('span', { class: 'sfe-ev2__words' }, item.sentence);
  const detail = o.detail ? h('span', { class: 'sfe-ev2__detail' }, o.detail) : null;
  const main = o.onSelect
    ? h('button', { type: 'button', class: 'sfe-ev2__main sfe-ev2__open', 'aria-label': `${item.title}: open the details` }, title, words, detail)
    : h('div', { class: 'sfe-ev2__main' }, title, words, detail);
  if (o.onSelect) main.addEventListener('click', o.onSelect);
  const when = timeButton(item.start, o.zone, item.title, o.onJump, { end: o.showEnd ? item.end : null });
  const chip = uncertaintyChip(o.timeInfo ?? null);
  const el = h(
    'li',
    {
      class: `sfe-ev2${o.dim ? ' sfe-ev2--dim' : ''}`,
      'data-kind': item.kind,
      ...Object.fromEntries(Object.entries(o.data ?? {}).map(([k, v]) => [`data-${k}`, v])),
    },
    h('span', { class: 'sfe-ev2__when' }, when, chip),
    h('span', { class: 'sfe-ev2__glyph' }, o.glyph ?? null),
    main,
    h('span', { class: 'sfe-ev2__add' }, o.add ?? null),
  );
  return {
    el,
    anchor: el,
    setNext(on) {
      el.classList.toggle('sfe-ev2--next', on);
    },
    setSelected(on) {
      if (o.onSelect) main.setAttribute('aria-expanded', String(on));
      el.classList.toggle('sfe-ev2--selected', on);
    },
  };
}

/** A search's status line: what it found, or how far it has got. */
export function searchStatus(state: SearchState<unknown> | null, found: string, what = 'Searching'): string {
  if (!state) return '';
  if (state.error) return '';
  if (!state.done) return `${progressText(state, what)}${state.items.length ? ` · ${found}` : ''}`;
  return found;
}

export interface Split {
  el: HTMLElement;
  list: HTMLElement;
  aside: HTMLElement;
  /** Put the card beside the list, or under `row` when the stage is narrow. */
  place(card: HTMLElement | null, row: HTMLElement | null): void;
  destroy(): void;
}

/** A list with a card beside it (under the chosen row on a narrow stage), like the eclipses. */
export function splitView(root: HTMLElement): Split {
  const list = h('div', { class: 'sfe-listcol' });
  const aside = h('div', { class: 'sfe-cardcol' });
  const el = h('div', { class: 'sfe-split' }, list, aside);
  let narrow = false;
  let card: HTMLElement | null = null;
  let row: HTMLElement | null = null;
  const place = (): void => {
    if (!card) {
      aside.hidden = narrow;
      return;
    }
    const target = narrow && row ? row : aside;
    if (card.parentElement !== target) target.append(card);
    if (aside.hidden !== narrow) aside.hidden = narrow;
  };
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      const next = root.clientWidth < INLINE_CARD_PX;
      if (next === narrow) return;
      narrow = next;
      root.classList.toggle('sfe--narrow', narrow);
      place();
    });
    ro.observe(root);
  }
  return {
    el,
    list,
    aside,
    place(c, r) {
      if (card && card !== c) card.remove();
      card = c;
      row = r;
      place();
    },
    destroy() {
      ro?.disconnect();
    },
  };
}
