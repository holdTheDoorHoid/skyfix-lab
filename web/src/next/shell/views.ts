/**
 * The explorer's views as the switcher shows them. OWNER: shell-design agent.
 * `map` and `globe` share one tab (the map view switches between a flat chart and a
 * globe itself).
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
  /** For the page title and the placeholder. */
  title: string;
  /** What the view will show, for the "coming soon" page. */
  promise: string[];
  /** Something useful to do meanwhile, when there is one. */
  meanwhile?: string;
}

const MAP: ViewMeta = {
  tab: 'map',
  label: 'Map',
  icon: 'map',
  tip: 'The place on a world map, with day and night',
  title: 'Map',
  promise: [
    'A world map that works offline, with an optional street map.',
    'Day, night and the three twilights shaded as they are now.',
    'A compass at your place: where the Sun or Moon rises and sets, where it is now, and its path today.',
    'Where each body is straight overhead, and the circle you would get by measuring its height.',
  ],
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
    promise: [
      'The whole sky from your place: 9 000 stars, the constellations, the planets, and the Moon with its phase.',
      'A horizon view with the compass points, and the sky’s colour following the Sun.',
    ],
  },
  charts: {
    tab: 'charts',
    label: 'Charts',
    icon: 'charts',
    tip: 'Heights through the day, twilight through the year',
    title: 'Charts',
    promise: [
      'The height of each body through the day, over the twilight bands.',
      'Sunrise, sunset and twilight through the year; a Moon calendar; when each planet can be seen.',
    ],
  },
  navigate: {
    tab: 'navigate',
    label: 'Navigate',
    icon: 'sextant',
    tip: 'Sights, corrections and the fix',
    title: 'Navigate',
    promise: [
      'Enter sights by body and sextant reading; see every correction and the fix, with its honest uncertainty.',
      'Noon sight, Polaris, a running fix, averaging a run of sights, and planning tonight’s sights.',
    ],
    meanwhile: 'The current workbench already does sights, corrections, the fix and planning.',
  },
  almanac: {
    tab: 'almanac',
    label: 'Almanac',
    icon: 'almanac',
    tip: 'Printable daily almanac pages',
    title: 'Almanac',
    promise: ['Daily pages laid out the way navigators use them, ready to print.'],
  },
  events: {
    tab: 'events',
    label: 'Events',
    icon: 'events',
    tip: 'Eclipses, Moon phases, equinoxes and solstices',
    title: 'Events',
    promise: [
      'Eclipses: a list, what you would see from your place, and their paths on the map.',
      'Moon phases, equinoxes and solstices, and when planets pass close together.',
    ],
  },
  learn: {
    tab: 'learn',
    label: 'Learn',
    icon: 'learn',
    tip: 'Guided demonstrations and the simulator',
    title: 'Learn',
    promise: ['The demonstrations told as guided stories, the simulator, and the coverage experiments.'],
    meanwhile: 'The demonstrations and the simulator are in the current workbench.',
  },
  about: {
    tab: 'about',
    label: 'About',
    icon: 'about',
    tip: 'Accuracy, sources and the manual',
    title: 'About',
    promise: ['How accurate each part is, where the data comes from, and the manual.'],
  },
};

/** The tabs, in order. */
export const TABS: readonly ViewMeta[] = (['map', 'sky', 'charts', 'navigate', 'almanac', 'events', 'learn', 'about'] as const).map(
  (id) => VIEW_META[id],
);
