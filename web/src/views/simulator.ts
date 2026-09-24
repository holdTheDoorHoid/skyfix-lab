/**
 * Simulator view. The ONLY view that draws the truth position.
 *
 * The scenario is `skyfix_sim::scenario::Scenario` (docs/SIMULATOR.md). Its fields fall
 * into two groups and the interface keeps them apart on screen, because the whole point
 * of the experiments is that what the estimator is TOLD need not match what was DONE:
 *
 * - TRUTH knobs seed the generator and never reach the session;
 * - REPORTED knobs are written into the session and are what the solver believes.
 *
 * The truth never enters the session the Observations view holds: "Send session to
 * Observations" copies `output.session` and nothing else.
 */

import { button, checkbox, clear, field, h, numberInput, select, textInput } from '../dom.js';
import { fixed, formatLatLon, metres, metresBoth } from '../format.js';
import { MAX_REPETITIONS, type Scenario } from '../api/adapter.js';
import type { Store } from '../store.js';
import type { ErrorEllipse, FixResult, LatLon } from '../types.js';
import { defaultSolveOptions } from '../types.js';
import { buildPlotSpec, conditioningBlock, renderPlotPanel } from './fix.js';
import { note, panel, toolbar, warningList } from './common.js';

// ---------------------------------------------------------------------------
// Truth arithmetic, shared with the tests
// ---------------------------------------------------------------------------

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
  return (alongMajor / ellipse.semi_major_m) ** 2 + (alongMinor / ellipse.semi_minor_m) ** 2 <= 1;
}

// ---------------------------------------------------------------------------
// Scenario controls
// ---------------------------------------------------------------------------

type Patch = (mutate: (s: Scenario) => void, rerender?: boolean) => void;

const GEOMETRY_OPTIONS = [
  { value: 'as_given' as const, label: 'As listed — use every body' },
  { value: 'clustered' as const, label: 'Clustered — keep one azimuth sector' },
  { value: 'well_spread' as const, label: 'Well spread — farthest-point ordering' },
];

const GEOMETRY_NOTE: Record<string, string> = {
  as_given: 'Every body in the list is used, in the order given.',
  clustered:
    'Only the bodies whose azimuths fit inside one window are kept. This is the geometry that hides a shared bias.',
  well_spread:
    'The bodies are reordered so a round-robin schedule walks the best-separated ones first.',
};

const ASSUMED_MODE_OPTIONS = [
  { value: 'none' as const, label: 'None — the solver must find it by multistart' },
  { value: 'offset_from_truth' as const, label: 'Dead reckoning — a fixed offset from the truth' },
  { value: 'explicit' as const, label: 'Explicit — a position you choose' },
  { value: 'truth' as const, label: 'The truth itself — initialisation study only' },
];

const ASSUMED_MODE_NOTE: Record<string, string> = {
  none: 'No assumed position at all.',
  offset_from_truth:
    'What a navigator actually has. It leaks a bounded amount of truth — the fix is within this distance of it — and the session says so in its notes.',
  explicit: 'Unrelated to the truth, so it leaks nothing.',
  truth: 'Not an honest experiment: the session records that it was started from the answer.',
};

const ROLE_OPTIONS = [
  { value: 'initializer' as const, label: 'Initializer only (does not influence the answer)' },
  { value: 'prior' as const, label: 'Prior (influences the answer; reported)' },
  { value: 'disabled' as const, label: 'Disabled' },
];

