/**
 * Simulator view. The ONLY view that draws the truth position.
 *
 * The truth never enters the session the Observations view holds: "Send session to
 * Observations" copies `output.session` and nothing else, and the solver is called with
 * the same session an observer would have written down.
 */

import { button, checkbox, clear, field, h, numberInput, select, textInput } from '../dom.js';
import { formatLatLon, metres, metresBoth } from '../format.js';
import { GEOMETRY_PRESETS, type GeometryPreset } from '../api/adapter.js';
import { MockApi } from '../api/mock.js';
import type { Store } from '../store.js';
import type { ErrorEllipse, FixResult, LatLon } from '../types.js';
import { defaultSolveOptions } from '../types.js';
import { buildPlotSpec, conditioningBlock, renderPlotPanel } from './fix.js';
import { note, panel, toolbar, warningList } from './common.js';

const HORIZON_OPTIONS = [
  { value: 'sea' as const, label: 'Natural sea horizon' },
  { value: 'artificial_reflected' as const, label: 'Reflected artificial horizon' },
  { value: 'electronic_vertical' as const, label: 'Electronic local vertical' },
];

/** Offset of `p` from `origin` in tangent-plane metres (north, east). */
export function offsetMetres(origin: LatLon, p: LatLon): { north: number; east: number } {
  const north = (p.lat_deg - origin.lat_deg) * 60 * 1852;
  let dLon = p.lon_deg - origin.lon_deg;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  const east = dLon * 60 * 1852 * Math.cos((origin.lat_deg * Math.PI) / 180);
  return { north, east };
}

/** Is `truth` inside the 95 % ellipse centred on `fix`? */
export function truthInsideEllipse(fix: LatLon, truth: LatLon, ellipse: ErrorEllipse): boolean {
  const { north, east } = offsetMetres(fix, truth);
  const theta = (ellipse.orientation_deg * Math.PI) / 180;
  const alongMajor = north * Math.cos(theta) + east * Math.sin(theta);
  const alongMinor = -north * Math.sin(theta) + east * Math.cos(theta);
  return (
    (alongMajor / ellipse.semi_major_m) ** 2 + (alongMinor / ellipse.semi_minor_m) ** 2 <= 1
  );
}

function comparison(result: FixResult, truth: LatLon): HTMLElement {
  if (result.kind !== 'unique') {
    return h(
      'p',
      { class: 'plain' },
      `The solver returned "${result.kind}", so there is no single position to compare with the truth. That is the honest answer for this geometry, not a failure to report.`,
    );
  }
  const fix = result.fix;
  const { north, east } = offsetMetres(fix.position, truth);
  const distance = Math.hypot(north, east);
  const inside = fix.ellipse95 ? truthInsideEllipse(fix.position, truth, fix.ellipse95) : null;
  const predicted = Math.hypot(fix.sigma_north_m, fix.sigma_east_m);

  const verdict =
    inside === null
      ? 'No ellipse was drawn for this fix, so there is nothing to test the truth against.'
      : inside
        ? 'The truth lies INSIDE the 95 % nominal ellipse.'
        : 'The truth lies OUTSIDE the 95 % nominal ellipse. Under the independent-noise model that should happen about 5 % of the time — and every time an error is shared rather than independent.';

  return h(
    'div',
    {},
    h(
      'dl',
      { class: 'facts' },
      h('div', { class: 'kv' }, h('dt', {}, 'True position'), h('dd', { class: 'sim' }, `${formatLatLon(truth)} — simulated`)),
      h('div', { class: 'kv' }, h('dt', {}, 'Estimated position'), h('dd', {}, formatLatLon(fix.position))),
      h('div', { class: 'kv' }, h('dt', {}, 'True error'), h('dd', {}, `${metresBoth(distance)} — ${metres(Math.abs(north))} ${north >= 0 ? 'north' : 'south'}, ${metres(Math.abs(east))} ${east >= 0 ? 'east' : 'west'}`)),
      h('div', { class: 'kv' }, h('dt', {}, 'Predicted 1-sigma'), h('dd', {}, `${metres(fix.sigma_north_m)} north, ${metres(fix.sigma_east_m)} east (combined ${metres(predicted)})`)),
      h('div', { class: 'kv' }, h('dt', {}, 'Error / predicted sigma'), h('dd', {}, predicted > 0 ? `${(distance / predicted).toFixed(2)}` : 'n/a')),
    ),
    h('p', { class: inside === false ? 'plain outside' : 'plain' }, verdict),
  );
}

