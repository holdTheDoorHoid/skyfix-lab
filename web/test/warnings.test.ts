import { describe, expect, it } from 'vitest';
import {
  WARNING_CODES,
  WARNING_SEVERITY,
  warningLabel,
  warningSentence,
  warningSightId,
  type Warning,
  type WarningCode,
} from '../src/types.js';
import { ALL_WARNING_EXAMPLES } from '../src/api/fixtures.js';

/** One instance of every variant, built here so the test does not depend on fixtures. */
const EXAMPLES: Record<WarningCode, Warning> = {
  low_altitude_refraction: {
    code: 'low_altitude_refraction',
    id: 'obs-5',
    apparent_altitude_deg: 4.2,
    sigma_added_arcmin: 1,
  },
  dip_not_applicable: { code: 'dip_not_applicable', id: 'obs-2', horizon: 'artificial_reflected' },
  already_corrected: {
    code: 'already_corrected',
    id: 'obs-3',
    kind: 'observed_ho',
    ignored: ['refraction', 'semidiameter'],
  },
  limb_ignored_for_star: { code: 'limb_ignored_for_star', id: 'obs-1' },
  supplied_direction_used: { code: 'supplied_direction_used', id: 'obs-1' },
  ephemeris_coverage_limited: {
    code: 'ephemeris_coverage_limited',
    provider: 'fixture-pack',
    coverage: '2026',
  },
  poor_geometry: { code: 'poor_geometry', condition_number: 41.2, max_azimuth_gap_deg: 214 },
  clock_degenerate_with_longitude: {
    code: 'clock_degenerate_with_longitude',
    sigma_east_m: 1390,
  },
  prior_used: { code: 'prior_used', sigma_nm: 20, shift_m: 640 },
  robust_weights_applied: { code: 'robust_weights_applied', downweighted_ids: ['obs-3', 'obs-4'] },
  ellipse_suppressed: { code: 'ellipse_suppressed', reason: 'the result is ambiguous' },
  posterior_scaling_skipped: { code: 'posterior_scaling_skipped', dof: 1 },
  duplicate_observation: { code: 'duplicate_observation', ids: ['obs-2', 'obs-3'] },
  not_converged: { code: 'not_converged', iterations: 50 },
  other: { code: 'other', message: 'Something worth saying.' },
};

describe('Warning vocabulary', () => {
  it('has an example for every code, and no code without one', () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual([...WARNING_CODES].sort());
  });

  it('gives every variant a severity', () => {
    for (const code of WARNING_CODES) {
      expect(WARNING_SEVERITY[code], `severity missing for ${code}`).toMatch(/^(caution|note)$/);
    }
  });

  it('renders every variant as a real sentence', () => {
    for (const code of WARNING_CODES) {
      const sentence = warningSentence(EXAMPLES[code]);
      expect(sentence, `no sentence for ${code}`).toBeTruthy();
      expect(sentence, `${code} fell through to the unmapped branch`).not.toMatch(
        /Unmapped warning/,
      );
      expect(sentence.length, `${code} sentence is too short to be useful`).toBeGreaterThan(20);
      expect(sentence.trim().endsWith('.'), `${code} sentence does not end in a full stop`).toBe(
        true,
      );
      expect(sentence, `${code} leaked an object`).not.toMatch(/\[object Object\]/);
      expect(sentence, `${code} printed undefined`).not.toMatch(/undefined/);
      expect(sentence, `${code} printed NaN`).not.toMatch(/NaN/);
    }
  });

  it('never says "accuracy"', () => {
    for (const code of WARNING_CODES) {
      expect(warningSentence(EXAMPLES[code]).toLowerCase()).not.toContain('accuracy');
    }
  });

  it('labels each warning Caution or Note in words', () => {
    expect(warningLabel(EXAMPLES.poor_geometry)).toBe('Caution');
    expect(warningLabel(EXAMPLES.limb_ignored_for_star)).toBe('Note');
  });

  it('reports the sight a warning belongs to, when it has one', () => {
    expect(warningSightId(EXAMPLES.limb_ignored_for_star)).toBe('obs-1');
    expect(warningSightId(EXAMPLES.poor_geometry)).toBeNull();
  });

  it('names the sight inside every per-sight sentence', () => {
    for (const code of WARNING_CODES) {
      const id = warningSightId(EXAMPLES[code]);
      if (id) expect(warningSentence(EXAMPLES[code])).toContain(id);
    }
  });

  it('keeps the shipped example set complete too', () => {
    expect(ALL_WARNING_EXAMPLES.map((w) => w.code).sort()).toEqual([...WARNING_CODES].sort());
  });

  it('reads sensibly for the singular and plural cases', () => {
    expect(warningSentence({ code: 'posterior_scaling_skipped', dof: 1 })).toContain('1 degree ');
    expect(warningSentence({ code: 'posterior_scaling_skipped', dof: 2 })).toContain('2 degrees ');
    expect(
      warningSentence({ code: 'already_corrected', id: 'x', kind: 'observed_ho', ignored: ['dip'] }),
    ).toContain('was not applied again');
    expect(
      warningSentence({
        code: 'already_corrected',
        id: 'x',
        kind: 'observed_ho',
        ignored: ['dip', 'refraction'],
      }),
    ).toContain('were not applied again');
  });

  it('describes each horizon mode in words rather than its enum name', () => {
    expect(warningSentence({ code: 'dip_not_applicable', id: 'a', horizon: 'sea' })).toContain(
      'natural sea horizon',
    );
    expect(
      warningSentence({ code: 'dip_not_applicable', id: 'a', horizon: 'electronic_vertical' }),
    ).toContain('electronic local vertical');
  });
});
