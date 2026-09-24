/**
 * Fix view: the graticule plot, the residuals, the conditioning and the warnings.
 *
 * `FixResult::Unique` carries no circles of position, so the circles drawn here come
 * from the reduced sights (GP = (dec, −GHA), radius = 90° − Ho). Solving therefore
 * reduces first and keeps the reduction.
 */

import { button, checkbox, clear, h, numberInput } from '../dom.js';
import { degBoth, formatLatLon, formatLatLonDecimal, magnitude, metres, metresBoth } from '../format.js';
import { renderPlot, defaultPlotView, emptyPlotSpec, type PlotSpec, type PlotView } from '../plot/graticule.js';
import { renderResiduals } from '../plot/residuals.js';
import type { Store } from '../store.js';
import type { CircleOfPosition, Conditioning, FixResult, LatLon, Residual } from '../types.js';
import { note, panel, toolbar, warningList } from './common.js';

/** Plot pan/zoom is view furniture, not application state: kept here between renders. */
let plotView: PlotView = defaultPlotView();

export function resetFixPlotView(): void {
  plotView = defaultPlotView();
}

export async function runSolve(store: Store): Promise<void> {
  try {
    const reduced = await store.api.reduce(store.state.session, store.state.ephemerisMode);
    store.set({ reduced, reduceError: null }, { quiet: true });
    const options = {
      ...store.state.solveOptions,
      initializer:
        store.state.session.observer.assumed_position_role.role === 'initializer'
          ? store.state.session.observer.assumed_position
          : null,
      prior:
        store.state.session.observer.assumed_position_role.role === 'prior' &&
        store.state.session.observer.assumed_position
          ? {
              center: store.state.session.observer.assumed_position,
              sigma_nm: store.state.session.observer.assumed_position_role.sigma_nm,
            }
          : null,
      clock_uncertainty_s: store.state.session.clock.uncertainty_s,
    };
    const fix = await store.api.solve(store.state.session, options);
    store.set({ fix, fixError: null, solveOptions: options });
  } catch (error) {
    store.set({ fix: null, fixError: String(error) });
  }
}

/** Circles built from the reduction, since a unique fix does not carry them. */
export function circlesFromReduction(store: Store): CircleOfPosition[] {
  return (store.state.reduced ?? [])
    .filter((e) => e.status === 'ok')
    .map((e) => {
      const sight = (e as Extract<typeof e, { status: 'ok' }>).sight;
      const lon = ((((-sight.gha_deg % 360) + 540) % 360) - 180);
      return {
        id: sight.id,
        body: sight.body,
        gp: { lat_deg: sight.dec_deg, lon_deg: lon === -180 ? 180 : lon },
        zenith_distance_deg: 90 - sight.ho_deg,
      };
    });
}

export async function buildPlotSpec(
  store: Store,
  result: FixResult | null,
  extra: { truth?: LatLon | null } = {},
): Promise<PlotSpec> {
  const spec = emptyPlotSpec();
  const circles: CircleOfPosition[] =
    result && 'circles' in result && result.circles.length > 0
      ? result.circles
      : circlesFromReduction(store);

  for (const circle of circles) {
    const points = await store.api.circlePoints(
      circle.gp.lat_deg,
      circle.gp.lon_deg,
      circle.zenith_distance_deg,
      360,
    );
    spec.circles.push({
      id: circle.id,
      body: circle.body,
      points: points.map(([lat_deg, lon_deg]) => ({ lat_deg, lon_deg })),
    });
  }

  if (result?.kind === 'unique') {
    spec.fix = result.fix.position;
    if (result.fix.ellipse95) {
      spec.ellipse = { centre: result.fix.position, ellipse: result.fix.ellipse95 };
    }
  } else if (result?.kind === 'ambiguous') {
    spec.candidates = result.candidates.map((c) => c.position);
  }

  const role = store.state.session.observer.assumed_position_role;
  const assumed = store.state.session.observer.assumed_position;
  if (assumed && role.role !== 'disabled') {
    spec.assumed = {
      position: assumed,
      role: role.role === 'prior' ? `prior, ${role.sigma_nm} NM` : 'initializer',
    };
  }
  spec.truth = extra.truth ?? null;
  return spec;
}

