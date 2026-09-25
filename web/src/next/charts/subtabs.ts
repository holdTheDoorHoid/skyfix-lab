/**
 * A Charts tab that holds several charts (charts2 agent, expansion programme Q5): a second,
 * smaller row of tabs above the card, and the chosen chart below it. The Sun tab (sun path,
 * analemma, sunrise bearings, equation of time, solar panel) and the Moon tab (phases, the
 * Moon through the year) use it. OWNER: charts2 agent.
 *
 * WAI-ARIA tabs with automatic activation, like the main tabs: arrows, Home and End move
 * between them. The choice is remembered for the page's lifetime in the `memory` object.
 */

import { h } from '../../dom.js';
import { disposer } from '../component.js';
import { uid, type ChartComponent } from './frame.js';

export interface SubView<T extends string> {
  readonly id: T;
  readonly label: string;
  /** A sentence for the tooltip. */
  readonly title: string;
  readonly chart: ChartComponent;
}

/** Page-lifetime memory of a tab's chosen sub-view, and who to tell when it is changed from outside. */
export interface SubMemory<T extends string> {
  current: T;
  readonly listeners: Set<(id: T) => void>;
}

export function subMemory<T extends string>(initial: T): SubMemory<T> {
  return { current: initial, listeners: new Set() };
}

/** Choose a sub-view from outside (a link from another view); a mounted tab follows. */
export function chooseSub<T extends string>(memory: SubMemory<T>, id: T): void {
  memory.current = id;
  for (const fn of [...memory.listeners]) fn(id);
}

export function withSubViews<T extends string>(label: string, views: readonly SubView<T>[], memory: SubMemory<T>): ChartComponent {
  return (host, ctx, ui) => {
    const d = disposer();
    const panelId = uid('sfc-sub');
    const strip = h('div', { class: 'sf-seg sf-seg--sm sfc-subtabs', role: 'tablist', 'aria-label': label });
    const panel = h('div', { class: 'sfc-subpanel', role: 'tabpanel', id: panelId, tabindex: '-1' });
    host.append(strip, panel);
    d.add(() => {
      strip.remove();
      panel.remove();
    });

    let mounted: { destroy(): void } | null = null;
    let current: T | null = null;
    const tabs = views.map((v, i) => {
      const el = h(
        'button',
        { type: 'button', class: 'sf-seg__opt', role: 'tab', id: `${panelId}-${v.id}`, 'aria-controls': panelId, 'data-tip': v.title, 'data-sub': v.id },
        v.label,
      );
      el.addEventListener('click', () => show(v.id));
      el.addEventListener('keydown', (event) => {
        let j: number | null = null;
        if (event.key === 'ArrowRight') j = (i + 1) % views.length;
        else if (event.key === 'ArrowLeft') j = (i - 1 + views.length) % views.length;
        else if (event.key === 'Home') j = 0;
        else if (event.key === 'End') j = views.length - 1;
        if (j === null) return;
        event.preventDefault();
        show(views[j]!.id);
        tabs[j]?.focus();
      });
      strip.append(el);
      return el;
    });

    function show(id: T): void {
      const view = views.find((v) => v.id === id) ?? views[0]!;
      memory.current = view.id;
      tabs.forEach((el, k) => {
        const on = views[k]!.id === view.id;
        el.setAttribute('aria-selected', String(on));
        el.tabIndex = on ? 0 : -1;
      });
      if (current === view.id) return;
      mounted?.destroy();
      panel.replaceChildren();
      panel.setAttribute('aria-labelledby', `${panelId}-${view.id}`);
      mounted = view.chart(panel, ctx, ui);
      current = view.id;
    }

    const follow = (id: T): void => show(id);
    memory.listeners.add(follow);
    d.add(() => memory.listeners.delete(follow));
    d.add(() => {
      mounted?.destroy();
      mounted = null;
    });
    show(memory.current);
    return { destroy: () => d.dispose() };
  };
}
