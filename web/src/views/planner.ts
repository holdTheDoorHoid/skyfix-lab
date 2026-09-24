/**
 * Planner: which bodies to shoot next, ranked by what they do to the CONDITIONING of
 * the fix — not by brightness and not by evenly spaced azimuths (docs/PLANNER.md).
 *
 * Two disclosures are permanent fixtures of this view, not fine print:
 *   1. it needs an approximate position, and it names the one it used;
 *   2. visibility here is geometric, plus a twilight flag. It is not a weather forecast.
 */

import { button, clear, field, h, numberInput, select, textInput } from '../dom.js';
import { fixed, finiteOr, formatLatLon, magnitude, metres } from '../format.js';
import { OBJECTIVES, defaultPlanOptions, type Objective, type PlanMetrics } from '../api/adapter.js';
import type { Store } from '../store.js';
import { note, panel, toolbar } from './common.js';

function metricsRow(label: string, m: PlanMetrics): HTMLElement {
  return h(
    'tr',
    { class: m.singular ? 'step-skipped' : undefined },
    h('th', { scope: 'row' }, label),
    h('td', { 'data-label': 'sights' }, String(m.sight_count)),
    h(
      'td',
      { 'data-label': 'north / east 1 sigma' },
      m.sigma_north_m === null || m.sigma_east_m === null
        ? 'singular (no finite value)'
        : `${metres(m.sigma_north_m)} / ${metres(m.sigma_east_m)}`,
    ),
    h(
      'td',
      { 'data-label': 'ellipse axes 1 sigma' },
      m.semi_major_sigma_m === null || m.semi_minor_sigma_m === null
        ? 'singular (no finite value)'
        : `${metres(m.semi_major_sigma_m)} × ${metres(m.semi_minor_sigma_m)}` +
          (m.semi_major_azimuth_deg === null
            ? ''
            : ` at ${fixed(m.semi_major_azimuth_deg, 0)}°`),
    ),
    h('td', { 'data-label': 'condition number' }, finiteOr(m.condition_number, magnitude)),
    h('td', { 'data-label': 'largest azimuth gap' }, `${fixed(m.max_azimuth_gap_deg, 0)}°`),
  );
}

