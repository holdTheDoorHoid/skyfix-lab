/**
 * DESIGN MOCKUP DATA — hard-coded, illustrative numbers (EXPLORER_PLAN work package E2,
 * phase 1). Nothing here is a result: the values were produced once by the MOCK engine
 * (`src/next/engine/mock.ts`, low-precision formulas) for Philadelphia City Hall on
 * Thursday 2026-09-24 at 16:30 EDT, so that every number on the mockup agrees with every
 * other. The real shell reads the engine instead.
 *
 * Shapes follow the engine contract (docs/EXPLORER_API.md) so the phase-2 shell can
 * draw the same things from `ctx.engine`.
 */

import type { BodyKind, PhaseSegment, SkyPhase } from '../engine/types.js';

/** Local midnight, 2026-09-24 00:00 EDT (04:00 UTC), as a UTC Julian Date. */
export const DAY_START = 2461307.6666666665;
export const DAY_END = DAY_START + 1;
/** Hours after local midnight -> jd_utc. */
export const at = (hours: number): number => DAY_START + hours / 24;

/** The moment shown: 16:30 EDT = 20:30 UTC. */
export const NOW_JD = at(16.5);
export const ZONE = { kind: 'iana', zone: 'America/New_York' } as const;

export const PLACE = {
  label: 'Philadelphia City Hall',
  lat_deg: 39.9526,
  lon_deg: -75.1652,
  height_of_eye_m: 2,
};

/** day_events(...).phases for the local day (CONVENTIONS 13.4). */
export const PHASES: PhaseSegment[] = (
  [
    [0, 5.3264, 'night'],
    [5.3264, 5.8609, 'astronomical'],
    [5.8609, 6.3871, 'nautical'],
    [6.3871, 6.8371, 'civil'],
    [6.8371, 18.9052, 'day'],
    [18.9052, 19.3543, 'civil'],
    [19.3543, 19.8792, 'nautical'],
    [19.8792, 20.4121, 'astronomical'],
    [20.4121, 24, 'night'],
  ] as [number, number, SkyPhase][]
).map(([a, b, phase]) => ({ jd_start: at(a), jd_end: at(b), phase }));

/** The Sun's events today (hours after local midnight; azimuth or altitude). */
export const SUN_EVENTS = {
  astronomical_dawn: { h: 5.3264, az: 74.97 },
  nautical_dawn: { h: 5.8609, az: 80.48 },
  civil_dawn: { h: 6.3871, az: 85.68 },
  rise: { h: 6.8371, az: 90.04 },
  transit: { h: 12.8766, alt: 49.387 },
  set: { h: 18.9052, az: 269.71 },
  civil_dusk: { h: 19.3543, az: 274.04 },
  nautical_dusk: { h: 19.8792, az: 279.21 },
  astronomical_dusk: { h: 20.4121, az: 284.68 },
  day_length_h: 12.068,
};

export const MOON_EVENTS = {
  set: { h: 4.5093, az: 256.38 },
  rise: { h: 17.9114, az: 99.35 },
  transit: { h: 23.6741, alt: 43.731 },
};

/** Next principal phase: full Moon, 2026-09-26 16:49 UTC. */
export const NEXT_FULL_MOON_JD = 2461310.2008291;

export interface MockBody {
  body: string;
  kind: BodyKind;
  /** Apparent topocentric altitude (with display refraction). */
  alt: number;
  az: number;
  gha: number;
  dec: number;
  gp: [number, number];
  magnitude: number | null;
  illuminated?: number;
  limbFromUp?: number;
  distance_km?: number;
  sd_arcmin?: number;
  hp_arcmin?: number;
  hc?: number;
  zn?: number;
  rises_h?: number;
}

