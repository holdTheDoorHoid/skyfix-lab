/**
 * How a fix is reported (the Fix and the Running fix methods): the result kind in words
 * and shape, the position, its uncertainty with the nominal 95 % ellipse or the reason
 * there is none, the rejected alternatives, the residuals of every sight, the geometry's
 * conditioning, and the warnings. The four result kinds keep their meaning (CONVENTIONS
 * section 8): a unique fix, an ambiguous set of candidates (none promoted), an
 * underdetermined circle, or a failure. OWNER: navigate agent.
 */

import { h, s } from '../../dom.js';
import type { Conditioning, Fix, FixResult, Residual } from '../../types.js';
import type { AngleFormat } from '../state.js';
import {
  fmtAngle,
  fmtArcmin,
  fmtBearing,
  fmtMagnitude,
  fmtMetres,
  fmtMetresNm,
  fmtNm,
  fmtNum,
  fmtPosition,
} from './format.js';
import { ELLIPSE_MODEL, RESULT_KIND_TEXT } from './text.js';
import { facts, para, warningList } from './ui.js';

const KIND_MARK: Record<FixResult['kind'], string> = {
  unique: 'M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2Z',
  ambiguous: 'M4.5 3.5 8 7 4.5 10.5 1 7Z M11.5 5.5 15 9 11.5 12.5 8 9Z',
  underdetermined: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z',
  failed: 'M3 3l10 10M13 3 3 13',
};

/** The result kind, as a heading with a shape: meaning never rests on colour. */
export function resultKind(kind: FixResult['kind']): HTMLElement {
  const svg = s('svg', { viewBox: '0 0 16 16', class: 'sfn-kind__mark', 'aria-hidden': 'true' });
  svg.appendChild(s('path', { d: KIND_MARK[kind] }));
  return h('p', { class: `sfn-kind sfn-kind--${kind}` }, svg, h('span', {}, RESULT_KIND_TEXT[kind].label));
}

function uniqueFacts(fix: Fix, format: AngleFormat): HTMLElement {
  const e = fix.ellipse95;
  return facts([
    ['Position', h('strong', { class: 'sfn-num' }, fmtPosition(fix.position, format))],
    ['Position, decimal', h('span', { class: 'sfn-num' }, `${fix.position.lat_deg.toFixed(5)}, ${fix.position.lon_deg.toFixed(5)} (east-positive)`)],
    ['North uncertainty', `${fmtMetresNm(fix.sigma_north_m)}, 1 sigma`],
    ['East uncertainty', `${fmtMetresNm(fix.sigma_east_m)}, 1 sigma`],
    fix.clock_sigma_east_m > 0 ? ['Of which the clock', `${fmtMetres(fix.clock_sigma_east_m)} east-west, from the stated time uncertainty`] : null,
    [
      '95 % ellipse',
      e
        ? h('span', {}, `${fmtMetres(e.semi_major_m)} × ${fmtMetres(e.semi_minor_m)}, long axis ${fmtBearing(e.orientation_deg)} — `, h('strong', {}, e.model || ELLIPSE_MODEL))
        : h('span', { class: 'sfn-muted' }, `not drawn: ${fix.ellipse_suppressed_reason ?? 'suppressed'}`),
    ],
    ['Fit', `chi-square ${fmtNum(fix.chi2, 2)} with ${fix.dof} degree${fix.dof === 1 ? '' : 's'} of freedom`],
    ['Solver', `${fix.iterations} iteration${fix.iterations === 1 ? '' : 's'}${fix.converged ? ', converged' : ' — did NOT converge: treat the position as provisional'}`],
    fix.shared_bias_arcmin !== null ? ['Shared altitude bias', `${fmtArcmin(fix.shared_bias_arcmin, 2)} on every sight (estimated)`] : null,
    fix.prior
      ? [
          'Prior',
          `${fix.prior.sigma_nm} NM at ${fmtPosition(fix.prior.center, format)}; it moved the fix ${fmtMetres(fix.prior.shift_m)}` +
            (fix.prior.fix_without_prior ? ` (without it: ${fmtPosition(fix.prior.fix_without_prior, format)})` : ''),
        ]
      : null,
    fix.robust ? ['Robust weighting', `${fix.robust.note} Downweighted: ${fix.robust.downweighted_ids.join(', ') || 'none'}.`] : null,
    fix.posterior_scaled
      ? [
          'Residual-scaled',
          `scale factor s² = ${fmtNum(fix.posterior_scaled.scale_factor_s2, 2)}` +
            (fix.posterior_scaled.ellipse95 ? `; scaled 95 % ellipse ${fmtMetres(fix.posterior_scaled.ellipse95.semi_major_m)} × ${fmtMetres(fix.posterior_scaled.ellipse95.semi_minor_m)}` : ''),
        ]
      : null,
  ]);
}

