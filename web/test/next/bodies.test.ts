/** Which coverage group a body belongs to, and whether it may be offered for sights. */
import { describe, expect, it } from 'vitest';
import { coverageGroupFor, offeredForSights } from '../../src/next/engine/bodies.js';
import type { BodyInfo, ExplorerCoverage } from '../../src/next/engine/types.js';

const moon: BodyInfo = { body: 'Moon', kind: 'moon', navigational: true, magnitude: null };
const neptune: BodyInfo = { body: 'Neptune', kind: 'planet', navigational: false, magnitude: null };
const venus: BodyInfo = { body: 'Venus', kind: 'planet', navigational: true, magnitude: null };
const vega: BodyInfo = { body: 'Vega', kind: 'star', navigational: true, magnitude: 0.03 };

const group = (name: string, validated: boolean, bodies?: string[]) => ({
  name,
  provider: 'p',
  accuracy_arcmin: 0.1,
  validated,
  notes: '',
  ...(bodies ? { bodies } : {}),
});

describe('coverage groups', () => {
  it('uses the listed bodies when the engine provides them', () => {
    const cov: ExplorerCoverage = {
      start_utc: '',
      end_utc: '',
      groups: [group('Lunar theory', true, ['Moon']), group('Everything else', false, ['Venus', 'Neptune'])],
    };
    expect(coverageGroupFor(moon, cov)!.name).toBe('Lunar theory');
    expect(offeredForSights(moon, cov)).toBe(true);
    expect(offeredForSights(venus, cov)).toBe(false);
    expect(coverageGroupFor(vega, cov)).toBeNull(); // listed groups never guess
  });

  it('falls back to the group named after the body kind', () => {
    const cov: ExplorerCoverage = {
      start_utc: '',
      end_utc: '',
      groups: [group('Sun', true), group('Moon', true), group('Planets', true), group('Stars', false)],
    };
    expect(offeredForSights(moon, cov)).toBe(true);
    expect(offeredForSights(venus, cov)).toBe(true);
    expect(offeredForSights(neptune, cov)).toBe(false); // shown, never offered
    expect(offeredForSights(vega, cov)).toBe(false); // provider not validated
  });
});