/** sky_state(...) at 16:30 EDT, the solar-system bodies. */
export const BODIES: MockBody[] = [
  { body: 'Mercury', kind: 'planet', alt: 30.42, az: 222.08, gha: 111.054, dec: -9.552, gp: [-9.552, -111.054], magnitude: -0.17, illuminated: 0.831 },
  { body: 'Venus', kind: 'planet', alt: 26.24, az: 204.61, gha: 98.592, dec: -19.972, gp: [-19.972, -98.592], magnitude: -4.56, illuminated: 0.205 },
  {
    body: 'Sun',
    kind: 'sun',
    alt: 26.04,
    az: 244.73,
    gha: 129.529,
    dec: -0.718,
    gp: [-0.718, -129.529],
    magnitude: -26.73,
    distance_km: 150060030,
    sd_arcmin: 15.94,
    hp_arcmin: 0.15,
    hc: 26.012,
    zn: 244.725,
  },
  { body: 'Jupiter', kind: 'planet', alt: 6.57, az: 285.29, gha: 170.075, dec: 15.836, gp: [15.836, -170.075], magnitude: -1.85, illuminated: 0.996 },
  { body: 'Mars', kind: 'planet', alt: -3.61, az: 302.72, gha: 190.823, dec: 21.437, gp: [21.437, 169.177], magnitude: 1.16 },
  {
    body: 'Moon',
    kind: 'moon',
    alt: -16.05,
    az: 86.45,
    gha: 330.748,
    dec: -7.426,
    gp: [-7.426, 29.252],
    magnitude: -12.14,
    illuminated: 0.962,
    // bright_limb_angle_deg 249.8 minus parallactic_angle_deg -50.6
    limbFromUp: 300.4,
    distance_km: 387497,
    rises_h: 17.9114,
  },
  { body: 'Neptune', kind: 'planet', alt: -27.12, az: 64.0, gha: 307.853, dec: -0.104, gp: [-0.104, 52.147], magnitude: 7.81 },
  { body: 'Uranus', kind: 'planet', alt: -27.89, az: 351.8, gha: 247.452, dec: 21.086, gp: [21.086, 112.548], magnitude: 5.64 },
  { body: 'Saturn', kind: 'planet', alt: -31.16, az: 54.47, gha: 298.971, dec: 2.303, gp: [2.303, 61.029], magnitude: 0.68 },
];

/** How many of the 58 navigational stars are above the horizon at 16:30 (all hidden by daylight). */
export const STARS_ABOVE = 26;

/** The Sun's apparent altitude and azimuth every 10 minutes from local midnight (sample_bodies). */
export const SUN_PATH_ALT: number[] = [-48.06,-48.67,-49.16,-49.52,-49.76,-49.86,-49.83,-49.68,-49.39,-48.98,-48.44,-47.78,-47.02,-46.15,-45.17,-44.11,-42.96,-41.73,-40.42,-39.05,-37.62,-36.13,-34.59,-33.01,-31.38,-29.72,-28.02,-26.29,-24.53,-22.75,-20.94,-19.12,-17.28,-15.42,-13.55,-11.67,-9.77,-7.87,-5.97,-4.06,-2.15,-0.25,1.4,3.18,5.03,6.89,8.77,10.64,12.51,14.38,16.23,18.06,19.89,21.69,23.47,25.23,26.96,28.66,30.33,31.96,33.55,35.09,36.59,38.03,39.42,40.74,41.99,43.16,44.26,45.26,46.17,46.98,47.68,48.26,48.73,49.08,49.3,49.4,49.36,49.2,48.91,48.5,47.97,47.32,46.57,45.71,44.75,43.7,42.56,41.34,40.05,38.7,37.28,35.81,34.29,32.71,31.1,29.45,27.76,26.04,24.3,22.53,20.73,18.92,17.09,15.24,13.38,11.51,9.64,7.76,5.88,4.02,2.2,0.48,-1.28,-3.2,-5.11,-7.02,-8.93,-10.83,-12.72,-14.61,-16.48,-18.33,-20.17,-21.99,-23.79,-25.57,-27.32,-29.04,-30.73,-32.39,-34.01,-35.58,-37.1,-38.57,-39.99,-41.33,-42.61,-43.82,-44.94,-45.97,-46.91,-47.74,-48.46];
export const SUN_PATH_AZ: number[] = [339.76,343.46,347.24,351.09,354.99,358.91,2.84,6.76,10.64,14.46,18.21,21.87,25.43,28.88,32.22,35.43,38.53,41.51,44.36,47.11,49.75,52.28,54.72,57.06,59.32,61.51,63.61,65.65,67.63,69.56,71.43,73.26,75.04,76.8,78.51,80.21,81.87,83.52,85.16,86.78,88.39,90,91.61,93.22,94.84,96.46,98.1,99.76,101.44,103.15,104.88,106.65,108.46,110.3,112.2,114.15,116.16,118.23,120.36,122.58,124.87,127.25,129.71,132.28,134.95,137.72,140.61,143.6,146.71,149.94,153.27,156.71,160.26,163.88,167.59,171.36,175.17,179,182.84,186.67,190.46,194.19,197.86,201.45,204.94,208.32,211.6,214.76,217.82,220.75,223.58,226.3,228.91,231.42,233.84,236.17,238.42,240.59,242.69,244.73,246.7,248.62,250.49,252.31,254.09,255.84,257.56,259.25,260.91,262.56,264.19,265.8,267.41,269.02,270.62,272.23,273.84,275.46,277.1,278.75,280.43,282.12,283.85,285.62,287.42,289.26,291.15,293.1,295.1,297.17,299.31,301.53,303.82,306.21,308.69,311.28,313.97,316.77,319.69,322.73,325.89,329.18,332.58,336.1,339.73];

