/**
 * Where the site's other parts are, for Help and About: the manual (the mdBook the Pages
 * workflow publishes at `docs/`), the source repository, and installing the app. OWNER:
 * packs agent (the shell fixes of the expansion programme).
 *
 * Both links open in a new tab: the explorer's place is never stored, so leaving the page
 * would lose it.
 */

import { h } from '../../dom.js';
import { button } from '../theme/primitives.js';
import { installOffer, IOS_HINT, type InstallOffer } from './install.js';

/** The manual, relative to the site root (where the explorer's page is). */
export const MANUAL_URL = 'docs/';
export const REPOSITORY_URL = 'https://github.com/holdTheDoorHoid/skyfix-lab';

export function manualLink(text = 'The manual'): HTMLAnchorElement {
  return h('a', { href: MANUAL_URL, target: '_blank', rel: 'noopener' }, text);
}

export function repositoryLink(text = 'The source code'): HTMLAnchorElement {
  return h('a', { href: REPOSITORY_URL, target: '_blank', rel: 'noopener noreferrer' }, text);
}

/** The manual's page of every data source and its licence (polish2). */
export const SOURCES_URL = `${MANUAL_URL}THIRD_PARTY.html`;

export function sourcesLink(text = 'Every source and its licence'): HTMLAnchorElement {
  return h('a', { href: SOURCES_URL, target: '_blank', rel: 'noopener' }, text);
}

/**
 * "Install SkyFix Lab" while the browser offers it; on an iPhone or iPad the one line that
 * says how; nothing once installed, or where the browser has not offered. Follows the
 * offer as it changes (the browser's event can come after the page has drawn).
 */
export function installControl(offer: InstallOffer = installOffer()): { el: HTMLElement; destroy(): void } {
  const status = h('span', { class: 'sf-install__status', role: 'status' });
  const install = button({
    label: 'Install SkyFix Lab',
    variant: 'secondary',
    size: 'sm',
    tip: 'Install it as an app on this device: its own window, and it works offline',
    onClick: () => {
      void offer.install().then((outcome) => {
        status.textContent = outcome === 'accepted' ? 'Installing: it opens in its own window from now on.' : '';
      });
    },
  });
  const hint = h('span', { class: 'sf-install__hint' }, IOS_HINT);
  const el = h('div', { class: 'sf-install' }, install, hint, status);
  const draw = (): void => {
    const state = offer.state();
    install.hidden = state !== 'available';
    hint.hidden = state !== 'ios';
    el.hidden = state === 'none' || (state === 'installed' && !status.textContent);
  };
  draw();
  return { el, destroy: offer.subscribe(draw) };
}