function truthControls(scenario: Scenario, patch: Patch): HTMLElement {
  const wrong = scenario.wrong_sight;
  return h(
    'div',
    { class: 'truth-group' },
    note(
      'These seed the generator. None of them is written into the session: the solver never sees any of it.',
    ),
    h(
      'div',
      { class: 'grid-2' },
      field(
        'Seed',
        numberInput(scenario.seed, (v) => patch((s) => { s.seed = Math.round(v); }), {
          step: '1',
          min: '0',
        }),
        'The same seed always produces the same session.',
      ),
      field(
        'True latitude, degrees (north +)',
        numberInput(scenario.truth.lat_deg, (v) => patch((s) => { s.truth.lat_deg = v; }), {
          step: '0.0001',
          min: '-90',
          max: '90',
        }),
      ),
      field(
        'True longitude, degrees (east +)',
        numberInput(scenario.truth.lon_deg, (v) => patch((s) => { s.truth.lon_deg = v; }), {
          step: '0.0001',
          min: '-180',
          max: '180',
        }),
      ),
      field(
        'First true sight, UTC',
        textInput(scenario.start_utc, (v) => patch((s) => { s.start_utc = v; })),
        'RFC 3339 with a trailing Z.',
      ),
      field(
        'Independent noise, arcminutes (1 sigma)',
        numberInput(scenario.altitude_noise_arcmin, (v) =>
          patch((s) => { s.altitude_noise_arcmin = v; }), { step: '0.1', min: '0' }),
        'Different on every sight. This is the error that more sights reduce.',
      ),
      field(
        'Shared altitude bias, arcminutes',
        numberInput(scenario.shared_altitude_bias_arcmin, (v) =>
          patch((s) => { s.shared_altitude_bias_arcmin = v; }), { step: '0.1' }),
        'The same on every sight. More sights do NOT reduce it, and the residuals stay small while the position is wrong.',
      ),
      field(
        'Clock offset, seconds (recorded − true)',
        numberInput(scenario.clock_offset_s, (v) => patch((s) => { s.clock_offset_s = v; }), {
          step: '1',
        }),
        'Positive means the clock runs fast. For star sights this is nearly the same unknown as longitude.',
      ),
      field(
        'Missing fraction',
        numberInput(scenario.missing_fraction, (v) =>
          patch((s) => { s.missing_fraction = Math.min(Math.max(v, 0), 0.9); }), {
          step: '0.1',
          min: '0',
          max: '0.9',
        }),
        'Dropped as an exact count: round(scheduled × fraction).',
      ),
    ),
    h(
      'div',
      { class: 'grid-2' },
      checkbox(wrong !== null, 'Include one deliberately wrong sight', (v) =>
        patch((s) => {
          s.wrong_sight = v ? { index: 0, error_arcmin: 15 } : null;
        }, true),
      ),
      wrong
        ? field(
            'Which emitted sight (0-based)',
            numberInput(wrong.index, (v) =>
              patch((s) => {
                if (s.wrong_sight) s.wrong_sight.index = Math.max(0, Math.round(v));
              }), { step: '1', min: '0' }),
          )
        : h('div', {}),
      wrong
        ? field(
            'Altitude error on that sight, arcminutes',
            numberInput(wrong.error_arcmin, (v) =>
              patch((s) => {
                if (s.wrong_sight) s.wrong_sight.error_arcmin = v;
              }), { step: '1' }),
          )
        : h('div', {}),
    ),
  );
}

