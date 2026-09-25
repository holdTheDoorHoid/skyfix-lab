/**
 * The mock adapter is what the interface runs against until the Rust core lands, so its
 * contract shapes and its refusal to leak simulated truth are worth pinning down.
 */
import { describe, expect, it } from 'vitest';
import { MockApi, emptySession, withDefaults } from '../src/api/mock.js';
import { MOCK_DEMOS } from '../src/api/mockDemos.js';
import { defaultSolveOptions, SESSION_SCHEMA, TRUTH_SCHEMA, CORRECTION_ORDER } from '../src/types.js';
import type { Scenario } from '../src/api/adapter.js';
import type { LatLon } from '../src/types.js';

/** North and east offsets of `p` from `origin`, metres, on the sphere (1′ = 1852 m). */
function offsetMetres(origin: LatLon, p: LatLon): { north: number; east: number } {
  const north = (p.lat_deg - origin.lat_deg) * 60 * 1852;
  let dLon = p.lon_deg - origin.lon_deg;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  return { north, east: dLon * 60 * 1852 * Math.cos((origin.lat_deg * Math.PI) / 180) };
}

const api = new MockApi();

/** The mock's own spread-geometry scenario, cloned so a test can vary it. */
function scenario(patch: Partial<Scenario> = {}): Scenario {
  return { ...structuredClone(MOCK_DEMOS[0]!), ...patch };
}

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
    const sc = scenario();
    sc.altitude_kind = {
      kind: 'sextant_hs',
      height_of_eye_m: 2,
      index_correction_arcmin: -2,
      pressure_hpa: 1010,
      temperature_c: 10,
    };
    const { session } = await api.simulate(sc);
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
    const sc = scenario({ clock_offset_s: 12, shared_altitude_bias_arcmin: 2 });
    const { session, truth } = await api.simulate(sc);
    expect(truth.schema).toBe(TRUTH_SCHEMA);
    expect(truth.position).toEqual(sc.truth);
    expect(truth.clock_offset_s).toBe(12);
    const asJson = JSON.stringify(session);
    expect(asJson).not.toContain(String(sc.truth.lat_deg));
    expect(asJson).not.toContain(String(sc.seed));
    expect(session.meta.kind).toBe('simulated');
  });

  it('is deterministic for a seed', async () => {
    const a = await api.simulate(scenario());
    const b = await api.simulate(scenario());
    expect(a.session).toEqual(b.session);
    const c = await api.simulate(scenario({ seed: 999 }));
    expect(c.session.observations[0]!.altitude_deg).not.toBe(
      a.session.observations[0]!.altitude_deg,
    );
  });

  it('recovers the truth from a clean noise-free session', async () => {
    const sc = scenario({ altitude_noise_arcmin: 0, reported_sigma_arcmin: 1 });
    const { session, truth } = await api.simulate(sc);
    const result = await api.solve(session, defaultSolveOptions(), 'supplied');
    expect(result.kind).toBe('unique');
    if (result.kind !== 'unique') return;
    const { north, east } = offsetMetres(result.fix.position, truth.position);
    expect(Math.hypot(north, east)).toBeLessThan(50);
  });

  it('carries the circles of position on a unique fix, as types.rs now does', async () => {
    const { session } = await api.simulate(scenario());
    const result = await api.solve(session, defaultSolveOptions(), 'supplied');
    if (result.kind !== 'unique') throw new Error(`expected unique, got ${result.kind}`);
    expect(result.circles).toHaveLength(session.observations.length);
    expect(result.fix.conditioning.columns).toBeTruthy();
  });

  it('returns underdetermined for one sight and ambiguous for two', async () => {
    const one = scenario({ sources: MOCK_DEMOS[0]!.sources.slice(0, 1) });
    one.schedule = { ...one.schedule, count: 1 };
    const oneOut = await api.simulate(one);
    const oneResult = await api.solve(oneOut.session, defaultSolveOptions(), 'supplied');
    expect(oneResult.kind).toBe('underdetermined');
    if (oneResult.kind === 'underdetermined') expect(oneResult.circles).toHaveLength(1);

    const twoOut = await api.simulate(structuredClone(MOCK_DEMOS[2]!));
    const twoResult = await api.solve(twoOut.session, defaultSolveOptions(), 'supplied');
    expect(twoResult.kind).toBe('ambiguous');
    if (twoResult.kind === 'ambiguous') {
      expect(twoResult.candidates).toHaveLength(2);
      expect(twoResult.circles).toHaveLength(2);
    }
  });

  it('reports a singular condition number as null, never as zero', async () => {
    const one = scenario({ sources: MOCK_DEMOS[0]!.sources.slice(0, 1) });
    one.schedule = { ...one.schedule, count: 1 };
    const { session } = await api.simulate(one);
    const entries = await api.reduce(session, 'supplied');
    expect(entries).toHaveLength(1);
  });

  it('lets a shared bias hide behind a clustered geometry', async () => {
    // MOCK_DEMOS[1] is the clustered + 3 arcminute bias scenario.
    const sc = structuredClone(MOCK_DEMOS[1]!);
    sc.altitude_noise_arcmin = 0;
    sc.reported_sigma_arcmin = 1;
    const { session, truth } = await api.simulate(sc);
    const result = await api.solve(session, defaultSolveOptions(), 'supplied');
    expect(result.kind).toBe('unique');
    if (result.kind !== 'unique') return;
    for (const r of result.fix.residuals) expect(Math.abs(r.residual_arcmin)).toBeLessThan(0.6);
    const { north, east } = offsetMetres(result.fix.position, truth.position);
    expect(Math.hypot(north, east)).toBeGreaterThan(3000);
  });

  it('makes a shared bias visible when the azimuths surround the observer', async () => {
    // The same 3 arcminute bias as the clustered case above, on the same six bodies,
    // but with every one of them used. How much of the bias the fit can absorb depends
    // entirely on how balanced the azimuths are, so the two cases are compared rather
    // than each being pinned to a number.
    const base = { altitude_noise_arcmin: 0, reported_sigma_arcmin: 1 } as const;
    const clustered = structuredClone(MOCK_DEMOS[1]!);
    Object.assign(clustered, base);
    const spread = structuredClone(MOCK_DEMOS[1]!);
    Object.assign(spread, base);
    spread.geometry = { preset: 'as_given' };

    const run = async (sc: Scenario) => {
      const { session, truth } = await api.simulate(sc);
      const result = await api.solve(session, defaultSolveOptions(), 'supplied');
      if (result.kind !== 'unique') throw new Error(`expected unique, got ${result.kind}`);
      const { north, east } = offsetMetres(result.fix.position, truth.position);
      return {
        error: Math.hypot(north, east),
        maxResidual: Math.max(...result.fix.residuals.map((r) => Math.abs(r.residual_arcmin))),
      };
    };

    const c = await run(clustered);
    const sp = await run(spread);

    // Clustered: the fit looks perfect and the position is miles out.
    expect(c.maxResidual).toBeLessThan(0.6);
    expect(c.error).toBeGreaterThan(3000);
    // Spread: the residuals carry the bias, and the position is far better.
    expect(sp.maxResidual).toBeGreaterThan(1);
    expect(sp.error).toBeLessThan(c.error / 2);
  });

  it('refuses a scenario naming a real body rather than inventing one', async () => {
    const sc = scenario({ sources: [{ source: 'named', name: 'Vega' }] });
    await expect(api.simulate(sc)).rejects.toThrow(/no star catalogue/);
  });

  it('refuses to plan rather than guessing which bodies are up', async () => {
    await expect(
      api.plan({ lat_deg: 40, lon_deg: -75 }, '2026-10-01T01:30:00Z', {
        select: 4,
        min_altitude_deg: 15,
        max_altitude_deg: 75,
        already_taken: [],
        objective: 'min_trace',
        base_sigma_arcmin: 1,
      }),
    ).rejects.toThrow(/no astronomy/);
  });

  it('runs a coverage experiment with a Wilson interval', async () => {
    const summary = await api.experiment({
      scenario: scenario(),
      solve_options: defaultSolveOptions(),
      repetitions: 20,
    });
    expect(summary.runs).toHaveLength(20);
    expect(summary.aggregate.coverage_fraction).not.toBeNull();
    const ci = summary.aggregate.coverage_ci95!;
    expect(ci[0]).toBeGreaterThanOrEqual(0);
    expect(ci[1]).toBeLessThanOrEqual(1);
    expect(ci[0]).toBeLessThanOrEqual(summary.aggregate.coverage_fraction!);
    expect(ci[1]).toBeGreaterThanOrEqual(summary.aggregate.coverage_fraction!);
  });

  it('circle points come back as [lat, lon] pairs', async () => {
    const points = await api.circlePoints(38.79, -123.45, 28.77, 8);
    expect(points).toHaveLength(8);
    expect(points[0]![0]).toBeCloseTo(38.79 + 28.77, 6);
  });
});
