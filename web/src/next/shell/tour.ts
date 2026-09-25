/**
 * A short first-run tour: five cards pointing at the place, the time bar, the views, the
 * Tonight tab (tonight agent) and the honesty banner. OWNER: shell-design agent (added by
 * the polish pass).
 *
 * Rules
 * - It never blocks the page: no backdrop, no focus trap; a card beside what it explains,
 *   with a ring round that part. Everything stays usable while it is open.
 * - Shown once, on the first visit. Skip, Done, the close button and Escape all dismiss it,
 *   and the dismissal is remembered for this viewer (localStorage, every access guarded; a
 *   browser that refuses storage just shows it again next time). Nothing else is stored.
 * - Reachable again from Help (the app strip) and from the About view (`openTour`).
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import { safeLocalStorage } from '../state.js';
import { button, iconButton } from '../theme/primitives.js';

/** The one key the tour writes: `done` once it has been dismissed. */
export const TOUR_KEY = 'skyfix.explorer.tour.v1';

export interface TourStep {
  title: string;
  text: string;
  /** What the card points at (a selector); the card goes beside it. */
  target: string;
  side: 'right' | 'below';
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    title: 'Your place',
    text: 'Click the map to put yourself anywhere (press and hold on a phone), drag the marker, or type a place name or coordinates here. Your place is never stored or sent anywhere.',
    target: '.sf-search',
    side: 'right',
  },
  {
    title: 'The moment',
    text: 'Drag along the day on the time bar, step the date with the arrows, or press Play to watch the sky move. Keys: ← → ten minutes, with Shift an hour, with Alt a day; N is now.',
    target: '.sf-timebar',
    side: 'below',
  },
  {
    title: 'Ways to look',
    text: 'Map, Sky, Tonight, Charts, Navigate, Almanac, Events and Learn all show the same place and moment. Choose the Sun, the Moon, a planet or a star in the panel’s Selected card and every view follows it.',
    target: '.sf-views',
    side: 'right',
  },
  // tonight agent (expansion programme Q2): the Tonight view's card.
  {
    title: 'Tonight',
    text: 'The night ahead at your place on one page: when it is dark, the Moon, the planets, the best deep-sky sights, meteors, the Milky Way and the next two weeks. Every time on it moves the explorer there.',
    target: '.sf-views__tab[data-view="tonight"]',
    side: 'right',
  },
  {
    title: 'Honest numbers',
    text: 'Every number is computed in this page by the SkyFix Lab core, offline once loaded. It is a simulation and analysis workbench, not a navigation instrument. This tour is in Help and in About.',
    target: '.sf-honesty',
    side: 'below',
  },
];

/** Whether this viewer has dismissed the tour. A browser that refuses storage has not. */
export function tourDismissed(storage: Storage | null = safeLocalStorage()): boolean {
  try {
    return storage?.getItem(TOUR_KEY) === 'done';
  } catch {
    return false;
  }
}

/** Remember the dismissal; false when the browser refused (not an error). */
export function rememberTourDismissed(storage: Storage | null = safeLocalStorage()): boolean {
  try {
    storage?.setItem(TOUR_KEY, 'done');
    return Boolean(storage);
  } catch {
    return false;
  }
}