function reportedControls(scenario: Scenario, patch: Patch): HTMLElement {
  const reportTrue = scenario.reported_sigma_arcmin === null;
  return h(
    'div',
    { class: 'reported-group' },
    note(
      'These are written into the session. They are what the solver is told, and they need not match what was actually done above.',
    ),
    h(
      'div',
      { class: 'grid-2' },
      checkbox(
        reportTrue,
        'Report the true noise as the sight uncertainty (the honest case)',
        (v) =>
          patch((s) => {
            s.reported_sigma_arcmin = v ? null : s.altitude_noise_arcmin || 1;
          }, true),
      ),
      reportTrue
        ? h('div', {})
        : field(
            'Reported sigma per sight, arcminutes',
            numberInput(scenario.reported_sigma_arcmin ?? 1, (v) =>
              patch((s) => { s.reported_sigma_arcmin = v; }), { step: '0.1', min: '0.01' }),
            'Deliberately misreported: the estimator is told something the data does not obey.',
          ),
      field(
        'Reported clock uncertainty, seconds',
        numberInput(scenario.reported_clock_uncertainty_s, (v) =>
          patch((s) => { s.reported_clock_uncertainty_s = v; }), { step: '1', min: '0' }),
        'Propagated into an east-west term of the position uncertainty. Declaring none does not make a clock offset go away.',
      ),
      field(
        'Almanac lookup',
        select(
          scenario.almanac_lookup,
          [
            { value: 'recorded_time' as const, label: 'At the recorded (possibly wrong) time' },
            { value: 'true_time' as const, label: 'At the true time — control case' },
          ],
          (v) => patch((s) => { s.almanac_lookup = v; }),
        ),
        'Looking a body up at the time you believe is what makes a clock offset move the fix.',
      ),
      field(
        'Assumed position',
        select(
          scenario.assumed_position.mode.mode,
          ASSUMED_MODE_OPTIONS,
          (v) =>
            patch((s) => {
              s.assumed_position.mode =
                v === 'offset_from_truth'
                  ? { mode: 'offset_from_truth', distance_nm: 25, bearing_deg: 300 }
                  : v === 'explicit'
                    ? { mode: 'explicit', lat_deg: s.truth.lat_deg, lon_deg: s.truth.lon_deg }
                    : v === 'truth'
                      ? { mode: 'truth' }
                      : { mode: 'none' };
            }, true),
        ),
        ASSUMED_MODE_NOTE[scenario.assumed_position.mode.mode],
      ),
      field(
        'What it is allowed to do',
        select(scenario.assumed_position.role.role, ROLE_OPTIONS, (v) =>
          patch((s) => {
            s.assumed_position.role =
              v === 'prior'
                ? { role: 'prior', sigma_nm: 20 }
                : v === 'disabled'
                  ? { role: 'disabled' }
                  : { role: 'initializer' };
          }, true),
        ),
      ),
      scenario.assumed_position.mode.mode === 'offset_from_truth'
        ? field(
            'Dead-reckoning distance, nautical miles',
            numberInput(scenario.assumed_position.mode.distance_nm, (v) =>
              patch((s) => {
                if (s.assumed_position.mode.mode === 'offset_from_truth') {
                  s.assumed_position.mode.distance_nm = v;
                }
              }), { step: '1', min: '0' }),
          )
        : null,
      scenario.assumed_position.mode.mode === 'offset_from_truth'
        ? field(
            'Dead-reckoning bearing, degrees true',
            numberInput(scenario.assumed_position.mode.bearing_deg, (v) =>
              patch((s) => {
                if (s.assumed_position.mode.mode === 'offset_from_truth') {
                  s.assumed_position.mode.bearing_deg = v;
                }
              }), { step: '1', min: '0', max: '360' }),
          )
        : null,
    ),
  );
}