export function conditioningBlock(conditioning: Conditioning): HTMLElement {
  const c = conditioning.condition_number;
  const gap = conditioning.max_azimuth_gap_deg;
  const sentences: string[] = [];
  if (!Number.isFinite(c) || conditioning.rank < 2) {
    sentences.push(
      'These sights do not constrain both components of position. There is a direction in which you could move a long way without changing any predicted altitude.',
    );
  } else if (c < 2) {
    sentences.push(
      'The sights are well spread: the nominal uncertainty is nearly the same in every direction.',
    );
  } else if (c < 5) {
    sentences.push(
      `The geometry is workable but not even: the weakest direction is about ${c.toFixed(1)} times worse than the best.`,
    );
  } else {
    sentences.push(
      `The geometry is poor: the weakest direction is about ${magnitude(c)} times worse than the best. The ellipse is long and thin for that reason, not because the sights are bad.`,
    );
  }
  sentences.push(
    `A one-arcminute error in a single altitude moves this fix by roughly ${metres(conditioning.geometric_dilution_m_per_arcmin)}.`,
  );
  if (gap > 180) {
    sentences.push(
      `Every body lies within one ${(360 - gap).toFixed(0)}° sector of the horizon — the largest gap between neighbouring azimuths is ${gap.toFixed(0)}°.`,
    );
  } else {
    sentences.push(`The largest gap between neighbouring sight azimuths is ${gap.toFixed(0)}°.`);
  }

  return h(
    'div',
    { class: 'conditioning' },
    h(
      'dl',
      { class: 'facts' },
      h('div', { class: 'kv' }, h('dt', {}, 'Condition number'), h('dd', {}, magnitude(c))),
      h('div', { class: 'kv' }, h('dt', {}, 'Rank'), h('dd', {}, `${conditioning.rank} of 2`)),
      h(
        'div',
        { class: 'kv' },
        h('dt', {}, 'Largest azimuth gap'),
        h('dd', {}, `${gap.toFixed(1)}°`),
      ),
      h(
        'div',
        { class: 'kv' },
        h('dt', {}, 'Geometric dilution'),
        h('dd', {}, `${metres(conditioning.geometric_dilution_m_per_arcmin)} per arcminute of altitude noise`),
      ),
      h(
        'div',
        { class: 'kv' },
        h('dt', {}, 'Singular values'),
        h('dd', {}, conditioning.singular_values.map((v) => magnitude(v)).join(', ')),
      ),
    ),
    h('p', { class: 'plain' }, sentences.join(' ')),
  );
}

