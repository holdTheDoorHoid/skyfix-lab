/**
 * The Charts view (EXPLORER_PLAN section 2). OWNER: charts agent.
 *
 * Four hand-built SVG charts on one shared place and time, each with a table view:
 *
 *   Day      height of the Sun, Moon, planets and the selected star through the local day
 *   Year     sunrise, sunset and twilight for every day of the year (a "sun calendar")
 *   Moon     a month of Moon phases with moonrise and moonset
 *   Planets  when each planet is up in the dark, night by night through the year
 *
 * Every time shown is in the display zone with UTC on hover; clicking a time anywhere sets
 * the app's time (`store.time`). Mount with the standard component contract:
 *
 * ```ts
 * import { charts } from './charts/index.js';
 * const view = charts(host, ctx); // later: view.destroy()
 * ```
 */

import './charts.css';
import { h } from '../../dom.js';
import { disposer, type Component, type Ctx, type Mounted } from '../component.js';
import { createStore } from '../state.js';
import { dayChart } from './day-chart.js';
import type { ChartComponent, ChartMode, ChartTab, ChartUi } from './frame.js';
import { moonCalendar } from './moon-calendar.js';
import { planetChart } from './planet-chart.js';
import { yearChart } from './year-chart.js';

export const CHART_TABS: readonly { id: ChartTab; label: string; title: string; chart: ChartComponent }[] = [
  { id: 'day', label: 'Day', title: 'Height above the horizon through the day', chart: dayChart },
  { id: 'year', label: 'Year', title: 'Sunrise, sunset and twilight through the year', chart: yearChart },
  { id: 'moon', label: 'Moon', title: 'Moon phases, moonrise and moonset for the month', chart: moonCalendar },
  { id: 'planets', label: 'Planets', title: 'When each planet is up in the dark, through the year', chart: planetChart },
];

export interface ChartsOptions {
  /** The tab to open with. Default: the last one used on this page, else Day. */
  tab?: ChartTab;
  /** Chart or table. Default: the last one used, else chart. */
  mode?: ChartMode;
}

// Remembered for the page's lifetime, so leaving the Charts view and coming back keeps them.
let lastTab: ChartTab = 'day';
let lastMode: ChartMode = 'chart';

/** The Charts view with options (the dev page opens a given tab). */
export function chartsView(options: ChartsOptions = {}): Component {
  return (host: HTMLElement, ctx: Ctx): Mounted => {
    const d = disposer();
    const ui = createStore<ChartUi>({
      tab: options.tab ?? lastTab,
      mode: options.mode ?? lastMode,
    });

    const root = h('div', { class: 'sfc' });
    host.append(root);
    d.add(() => root.remove());

    // Tabs (WAI-ARIA tabs, automatic activation, arrows move between them).
    const tablist = h('div', { class: 'sfc-tabs', role: 'tablist', 'aria-label': 'Charts' });
    const panel = h('div', { class: 'sfc-panel', role: 'tabpanel', tabindex: '-1' });
    const tabs = CHART_TABS.map((t) => {
      const el = h(
        'button',
        { type: 'button', class: 'sfc-tab', role: 'tab', id: `sfc-tab-${t.id}`, title: t.title, 'aria-controls': 'sfc-chart-panel' },
        t.label,
      );
      el.addEventListener('click', () => ui.patch({ tab: t.id }));
      el.addEventListener('keydown', (event) => {
        const i = CHART_TABS.findIndex((x) => x.id === t.id);
        let j: number | null = null;
        if (event.key === 'ArrowRight') j = (i + 1) % CHART_TABS.length;
        else if (event.key === 'ArrowLeft') j = (i - 1 + CHART_TABS.length) % CHART_TABS.length;
        else if (event.key === 'Home') j = 0;
        else if (event.key === 'End') j = CHART_TABS.length - 1;
        if (j === null) return;
        event.preventDefault();
        ui.patch({ tab: CHART_TABS[j]!.id });
        tabs[j]?.focus();
      });
      tablist.append(el);
      return el;
    });
    panel.id = 'sfc-chart-panel';

    // Chart or table.
    const modeButtons = (['chart', 'table'] as const).map((mode) => {
      const el = h(
        'button',
        { type: 'button', 'aria-pressed': 'false', title: mode === 'chart' ? 'Show the chart' : 'Show the same numbers as a table' },
        mode === 'chart' ? 'Chart' : 'Table',
      );
      el.addEventListener('click', () => ui.patch({ mode }));
      return el;
    });
    const seg = h('div', { class: 'sfc-seg', role: 'group', 'aria-label': 'View as' }, ...modeButtons);

    root.append(h('div', { class: 'sfc-bar' }, tablist, h('div', {}, h('span', { class: 'sfc-seg-label' }, 'View as'), seg)), panel);

    let mounted: { destroy(): void } | null = null;
    let mountedTab: ChartTab | null = null;
    const mount = (tab: ChartTab): void => {
      if (tab === mountedTab) return;
      mounted?.destroy();
      panel.replaceChildren();
      const def = CHART_TABS.find((t) => t.id === tab) ?? CHART_TABS[0]!;
      panel.setAttribute('aria-labelledby', `sfc-tab-${def.id}`);
      mounted = def.chart(panel, ctx, ui);
      mountedTab = def.id;
    };
    d.add(() => {
      mounted?.destroy();
      mounted = null;
    });

    d.add(
      ui.select(
        (u) => u.tab,
        (tab) => {
          lastTab = tab;
          tabs.forEach((el, i) => {
            const on = CHART_TABS[i]!.id === tab;
            el.setAttribute('aria-selected', String(on));
            el.tabIndex = on ? 0 : -1;
          });
          mount(tab);
        },
        { immediate: true },
      ),
    );
    d.add(
      ui.select(
        (u) => u.mode,
        (mode) => {
          lastMode = mode;
          modeButtons.forEach((el, i) => el.setAttribute('aria-pressed', String((i === 0 ? 'chart' : 'table') === mode)));
        },
        { immediate: true },
      ),
    );

    return { destroy: () => d.dispose() };
  };
}

/** The Charts view: mount it for the `charts` view id. */
export const charts: Component = (host, ctx) => chartsView()(host, ctx);

export { dayChart } from './day-chart.js';
export { moonCalendar } from './moon-calendar.js';
export { planetChart } from './planet-chart.js';
export { yearChart } from './year-chart.js';
export type { ChartComponent, ChartMode, ChartTab, ChartUi } from './frame.js';