export function renderSimulator(store: Store, root: HTMLElement): void {
  clear(root);
  const sim = store.state.simulation;
  const scenario = sim.scenario;
  const patch = (p: Partial<typeof scenario>, rerender = false): void => {
    store.set(
      { simulation: { ...store.state.simulation, scenario: { ...store.state.simulation.scenario, ...p } } },
      { quiet: !rerender },
    );
    if (rerender) renderSimulator(store, root);
  };

  const preset = GEOMETRY_PRESETS.find((p) => p.value === scenario.geometry);

  const controls = h(
    'div',
    { class: 'grid-2' },
    field('Scenario name', textInput(scenario.name, (v) => patch({ name: v }))),
    field(
      'Seed',
      numberInput(scenario.seed, (v) => patch({ seed: Math.round(v) }), { step: '1', min: '0' }),
      'The same seed always produces the same session.',
    ),
    field(
      'Geometry preset',
      select(
        scenario.geometry,
        GEOMETRY_PRESETS.map((p) => ({ value: p.value, label: p.label })),
        (v: GeometryPreset) => patch({ geometry: v }, true),
      ),
      preset?.note,
    ),
    field(
      'Number of sights',
      numberInput(scenario.sight_count, (v) => patch({ sight_count: Math.max(1, Math.round(v)) }), { step: '1', min: '1', max: '6' }),
      'Ignored by the one-sight and two-sight presets.',
    ),
    field('First sight UTC', textInput(scenario.utc, (v) => patch({ utc: v })), 'RFC 3339 with a trailing Z.'),
    field(
      'True latitude, degrees (north +)',
      numberInput(scenario.truth_position.lat_deg, (v) =>
        patch({ truth_position: { ...scenario.truth_position, lat_deg: v } }), { step: '0.0001' }),
      'Simulation only. Never written into the session.',
    ),
    field(
      'True longitude, degrees (east +)',
      numberInput(scenario.truth_position.lon_deg, (v) =>
        patch({ truth_position: { ...scenario.truth_position, lon_deg: v } }), { step: '0.0001' }),
    ),
    field(
      'Declared sigma per sight, arcminutes',
      numberInput(scenario.sigma_arcmin, (v) => patch({ sigma_arcmin: v }), { step: '0.1', min: '0.01' }),
      'What the session tells the solver.',
    ),
    field(
      'Independent noise injected, arcminutes (1 sigma)',
      numberInput(scenario.noise_arcmin, (v) => patch({ noise_arcmin: v }), { step: '0.1', min: '0' }),
      'Different on every sight. This is the error that averaging reduces.',
    ),
    field(
      'Shared altitude bias, arcminutes',
      numberInput(scenario.shared_altitude_bias_arcmin, (v) => patch({ shared_altitude_bias_arcmin: v }), { step: '0.1' }),
      'The same on every sight. Averaging does NOT reduce it, and the residuals stay small while the position is wrong.',
    ),
    field(
      'Clock offset, seconds',
      numberInput(scenario.clock_offset_s, (v) => patch({ clock_offset_s: v }), { step: '1' }),
      'Every recorded time wrong by this amount. For star sights this is nearly the same as a longitude error.',
    ),
    field(
      'Declared clock uncertainty, seconds',
      numberInput(scenario.clock_uncertainty_s, (v) => patch({ clock_uncertainty_s: v }), { step: '1', min: '0' }),
      'Written into the session and propagated into the east-west uncertainty.',
    ),
    field(
      'Missing fraction',
      numberInput(scenario.missing_fraction, (v) => patch({ missing_fraction: Math.min(Math.max(v, 0), 0.9) }), { step: '0.1', min: '0', max: '0.9' }),
      'Fraction of generated sights dropped before the session is written.',
    ),
    field(
      'Height of eye, metres',
      numberInput(scenario.height_of_eye_m, (v) => patch({ height_of_eye_m: v }), { step: '0.1', min: '0' }),
    ),
    field(
      'Index correction, arcminutes (added to the reading)',
      numberInput(scenario.index_correction_arcmin, (v) => patch({ index_correction_arcmin: v }), { step: '0.1' }),
    ),
    field(
      'Horizon mode',
      select(scenario.horizon, HORIZON_OPTIONS, (v) => patch({ horizon: v })),
    ),
  );

  const wrongEnabled = scenario.wrong_sight !== null;
  const wrongControls = h(
    'div',
    { class: 'grid-2' },
    checkbox(wrongEnabled, 'Include one deliberately wrong sight', (v) =>
      patch({ wrong_sight: v ? { index: 0, error_arcmin: 15 } : null }, true),
    ),
    wrongEnabled
      ? field(
          'Which sight (0-based index)',
          numberInput(scenario.wrong_sight!.index, (v) =>
            patch({ wrong_sight: { ...scenario.wrong_sight!, index: Math.max(0, Math.round(v)) } }), { step: '1', min: '0' }),
        )
      : h('div', {}),
    wrongEnabled
      ? field(
          'Altitude error on that sight, arcminutes',
          numberInput(scenario.wrong_sight!.error_arcmin, (v) =>
            patch({ wrong_sight: { ...scenario.wrong_sight!, error_arcmin: v } }), { step: '1' }),
        )
      : h('div', {}),
  );

  const run = button(
    'Run: simulate, then solve',
    () => void runSimulation(store, root),
    { class: 'primary' },
  );

  root.appendChild(
    panel(
      'Scenario',
      note(
        'A seeded generator makes a session from a known position, then the solver is given that session and nothing else. The truth is stored beside the session, never inside it.',
      ),
      controls,
      wrongControls,
      toolbar(run),
      sim.error ? h('p', { class: 'error' }, sim.error) : null,
      sim.usedMock
        ? h('p', { class: 'note' }, 'This run used the browser’s mock generator because the WebAssembly package has no simulator compiled in yet.')
        : null,
    ),
  );

  if (!sim.session || !sim.truth) {
    root.appendChild(panel('No run yet', h('p', { class: 'muted' }, 'Press “Run”.')));
    return;
  }

  root.appendChild(
    panel(
      'Generated session',
      h(
        'dl',
        { class: 'facts' },
        h('div', { class: 'kv' }, h('dt', {}, 'Sights written'), h('dd', {}, String(sim.session.observations.length))),
        h('div', { class: 'kv' }, h('dt', {}, 'Truth position'), h('dd', { class: 'sim' }, `${formatLatLon(sim.truth.position)} — simulated`)),
        h('div', { class: 'kv' }, h('dt', {}, 'Seed'), h('dd', {}, String(sim.truth.seed))),
        h('div', { class: 'kv' }, h('dt', {}, 'Clock offset injected'), h('dd', { class: 'sim' }, `${sim.truth.clock_offset_s} s — simulated`)),
        h('div', { class: 'kv' }, h('dt', {}, 'Shared bias injected'), h('dd', { class: 'sim' }, `${sim.truth.shared_altitude_bias_arcmin}′ — simulated`)),
        h('div', { class: 'kv' }, h('dt', {}, 'Deliberately wrong sights'), h('dd', { class: 'sim' }, sim.truth.wrong_sight_ids.length > 0 ? `${sim.truth.wrong_sight_ids.join(', ')} — simulated` : 'none')),
      ),
      toolbar(
        button('Send session to Observations (truth is not copied)', () => {
          store.replaceSession(structuredClone(sim.session!));
          store.notice('info', 'The simulated session is now on the Observations view. Its truth stayed here.');
        }),
      ),
    ),
  );

  if (sim.fix) {
    root.appendChild(panel('Truth versus the reported uncertainty', comparison(sim.fix, sim.truth.position)));

    const plotHolder = h('div', {});
    root.appendChild(plotHolder);
    const simStore = simulationStore(store);
    void buildPlotSpec(simStore, sim.fix, { truth: sim.truth.position }).then((spec) => {
      clear(plotHolder);
      plotHolder.appendChild(
        renderPlotPanel(
          store,
          spec,
          'Position plot with truth',
          'The asterisk is the simulated truth. It appears on this view only.',
        ),
      );
    });

    if (sim.fix.kind === 'unique') {
      root.appendChild(panel('Conditioning', conditioningBlock(sim.fix.fix.conditioning)));
    }
    root.appendChild(panel('Warnings', warningList(sim.fix.warnings, 'The solver reported no warnings.')));
  }
}