/** The whole summary for any result kind. */
export function fixSummary(result: FixResult, format: AngleFormat): HTMLElement {
  const out = h('div', { class: 'sfn-result' }, resultKind(result.kind));
  switch (result.kind) {
    case 'unique':
      out.append(uniqueFacts(result.fix, format));
      if (result.alternatives.length) {
        out.append(
          para(
            `${result.alternatives.length} other minimum${result.alternatives.length === 1 ? ' was' : 'a were'} found and rejected: ` +
              result.alternatives.map((a) => `${fmtPosition(a.position, format)} (chi-square ${fmtNum(a.delta_chi2_from_best, 1)} worse)`).join('; ') +
              '.',
          ),
        );
      }
      break;
    case 'ambiguous':
      out.append(
        para(RESULT_KIND_TEXT.ambiguous.sentence, 'sfn-plain'),
        h(
          'ol',
          { class: 'sfn-candidates' },
          ...result.candidates.map((c, i) =>
            h(
              'li',
              {},
              h('strong', {}, `Candidate ${String.fromCharCode(65 + i)}: `),
              h('span', { class: 'sfn-num' }, fmtPosition(c.position, format)),
              h('span', { class: 'sfn-muted' }, ` — chi-square ${fmtNum(c.chi2, 2)} (${fmtNum(c.delta_chi2_from_best, 2)} from the best)`),
            ),
          ),
        ),
      );
      break;
    case 'underdetermined':
      out.append(para(RESULT_KIND_TEXT.underdetermined.sentence, 'sfn-plain'), para(result.reason));
      break;
    case 'failed':
      out.append(para(result.reason, 'sfn-plain'));
      break;
  }
  return out;
}

/** Residuals: observed minus computed at the fix, each against its own ±1 sigma band. */
export function residualChart(residuals: readonly Residual[], sigmas: ReadonlyMap<string, number>): SVGSVGElement {
  const row = 28;
  const labelW = 150;
  const chartW = 420;
  const height = Math.max(residuals.length * row + 30, 70);
  const width = labelW + chartW + 16;
  const svg = s('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'sfn-residuals',
    role: 'img',
    'aria-label': `Residuals of ${residuals.length} sights, arcminutes, each against its own one-sigma band.`,
  }) as SVGSVGElement;
  const maxAbs = Math.max(1, ...residuals.map((r) => Math.abs(r.residual_arcmin)), ...residuals.map((r) => (sigmas.get(r.id) ?? 1) * 1.3));
  const centre = labelW + chartW / 2;
  const scale = chartW / 2 / (maxAbs * 1.15);
  residuals.forEach((r, i) => {
    const y = 6 + i * row;
    const sigma = sigmas.get(r.id) ?? 1;
    const out = Math.abs(r.normalized) > 3;
    const t = s('text', { x: 0, y: y + 15, class: 'sfn-residuals__label' });
    t.textContent = `${r.id} · ${r.body}`;
    svg.appendChild(t);
    svg.appendChild(s('rect', { x: (centre - sigma * scale).toFixed(1), y: y + 2, width: Math.max(2 * sigma * scale, 1).toFixed(1), height: row - 8, class: 'sfn-residuals__band' }));
    const w = Math.abs(r.residual_arcmin) * scale;
    svg.appendChild(s('rect', { x: (r.residual_arcmin >= 0 ? centre : centre - w).toFixed(1), y: y + 7, width: Math.max(w, 1.5).toFixed(1), height: row - 18, class: `sfn-residuals__bar${out ? ' sfn-residuals__bar--out' : ''}` }));
    const v = s('text', {
      x: ((r.residual_arcmin >= 0 ? centre + w + 6 : centre - w - 6)).toFixed(1),
      y: y + 15,
      'text-anchor': r.residual_arcmin >= 0 ? 'start' : 'end',
      class: 'sfn-residuals__value',
    });
    v.textContent = `${fmtArcmin(r.residual_arcmin, 2)} (${fmtNum(r.normalized, 1)} σ)${out ? ' outlier' : ''}`;
    svg.appendChild(v);
  });
  svg.appendChild(s('line', { x1: centre, y1: 2, x2: centre, y2: height - 22, class: 'sfn-residuals__axis' }));
  const cap = s('text', { x: centre, y: height - 6, 'text-anchor': 'middle', class: 'sfn-residuals__caption' });
  cap.textContent = 'Ho − Hc at the fix, arcminutes; the shaded band is that sight’s ±1 sigma';
  svg.appendChild(cap);
  return svg;
}

