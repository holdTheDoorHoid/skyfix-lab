/**
 * The six packaged demos from docs/BRIEF.md ("Required packaged demos").
 *
 * Each demo is a simulator scenario, so "Load demo" runs the same code path the
 * Simulator view does. Every session they produce is marked `kind: simulated`.
 */

import type { Scenario } from './api/adapter.js';
import { defaultScenario } from './api/adapter.js';

export interface DemoVariant {
  id: string;
  label: string;
  /** What you are meant to see. Shown next to the menu, not hidden in a tooltip. */
  expect: string;
  scenario: Scenario;
}

export interface Demo {
  id: string;
  title: string;
  why: string;
  variants: DemoVariant[];
}

const PHILADELPHIA = { lat_deg: 39.9526, lon_deg: -75.1652 };

function scenario(name: string, patch: Partial<Scenario>): Scenario {
  return { ...defaultScenario(), name, truth_position: PHILADELPHIA, ...patch };
}

export const DEMOS: Demo[] = [
  {
    id: 'philadelphia',
    title: '1. Philadelphia star sights',
    why: 'The baseline: four well-spread stars, independent noise only.',
    variants: [
      {
        id: 'philadelphia-good',
        label: 'Four stars, 1.0′ noise',
        expect:
          'A unique fix within about a mile of 39° 57.2′ N, 075° 09.9′ W, with a 95 % ellipse and four small residuals.',
        scenario: scenario('Philadelphia four-star', {
          seed: 20261001,
          geometry: 'good',
          sight_count: 4,
          noise_arcmin: 1,
        }),
      },
    ],
  },
  {
    id: 'geometry',
    title: '2. Good versus clustered geometry',
    why: 'The same noise, two geometries. Conditioning, not noise, sets the ellipse shape.',
    variants: [
      {
        id: 'geometry-good',
        label: 'Spread azimuths',
        expect: 'Condition number near 1 and a nearly circular ellipse.',
        scenario: scenario('Spread azimuths', {
          seed: 7,
          geometry: 'good',
          sight_count: 4,
          noise_arcmin: 1,
        }),
      },
      {
        id: 'geometry-clustered',
        label: 'Clustered azimuths (60° sector)',
        expect:
          'The same 1.0′ noise now produces a long thin ellipse across the sector, and a poor-geometry warning.',
        scenario: scenario('Clustered azimuths', {
          seed: 7,
          geometry: 'clustered',
          sight_count: 4,
          noise_arcmin: 1,
        }),
      },
    ],
  },
  {
    id: 'bad-sight',
    title: '3. One bad observation',
    why: 'A single mis-read sight, and what the residual chart shows.',
    variants: [
      {
        id: 'bad-sight-18',
        label: 'Five sights, one wrong by 18′',
        expect:
          'One residual far outside its ±1 sigma band (normalised above 3, highlighted), the rest small.',
        scenario: scenario('One wrong sight', {
          seed: 31,
          geometry: 'good',
          sight_count: 5,
          noise_arcmin: 0.8,
          wrong_sight: { index: 2, error_arcmin: 18 },
        }),
      },
    ],
  },
  {
    id: 'clock',
    title: '4. A shared clock offset',
    why: 'Clock error and longitude are strongly coupled; the solver never estimates the offset.',
    variants: [
      {
        id: 'clock-30',
        label: '30 s fast, uncertainty not declared',
        expect:
          'The fix moves several nautical miles east-west, residuals stay small, and nothing warns you. The error is outside the ellipse.',
        scenario: scenario('Clock offset, undeclared', {
          seed: 5,
          geometry: 'good',
          sight_count: 4,
          noise_arcmin: 0.5,
          clock_offset_s: 30,
          clock_uncertainty_s: 0,
        }),
      },
      {
        id: 'clock-30-declared',
        label: '30 s fast, 30 s uncertainty declared',
        expect:
          'The same displaced fix, but the east-west nominal uncertainty now covers it and a clock warning appears.',
        scenario: scenario('Clock offset, declared', {
          seed: 5,
          geometry: 'good',
          sight_count: 4,
          noise_arcmin: 0.5,
          clock_offset_s: 30,
          clock_uncertainty_s: 30,
        }),
      },
    ],
  },
  {
    id: 'shared-bias',
    title: '5. A shared altitude bias',
    why: 'Repeating a measurement cannot average away an error common to every measurement. Whether you can SEE the bias depends entirely on the azimuth spread.',
    variants: [
      {
        id: 'shared-bias-clustered',
        label: 'Six clustered sights, +3.0′ on every one',
        expect:
          'Every residual stays under half a minute — the fit looks excellent — yet the position is about three nautical miles out. Six sights are no better than one.',
        scenario: scenario('Shared bias, clustered sights', {
          seed: 11,
          geometry: 'clustered',
          sight_count: 6,
          noise_arcmin: 0.4,
          shared_altitude_bias_arcmin: 3,
        }),
      },
      {
        id: 'shared-bias-spread',
        label: 'Six spread sights, +3.0′ on every one',
        expect:
          'The same bias, now visible: every residual is about +3′ while the position barely moves. Surrounding yourself with bodies is what exposes a common error.',
        scenario: scenario('Shared bias, spread sights', {
          seed: 11,
          geometry: 'good',
          sight_count: 6,
          noise_arcmin: 0.4,
          shared_altitude_bias_arcmin: 3,
        }),
      },
    ],
  },
  {
    id: 'ambiguity',
    title: '6. One sight, and an ambiguous two',
    why: 'What a single altitude actually tells you, and why two circles are not one answer.',
    variants: [
      {
        id: 'ambiguity-one',
        label: 'One sight',
        expect:
          'No point at all: a circle of position, and the statement that one sight cannot give a position.',
        scenario: scenario('Single sight', {
          seed: 3,
          geometry: 'single_sight',
          sight_count: 1,
          noise_arcmin: 0.5,
        }),
      },
      {
        id: 'ambiguity-two',
        label: 'Two sights',
        expect:
          'Two candidates drawn with equal weight and labelled ambiguous. Nothing in the session chooses between them.',
        scenario: scenario('Two sights', {
          seed: 3,
          geometry: 'two_body',
          sight_count: 2,
          noise_arcmin: 0.5,
        }),
      },
    ],
  },
];

export function findVariant(id: string): { demo: Demo; variant: DemoVariant } | null {
  for (const demo of DEMOS) {
    const variant = demo.variants.find((v) => v.id === id);
    if (variant) return { demo, variant };
  }
  return null;
}
