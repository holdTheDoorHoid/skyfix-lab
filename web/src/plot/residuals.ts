/**
 * Residual bar chart, arcminutes, with the +/- sigma band drawn behind the bars.
 * A normalised residual over 3 is called out with a hatch, a heavier outline AND the
 * word "outlier": never colour alone.
 */

import { s } from '../dom.js';
import type { Residual } from '../types.js';

const ROW_HEIGHT = 30;
const LABEL_WIDTH = 150;
const CHART_WIDTH = 560;

export function renderResiduals(residuals: Residual[], sigmas: Map<string, number>): SVGSVGElement {
  const height = Math.max(residuals.length * ROW_HEIGHT + 34, 80);
  const width = LABEL_WIDTH + CHART_WIDTH + 20;
  const svg = s('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'residual-chart',
    role: 'img',
    'aria-label': `Residuals in arcminutes for ${residuals.length} sights.`,
  }) as SVGSVGElement;

  const maxAbs = Math.max(
    2,
    ...residuals.map((r) => Math.abs(r.residual_arcmin)),
    ...residuals.map((r) => (sigmas.get(r.id) ?? 1) * 1.5),
  );
  const centre = LABEL_WIDTH + CHART_WIDTH / 2;
  const scale = CHART_WIDTH / 2 / (maxAbs * 1.1);

  const defs = s('defs');
  const hatch = s('pattern', {
    id: 'outlier-hatch',
    width: 6,
    height: 6,
    patternUnits: 'userSpaceOnUse',
    patternTransform: 'rotate(45)',
  });
  hatch.appendChild(s('rect', { width: 6, height: 6, class: 'hatch-bg' }));
  hatch.appendChild(s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'hatch-line' }));
  defs.appendChild(hatch);
  svg.appendChild(defs);

  residuals.forEach((r, i) => {
    const y = 10 + i * ROW_HEIGHT;
    const sigma = sigmas.get(r.id) ?? 1;
    const outlier = Math.abs(r.normalized) > 3;

    svg.appendChild(
      s(
        'text',
        { x: 0, y: y + 16, class: 'residual-label' },
        `${r.id} · ${r.body}`,
      ),
    );
    // +/- 1 sigma band.
    svg.appendChild(
      s('rect', {
        x: centre - sigma * scale,
        y: y + 2,
        width: Math.max(sigma * 2 * scale, 1),
        height: ROW_HEIGHT - 10,
        class: 'sigma-band',
      }),
    );
    const w = Math.abs(r.residual_arcmin) * scale;
    svg.appendChild(
      s('rect', {
        x: r.residual_arcmin >= 0 ? centre : centre - w,
        y: y + 6,
        width: Math.max(w, 1),
        height: ROW_HEIGHT - 18,
        class: outlier ? 'residual-bar outlier' : 'residual-bar',
        fill: outlier ? 'url(#outlier-hatch)' : undefined,
      }),
    );
    svg.appendChild(
      s(
        'text',
        {
          x: (r.residual_arcmin >= 0 ? centre + w : centre - w) + (r.residual_arcmin >= 0 ? 6 : -6),
          y: y + 18,
          class: 'residual-value',
          'text-anchor': r.residual_arcmin >= 0 ? 'start' : 'end',
        },
        `${r.residual_arcmin >= 0 ? '+' : '−'}${Math.abs(r.residual_arcmin).toFixed(2)}′ (${r.normalized.toFixed(1)} σ)${outlier ? ' outlier' : ''}`,
      ),
    );
  });

  svg.appendChild(
    s('line', { x1: centre, y1: 6, x2: centre, y2: height - 24, class: 'residual-axis' }),
  );
  svg.appendChild(
    s(
      'text',
      { x: centre, y: height - 8, class: 'axis-caption', 'text-anchor': 'middle' },
      'residual Ho − Hc, arcminutes — shaded band is ±1 sigma of that sight',
    ),
  );
  return svg;
}
