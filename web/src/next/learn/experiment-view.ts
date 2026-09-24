/**
 * The coverage experiment's result: how often the truth fell inside the nominal 95 %
 * ellipse, with its Wilson interval against the band an honest model lands in, the
 * error-to-sigma ratio against its band, one dot per repetition, and the verdict in
 * words (verdict.ts, the command line's own rule). OWNER: learn agent.
 */

import { h, s } from '../../dom.js';
import type { ExperimentSummary, Scenario } from '../../api/adapter.js';
import { icon } from '../theme/index.js';
import { arcmin, type Fmt } from './facts.js';
import { MAHALANOBIS_95 } from './geo.js';
import { r2 } from './project.js';
import { responsive } from './result.js';
import { COVERAGE_BAND, RATIO_BAND, dedupeNotes, experimentVerdict } from './verdict.js';

const pct = (p: number | null, digits = 0): string => (p === null ? '—' : `${(p * 100).toFixed(digits)} %`);

/** Coverage on a 0-100 % scale: the healthy band, the nominal 95 %, the Wilson interval, the result. */
export function coverageBand(summary: ExperimentSummary, width = 600): SVGSVGElement {
  const a = summary.aggregate;
  const W = Math.max(260, Math.round(width));
  const H = 64;
  const pad = { l: 12, r: 12 };
  const x = (p: number): number => pad.l + p * (W - pad.l - pad.r);
  const y0 = 30;
  const svg = s('svg', {
    class: 'sfl-band',
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label':
      a.coverage_fraction === null
        ? 'No coverage: nothing was scored.'
        : `Coverage ${pct(a.coverage_fraction, 1)}, Wilson 95 % interval ${pct(a.coverage_ci95?.[0] ?? null, 1)} to ${pct(a.coverage_ci95?.[1] ?? null, 1)}; an honest model lands between 85 and 100 %, near 95 %.`,
  }) as SVGSVGElement;
  svg.append(s('rect', { class: 'sfl-band__track', x: x(0), y: y0 - 5, width: r2(x(1) - x(0)), height: 10, rx: 5 }));
  svg.append(s('rect', { class: 'sfl-band__ok', x: r2(x(COVERAGE_BAND[0])), y: y0 - 9, width: r2(x(COVERAGE_BAND[1]) - x(COVERAGE_BAND[0])), height: 18, rx: 3 }));
  svg.append(s('path', { class: 'sfl-band__nominal', d: `M${r2(x(0.95))} ${y0 - 14}V${y0 + 14}` }));
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    const t = s('text', { class: 'sfl-band__tick', x: r2(x(p)), y: H - 4, 'text-anchor': p === 0 ? 'start' : p === 1 ? 'end' : 'middle' });
    t.textContent = `${p * 100} %`;
    svg.append(t);
  }
  const lab = s('text', { class: 'sfl-band__label', x: r2(x(0.95) - 4), y: 10, 'text-anchor': 'end' });
  lab.textContent = 'promised: 95 %';
  svg.append(lab);
  if (a.coverage_fraction !== null) {
    if (a.coverage_ci95) {
      svg.append(s('rect', { class: 'sfl-band__ci', x: r2(x(a.coverage_ci95[0])), y: y0 - 3, width: r2(Math.max(2, x(a.coverage_ci95[1]) - x(a.coverage_ci95[0]))), height: 6, rx: 3 }));
    }
    const cx = x(a.coverage_fraction);
    svg.append(s('path', { class: 'sfl-band__mark', d: `M${r2(cx)} ${y0 - 11}l7 -9h-14Z` }));
    svg.append(s('circle', { class: 'sfl-band__dot', cx: r2(cx), cy: y0, r: 6 }));
  }
  return svg;
}