function resultSummary(result: FixResult): HTMLElement {
  switch (result.kind) {
    case 'unique': {
      const fix = result.fix;
      return h(
        'div',
        {},
        h('p', { class: 'result-kind kind-unique' }, 'Unique fix'),
        h(
          'dl',
          { class: 'facts' },
          h('div', { class: 'kv' }, h('dt', {}, 'Position'), h('dd', {}, formatLatLon(fix.position))),
          h('div', { class: 'kv' }, h('dt', {}, 'Position, decimal'), h('dd', {}, formatLatLonDecimal(fix.position))),
          h('div', { class: 'kv' }, h('dt', {}, 'North nominal uncertainty'), h('dd', {}, `${metresBoth(fix.sigma_north_m)} (1 sigma)`)),
          h('div', { class: 'kv' }, h('dt', {}, 'East nominal uncertainty'), h('dd', {}, `${metresBoth(fix.sigma_east_m)} (1 sigma)`)),
          fix.clock_sigma_east_m > 0
            ? h('div', { class: 'kv' }, h('dt', {}, 'Of which clock'), h('dd', {}, `${metres(fix.clock_sigma_east_m)} east-west, from the declared time uncertainty`))
            : null,
          fix.ellipse95
            ? h(
                'div',
                { class: 'kv' },
                h('dt', {}, '95 % ellipse'),
                h(
                  'dd',
                  {},
                  `${metres(fix.ellipse95.semi_major_m)} × ${metres(fix.ellipse95.semi_minor_m)}, major axis ${fix.ellipse95.orientation_deg.toFixed(1)}° from north — `,
                  h('strong', {}, '95 % nominal, independent-noise model'),
                ),
              )
            : h('div', { class: 'kv' }, h('dt', {}, '95 % ellipse'), h('dd', { class: 'muted' }, `not drawn: ${fix.ellipse_suppressed_reason ?? 'suppressed'}`)),
          h('div', { class: 'kv' }, h('dt', {}, 'Chi-square / dof'), h('dd', {}, `${fix.chi2.toFixed(2)} / ${fix.dof}`)),
          h('div', { class: 'kv' }, h('dt', {}, 'Iterations'), h('dd', {}, `${fix.iterations}${fix.converged ? ' (converged)' : ' (did NOT converge)'}`)),
          fix.shared_bias_arcmin !== null
            ? h('div', { class: 'kv' }, h('dt', {}, 'Estimated shared bias'), h('dd', {}, `${fix.shared_bias_arcmin.toFixed(2)}′ applied to every sight`))
            : null,
          fix.prior
            ? h('div', { class: 'kv' }, h('dt', {}, 'Prior'), h('dd', {}, `${fix.prior.sigma_nm} NM at ${formatLatLon(fix.prior.center)}; it moved the fix ${metres(fix.prior.shift_m)}`))
            : null,
          fix.posterior_scaled
            ? h('div', { class: 'kv' }, h('dt', {}, 'Residual-scaled covariance'), h('dd', {}, `scale factor s² = ${fix.posterior_scaled.scale_factor_s2.toFixed(2)}`))
            : null,
        ),
        result.alternatives.length > 0
          ? h(
              'p',
              { class: 'note' },
              `${result.alternatives.length} other minimum${result.alternatives.length === 1 ? '' : 'a'} was rejected, the nearest by a chi-square gap of ${result.alternatives[0]!.delta_chi2_from_best.toFixed(1)}.`,
            )
          : null,
      );
    }
    case 'ambiguous':
      return h(
        'div',
        {},
        h('p', { class: 'result-kind kind-ambiguous' }, 'Ambiguous — two or more positions fit equally well'),
        h(
          'p',
          { class: 'plain' },
          'Nothing in this session chooses between these candidates. They are drawn with equal weight on purpose. Resolve it with another sight in a different direction, or by declaring a prior on the Observations view.',
        ),
        h(
          'ol',
          { class: 'candidates' },
          ...result.candidates.map((c, i) =>
            h(
              'li',
              {},
              h('strong', {}, `Candidate ${String.fromCharCode(65 + i)}: `),
              `${formatLatLon(c.position)} — chi-square ${c.chi2.toFixed(2)} (${c.delta_chi2_from_best.toFixed(2)} from the best)`,
            ),
          ),
        ),
      );
    case 'underdetermined':
      return h(
        'div',
        {},
        h('p', { class: 'result-kind kind-underdetermined' }, 'Underdetermined — no position'),
        h(
          'p',
          { class: 'plain' },
          'One sight constrains you to this circle, not a point. Every position on the circle predicts the altitude you measured.',
        ),
        h('p', { class: 'note' }, result.reason),
      );
    case 'failed':
      return h(
        'div',
        {},
        h('p', { class: 'result-kind kind-failed' }, 'Failed — no position'),
        h('p', { class: 'plain' }, result.reason),
      );
  }
}

