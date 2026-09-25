/**
 * Settings → Data packs: each pack the site offers (and any other saved or loaded one),
 * with its size and state, Get and Remove, and the total saved on this device. Hidden
 * while the site offers no pack and none is saved. OWNER: packs agent.
 *
 *   DATA PACKS
 *   Deep time                                              0.4 MB
 *   Positions from 2000 BC to AD 3000.
 *   Saved · in use                                       [Remove]
 *   Saved on this device: 0.4 MB. Packs are saved in this browser only.
 */

import './packs.css';
import { h } from '../../dom.js';
import type { PackService, PackState } from '../engine/types.js';
import { button } from '../theme/primitives.js';
import { formatBytes } from './manifest.js';

/** The state line of one pack, in words. */
export function packStateText(p: PackState): string {
  if (p.progress) return `Downloading… ${formatBytes(p.progress.received)} of ${formatBytes(p.progress.total)}`;
  if (p.saved) {
    const parts = [`Saved · ${formatBytes(p.savedBytes || p.bytes)}`];
    if (p.stale) parts.push('an older version, updated when next used');
    else if (p.loaded) parts.push('in use');
    return parts.join(' · ');
  }
  if (p.removedInUse) return 'Removed from this device; in use until the page is reloaded';
  if (p.loaded) return 'In use for this visit; not saved';
  if (!p.supported) return 'This version of the numerical core cannot use it';
  return 'Not saved';
}

export function packsSettings(packs: PackService): { el: HTMLElement; refresh(): void; destroy(): void } {
  const list = h('div', { class: 'sf-packs-list', role: 'list' });
  const total = h('p', { class: 'sf-settings__note sf-packs-total' });
  const el = h('div', { class: 'sf-packs', hidden: true }, h('div', { class: 'sf-popover__title' }, 'Data packs'), list, total);

  const row = (p: PackState): HTMLElement => {
    const busy = p.progress !== null;
    const act = busy
      ? null
      : p.saved && !p.stale
        ? button({ label: 'Remove', variant: 'ghost', size: 'sm', tip: `Delete the ${p.label} pack from this device`, onClick: () => void packs.remove(p.name) })
        : p.offered && p.supported
          ? button({
              label: p.saved ? 'Update' : 'Get',
              variant: 'secondary',
              size: 'sm',
              tip: `Download the ${p.label} pack (${formatBytes(p.bytes)}) and save it on this device`,
              onClick: () => void packs.get(p.name),
            })
          : null;
    const remove =
      p.saved && p.stale && !busy
        ? button({ label: 'Remove', variant: 'ghost', size: 'sm', tip: `Delete the ${p.label} pack from this device`, onClick: () => void packs.remove(p.name) })
        : null;
    const meter = busy
      ? h(
          'div',
          { class: 'sf-packs-prompt__bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('span', { class: 'sf-packs-prompt__bar-fill', style: `width: ${Math.min(100, Math.round((100 * p.progress!.received) / Math.max(1, p.progress!.total)))}%` }),
        )
      : null;
    return h(
      'div',
      { class: 'sf-packs-row', role: 'listitem', 'data-pack': p.name, 'data-state': busy ? 'loading' : p.saved ? 'saved' : 'absent' },
      h('div', { class: 'sf-packs-row__head' }, h('span', { class: 'sf-packs-row__label' }, p.label), h('span', { class: 'sf-packs-row__size sf-num' }, formatBytes(p.bytes))),
      p.description ? h('p', { class: 'sf-packs-row__description' }, p.description) : null,
      h('div', { class: 'sf-packs-row__foot' }, h('span', { class: 'sf-packs-row__state', role: 'status' }, packStateText(p)), h('span', { class: 'sf-packs-row__actions' }, remove, act)),
      meter,
      p.error ? h('p', { class: 'sf-packs-row__error' }, p.error) : null,
    );
  };

  const render = (): void => {
    const rows = packs.status();
    el.hidden = rows.length === 0;
    // Keep the keyboard where it was: a row is redrawn when its state changes (Get becomes
    // a progress bar, then Remove), and focus must not fall back to the page.
    const focused = list.contains(document.activeElement) ? (document.activeElement?.closest('[data-pack]') as HTMLElement | null)?.dataset.pack : undefined;
    list.replaceChildren(...rows.map(row));
    if (focused) {
      const again = list.querySelector<HTMLElement>(`[data-pack="${focused}"]`);
      const target = again?.querySelector<HTMLElement>('button') ?? again;
      if (again && !again.querySelector('button')) again.tabIndex = -1;
      target?.focus();
    }
    const saved = rows.reduce((sum, p) => sum + (p.saved ? p.savedBytes || p.bytes : 0), 0);
    total.textContent = `${saved > 0 ? `Saved on this device: ${formatBytes(saved)}. ` : ''}Packs are saved in this browser only.`;
  };

  const stop = packs.subscribe(render);
  render();
  return {
    el,
    refresh() {
      render();
      void packs.refresh();
    },
    destroy: stop,
  };
}
