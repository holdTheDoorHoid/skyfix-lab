/**
 * What a run means, in plain words: the key number of each story and a short "what
 * happened / why" built from the run's own numbers. OWNER: learn agent.
 *
 * Every number in these sentences is read from the run (`facts.ts`), never typed in, and
 * every claim that depends on the outcome ("inside the ellipse", "residuals look
 * ordinary") is conditional on it, so a change in the core that changed a demo could not
 * leave a story telling the old tale. docs/DEMOS.md holds the published values;
 * web/test/next/learn-wasm.test.ts checks the two agree.
 */

import type { Scenario } from '../../api/adapter.js';
import type { Truth } from '../../types.js';
import {
  arcmin,
  candidateLetter,
  compassWords,
  conditionText,
  ellipseSize,
  errorBearing,
  signedDeg,
  times,
  type Facts,
  type Fmt,
  type UniqueFacts,
} from './facts.js';
import type { Run } from './run.js';
import type { StoryId } from './stories.js';

export interface KeyNumber {
  /** The number itself, large: "7.07 km". */
  value: string;
  /** What it is, one line: "from the truth, while the fix claims 231 m (1 σ)". */
  caption: string;
}

export interface Explanation {
  happened: string[];
  why: string[];
}

// ---------------------------------------------------------------------------------------
// Phrases

/** "inside its 95 % ellipse (2.37 × 2.23 km)" or the honest alternatives. */
function insidePhrase(f: UniqueFacts, fmt: Fmt): string {
  if (!f.ellipse) return `with no 95 % ellipse to test against (${f.ellipseSuppressedReason ?? 'the core suppressed it'})`;
  const size = ellipseSize(f.ellipse, fmt);
  if (f.inside95 === null) return `with a 95 % ellipse of ${size}`;
  return f.inside95 ? `inside its 95 % ellipse (${size})` : `outside its own 95 % ellipse (${size})`;
}

/** The same, with the truth as the subject: "the truth is inside the 95 % ellipse (…)". */
function truthVsEllipse(f: UniqueFacts, fmt: Fmt): string {
  if (!f.ellipse) return `no 95 % ellipse was drawn (${f.ellipseSuppressedReason ?? 'the core suppressed it'})`;
  const size = ellipseSize(f.ellipse, fmt);
  if (f.inside95 === null) return `the 95 % ellipse is ${size}`;
  return `the truth is ${f.inside95 ? 'inside' : 'outside'} the 95 % ellipse (${size})`;
}

function direction(f: UniqueFacts): string {
  return compassWords(errorBearing(f));
}

/** "every residual is under 1.0 σ" / "the largest residual is 9.9 σ (obs-3)". */
function residualPhrase(f: UniqueFacts): string {
  const w = f.worst;
  if (!w) return 'there are no residuals to look at';
  const n = Math.abs(w.normalized);
  if (n <= 1.5) return `every residual is under ${Math.max(1, Math.ceil(n * 10) / 10).toFixed(1)} σ, about the size of the noise`;
  return `the largest residual is ${times(n)} σ (${w.id}, ${arcmin(w.residual_arcmin)})`;
}

/** The rate the scenario's stars turn at, degrees per hour (sidereal unless it says otherwise). */
function skyRate(scenario: Scenario): number {
  for (const s of scenario.sources) if (s.source === 'supplied') return s.gha_rate_deg_per_hour;
  return 15.04106864;
}