function plotControls(store: Store): HTMLElement {
  const rerender = () => store.notify();
  return toolbar(
    button('Zoom in', () => {
      plotView = { ...plotView, zoom: plotView.zoom * 1.6 };
      rerender();
    }),
    button('Zoom out', () => {
      plotView = { ...plotView, zoom: Math.max(plotView.zoom / 1.6, 0.05) };
      rerender();
    }),
    button('Fit', () => {
      plotView = defaultPlotView();
      rerender();
    }),
    h('span', { class: 'muted' }, 'Drag the plot to pan.'),
  );
}

function attachPan(svg: SVGSVGElement, onPan: (dx: number, dy: number) => void): void {
  let active = false;
  let lastX = 0;
  let lastY = 0;
  svg.addEventListener('pointerdown', (event) => {
    active = true;
    lastX = event.clientX;
    lastY = event.clientY;
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', (event) => {
    if (!active) return;
    const rect = svg.getBoundingClientRect();
    const scale = 720 / Math.max(rect.width, 1);
    onPan((event.clientX - lastX) * scale, (event.clientY - lastY) * scale);
    lastX = event.clientX;
    lastY = event.clientY;
  });
  const end = (event: PointerEvent) => {
    active = false;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

export function renderPlotPanel(
  store: Store,
  spec: PlotSpec,
  title: string,
  extraNote: string | null,
): HTMLElement {
  const svg = renderPlot(spec, plotView);
  attachPan(svg, (dx, dy) => {
    // Convert pixel drag to degrees using the rendered scale.
    const latPerPx = 1 / 40;
    plotView = {
      ...plotView,
      offsetLat: plotView.offsetLat + (dy * latPerPx) / plotView.zoom,
      offsetLon: plotView.offsetLon - (dx * latPerPx) / plotView.zoom,
    };
    store.notify();
  });
  return panel(
    title,
    extraNote ? note(extraNote) : null,
    plotControls(store),
    h('div', { class: 'plot-wrap' }, svg),
    h('p', { class: 'legend' },
      'Grid lines are latitude and longitude. East-west distances are drawn shortened by cos(latitude) so circles look round near the middle of the view.',
    ),
  );
}

function optionControls(store: Store): HTMLElement {
  const options = store.state.solveOptions;
  return h(
    'div',
    { class: 'options' },
    checkbox(
      options.estimate_shared_bias,
      'Estimate a shared altitude bias as a third unknown',
      (v) => store.set({ solveOptions: { ...store.state.solveOptions, estimate_shared_bias: v } }),
    ),
    checkbox(
      options.robust !== null,
      'Robust (Huber) weighting — downweights outliers and makes the covariance approximate',
      (v) =>
        store.set({
          solveOptions: {
            ...store.state.solveOptions,
            robust: v ? { huber_k: 1.5, max_reweight_iterations: 10 } : null,
          },
        }),
    ),
    checkbox(
      options.posterior_scaling,
      'Also report residual-scaled covariance (only used when 3 or more degrees of freedom)',
      (v) => store.set({ solveOptions: { ...store.state.solveOptions, posterior_scaling: v } }),
    ),
    checkbox(options.multistart.enabled, 'Multistart search for other minima', (v) =>
      store.set({
        solveOptions: {
          ...store.state.solveOptions,
          multistart: { ...store.state.solveOptions.multistart, enabled: v },
        },
      }),
    ),
    h(
      'div',
      { class: 'field inline' },
      h('label', { for: 'max-iterations' }, 'Maximum iterations'),
      numberInput(
        options.max_iterations,
        (v) => store.set({ solveOptions: { ...store.state.solveOptions, max_iterations: Math.max(1, Math.round(v)) } }),
        { step: '1', min: '1', id: 'max-iterations' },
      ),
    ),
    h(
      'p',
      { class: 'note' },
      `The initializer and any prior come from the assumed position on the Observations view (currently: ${store.state.session.observer.assumed_position_role.role}). Clock uncertainty comes from the session clock (${store.state.session.clock.uncertainty_s} s).`,
    ),
  );
}

export function renderFix(store: Store, root: HTMLElement): void {
  clear(root);
  const result = store.state.fix;

  root.appendChild(
    panel(
      'Solve',
      note('Solving reduces every sight first, then fits a position by weighted least squares.'),
      optionControls(store),
      toolbar(button('Solve', () => void runSolve(store), { class: 'primary' })),
      store.state.fixError ? h('p', { class: 'error' }, store.state.fixError) : null,
    ),
  );

  if (!result) {
    root.appendChild(panel('No fix yet', h('p', { class: 'muted' }, 'Press “Solve”.')));
    return;
  }

  const resultPanel = panel('Result', resultSummary(result));
  root.appendChild(resultPanel);

  const plotHolder = h('div', {});
  root.appendChild(plotHolder);
  void buildPlotSpec(store, result).then((spec) => {
    clear(plotHolder);
    plotHolder.appendChild(
      renderPlotPanel(
        store,
        spec,
        'Position plot',
        result.kind === 'underdetermined'
          ? 'One sight constrains you to this circle, not a point.'
          : result.kind === 'ambiguous'
            ? 'Both candidates are drawn identically. Neither is preferred.'
            : null,
      ),
    );
  });

  if (result.kind === 'unique') {
    const sigmas = new Map<string, number>();
    for (const entry of store.state.reduced ?? []) {
      if (entry.status === 'ok') sigmas.set(entry.sight.id, entry.sight.sigma_arcmin);
    }
    for (const r of result.fix.residuals) if (!sigmas.has(r.id)) sigmas.set(r.id, 1);
    root.appendChild(
      panel(
        'Residuals',
        note(
          'Observed minus computed altitude at the fix, in arcminutes. The shaded band is that sight’s own ±1 sigma. A normalised residual past 3 is marked as an outlier.',
        ),
        h('div', { class: 'chart-wrap' }, renderResiduals(result.fix.residuals, sigmas)),
        residualTable(result.fix.residuals),
      ),
    );
    root.appendChild(panel('Conditioning', conditioningBlock(result.fix.conditioning)));
  }

  root.appendChild(
    panel('Warnings', warningList(result.warnings, 'The solver reported no warnings.')),
  );
}

function residualTable(residuals: Residual[]): HTMLElement {
  const table = h('table', { class: 'residual-table' });
  table.appendChild(
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ...['id', 'body', 'Hc', 'Zn', 'residual', 'normalised', 'weight', 'intercept'].map((t) =>
          h('th', {}, t),
        ),
      ),
    ),
  );
  const body = h('tbody', {});
  for (const r of residuals) {
    body.appendChild(
      h(
        'tr',
        { class: Math.abs(r.normalized) > 3 ? 'outlier-row' : undefined },
        h('td', { 'data-label': 'id' }, r.id),
        h('td', { 'data-label': 'body' }, r.body),
        h('td', { 'data-label': 'Hc' }, degBoth(r.hc_deg, 4, 2)),
        h('td', { 'data-label': 'Zn' }, `${r.zn_deg.toFixed(1)}°`),
        h('td', { 'data-label': 'residual' }, `${r.residual_arcmin >= 0 ? '+' : '−'}${Math.abs(r.residual_arcmin).toFixed(2)}′`),
        h('td', { 'data-label': 'normalised' }, `${r.normalized.toFixed(2)} σ${Math.abs(r.normalized) > 3 ? ' — outlier' : ''}`),
        h('td', { 'data-label': 'weight' }, r.weight.toFixed(2)),
        h('td', { 'data-label': 'intercept' }, `${r.intercept_nm.toFixed(2)} NM`),
      ),
    );
  }
  table.appendChild(body);
  return h('div', { class: 'table-scroll' }, table);
}