/** The error-to-sigma ratio on a log scale, with the healthy band 0.6-1.6. */
export function ratioBand(summary: ExperimentSummary, width = 600): SVGSVGElement {
  const r = summary.aggregate.error_to_sigma_ratio;
  const W = Math.max(260, Math.round(width));
  const H = 52;
  const lo = Math.log10(0.1);
  const hi = Math.log10(100);
  const x = (v: number): number => 12 + ((Math.log10(Math.min(100, Math.max(0.1, v))) - lo) / (hi - lo)) * (W - 24);
  const y0 = 20;
  const svg = s('svg', {
    class: 'sfl-band',
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': r === null ? 'No error-to-sigma ratio.' : `Error divided by predicted sigma: ${r.toFixed(2)}; honest runs land between 0.6 and 1.6.`,
  }) as SVGSVGElement;
  svg.append(s('rect', { class: 'sfl-band__track', x: x(0.1), y: y0 - 5, width: r2(x(100) - x(0.1)), height: 10, rx: 5 }));
  svg.append(s('rect', { class: 'sfl-band__ok', x: r2(x(RATIO_BAND[0])), y: y0 - 9, width: r2(x(RATIO_BAND[1]) - x(RATIO_BAND[0])), height: 18, rx: 3 }));
  svg.append(s('path', { class: 'sfl-band__nominal', d: `M${r2(x(1))} ${y0 - 12}V${y0 + 12}` }));
  for (const v of [0.1, 0.3, 1, 3, 10, 30, 100]) {
    const t = s('text', { class: 'sfl-band__tick', x: r2(x(v)), y: H - 4, 'text-anchor': v === 0.1 ? 'start' : v === 100 ? 'end' : 'middle' });
    t.textContent = `${v}×`;
    svg.append(t);
  }
  if (r !== null) svg.append(s('circle', { class: 'sfl-band__dot', cx: r2(x(r)), cy: y0, r: 6 }));
  return svg;
}

/**
 * One dot per scored repetition: how far the truth was from the fix in units of the
 * ellipse (Mahalanobis distance). Left of the line, the truth was inside the 95 % ellipse.
 */
export function runDots(summary: ExperimentSummary, width = 600): SVGSVGElement | null {
  const ds = summary.runs.map((r) => r.mahalanobis).filter((d): d is number => d !== null && Number.isFinite(d));
  if (!ds.length) return null;
  const W = Math.max(260, Math.round(width));
  const H = 78;
  const lo = Math.log10(0.05);
  const hi = Math.log10(Math.max(100, ...ds) * 1.2);
  const x = (v: number): number => 12 + ((Math.log10(Math.max(0.05, v)) - lo) / (hi - lo)) * (W - 24);
  const svg = s('svg', {
    class: 'sfl-dots',
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `${ds.length} repetitions: ${ds.filter((d) => d <= MAHALANOBIS_95).length} with the truth inside the 95 % ellipse.`,
  }) as SVGSVGElement;
  const edge = x(MAHALANOBIS_95);
  svg.append(s('rect', { class: 'sfl-dots__inside', x: 12, y: 6, width: r2(edge - 12), height: H - 30, rx: 4 }));
  svg.append(s('path', { class: 'sfl-dots__edge', d: `M${r2(edge)} 2V${H - 22}` }));
  const t1 = s('text', { class: 'sfl-band__label', x: r2(edge - 6), y: 16, 'text-anchor': 'end' });
  t1.textContent = 'inside';
  const t2 = s('text', { class: 'sfl-band__label', x: r2(edge + 6), y: 16 });
  t2.textContent = 'outside the 95 % ellipse';
  svg.append(t1, t2);
  // A fixed jitter so the picture is the same every time it is drawn.
  ds.forEach((d, i) => {
    const jitter = ((i * 37) % 17) / 16;
    svg.append(s('circle', { class: `sfl-dots__dot${d > MAHALANOBIS_95 ? ' sfl-dots__dot--out' : ''}`, cx: r2(x(d)), cy: r2(24 + jitter * (H - 58)), r: 3.6 }));
  });
  for (const v of [0.1, 1, 10, 100]) {
    if (Math.log10(v) > hi) continue;
    const t = s('text', { class: 'sfl-band__tick', x: r2(x(v)), y: H - 6, 'text-anchor': 'middle' });
    t.textContent = `${v}`;
    svg.append(t);
  }
  return svg;
}

function row(k: string, v: string): HTMLElement {
  return h('div', { class: 'sfl-kv' }, h('dt', {}, k), h('dd', { class: 'sf-num' }, v));
}

