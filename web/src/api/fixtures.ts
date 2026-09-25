/**
 * Hand-written fixtures in the exact contract shapes, typed against types.ts so a
 * drift in the Rust contract shows up as a TypeScript error here first.
 *
 * These are ILLUSTRATIVE NUMBERS for building and testing the interface. They are not
 * the output of the numerical core and must never be presented as a result.
 */

import type { FixResult, ReducedSight, Warning } from '../types.js';
import type { ReduceEntry } from './adapter.js';

/** A converged five-sight fix near Philadelphia, with a 95 % ellipse. */
export const UNIQUE_FIX: Extract<FixResult, { kind: 'unique' }> = {
  kind: 'unique',
  fix: {
    position: { lat_deg: 39.9531, lon_deg: -75.1644 },
    shared_bias_arcmin: null,
    covariance_ne_m2: [
      [186000, -42000],
      [-42000, 241000],
    ],
    sigma_north_m: 431.3,
    sigma_east_m: 491.0,
    clock_sigma_east_m: 0,
    ellipse95: {
      semi_major_m: 1257.1,
      semi_minor_m: 989.2,
      orientation_deg: 118.4,
      confidence: 0.95,
      model: 'nominal 95 %, independent-noise model',
    },
    ellipse_suppressed_reason: null,
    posterior_scaled: null,
    residuals: [
      {
        id: 'obs-1',
        body: 'Vega',
        hc_deg: 61.2312,
        zn_deg: 281.4,
        residual_arcmin: 0.82,
        normalized: 0.82,
        weight: 1,
        intercept_nm: 0.82,
      },
      {
        id: 'obs-2',
        body: 'Altair',
        hc_deg: 43.8871,
        zn_deg: 203.7,
        residual_arcmin: -1.14,
        normalized: -1.14,
        weight: 1,
        intercept_nm: -1.14,
      },
      {
        id: 'obs-3',
        body: 'Arcturus',
        hc_deg: 28.4409,
        zn_deg: 279.1,
        residual_arcmin: 0.37,
        normalized: 0.37,
        weight: 1,
        intercept_nm: 0.37,
      },
      {
        id: 'obs-4',
        body: 'Kochab',
        hc_deg: 46.0125,
        zn_deg: 341.2,
        residual_arcmin: -0.51,
        normalized: -0.51,
        weight: 1,
        intercept_nm: -0.51,
      },
      {
        id: 'obs-5',
        body: 'Deneb',
        hc_deg: 9.1044,
        zn_deg: 58.9,
        residual_arcmin: 1.36,
        normalized: 0.97,
        weight: 1,
        intercept_nm: 1.36,
      },
    ],
    chi2: 3.42,
    dof: 3,
    conditioning: {
      singular_values: [2.03, 1.41],
      condition_number: 1.44,
      rank: 2,
      geometric_dilution_m_per_arcmin: 2620,
      max_azimuth_gap_deg: 118,
      columns: 'position (north, east)',
    },
    iterations: 4,
    converged: true,
    prior: null,
    robust: null,
  },
  circles: [
    {
      id: 'obs-1',
      body: 'Vega',
      gp: { lat_deg: 38.789, lon_deg: -123.4567 },
      zenith_distance_deg: 28.7655,
    },
  ],
  alternatives: [
    {
      position: { lat_deg: 12.4411, lon_deg: -66.2087 },
      chi2: 4821.6,
      delta_chi2_from_best: 4818.18,
      converged: true,
      iterations: 7,
      shared_bias_arcmin: null,
    },
  ],
  warnings: [
    {
      code: 'low_altitude_refraction',
      id: 'obs-5',
      apparent_altitude_deg: 9.1,
      sigma_added_arcmin: 0,
    },
  ],
};

