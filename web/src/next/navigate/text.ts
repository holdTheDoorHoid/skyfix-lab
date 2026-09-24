/**
 * The Navigate view's words: plain language first, the navigator's term beside it
 * (EXPLORER_PLAN section 1, "Height above horizon · altitude"). Every explanation the view
 * shows lives here, so the wording can be reviewed in one place. OWNER: navigate agent.
 *
 * Wording that must not drift (docs/CONVENTIONS.md and the old workbench):
 * - the ellipse is always "nominal 95 %, independent-noise model";
 * - the planner's position is "an approximate position … never a prior";
 * - the four result kinds are named unique, ambiguous, underdetermined and failed.
 */

import type { AltitudeKind, CorrectionKind, HorizonMode, Limb } from '../../types.js';
import type { LunarClearingStep } from '../engine/types.js';

export const HONESTY = 'Simulation and analysis workbench. Not a navigation instrument.';

/** The ellipse's model, exactly as the core writes it (CONVENTIONS section 9). */
export const ELLIPSE_MODEL = 'nominal 95 %, independent-noise model';

export interface StepText {
  /** Plain words. */
  plain: string;
  /** The navigator's term. */
  term: string;
  /** One sentence: why this step exists. */
  why: string;
}

/** The six correction steps (CONVENTIONS section 5), in the order the core runs them. */
export const STEP_TEXT: Record<CorrectionKind, StepText> = {
  index_correction: {
    plain: 'Instrument error',
    term: 'index correction, IC',
    why: 'A sextant rarely reads exactly zero with its mirrors parallel; the index correction is added to every reading.',
  },
  dip: {
    plain: 'Height of eye',
    term: 'dip',
    why: 'From above the water the sea horizon lies below true level, so every reading is a little too high.',
  },
  artificial_horizon_halving: {
    plain: 'Artificial horizon: halve the angle',
    term: 'double angle ÷ 2',
    why: 'With a reflected artificial horizon the sextant measures twice the altitude.',
  },
  refraction: {
    plain: 'Air bends the light',
    term: 'refraction, R',
    why: 'The atmosphere lifts every body, most near the horizon.',
  },
  semidiameter: {
    plain: 'Edge of the disc to its centre',
    term: 'semidiameter, SD',
    why: 'For the Sun and the Moon you bring an edge (limb) to the horizon; the tables are for the centre.',
  },
  parallax: {
    plain: 'Seen from the surface, not the centre',
    term: 'parallax in altitude, PA',
    why: 'The almanac gives directions from the Earth’s centre; near bodies, above all the Moon, look lower from its surface.',
  },
};

export const KIND_TEXT: Record<AltitudeKind, { plain: string; term: string; option: string }> = {
  sextant_hs: { plain: 'Sextant reading', term: 'Hs', option: 'Sextant reading Hs (raw, nothing corrected)' },
  apparent_ha: { plain: 'Apparent altitude', term: 'Ha', option: 'Apparent altitude Ha (index, dip and halving done)' },
  observed_ho: { plain: 'Observed altitude', term: 'Ho', option: 'Observed altitude Ho (fully corrected)' },
};

export const LIMB_TEXT: Record<Limb, string> = {
  lower: 'Lower edge',
  center: 'Centre',
  upper: 'Upper edge',
};

export const HORIZON_TEXT: Record<HorizonMode, { label: string; explain: string }> = {
  sea: {
    label: 'Sea horizon',
    explain: 'Dip applies: the visible horizon is below true level by 1.76′ × √(height of eye in metres).',
  },
  artificial_reflected: {
    label: 'Reflected artificial horizon',
    explain: 'The reading is the double angle. It is halved after the index correction, and no dip applies.',
  },
  electronic_vertical: {
    label: 'Electronic vertical',
    explain: 'An inclinometer or camera attitude supplies level directly. No dip; the index correction is the instrument zero offset.',
  },
};

export const ROLE_TEXT = {
  initializer: {
    label: 'Starting point only',
    explain: 'The solver starts its search here. It never pulls the answer towards it (an initializer, never a prior).',
  },
  prior: {
    label: 'Prior: it influences the answer',
    explain: 'A prior changes the fix. The result is reported with and without it.',
  },
  disabled: {
    label: 'Not used',
    explain: 'The solver searches the whole globe; nothing is assumed.',
  },
} as const;

export const LUNAR_STEP_TEXT: Record<LunarClearingStep['kind'], { plain: string; term: string }> = {
  index_correction: { plain: 'Instrument error', term: 'index correction' },
  moon_semidiameter: { plain: 'Moon’s edge to its centre', term: 'Moon’s semidiameter (augmented)' },
  body_semidiameter: { plain: 'Other body’s edge to its centre', term: 'semidiameter' },
  refraction: { plain: 'Air bends the light', term: 'refraction removed' },
  parallax: { plain: 'Seen from the surface, not the centre', term: 'parallax removed (WGS84)' },
};

