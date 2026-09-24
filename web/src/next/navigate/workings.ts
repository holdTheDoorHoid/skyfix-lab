/**
 * A sight's correction workings: every step of CONVENTIONS section 5 in the core's order,
 * applied or not, with plain words first and the navigator's term beside them, the
 * altitude before and after, the change in arcminutes, and the core's own note. A step
 * that did not run is still a row with its reason: silence about a correction is how
 * corrections get applied twice (the old Corrections view's rule). OWNER: navigate agent.
 */

import { h } from '../../dom.js';
import type { CorrectionBreakdown, CorrectionKind, ReducedSight } from '../../types.js';
import { CORRECTION_ORDER } from '../../types.js';
import type { SightCorrectionBreakdown } from '../engine/types.js';
import type { AngleFormat } from '../state.js';
import { fmtAngle, fmtArcmin, fmtBearing, fmtNm, fmtSigma } from './format.js';
import { KIND_TEXT, STEP_TEXT } from './text.js';
import { facts, warningList } from './ui.js';

/** The core's "not applicable: …" prefix is already said by the row's tag. */
export function skippedReason(note: string): string {
  return note.replace(/^not (applicable|applied)\s*:\s*/i, '');
}

export function workingsTable(breakdown: CorrectionBreakdown | SightCorrectionBreakdown, format: AngleFormat, caption?: string): HTMLElement {
  const byKind = new Map<CorrectionKind, CorrectionBreakdown['steps'][number]>(
    (breakdown.steps as CorrectionBreakdown['steps']).map((s) => [s.kind, s]),
  );
  const table = h('table', { class: 'sfn-workings' });
  if (caption) table.appendChild(h('caption', { class: 'sfn-sr' }, caption));
  table.appendChild(
    h(
      'thead',
      {},
      h('tr', {}, h('th', { scope: 'col' }, 'Step'), h('th', { scope: 'col', class: 'sfn-num' }, 'Change'), h('th', { scope: 'col', class: 'sfn-num' }, 'Altitude after')),
    ),
  );
  const body = h('tbody', {});
  const kind = KIND_TEXT[breakdown.input_kind];
  body.appendChild(
    h(
      'tr',
      { class: 'sfn-workings__start' },
      h('th', { scope: 'row' }, `${kind.plain} `, h('span', { class: 'sfn-term' }, `· ${kind.term}`)),
      h('td', { class: 'sfn-num' }, ''),
      h('td', { class: 'sfn-num' }, fmtAngle(breakdown.input_deg, format)),
    ),
  );
  for (const k of CORRECTION_ORDER) {
    const step = byKind.get(k);
    const text = STEP_TEXT[k];
    const name = h('span', {}, text.plain, ' ', h('span', { class: 'sfn-term' }, `· ${text.term}`));
    if (!step) {
      body.appendChild(h('tr', { class: 'sfn-workings__skip' }, h('th', { scope: 'row' }, name, h('span', { class: 'sfn-workings__note' }, 'not reported by the core')), h('td', { class: 'sfn-num' }, '—'), h('td', {})));
      continue;
    }
    if (!step.applied) {
      body.appendChild(
        h(
          'tr',
          { class: 'sfn-workings__skip' },
          h('th', { scope: 'row' }, name, h('span', { class: 'sfn-workings__note' }, `Not applied: ${skippedReason(step.note)}`)),
          h('td', { class: 'sfn-num' }, '—'),
          h('td', { class: 'sfn-num sfn-muted' }, ''),
        ),
      );
      continue;
    }
    body.appendChild(
      h(
        'tr',
        {},
        h('th', { scope: 'row' }, name, h('span', { class: 'sfn-workings__note' }, step.note)),
        h('td', { class: 'sfn-num sfn-workings__delta' }, fmtArcmin(step.delta_arcmin, 1)),
        h('td', { class: 'sfn-num' }, fmtAngle(step.after_deg, format)),
      ),
    );
  }
  body.appendChild(
    h(
      'tr',
      { class: 'sfn-workings__end' },
      h('th', { scope: 'row' }, 'Observed altitude ', h('span', { class: 'sfn-term' }, '· Ho'), h('span', { class: 'sfn-workings__note' }, `Uncertainty ${fmtSigma(breakdown.sigma_ho_arcmin)} (1 sigma)`)),
      h('td', { class: 'sfn-num' }, fmtArcmin((breakdown.ho_deg - breakdown.input_deg) * 60, 1)),
      h('td', { class: 'sfn-num' }, h('strong', {}, fmtAngle(breakdown.ho_deg, format))),
    ),
  );
  table.appendChild(body);
  return h('div', { class: 'sfn-table-scroll' }, table);
}

/** The full workings of one reduced sight: direction, the steps, the intercept, warnings. */
export function sightWorkings(sight: ReducedSight, format: AngleFormat): HTMLElement {
  const warnings = [...sight.warnings, ...sight.corrections.warnings];
  return h(
    'div',
    { class: 'sfn-sight__workings' },
    workingsTable(sight.corrections, format, `Correction workings for ${sight.id}`),
    facts([
      [
        'Body direction',
        `GHA ${fmtAngle(sight.gha_deg, format)}, declination ${fmtAngle(sight.dec_deg, format)} (from ${sight.direction_source === 'supplied' ? 'the values in this sight' : sight.direction_source})`,
      ],
      sight.hc_deg !== null && sight.zn_deg !== null && sight.intercept_nm !== null
        ? [
            'At the assumed position',
            `computed Hc ${fmtAngle(sight.hc_deg, format)}, bearing Zn ${fmtBearing(sight.zn_deg)}, intercept ${fmtNm(Math.abs(sight.intercept_nm), 1)} ${sight.intercept_nm >= 0 ? 'toward' : 'away from'} the body`,
          ]
        : ['At the assumed position', 'no assumed position, so no intercept'],
    ]),
    warnings.length ? warningList(warnings) : null,
  );
}