function stars(scenario: Scenario): string[] {
  return [...new Set(scenario.sources.map((s) => s.name))];
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function claimed(f: UniqueFacts, fmt: Fmt): string {
  return `${fmt.dist(f.sigmaRadialM)} (1 σ)`;
}

// ---------------------------------------------------------------------------------------
// Key numbers

/** The one number each story turns on. Generic for Simulator runs. */
export function keyNumber(story: StoryId | null, run: Pick<Run, 'variant' | 'scenario' | 'reduced'>, facts: Facts, fmt: Fmt): KeyNumber {
  if (facts.kind === 'failed') return { value: 'No answer', caption: `The solver failed: ${facts.reason}` };
  if (facts.kind === 'underdetermined') {
    return {
      value: `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(facts.radiusNm)} NM`,
      caption: `radius of the circle of position (${fmt.dist(facts.radiusM)}) — a circle, not a point`,
    };
  }
  if (facts.kind === 'ambiguous') {
    return {
      value: fmt.dist(facts.separationM),
      caption: `between ${facts.candidates.length} equally good answers — neither is preferred`,
    };
  }
  const f = facts;
  switch (story) {
    case 'good-geometry':
    case 'clustered-geometry':
      if (f.ellipse) {
        return {
          value: ellipseSize(f.ellipse, fmt),
          caption: `95 % ellipse (semi-axes), condition number ${conditionText(f.conditionNumber)}${
            story === 'clustered-geometry' ? ' — long and thin' : ' — nearly round'
          }`,
        };
      }
      break;
    case 'one-bad-sight':
      if (run.variant === 'robust') {
        return {
          value: fmt.dist(f.errorM),
          caption: `from the truth with robust weighting (${list(f.downweighted.map((id) => `${id} weight ${(f.weights[id] ?? 1).toFixed(2)}`)) || 'nothing downweighted'})`,
        };
      }
      if (f.worst) {
        return {
          value: fmt.dist(f.errorM),
          caption: `from the truth; ${f.worst.id}'s residual is ${arcmin(f.worst.residual_arcmin)} (${times(Math.abs(f.worst.normalized))} σ)`,
        };
      }
      break;
    case 'clock-offset':
      if (run.variant === 'clock-sigma' && f.ellipse) {
        return {
          value: fmt.dist(f.ellipse.semi_major_m),
          caption: `east–west half-axis of the 95 % ellipse; the fix did not move (still ${signedDeg(f.dLonDeg)} of longitude)`,
        };
      }
      return {
        value: signedDeg(f.dLonDeg),
        caption: `of longitude: ${fmt.dist(f.errorM)} ${direction(f)}, latitude change ${signedDeg(f.dLatDeg, 6)}, residuals ${arcmin(f.maxResidualArcmin)}`,
      };
    case 'shared-bias':
      if (run.variant === 'estimate-bias') {
        return {
          value: fmt.dist(f.errorM),
          caption: `from the truth, with a shared bias estimated at ${f.sharedBiasArcmin === null ? '—' : arcmin(f.sharedBiasArcmin)}`,
        };
      }
      return {
        value: fmt.dist(f.errorM),
        caption: `from the truth, while the fix claims ${claimed(f, fmt)}`,
      };
    case 'two-sight-ambiguous':
      return { value: fmt.dist(f.errorM), caption: `from the truth: three circles meet at one point` };
    case 'philadelphia-stars-sextant': {
      const total = totalCorrection(run);
      if (total) {
        return {
          value: total,
          caption: `taken off each raw reading before solving; the fix is then ${fmt.dist(f.errorM)} from the truth, ${insidePhrase(f, fmt)}`,
        };
      }
      break;
    }
    default:
      break;
  }
  return {
    value: fmt.dist(f.errorM),
    caption: `from the truth, ${insidePhrase(f, fmt)}`,
  };
}

// ---------------------------------------------------------------------------------------
// Explanations

/** "What happened" and "why", for a story run or (story = null) a Simulator run. */
export function explain(
  story: StoryId | null,
  run: Pick<Run, 'variant' | 'scenario' | 'truth' | 'reduced' | 'options' | 'session'>,
  facts: Facts,
  fmt: Fmt,
): Explanation {
  if (facts.kind === 'failed') {
    return {
      happened: [`The solver could not produce an answer: ${facts.reason}.`],
      why: ['A failure is reported as one, never dressed up as a position.'],
    };
  }
  if (facts.kind === 'underdetermined') return explainUnderdetermined(facts, fmt);
  if (facts.kind === 'ambiguous') return explainAmbiguous(facts, fmt, story);
  const f = facts;
  switch (story) {
    case 'philadelphia-stars':
      return {
        happened: [
          `The fix is ${fmt.dist(f.errorM)} from the truth, ${insidePhrase(f, fmt)}, and ${residualPhrase(f)}.`,
        ],
        why: [
          'Five stars spread round the compass give lines that cross at wide angles, and each sight’s error is small, random and independent of the others. ' +
            'That is exactly the situation the solver’s error model describes, so its ellipse can be taken at its word.',
        ],
      };
    case 'philadelphia-stars-real':
      return {
        happened: [
          `${list(stars(run.scenario))}, looked up in the built-in almanac for the simulated evening, give a fix ${fmt.dist(f.errorM)} from the truth, ${insidePhrase(f, fmt)}.`,
        ],
        why: [
          'The simulator placed the real stars where the almanac says they were, and the solver looked them up again on its own: agreement means the astronomy and the navigation agree. ' +
            'The distance differs from the invented-star run because its random noise is different (another seed), not because anything is wrong.',
        ],
      };
    case 'philadelphia-stars-sextant':
      return {
        happened: [
          `${correctionSummary(run)} After that the fix is ${fmt.dist(f.errorM)} from the truth, ${insidePhrase(f, fmt)}.`,
        ],
        why: [
          'A sextant measures the angle between a star and the horizon as the instrument and the eye see it. Each correction has a size and a sign, and applying one twice or with the wrong sign would move the fix by that much. ' +
            'Run fifty times, this scenario gives the same coverage and the same error as the corrected-altitude version.',
        ],
      };
    case 'good-geometry':
      return {
        happened: [
          `The ${f.residuals.length} lines cross at wide angles. The 95 % ellipse is ${f.ellipse ? ellipseSize(f.ellipse, fmt) : 'not drawn'} and the condition number is ${conditionText(f.conditionNumber)} (1 would be perfectly balanced). ` +
            `The fix is ${fmt.dist(f.errorM)} from the truth, ${f.inside95 === null ? 'with nothing to test it against' : f.inside95 ? 'inside the ellipse' : 'outside the ellipse'}.`,
        ],
        why: [
          'Stars in different directions pin the position down in different directions, so no direction is left loose. The clustered run uses the same stars, the same noise and the same random seed; only the directions change.',
        ],
      };
    case 'clustered-geometry': {
      const window = run.scenario.geometry.preset === 'clustered' ? run.scenario.geometry.window_deg : null;
      const warned = f.warnings.some((w) => w.code === 'poor_geometry');
      return {
        happened: [
          `Only the ${f.residuals.length} sights of stars inside one ${window === null ? 'narrow' : `${window}°`} patch of sky were used. The 95 % ellipse is ${f.ellipse ? ellipseSize(f.ellipse, fmt) : 'not drawn'}, long and thin, and the condition number is ${conditionText(f.conditionNumber)}${warned ? '; the solver warns that the geometry is poor' : ''}. ` +
            `The fix is ${fmt.dist(f.errorM)} from the truth, ${f.inside95 === null ? 'with nothing to test it against' : f.inside95 ? 'inside its ellipse' : 'outside its ellipse'}.`,
        ],
        why: [
          'Nearly parallel lines pin down how far along them you are, and say little about where you are across them. The ellipse says so: it is bigger and a different shape, rather than falsely confident.',
        ],
      };
    }
    case 'one-bad-sight':
      if (run.variant === 'robust') {
        const ids = f.downweighted;
        return {
          happened: [
            `With robust weighting on, ${ids.length ? list(ids.map((id) => `${id} was given ${(f.weights[id] ?? 1).toFixed(2)} of its normal weight`)) : 'no sight was downweighted'}, and the fix moved to ${fmt.dist(f.errorM)} from the truth, ${insidePhrase(f, fmt)}.`,
            'The report now calls the covariance approximate, because the weights are no longer the stated uncertainties.',
          ],
          why: [
            'Robust (Huber) weighting lets a sight that disagrees strongly with the rest pull less. It is a judgement about the data, so the tool says it made one.',
          ],
        };
      }
      return {
        happened: [
          `The fix is ${fmt.dist(f.errorM)} from the truth, ${insidePhrase(f, fmt)}. ${f.worst ? `One residual stands out: ${f.worst.id} (${f.worst.body}) is off by ${arcmin(f.worst.residual_arcmin)}, ${times(Math.abs(f.worst.normalized))} times its stated uncertainty` : ''}${
            f.worst ? `; the others are inflated too, up to ${arcmin(secondLargest(f))}.` : ''
          }`,
        ],
        why: [
          `${wrongSightSentence(run.truth)} Least squares does not reject a sight: it splits the difference, so the fix is dragged towards the bad line and every residual grows. ` +
            'One residual far larger than the rest points at a bad sight rather than a bad position.',
        ],
      };
    case 'clock-offset': {
      const offset = run.truth.clock_offset_s;
      if (run.variant === 'clock-sigma') {
        return {
          happened: [
            `Told the clock may be off by ${run.options.clock_uncertainty_s} seconds, the solver left the fix where it was (${signedDeg(f.dLonDeg)} of longitude from the truth) and stretched the 95 % ellipse to ${f.ellipse ? ellipseSize(f.ellipse, fmt) : '—'}, long east–west. ` +
              `The truth is now ${f.inside95 === null ? 'untested' : f.inside95 ? 'inside it' : 'still outside it'}.`,
          ],
          why: [
            'Clock error and longitude are the same unknown for star sights, so the solver cannot estimate one from the other. Declaring what you know about the clock is the honest response: the uncertainty grows along exactly the direction a clock error pushes.',
          ],
        };
      }
      const rate = skyRate(run.scenario);
      const shift = Math.abs((rate * offset) / 3600);
      return {
        happened: [
          `The fix is ${fmt.dist(f.errorM)} ${direction(f)} of the truth: ${signedDeg(f.dLonDeg)} of longitude, with latitude unchanged (${signedDeg(f.dLatDeg, 6)}). ` +
            `Every residual is zero (largest ${arcmin(f.maxResidualArcmin)}), and ${truthVsEllipse(f, fmt)}.`,
        ],
        why: [
          `The watch was ${Math.abs(offset)} seconds ${offset >= 0 ? 'fast' : 'slow'}. The sky turns ${rate.toFixed(2)}° an hour, so every star's tabulated position was ${shift.toFixed(4)}° too far ${offset >= 0 ? 'west' : 'east'}, and the only place that fits all the sights is that much further ${offset >= 0 ? 'west' : 'east'} in longitude. ` +
            'The sights agree with each other perfectly, so nothing in the data looks wrong.',
        ],
      };
    }
    case 'shared-bias': {
      const bias = run.truth.shared_altitude_bias_arcmin;
      if (run.variant === 'estimate-bias') {
        return {
          happened: [
            `Asked to estimate one bias shared by every sight, the solver found ${f.sharedBiasArcmin === null ? '—' : arcmin(f.sharedBiasArcmin)} (the answer key says ${arcmin(bias, 1)} was added), and the fix moved to ${fmt.dist(f.errorM)} from the truth, ${insidePhrase(f, fmt)}.`,
            ...(f.sharedBiasArcmin === null
              ? []
              : [
                  `The lines are drawn from the sights as measured, so the fix now sits about ${arcmin(Math.abs(f.sharedBiasArcmin)).replace('+', '')} (${fmt.dist((Math.abs(f.sharedBiasArcmin) * 1852))}) short of every one of them: that is the bias the solver took off each sight.`,
                ]),
          ],
          why: [
            `A bias can only be told apart from position when the stars are spread widely enough. Here every star lies within ${(360 - f.maxAzimuthGapDeg).toFixed(0)}° of bearing of the others, so the geometry is weak (condition number ${conditionText(f.conditionNumber)}) and the ellipse grows — honestly.`,
          ],
        };
      }
      return {
        happened: [
          `The fix is ${fmt.dist(f.errorM)} from the truth but claims ${claimed(f, fmt)}, because every sight shares the same bias — the model assumes independent errors. ` +
            `The error is ${times(f.ratio)} times the stated uncertainty, and ${truthVsEllipse(f, fmt)}.`,
          residualHint(f, run.session),
        ],
        why: [
          `The instrument read ${arcmin(bias, 1)} high on all ${f.residuals.length} sights. Many sights average random noise away, which is why the ellipse is small; an error that is the same on every sight does not average away. ` +
            'It moves the position instead of showing in the residuals, so more sights make the ellipse smaller and the answer no better.',
        ],
      };
    }
    case 'two-sight-ambiguous':
      return {
        happened: [
          `With a third star the circles meet at one point: a unique fix ${fmt.dist(f.errorM)} from the truth, ${insidePhrase(f, fmt)}.`,
        ],
        why: ['The third circle passes through only one of the two crossings, so the ambiguity goes away without any outside knowledge.'],
      };
    default:
      return explainGenericUnique(f, run, fmt);
  }
}

/** The largest residual (signed, arcminutes) apart from the worst one. */
/**
 * What the residuals of a shared-error run do and do not say: small in arcminutes, so
 * nothing points at the cause; compared with the uncertainty each sight claims, possibly
 * too big as a whole (chi-square), which is a hint and no more.
 */
function residualHint(f: UniqueFacts, session: Pick<Run['session'], 'observations'>): string {
  const sigma = session.observations[0]?.sigma_arcmin;
  const lead = `No residual is bigger than ${arcmin(f.maxResidualArcmin).replace('+', '')}, the scatter of an ordinary sextant, and none points at the bias.`;
  if (f.dof <= 0 || sigma === undefined) return lead;
  if (f.chi2 > 2 * f.dof) {
    return (
      `${lead} Against the ${arcmin(sigma, 1).replace('+', '')} each sight claims they are too big as a whole (χ² ${f.chi2.toFixed(1)} where about ${f.dof} is expected): ` +
      'a hint that something is wrong, but not what, nor which way.'
    );
  }
  return `${lead} Even against the ${arcmin(sigma, 1).replace('+', '')} each sight claims they look like ordinary noise (χ² ${f.chi2.toFixed(1)} on ${f.dof} degrees of freedom).`;
}

function secondLargest(f: UniqueFacts): number {
  const others = f.residuals.filter((r) => r.id !== f.worst?.id).map((r) => r.residual_arcmin);
  return others.length ? others.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)) : 0;
}