function skyControls(scenario: Scenario, patch: Patch): HTMLElement {
  const emitted = scenario.altitude_kind;
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'grid-2' },
      field(
        'Sights scheduled',
        numberInput(scenario.schedule.count, (v) =>
          patch((s) => { s.schedule.count = Math.max(1, Math.round(v)); }), { step: '1', min: '1' }),
      ),
      field(
        'Seconds between sights',
        numberInput(scenario.schedule.spacing_s, (v) =>
          patch((s) => { s.schedule.spacing_s = Math.max(0, v); }), { step: '10', min: '0' }),
      ),
      field(
        'Body order',
        select(
          scenario.schedule.ordering,
          [
            { value: 'round_robin' as const, label: 'Round robin — one round of the sky, then another' },
            { value: 'sequential' as const, label: 'Sequential — all of one body, then the next' },
          ],
          (v) => patch((s) => { s.schedule.ordering = v; }),
        ),
      ),
      field(
        'Geometry preset',
        select(scenario.geometry.preset, GEOMETRY_OPTIONS, (v) =>
          patch((s) => {
            s.geometry =
              v === 'clustered'
                ? { preset: 'clustered', window_deg: 60 }
                : v === 'well_spread'
                  ? { preset: 'well_spread', keep: null }
                  : { preset: 'as_given' };
          }, true),
        ),
        GEOMETRY_NOTE[scenario.geometry.preset],
      ),
      scenario.geometry.preset === 'clustered'
        ? field(
            'Azimuth window, degrees',
            numberInput(scenario.geometry.window_deg, (v) =>
              patch((s) => {
                if (s.geometry.preset === 'clustered') s.geometry.window_deg = v;
              }), { step: '5', min: '1', max: '359' }),
          )
        : null,
      field(
        'What the session records',
        select(
          emitted.kind,
          [
            { value: 'observed_ho' as const, label: 'Observed Ho — already corrected' },
            { value: 'sextant_hs' as const, label: 'Sextant Hs — raw, over a sea horizon' },
          ],
          (v) =>
            patch((s) => {
              s.altitude_kind =
                v === 'sextant_hs'
                  ? {
                      kind: 'sextant_hs',
                      height_of_eye_m: 2,
                      index_correction_arcmin: -2,
                      pressure_hpa: 1010,
                      temperature_c: 10,
                    }
                  : { kind: 'observed_ho' };
            }, true),
        ),
        emitted.kind === 'sextant_hs'
          ? 'The correction chain is run backwards, so reducing the session has real work to do.'
          : 'The reducer has nothing to do; the solver consumes the altitudes as they stand.',
      ),
      emitted.kind === 'sextant_hs'
        ? field(
            'Height of eye, metres',
            numberInput(emitted.height_of_eye_m, (v) =>
              patch((s) => {
                if (s.altitude_kind.kind === 'sextant_hs') s.altitude_kind.height_of_eye_m = v;
              }), { step: '0.1', min: '0' }),
          )
        : null,
      emitted.kind === 'sextant_hs'
        ? field(
            'Index correction, arcminutes (added to the reading)',
            numberInput(emitted.index_correction_arcmin, (v) =>
              patch((s) => {
                if (s.altitude_kind.kind === 'sextant_hs') {
                  s.altitude_kind.index_correction_arcmin = v;
                }
              }), { step: '0.1' }),
          )
        : null,
    ),
    h(
      'details',
      { class: 'sources' },
      h('summary', {}, `Bodies in this scenario (${scenario.sources.length})`),
      h(
        'ul',
        { class: 'explain' },
        ...scenario.sources.map((source) =>
          h(
            'li',
            {},
            h('strong', {}, source.name),
            source.source === 'supplied'
              ? ` — supplied direction: GHA ${fixed(source.gha_deg_at_start, 3)}° at the start, advancing ${fixed(source.gha_rate_deg_per_hour, 4)}°/h, declination ${fixed(source.dec_deg, 3)}°`
              : ' — a real body, resolved by the star catalogue at the recorded time',
          ),
        ),
      ),
      note(
        'The sky is chosen by the scenario, not edited here. Load a different demo to change the bodies.',
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

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
      h('div', { class: 'kv' }, h('dt', {}, 'Longitude difference'), h('dd', {}, `${fixed(truth.lon_deg - fix.position.lon_deg, 4)}° (truth − fix)`)),
      h('div', { class: 'kv' }, h('dt', {}, 'Predicted 1-sigma'), h('dd', {}, `${metres(fix.sigma_north_m)} north, ${metres(fix.sigma_east_m)} east (combined ${metres(predicted)})`)),
      h('div', { class: 'kv' }, h('dt', {}, 'Error ÷ predicted sigma'), h('dd', {}, predicted > 0 ? fixed(distance / predicted, 2) : 'n/a')),
      h('div', { class: 'kv' }, h('dt', {}, 'Largest residual'), h('dd', {}, `${fixed(Math.max(...fix.residuals.map((r) => Math.abs(r.residual_arcmin))), 2)}′`)),
    ),
    h('p', { class: inside === false ? 'plain outside' : 'plain' }, verdict),
  );
}

