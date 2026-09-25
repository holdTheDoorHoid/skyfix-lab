/**
 * The Charts view (EXPLORER_PLAN section 2). OWNER: charts agent; the Sun and Tides tabs,
 * the Moon tab's year chart and every chart's Save menu: charts2 agent (expansion
 * programme Q5).
 *
 * Hand-built SVG charts on one shared place and time, each with a table view:
 *
 *   Day      height of the Sun, Moon, planets and the selected star through the local day
 *   Year     sunrise, sunset and twilight for every day of the year (a "sun calendar")
 *   Sun      the Sun's path across the sky, the analemma, sunrise and sunset bearings through
 *            the year, the equation of time, and a solar-panel helper (clear-sky estimate)
 *   Moon     a month of Moon phases with moonrise, moonset, perigee and apogee; the Moon's
 *            height and bearing at an hour of the evening through the year
 *   Planets  when each planet is up in the dark, through the year
 *   Tides    predicted high and low water and the tide curve at US stations (the tides-us pack)
 *
 * Every time shown is in the display zone with UTC on hover; clicking a time anywhere sets
 * the app's time (`store.time`). Every card has a Save menu: picture (PNG), table (CSV),
 * print, share. Mount with the standard component contract:
 *
 * ```ts
 * import { charts } from './charts/index.js';
 * const view = charts(host, ctx); // later: view.destroy()
 * ```
 */

import '../theme/index.js';
import './charts.css';
import { h } from '../../dom.js';
import { disposer, type Component, type Ctx, type Mounted } from '../component.js';
import { createStore, type ExplorerStore } from '../state.js';
import { segmented } from '../theme/primitives.js';
import { analemmaChart } from './analemma.js';
import { dayChart } from './day-chart.js';
import { eotChart } from './eot.js';
import { uid, type ChartComponent, type ChartMode, type ChartTab, type ChartUi } from './frame.js';
import { moonCalendar } from './moon-calendar.js';
import { moonYearChart } from './moon-year.js';
import { planetChart } from './planet-chart.js';
import { solarChart } from './solar.js';
import { chooseSub, subMemory, withSubViews, type SubView } from './subtabs.js';
import { sunBearingsChart } from './sun-bearings.js';
import { sunPathChart } from './sun-path.js';
import { tidesChart } from './tides.js';
import { yearChart } from './year-chart.js';

export type SunView = 'path' | 'analemma' | 'bearings' | 'eot' | 'solar';
export type MoonView = 'phases' | 'year';

export const SUN_VIEWS: readonly SubView<SunView>[] = [
  { id: 'path', label: 'Sun path', title: 'The Sun’s path across the sky today, at the solstices and at the equinoxes', chart: sunPathChart },
  { id: 'analemma', label: 'Analemma', title: 'Where the Sun stands at one time of day, every day of the year', chart: analemmaChart },
  { id: 'bearings', label: 'Sunrise bearings', title: 'Where on the horizon the Sun rises and sets, through the year', chart: sunBearingsChart },
  { id: 'eot', label: 'Equation of time', title: 'How far a sundial runs fast or slow, and the Sun’s declination, through the year', chart: eotChart },
  { id: 'solar', label: 'Solar panel', title: 'Clear-sky energy on a solar panel through the year, and the best tilt (an estimate)', chart: solarChart },
];

export const MOON_VIEWS: readonly SubView<MoonView>[] = [
  { id: 'phases', label: 'Phases', title: 'Moon phases, moonrise, moonset, perigee and apogee for the month', chart: moonCalendar },
  { id: 'year', label: 'Through the year', title: 'The Moon’s height and bearing at one hour, every day of the year', chart: moonYearChart },
];

const sunMemory = subMemory<SunView>('path');
const moonMemory = subMemory<MoonView>('phases');

export const CHART_TABS: readonly { id: ChartTab; label: string; title: string; chart: ChartComponent }[] = [
  { id: 'day', label: 'Day', title: 'Height above the horizon through the day', chart: dayChart },
  { id: 'year', label: 'Year', title: 'Sunrise, sunset and twilight through the year', chart: yearChart },
  { id: 'sun', label: 'Sun', title: 'Sun path, analemma, sunrise bearings, equation of time and a solar panel', chart: withSubViews('Sun charts', SUN_VIEWS, sunMemory) },
  { id: 'moon', label: 'Moon', title: 'Moon phases for the month, and the Moon through the year', chart: withSubViews('Moon charts', MOON_VIEWS, moonMemory) },
  { id: 'planets', label: 'Planets', title: 'When each planet is up in the dark, through the year', chart: planetChart },
  { id: 'tides', label: 'Tides', title: 'Predicted high and low water at US tide stations', chart: tidesChart },
];