function wrongSightSentence(truth: Truth): string {
  const ids = truth.wrong_sight_ids;
  if (!ids.length) return 'No sight was deliberately wrong in this run.';
  return `The answer key says ${list(ids)} ${ids.length === 1 ? 'was' : 'were'} deliberately misread.`;
}

/** The whole correction (observed minus raw), smallest to largest: "−4.55′ to −5.92′". */
export function totalCorrection(run: Pick<Run, 'reduced'>): string | null {
  const totals = (run.reduced ?? []).flatMap((e) => (e.status === 'ok' ? [(e.sight.corrections.ho_deg - e.sight.corrections.input_deg) * 60] : []));
  if (!totals.length) return null;
  const lo = Math.min(...totals);
  const hi = Math.max(...totals);
  // Smaller correction first, by size.
  const [a, b] = Math.abs(lo) <= Math.abs(hi) ? [lo, hi] : [hi, lo];
  return Math.abs(hi - lo) < 0.005 ? arcmin(lo) : `${arcmin(a)} to ${arcmin(b)}`;
}

/** The correction chain of a raw-reading session, in one or two sentences. */
export function correctionSummary(run: Pick<Run, 'reduced'>): string {
  const sights = (run.reduced ?? []).flatMap((e) => (e.status === 'ok' ? [e.sight] : []));
  if (!sights.length) return 'The readings were corrected before solving.';
  const range = (kind: string): [number, number] | null => {
    const values = sights.flatMap((s) => s.corrections.steps.filter((st) => st.kind === kind && st.applied).map((st) => st.delta_arcmin));
    if (!values.length) return null;
    return [Math.min(...values), Math.max(...values)];
  };
  const one = (r: [number, number] | null, what: string): string | null => {
    if (!r) return null;
    const [lo, hi] = r;
    // Smaller correction first, by size, as the key number is written.
    const [a, b] = Math.abs(lo) <= Math.abs(hi) ? [lo, hi] : [hi, lo];
    return Math.abs(hi - lo) < 0.005 ? `${what} ${arcmin(lo)}` : `${what} ${arcmin(a)} to ${arcmin(b)}`;
  };
  const parts = [one(range('index_correction'), 'index correction'), one(range('dip'), 'dip'), one(range('refraction'), 'refraction')].filter(
    (x): x is string => x !== null,
  );
  return `Before solving, the tool undid the instrument and the air on each of the ${sights.length} readings: ${list(parts)}.`;
}