export function residualTable(residuals: readonly Residual[], format: AngleFormat): HTMLElement {
  const table = h('table', { class: 'sf-table sfn-table' });
  table.appendChild(
    h(
      'thead',
      {},
      h('tr', {}, ...['Sight', 'Body', 'Computed · Hc', 'Bearing · Zn', 'Residual', 'Normalised', 'Weight', 'Intercept'].map((t) => h('th', { scope: 'col' }, t))),
    ),
  );
  const body = h('tbody', {});
  for (const r of residuals) {
    const out = Math.abs(r.normalized) > 3;
    body.appendChild(
      h(
        'tr',
        { class: out ? 'sfn-row--outlier' : undefined },
        h('th', { scope: 'row' }, r.id),
        h('td', {}, r.body),
        h('td', {}, fmtAngle(r.hc_deg, format)),
        h('td', {}, fmtBearing(r.zn_deg)),
        h('td', {}, fmtArcmin(r.residual_arcmin, 2)),
        h('td', {}, `${fmtNum(r.normalized, 2)} σ${out ? ' — outlier' : ''}`),
        h('td', {}, fmtNum(r.weight, 2)),
        h('td', {}, fmtNm(r.intercept_nm, 2)),
      ),
    );
  }
  table.appendChild(body);
  return h('div', { class: 'sfn-table-scroll' }, table);
}

/** The geometry in plain sentences, with the numbers (the old workbench's wording). */
export function conditioningBlock(c: Conditioning): HTMLElement {
  const n = c.condition_number;
  const gap = c.max_azimuth_gap_deg;
  const sentences: string[] = [];
  if (n === null || !Number.isFinite(n) || c.rank < 2) {
    sentences.push('These sights do not constrain both directions of position: there is a direction in which you could move a long way without changing any predicted altitude.');
  } else if (n < 2) {
    sentences.push('The sights are well spread: the uncertainty is nearly the same in every direction.');
  } else if (n < 5) {
    sentences.push(`The geometry is workable but uneven: the weakest direction is about ${n.toFixed(1)} times worse than the best.`);
  } else {
    sentences.push(`The geometry is poor: the weakest direction is about ${fmtMagnitude(n)} times worse than the best. The ellipse is long and thin for that reason, not because the sights are bad.`);
  }
  sentences.push(
    c.geometric_dilution_m_per_arcmin === null
      ? 'No finite figure says how far a one-arcminute altitude error moves this fix: along the unconstrained direction it moves without limit.'
      : `A one-arcminute error in a single altitude moves this fix by roughly ${fmtMetres(c.geometric_dilution_m_per_arcmin)}.`,
  );
  sentences.push(
    gap > 180
      ? `Every body lies within one ${(360 - gap).toFixed(0)}° sector of the horizon; the largest gap between neighbouring bearings is ${gap.toFixed(0)}°.`
      : `The largest gap between neighbouring sight bearings is ${gap.toFixed(0)}°.`,
  );
  return h(
    'div',
    { class: 'sfn-conditioning' },
    para(sentences.join(' '), 'sfn-plain'),
    facts([
      ['Condition number', fmtMagnitude(n)],
      ['Rank', `${c.rank} of 2`],
      ['Largest bearing gap', `${gap.toFixed(1)}°`],
      ['Geometric dilution', c.geometric_dilution_m_per_arcmin === null ? 'singular (no finite value)' : `${fmtMetres(c.geometric_dilution_m_per_arcmin)} per arcminute of altitude noise`],
      c.columns ? ['Columns described', c.columns] : null,
      c.singular_values.length ? ['Singular values', c.singular_values.map((v) => fmtMagnitude(v)).join(', ')] : null,
    ]),
  );
}

export function warningsBlock(result: FixResult): HTMLElement {
  return warningList(result.warnings, 'The solver reported no warnings.');
}