function experimentPanel(store: Store): HTMLElement {
  const sim = store.state.simulation;
  const summary = sim.summary;
  const body = h('div', {});

  if (summary) {
    const a = summary.aggregate;
    const percent = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)} %`);
    body.appendChild(
      h(
        'dl',
        { class: 'facts' },
        h('div', { class: 'kv' }, h('dt', {}, 'Repetitions'), h('dd', {}, `${a.repetitions} run, ${a.evaluated} with an ellipse to score`)),
        h('div', { class: 'kv' }, h('dt', {}, 'Result kinds'), h('dd', {}, a.result_kind_counts.map(([k, n]) => `${k} × ${n}`).join(', ') || 'none')),
        h(
          'div',
          { class: 'kv' },
          h('dt', {}, 'Coverage of the 95 % ellipse'),
          h(
            'dd',
            {},
            percent(a.coverage_fraction),
            a.coverage_ci95
              ? ` (Wilson 95 % interval ${percent(a.coverage_ci95[0])} to ${percent(a.coverage_ci95[1])})`
              : '',
          ),
        ),
        h('div', { class: 'kv' }, h('dt', {}, 'RMS true error'), h('dd', {}, a.rms_error_m === null ? 'n/a' : metres(a.rms_error_m))),
        h('div', { class: 'kv' }, h('dt', {}, 'RMS predicted sigma'), h('dd', {}, a.rms_predicted_sigma_m === null ? 'n/a' : metres(a.rms_predicted_sigma_m))),
        h('div', { class: 'kv' }, h('dt', {}, 'Error ÷ sigma'), h('dd', {}, a.error_to_sigma_ratio === null ? 'n/a' : fixed(a.error_to_sigma_ratio, 2))),
        h('div', { class: 'kv' }, h('dt', {}, 'Mean residual RMS'), h('dd', {}, a.mean_residual_rms_arcmin === null ? 'n/a' : `${fixed(a.mean_residual_rms_arcmin, 3)}′`)),
      ),
    );
    body.appendChild(
      h(
        'p',
        { class: 'plain' },
        a.coverage_fraction === null
          ? 'No run produced an ellipse, so there is no coverage to report.'
          : a.coverage_ci95 && a.coverage_ci95[1] < 0.95
            ? 'Coverage is below the nominal 95 % and the interval does not reach it. The ellipse is optimistic for this scenario — which is what a shared error, rather than independent noise, does to it.'
            : a.coverage_ci95 && a.coverage_ci95[0] > 0.95
              ? 'Coverage is above the nominal 95 %: the ellipse is conservative here.'
              : 'Coverage is consistent with the nominal 95 % at this sample size. A wider interval means only that more repetitions would say more.',
      ),
    );
    for (const n of summary.notes) body.appendChild(note(n));
  } else {
    body.appendChild(h('p', { class: 'muted' }, 'Not run yet.'));
  }

  return panel(
    'Coverage experiment',
    note(
      'Repeat the scenario with a fresh seed each time and count how often the truth falls inside the nominal 95 % ellipse. The interval is a Wilson score interval, which stays sensible near 0 and 1.',
    ),
    h(
      'div',
      { class: 'grid-2' },
      field(
        'Repetitions',
        numberInput(
          sim.repetitions,
          (v) =>
            store.set(
              {
                simulation: {
                  ...store.state.simulation,
                  repetitions: Math.min(Math.max(Math.round(v), 1), MAX_REPETITIONS),
                },
              },
              { quiet: true },
            ),
          { step: '10', min: '1', max: String(MAX_REPETITIONS) },
        ),
        `At most ${MAX_REPETITIONS}: the solver runs on this page's own thread.`,
      ),
    ),
    toolbar(
      button(
        sim.running ? 'Running…' : 'Run the coverage experiment',
        () => void runExperiment(store),
        { class: 'primary' },
      ),
    ),
    body,
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function renderSimulator(store: Store, root: HTMLElement): void {
  clear(root);
  const sim = store.state.simulation;
  const scenario = sim.scenario;

  if (!scenario) {
    root.appendChild(
      panel(
        'Simulator',
        h('p', { class: 'muted' }, 'Waiting for the packaged scenarios to load from the core.'),
      ),
    );
    return;
  }

  const patch: Patch = (mutate, rerender = false) => {
    const next = structuredClone(store.state.simulation.scenario!);
    mutate(next);
    store.set(
      { simulation: { ...store.state.simulation, scenario: next } },
      { quiet: !rerender },
    );
    if (rerender) renderSimulator(store, root);
  };

  const demoSelect = h('select', { id: 'sim-demo' }) as HTMLSelectElement;
  demoSelect.appendChild(h('option', { value: '' }, 'Start from a packaged scenario…'));
  for (const demo of store.state.demos) {
    demoSelect.appendChild(h('option', { value: demo.name }, demo.name));
  }
  demoSelect.value = scenario.name;
  demoSelect.addEventListener('change', () => {
    const demo = store.state.demos.find((d) => d.name === demoSelect.value);
    if (!demo) return;
    store.set({
      simulation: {
        ...store.state.simulation,
        scenario: structuredClone(demo.scenario),
        session: null,
        truth: null,
        fix: null,
        summary: null,
        error: null,
      },
    });
    renderSimulator(store, root);
  });

  root.appendChild(
    panel(
      'Scenario',
      note(
        'A seeded generator makes a session from a known position, then the solver is given that session and nothing else. The truth is stored beside the session, never inside it.',
      ),
      toolbar(demoSelect),
      scenario.description ? h('p', { class: 'plain' }, scenario.description) : null,
      field('Scenario name', textInput(scenario.name, (v) => patch((s) => { s.name = v; }))),
      h('h3', { class: 'group-heading truth-heading' }, 'What is actually done to the data (truth)'),
      truthControls(scenario, patch),
      h('h3', { class: 'group-heading reported-heading' }, 'What the session tells the solver (reported)'),
      reportedControls(scenario, patch),
      h('h3', { class: 'group-heading' }, 'The sky and the schedule'),
      skyControls(scenario, patch),
      toolbar(button('Run: simulate, then solve', () => void runSimulation(store), { class: 'primary' })),
      sim.error ? h('p', { class: 'error' }, sim.error) : null,
    ),
  );

  if (!sim.session || !sim.truth) {
    root.appendChild(panel('No run yet', h('p', { class: 'muted' }, 'Press “Run”.')));
    root.appendChild(experimentPanel(store));
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
        h('div', { class: 'kv' }, h('dt', {}, 'Seed'), h('dd', { class: 'sim' }, `${sim.truth.seed} — simulated`)),
        h('div', { class: 'kv' }, h('dt', {}, 'Clock offset injected'), h('dd', { class: 'sim' }, `${sim.truth.clock_offset_s} s — simulated`)),
        h('div', { class: 'kv' }, h('dt', {}, 'Shared bias injected'), h('dd', { class: 'sim' }, `${sim.truth.shared_altitude_bias_arcmin}′ — simulated`)),
        h('div', { class: 'kv' }, h('dt', {}, 'Deliberately wrong sights'), h('dd', { class: 'sim' }, sim.truth.wrong_sight_ids.length > 0 ? `${sim.truth.wrong_sight_ids.join(', ')} — simulated` : 'none')),
      ),
      sim.truth.notes ? note(sim.truth.notes) : null,
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
    void buildPlotSpec(store, sim.fix, { truth: sim.truth.position, session: sim.session }).then(
      (spec) => {
        clear(plotHolder);
        plotHolder.appendChild(
          renderPlotPanel(
            store,
            spec,
            'Position plot with truth',
            'The asterisk is the simulated truth. It appears on this view only.',
          ),
        );
      },
    );

    if (sim.fix.kind === 'unique') {
      root.appendChild(panel('Conditioning', conditioningBlock(sim.fix.fix.conditioning)));
    }
    root.appendChild(panel('Warnings', warningList(sim.fix.warnings, 'The solver reported no warnings.')));
  }

  root.appendChild(experimentPanel(store));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function runSimulation(store: Store): Promise<void> {
  const scenario = store.state.simulation.scenario;
  if (!scenario) return;
  try {
    const output = await store.api.simulate(scenario);
    const fix = await store.api.solve(
      output.session,
      { ...defaultSolveOptions(), clock_uncertainty_s: output.session.clock.uncertainty_s },
      store.state.ephemerisMode,
    );
    store.set({
      simulation: {
        ...store.state.simulation,
        session: output.session,
        truth: output.truth,
        fix,
        error: null,
      },
    });
  } catch (error) {
    store.set({
      simulation: {
        ...store.state.simulation,
        session: null,
        truth: null,
        fix: null,
        error: String(error),
      },
    });
  }
}

export async function runExperiment(store: Store): Promise<void> {
  const scenario = store.state.simulation.scenario;
  if (!scenario) return;
  store.set({ simulation: { ...store.state.simulation, running: true } });
  // Yield once so the button repaints before the solver takes the thread.
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const summary = await store.api.experiment({
      scenario,
      solve_options: defaultSolveOptions(),
      repetitions: store.state.simulation.repetitions,
    });
    store.set({
      simulation: { ...store.state.simulation, summary, running: false, error: null },
    });
  } catch (error) {
    store.set({
      simulation: {
        ...store.state.simulation,
        summary: null,
        running: false,
        error: String(error),
      },
    });
  }
}