export function renderPlanner(store: Store, root: HTMLElement): void {
  clear(root);
  const session = store.state.session;
  const assumed = session.observer.assumed_position;
  const options = store.state.planOptions;
  const plan = store.state.plan;

  const patch = (mutate: (o: typeof options) => void): void => {
    const next = { ...store.state.planOptions };
    mutate(next);
    store.set({ planOptions: next }, { quiet: true });
  };

  root.appendChild(
    panel(
      'What this planner can and cannot tell you',
      h(
        'ol',
        { class: 'explain' },
        h(
          'li',
          {},
          h('strong', {}, 'It needs an approximate position, and it says which one it used. '),
          'Ranking bodies means predicting where they will be, which needs a position to predict from. That approximate position is a planning input only: it never becomes a prior on a fix, and it never reaches the solver.',
        ),
        h(
          'li',
          {},
          h('strong', {}, 'Visibility is geometric, plus a twilight flag. '),
          'There is no weather here. A body this planner calls visible may be behind cloud, and the twilight note comes from the computed Sun altitude, not from an observation of the sky.',
        ),
        h(
          'li',
          {},
          h('strong', {}, 'Ranking is by conditioning, not brightness. '),
          'The useful question is which body most improves the geometry you already have. A brighter star in a direction you have already covered adds less than a dimmer one that fills the gap.',
        ),
      ),
    ),
  );

  const latInput = numberInput(
    store.state.planPosition.lat_deg,
    (v) => store.set({ planPosition: { ...store.state.planPosition, lat_deg: v } }, { quiet: true }),
    { step: '0.01', min: '-90', max: '90' },
  );
  const lonInput = numberInput(
    store.state.planPosition.lon_deg,
    (v) => store.set({ planPosition: { ...store.state.planPosition, lon_deg: v } }, { quiet: true }),
    { step: '0.01', min: '-180', max: '180' },
  );

  const objective = OBJECTIVES.find((o) => o.value === options.objective);

  root.appendChild(
    panel(
      'Where and when',
      h(
        'div',
        { class: 'grid-2' },
        field('Approximate latitude, degrees (north +)', latInput),
        field('Approximate longitude, degrees (east +)', lonInput),
        field(
          'UTC',
          textInput(store.state.planUtc, (v) => store.set({ planUtc: v }, { quiet: true })),
          'RFC 3339 with a trailing Z.',
        ),
        field(
          'How many sights to plan',
          numberInput(options.select, (v) => patch((o) => { o.select = Math.max(1, Math.round(v)); }), {
            step: '1',
            min: '1',
            max: '12',
          }),
        ),
        field(
          'What to optimise',
          select(
            options.objective,
            OBJECTIVES.map((o) => ({ value: o.value, label: o.label })),
            (v: Objective) => {
              patch((o) => { o.objective = v; });
              renderPlanner(store, root);
            },
          ),
          objective?.note,
        ),
        field(
          'Lowest altitude to consider, degrees',
          numberInput(options.min_altitude_deg, (v) => patch((o) => { o.min_altitude_deg = v; }), {
            step: '1',
            min: '0',
            max: '89',
          }),
          'Below about 15° the refraction model is the weak link, not the sextant.',
        ),
        field(
          'Highest altitude to consider, degrees',
          numberInput(options.max_altitude_deg, (v) => patch((o) => { o.max_altitude_deg = v; }), {
            step: '1',
            min: '1',
            max: '90',
          }),
          'Near the zenith the azimuth changes too fast to measure against a horizon.',
        ),
        field(
          'Assumed sight uncertainty, arcminutes',
          numberInput(options.base_sigma_arcmin, (v) =>
            patch((o) => { o.base_sigma_arcmin = Math.max(v, 0.01); }), { step: '0.1', min: '0.01' }),
          'What the prediction assumes each sight will be worth.',
        ),
      ),
      toolbar(
        button('Rank the sky', () => void runPlan(store).then(() => renderPlanner(store, root)), {
          class: 'primary',
        }),
        assumed
          ? button('Use the session’s assumed position', () => {
              store.set({ planPosition: { ...assumed } });
              renderPlanner(store, root);
            })
          : null,
      ),
      store.state.planError ? h('p', { class: 'error' }, store.state.planError) : null,
    ),
  );

  if (!plan) {
    root.appendChild(panel('No plan yet', h('p', { class: 'muted' }, 'Press “Rank the sky”.')));
    return;
  }

  root.appendChild(
    panel(
      'The position this plan assumed',
      h(
        'p',
        { class: 'plain' },
        `Everything below is predicted from ${formatLatLon(plan.approximate_position)} at ${plan.utc}. ` +
          'Change either and the ranking changes. This position was used for prediction only.',
      ),
    ),
  );

  const list = h('ol', { class: 'plan-list' });
  for (const body of plan.bodies) {
    list.appendChild(
      h(
        'li',
        {},
        h('strong', {}, body.body),
        ` — altitude ${fixed(body.altitude_deg, 1)}°, azimuth ${fixed(body.azimuth_deg, 1)}°`,
        body.magnitude === null ? '' : `, magnitude ${fixed(body.magnitude, 1)}`,
        h('div', { class: 'muted' }, `score ${fixed(body.score, 3)} ${body.score_units}`),
        h('div', { class: 'plain' }, body.rationale),
      ),
    );
  }
  root.appendChild(
    panel(
      `Ranked sights (${plan.bodies.length})`,
      note(
        'In the order a greedy search picks them: each one is the body that most improves the geometry given everything above it.',
      ),
      plan.bodies.length > 0
        ? list
        : h('p', { class: 'muted' }, 'Nothing was ranked. Widen the altitude range, or try another time.'),
    ),
  );

  const table = h('table', { class: 'plan-metrics' });
  table.appendChild(
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ...['stage', 'sights', 'north / east 1 sigma', 'ellipse axes 1 sigma', 'condition number', 'largest azimuth gap'].map(
          (t) => h('th', {}, t),
        ),
      ),
    ),
  );
  const tbody = h('tbody', {});
  tbody.appendChild(metricsRow('Before (what you already have)', plan.baseline));
  // A progression entry with `sight_count` k is the state after k picks, so entry 0 is
  // the baseline repeated. Label each by the body that produced it.
  for (const m of plan.progression) {
    const taken = m.sight_count - plan.baseline.sight_count;
    if (taken <= 0) continue;
    tbody.appendChild(metricsRow(`After ${plan.bodies[taken - 1]?.body ?? `pick ${taken}`}`, m));
  }
  tbody.appendChild(metricsRow('Predicted total', plan.predicted));
  table.appendChild(tbody);

  root.appendChild(
    panel(
      'Predicted uncertainty, sight by sight',
      note(
        'What the nominal uncertainty becomes as each planned sight is added. These are predictions from geometry under the assumed sight uncertainty, not measurements.',
      ),
      h('div', { class: 'table-scroll' }, table),
    ),
  );

  if (plan.excluded.length > 0) {
    root.appendChild(
      panel(
        `Considered and excluded (${plan.excluded.length})`,
        note('Bodies that were up but were not ranked, and why.'),
        h(
          'ul',
          { class: 'explain' },
          ...plan.excluded.map((e) =>
            h(
              'li',
              {},
              h('strong', {}, e.body),
              ` — altitude ${fixed(e.altitude_deg, 1)}°, azimuth ${fixed(e.azimuth_deg, 1)}°: ${e.reason}`,
            ),
          ),
        ),
      ),
    );
  }

  root.appendChild(
    panel(
      'What this plan discloses',
      h('ul', { class: 'explain' }, ...plan.notes.map((n) => h('li', {}, n))),
    ),
  );
}

export async function runPlan(store: Store): Promise<void> {
  try {
    const plan = await store.api.plan(
      store.state.planPosition,
      store.state.planUtc,
      store.state.planOptions,
    );
    store.set({ plan, planError: null }, { quiet: true });
  } catch (error) {
    store.set({ plan: null, planError: String(error) }, { quiet: true });
  }
}

export { defaultPlanOptions };
