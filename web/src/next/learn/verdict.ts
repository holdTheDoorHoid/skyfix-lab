/**
 * What a coverage experiment says, in one paragraph. OWNER: learn agent.
 *
 * A port of `verdict` in crates/skyfix-cli/src/commands/experiment.rs, with the same
 * thresholds, so the browser and the command line never disagree about a run:
 *
 * - healthy only when coverage is 0.85-1.00 AND the error-to-sigma ratio is inside the
 *   two-sided band 0.6-1.6 (docs/SIMULATOR.md section 6: under a correct model the ratio
 *   is about 1; an ellipse ten times too large fails to describe the error as surely as
 *   one half the size);
 * - a scenario with a shared bias or a clock offset is MEANT to fail, and says so;
 * - nothing scored (every run ambiguous or underdetermined) is not a verdict at all.
 */

import type { Aggregate, ExperimentSummary, Scenario } from '../../api/adapter.js';

export const RATIO_BAND: readonly [number, number] = [0.6, 1.6];
export const COVERAGE_BAND: readonly [number, number] = [0.85, 1.0];
/** Stars turn at the sidereal rate (docs/SIMULATOR.md section 2). */
export const SIDEREAL_DEG_PER_HOUR = 15.04106864;

export type VerdictTone = 'healthy' | 'disagrees' | 'meant-to-fail' | 'nothing-scored';

export interface Verdict {
  tone: VerdictTone;
  /** Short heading for the verdict chip. */
  title: string;
  text: string;
}

/** `experiment::clock_longitude_shift_deg`: a fast clock moves the fix west. */
export function clockLongitudeShiftDeg(clockOffsetS: number, rateDegPerHour = SIDEREAL_DEG_PER_HOUR): number {
  return (-rateDegPerHour * clockOffsetS) / 3600;
}

function clockShiftSentence(scenario: Scenario): string {
  const dt = scenario.clock_offset_s;
  if (dt === 0 || scenario.shared_altitude_bias_arcmin !== 0) return '';
  const shift = clockLongitudeShiftDeg(dt);
  const signed = `${shift >= 0 ? '+' : '−'}${Math.abs(shift).toFixed(6)}`;
  return (
    ` In longitude that is ${signed} degrees, and the latitude has not moved: the small north component of the mean ` +
    'error is the great-circle decomposition of a shift along a parallel, not a change of latitude.'
  );
}

export function experimentVerdict(a: Aggregate, scenario: Scenario): Verdict {
  const correlated = scenario.shared_altitude_bias_arcmin !== 0 || scenario.clock_offset_s !== 0;
  const ratio = a.error_to_sigma_ratio;
  if (a.evaluated === 0) {
    return {
      tone: 'nothing-scored',
      title: 'Nothing to score',
      text:
        'Nothing was scored, so there is no statement to make about the uncertainty model. The result kinds say why: an ambiguous or ' +
        'underdetermined answer is a correct answer to an under-constrained question, not a failure of the solver.',
    };
  }
  if (correlated) {
    return {
      tone: 'meant-to-fail',
      title: 'Meant to fail',
      text:
        'This scenario adds an error that is the same on every sight, which the independent-noise model behind the ellipse cannot ' +
        'represent, so it is meant to fail this test; a coverage near 95 % here would mean the test was not measuring anything. ' +
        `The error is about ${ratio === null ? '—' : ratio.toFixed(0)} times the predicted sigma, and the mean signed error shows the direction it pushes. ` +
        `More sights would shrink the ellipse and not the error.${clockShiftSentence(scenario)}`,
    };
  }
  const p = a.coverage_fraction;
  if (p !== null && ratio !== null) {
    if (p >= COVERAGE_BAND[0] && p <= COVERAGE_BAND[1] && ratio >= RATIO_BAND[0] && ratio <= RATIO_BAND[1]) {
      return {
        tone: 'healthy',
        title: 'Honest',
        text:
          `Coverage ${p.toFixed(2)} and an error-to-sigma ratio of ${ratio.toFixed(2)} are what an honest independent-noise model looks like: ` +
          'the ellipse is about the right size, and the errors scatter the way it predicts.',
      };
    }
    const direction =
      ratio < RATIO_BAND[0]
        ? ' The predicted uncertainty is too large relative to the observed error: the ellipse covers the truth, but it claims less than the sights can support.'
        : ratio > RATIO_BAND[1]
          ? ' The predicted uncertainty is too small relative to the observed error: the ellipse is narrower than the errors actually seen.'
          : '';
    return {
      tone: 'disagrees',
      title: 'Does not agree',
      text:
        `Coverage ${p.toFixed(2)} with an error-to-sigma ratio of ${ratio.toFixed(2)}: the reported uncertainty and the errors actually seen do not agree, ` +
        `so read the scenario's description for what is moving the fix before trusting the ellipse.${direction}`,
    };
  }
  return {
    tone: 'disagrees',
    title: 'Too few runs',
    text: 'Not enough scored repetitions to say whether the uncertainty describes the error.',
  };
}

/** A hundred repetitions of the same note is noise: say it once, with a count (as the CLI does). */
export function dedupeNotes(summary: Pick<ExperimentSummary, 'notes'>): { text: string; count: number }[] {
  const seen: { text: string; count: number }[] = [];
  for (const note of summary.notes) {
    const m = /^repetition \d+: (.*)$/s.exec(note);
    const text = m ? m[1]! : note;
    const hit = seen.find((s) => s.text === text);
    if (hit) hit.count += 1;
    else seen.push({ text, count: 1 });
  }
  return seen;
}