export function experimentResult(summary: ExperimentSummary, scenario: Scenario, fmt: Fmt): HTMLElement {
  const a = summary.aggregate;
  const verdict = experimentVerdict(a, scenario);
  const refused = summary.notes.find((n) => n.startsWith('experiment refused'));
  const inside = summary.runs.filter((r) => r.inside_ellipse95 === true).length;
  const notes = dedupeNotes(summary);
  const hasDots = summary.runs.some((r) => r.mahalanobis !== null && Number.isFinite(r.mahalanobis));
  return h(
    'div',
    { class: 'sfl-exp__result', 'data-tone': verdict.tone },
    refused
      ? h('div', { class: 'sf-notice sf-notice--error', role: 'alert' }, icon('caution'), h('span', {}, refused))
      : h(
          'div',
          { class: `sfl-verdict sfl-verdict--${verdict.tone}` },
          h('span', { class: 'sfl-verdict__chip' }, icon(verdict.tone === 'healthy' ? 'check' : verdict.tone === 'nothing-scored' ? 'info' : 'caution'), verdict.title),
          h('p', {}, verdict.text),
        ),
    a.coverage_fraction !== null
      ? h(
          'div',
          { class: 'sfl-exp__chart' },
          h(
            'p',
            { class: 'sfl-exp__big' },
            h('span', { class: 'sf-num' }, pct(a.coverage_fraction)),
            ` of runs had the truth inside the 95 % ellipse (${inside} of ${a.evaluated}); Wilson 95 % interval ${pct(a.coverage_ci95?.[0] ?? null)} to ${pct(a.coverage_ci95?.[1] ?? null)}.`,
          ),
          responsive('sfl-band-wrap', (w) => coverageBand(summary, w)),
          h('p', { class: 'sfl-muted' }, 'The shaded band is where an honest model lands with this many runs; the dashed line is the promised 95 %.'),
        )
      : null,
    a.error_to_sigma_ratio !== null
      ? h(
          'div',
          { class: 'sfl-exp__chart' },
          h('p', { class: 'sfl-exp__big' }, h('span', { class: 'sf-num' }, `${a.error_to_sigma_ratio.toFixed(2)}×`), ' error ÷ predicted sigma (RMS over all runs); about 1 is honest.'),
          responsive('sfl-band-wrap', (w) => ratioBand(summary, w)),
        )
      : null,
    hasDots
      ? h(
          'div',
          { class: 'sfl-exp__chart' },
          h('p', { class: 'sfl-muted' }, 'Each dot is one repetition: how far the truth was from that run’s fix, measured in the run’s own ellipse (log scale).'),
          responsive('sfl-band-wrap', (w) => runDots(summary, w)),
        )
      : null,
    h(
      'dl',
      { class: 'sfl-numbers' },
      row('Repetitions', `${a.repetitions} run, ${a.evaluated} with an ellipse to score`),
      row('Result kinds', a.result_kind_counts.map(([k, n]) => `${k} × ${n}`).join(', ') || 'none'),
      row('Mean error', a.mean_error_m === null ? '—' : fmt.distBoth(a.mean_error_m)),
      row('RMS error', a.rms_error_m === null ? '—' : fmt.distBoth(a.rms_error_m)),
      row('RMS predicted sigma', a.rms_predicted_sigma_m === null ? '—' : fmt.distBoth(a.rms_predicted_sigma_m)),
      row(
        'Mean signed error',
        a.mean_error_north_m === null || a.mean_error_east_m === null ? '—' : `north ${fmt.dist(a.mean_error_north_m)}, east ${fmt.dist(a.mean_error_east_m)}`,
      ),
      row('Mean residual RMS', a.mean_residual_rms_arcmin === null ? '—' : arcmin(a.mean_residual_rms_arcmin, 3).replace('+', '')),
    ),
    notes.length
      ? h(
          'ul',
          { class: 'sfl-notes' },
          ...notes.filter((n) => !n.text.startsWith('experiment refused')).map((n) => h('li', {}, n.count > 1 ? `${n.text} (in ${n.count} repetitions)` : n.text)),
        )
      : null,
  );
}
