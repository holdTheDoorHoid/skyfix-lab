/**
 * The view switcher at the top of the panel: eight tabs with icons and labels (two rows
 * of four on a desktop, one scrolling row on a phone). Arrow keys move between tabs.
 * OWNER: shell-design agent.
 */

import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import { setAttr } from '../shell/derived.js';
import { TABS, VIEW_META } from '../shell/views.js';
import type { ViewId } from '../state.js';
import { icon } from '../theme/icons.js';

export function viewSwitcher(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const { store } = ctx;
  const d = disposer();
  /** The map tab returns to whichever of map and globe was used last. */
  let lastMap: ViewId = store.get().view === 'globe' ? 'globe' : 'map';
  const buttons = TABS.map((meta) => {
    const b = h(
      'button',
      { type: 'button', class: 'sf-views__tab', 'data-view': meta.tab, 'data-tip': meta.tip },
      icon(meta.icon),
      h('span', {}, meta.label),
    );
    b.addEventListener('click', () => {
      const current = store.get().view;
      if (VIEW_META[current].tab === meta.tab) return;
      store.patch({ view: meta.tab === 'map' ? lastMap : meta.tab });
    });
    return b;
  });
  const el = h('nav', { class: 'sf-views', 'aria-label': 'Views' }, ...buttons);
  el.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (i + 1) % buttons.length
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (i - 1 + buttons.length) % buttons.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? buttons.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    buttons[next]!.focus();
  });
  d.add(
    watch(ctx, (s) => s.view, (view) => {
      if (view === 'map' || view === 'globe') lastMap = view;
      const tab = VIEW_META[view].tab;
      for (const b of buttons) {
        const on = b.dataset.view === tab;
        setAttr(b, 'aria-current', on ? 'page' : null);
        b.tabIndex = on ? 0 : -1;
      }
      buttons.find((b) => b.dataset.view === tab)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }),
  );
  return { el, destroy: () => d.dispose() };
}
