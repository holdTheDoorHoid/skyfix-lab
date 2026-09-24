/**
 * The mock adapter is what the interface runs against until the Rust core lands, so its
 * contract shapes and its refusal to leak simulated truth are worth pinning down.
 */
import { describe, expect, it } from 'vitest';
import { MockApi, emptySession, withDefaults } from '../src/api/mock.js';
import { defaultScenario } from '../src/api/adapter.js';
import { defaultSolveOptions, SESSION_SCHEMA, TRUTH_SCHEMA, CORRECTION_ORDER } from '../src/types.js';
import { offsetMetres, truthInsideEllipse } from '../src/views/simulator.js';

const api = new MockApi();

describe('session defaults', () => {
  it('fills serde defaults for a partial document', () => {
    const session = withDefaults({
      schema: SESSION_SCHEMA,
      observations: [{ body: 'Vega', utc: '2026-10-01T01:30:00Z', altitude_deg: 61.2 }],
    });
    expect(session.observer.pressure_hpa).toBe(1010);
    expect(session.observer.temperature_c).toBe(10);
    expect(session.instrument.horizon).toBe('sea');
    expect(session.observations[0]!.sigma_arcmin).toBe(1);
    expect(session.observations[0]!.limb).toBe('center');
    expect(session.observations[0]!.id).toBe('obs-1');
  });

  it('defaults a session to SIMULATED, the safer of the two', () => {
    expect(emptySession().meta.kind).toBe('simulated');
  });

  it('rejects a document with the wrong schema', async () => {
    await expect(api.parseSession('{"schema":"nope","observations":[]}')).rejects.toThrow(
      /unsupported session schema/,
    );
  });

  it('rejects a non-positive sigma', async () => {
    const json = JSON.stringify({
      schema: SESSION_SCHEMA,
      observations: [{ id: 'a', body: 'Vega', utc: '2026-10-01T01:30:00Z', altitude_deg: 10, sigma_arcmin: 0 }],
    });
    await expect(api.parseSession(json)).rejects.toThrow(/sigma_arcmin/);
  });
});

describe('reduction', () => {
  it('reports all six correction steps, applied or not', async () => {
    const { session } = await api.simulate(defaultScenario());
    const entries = await api.reduce(session, 'supplied');
    const first = entries[0]!;
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.sight.corrections.steps.map((s) => s.kind)).toEqual([...CORRECTION_ORDER]);
    const skipped = first.sight.corrections.steps.filter((s) => !s.applied);
    expect(skipped.length).toBeGreaterThan(0);
    for (const step of skipped) expect(step.note).toMatch(/^not applied: /);
  });

  it('rejects a sight with no direction rather than guessing one', async () => {
    const session = emptySession();
    session.observations.push({
      id: 'obs-1',
      body: 'Vega',
      utc: '2026-10-01T01:30:00Z',
      altitude_deg: 61.2,
      altitude_kind: 'sextant_hs',
      sigma_arcmin: 1,
      limb: 'center',
      horizon: null,
      geocentric: null,
      notes: '',
    });
    const [entry] = await api.reduce(session, 'supplied');
    expect(entry!.status).toBe('error');
  });
});