export type MethodId = 'fix' | 'noon' | 'polaris' | 'running' | 'average' | 'lunar' | 'plan';

export interface MethodText {
  id: MethodId;
  label: string;
  /** The tab's tooltip and the heading. */
  title: string;
  /** Two or three plain sentences under the heading. */
  explain: string;
}

export const METHODS: readonly MethodText[] = [
  {
    id: 'fix',
    label: 'Fix',
    title: 'Your position from several sights',
    explain:
      'Each sight says you stand somewhere on one circle on the Earth: every place where that body stood at that height at that moment (a circle of position). Where the circles cross is your fix, found by weighted least squares. Sights spread round the horizon make a tight fix; sights all on one side make a long, thin one.',
  },
  {
    id: 'noon',
    label: 'Noon sight',
    title: 'Latitude from the highest point',
    explain:
      'Around local noon the Sun (or any body) climbs to its highest as it crosses your meridian. How HIGH it gets gives your latitude directly and strongly. WHEN it peaks gives your longitude, but only weakly: the top of the curve is flat. Take a run of sights before and after the peak.',
  },
  {
    id: 'polaris',
    label: 'Polaris',
    title: 'Latitude from the Pole Star',
    explain:
      'Polaris sits within a degree of the celestial pole, so its height is nearly your latitude. The small difference depends on the time and your longitude; it is worked out exactly here, and the Nautical Almanac’s a0, a1, a2 table terms are shown beside it for teaching.',
  },
  {
    id: 'running',
    label: 'Running fix',
    title: 'A fix while under way',
    explain:
      'Sights taken hours apart from a moving vessel are brought to one moment by the dead-reckoning run between them (course and speed), then solved as a fix. How well you know the course and speed limits the answer as much as the sextant does.',
  },
  {
    id: 'average',
    label: 'Average a run',
    title: 'Many quick sights of one body, made into one good one',
    explain:
      'Take several sights of one body in a few minutes. The heights change along a curve the almanac predicts; fitting only its level averages the noise without the error a plain average makes, flags a sight that does not fit, and gives one sight you can use in a fix.',
  },
  {
    id: 'lunar',
    label: 'Lunar distance',
    title: 'Greenwich time from the Moon',
    explain:
      'The Moon moves against the stars by about its own width every hour. Measure its distance from the Sun, a star or a planet, clear the measurement of refraction and parallax, and the almanac says what time it is at Greenwich: a clock that needs no chronometer. One arcminute of distance is about two minutes of time.',
  },
  {
    id: 'plan',
    label: 'Plan sights',
    title: 'What to shoot, and when',
    explain:
      'Star sights need the stars and a sharp horizon at once: nautical twilight, the Sun 6° to 12° below the horizon. The planner finds tonight’s windows and picks three to five bodies spread round the horizon, with the sextant reading and bearing to expect.',
  },
];

export const RESULT_KIND_TEXT = {
  unique: { label: 'Unique fix', sentence: 'One position fits the sights clearly better than any other.' },
  ambiguous: {
    label: 'Ambiguous — two or more positions fit equally well',
    sentence:
      'Nothing in these sights chooses between the candidates, so none is promoted and no ellipse is drawn. Add a sight of a body in a different direction, or state a prior.',
  },
  underdetermined: {
    label: 'Underdetermined — no position',
    sentence: 'These sights constrain you to a circle (or a line), not a point. Every place on it predicts the heights you measured.',
  },
  failed: { label: 'Failed — no position', sentence: 'The solver found no position.' },
} as const;

/** The old planner's standing disclosures (docs/PLANNER.md), unchanged in substance. */
export const PLANNER_DISCLOSURES: readonly { strong: string; text: string }[] = [
  {
    strong: 'It needs an approximate position, and it says which one it used. ',
    text: 'Ranking bodies means predicting where they will be, which needs a position to predict from. That approximate position is a planning input only: it never becomes a prior on a fix, and it never reaches the solver.',
  },
  {
    strong: 'Visibility is geometric, plus a twilight flag. ',
    text: 'There is no weather here. A body the planner calls visible may be behind cloud, and the twilight rule comes from the computed Sun altitude, not from an observation of the sky.',
  },
  {
    strong: 'Ranking is by geometry, not brightness. ',
    text: 'The useful question is which body most improves the geometry you already have. A bright star in a direction you have covered adds less than a dimmer one that fills the gap.',
  },
];

export const AUTOSAVE_TEXT =
  'Your sights, and the assumed position that goes with them, are kept in this browser only, on this device, so a reload does not lose them. Nothing is kept until you enter a sight or a reading, nothing is sent anywhere, and no position is ever put in the address bar.';
