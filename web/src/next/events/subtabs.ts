/**
 * A tab's own tabs: the Moon's (phases, perigee and supermoons, occultations) and the
 * Planets' (highlights, conjunctions, retrograde loops, transits, Jupiter's moons). WAI-ARIA
 * tabs with automatic activation, as the view's own strip, one size smaller. OWNER: events2.
 */

import { h } from '../../dom.js';
import { disposer, type Mounted } from '../component.js';
import type { Store } from '../state.js';
import type { EventsUi, TabComponent, TabEnv } from './env.js';

export interface SubTab<T extends string> {
  id: T;
  label: string;
  tip: string;
  tab: TabComponent;
}

let seq = 0;

/**
 * Mount a strip of sub-tabs in `host`, showing the one `select(ui)` names; choosing one
 * calls `choose`. Each sub-tab's component is mounted when shown and destroyed when left.
 */
export function subTabs<T extends string>(
  host: HTMLElement,
  env: TabEnv,
  options: {
    label: string;
    tabs: readonly SubTab<T>[];
    select(ui: EventsUi): T;
    choose(ui: Store<EventsUi>, id: T): void;
    className?: string;
  },
): Mounted {
  const d = disposer();
  const id = `sfe-sub-${++seq}`;
  const tabs = options.tabs;
  const strip = h('div', { class: 'sf-seg sf-seg--sm sfe-subtabs', role: 'tablist', 'aria-label': options.label });
  const panel = h('div', { class: 'sfe-subpanel', role: 'tabpanel', id, tabindex: '-1' });
  const root = h('div', { class: `sfe-tabbody ${options.className ?? ''}`.trim() }, strip, panel);
  host.append(root);
  d.add(() => root.remove());

  const buttons = tabs.map((t, i) => {
    const b = h(
      'button',
      { type: 'button', class: 'sf-seg__opt', role: 'tab', id: `${id}-${t.id}`, 'aria-controls': id, 'data-sub': t.id, 'data-tip': t.tip },
      t.label,
    );
    b.addEventListener('click', () => options.choose(env.ui, t.id));
    b.addEventListener('keydown', (event) => {
      let j: number | null = null;
      if (event.key === 'ArrowRight') j = (i + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') j = 0;
      else if (event.key === 'End') j = tabs.length - 1;
      if (j === null) return;
      event.preventDefault();
      options.choose(env.ui, tabs[j]!.id);
      buttons[j]?.focus();
    });
    strip.append(b);
    return b;
  });

  let mounted: Mounted | null = null;
  let shown: T | null = null;
  const mount = (which: T): void => {
    if (which === shown) return;
    mounted?.destroy();
    panel.replaceChildren();
    const def = tabs.find((t) => t.id === which) ?? tabs[0]!;
    panel.setAttribute('aria-labelledby', `${id}-${def.id}`);
    root.dataset.sub = def.id;
    buttons.forEach((b, i) => {
      const on = tabs[i]!.id === def.id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    shown = def.id;
    mounted = def.tab(panel, env);
  };
  d.add(() => {
    mounted?.destroy();
    mounted = null;
  });
  d.add(env.ui.select(options.select, (which) => mount(which)));
  mount(options.select(env.ui.get()));
  return { destroy: () => d.dispose() };
}
