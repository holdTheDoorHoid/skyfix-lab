/**
 * Saving events: each tab's Save menu (a calendar file for what the list shows, the same
 * to the device's share sheet where it takes one, a CSV table) and the small calendar
 * button beside each event. Files are made on this device and handed to the browser;
 * nothing is sent anywhere. OWNER: events2 agent.
 *
 *   Save ▾   Add to a calendar (.ics)     12 events
 *            Share to a calendar…          (only where the device's share sheet takes files)
 *            Save as a table (.csv)
 *            [x] Name the place in the files
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import { canShareIcs, icsEventCount, icsExportable, icsFileName, saveIcs, shareIcs } from '../export/ics.js';
import { dateMedium } from '../shell/format.js';
import { displayZone } from '../state.js';
import { roundToMinute } from '../time.js';
import { icon } from '../theme/icons.js';
import { button, popover, type Popover } from '../theme/primitives.js';
import { fileName as csvFileName, saveText } from '../export/csv.js';
import type { EventsUi } from './env.js';
import {
  csvComments,
  csvOfItems,
  fileWords,
  icsEventOf,
  icsOfItems,
  utcDate,
  type EventItem,
  type FileContext,
  type FilePlace,
  type Words,
} from './items.js';
import type { Store } from '../state.js';

/** What a tab's files hold. */
export interface ExportSource {
  /** The files' title: `Moon: perigee and apogee`. */
  title(): string;
  /** File name parts after `skyfix`: `['moon-perigee', '2026-09-25']`. */
  fileParts(): (string | number)[];
  /** The events, written with the given words (the files' own). */
  items(words: Words): readonly EventItem[];
  /** The times hold for the place (local circumstances). */
  readonly local: boolean;
  /** Lines a table must carry beside its numbers (what they are, how far to trust them). */
  notes?(): string[];
}

function filePlace(ctx: Ctx, ui: Store<EventsUi>): FilePlace | null {
  if (!ui.get().namePlace) return null;
  const o = ctx.store.get().observer;
  return { label: o.label, lat_deg: Math.round(o.lat_deg * 1e4) / 1e4, lon_deg: Math.round(o.lon_deg * 1e4) / 1e4 };
}

function fileContext(ctx: Ctx, ui: Store<EventsUi>): FileContext {
  return { engine: ctx.engine, place: filePlace(ctx, ui), format: ctx.store.get().settings.angleFormat };
}

export interface ExportMenu {
  el: HTMLElement;
  /** Say how many events the calendar file would hold (after the list changed). */
  refresh(): void;
  destroy(): void;
}