export interface ChartsOptions {
  /** The tab to open with. Default: the last one used on this page, else Day. */
  tab?: ChartTab;
  /** Chart or table. Default: the last one used, else chart. */
  mode?: ChartMode;
  /** The Sun tab's chart to open with (default: the last one used, else the sun path). */
  sun?: SunView;
  /** The Moon tab's chart to open with (default: the last one used, else the phases). */
  moon?: MoonView;
}

// Remembered for the page's lifetime, so leaving the Charts view and coming back keeps them.
let lastTab: ChartTab = 'day';
let lastMode: ChartMode = 'chart';
/** Mounted Charts views, told when another view asks for a tab (`showCharts`). */
const tabListeners = new Set<(tab: ChartTab) => void>();

/**
 * Open the Charts view on a tab, and on one of the Sun or Moon tab's charts: for links from
 * other views ("the tide curve", "the sun path"). A mounted Charts view switches at once.
 */
export function showCharts(store: ExplorerStore, tab: ChartTab, sub?: SunView | MoonView): void {
  lastTab = tab;
  if (tab === 'sun' && sub && SUN_VIEWS.some((v) => v.id === sub)) chooseSub(sunMemory, sub as SunView);
  if (tab === 'moon' && sub && MOON_VIEWS.some((v) => v.id === sub)) chooseSub(moonMemory, sub as MoonView);
  for (const fn of [...tabListeners]) fn(tab);
  if (store.get().view !== 'charts') store.patch({ view: 'charts' });
}

/** The Charts view with options (the dev page opens a given tab). */
export function chartsView(options: ChartsOptions = {}): Component {
  return (host: HTMLElement, ctx: Ctx): Mounted => {
    const d = disposer();
    if (options.sun) sunMemory.current = options.sun;
    if (options.moon) moonMemory.current = options.moon;
    const ui = createStore<ChartUi>({
      tab: options.tab ?? lastTab,
      mode: options.mode ?? lastMode,
    });

    const root = h('div', { class: 'sfc sf-on-stage' });
    host.append(root);
    d.add(() => root.remove());

    // Tabs (WAI-ARIA tabs, automatic activation, arrows move between them).
    const tablist = h('div', { class: 'sf-seg sfc-tabs', role: 'tablist', 'aria-label': 'Charts' });
    const panelId = uid('sfc-chart-panel');
    const panel = h('div', { class: 'sfc-panel', role: 'tabpanel', tabindex: '-1', id: panelId });
    const tabs = CHART_TABS.map((t) => {
      const el = h(
        'button',
        { type: 'button', class: 'sf-seg__opt', role: 'tab', id: `${panelId}-${t.id}`, 'data-tip': t.title, 'aria-controls': panelId, 'data-tab': t.id },
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

    // Chart or table.
    const mode = segmented<ChartMode>({
      label: 'View as',
      size: 'sm',
      value: ui.get().mode,
      options: [
        { value: 'chart', label: 'Chart', tip: 'Show the chart' },
        { value: 'table', label: 'Table', tip: 'Show the same numbers as a table' },
      ],
      onChange: (value) => ui.patch({ mode: value }),
    });

    root.append(
      h('div', { class: 'sfc-bar' }, tablist, h('div', { class: 'sfc-mode' }, h('span', {}, 'View as'), mode.el)),
      panel,
    );

    let mounted: { destroy(): void } | null = null;
    let mountedTab: ChartTab | null = null;
    const mount = (tab: ChartTab): void => {
      if (tab === mountedTab) return;
      mounted?.destroy();
      panel.replaceChildren();
      const def = CHART_TABS.find((t) => t.id === tab) ?? CHART_TABS[0]!;
      panel.setAttribute('aria-labelledby', `${panelId}-${def.id}`);
      mounted = def.chart(panel, ctx, ui);
      mountedTab = def.id;
    };
    d.add(() => {
      mounted?.destroy();
      mounted = null;
    });

    const follow = (tab: ChartTab): void => ui.patch({ tab });
    tabListeners.add(follow);
    d.add(() => tabListeners.delete(follow));

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
        (value) => {
          lastMode = value;
          mode.set(value);
        },
        { immediate: true },
      ),
    );

    return { destroy: () => d.dispose() };
  };
}

/** The Charts view: mount it for the `charts` view id. */
export const charts: Component = (host, ctx) => chartsView()(host, ctx);

export { analemmaChart } from './analemma.js';
export { dayChart } from './day-chart.js';
export { eotChart } from './eot.js';
export { moonCalendar } from './moon-calendar.js';
export { moonYearChart } from './moon-year.js';
export { planetChart } from './planet-chart.js';
export { solarChart } from './solar.js';
export { sunBearingsChart } from './sun-bearings.js';
export { sunPathChart } from './sun-path.js';
export { tidesChart } from './tides.js';
export { yearChart } from './year-chart.js';
export type { ChartComponent, ChartMode, ChartTab, ChartUi } from './frame.js';
