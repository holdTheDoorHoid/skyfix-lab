/**
 * A sight's correction workings: every step of CONVENTIONS section 5 in the core's order,
 * applied or not, with plain words first and the navigator's term beside them, the
 * altitude before and after, the change in arcminutes, and the core's own note. A step
 * that did not run is still a row with its reason: silence about a correction is how
 * corrections get applied twice (the old Corrections view's rule). OWNER: navigate agent.
 */

import { h } from '../../dom.js';
import type { CorrectionBreakdown, CorrectionKind, LoggedValue, ReducedSight } from '../../types.js';
import { CORRECTION_ORDER } from '../../types.js';
import type { SightCorrectionBreakdown } from '../engine/types.js';
import type { AngleFormat } from '../state.js';
import { isoUtc } from '../time.js';
import { fmtAngle, fmtArcmin, fmtBearing, fmtNm, fmtSigma, utcInputText } from './format.js';
import { KIND_TEXT, LOG_METHOD_TEXT, STEP_TEXT } from './text.js';
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
  if (caption) table.appendChild(h('caption', { class: 'sf-sr' }, caption));
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

/**
 * A value the core read from an error log, in words (navigate2, expansion programme):
 * `−1.50′, interpolated between 00:00 (−1.00′) and 02:00 (−2.00′)`, with how far outside
 * the log a held value was.
 */
export function loggedValueText(v: LoggedValue, unit: '′' | 's'): string {
  const fmt = (x: number): string => (unit === '′' ? fmtArcmin(x, 2) : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)} s`);
  const at = (p: { utc: string; value: number }): string => `${utcInputText(p.utc)} UTC (${fmt(p.value)})`;
  const how =
    v.method === 'interpolated' && v.from && v.to
      ? `interpolated between ${at(v.from)} and ${at(v.to)}`
      : v.method === 'at_entry' && v.from
        ? `the entry at ${at(v.from)}`
        : v.method === 'only_entry'
          ? 'the log’s only entry'
          : v.method === 'held_before_first' && (v.from ?? v.to)
            ? `the first entry, ${at((v.from ?? v.to)!)}, held: the sight is ${v.hours_outside.toFixed(1)} h before the log starts (not extrapolated)`
            : v.method === 'held_after_last' && (v.from ?? v.to)
              ? `the last entry, ${at((v.from ?? v.to)!)}, held: the sight is ${v.hours_outside.toFixed(1)} h after the log ends (not extrapolated)`
              : LOG_METHOD_TEXT[v.method];
  return `${fmt(v.value)}, ${how}`;
}

/** The full workings of one reduced sight: direction, the steps, the intercept, warnings. */
export function sightWorkings(sight: ReducedSight, format: AngleFormat): HTMLElement {
  const warnings = [...sight.warnings, ...sight.corrections.warnings];
  return h(
    'div',
    { class: 'sfn-sight__workings' },
    workingsTable(sight.corrections, format, `Correction workings for ${sight.id}`),
    facts([
      // navigate2: the values the core took from the session's error logs.
      sight.index_correction_from_log ? ['Index correction from the log', loggedValueText(sight.index_correction_from_log, '′')] : null,
      sight.clock_correction_from_log ? ['Watch correction from the log', `${loggedValueText(sight.clock_correction_from_log, 's')}; the sight’s time became ${utcInputText(isoUtc(sight.jd_utc))} UTC`] : null,
      [
        'Body direction',
        `GHA ${fmtAngle(sight.gha_deg, format)}, declination ${fmtAngle(sight.dec_deg, format)} (from ${sight.direction_source === 'supplied' ? 'the values in this sight' : sight.direction_source})`,
      ],
      sight.hc_deg !== null && sight.zn_deg !== null && sight.intercept_nm !== null
        ? [
            'At the assumed position',
            `computed Hc ${fmtAngle(sight.hc_deg, format)}, bearing Zn ${fmtBearing(sight.zn_deg)}, intercept ${fmtNm(Math.abs(sight.intercept_nm), 1)} ${sight.intercept_nm >= 0 ? 'toward' : 'away from'} the body` +
              // CONVENTIONS 15.4: the Moon's Hc carries the part of its parallax the
              // spherical Earth leaves out (the real Earth's flattening).
              (typeof sight.earth_shape_arcmin === 'number'
                ? `; Hc includes ${fmtArcmin(sight.earth_shape_arcmin, 2)} for the Earth's shape (the flattening's effect on the Moon's parallax)`
                : ''),
          ]
        : ['At the assumed position', 'no assumed position, so no intercept'],
    ]),
    warnings.length ? warningList(warnings) : null,
  );
}