/** A view of the store whose `session`/`reduced` are the simulation's, for plotting. */
function simulationStore(store: Store): Store {
  const sim = store.state.simulation;
  return {
    ...store,
    api: store.api,
    state: {
      ...store.state,
      session: sim.session ?? store.state.session,
      reduced: store.state.simulation.session ? (store.state.reduced ?? null) : null,
    },
  } as Store;
}

export async function runSimulation(store: Store, root: HTMLElement): Promise<void> {
  const scenario = store.state.simulation.scenario;
  let usedMock = false;
  let output;
  try {
    output = await store.api.simulate(scenario);
  } catch (error) {
    try {
      output = await new MockApi().simulate(scenario);
      usedMock = true;
      store.notice(
        'caution',
        `The WebAssembly simulator is not available (${String(error)}). The browser's mock generator was used.`,
      );
    } catch (inner) {
      store.set({
        simulation: { ...store.state.simulation, error: String(inner), session: null, truth: null, fix: null },
      });
      renderSimulator(store, root);
      return;
    }
  }

  let fix: FixResult | null = null;
  let error: string | null = null;
  let reduced = null;
  try {
    reduced = await store.api.reduce(output.session, store.state.ephemerisMode);
  } catch {
    reduced = await new MockApi().reduce(output.session, 'supplied');
  }
  try {
    fix = await store.api.solve(output.session, {
      ...defaultSolveOptions(),
      initializer: output.session.observer.assumed_position,
      clock_uncertainty_s: output.session.clock.uncertainty_s,
    });
  } catch (e) {
    try {
      fix = await new MockApi().solve(output.session, {
        ...defaultSolveOptions(),
        initializer: output.session.observer.assumed_position,
        clock_uncertainty_s: output.session.clock.uncertainty_s,
      });
      usedMock = true;
    } catch {
      error = String(e);
    }
  }

  store.set({
    reduced,
    simulation: {
      scenario,
      session: output.session,
      truth: output.truth,
      fix,
      error,
      usedMock,
    },
  });
  renderSimulator(store, root);
}
