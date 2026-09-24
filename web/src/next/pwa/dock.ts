/**
 * The connection and update dock: a small area at the bottom centre of the window that
 * shows, only when there is something to say,
 *
 *   an Offline chip        while the browser reports no connection;
 *   "New version available  [Reload] [×]"   when a new version waits (never applied
 *                          unless Reload is pressed: nobody loses work to an update);
 *   "Updated in another tab  [Reload] [×]"  when another tab applied it;
 *   "Saved for offline use"                 once, after the first install (fades by
 *                          itself after a while; the others stay until answered).
 *
 * Built from the design system's primitives (theme/); floats above the stage and the
 * phone's bottom sheet, below popovers and tooltips. OWNER: release agent.
 */

import '../theme/index.js';
import './dock.css';
import { h } from '../../dom.js';
import type { UpdateHandle } from '../../pwa/register.js';
import { icon } from '../theme/icons.js';
import { button, chip, iconButton } from '../theme/primitives.js';

export interface Dock {
  setOffline(offline: boolean): void;
  showUpdate(update: UpdateHandle): void;
  showUpdatedElsewhere(reload: () => void): void;
  showOfflineReady(): void;
  destroy(): void;
}

export const OFFLINE_TIP =
  'No connection. Everything here keeps working from this device: the numerical core, the world map and place search. Only the optional street map needs a connection.';

/** How long the "saved for offline use" note stays, unless the pointer or focus is on it. */
const READY_NOTE_MS = 9000;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A cloud with a line through it, on the icon set's 24-unit grid and stroke (icons.ts). */
function offlineGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.75',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: 'sf-icon',
    'aria-hidden': 'true',
    focusable: 'false',
  })) {
    svg.setAttribute(k, v);
  }
  for (const d of ['M7 18h10.5a3.5 3.5 0 0 0 .4-6.97 5.5 5.5 0 0 0-10.3-1.43A4.25 4.25 0 0 0 7 18Z', 'M3.5 3.5l17 17']) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

type CardKind = 'update' | 'elsewhere' | 'ready';
/** A card never gives way to a less important one. */
const RANK: Record<CardKind, number> = { ready: 0, update: 1, elsewhere: 2 };

export function createDock(host: HTMLElement = document.body): Dock {
  const offline = chip({ label: 'Offline', lead: offlineGlyph(), tip: OFFLINE_TIP, class: 'sf-pwa__offline', attrs: { tabindex: 0 } });
  // A live region: "Offline" and each card are announced when they appear.
  const status = h('div', { class: 'sf-pwa__row', role: 'status' });
  const cards = h('div', { class: 'sf-pwa__row', role: 'status' });
  const el = h('div', { class: 'sf-pwa sf-on-chrome', role: 'region', 'aria-label': 'Connection and updates' }, cards, status);
  host.appendChild(el);

  let shown: { kind: CardKind; el: HTMLElement } | null = null;
  let readyTimer = 0;

  const clearCard = (): void => {
    window.clearTimeout(readyTimer);
    shown?.el.remove();
    shown = null;
  };

  const showCard = (kind: CardKind, text: string, actions: HTMLElement[]): HTMLElement | null => {
    if (shown && RANK[shown.kind] > RANK[kind]) return null;
    clearCard();
    const later = kind === 'update' || kind === 'elsewhere';
    const dismiss = iconButton('close', later ? 'Later: keep this version for now' : 'Dismiss', {
      size: 'sm',
      tip: later ? 'Later' : 'Dismiss',
      onClick: clearCard,
    });
    const card = h(
      'div',
      { class: 'sf-notice sf-pwa__card', 'data-kind': kind },
      icon('info'),
      h('span', { class: 'sf-pwa__text' }, text),
      h('span', { class: 'sf-pwa__actions' }, ...actions, dismiss),
    );
    cards.appendChild(card);
    shown = { kind, el: card };
    return card;
  };

  return {
    setOffline(isOffline) {
      if (isOffline && !offline.isConnected) status.appendChild(offline);
      if (!isOffline) offline.remove();
    },

    showUpdate(update) {
      showCard('update', 'New version available', [
        button({
          label: 'Reload',
          variant: 'primary',
          size: 'sm',
          tip: 'Reload this page with the new version',
          onClick: () => update.apply(),
        }),
      ]);
    },

    showUpdatedElsewhere(reload) {
      showCard('elsewhere', 'SkyFix Lab was updated in another tab', [
        button({ label: 'Reload', variant: 'primary', size: 'sm', tip: 'Reload this page with the new version', onClick: reload }),
      ]);
    },

    showOfflineReady() {
      const card = showCard('ready', 'Saved on this device: SkyFix Lab now works offline', []);
      if (!card) return;
      const later = (): void => {
        window.clearTimeout(readyTimer);
        readyTimer = window.setTimeout(() => {
          if (card.matches(':hover, :focus-within')) later();
          else if (shown?.el === card) clearCard();
        }, READY_NOTE_MS);
      };
      later();
    },

    destroy() {
      clearCard();
      el.remove();
    },
  };
}