describe('simulation and solving', () => {
  it('keeps the truth out of the session', async () => {
    const scenario = { ...defaultScenario(), clock_offset_s: 12, shared_altitude_bias_arcmin: 2 };
    const { session, truth } = await api.simulate(scenario);
    expect(truth.schema).toBe(TRUTH_SCHEMA);
    expect(truth.position).toEqual(scenario.truth_position);
    const asJson = JSON.stringify(session);
    expect(asJson).not.toContain('truth');
    expect(asJson).not.toContain(String(scenario.truth_position.lat_deg));
    expect(session.meta.kind).toBe('simulated');
  });

  it('is deterministic for a seed', async () => {
    const a = await api.simulate(defaultScenario());
    const b = await api.simulate(defaultScenario());
    expect(a.session).toEqual(b.session);
    const c = await api.simulate({ ...defaultScenario(), seed: 999 });
    expect(c.session.observations[0]!.altitude_deg).not.toBe(a.session.observations[0]!.altitude_deg);
  });

  it('recovers the truth from a clean four-star session', async () => {
    const scenario = { ...defaultScenario(), noise_arcmin: 0 };
    const { session, truth } = await api.simulate(scenario);
    const result = await api.solve(session, defaultSolveOptions());
    expect(result.kind).toBe('unique');
    if (result.kind !== 'unique') return;
    const { north, east } = offsetMetres(result.fix.position, truth.position);
    expect(Math.hypot(north, east)).toBeLessThan(50);
  });

  it('returns underdetermined for one sight and ambiguous for two', async () => {
    const one = await api.simulate({ ...defaultScenario(), geometry: 'single_sight' });
    const oneResult = await api.solve(one.session, defaultSolveOptions());
    expect(oneResult.kind).toBe('underdetermined');
    if (oneResult.kind === 'underdetermined') expect(oneResult.circles).toHaveLength(1);

    const two = await api.simulate({ ...defaultScenario(), geometry: 'two_body' });
    const twoResult = await api.solve(two.session, defaultSolveOptions());
    expect(twoResult.kind).toBe('ambiguous');
    if (twoResult.kind === 'ambiguous') {
      expect(twoResult.candidates).toHaveLength(2);
      expect(twoResult.circles).toHaveLength(2);
    }
  });

  it('lets a shared bias hide in the residuals when the azimuths are clustered', async () => {
    // The brief's fifth demo: many sights, an excellent-looking fit, a wrong position.
    const scenario = {
      ...defaultScenario(),
      geometry: 'clustered' as const,
      noise_arcmin: 0,
      sight_count: 6,
      shared_altitude_bias_arcmin: 3,
    };
    const { session, truth } = await api.simulate(scenario);
    const result = await api.solve(session, defaultSolveOptions());
    expect(result.kind).toBe('unique');
    if (result.kind !== 'unique') return;
    for (const r of result.fix.residuals) expect(Math.abs(r.residual_arcmin)).toBeLessThan(0.5);
    const { north, east } = offsetMetres(result.fix.position, truth.position);
    // 3 arcminutes of shared bias is about 3 NM of position error, and no residual shows it.
    expect(Math.hypot(north, east)).toBeGreaterThan(3000);
  });

  it('pushes a shared bias into the residuals when the azimuths surround the observer', async () => {
    const scenario = {
      ...defaultScenario(),
      geometry: 'good' as const,
      noise_arcmin: 0,
      sight_count: 6,
      shared_altitude_bias_arcmin: 3,
    };
    const { session, truth } = await api.simulate(scenario);
    const result = await api.solve(session, defaultSolveOptions());
    expect(result.kind).toBe('unique');
    if (result.kind !== 'unique') return;
    // Position is barely moved, but every residual is the bias. Same error, visible.
    for (const r of result.fix.residuals) expect(Math.abs(r.residual_arcmin)).toBeCloseTo(3, 1);
    const { north, east } = offsetMetres(result.fix.position, truth.position);
    expect(Math.hypot(north, east)).toBeLessThan(200);
  });

  it('makes a clustered geometry ill-conditioned', async () => {
    const good = await api.simulate({ ...defaultScenario(), geometry: 'good', noise_arcmin: 0 });
    const clustered = await api.simulate({ ...defaultScenario(), geometry: 'clustered', noise_arcmin: 0 });
    const a = await api.solve(good.session, defaultSolveOptions());
    const b = await api.solve(clustered.session, defaultSolveOptions());
    if (a.kind !== 'unique' || b.kind !== 'unique') throw new Error('expected unique fixes');
    expect(b.fix.conditioning.condition_number).toBeGreaterThan(
      a.fix.conditioning.condition_number * 3,
    );
    expect(b.warnings.some((w) => w.code === 'poor_geometry')).toBe(true);
  });

  it('circle points come back as [lat, lon] pairs', async () => {
    const points = await api.circlePoints(38.79, -123.45, 28.77, 8);
    expect(points).toHaveLength(8);
    expect(points[0]![0]).toBeCloseTo(38.79 + 28.77, 6);
  });

  it('lists the Sun, 57 stars and Polaris', async () => {
    const names = await api.catalog();
    expect(names).toHaveLength(59);
    expect(names[0]).toBe('Sun');
    expect(names).toContain('Polaris');
    expect(new Set(names).size).toBe(59);
  });
});

describe('truth versus the ellipse', () => {
  const ellipse = {
    semi_major_m: 2000,
    semi_minor_m: 1000,
    orientation_deg: 0,
    confidence: 0.95,
    model: 'nominal 95 %, independent-noise model',
  };
  const fix = { lat_deg: 40, lon_deg: -75 };

  it('accepts a point inside along the major axis (north)', () => {
    const truth = { lat_deg: 40 + 1500 / (60 * 1852), lon_deg: -75 };
    expect(truthInsideEllipse(fix, truth, ellipse)).toBe(true);
  });

  it('rejects a point outside along the minor axis (east)', () => {
    const east = 1500 / (60 * 1852 * Math.cos((40 * Math.PI) / 180));
    expect(truthInsideEllipse(fix, { lat_deg: 40, lon_deg: -75 + east }, ellipse)).toBe(false);
  });

  it('measures east-west offsets with the cos(latitude) factor', () => {
    const { east } = offsetMetres(fix, { lat_deg: 40, lon_deg: -74 });
    expect(east).toBeCloseTo(60 * 1852 * Math.cos((40 * Math.PI) / 180), 6);
  });

  it('measures across the antimeridian without a 360-degree jump', () => {
    const { east } = offsetMetres({ lat_deg: 0, lon_deg: 179.5 }, { lat_deg: 0, lon_deg: -179.5 });
    expect(east).toBeCloseTo(60 * 1852, 6);
  });
});