/** Two sights: two intersections, neither promoted. */
export const AMBIGUOUS_FIX: Extract<FixResult, { kind: 'ambiguous' }> = {
  kind: 'ambiguous',
  candidates: [
    {
      position: { lat_deg: 39.9526, lon_deg: -75.1652 },
      chi2: 0.41,
      delta_chi2_from_best: 0,
      converged: true,
      iterations: 3,
      shared_bias_arcmin: null,
    },
    {
      position: { lat_deg: 17.2044, lon_deg: -41.8813 },
      chi2: 0.44,
      delta_chi2_from_best: 0.03,
      converged: true,
      iterations: 3,
      shared_bias_arcmin: null,
    },
  ],
  circles: [
    {
      id: 'obs-1',
      body: 'Vega',
      gp: { lat_deg: 38.789, lon_deg: -123.4567 },
      zenith_distance_deg: 28.7655,
    },
    {
      id: 'obs-2',
      body: 'Altair',
      gp: { lat_deg: 8.8683, lon_deg: -30.114 },
      zenith_distance_deg: 46.1129,
    },
  ],
  warnings: [
    {
      code: 'ellipse_suppressed',
      reason: 'two minima lie within the 95 % chi-square margin, so no single ellipse applies',
    },
    { code: 'poor_geometry', condition_number: 41.2, max_azimuth_gap_deg: 214 },
  ],
};

/** One sight: a circle, never a point. */
export const UNDERDETERMINED_FIX: Extract<FixResult, { kind: 'underdetermined' }> = {
  kind: 'underdetermined',
  circles: [
    {
      id: 'obs-1',
      body: 'Vega',
      gp: { lat_deg: 38.789, lon_deg: -123.4567 },
      zenith_distance_deg: 28.7655,
    },
  ],
  reason: '1 usable sight: the Jacobian has rank 1, so position is constrained to a circle',
  warnings: [
    {
      code: 'ellipse_suppressed',
      reason: 'a single altitude constrains position to a circle, not to a point',
    },
  ],
};

/** Mutually inconsistent sights: no minimum is acceptable anywhere. */
export const FAILED_FIX: Extract<FixResult, { kind: 'failed' }> = {
  kind: 'failed',
  reason:
    'no minimum converged from 36 starting points; the best residual is 94 arcminutes, far outside the stated sight uncertainties',
  warnings: [
    { code: 'not_converged', iterations: 50 },
    { code: 'duplicate_observation', ids: ['obs-2', 'obs-3'] },
  ],
};

/**
 * One fully reduced star sight showing all six correction steps, three of them skipped
 * with the reason recorded rather than silently dropped.
 */
export const SAMPLE_REDUCED_SIGHT: ReducedSight = {
  id: 'obs-1',
  body: 'Vega',
  utc: '2026-10-01T01:30:00Z',
  jd_utc: 2461314.5625,
  gha_deg: 123.4567,
  dec_deg: 38.789,
  direction_source: 'supplied',
  ho_deg: 61.2049,
  sigma_arcmin: 1.0,
  corrections: {
    input_kind: 'sextant_hs',
    input_deg: 61.2345,
    steps: [
      {
        kind: 'index_correction',
        applied: true,
        before_deg: 61.2345,
        after_deg: 61.2012,
        delta_arcmin: -2.0,
        note: 'index correction −2.0′ added (2.0′ on the arc)',
      },
      {
        kind: 'dip',
        applied: true,
        before_deg: 61.2012,
        after_deg: 61.1597,
        delta_arcmin: -2.49,
        note: 'dip for 2.0 m height of eye, natural sea horizon',
      },
      {
        kind: 'artificial_horizon_halving',
        applied: false,
        before_deg: 61.1597,
        after_deg: 61.1597,
        delta_arcmin: 0,
        note: 'not applied: horizon mode is the natural sea horizon, so the reading is not a double angle',
      },
      {
        kind: 'refraction',
        applied: true,
        before_deg: 61.1597,
        after_deg: 61.2049,
        delta_arcmin: -0.55,
        note: 'Bennett 1982 at 1010 hPa, 10 °C',
      },
      {
        kind: 'semidiameter',
        applied: false,
        before_deg: 61.2049,
        after_deg: 61.2049,
        delta_arcmin: 0,
        note: 'not applied: a star has no measurable disc',
      },
      {
        kind: 'parallax',
        applied: false,
        before_deg: 61.2049,
        after_deg: 61.2049,
        delta_arcmin: 0,
        note: 'not applied: stellar parallax in altitude is zero at this precision',
      },
    ],
    ho_deg: 61.2049,
    sigma_ho_arcmin: 1.0,
    warnings: [{ code: 'limb_ignored_for_star', id: 'obs-1' }],
  },
  hc_deg: 61.2312,
  zn_deg: 281.4,
  intercept_nm: -1.58,
  warnings: [{ code: 'supplied_direction_used', id: 'obs-1' }],
  horizontal_parallax_arcmin: 0,
  earth_shape_arcmin: null,
};