/** The Sun's path on the solstices at this place, [altitude, azimuth] every 10 minutes while up. */
export const SOLSTICE_JUNE: [number, number][] = [[-0.54,57.57],[0.86,59.18],[2.38,60.76],[3.98,62.32],[5.64,63.86],[7.34,65.37],[9.08,66.86],[10.83,68.34],[12.61,69.81],[14.41,71.26],[16.22,72.7],[18.05,74.14],[19.9,75.57],[21.76,77.01],[23.62,78.44],[25.5,79.88],[27.39,81.33],[29.29,82.8],[31.19,84.28],[33.09,85.78],[35.01,87.3],[36.92,88.86],[38.83,90.46],[40.75,92.1],[42.66,93.79],[44.57,95.55],[46.47,97.37],[48.37,99.28],[50.25,101.28],[52.12,103.4],[53.98,105.64],[55.81,108.03],[57.62,110.61],[59.39,113.38],[61.13,116.4],[62.82,119.7],[64.45,123.32],[66.02,127.33],[67.5,131.77],[68.87,136.72],[70.11,142.22],[71.21,148.31],[72.12,155],[72.82,162.26],[73.28,169.97],[73.48,177.96],[73.41,186],[73.08,193.88],[72.5,201.38],[71.69,208.37],[70.69,214.77],[69.52,220.56],[68.21,225.78],[66.78,230.47],[65.26,234.7],[63.66,238.51],[61.99,241.97],[60.28,245.12],[58.52,248.01],[56.73,250.68],[54.91,253.16],[53.06,255.48],[51.2,257.66],[49.32,259.72],[47.43,261.67],[45.53,263.54],[43.63,265.32],[41.72,267.05],[39.8,268.71],[37.89,270.33],[35.98,271.91],[34.06,273.45],[32.15,274.96],[30.25,276.45],[28.35,277.93],[26.46,279.38],[24.58,280.83],[22.7,282.26],[20.84,283.7],[18.99,285.13],[17.15,286.57],[15.33,288.01],[13.52,289.45],[11.73,290.91],[9.96,292.38],[8.22,293.87],[6.5,295.37],[4.82,296.9],[3.18,298.44],[1.61,300.01],[0.17,301.61]];
export const SOLSTICE_DECEMBER: [number, number][] = [[-0.06,120.63],[1.35,122.24],[2.84,123.87],[4.36,125.54],[5.86,127.25],[7.34,128.99],[8.79,130.76],[10.21,132.58],[11.59,134.44],[12.93,136.34],[14.22,138.28],[15.47,140.27],[16.66,142.3],[17.8,144.38],[18.88,146.51],[19.91,148.68],[20.87,150.9],[21.77,153.16],[22.6,155.47],[23.35,157.82],[24.04,160.21],[24.65,162.64],[25.18,165.09],[25.63,167.58],[26,170.09],[26.29,172.63],[26.49,175.18],[26.61,177.74],[26.64,180.3],[26.59,182.86],[26.45,185.42],[26.23,187.97],[25.92,190.5],[25.53,193],[25.06,195.48],[24.51,197.94],[23.88,200.35],[23.18,202.73],[22.41,205.07],[21.56,207.37],[20.65,209.62],[19.67,211.83],[18.64,213.99],[17.54,216.11],[16.39,218.18],[15.18,220.2],[13.92,222.18],[12.62,224.11],[11.27,226],[9.88,227.85],[8.46,229.66],[7,231.42],[5.51,233.15],[4,234.85],[2.49,236.51],[1.01,238.14],[-0.38,239.74]];