export interface Tour {
  /** Show the tour from its first card; `focus` moves the keyboard to it (asked for, not automatic). */
  open(options?: { focus?: boolean }): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const tours = new WeakMap<object, Tour>();

/** Open the page's tour (Help, About). False when this page has none (developer pages). */
export function openTour(ctx: Pick<Ctx, 'store'>): boolean {
  const tour = tours.get(ctx.store);
  tour?.open({ focus: true });
  return Boolean(tour);
}

/** Whether this page has a tour to open. */
export function hasTour(ctx: Pick<Ctx, 'store'>): boolean {
  return tours.has(ctx.store);
}

const PHONE = '(max-width: 767px)';

export function createTour(ctx: Pick<Ctx, 'store'>, options: { storage?: Storage | null } = {}): Tour {
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
  let index = 0;
  let isOpen = false;
  /** Where the keyboard was when the tour was asked for, to go back there. */
  let returnTo: HTMLElement | null = null;

  const title = h('h2', { class: 'sf-tour__title', id: 'sf-tour-title' });
  const text = h('p', { class: 'sf-tour__text' });
  const count = h('span', { class: 'sf-tour__count' });
  const back = button({ label: 'Back', variant: 'ghost', size: 'sm', onClick: () => show(index - 1) });
  const next = button({ label: 'Next', variant: 'primary', size: 'sm', onClick: () => (index === TOUR_STEPS.length - 1 ? dismiss() : show(index + 1)) });
  const skip = button({ label: 'Skip the tour', variant: 'ghost', size: 'sm', onClick: () => dismiss() });
  const close = iconButton('close', 'Close the tour', { size: 'sm', class: 'sf-tour__close', onClick: () => dismiss() });
  const card = h(
    'section',
    { class: 'sf-tour', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'sf-tour-title', tabindex: '-1', hidden: true },
    h('div', { class: 'sf-tour__head' }, count, close),
    title,
    text,
    h('div', { class: 'sf-tour__actions' }, skip, h('span', { class: 'sf-tour__spacer' }), back, next),
  );
  const ring = h('div', { class: 'sf-tour-ring', 'aria-hidden': 'true', hidden: true });
  document.body.append(ring, card);

  const target = (): HTMLElement | null => {
    const el = document.querySelector<HTMLElement>(TOUR_STEPS[index]!.target);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight ? el : null;
  };

  const place = (): void => {
    if (!isOpen) return;
    const step = TOUR_STEPS[index]!;
    const el = target();
    const margin = 12;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    if (el) {
      const r = el.getBoundingClientRect();
      ring.hidden = false;
      ring.style.left = `${Math.round(r.left - 4)}px`;
      ring.style.top = `${Math.round(r.top - 4)}px`;
      ring.style.width = `${Math.round(r.width + 8)}px`;
      ring.style.height = `${Math.round(r.height + 8)}px`;
    } else {
      ring.hidden = true;
    }
    const c = card.getBoundingClientRect();
    let left: number;
    let top: number;
    if (matchMedia(PHONE).matches || !el) {
      // Phones: across the top of the map, under the time bar (the sheet has the bottom).
      const bar = document.querySelector('.sf-timebar')?.getBoundingClientRect();
      left = (vw - c.width) / 2;
      top = (bar?.bottom ?? 0) + 8;
    } else {
      const r = el.getBoundingClientRect();
      if (step.side === 'right') {
        left = r.right + 16;
        top = r.top;
      } else {
        left = r.left + r.width / 2 - c.width / 2;
        top = r.bottom + 12;
      }
    }
    card.style.left = `${Math.round(Math.max(margin, Math.min(left, vw - c.width - margin)))}px`;
    card.style.top = `${Math.round(Math.max(margin, Math.min(top, vh - c.height - margin)))}px`;
  };

  const show = (i: number): void => {
    index = Math.max(0, Math.min(TOUR_STEPS.length - 1, i));
    const step = TOUR_STEPS[index]!;
    title.textContent = step.title;
    text.textContent = step.text;
    count.textContent = `${index + 1} of ${TOUR_STEPS.length}`;
    back.hidden = index === 0;
    next.querySelector('.sf-btn__label')!.textContent = index === TOUR_STEPS.length - 1 ? 'Done' : 'Next';
    place();
    if (card.contains(document.activeElement) && document.activeElement !== next) next.focus({ preventScroll: true });
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    // Escape closes a menu first; only an Escape nothing else wanted closes the tour.
    if (document.querySelector('.sf-popover:not([hidden])')) return;
    e.preventDefault();
    dismiss();
  };
  const onMove = (): void => place();

  function dismiss(): void {
    rememberTourDismissed(storage);
    api.close();
  }

  const api: Tour = {
    open({ focus = false } = {}) {
      if (!isOpen) {
        isOpen = true;
        card.hidden = false;
        window.addEventListener('keydown', onKey);
        window.addEventListener('resize', onMove);
        document.addEventListener('scroll', onMove, true);
      }
      show(0);
      if (focus) {
        returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        card.focus({ preventScroll: true });
      }
    },
    close() {
      if (!isOpen) return;
      isOpen = false;
      const hadFocus = card.contains(document.activeElement);
      card.hidden = true;
      ring.hidden = true;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      document.removeEventListener('scroll', onMove, true);
      if (hadFocus) (returnTo?.isConnected ? returnTo : document.querySelector<HTMLElement>('.sf-appbar .sf-brand'))?.focus({ preventScroll: true });
      returnTo = null;
    },
    isOpen: () => isOpen,
    destroy() {
      api.close();
      card.remove();
      ring.remove();
      if (tours.get(ctx.store) === api) tours.delete(ctx.store);
    },
  };
  tours.set(ctx.store, api);
  return api;
}
