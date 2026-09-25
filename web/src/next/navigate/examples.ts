/**
 * Example sessions, one or more per method, so a newcomer can see each method work before
 * entering their own sights. Every example is marked SIMULATED and says where its numbers
 * come from. OWNER: navigate agent.
 *
 * Sources (all are this project's own test data or public-domain worked examples):
 * - fixtures/reference/nav_methods.json and fixtures/sessions/reference-*.json: raw sextant
 *   readings built from Skyfield + JPL ephemerides by tools/reference/ (never from the
 *   Rust core), zero noise;
 * - fixtures/reference/bowditch_worked_examples.json: The American Practical Navigator
 *   (Bowditch, NGA Pub. 9, 2019), sections 1910 and 1912 — a U.S. Government work;
 * - fixtures/reference/lunar_distances.json, case lunar-19;
 * - "Five stars at dusk" is made here, at load time, by the engine's own predicted sextant
 *   readings at a stated true position plus stated errors: a simulation, labelled so.
 */

import type { Observation, Session } from '../../types.js';
import { SESSION_SCHEMA } from '../../types.js';
import type { NavTools } from '../engine/wasm-nav.js';
import { jdFromIso } from '../time.js';
import { defaultWorking, type Working } from './model.js';
import type { MethodId } from './text.js';

export interface Example {
  id: string;
  title: string;
  /** One sentence: what it shows. */
  blurb: string;
  method: MethodId;
  /** The working state it loads (built on the defaults). Throws when it cannot be built. */
  build(nav: NavTools | null): Working;
}

function session(name: string, notes: string, parts: Partial<Omit<Session, 'meta' | 'schema'>> & { observations: Observation[] }): Session {
  return {
    schema: SESSION_SCHEMA,
    meta: { name, notes, kind: 'simulated' },
    observer: parts.observer ?? {
      height_of_eye_m: 0,
      pressure_hpa: 1010,
      temperature_c: 10,
      assumed_position: null,
      assumed_position_role: { role: 'initializer' },
    },
    instrument: parts.instrument ?? { name: '', index_correction_arcmin: 0, horizon: 'sea' },
    clock: parts.clock ?? { uncertainty_s: 0, correction_s: 0 },
    observations: parts.observations,
  };
}

const obs = (id: string, body: string, utc: string, altitude_deg: number, extra: Partial<Observation> = {}): Observation => ({
  id,
  body,
  utc,
  altitude_deg,
  altitude_kind: 'sextant_hs',
  sigma_arcmin: 0.5,
  limb: 'center',
  horizon: null,
  geocentric: null,
  notes: '',
  ...extra,
});

/** The generator's observer for fixtures/reference/nav_methods.json. */
const NAV_METHODS_OBSERVER = (lat: number, lon: number): Session['observer'] => ({
  height_of_eye_m: 3,
  pressure_hpa: 1010,
  temperature_c: 10,
  assumed_position: { lat_deg: lat, lon_deg: lon },
  assumed_position_role: { role: 'initializer' },
});
const NAV_METHODS_INSTRUMENT: Session['instrument'] = { name: 'synthetic sextant', index_correction_arcmin: -1.2, horizon: 'sea' };
const SKYFIELD = 'Raw sextant readings built by tools/reference/gen_nav_methods.py from Skyfield and JPL ephemerides (fixtures/reference/nav_methods.json), zero noise.';

