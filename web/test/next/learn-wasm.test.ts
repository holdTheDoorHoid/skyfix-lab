/**
 * Every Learn story, run through the REAL WebAssembly core by the same code the view uses
 * (runStory, factsOf, keyNumber, explain, experimentFor), against the numbers docs/DEMOS.md
 * publishes. Needs the built package (`npm run wasm`); without it this file is skipped and
 * says so loudly, because then nothing here has been checked.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DemoEntry } from '../../src/api/adapter.js';
import { WasmApi } from '../../src/api/wasm.js';
import { chartModel } from '../../src/next/learn/chart-model.js';
import { explain, keyNumber } from '../../src/next/learn/explain.js';
import { factsOf, makeFmt, type Facts, type UniqueFacts } from '../../src/next/learn/facts.js';
import { experimentFor, runStory, type LearnApi, type Run } from '../../src/next/learn/run.js';
import { STORY_IDS, type StoryId, type VariantId } from '../../src/next/learn/stories.js';
import { experimentVerdict } from '../../src/next/learn/verdict.js';

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

if (!hasPackage) {
  console.warn(
    '\n*** learn-wasm.test.ts SKIPPED: no WebAssembly package in web/src/wasm-pkg. The Learn stories have NOT been ' +
      'checked against docs/DEMOS.md. Build it with `npm run wasm` and run the tests again. ***\n',
  );
}

const fmt = makeFmt('metric', 'dm');
const TRUTH = { lat_deg: 39.9526, lon_deg: -75.1652 };

function uniqueOf(f: Facts): UniqueFacts {
  if (f.kind !== 'unique') throw new Error(`expected a unique fix, got ${f.kind}`);
  return f;
}

describe.skipIf(!hasPackage)(
  hasPackage ? 'Learn stories on the real core, against docs/DEMOS.md' : 'Learn stories on the real core — SKIPPED, no WebAssembly package (npm run wasm)',
  () => {
    let api: LearnApi;
    let demos: DemoEntry[];
    const runs = new Map<string, Run>();

    const story = async (id: StoryId, variant: VariantId | null = null): Promise<{ run: Run; facts: Facts }> => {
      const key = `${id}|${variant}`;
      let run = runs.get(key);
      if (!run) {
        run = await runStory(api, demos, id, variant);
        runs.set(key, run);
      }
      return { run, facts: factsOf(run.result, run.truth.position) };
    };

    const experiment = async (id: StoryId) => {
      const demo = demos.find((d) => d.name === id)!;
      const summary = await api.experiment(experimentFor(demo.scenario, 50));
      return { summary, a: summary.aggregate, verdict: experimentVerdict(summary.aggregate, demo.scenario) };
    };

    beforeAll(async () => {
      const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
        initSync: (input: { module: BufferSource }) => unknown;
        init?: () => void;
      };
      glue.initSync({ module: readFileSync(WASM_FILE) });
      glue.init?.();
      // The adapter's constructor is private (the page loads it with WasmApi.load); a test
      // hands it the module it has just initialised.
      api = new (WasmApi as unknown as new (exports: unknown) => WasmApi)(glue);
      demos = await api.demos();
    });

    it('offers the ten packaged demonstrations in story order', () => {
      expect(demos.map((d) => d.name)).toEqual([...STORY_IDS]);
    });

    it('never lets the truth into a session or the solver’s options (every story and variant)', async () => {
      const cases: [StoryId, VariantId | null][] = [
        ...STORY_IDS.map((id) => [id, null] as [StoryId, null]),
        ['one-bad-sight', 'robust'],
        ['clock-offset', 'clock-sigma'],
        ['shared-bias', 'estimate-bias'],
        ['two-sight-ambiguous', 'third-star'],
      ];
      for (const [id, variant] of cases) {
        const { run } = await story(id, variant);
        const sent = JSON.stringify([run.session, run.options]);
        expect(sent, id).not.toContain('39.9526');
        expect(sent, id).not.toContain('75.1652');
        expect(sent, id).not.toContain(String(run.truth.seed));
        expect(run.options.initializer, id).toBeNull();
        expect(run.options.prior, id).toBeNull();
        expect(run.truth.position, id).toEqual(TRUTH);
        expect(run.session.meta.kind, id).toBe('simulated');
      }
    }, 60_000);

    // --- 1. A fix that works ---------------------------------------------------------------

    it('philadelphia-stars: 796 m from the truth, inside a 2.37 by 2.23 km ellipse', async () => {
      const { run, facts } = await story('philadelphia-stars');
      const f = uniqueOf(facts);
      expect(f.fix.lat_deg).toBeCloseTo(39.95313, 5);
      expect(f.fix.lon_deg).toBeCloseTo(-75.155885, 5);
      expect(f.errorM).toBeCloseTo(795.7, 0);
      expect(f.ellipse!.semi_major_m).toBeCloseTo(2365.6, 1);
      expect(f.ellipse!.semi_minor_m).toBeCloseTo(2227.9, 1);
      expect(f.ellipse!.orientation_deg).toBeCloseTo(2.1, 1);
      expect(f.inside95).toBe(true);
      expect(Math.max(...f.residuals.map((r) => Math.abs(r.normalized)))).toBeLessThan(1.1);
      expect(keyNumber('philadelphia-stars', run, f, fmt).value).toBe('796 m');
    });

    it('philadelphia-stars-real: six real stars, a unique fix inside its ellipse', async () => {
      const { run, facts } = await story('philadelphia-stars-real');
      const f = uniqueOf(facts);
      expect(run.session.observations.map((o) => o.body)).toEqual(['Vega', 'Altair', 'Arcturus', 'Deneb', 'Capella', 'Polaris']);
      expect(f.inside95).toBe(true);
      expect(f.errorM).toBeLessThan(f.ellipse!.semi_major_m);
      expect(explain('philadelphia-stars-real', run, f, fmt).happened.join(' ')).toContain('Vega, Altair, Arcturus, Deneb, Capella and Polaris');
    });

    it('philadelphia-stars-sextant: undoes the index correction (−1.5′), the dip (−2.49′) and refraction on every reading', async () => {
      const { run, facts } = await story('philadelphia-stars-sextant');
      expect(uniqueOf(facts).inside95).toBe(true);
      const sights = (run.reduced ?? []).flatMap((e) => (e.status === 'ok' ? [e.sight] : []));
      expect(sights).toHaveLength(5);
      for (const s of sights) {
        const step = (k: string) => s.corrections.steps.find((x) => x.kind === k && x.applied)!;
        expect(s.corrections.input_kind).toBe('sextant_hs');
        expect(step('index_correction').delta_arcmin).toBeCloseTo(-1.5, 6);
        expect(step('dip').delta_arcmin).toBeCloseTo(-1.76 * Math.SQRT2, 6);
        expect(step('refraction').delta_arcmin).toBeLessThan(0);
      }
      expect(explain('philadelphia-stars-sextant', run, facts, fmt).happened[0]).toContain('index correction −1.50′, dip −2.49′ and refraction');
      // The key number is the whole correction taken off each reading, and it is the sum of the steps.
      for (const s of sights) {
        const sum = s.corrections.steps.filter((x) => x.applied).reduce((a, x) => a + x.delta_arcmin, 0);
        expect((s.corrections.ho_deg - s.corrections.input_deg) * 60).toBeCloseTo(sum, 6);
      }
      const key = keyNumber('philadelphia-stars-sextant', run, facts, fmt);
      expect(key.value).toMatch(/^−\d\.\d\d′ to −\d\.\d\d′$/);
      expect(key.caption).toContain('taken off each raw reading before solving');
    });

    it('the healthy-fix experiments reproduce DEMOS.md: coverage 0.96 / 0.98 / 0.96, ratio 1.02 / 1.01 / 1.02', async () => {
      const cases: [StoryId, number, number, number, number][] = [
        ['philadelphia-stars', 0.96, 1232.1, 1327.6, 1.02],
        ['philadelphia-stars-real', 0.98, 1092.7, 1210.1, 1.01],
        ['philadelphia-stars-sextant', 0.96, 1233.6, 1327.6, 1.02],
      ];
      for (const [id, coverage, meanError, meanSigma, ratio] of cases) {
        const { a, verdict } = await experiment(id);
        expect(a.coverage_fraction, id).toBeCloseTo(coverage, 3);
        expect(a.mean_error_m!, id).toBeCloseTo(meanError, 0);
        expect(a.mean_predicted_sigma_m!, id).toBeCloseTo(meanSigma, 0);
        expect(a.error_to_sigma_ratio!, id).toBeCloseTo(ratio, 2);
        expect(verdict.tone, id).toBe('healthy');
      }
      const { a } = await experiment('philadelphia-stars');
      expect(a.coverage_ci95![0]).toBeCloseTo(0.865, 3);
      expect(a.coverage_ci95![1]).toBeCloseTo(0.989, 3);
    }, 60_000);

    // --- 2. Geometry -------------------------------------------------------------------------

    it('good-geometry: a 3.15 by 2.29 km ellipse at condition 1.38', async () => {
      const { run, facts } = await story('good-geometry');
      const f = uniqueOf(facts);
      expect(f.ellipse!.semi_major_m).toBeCloseTo(3151.5, 1);
      expect(f.ellipse!.semi_minor_m).toBeCloseTo(2286.5, 1);
      expect(f.ellipse!.orientation_deg).toBeCloseTo(123.9, 1);
      expect(f.conditionNumber!).toBeCloseTo(1.38, 2);
      expect(f.maxAzimuthGapDeg).toBeCloseTo(92.5, 1);
      expect(keyNumber('good-geometry', run, f, fmt).value).toBe('3.15 × 2.29 km');
    });

    it('clustered-geometry: a 9.28 by 1.89 km ellipse at condition 4.91, with a poor-geometry warning', async () => {
      const { run, facts } = await story('clustered-geometry');
      const f = uniqueOf(facts);
      expect(f.ellipse!.semi_major_m).toBeCloseTo(9278.0, 1);
      expect(f.ellipse!.semi_minor_m).toBeCloseTo(1888.6, 1);
      expect(f.ellipse!.orientation_deg).toBeCloseTo(124.4, 1);
      expect(f.conditionNumber!).toBeCloseTo(4.91, 2);
      expect(f.maxAzimuthGapDeg).toBeCloseTo(331.6, 1);
      expect(f.warnings.some((w) => w.code === 'poor_geometry')).toBe(true);
      const key = keyNumber('clustered-geometry', run, f, fmt);
      expect(key.value).toBe('9.28 × 1.89 km');
      expect(key.caption).toContain('condition number 4.91');
    });

    it('the geometry experiments reproduce DEMOS.md: coverage 1.00 and 0.96, ratio 0.93 and 1.05', async () => {
      const good = await experiment('good-geometry');
      expect(good.a.coverage_fraction).toBeCloseTo(1, 3);
      expect(good.a.mean_error_m!).toBeCloseTo(1374.9, 0);
      expect(good.a.mean_predicted_sigma_m!).toBeCloseTo(1590.7, 0);
      expect(good.a.error_to_sigma_ratio!).toBeCloseTo(0.93, 2);
      const clustered = await experiment('clustered-geometry');
      expect(clustered.a.coverage_fraction).toBeCloseTo(0.96, 3);
      expect(clustered.a.mean_error_m!).toBeCloseTo(3476.9, 0);
      expect(clustered.a.mean_predicted_sigma_m!).toBeCloseTo(3867.6, 0);
      expect(clustered.a.error_to_sigma_ratio!).toBeCloseTo(1.05, 2);
      expect(good.verdict.tone).toBe('healthy');
      expect(clustered.verdict.tone).toBe('healthy');
    }, 60_000);

    // --- 3. One bad sight --------------------------------------------------------------------

    it('one-bad-sight: 6.57 km off, obs-3 at 4.97′ (9.9 σ); robust weighting brings it to 894 m', async () => {
      const { run, facts } = await story('one-bad-sight');
      const f = uniqueOf(facts);
      expect(f.errorM).toBeCloseTo(6567.0, 0);
      expect(f.worst!.id).toBe('obs-3');
      expect(f.worst!.residual_arcmin).toBeCloseTo(4.97, 2);
      expect(f.worst!.normalized).toBeCloseTo(9.93, 2);
      expect(f.inside95).toBe(false);
      expect(run.truth.wrong_sight_ids).toEqual(['obs-3']);
      const key = keyNumber('one-bad-sight', run, f, fmt);
      expect(key.value).toBe('6.57 km');
      expect(key.caption).toContain("obs-3's residual is +4.97′ (9.93 σ)");
      const robust = await story('one-bad-sight', 'robust');
      const r = uniqueOf(robust.facts);
      expect(r.errorM).toBeCloseTo(894.4, 0);
      expect(r.downweighted).toEqual(['obs-3']);
      expect(r.weights['obs-3']!).toBeCloseTo(0.09, 2);
      expect(r.warnings.some((w) => w.code === 'robust_weights_applied')).toBe(true);
      expect(keyNumber('one-bad-sight', robust.run, r, fmt).value).toBe('894 m');
    });

    it('the one-bad-sight experiment reproduces DEMOS.md: coverage 0, error 7.57 times sigma', async () => {
      const { a, verdict } = await experiment('one-bad-sight');
      expect(a.coverage_fraction).toBe(0);
      expect(a.coverage_ci95![1]).toBeCloseTo(0.071, 3);
      expect(a.mean_error_m!).toBeCloseTo(6249.1, 0);
      expect(a.mean_predicted_sigma_m!).toBeCloseTo(829.5, 0);
      expect(a.error_to_sigma_ratio!).toBeCloseTo(7.57, 2);
      expect(verdict.tone).toBe('disagrees');
      expect(verdict.text).toContain('too small relative to the observed error');
    }, 60_000);

    // --- 4. A clock that is wrong ------------------------------------------------------------

    it('clock-offset: a pure east-west shift of −0.2507° of longitude, residuals zero', async () => {
      const { run, facts } = await story('clock-offset');
      const f = uniqueOf(facts);
      expect(f.dLonDeg).toBeCloseTo(-0.250684, 6);
      expect(Math.abs(f.dLatDeg)).toBeLessThan(1e-6);
      expect(f.errorM).toBeCloseTo(21353.8, 0);
      expect(f.maxResidualArcmin).toBeLessThan(0.005);
      expect(f.inside95).toBe(false);
      const key = keyNumber('clock-offset', run, f, fmt);
      expect(key.value).toBe('−0.2507°');
      expect(key.caption).toContain('21.35 km west');
      expect(key.caption).toContain('latitude change 0.000000°');
      const model = chartModel(run.result, run.truth.position)!;
      expect(model.fix).not.toBeNull();
      expect(model.ellipse).not.toBeNull();
    });

    it('clock-offset with 60 s of declared clock doubt: the fix stays put, the ellipse grows to 52.3 km east-west and covers the truth', async () => {
      const { facts } = await story('clock-offset', 'clock-sigma');
      const f = uniqueOf(facts);
      expect(f.dLonDeg).toBeCloseTo(-0.250684, 6);
      expect(f.ellipse!.semi_major_m).toBeCloseTo(52343.1, 1);
      expect(f.ellipse!.semi_minor_m).toBeCloseTo(2950.6, 1);
      expect(f.ellipse!.orientation_deg).toBeCloseTo(90, 1);
      expect(f.clockSigmaEastM).toBeCloseTo(21353.8, 0);
      expect(f.inside95).toBe(true);
    });

    it('the clock experiment reproduces DEMOS.md: coverage 0, error 12.87 times sigma, residuals zero', async () => {
      const { a, verdict } = await experiment('clock-offset');
      expect(a.coverage_fraction).toBe(0);
      expect(a.mean_error_m!).toBeCloseTo(21353.8, 0);
      expect(a.mean_predicted_sigma_m!).toBeCloseTo(1659.1, 0);
      expect(a.error_to_sigma_ratio!).toBeCloseTo(12.87, 2);
      expect(a.mean_residual_rms_arcmin!).toBeLessThan(0.0005);
      expect(verdict.tone).toBe('meant-to-fail');
      expect(verdict.text).toContain('−0.250684 degrees');
    }, 60_000);

    // --- 5. An error every sight shares ------------------------------------------------------

    it('shared-bias: 7.07 km from the truth but claims 231 m, because every sight shares the same bias', async () => {
      const { run, facts } = await story('shared-bias');
      const f = uniqueOf(facts);
      expect(f.errorM).toBeCloseTo(7072.3, 0);
      expect(f.sigmaNorthM).toBeCloseTo(177.5, 1);
      expect(f.sigmaEastM).toBeCloseTo(147.7, 1);
      expect(f.sigmaRadialM).toBeCloseTo(230.9, 1);
      expect(f.ellipse!.semi_major_m).toBeCloseTo(435.5, 1);
      expect(f.ellipse!.semi_minor_m).toBeCloseTo(360.3, 1);
      expect(f.ratio!).toBeCloseTo(30.6, 1);
      expect(f.inside95).toBe(false);
      expect(f.residuals).toHaveLength(24);
      const key = keyNumber('shared-bias', run, f, fmt);
      expect(key.value).toBe('7.07 km');
      expect(key.caption).toBe('from the truth, while the fix claims 231 m (1 σ)');
      const said = explain('shared-bias', run, f, fmt).happened;
      expect(said[0]).toContain(
        'The fix is 7.07 km from the truth but claims 231 m (1 σ), because every sight shares the same bias — the model assumes independent errors.',
      );
      // Honest about the residuals: small in arcminutes, too big against the 0.3′ each sight claims.
      expect(said[1]).toContain('No residual is bigger than 1.20′');
      expect(said[1]).toContain('χ² 129.5 where about 22 is expected');
    });

    it('shared-bias with the bias estimated: 795 m from the truth, bias 2.70′, and an honest ellipse that covers it', async () => {
      const { facts } = await story('shared-bias', 'estimate-bias');
      const f = uniqueOf(facts);
      expect(f.errorM).toBeCloseTo(794.8, 0);
      expect(f.sharedBiasArcmin!).toBeCloseTo(2.7026, 3);
      expect(f.ellipse!.semi_major_m).toBeCloseTo(1567.6, 1);
      expect(f.inside95).toBe(true);
      const said = explain('shared-bias', (await story('shared-bias', 'estimate-bias')).run, f, fmt);
      expect(said.happened.join(' ')).toContain('found +2.70′ (the answer key says +3.0′ was added)');
      expect(said.happened.join(' ')).toContain('short of every one of them');
      expect(said.why.join(' ')).toContain('within 106° of bearing');
    });

    it('the shared-bias experiment reproduces DEMOS.md: coverage 0, error 30.45 times sigma, residual RMS 0.745′', async () => {
      const { a, verdict } = await experiment('shared-bias');
      expect(a.coverage_fraction).toBe(0);
      expect(a.mean_error_m!).toBeCloseTo(7028.7, 0);
      expect(a.mean_predicted_sigma_m!).toBeCloseTo(230.9, 0);
      expect(a.error_to_sigma_ratio!).toBeCloseTo(30.45, 2);
      expect(a.mean_residual_rms_arcmin!).toBeCloseTo(0.745, 3);
      expect(verdict.tone).toBe('meant-to-fail');
    }, 60_000);

    // --- 6. Too few sights -------------------------------------------------------------------

    it('single-sight: underdetermined, a circle of 2,700 NM round 56°51.74′N 9°00.49′W, and no point', async () => {
      const { run, facts } = await story('single-sight');
      expect(run.result.kind).toBe('underdetermined');
      if (facts.kind !== 'underdetermined') throw new Error('expected underdetermined');
      expect(facts.circles).toHaveLength(1);
      const c = facts.circles[0]!;
      expect(c.zenith_distance_deg).toBeCloseTo(45, 4);
      expect(c.gp.lat_deg).toBeCloseTo(56 + 51.74 / 60, 3);
      expect(c.gp.lon_deg).toBeCloseTo(-(9 + 0.49 / 60), 3);
      expect(facts.radiusNm).toBeCloseTo(2700, 1);
      expect(facts.truthOffCircleM).toBeLessThan(1);
      expect(keyNumber('single-sight', run, facts, fmt).value).toBe('2,700 NM');
      const model = chartModel(run.result, run.truth.position)!;
      expect(model.circles).toHaveLength(1);
      expect(model.fix).toBeNull();
      expect(model.candidates).toEqual([]);
      expect(model.ellipse).toBeNull();
    });

    it('two-sight-ambiguous: both candidates, 8,916 km apart, neither promoted; a third star settles it', async () => {
      const { run, facts } = await story('two-sight-ambiguous');
      expect(run.result.kind).toBe('ambiguous');
      if (facts.kind !== 'ambiguous') throw new Error('expected ambiguous');
      expect(facts.candidates).toHaveLength(2);
      const [a, b] = facts.candidates;
      expect(a!.lat_deg).toBeCloseTo(6.248595, 5);
      expect(a!.lon_deg).toBeCloseTo(7.324286, 5);
      expect(b!.lat_deg).toBeCloseTo(39.9526, 5);
      expect(b!.lon_deg).toBeCloseTo(-75.1652, 5);
      expect(facts.separationM / 1000).toBeCloseTo(8916.4, 0);
      expect(keyNumber('two-sight-ambiguous', run, facts, fmt).value).toBe('8,916 km');
      const model = chartModel(run.result, run.truth.position)!;
      expect(model.candidates).toHaveLength(2);
      expect(model.fix).toBeNull();
      expect(model.ellipse).toBeNull();
      const third = await story('two-sight-ambiguous', 'third-star');
      const f = uniqueOf(third.facts);
      expect(f.errorM).toBeLessThan(1);
      expect(third.run.session.observations).toHaveLength(3);
    });

    it('the under-constrained experiments score nothing, as DEMOS.md says they must', async () => {
      const single = await experiment('single-sight');
      expect(single.a.result_kind_counts).toEqual([['underdetermined', 50]]);
      expect(single.a.evaluated).toBe(0);
      expect(single.verdict.tone).toBe('nothing-scored');
      const two = await experiment('two-sight-ambiguous');
      expect(two.a.result_kind_counts).toEqual([['ambiguous', 50]]);
      expect(two.verdict.tone).toBe('nothing-scored');
    }, 60_000);
  },
);