function explainUnderdetermined(f: Extract<Facts, { kind: 'underdetermined' }>, fmt: Fmt): Explanation {
  const c = f.circles[0];
  return {
    happened: [
      `No position. ${f.circles.length === 1 ? 'One sight' : `These ${f.circles.length} sights`} put the observer somewhere on a circle of radius ${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(f.radiusNm)} NM (${fmt.dist(f.radiusM)})` +
        `${c ? ` around the point where ${c.body} is straight overhead (${fmt.pos(c.gp)})` : ''}, and nowhere in particular on it. ` +
        `The answer key lies on that circle (${fmt.dist(f.truthOffCircleM)} from it).`,
    ],
    why: [
      'The height of a star says how far you are from the point where it is overhead, not in which direction. A tool that printed a latitude and longitude here would be inventing precision the measurement does not contain.',
    ],
  };
}

function explainAmbiguous(f: Extract<Facts, { kind: 'ambiguous' }>, fmt: Fmt, story: StoryId | null): Explanation {
  const where = f.candidates.map((c, i) => `${candidateLetter(i)} at ${fmt.pos(c)}`);
  return {
    happened: [
      `Two answers, neither preferred. The circles cross at ${list(where)}, ${fmt.dist(f.separationM)} apart, and both fit the sights ${story === 'two-sight-ambiguous' ? 'exactly' : 'equally well'}. ` +
        `The answer key is candidate ${candidateLetter(f.nearestIndex)} (${fmt.dist(f.nearestM)} away); the sights alone cannot say that.`,
    ],
    why: [
      'Two circles on a sphere cross twice. A navigator chooses between the crossings with outside knowledge, such as a dead-reckoning position, and this tool would use that only if you declared it as a prior. A third star in another direction settles it by itself.',
    ],
  };
}

