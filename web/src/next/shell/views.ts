/**
 * The explorer's views as the switcher shows them. OWNER: shell-design agent; the tab
 * strip since the expansion programme: tonight agent (Q2).
 *
 * `map` and `globe` share one tab (the map view switches between a flat chart and a
 * globe itself). Eight tabs: Tonight joined them in the expansion programme and About left
 * for the Help menu (the **?** in the app strip), where "About SkyFix Lab" opens it; it is
 * still a view, reached at `#about` like any other, with no tab of its own.
 */

import type { ViewId } from '../state.js';
import type { IconName } from '../theme/icons.js';

export interface ViewMeta {
  /** The tab: `map` stands for both `map` and `globe`. */
  tab: Exclude<ViewId, 'globe'>;
  label: string;
  icon: IconName;
  /** Tooltip on the tab. */
  tip: string;
  /** For the page title. */
  title: string;
}

const MAP: ViewMeta = {
  tab: 'map',
  label: 'Map',
  icon: 'map',
  tip: 'The place on a world map, with day and night',
  title: 'Map',
};

export const VIEW_META: Record<ViewId, ViewMeta> = {
  map: MAP,
  globe: { ...MAP, title: 'Globe' },
  sky: {
    tab: 'sky',
    label: 'Sky',
    icon: 'sky',
    tip: 'What you would see: the sky dome and the horizon',
    title: 'Sky',
  },
  tonight: {
    tab: 'tonight',
    label: 'Tonight',
    icon: 'tonight',
    tip: 'The night ahead: darkness, the Moon, planets, deep sky, meteors and what is coming up',
    title: 'Tonight',
  },
  charts: {
    tab: 'charts',
    label: 'Charts',
    icon: 'charts',
    tip: 'Heights through the day, twilight through the year',
    title: 'Charts',
  },
  navigate: {
    tab: 'navigate',
    label: 'Navigate',
    icon: 'sextant',
    tip: 'Sights, corrections and the fix',
    title: 'Navigate',
  },
  almanac: {
    tab: 'almanac',
    label: 'Almanac',
    icon: 'almanac',
    tip: 'Printable daily almanac pages',
    title: 'Almanac',
  },
  events: {
    tab: 'events',
    label: 'Events',
    icon: 'events',
    tip: 'Eclipses, Moon phases, equinoxes and solstices, planet events',
    title: 'Events',
  },
  learn: {
    tab: 'learn',
    label: 'Learn',
    icon: 'learn',
    tip: 'Guided demonstrations and the simulator',
    title: 'Learn',
  },
  about: {
    tab: 'about',
    label: 'About',
    icon: 'about',
    tip: 'Accuracy, sources and the manual',
    title: 'About',
  },
};

/** The tabs, in order: eight, two rows of four on a desktop. About is in the Help menu. */
export const TAB_IDS = ['map', 'sky', 'tonight', 'charts', 'navigate', 'almanac', 'events', 'learn'] as const;

/** The tabs, in order. */
export const TABS: readonly ViewMeta[] = TAB_IDS.map((id) => VIEW_META[id]);

/** True when the view has a tab of its own (About is reached from Help). */
export function hasTab(view: ViewId): boolean {
  return TABS.some((t) => t.tab === VIEW_META[view].tab);
}