/** The Save menu for a tab's list. */
export function exportMenu(ctx: Ctx, ui: Store<EventsUi>, source: ExportSource): ExportMenu {
  const status = h('span', { class: 'sfe-save__status', role: 'status', 'aria-live': 'polite' });
  const trigger = button({
    label: 'Save',
    icon: 'calendar',
    iconAfter: 'chevron-down',
    size: 'sm',
    variant: 'secondary',
    class: 'sfe-save__btn',
    tip: 'Add these events to a calendar, or save them as a table',
  });
  const count = h('span', { class: 'sf-menu__hint' });
  const icsItem = h(
    'button',
    { type: 'button', class: 'sf-menu__item', 'data-action': 'ics' },
    icon('calendar'),
    h('span', {}, 'Add to a calendar (.ics)'),
    count,
  );
  const shareItem = h(
    'button',
    { type: 'button', class: 'sf-menu__item', 'data-action': 'share', hidden: true },
    icon('share'),
    h('span', {}, 'Share to a calendar…'),
  );
  const csvItem = h(
    'button',
    { type: 'button', class: 'sf-menu__item', 'data-action': 'csv' },
    icon('list'),
    h('span', {}, 'Save as a table (.csv)'),
  );
  const placeBox = h('input', { type: 'checkbox', checked: ui.get().namePlace });
  const placeRow = h('label', { class: 'sf-check sfe-save__place' }, placeBox, 'Name the place in the files');
  const menuEl = h(
    'div',
    { class: 'sfe-save__menu' },
    h('div', { class: 'sf-popover__title' }, 'Save these events'),
    h('div', { class: 'sf-menu', role: 'group', 'aria-label': 'Save these events' }, icsItem, shareItem, csvItem),
    placeRow,
    h('p', { class: 'sfe-save__note' }, 'Files are made on this device; nothing is sent anywhere. A calendar file keeps the next events in your own calendar, with what each one means.'),
  );
  const pop: Popover = popover(trigger, menuEl, {
    label: 'Save these events',
    placement: 'bottom-end',
    onStage: true,
    onOpen: () => refresh(),
  });
  placeBox.addEventListener('change', () => ui.patch({ namePlace: placeBox.checked }));

  const itemsNow = (): readonly EventItem[] => source.items(fileWords(ctx.store.get()));
  const refresh = (): void => {
    const items = itemsNow();
    const n = icsEventCount(items.map((i) => icsEventOf(i, fileContext(ctx, ui))));
    count.textContent = n === 1 ? '1 event' : `${n} events`;
    icsItem.disabled = n === 0;
    shareItem.disabled = n === 0;
    csvItem.disabled = items.length === 0;
    shareItem.hidden = !canShareIcs();
    placeRow.hidden = !source.local;
    placeBox.checked = ui.get().namePlace;
  };
  const fileName = (ext: 'ics' | 'csv'): string => (ext === 'ics' ? icsFileName(source.fileParts()) : csvFileName(source.fileParts(), 'csv'));

  const saveCalendar = (share: boolean): void => {
    const items = itemsNow();
    const text = icsOfItems(items, source.title(), fileContext(ctx, ui), Date.now());
    const name = fileName('ics');
    pop.close();
    if (share) {
      void shareIcs(text, name, `SkyFix Lab: ${source.title()}`).then((outcome) => {
        status.textContent =
          outcome === 'shared' ? 'Shared.' : outcome === 'cancelled' ? '' : 'This device could not share it: use Add to a calendar instead.';
      });
      return;
    }
    saveIcs(text, name);
    status.textContent = `Saved ${name}.`;
  };
  icsItem.addEventListener('click', () => saveCalendar(false));
  shareItem.addEventListener('click', () => saveCalendar(true));
  csvItem.addEventListener('click', () => {
    const state = ctx.store.get();
    const items = itemsNow();
    const text = csvOfItems(items, state, ctx.engine, csvComments(source.title(), state, filePlace(ctx, ui), source.local, source.notes?.() ?? []));
    const name = fileName('csv');
    pop.close();
    saveText(text, name);
    status.textContent = `Saved ${name}.`;
  });

  const el = h('div', { class: 'sfe-save' }, trigger, status);
  return {
    el,
    refresh: () => {
      if (pop.isOpen()) refresh();
    },
    destroy: () => pop.destroy(),
  };
}

/**
 * The calendar button beside one event: a calendar file for that event alone. Disabled,
 * with the reason, for an event a calendar file cannot hold (before AD 1).
 */
export function addToCalendarButton(ctx: Ctx, ui: Store<EventsUi>, item: () => EventItem, label: string): HTMLButtonElement {
  const probe = item();
  const ok = icsExportable(probe.start);
  const b = button({
    icon: 'calendar',
    variant: 'ghost',
    size: 'sm',
    class: 'sfe-add',
    ariaLabel: `Add ${label} to a calendar`,
    tip: ok ? 'Add to a calendar (.ics)' : 'A calendar file cannot hold a date before AD 1',
  });
  if (!ok) b.disabled = true;
  b.addEventListener('click', () => {
    const state = ctx.store.get();
    const one = item();
    const fc = fileContext(ctx, ui);
    const text = icsOfItems([one], one.title, fc, Date.now());
    const zone = displayZone(state);
    saveIcs(text, icsFileName([one.title, utcDate(one.start)]));
    b.dataset.tip = `Saved: ${one.title}, ${dateMedium(roundToMinute(one.start), zone)}`;
  });
  return b;
}
