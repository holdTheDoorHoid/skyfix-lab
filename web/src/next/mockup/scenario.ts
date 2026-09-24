/**
 * DESIGN MOCKUP: the two moments the mockup can show, assembled from the hard-coded data
 * (data.ts). `afternoon` is 16:30 EDT with the Sun selected; `evening` is 19:35 EDT, in
 * nautical twilight, with the Moon selected. Both are Philadelphia City Hall on
 * Thursday 2026-09-24. Illustrative numbers only.
 */

import type { SkyPhase } from '../engine/types.js';
import type { GlyphName } from '../theme/glyphs.js';
import {
  at,
  BODIES,
  EVENING_BODIES,
  EVENING_JD,
  EVENING_STARS_ABOVE,
  EVENING_SUBSOLAR,
  MOON_EVENTS,
  MOON_PATH_ALT,
  MOON_PATH_AZ,
  MOON_TONIGHT,
  NOW_JD,
  SOLSTICE_DECEMBER,
  SOLSTICE_JUNE,
  STARS_ABOVE,
  SUN_EVENTS,
  SUN_PATH_ALT,
  SUN_PATH_AZ,
  type MockBody,
} from './data.js';

export type Moment = 'afternoon' | 'evening';

export interface EventTime {
  jd: number;
  /** Bearing along the horizon (rise, set) … */
  az?: number;
  /** … or height at transit. */
  alt?: number;
}

export interface Scenario {
  id: Moment;
  jd: number;
  phase: SkyPhase;
  /** The Sun's ground point, for the map's shading. */
  subsolar: [number, number];
  /** Following the wall clock (the "Now" button pressed). */
  live: boolean;
  handleGlyph: 'sun' | 'moon';
  selected: MockBody;
  glyph: GlyphName;
  colorToken: string;
  /** The selected body's events inside today's local day (the ribbon's ticks). */
  dayEvents: { rise?: EventTime; transit?: EventTime; set?: EventTime };
  /** Around now: the rise, highest point and set of the current passage (cards, compass). */
  passage: { rise: EventTime; transit: EventTime; set: EventTime; setNextDay: boolean };
  /** Apparent altitude and azimuth samples of the passage, for the compass. */
  path: { alt: readonly number[]; az: readonly number[]; stepsPerHour: number };
  band?: { summer: readonly (readonly [number, number])[]; winter: readonly (readonly [number, number])[] };
  /** Everything above the horizon worth listing, and what is below. */
  up: MockBody[];
  below: MockBody[];
  starsUp: number;
  starsListed: number;
  /** Ground points drawn on the map. */
  groundPoints: MockBody[];
}

const find = (list: MockBody[], name: string): MockBody => list.find((b) => b.body === name)!;

const afternoon: Scenario = {
  id: 'afternoon',
  jd: NOW_JD,
  phase: 'day',
  subsolar: [find(BODIES, 'Sun').gp[0], find(BODIES, 'Sun').gp[1]],
  live: true,
  handleGlyph: 'sun',
  selected: find(BODIES, 'Sun'),
  glyph: 'sun',
  colorToken: '--body-sun',
  dayEvents: {
    rise: { jd: at(SUN_EVENTS.rise.h), az: SUN_EVENTS.rise.az },
    transit: { jd: at(SUN_EVENTS.transit.h), alt: SUN_EVENTS.transit.alt },
    set: { jd: at(SUN_EVENTS.set.h), az: SUN_EVENTS.set.az },
  },
  passage: {
    rise: { jd: at(SUN_EVENTS.rise.h), az: SUN_EVENTS.rise.az },
    transit: { jd: at(SUN_EVENTS.transit.h), alt: SUN_EVENTS.transit.alt },
    set: { jd: at(SUN_EVENTS.set.h), az: SUN_EVENTS.set.az },
    setNextDay: false,
  },
  path: { alt: SUN_PATH_ALT, az: SUN_PATH_AZ, stepsPerHour: 6 },
  band: { summer: SOLSTICE_JUNE, winter: SOLSTICE_DECEMBER },
  up: BODIES.filter((b) => b.alt > 0).sort((a, b) => b.alt - a.alt),
  below: BODIES.filter((b) => b.alt <= 0),
  starsUp: STARS_ABOVE,
  starsListed: 0,
  groundPoints: BODIES.filter((b) => ['Sun', 'Moon', 'Venus', 'Mercury', 'Jupiter'].includes(b.body)),
};

const evening: Scenario = {
  id: 'evening',
  jd: EVENING_JD,
  phase: 'nautical',
  subsolar: EVENING_SUBSOLAR,
  live: false,
  handleGlyph: 'moon',
  selected: find(EVENING_BODIES, 'Moon'),
  glyph: 'moon',
  colorToken: '--body-moon',
  dayEvents: {
    set: { jd: at(MOON_EVENTS.set.h), az: MOON_EVENTS.set.az },
    rise: { jd: at(MOON_EVENTS.rise.h), az: MOON_EVENTS.rise.az },
    transit: { jd: at(MOON_EVENTS.transit.h), alt: MOON_EVENTS.transit.alt },
  },
  passage: {
    rise: { jd: at(MOON_TONIGHT.rise.h), az: MOON_TONIGHT.rise.az },
    transit: { jd: at(MOON_TONIGHT.transit.h), alt: MOON_TONIGHT.transit.alt },
    set: { jd: at(MOON_TONIGHT.set.h), az: MOON_TONIGHT.set.az },
    setNextDay: true,
  },
  path: { alt: MOON_PATH_ALT, az: MOON_PATH_AZ, stepsPerHour: 6 },
  up: EVENING_BODIES.filter((b) => b.alt > 0).sort((a, b) => b.alt - a.alt),
  below: EVENING_BODIES.filter((b) => b.alt <= 0),
  starsUp: EVENING_STARS_ABOVE,
  starsListed: EVENING_BODIES.filter((b) => b.kind === 'star' && b.alt > 0).length,
  // Only ground points inside the mockup's view (the Sun's and Venus's are over the Pacific).
  groundPoints: EVENING_BODIES.filter((b) => ['Moon'].includes(b.body)),
};

export const SCENARIOS: Record<Moment, Scenario> = { afternoon, evening };
