/**
 * The words that go under a residual heat map. OWNER: misfit agent.
 *
 * Short and honest: what the shading means, what the line means and under which model,
 * and the one thing the picture cannot show (a shared error moves it without widening it).
 * The situations that change that sentence (a shared bias estimated, robust weights, the
 * best point off the view) add a sentence each; the grid's own `notes` carry the detail.
 */

import type { MisfitGrid, MisfitLevelName } from '../engine/types.js';
import { DEFAULT_LEVELS } from './grid.js';

/** The caption for the default drawing (the 95 % line inside the 3-sigma line). */
export const MISFIT_CAPTION =
  'Darker = worse fit. The inner line is where the fit is within the 95 % level of the best point, ' +
  'under the independent-noise model; shared errors (a biased sextant, a wrong clock) move the whole ' +
  'picture without widening it.';

export interface CaptionOptions {
  /** The levels drawn as lines (default the 95 % and 3-sigma lines). */
  levels?: readonly MisfitLevelName[];
}

/**
 * The caption for `grid` drawn with `levels`. With no grid, the default caption. The line
 * that the 95 % level is called depends on what else is drawn: "the inner line" beside the
 * 3-sigma line only, "the solid line" when the 1-sigma line is drawn too, "the line" alone.
 */
export function misfitCaption(
  grid?: Pick<MisfitGrid, 'bias_profiled' | 'weighted' | 'min'> | null,
  options: CaptionOptions = {},
): string {
  const levels = options.levels ?? DEFAULT_LEVELS;
  const which = levels.includes('one_sigma')
    ? 'The solid line (dotted: 68 %, dashed: 99.7 %)'
    : levels.includes('three_sigma')
      ? 'The inner line'
      : 'The line';
  const parts: string[] = [];
  if (grid?.bias_profiled) {
    parts.push(
      `Darker = worse fit, judging every point with the sextant bias that suits it best. ${which} is where ` +
        'the fit is within the 95 % level of the best point for position and bias together, under the ' +
        'independent-noise model; a wrong clock still moves the whole picture without widening it.',
    );
  } else {
    parts.push(
      `Darker = worse fit. ${which} is where the fit is within the 95 % level of the best point, under the ` +
        'independent-noise model; shared errors (a biased sextant, a wrong clock) move the whole picture ' +
        'without widening it.',
    );
  }
  if (grid?.weighted) {
    parts.push("Suspect sights count less, as in the solver's robust fix, so far from the fix the picture is approximate.");
  }
  if (grid && !grid.min.inside_grid) parts.push('The best point is outside this view.');
  return parts.join(' ');
}
