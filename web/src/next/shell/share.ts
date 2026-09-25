/**
 * Share: the one way a position leaves the page, and only when the person asks
 * (EXPLORER_PLAN §1). The link is made when the panel opens and shown here; the address
 * bar is never changed and nothing is sent anywhere. OWNER: shell-design agent.
 *
 * Copy puts the link on the clipboard. Where the device has a share sheet (the Web Share
 * API: phones, tablets, some desktops), "Share…" beside it hands the same link to it; what
 * happens next is the person's choice in their own apps (packs agent, 2026-09-24).
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import { shareUrl } from '../state.js';
import { button } from '../theme/primitives.js';

export function sharePanel(ctx: Ctx): { el: HTMLElement; refresh(): void } {
  const { store } = ctx;
  const place = h('input', { type: 'checkbox', checked: true, id: 'sf-share-place' });
  const time = h('input', { type: 'checkbox', checked: true, id: 'sf-share-time' });
  const link = h('input', { class: 'sf-input sf-num', readonly: true, 'aria-label': 'The link', id: 'sf-share-link' });
  const status = h('span', { class: 'sf-share__status', role: 'status', 'aria-live': 'polite' });
  const copy = button({ label: 'Copy', icon: 'copy', variant: 'primary', size: 'sm' });
  const nav = globalThis.navigator as (Navigator & { share?: (data: ShareData) => Promise<void>; canShare?: (data: ShareData) => boolean }) | undefined;
  const canShare = (url: string): boolean => {
    if (typeof nav?.share !== 'function') return false;
    try {
      return typeof nav.canShare === 'function' ? nav.canShare({ url }) : true;
    } catch {
      return false;
    }
  };
  const sheet = button({ label: 'Share…', icon: 'share', variant: 'secondary', size: 'sm', tip: 'Send the link with this device’s share sheet' });
  sheet.hidden = !canShare(globalThis.location?.href ?? 'https://example.org/');
  sheet.addEventListener('click', async () => {
    if (!nav?.share) return;
    try {
      await nav.share({ title: 'SkyFix Lab', url: link.value });
      status.textContent = 'Shared.';
    } catch (error) {
      // Closing the share sheet is not a failure.
      if ((error as { name?: string } | null)?.name === 'AbortError') return;
      status.textContent = 'This device could not share it: copy the link instead.';
    }
  });

  const refresh = (): void => {
    link.value = shareUrl(store.get(), globalThis.location.href, { place: place.checked, time: time.checked });
    status.textContent = '';
  };
  place.addEventListener('change', refresh);
  time.addEventListener('change', refresh);
  link.addEventListener('focus', () => link.select());
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link.value);
      status.textContent = 'Copied.';
    } catch {
      link.focus();
      link.select();
      status.textContent = 'Selected: copy it with Ctrl+C (⌘C on a Mac).';
    }
  });

  const el = h(
    'div',
    { class: 'sf-share' },
    h('div', { class: 'sf-popover__title' }, 'Share this view'),
    h(
      'p',
      { class: 'sf-share__text' },
      'A link that opens this place, time and body. It is made now because you asked: the address bar never carries your position by itself, and nothing is sent anywhere.',
    ),
    h(
      'div',
      { class: 'sf-share__options' },
      h('label', { class: 'sf-check', for: 'sf-share-place' }, place, 'Include the place'),
      h('label', { class: 'sf-check', for: 'sf-share-time' }, time, 'Include the time'),
    ),
    h('div', { class: 'sf-share__row' }, link, copy, sheet),
    status,
  );
  return { el, refresh };
}