const NOON_RUN: [string, string, number][] = [
  ['n00', '2026-09-23T16:32:58Z', 49.340197617],
  ['n01', '2026-09-23T16:34:58Z', 49.38856457],
  ['n02', '2026-09-23T16:36:58Z', 49.43183289],
  ['n03', '2026-09-23T16:38:58Z', 49.469985671],
  ['n04', '2026-09-23T16:40:58Z', 49.503007905],
  ['n05', '2026-09-23T16:42:58Z', 49.530886587],
  ['n06', '2026-09-23T16:44:58Z', 49.553610688],
  ['n07', '2026-09-23T16:46:58Z', 49.571171188],
  ['n08', '2026-09-23T16:48:58Z', 49.583561092],
  ['n09', '2026-09-23T16:50:58Z', 49.590775449],
  ['n10', '2026-09-23T16:52:58Z', 49.59281135],
  ['n11', '2026-09-23T16:54:58Z', 49.58966795],
  ['n12', '2026-09-23T16:56:58Z', 49.581346455],
  ['n13', '2026-09-23T16:58:58Z', 49.567850129],
  ['n14', '2026-09-23T17:00:58Z', 49.54918428],
  ['n15', '2026-09-23T17:02:58Z', 49.525356249],
  ['n16', '2026-09-23T17:04:58Z', 49.496375423],
  ['n17', '2026-09-23T17:06:58Z', 49.462253172],
  ['n18', '2026-09-23T17:08:58Z', 49.423002857],
  ['n19', '2026-09-23T17:10:58Z', 49.378639799],
  ['n20', '2026-09-23T17:12:58Z', 49.329181231],
];

const VEGA_RUN: [string, string, number][] = [
  ['a00', '2026-10-01T01:28:30Z', 61.436228321],
  ['a01', '2026-10-01T01:29:00Z', 61.341619233],
  ['a02', '2026-10-01T01:29:30Z', 61.247024756],
  ['a03', '2026-10-01T01:30:00Z', 61.152444955],
  ['a04', '2026-10-01T01:30:30Z', 61.057879893],
  ['a05', '2026-10-01T01:31:00Z', 60.963329632],
  ['a06', '2026-10-01T01:31:30Z', 60.868794238],
];

/** The dusk star fix: true position, bodies, times and the errors added to each reading. */
export const DUSK_TRUTH = { lat_deg: 39.9526, lon_deg: -75.1652 };
export const DUSK_SIGHTS: [string, string, number][] = [
  ['Deneb', '2026-09-24T23:28:00Z', 0.3],
  ['Altair', '2026-09-24T23:30:00Z', -0.2],
  ['Antares', '2026-09-24T23:32:00Z', 0.4],
  ['Arcturus', '2026-09-24T23:34:00Z', -0.3],
  ['Kochab', '2026-09-24T23:36:00Z', 0.1],
];

