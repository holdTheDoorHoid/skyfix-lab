/**
 * A small demo set for the MOCK adapter only.
 *
 * The real six-plus packaged demonstrations live in `skyfix_sim::demos` and reach the
 * UI through the `demos()` export. These three exist so that the Observations and
 * Simulator views have something to load when there is no WebAssembly build, and they
 * are written in the real `Scenario` shape so the controls behave identically.
 */

import type { BodySource, Scenario } from './adapter.js';

const PHILADELPHIA = { lat_deg: 39.9526, lon_deg: -75.1652 };
const START = '2026-10-01T01:30:00Z';

/**
 * Five synthetic bodies placed so that, from Philadelphia at the start time, they sit
 * at the given altitude and azimuth. GHA and declination are computed from the inverse
 * geometry, the same trick `skyfix_sim::scenario::gha_dec_for` uses.
 */
function bodyAt(name: string, altitudeDeg: number, azimuthDeg: number): BodySource {
  const d = Math.PI / 180;
  const lat = PHILADELPHIA.lat_deg * d;
  const z = (90 - altitudeDeg) * d;
  const az = azimuthDeg * d;
  // Walk `z` along `az` from the observer to reach the body's geographic position.
  const sinDec = Math.sin(lat) * Math.cos(z) + Math.cos(lat) * Math.sin(z) * Math.cos(az);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const dLon = Math.atan2(
    Math.sin(az) * Math.sin(z) * Math.cos(lat),
    Math.cos(z) - Math.sin(lat) * sinDec,
  );
  const lonEast = PHILADELPHIA.lon_deg * d + dLon;
  const gha = ((((-lonEast / d) % 360) + 360) % 360);
  return {
    source: 'supplied',
    name,
    gha_deg_at_start: gha,
    dec_deg: dec / d,
    gha_rate_deg_per_hour: 15.04106864,
  };
}

function base(name: string, description: string, sources: BodySource[], count: number): Scenario {
  return {
    name,
    description,
    seed: 2026100101,
    truth: PHILADELPHIA,
    start_utc: START,
    sources,
    schedule: { count, spacing_s: 120, ordering: 'round_robin' },
    altitude_noise_arcmin: 0.8,
    shared_altitude_bias_arcmin: 0,
    clock_offset_s: 0,
    missing_fraction: 0,
    wrong_sight: null,
    geometry: { preset: 'as_given' },
    altitude_kind: { kind: 'observed_ho' },
    reported_sigma_arcmin: null,
    reported_clock_uncertainty_s: 0,
    assumed_position: {
      mode: { mode: 'offset_from_truth', distance_nm: 25, bearing_deg: 300 },
      role: { role: 'initializer' },
    },
    almanac_lookup: 'recorded_time',
    emit_supplied_directions: true,
  };
}

const SPREAD: BodySource[] = [
  bodyAt('mock-A', 61.2, 35),
  bodyAt('mock-B', 43.9, 125),
  bodyAt('mock-C', 28.4, 215),
  bodyAt('mock-D', 46.0, 305),
  bodyAt('mock-E', 35.2, 80),
  bodyAt('mock-F', 52.8, 160),
];

export const MOCK_DEMOS: Scenario[] = [
  base(
    'mock-spread',
    'MOCK DEMO. Five synthetic bodies right round the compass, independent noise only. ' +
      'The shape of a healthy fix, for checking that the interface renders one.',
    SPREAD.slice(0, 5),
    5,
  ),
  (() => {
    const s = base(
      'mock-clustered-bias',
      'MOCK DEMO. The same six bodies squeezed into one 60-degree sector, with 3 arcminutes ' +
        'added to every altitude. The residuals stay small and the position is wrong: that is ' +
        'what a shared bias looks like when the geometry cannot expose it.',
      SPREAD,
      6,
    );
    s.geometry = { preset: 'clustered', window_deg: 60 };
    s.shared_altitude_bias_arcmin = 3;
    s.altitude_noise_arcmin = 0.4;
    return s;
  })(),
  (() => {
    const s = base(
      'mock-two-body',
      'MOCK DEMO. Two bodies only. Two circles of position meet at two points and nothing ' +
        'in the session chooses between them.',
      SPREAD.slice(0, 2),
      2,
    );
    s.altitude_noise_arcmin = 0.5;
    return s;
  })(),
];
