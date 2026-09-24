/**
 * The Learn view's logic, without a browser or an engine: the story catalogue, the numbers
 * taken from a result, the rules for what the chart may draw, the truth guard, the
 * experiment verdict, the projections and the map overlays. The real engine's numbers are
 * checked against docs/DEMOS.md in learn-wasm.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { DemoEntry, ExperimentSummary, Scenario, SimulationOutput } from '../../src/api/adapter.js';
import { CHI2_95_2DOF, defaultSolveOptions, type Fix, type FixResult, type LatLon, type Session, type SolveOptions } from '../../src/types.js';
import { chartModel, globeCenter, sheetFrame, MIN_HALF_SPAN_M, PALETTE_SIZE } from '../../src/next/learn/chart-model.js';
import { explain, keyNumber } from '../../src/next/learn/explain.js';
import { arcmin, factsOf, makeFmt, metric, nautical, signedDeg, statute } from '../../src/next/learn/facts.js';
import {
  applyOffsetM,
  bearingDeg,
  circleArcNear,
  distanceM,
  ellipseRing,
  mahalanobis,
  MAHALANOBIS_95,
  meanDirection,
  nearestOnCircle,
  tangentOffsetM,
} from '../../src/next/learn/geo.js';
import { overlaysFor } from '../../src/next/learn/mapbridge.js';
import { Ortho, SheetProjection, visibleRuns } from '../../src/next/learn/project.js';
import {
  CLOCK_SIGMA_S,
  experimentFor,
  guardAgainstTruth,
  runStory,
  simulateAndSolve,
  solveOptionsFor,
  truthGuardRadiusNm,
  TruthLeakError,
  VARIANT_STORY,
  VARIANTS,
  type LearnApi,
} from '../../src/next/learn/run.js';
import { GROUPS, sentenceCount, STORIES, STORY_IDS } from '../../src/next/learn/stories.js';
import { COVERAGE_BAND, RATIO_BAND, clockLongitudeShiftDeg, dedupeNotes, experimentVerdict } from '../../src/next/learn/verdict.js';

const PHILLY: LatLon = { lat_deg: 39.9526, lon_deg: -75.1652 };
const fmt = makeFmt('metric', 'dm');

// ---------------------------------------------------------------------------------------
// Fixtures

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    name: 'test',
    description: '',
    seed: 7,
    truth: { ...PHILLY },
    start_utc: '2026-10-01T01:30:00Z',
    sources: [
      { source: 'supplied', name: 'sim-A', gha_deg_at_start: 10, dec_deg: 20, gha_rate_deg_per_hour: 15.04106864 },
      { source: 'supplied', name: 'sim-B', gha_deg_at_start: 50, dec_deg: 10, gha_rate_deg_per_hour: 15.04106864 },
    ],
    schedule: { count: 2, spacing_s: 0, ordering: 'round_robin' },
    altitude_noise_arcmin: 0,
    shared_altitude_bias_arcmin: 0,
    clock_offset_s: 0,
    missing_fraction: 0,
    wrong_sight: null,
    geometry: { preset: 'as_given' },
    altitude_kind: { kind: 'observed_ho' },
    reported_sigma_arcmin: 1,
    reported_clock_uncertainty_s: 0,
    assumed_position: { mode: { mode: 'offset_from_truth', distance_nm: 25, bearing_deg: 300 }, role: { role: 'initializer' } },
    almanac_lookup: 'recorded_time',
    emit_supplied_directions: true,
    ...overrides,
  };
}

function session(assumed: LatLon | null, role: Session['observer']['assumed_position_role'] = { role: 'initializer' }): Session {
  return {
    schema: 'skyfix.session/1',
    meta: { name: 'test', notes: '', kind: 'simulated' },
    observer: { height_of_eye_m: 2, pressure_hpa: 1010, temperature_c: 10, assumed_position: assumed, assumed_position_role: role },
    instrument: { name: 'simulated', index_correction_arcmin: 0, horizon: 'sea' },
    clock: { uncertainty_s: 12, correction_s: 0 },
    observations: [],
  };
}

function fix(position: LatLon, overrides: Partial<Fix> = {}): Fix {
  return {
    position,
    shared_bias_arcmin: null,
    covariance_ne_m2: [
      [1000 ** 2, 0],
      [0, 1000 ** 2],
    ],
    sigma_north_m: 1000,
    sigma_east_m: 1000,
    clock_sigma_east_m: 0,
    ellipse95: {
      semi_major_m: 1000 * Math.sqrt(CHI2_95_2DOF),
      semi_minor_m: 1000 * Math.sqrt(CHI2_95_2DOF),
      orientation_deg: 0,
      confidence: 0.95,
      model: 'nominal 95 %, independent-noise model',
    },
    ellipse_suppressed_reason: null,
    posterior_scaled: null,
    residuals: [
      { id: 'obs-1', body: 'sim-A', hc_deg: 40, zn_deg: 30, residual_arcmin: 0.5, normalized: 0.5, weight: 1, intercept_nm: 0.5 },
      { id: 'obs-2', body: 'sim-B', hc_deg: 50, zn_deg: 150, residual_arcmin: -9, normalized: -9, weight: 1, intercept_nm: -9 },
      { id: 'obs-3', body: 'sim-A', hc_deg: 41, zn_deg: 32, residual_arcmin: 1.2, normalized: 1.2, weight: 1, intercept_nm: 1.2 },
    ],
    chi2: 82,
    dof: 1,
    conditioning: { singular_values: [1, 1], condition_number: 1.2, rank: 2, geometric_dilution_m_per_arcmin: 2000, max_azimuth_gap_deg: 180, columns: 'position (north, east)' },
    iterations: 4,
    converged: true,
    prior: null,
    robust: null,
    ...overrides,
  };
}

const CIRCLES = [
  { id: 'obs-1', body: 'sim-A', gp: { lat_deg: 60, lon_deg: -40 }, zenith_distance_deg: 30 },
  { id: 'obs-2', body: 'sim-B', gp: { lat_deg: 10, lon_deg: -80 }, zenith_distance_deg: 30 },
  { id: 'obs-3', body: 'sim-A', gp: { lat_deg: 60.1, lon_deg: -41 }, zenith_distance_deg: 29.9 },
];

function unique(position: LatLon, overrides: Partial<Fix> = {}): FixResult {
  return { kind: 'unique', fix: fix(position, overrides), alternatives: [], circles: CIRCLES, warnings: [] };
}

const AMBIGUOUS: FixResult = {
  kind: 'ambiguous',
  candidates: [
    { position: { lat_deg: 6.248595, lon_deg: 7.324286 }, chi2: 0, delta_chi2_from_best: 0, converged: true, iterations: 3, shared_bias_arcmin: null },
    { position: { lat_deg: 39.9526, lon_deg: -75.1652 }, chi2: 1e-25, delta_chi2_from_best: 1e-25, converged: true, iterations: 3, shared_bias_arcmin: null },
  ],
  circles: CIRCLES.slice(0, 2),
  warnings: [],
};

const GP = { lat_deg: 56.86229693433748, lon_deg: -9.008157904954384 };
const UNDERDETERMINED: FixResult = {
  kind: 'underdetermined',
  circles: [{ id: 'obs-1', body: 'sim-Alpha', gp: GP, zenith_distance_deg: 45 }],
  reason: '1 usable sight(s): one altitude constrains the observer to a circle of position, not to a point',
  warnings: [],
};

// ---------------------------------------------------------------------------------------

describe('the story catalogue', () => {
  it('tells all ten packaged demonstrations, in the order the core lists them', () => {
    expect(STORIES.map((s) => s.id)).toEqual([...STORY_IDS]);
    expect(STORY_IDS).toHaveLength(10);
    expect(new Set(STORY_IDS).size).toBe(10);
  });

  it('gives every story a title, exactly two sentences on what it shows, what to look at and what to try next', () => {
    for (const s of STORIES) {
      expect(s.title.length, s.id).toBeGreaterThan(3);
      expect(sentenceCount(s.summary), `${s.id}: ${s.summary}`).toBe(2);
      expect(s.lookAt.length, s.id).toBeGreaterThan(20);
      expect(s.next.text.length, s.id).toBeGreaterThan(20);
      expect(s.next.actions.length, s.id).toBeGreaterThan(0);
    }
  });

  it('covers each of the brief’s six demonstrations', () => {
    expect(GROUPS.map((g) => g.n)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const g of GROUPS) expect(STORIES.filter((s) => s.group === g.n).length, g.title).toBeGreaterThan(0);
  });

  it('offers each variant only on its own story, and links only to other stories', () => {
    for (const s of STORIES) {
      for (const a of s.next.actions) {
        if (a.kind === 'variant') expect(VARIANT_STORY[a.variant]).toBe(s.id);
        if (a.kind === 'story') {
          expect(STORY_IDS).toContain(a.story);
          expect(a.story).not.toBe(s.id);
        }
      }
    }
  });

  it('counts sentences the way the rule means', () => {
    expect(sentenceCount('One. Two.')).toBe(2);
    expect(sentenceCount('A circle about 2,700 NM across, centred there. It cannot say where.')).toBe(2);
    expect(sentenceCount('Only one sentence here.')).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------

describe('spherical helpers', () => {
  it('measure one arcminute of latitude as exactly one nautical mile', () => {
    expect(distanceM({ lat_deg: 0, lon_deg: 10 }, { lat_deg: 1 / 60, lon_deg: 10 })).toBeCloseTo(1852, 6);
  });

  it('split an offset into north and east with the right signs', () => {
    const north = tangentOffsetM(PHILLY, { lat_deg: PHILLY.lat_deg + 0.01, lon_deg: PHILLY.lon_deg });
    expect(north.north).toBeCloseTo(0.6 * 1852, 3);
    expect(Math.abs(north.east)).toBeLessThan(1e-6);
    const west = tangentOffsetM(PHILLY, { lat_deg: PHILLY.lat_deg, lon_deg: PHILLY.lon_deg - 0.25 });
    expect(west.east).toBeLessThan(0);
    const back = applyOffsetM(PHILLY, north.north, north.east);
    expect(back.lat_deg).toBeCloseTo(PHILLY.lat_deg + 0.01, 9);
  });

  it('score a point against a covariance exactly as the experiment runner does', () => {
    // docs/SIMULATOR.md section 6; skyfix_sim::experiment::mahalanobis tests.
    const edge = MAHALANOBIS_95 * 10;
    expect(mahalanobis([[100, 0], [0, 100]], edge, 0)!).toBeCloseTo(MAHALANOBIS_95, 12);
    expect(mahalanobis([[900, 0], [0, 4]], 30, 0)!).toBeCloseTo(1, 12);
    expect(mahalanobis([[900, 0], [0, 4]], 0, 6)!).toBeCloseTo(3, 12);
    const along = mahalanobis([[100, 90], [90, 100]], 10, 10)!;
    const across = mahalanobis([[100, 90], [90, 100]], 10, -10)!;
    expect(across).toBeGreaterThan(along * 4);
    expect(mahalanobis([[0, 0], [0, 0]], 1, 1)).toBeNull();
    expect(mahalanobis([[1, 2], [2, 1]], 1, 1)).toBeNull();
  });

  it('put the ellipse’s major axis on its stated bearing', () => {
    const e = { semi_major_m: 5000, semi_minor_m: 1000, orientation_deg: 124.4, confidence: 0.95, model: '' };
    const ring = ellipseRing(PHILLY, e, 8);
    expect(distanceM(PHILLY, ring[0]!)).toBeCloseTo(5000, 3);
    expect(bearingDeg(PHILLY, ring[0]!)).toBeCloseTo(124.4, 3);
    expect(distanceM(PHILLY, ring[2]!)).toBeCloseTo(1000, 3);
  });

  it('draw a piece of a circle of position that stays on the circle, centred nearest the point asked for', () => {
    const gp = { lat_deg: 50, lon_deg: -30 };
    const arcPts = circleArcNear(gp, 45, PHILLY, 20_000, 20);
    for (const p of arcPts) expect(distanceM(gp, p)).toBeCloseTo((45 * Math.PI * 6366707.0194937075) / 180, 3);
    const mid = arcPts[10]!;
    const nearest = nearestOnCircle(gp, 45, PHILLY);
    expect(distanceM(mid, nearest)).toBeLessThan(1e-3);
  });

  it('find the middle direction of some points', () => {
    const m = meanDirection([{ lat_deg: 0, lon_deg: -10 }, { lat_deg: 0, lon_deg: 10 }])!;
    expect(m.lat_deg).toBeCloseTo(0, 12);
    expect(m.lon_deg).toBeCloseTo(0, 12);
    expect(meanDirection([{ lat_deg: 0, lon_deg: 0 }, { lat_deg: 0, lon_deg: 180 }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------

describe('numbers taken from a result', () => {
  it('compare a unique fix with the answer key', () => {
    const at = { lat_deg: PHILLY.lat_deg + 0.01, lon_deg: PHILLY.lon_deg };
    const f = factsOf(unique(at), PHILLY);
    if (f.kind !== 'unique') throw new Error('expected unique');
    expect(f.errorM).toBeCloseTo(1111.2, 3);
    expect(f.errorNorthM).toBeCloseTo(1111.2, 3);
    expect(f.sigmaRadialM).toBeCloseTo(Math.SQRT2 * 1000, 9);
    expect(f.mahalanobis!).toBeCloseTo(1.1112, 3);
    expect(f.inside95).toBe(true);
    expect(f.ratio!).toBeCloseTo(1111.2 / (Math.SQRT2 * 1000), 6);
    expect(f.worst?.id).toBe('obs-2');
    expect(f.maxResidualArcmin).toBe(9);
  });

  it('say nothing about inside or outside when the ellipse was suppressed', () => {
    const f = factsOf(unique(PHILLY, { ellipse95: null, ellipse_suppressed_reason: 'the geometry is singular' }), PHILLY);
    if (f.kind !== 'unique') throw new Error('expected unique');
    expect(f.inside95).toBeNull();
    expect(f.ellipse).toBeNull();
    expect(f.ellipseSuppressedReason).toBe('the geometry is singular');
  });

  it('measure how far apart ambiguous candidates are and which one the answer key is', () => {
    const f = factsOf(AMBIGUOUS, PHILLY);
    if (f.kind !== 'ambiguous') throw new Error('expected ambiguous');
    expect(f.separationM / 1000).toBeCloseTo(8916.4, 0);
    expect(f.nearestIndex).toBe(1);
    expect(f.nearestM).toBeLessThan(1);
  });

  it('give an underdetermined result a circle, its radius, and the answer key on it', () => {
    const f = factsOf(UNDERDETERMINED, PHILLY);
    if (f.kind !== 'underdetermined') throw new Error('expected underdetermined');
    expect(f.radiusNm).toBe(2700);
    expect(f.truthOffCircleM).toBeLessThan(5);
  });

  it('write distances the way the stories quote them', () => {
    expect(metric(795.7)).toBe('796 m');
    expect(metric(7072.3)).toBe('7.07 km');
    expect(metric(21353.8)).toBe('21.35 km');
    expect(metric(8916433)).toBe('8,916 km');
    expect(nautical(21353.8)).toBe('11.53 NM');
    expect(statute(1609.344)).toBe('1.00 mi');
    expect(makeFmt('nautical').dist(1852)).toBe('1.00 NM');
    expect(makeFmt('metric').distBoth(1852)).toBe('1.85 km (1.00 NM)');
    expect(signedDeg(-0.250684477)).toBe('−0.2507°');
    expect(signedDeg(0.0000001, 6)).toBe('0.000000°');
    expect(arcmin(4.97)).toBe('+4.97′');
    expect(arcmin(-0.001)).toBe('0.00′');
  });
});

// ---------------------------------------------------------------------------------------

describe('what the chart may draw', () => {
  it('draws a unique fix with its ellipse, one colour per body, the first line of each labelled', () => {
    const m = chartModel(unique(PHILLY), PHILLY)!;
    expect(m.view).toBe('sheet');
    expect(m.canSheet).toBe(true);
    expect(m.fix).toEqual(PHILLY);
    expect(m.ellipse).not.toBeNull();
    expect(m.circles.map((c) => c.color)).toEqual([0, 1, 0]);
    expect(m.circles.map((c) => c.labelled)).toEqual([true, true, false]);
    expect(m.bodies.map((b) => b.body)).toEqual(['sim-A', 'sim-B']);
  });

  it('never draws a suppressed ellipse, and says why', () => {
    const m = chartModel(unique(PHILLY, { ellipse95: null, ellipse_suppressed_reason: 'the fix did not converge' }), PHILLY)!;
    expect(m.ellipse).toBeNull();
    expect(m.suppressedReason).toBe('the fix did not converge');
    const overlays = overlaysFor(m, 'x');
    expect(overlays.has('learn-ellipse')).toBe(false);
  });

  it('draws every ambiguous candidate alike, with no fix and no ellipse', () => {
    const m = chartModel(AMBIGUOUS, PHILLY)!;
    expect(m.candidates).toHaveLength(2);
    expect(m.fix).toBeNull();
    expect(m.ellipse).toBeNull();
    expect(m.view).toBe('globe');
    expect(m.canSheet).toBe(false);
    const points = overlaysFor(m, 'x').get('learn-points')!;
    expect(points.features.map((f) => (f.properties as { label: string }).label)).toEqual(['Candidate A', 'Candidate B']);
  });

  it('draws one sight as a circle and no point', () => {
    const m = chartModel(UNDERDETERMINED, PHILLY)!;
    expect(m.circles).toHaveLength(1);
    expect(m.fix).toBeNull();
    expect(m.candidates).toEqual([]);
    expect(m.ellipse).toBeNull();
    expect(globeCenter(m)).toEqual(GP);
    const overlays = overlaysFor(m, 'x');
    expect(overlays.has('learn-points')).toBe(false);
    expect(overlays.has('learn-lines-0')).toBe(true);
    expect((overlays.get('learn-truth')!.features[0]!.properties as { label: string }).label).toMatch(/answer key \(simulated\)/);
  });

  it('draws nothing for a failed solve', () => {
    expect(chartModel({ kind: 'failed', reason: 'no convergence', warnings: [] }, PHILLY)).toBeNull();
  });

  it('frames a close-up round the fix, the answer key and the ellipse, never smaller than its minimum', () => {
    const m = chartModel(unique({ lat_deg: PHILLY.lat_deg, lon_deg: PHILLY.lon_deg - 0.25 }), PHILLY)!;
    const f = sheetFrame(m)!;
    const truth = tangentOffsetM(m.fix!, PHILLY);
    expect(truth.east).toBeGreaterThan(f.minE);
    expect(truth.east).toBeLessThan(f.maxE);
    expect(f.maxN - f.minN).toBeGreaterThanOrEqual(2 * MIN_HALF_SPAN_M);
    expect(PALETTE_SIZE).toBe(6);
  });
});

// ---------------------------------------------------------------------------------------

describe('the truth stays the answer key', () => {
  it('builds solve options from the session alone, never with an initializer or a prior', () => {
    const o = solveOptionsFor(session({ lat_deg: 40.2, lon_deg: -75.6 }));
    expect(o.initializer).toBeNull();
    expect(o.prior).toBeNull();
    expect(o.clock_uncertainty_s).toBe(12);
    for (const v of Object.keys(VARIANTS) as (keyof typeof VARIANTS)[]) {
      const ov = solveOptionsFor(session(null), v);
      expect(ov.initializer, v).toBeNull();
      expect(ov.prior, v).toBeNull();
    }
    expect(solveOptionsFor(session(null), 'robust').robust).toEqual({ huber_k: 1.5, max_reweight_iterations: 10 });
    expect(solveOptionsFor(session(null), 'clock-sigma').clock_uncertainty_s).toBe(CLOCK_SIGMA_S);
    expect(solveOptionsFor(session(null), 'estimate-bias').estimate_shared_bias).toBe(true);
  });

  it('refuses to start the solver at, or pull it towards, the answer', () => {
    const near = { lat_deg: PHILLY.lat_deg + 0.5 / 60, lon_deg: PHILLY.lon_deg };
    const far = { lat_deg: PHILLY.lat_deg + 25 / 60, lon_deg: PHILLY.lon_deg };
    const options: SolveOptions = defaultSolveOptions();
    expect(() => guardAgainstTruth(session(near), options, PHILLY)).toThrow(TruthLeakError);
    expect(() => guardAgainstTruth(session(far), options, PHILLY)).not.toThrow();
    expect(() => guardAgainstTruth(session(null), { ...options, initializer: PHILLY }, PHILLY)).toThrow(/starting point/);
    expect(() => guardAgainstTruth(session(far, { role: 'prior', sigma_nm: 20 }), options, PHILLY)).toThrow(/prior/);
    expect(() => guardAgainstTruth(session(far, { role: 'disabled' }), options, PHILLY)).not.toThrow();
    expect(truthGuardRadiusNm(null)).toBe(1);
    expect(truthGuardRadiusNm(20)).toBe(60);
    expect(truthGuardRadiusNm(0.1)).toBe(1);
  });

  it('passes the session, and only the session, to the solver', async () => {
    const truth = { schema: 'skyfix.truth/1', session_name: 'test', position: PHILLY, seed: 2026100401, clock_offset_s: 60, shared_altitude_bias_arcmin: 0, wrong_sight_ids: [], notes: '' };
    const sess = session({ lat_deg: 40.16, lon_deg: -75.62 });
    const calls: unknown[][] = [];
    const api: LearnApi = {
      kind: 'wasm',
      description: 'fake',
      demos: async () => [],
      simulate: async (): Promise<SimulationOutput> => ({ session: sess, truth }),
      solve: async (...args) => {
        calls.push(args);
        return unique({ lat_deg: 39.9526, lon_deg: -75.415884 });
      },
      reduce: async () => [],
      experiment: async () => {
        throw new Error('not used');
      },
    };
    const run = await simulateAndSolve(api, { scenario: scenario() });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(sess);
    const sent = JSON.stringify(calls[0]);
    expect(sent).not.toContain('39.9526');
    expect(sent).not.toContain('75.1652');
    expect(sent).not.toContain('2026100401');
    expect(run.truth).toBe(truth);
    expect(run.session).toBe(sess);
    expect(run.reduced).toBeNull();
  });

  it('says plainly when the mock adapter cannot run a packaged story', async () => {
    const api = { kind: 'mock', description: 'mock', demos: async () => [] } as unknown as LearnApi;
    await expect(runStory(api, [], 'clock-offset')).rejects.toThrow(/needs the real numerical core/);
  });

  it('adds the third star from the Philadelphia demo, at the same moment', () => {
    const donor = scenario({ name: 'philadelphia-stars', sources: [{ source: 'supplied', name: 'sim-Delta', gha_deg_at_start: 1, dec_deg: 2, gha_rate_deg_per_hour: 15 }] });
    const demos: DemoEntry[] = [{ name: 'philadelphia-stars', description: '', requires_provider: false, scenario: donor }];
    const out = VARIANTS['third-star'].scenario!(scenario(), demos);
    expect(out.sources.map((s) => s.name)).toEqual(['sim-A', 'sim-B', 'sim-Delta']);
    expect(out.schedule.count).toBe(3);
    expect(() => VARIANTS['third-star'].scenario!(scenario(), [])).toThrow(/third star/);
  });

  it('runs experiments with the declared clock doubt and no starting point or prior', () => {
    const e = experimentFor(scenario({ reported_clock_uncertainty_s: 60 }), 50, { robust: true, estimateBias: false });
    expect(e.repetitions).toBe(50);
    expect(e.solve_options.clock_uncertainty_s).toBe(60);
    expect(e.solve_options.initializer).toBeNull();
    expect(e.solve_options.prior).toBeNull();
    expect(e.solve_options.robust).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------

describe('key numbers and explanations', () => {
  const run = (overrides: Partial<Scenario> = {}, truth: Partial<{ clock_offset_s: number; shared_altitude_bias_arcmin: number; wrong_sight_ids: string[] }> = {}) => ({
    variant: null,
    scenario: scenario(overrides),
    options: defaultSolveOptions(),
    reduced: null,
    truth: { schema: '', session_name: '', position: PHILLY, seed: 1, clock_offset_s: 0, shared_altitude_bias_arcmin: 0, wrong_sight_ids: [], notes: '', ...truth },
  });

  it('quote the shared-bias story the way the brief asks', () => {
    const at = applyOffsetM(PHILLY, -846.45, 6964.31);
    const result = unique(at, { sigma_north_m: 177.5, sigma_east_m: 147.7, covariance_ne_m2: [[177.5 ** 2, 0], [0, 147.7 ** 2]] });
    const facts = factsOf(result, PHILLY);
    const key = keyNumber('shared-bias', run(), facts, fmt);
    expect(key.value).toBe('7.02 km');
    expect(key.caption).toBe('from the truth, while the fix claims 231 m (1 σ)');
    const text = explain('shared-bias', run({}, { shared_altitude_bias_arcmin: 3 }), facts, fmt).happened.join(' ');
    expect(text).toContain('is 7.02 km from the truth but claims 231 m (1 σ), because every sight shares the same bias — the model assumes independent errors');
    expect(text).toContain('far outside');
  });

  it('give the clock story its east-west shift in degrees of longitude', () => {
    const at = { lat_deg: PHILLY.lat_deg, lon_deg: PHILLY.lon_deg - 0.250684477 };
    const facts = factsOf(unique(at), PHILLY);
    const key = keyNumber('clock-offset', run(), facts, fmt);
    expect(key.value).toBe('−0.2507°');
    expect(key.caption).toContain('21.35 km west');
    const why = explain('clock-offset', run({}, { clock_offset_s: 60 }), facts, fmt).why.join(' ');
    expect(why).toContain('60 seconds fast');
    expect(why).toContain('0.2507°');
  });

  it('never claim a position for one sight, nor a preference between two', () => {
    const one = keyNumber('single-sight', run(), factsOf(UNDERDETERMINED, PHILLY), fmt);
    expect(one.value).toBe('2,700 NM');
    expect(one.caption).toContain('a circle, not a point');
    const two = keyNumber('two-sight-ambiguous', run(), factsOf(AMBIGUOUS, PHILLY), fmt);
    expect(two.value).toBe('8,916 km');
    expect(two.caption).toContain('neither is preferred');
    const words = explain('two-sight-ambiguous', run(), factsOf(AMBIGUOUS, PHILLY), fmt).happened.join(' ');
    expect(words).toContain('neither preferred');
    expect(words).toContain('the sights alone cannot say that');
  });

  it('report a failure as a failure', () => {
    const facts = factsOf({ kind: 'failed', reason: 'no convergence anywhere', warnings: [] }, PHILLY);
    expect(keyNumber(null, run(), facts, fmt).value).toBe('No answer');
    expect(explain(null, run(), facts, fmt).happened[0]).toContain('no convergence anywhere');
  });
});

// ---------------------------------------------------------------------------------------

describe('the experiment verdict (the command line’s own rule)', () => {
  const aggregate = (coverage: number | null, ratio: number | null, evaluated = 50) => ({
    repetitions: 50,
    evaluated,
    result_kind_counts: [] as [string, number][],
    coverage_fraction: coverage,
    coverage_stderr: null,
    coverage_ci95: null,
    mean_error_m: null,
    rms_error_m: null,
    mean_error_north_m: null,
    mean_error_east_m: null,
    mean_predicted_sigma_m: null,
    rms_predicted_sigma_m: null,
    error_to_sigma_ratio: ratio,
    mean_residual_rms_arcmin: null,
  });

  it('is two-sided on the error-to-sigma ratio', () => {
    const clean = scenario();
    for (const r of [0.6, 0.93, 1, 1.05, 1.6]) expect(experimentVerdict(aggregate(0.96, r), clean).tone, String(r)).toBe('healthy');
    const big = experimentVerdict(aggregate(1, 0.1), clean);
    expect(big.tone).toBe('disagrees');
    expect(big.text).toContain('too large relative to the observed error');
    const small = experimentVerdict(aggregate(0.4, 7.57), clean);
    expect(small.text).toContain('too small relative to the observed error');
    const coverageOnly = experimentVerdict(aggregate(0.5, 1), clean);
    expect(coverageOnly.tone).toBe('disagrees');
    expect(coverageOnly.text).not.toContain('predicted uncertainty is too');
    expect(RATIO_BAND).toEqual([0.6, 1.6]);
    expect(COVERAGE_BAND).toEqual([0.85, 1]);
  });

  it('expects a shared error to fail, and says where a clock error puts the fix', () => {
    const clock = experimentVerdict(aggregate(0, 12.87), scenario({ clock_offset_s: 60 }));
    expect(clock.tone).toBe('meant-to-fail');
    expect(clock.text).toContain('−0.250684 degrees');
    expect(clock.text).toContain('the latitude has not moved');
    const bias = experimentVerdict(aggregate(0, 30.45), scenario({ shared_altitude_bias_arcmin: 3 }));
    expect(bias.tone).toBe('meant-to-fail');
    expect(bias.text).not.toContain('latitude has not moved');
    expect(clockLongitudeShiftDeg(60)).toBeCloseTo(-0.250684477, 9);
  });

  it('makes no statement when nothing was scored, and counts repeated notes once', () => {
    expect(experimentVerdict(aggregate(null, null, 0), scenario()).tone).toBe('nothing-scored');
    const summary = { notes: ['repetition 0: 2 candidate positions, none promoted', 'repetition 1: 2 candidate positions, none promoted', 'other'] } as Pick<ExperimentSummary, 'notes'>;
    expect(dedupeNotes(summary)).toEqual([
      { text: '2 candidate positions, none promoted', count: 2 },
      { text: 'other', count: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------------------

describe('projections', () => {
  it('put east to the right and north up on the plotting sheet, and invert', () => {
    const p = new SheetProjection(PHILLY, { minE: -1000, maxE: 1000, minN: -1000, maxN: 1000 }, { x: 0, y: 0, w: 200, h: 200 });
    const [x0, y0] = p.project(PHILLY);
    const [xe] = p.project(applyOffsetM(PHILLY, 0, 500));
    const [, yn] = p.project(applyOffsetM(PHILLY, 500, 0));
    expect(x0).toBeCloseTo(100, 6);
    expect(y0).toBeCloseTo(100, 6);
    expect(xe).toBeCloseTo(150, 3);
    expect(yn).toBeCloseTo(50, 3);
    const back = p.unproject(150, 50);
    expect(distanceM(back, applyOffsetM(PHILLY, 500, 500))).toBeLessThan(0.01);
  });

  it('hide the far side of the globe and cut lines at its edge', () => {
    const o = new Ortho({ lat_deg: 20, lon_deg: -30 }, 100, 200, 150);
    const c = o.project({ lat_deg: 20, lon_deg: -30 });
    expect(c.x).toBeCloseTo(200, 9);
    expect(c.y).toBeCloseTo(150, 9);
    expect(c.z).toBeCloseTo(1, 12);
    expect(o.project({ lat_deg: -20, lon_deg: 150 }).z).toBeCloseTo(-1, 12);
    // A small circle round the centre is wholly visible: one closed run.
    const ring = Array.from({ length: 36 }, (_, i) => applyOffsetM({ lat_deg: 20, lon_deg: -30 }, 1e6 * Math.cos(i / 5.73), 1e6 * Math.sin(i / 5.73)));
    expect(visibleRuns(o, ring, true)).toHaveLength(1);
    // A great circle through the centre (this meridian and its opposite) is cut at the edge
    // into one visible half.
    const meridian = [
      ...Array.from({ length: 73 }, (_, i) => ({ lat_deg: -90 + i * 2.5, lon_deg: -30 })),
      ...Array.from({ length: 71 }, (_, i) => ({ lat_deg: 87.5 - i * 2.5, lon_deg: 150 })),
    ];
    const runs = visibleRuns(o, meridian, true);
    expect(runs).toHaveLength(1);
    const ends = [runs[0]![0]!, runs[0]![runs[0]!.length - 1]!];
    for (const [x, y] of ends) expect(Math.hypot(x - 200, y - 150)).toBeCloseTo(100, 6);
  });
});