export const EXAMPLES: readonly Example[] = [
  {
    id: 'dusk-stars',
    title: 'Five stars at dusk, Philadelphia',
    blurb: 'A star fix from five sextant readings in evening twilight, well spread round the horizon.',
    method: 'fix',
    build(nav) {
      if (!nav) throw new Error('this example needs the engine’s predicted readings (nav tools)');
      const eye = 2.5;
      const ic = -1.2;
      const observations = DUSK_SIGHTS.map(([body, utc, err], i) => {
        const p = nav.predictSextant({ ...DUSK_TRUTH, height_of_eye_m: eye }, { index_correction_arcmin: ic, horizon: 'sea' }, body, 'center', jdFromIso(utc)!);
        return obs(`obs-${i + 1}`, body, utc, p.hs_deg + err / 60, { notes: `simulated: the engine's predicted reading at the true position ${err >= 0 ? '+' : ''}${err}′` });
      });
      return {
        ...defaultWorking(),
        method: 'fix',
        session: session(
          'Five stars at dusk, Philadelphia (simulated)',
          `Simulated for this example: each reading is the SkyFix engine's predicted sextant reading at 39.9526 N, 75.1652 W (Philadelphia City Hall) plus a stated error (${DUSK_SIGHTS.map(([b, , e]) => `${b} ${e >= 0 ? '+' : ''}${e}′`).join(', ')}). The fix should land within about a mile of City Hall.`,
          {
            observer: { height_of_eye_m: eye, pressure_hpa: 1010, temperature_c: 10, assumed_position: { lat_deg: 40.0833, lon_deg: -75.4167 }, assumed_position_role: { role: 'initializer' } },
            instrument: { name: 'simulated sextant', index_correction_arcmin: ic, horizon: 'sea' },
            observations,
          },
        ),
      };
    },
  },
  {
    id: 'timor-moon-venus',
    title: 'Moon, Venus and planets, Timor Sea',
    blurb: 'A morning-twilight fix with the Moon’s upper limb, a crescent Venus, Mars, Jupiter, Canopus and Acrux.',
    method: 'fix',
    build() {
      const note = "synthetic, zero noise: a raw sextant reading built from Skyfield's sky";
      return {
        ...defaultWorking(),
        method: 'fix',
        session: session(
          'Moon, Venus and planets, Timor Sea (Skyfield)',
          'fixtures/sessions/reference-moon-venus-timor.json: raw sextant readings built by tools/reference/gen_moon_sights.py from Skyfield + JPL DE440s on the real (WGS84) Earth, zero noise; the Moon’s computed altitude includes the Earth’s-shape term (CONVENTIONS 15.4). The true position is 12° 12.0′ S, 128° 30.0′ E.',
          {
            observer: { height_of_eye_m: 4.5, pressure_hpa: 1010, temperature_c: 10, assumed_position: { lat_deg: -11.7, lon_deg: 129.3 }, assumed_position_role: { role: 'initializer' } },
            instrument: { name: 'synthetic sextant', index_correction_arcmin: 0.8, horizon: 'sea' },
            observations: [
              obs('obs-1', 'Canopus', '2026-11-26T19:52:00Z', 40.3507822213, { sigma_arcmin: 0.2, notes: note }),
              obs('obs-2', 'Acrux', '2026-11-26T19:54:00Z', 26.5501166563, { sigma_arcmin: 0.2, notes: note }),
              obs('obs-3', 'Moon', '2026-11-26T19:56:00Z', 36.4054861869, { sigma_arcmin: 0.2, limb: 'upper', notes: note }),
              obs('obs-4', 'Jupiter', '2026-11-26T19:58:00Z', 60.2913717139, { sigma_arcmin: 0.2, notes: note }),
              obs('obs-5', 'Mars', '2026-11-26T20:00:00Z', 58.294550725, { sigma_arcmin: 0.2, notes: note }),
              obs('obs-6', 'Venus', '2026-11-26T20:02:00Z', 21.8481500979, { sigma_arcmin: 0.2, notes: note }),
            ],
          },
        ),
      };
    },
  },
  {
    id: 'two-stars',
    title: 'Two stars: an ambiguous fix',
    blurb: 'Two circles cross twice. Nothing chooses between the crossings, so neither is promoted.',
    method: 'fix',
    build() {
      const note = 'Synthetic, zero noise: Skyfield apparent topocentric altitude at the truth position, already fully corrected.';
      return {
        ...defaultWorking(),
        method: 'fix',
        session: session('Two stars over Philadelphia (ambiguous)', 'fixtures/sessions/reference-philadelphia-2star.json: Altair and Vega, fully corrected altitudes with their own GHA and declination.', {
          observer: { height_of_eye_m: 0, pressure_hpa: 1010, temperature_c: 10, assumed_position: { lat_deg: 40.5, lon_deg: -74.5 }, assumed_position_role: { role: 'initializer' } },
          instrument: { name: 'synthetic (no instrument)', index_correction_arcmin: 0, horizon: 'sea' },
          observations: [
            obs('obs-1', 'Altair', '2026-10-01T01:30:00Z', 54.61864819, {
              altitude_kind: 'observed_ho',
              sigma_arcmin: 0.1,
              geocentric: { gha_deg: 94.281291299, dec_deg: 8.942168505, semidiameter_arcmin: 0, horizontal_parallax_arcmin: 0 },
              notes: note,
            }),
            obs('obs-2', 'Vega', '2026-10-01T01:30:00Z', 61.072237331, {
              altitude_kind: 'observed_ho',
              sigma_arcmin: 0.1,
              geocentric: { gha_deg: 112.844408001, dec_deg: 38.812937689, semidiameter_arcmin: 0, horizontal_parallax_arcmin: 0 },
              notes: note,
            }),
          ],
        }),
        mode: 'supplied',
      };
    },
  },
  {
    id: 'noon-run',
    title: 'Noon sight: 21 Sun sights at Philadelphia',
    blurb: 'A run of lower-limb Sun sights, every two minutes for twenty minutes either side of noon.',
    method: 'noon',
    build() {
      const w = defaultWorking();
      return {
        ...w,
        method: 'noon',
        noon: { ...w.noon, body: 'Sun', drSigmaNm: 10 },
        session: session('Noon run, Philadelphia, 23 September 2026', `${SKYFIELD} True position 39° 57.2′ N, 075° 09.9′ W; the DR is 12 NM off.`, {
          observer: NAV_METHODS_OBSERVER(39.779322089, -75.295321012),
          instrument: NAV_METHODS_INSTRUMENT,
          observations: NOON_RUN.map(([id, utc, hs]) => obs(id, 'Sun', utc, hs, { limb: 'lower' })),
        }),
      };
    },
  },
  {
    id: 'noon-bowditch',
    title: 'Noon sight: Bowditch §1910, one altitude',
    blurb: 'The American Practical Navigator’s worked example of latitude at local apparent noon.',
    method: 'noon',
    build() {
      const w = defaultWorking();
      return {
        ...w,
        method: 'noon',
        noon: { ...w.noon, body: 'Sun', single: 'maximum', vessel: { course_deg: 45, speed_kn: 10 } },
        session: session(
          'Bowditch §1910: latitude at local apparent noon',
          'The American Practical Navigator (Bowditch, NGA Pub. 9, 2019), section 1910: 9 March 2016, 12-08-04 zone time, DR 39° 49.0′ N 044° 33.0′ W, 10 knots on 045; Hs 45° 54.0′ (lower limb), IC +0.2′, height of eye 68 ft. The book’s answer is 39° 48.6′ N.',
          {
            observer: { height_of_eye_m: 20.7264, pressure_hpa: 1010, temperature_c: 10, assumed_position: { lat_deg: 39.816666667, lon_deg: -44.55 }, assumed_position_role: { role: 'initializer' } },
            instrument: { name: 'Bowditch §1910', index_correction_arcmin: 0.2, horizon: 'sea' },
            observations: [obs('lan', 'Sun', '2016-03-09T15:08:04Z', 45.9, { limb: 'lower', sigma_arcmin: 0.5 })],
          },
        ),
      };
    },
  },
  {
    id: 'polaris-bowditch',
    title: 'Polaris: Bowditch §1912',
    blurb: 'Latitude from one observed altitude of the Pole Star, with the Almanac’s a0, a1, a2.',
    method: 'polaris',
    build() {
      const w = defaultWorking();
      return {
        ...w,
        method: 'polaris',
        polaris: { ...w.polaris, drSigmaNm: 10 },
        session: session(
          'Bowditch §1912: latitude by Polaris',
          'The American Practical Navigator (Bowditch, NGA Pub. 9, 2019), section 1912: 22 March 2016, 23-18-56 UT, DR 40° 46.0′ N 043° 22.0′ W, Ho 40° 52.1′. The book’s answer is 40° 48.4′ N.',
          {
            observer: { height_of_eye_m: 0, pressure_hpa: 1010, temperature_c: 10, assumed_position: { lat_deg: 40.766666667, lon_deg: -43.366666667 }, assumed_position_role: { role: 'initializer' } },
            observations: [obs('p', 'Polaris', '2016-03-22T23:18:56Z', 40.868333333, { altitude_kind: 'observed_ho', sigma_arcmin: 0.2 })],
          },
        ),
      };
    },
  },
  {
    id: 'vega-run',
    title: 'Averaging: seven Vega sights in three minutes',
    blurb: 'Vega setting over Philadelphia, 11′ lower every minute: averaged into one sight.',
    method: 'average',
    build() {
      const w = defaultWorking();
      return {
        ...w,
        method: 'average',
        average: { ...w.average, body: 'Vega', drSigmaNm: 10 },
        session: session('Vega run, Philadelphia, 1 October 2026', `${SKYFIELD} The DR is 15 NM off.`, {
          observer: NAV_METHODS_OBSERVER(40.077256408, -74.882250386),
          instrument: NAV_METHODS_INSTRUMENT,
          observations: VEGA_RUN.map(([id, utc, hs]) => obs(id, 'Vega', utc, hs)),
        }),
      };
    },
  },
  {
    id: 'running-fix',
    title: 'Running fix: three stars over three hours at 12 knots',
    blurb: 'Schedar, Enif and Vega, an hour and a half apart, from a vessel making 12 knots on 045.',
    method: 'running',
    build() {
      const w = defaultWorking();
      return {
        ...w,
        method: 'running',
        running: {
          legs: [{ start_utc: '2026-10-01T00:00:00Z', course_deg: 45, speed_kn: 12 }],
          referenceUtc: '2026-10-01T03:00:00Z',
          endUtc: null,
          speedSigmaKn: 0.5,
          courseSigmaDeg: 2,
          walkNmPerSqrtHour: 0,
        },
        session: session('Running fix, 12 knots on 045', `${SKYFIELD} Course 045 held as a rhumb line for 36 NM; the true position at 03:00 UTC is 40° 25.5′ N, 069° 26.7′ W.`, {
          observer: NAV_METHODS_OBSERVER(40.2, -69.8),
          instrument: NAV_METHODS_INSTRUMENT,
          observations: [
            obs('r0', 'Schedar', '2026-10-01T00:00:00Z', 42.597590097),
            obs('r1', 'Enif', '2026-10-01T01:30:00Z', 59.682065757),
            obs('r2', 'Vega', '2026-10-01T03:00:00Z', 40.485993229),
          ],
        }),
      };
    },
  },
  {
    id: 'lunar-venus',
    title: 'Lunar distance: the Moon and Venus, 2029',
    blurb: 'Greenwich time from the Moon’s near limb to Venus, with the watch nearly ten minutes slow.',
    method: 'lunar',
    build() {
      const w = defaultWorking();
      return {
        ...w,
        method: 'lunar',
        lunar: {
          ...w.lunar,
          body: 'Venus',
          watchUtc: '2029-10-17T01:05:43Z',
          distanceDeg: 74.240349240822,
          moonLimb: 'near',
          bodyLimb: 'center',
          moonAltitude: { deg: 49.267191761662, kind: 'sextant_hs', limb: 'lower' },
          bodyAltitude: { deg: null, kind: 'sextant_hs', limb: 'center' },
          sigmaArcmin: 0.2,
          searchHours: 12,
          drSigmaNm: null,
        },
        session: session(
          'Lunar distance, Moon and Venus, 17 October 2029',
          'fixtures/reference/lunar_distances.json case lunar-19 (tools/reference/gen_moon_sights.py, Skyfield on the WGS84 Earth). The true Greenwich time is 01:15:25 UTC; the watch read 01:05:43.',
          {
            observer: { height_of_eye_m: 10, pressure_hpa: 1010, temperature_c: 10, assumed_position: { lat_deg: 23.144296238, lon_deg: -103.107861768 }, assumed_position_role: { role: 'initializer' } },
            instrument: { name: 'synthetic sextant', index_correction_arcmin: -1.5, horizon: 'sea' },
            observations: [],
          },
        ),
      };
    },
  },
];

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
