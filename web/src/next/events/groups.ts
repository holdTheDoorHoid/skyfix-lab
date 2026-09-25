/**
 * The Moon and Planets tabs: each a strip of its own tabs over one list. OWNER: events2.
 */

import { apsidesTab } from './apsides.js';
import { conjunctionsTab } from './conjunctions.js';
import type { MoonSub, PlanetSub, TabComponent } from './env.js';
import { jupiterTab } from './jupiter.js';
import { moonTab, planetsTab } from './lists.js';
import { occultationsTab } from './occultations.js';
import { retrogradeTab } from './retrograde.js';
import { subTabs, type SubTab } from './subtabs.js';
import { transitsTab } from './transits.js';

const MOON: readonly SubTab<MoonSub>[] = [
  { id: 'phases', label: 'Phases', tip: 'New Moon, first quarter, full Moon and last quarter for the coming months', tab: moonTab },
  {
    id: 'apsides',
    label: 'Perigee and supermoons',
    tip: 'The Moon nearest and farthest each month, supermoons, and the year’s largest and smallest full Moon',
    tab: apsidesTab,
  },
  {
    id: 'occultations',
    label: 'Occultations',
    tip: 'Bright stars and planets the Moon passes in front of, seen from your place',
    tab: occultationsTab,
  },
];

const PLANETS: readonly SubTab<PlanetSub>[] = [
  { id: 'events', label: 'Highlights', tip: 'Oppositions, conjunctions with the Sun, greatest elongations and closest approaches', tab: planetsTab },
  { id: 'conjunctions', label: 'Close approaches', tip: 'Planets passing each other, the Moon and bright stars', tab: conjunctionsTab },
  { id: 'retrograde', label: 'Retrograde', tip: 'When each planet seems to stop and go backwards against the stars', tab: retrogradeTab },
  { id: 'transits', label: 'Transits', tip: 'Mercury and Venus crossing the Sun’s face, as seen from your place', tab: transitsTab },
  { id: 'jupiter', label: 'Jupiter’s moons', tip: 'Transits, shadows, eclipses and occultations of Jupiter’s four big moons, night by night', tab: jupiterTab },
];

export const moonGroup: TabComponent = (host, env) =>
  subTabs(host, env, {
    label: 'The Moon',
    tabs: MOON,
    select: (u) => u.moonSub,
    choose: (ui, id) => ui.patch({ moonSub: id }),
    className: 'sfe-group sfe-group--moon',
  });

export const planetsGroup: TabComponent = (host, env) =>
  subTabs(host, env, {
    label: 'The planets',
    tabs: PLANETS,
    select: (u) => u.planetSub,
    choose: (ui, id) => ui.patch({ planetSub: id }),
    className: 'sfe-group sfe-group--planets',
  });