export const SAMPLE_REDUCE_ENTRIES: ReduceEntry[] = [
  { status: 'ok', sight: SAMPLE_REDUCED_SIGHT },
  {
    status: 'error',
    id: 'obs-6',
    message:
      'observation obs-6: rejected: apparent altitude −0.8° is below the refraction model validity range (Ha ≥ 0°)',
  },
];

/** One of every warning code, for the About view and the mapping tests. */
export const ALL_WARNING_EXAMPLES: Warning[] = [
  { code: 'low_altitude_refraction', id: 'obs-5', apparent_altitude_deg: 4.2, sigma_added_arcmin: 1 },
  { code: 'dip_not_applicable', id: 'obs-2', horizon: 'artificial_reflected' },
  { code: 'already_corrected', id: 'obs-3', kind: 'observed_ho', ignored: ['refraction', 'dip'] },
  { code: 'limb_ignored_for_star', id: 'obs-1' },
  { code: 'supplied_direction_used', id: 'obs-1' },
  {
    code: 'ephemeris_coverage_limited',
    provider: 'fixture-pack',
    coverage: '2026-09-01 to 2026-12-31',
  },
  { code: 'poor_geometry', condition_number: 41.2, max_azimuth_gap_deg: 214 },
  { code: 'clock_degenerate_with_longitude', sigma_east_m: 1390 },
  { code: 'prior_used', sigma_nm: 20, shift_m: 640 },
  { code: 'robust_weights_applied', downweighted_ids: ['obs-3'] },
  { code: 'ellipse_suppressed', reason: 'the result is ambiguous' },
  { code: 'posterior_scaling_skipped', dof: 1 },
  { code: 'duplicate_observation', ids: ['obs-2', 'obs-3'] },
  { code: 'not_converged', iterations: 50 },
  { code: 'other', message: 'This session was produced by the simulator, not by an instrument.' },
  {
    code: 'flat_peak_longitude',
    body: 'Sun',
    sigma_time_s: 21,
    sigma_lon_arcmin: 5.3,
    sigma_east_nm: 4.1,
  },
  { code: 'meridian_near_zenith', body: 'Sun', meridian_altitude_deg: 87.9 },
  { code: 'meridian_side_ambiguous', body: 'Sun', latitude_deg: 18.5, other_latitude_deg: 21.5 },
  { code: 'not_at_meridian_passage', id: 'obs-1', minutes_from_passage: 24 },
  { code: 'one_sided_run', body: 'Sun', before: 5, after: 0 },
  {
    code: 'curvature_inconsistent',
    body: 'Sun',
    predicted_arcmin_per_min2: 0.036,
    fitted_arcmin_per_min2: 0.052,
    z: 4.2,
  },
  {
    code: 'slope_inconsistent',
    body: 'Vega',
    predicted_arcmin_per_min: -10.1,
    fitted_arcmin_per_min: -9.2,
    z: 3.6,
  },
  { code: 'run_outlier', id: 'obs-3', normalized_residual: 5.4, rejected: true },
  { code: 'polaris_near_pole', id: 'obs-1', latitude_deg: 88.9, azimuth_deg: 342 },
  { code: 'shore_beyond_sea_horizon', id: 'obs-4', distance_nm: 6, sea_horizon_nm: 3.66 },
  { code: 'error_log_outside_span', id: 'obs-6', log: 'watch_log', held_value: -2, hours_outside: 36 },
];