function explainGenericUnique(f: UniqueFacts, run: Pick<Run, 'truth'>, fmt: Fmt): Explanation {
  const correlated = run.truth.shared_altitude_bias_arcmin !== 0 || run.truth.clock_offset_s !== 0;
  const happened = [
    `The fix is ${fmt.dist(f.errorM)} ${direction(f)} of the truth and claims ${claimed(f, fmt)}: the error is ${times(f.ratio)} times the stated uncertainty. ` +
      `${capitalise(truthVsEllipse(f, fmt))}, and ${residualPhrase(f)}.`,
  ];
  const why: string[] = [];
  if (correlated) {
    const shared = `${run.truth.clock_offset_s ? `a clock ${run.truth.clock_offset_s} s off` : ''}${run.truth.clock_offset_s && run.truth.shared_altitude_bias_arcmin ? ' and ' : ''}${run.truth.shared_altitude_bias_arcmin ? `an altitude bias of ${arcmin(run.truth.shared_altitude_bias_arcmin, 1)}` : ''}`;
    why.push(
      f.inside95 && run.truth.shared_altitude_bias_arcmin && !run.truth.clock_offset_s
        ? `The answer key shows an error shared by every sight (${shared}), yet the truth is inside the ellipse this time: with bodies spread round the sky, a shared altitude bias shows up in the residuals more than in the position. ` +
            'The ellipse’s 95 % promise still does not cover shared errors; the coverage experiment shows how often it holds.'
        : `The answer key shows an error shared by every sight (${shared}). ` +
            'The ellipse assumes independent errors, so it cannot describe one that every sight shares.',
    );
  } else if (run.truth.wrong_sight_ids.length) {
    why.push(`${wrongSightSentence(run.truth)} Least squares splits the difference instead of rejecting it.`);
  } else {
    why.push('Only independent random noise was added, which is what the ellipse describes: across many runs the truth should fall inside it about 95 times in 100.');
  }
  return { happened, why };
}
