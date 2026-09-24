/**
 * The Simulator tab: everything the workbench's simulator view could do, restyled. OWNER:
 * learn agent.
 *
 * - Scenario editing, in the three groups docs/SIMULATOR.md keeps apart: what is really
 *   done to the sights (the answer key; never written into the session), what the session
 *   reports and the solver is told, and the sky and the schedule. Plus the two solver
 *   choices the stories use (robust weighting, estimating a shared bias).
 * - Generate and solve: the core simulates, the session alone goes to the solver, and the
 *   result is compared with the answer key, drawn, and explained.
 * - The coverage experiment: the scenario repeated with fresh noise, scored by the core's
 *   experiment runner, with the verdict band.
 *
 * The assumed-position mode "the truth itself" is not offered: it would start the solver
 * at the answer (the honesty rules of run.ts refuse such a run in any case).
 */

import { h } from '../../dom.js';
import { MAX_REPETITIONS, type AssumedPositionMode, type BodySource, type Scenario } from '../../api/adapter.js';
import { NM_M, type AssumedPositionRole } from '../../types.js';
import { button, icon } from '../theme/index.js';
import type { LearnEnv, SimState } from './env.js';
import { explain } from './explain.js';
import { experimentResult } from './experiment-view.js';
import { factsOf } from './facts.js';
import { checkField, fieldGroup, numberField, selectField, textField, type Choice } from './form.js';
import { answerKey, correctionTable, figure, kindChip, mockBadge, numbersList, residualChart, simulatedBadge, tiles, warningsList, type Figure } from './result.js';
import { EPHEMERIS_MODE, experimentFor, simulateAndSolve, truthGuardRadiusNm } from './run.js';
import { handOffToNavigate } from '../navigate/handoff.js';
import { STORIES, type SimulatorPreset } from './stories.js';
import { distanceM } from './geo.js';

// ---------------------------------------------------------------------------------------
// Actions (also used by the stories' "try next" buttons through the view's env)

function setSim(env: LearnEnv, patch: Partial<SimState>): void {
  env.state.patch({ sim: patch });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Apply a story's "open in the Simulator" preset. */
export function applyPreset(scenario: Scenario, preset: SimulatorPreset | null | undefined): Scenario {
  const s = structuredClone(scenario);
  if (preset === 'no-bias') s.shared_altitude_bias_arcmin = 0;
  else if (preset === 'clock-sigma-60') s.reported_clock_uncertainty_s = 60;
  else if (preset === 'eye-height-10' && s.altitude_kind.kind === 'sextant_hs') s.altitude_kind.height_of_eye_m = 10;
  return s;
}

export async function generateAndSolve(env: LearnEnv): Promise<void> {
  const sim = env.state.get().sim;
  if (!sim.scenario || sim.runStatus === 'running') return;
  setSim(env, { runStatus: 'running', runError: null });
  try {
    const { api } = await env.api();
    const demos = await env.demos();
    const run = await simulateAndSolve(api, { scenario: sim.scenario, choices: sim.choices, demos });
    setSim(env, { run, runStatus: 'idle', runError: null });
  } catch (error) {
    setSim(env, { run: null, runStatus: 'idle', runError: errorText(error) });
  }
}

export async function runExperiment(env: LearnEnv): Promise<void> {
  const sim = env.state.get().sim;
  if (!sim.scenario || sim.expStatus === 'running') return;
  setSim(env, { expStatus: 'running', expError: null });
  // Let "Running…" paint before the solver takes the page's thread.
  await new Promise((resolve) => setTimeout(resolve, 40));
  try {
    const { api } = await env.api();
    const scenario = structuredClone(sim.scenario);
    const summary = await api.experiment(experimentFor(scenario, sim.repetitions, sim.choices));
    setSim(env, { summary, summaryScenario: scenario, expStatus: 'idle', expError: null });
  } catch (error) {
    setSim(env, { summary: null, summaryScenario: null, expStatus: 'idle', expError: errorText(error) });
  }
}

// ---------------------------------------------------------------------------------------
// Editor

const GEOMETRY: Choice<Scenario['geometry']['preset']>[] = [
  { value: 'as_given', label: 'As listed: use every body' },
  { value: 'clustered', label: 'Clustered: keep one patch of sky' },
  { value: 'well_spread', label: 'Well spread: the best-separated bodies' },
];

const ASSUMED: Choice<AssumedPositionMode['mode']>[] = [
  { value: 'offset_from_truth', label: 'Dead reckoning: a set distance from the truth' },
  { value: 'explicit', label: 'A position you type' },
  { value: 'none', label: 'None: the solver searches the whole globe' },
];

const ROLES: Choice<AssumedPositionRole['role']>[] = [
  { value: 'initializer', label: 'Starting point only (does not pull the answer)' },
  { value: 'prior', label: 'Prior (pulls the answer; reported)' },
  { value: 'disabled', label: 'Not used' },
];

const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

function sourceText(b: BodySource): string {
  return b.source === 'supplied'
    ? `${b.name}: its own direction, GHA ${b.gha_deg_at_start.toFixed(3)}° at the start, turning ${b.gha_rate_deg_per_hour.toFixed(4)}° an hour, declination ${b.dec_deg.toFixed(3)}°`
    : `${b.name}: a real star, looked up in the built-in almanac at the recorded time`;
}

function editor(env: LearnEnv, scenario: Scenario): HTMLElement {
  const patch = (mutate: (s: Scenario) => void, rebuild = false): void => {
    const sim = env.state.get().sim;
    if (!sim.scenario) return;
    const next = structuredClone(sim.scenario);
    mutate(next);
    setSim(env, { scenario: next, ...(rebuild ? { editorVersion: sim.editorVersion + 1 } : {}) });
  };
  const s = scenario;
  const wrong = s.wrong_sight;
  const mode = s.assumed_position.mode;
  const role = s.assumed_position.role;
  const guard = truthGuardRadiusNm(role.role === 'prior' ? role.sigma_nm : null);
  const leak =
    role.role !== 'disabled' &&
    ((mode.mode === 'offset_from_truth' && mode.distance_nm <= guard) ||
      (mode.mode === 'explicit' && distanceM({ lat_deg: mode.lat_deg, lon_deg: mode.lon_deg }, s.truth) / NM_M <= guard) ||
      mode.mode === 'truth');

  const truthGroup = fieldGroup(
    'What is really done to the sights',
    'The answer key. These seed the generator and are never written into the session: the solver sees none of them.',
    'truth',
    numberField({ id: 'sfl-f-seed', label: 'Seed', value: s.seed, min: 0, step: 1, integer: true, help: 'The same seed always gives the same sights.' }, (v) => patch((x) => void (x.seed = v))),
    numberField({ id: 'sfl-f-lat', label: 'True latitude (north +)', value: s.truth.lat_deg, min: -90, max: 90, step: 0.0001, unit: '°' }, (v) => patch((x) => void (x.truth.lat_deg = v))),
    numberField({ id: 'sfl-f-lon', label: 'True longitude (east +)', value: s.truth.lon_deg, min: -180, max: 180, step: 0.0001, unit: '°' }, (v) => patch((x) => void (x.truth.lon_deg = v))),
    textField(
      { id: 'sfl-f-start', label: 'First sight (UTC)', value: s.start_utc, pattern: RFC3339_Z, invalid: 'Use the form 2026-10-01T01:30:00Z.', help: 'RFC 3339 with a trailing Z.' },
      (v) => patch((x) => void (x.start_utc = v)),
    ),
    numberField(
      { id: 'sfl-f-noise', label: 'Random error per sight (1 σ)', value: s.altitude_noise_arcmin, min: 0, step: 0.1, unit: '′', help: 'Different on every sight. More sights average it down.' },
      (v) => patch((x) => void (x.altitude_noise_arcmin = v)),
    ),
    numberField(
      { id: 'sfl-f-bias', label: 'Shared altitude bias', value: s.shared_altitude_bias_arcmin, step: 0.1, unit: '′', help: 'The same on every sight (+ reads high). More sights do not reduce it.' },
      (v) => patch((x) => void (x.shared_altitude_bias_arcmin = v)),
    ),
    numberField(
      { id: 'sfl-f-clock', label: 'Clock error (recorded − true)', value: s.clock_offset_s, step: 1, unit: 's', help: '+ means the watch is fast. For star sights it moves the fix east–west.' },
      (v) => patch((x) => void (x.clock_offset_s = v)),
    ),
    numberField(
      { id: 'sfl-f-missing', label: 'Share of sights lost', value: s.missing_fraction, min: 0, max: 0.9, step: 0.1, help: 'Dropped as an exact count: round(scheduled × share).' },
      (v) => patch((x) => void (x.missing_fraction = v)),
    ),
    checkField({ id: 'sfl-f-wrong', label: 'One sight deliberately wrong', checked: wrong !== null }, (on) =>
      patch((x) => void (x.wrong_sight = on ? { index: 0, error_arcmin: 8 } : null), true),
    ),
    wrong
      ? numberField({ id: 'sfl-f-wrong-i', label: 'Which sight (0 = the first written)', value: wrong.index, min: 0, step: 1, integer: true }, (v) =>
          patch((x) => {
            if (x.wrong_sight) x.wrong_sight.index = v;
          }),
        )
      : null,
    wrong
      ? numberField({ id: 'sfl-f-wrong-e', label: 'Its extra error', value: wrong.error_arcmin, step: 1, unit: '′' }, (v) =>
          patch((x) => {
            if (x.wrong_sight) x.wrong_sight.error_arcmin = v;
          }),
        )
      : null,
  );

  const reportTrue = s.reported_sigma_arcmin === null;
  const assumedOptions: Choice<AssumedPositionMode['mode']>[] =
    mode.mode === 'truth' ? [...ASSUMED, { value: 'truth', label: 'The truth itself (not offered: it starts the solver at the answer)', disabled: true }] : ASSUMED;
  const reportedGroup = fieldGroup(
    'What the navigator writes down',
    'Written into the session: what the solver is told. It need not match what was really done.',
    'reported',
    checkField({ id: 'sfl-f-honest', label: 'Report the true random error as each sight’s uncertainty (the honest case)', checked: reportTrue }, (on) =>
      patch((x) => void (x.reported_sigma_arcmin = on ? null : x.altitude_noise_arcmin || 1), true),
    ),
    reportTrue
      ? null
      : numberField(
          { id: 'sfl-f-sigma', label: 'Reported uncertainty per sight (1 σ)', value: s.reported_sigma_arcmin ?? 1, min: 0.01, step: 0.1, unit: '′', help: 'The solver is told this, whatever the truth.' },
          (v) => patch((x) => void (x.reported_sigma_arcmin = v)),
        ),
    numberField(
      { id: 'sfl-f-clock-sigma', label: 'Declared clock doubt (1 σ)', value: s.reported_clock_uncertainty_s, min: 0, step: 1, unit: 's', help: 'Widens the ellipse east–west. Declaring none does not make a clock error go away.' },
      (v) => patch((x) => void (x.reported_clock_uncertainty_s = v)),
    ),
    selectField(
      {
        id: 'sfl-f-lookup',
        label: 'Almanac looked up at',
        value: s.almanac_lookup,
        options: [
          { value: 'recorded_time', label: 'The recorded time (as a navigator would)' },
          { value: 'true_time', label: 'The true time (a control: the clock error then does nothing)' },
        ],
      },
      (v) => patch((x) => void (x.almanac_lookup = v)),
    ),
    selectField({ id: 'sfl-f-assumed', label: 'Assumed position', value: mode.mode, options: assumedOptions }, (v) =>
      patch((x) => {
        x.assumed_position.mode =
          v === 'offset_from_truth'
            ? { mode: 'offset_from_truth', distance_nm: 25, bearing_deg: 300 }
            : v === 'explicit'
              ? { mode: 'explicit', lat_deg: Math.round(x.truth.lat_deg), lon_deg: Math.round(x.truth.lon_deg) }
              : { mode: 'none' };
      }, true),
    ),
    mode.mode === 'offset_from_truth'
      ? numberField({ id: 'sfl-f-dr-d', label: 'Dead-reckoning error', value: mode.distance_nm, min: 0, step: 1, unit: 'NM', help: 'A real navigator’s rough position. The session’s notes disclose it.' }, (v) =>
          patch((x) => {
            if (x.assumed_position.mode.mode === 'offset_from_truth') x.assumed_position.mode.distance_nm = v;
          }, true),
        )
      : null,
    mode.mode === 'offset_from_truth'
      ? numberField({ id: 'sfl-f-dr-b', label: 'Dead-reckoning error, direction', value: mode.bearing_deg, min: 0, max: 360, step: 1, unit: '°' }, (v) =>
          patch((x) => {
            if (x.assumed_position.mode.mode === 'offset_from_truth') x.assumed_position.mode.bearing_deg = v;
          }),
        )
      : null,
    mode.mode === 'explicit'
      ? numberField({ id: 'sfl-f-ex-lat', label: 'Assumed latitude', value: mode.lat_deg, min: -90, max: 90, step: 0.1, unit: '°', help: 'Starts at the truth rounded to whole degrees; type any position.' }, (v) =>
          patch((x) => {
            if (x.assumed_position.mode.mode === 'explicit') x.assumed_position.mode.lat_deg = v;
          }),
        )
      : null,
    mode.mode === 'explicit'
      ? numberField({ id: 'sfl-f-ex-lon', label: 'Assumed longitude', value: mode.lon_deg, min: -180, max: 180, step: 0.1, unit: '°' }, (v) =>
          patch((x) => {
            if (x.assumed_position.mode.mode === 'explicit') x.assumed_position.mode.lon_deg = v;
          }),
        )
      : null,
    mode.mode === 'none'
      ? null
      : selectField({ id: 'sfl-f-role', label: 'The solver may use it as', value: role.role, options: ROLES }, (v) =>
          patch((x) => {
            x.assumed_position.role = v === 'prior' ? { role: 'prior', sigma_nm: 20 } : v === 'disabled' ? { role: 'disabled' } : { role: 'initializer' };
          }, true),
        ),
    mode.mode !== 'none' && role.role === 'prior'
      ? numberField({ id: 'sfl-f-prior', label: 'Prior uncertainty (1 σ)', value: role.sigma_nm, min: 0.1, step: 1, unit: 'NM' }, (v) =>
          patch((x) => {
            if (x.assumed_position.role.role === 'prior') x.assumed_position.role.sigma_nm = v;
          }, true),
        )
      : null,
    leak
      ? h(
          'p',
          { class: 'sf-notice sf-notice--caution sfl-field--wide' },
          icon('caution'),
          h('span', {}, 'This would start the solver at, or pull it towards, the answer, so runs are refused. Move the assumed position further away, or stop the solver using it.'),
        )
      : null,
  );

  const alt = s.altitude_kind;
  const skyGroup = fieldGroup(
    'The sky and the schedule',
    'Which bodies, how many sights, and what the observer writes down.',
    'sky',
    numberField({ id: 'sfl-f-count', label: 'Sights scheduled', value: s.schedule.count, min: 1, max: 500, step: 1, integer: true }, (v) => patch((x) => void (x.schedule.count = v))),
    numberField({ id: 'sfl-f-spacing', label: 'Time between sights', value: s.schedule.spacing_s, min: 0, step: 10, unit: 's' }, (v) => patch((x) => void (x.schedule.spacing_s = v))),
    selectField(
      {
        id: 'sfl-f-order',
        label: 'Order',
        value: s.schedule.ordering,
        options: [
          { value: 'round_robin', label: 'Round the sky, then round again' },
          { value: 'sequential', label: 'All of one body, then the next' },
        ],
      },
      (v) => patch((x) => void (x.schedule.ordering = v)),
    ),
    selectField({ id: 'sfl-f-geometry', label: 'Which bodies', value: s.geometry.preset, options: GEOMETRY }, (v) =>
      patch((x) => {
        x.geometry = v === 'clustered' ? { preset: 'clustered', window_deg: 30 } : v === 'well_spread' ? { preset: 'well_spread', keep: null } : { preset: 'as_given' };
      }, true),
    ),
    s.geometry.preset === 'clustered'
      ? numberField({ id: 'sfl-f-window', label: 'Patch of sky, width', value: s.geometry.window_deg, min: 1, max: 359, step: 5, unit: '°' }, (v) =>
          patch((x) => {
            if (x.geometry.preset === 'clustered') x.geometry.window_deg = v;
          }),
        )
      : null,
    selectField(
      {
        id: 'sfl-f-kind',
        label: 'The session records',
        value: alt.kind,
        options: [
          { value: 'observed_ho', label: 'Corrected heights (nothing left to correct)' },
          { value: 'sextant_hs', label: 'Raw sextant readings over a sea horizon' },
        ],
      },
      (v) =>
        patch((x) => {
          x.altitude_kind = v === 'sextant_hs' ? { kind: 'sextant_hs', height_of_eye_m: 2, index_correction_arcmin: -1.5, pressure_hpa: 1010, temperature_c: 10 } : { kind: 'observed_ho' };
        }, true),
    ),
    alt.kind === 'sextant_hs'
      ? numberField({ id: 'sfl-f-eye', label: 'Height of eye', value: alt.height_of_eye_m, min: 0, max: 500, step: 0.5, unit: 'm' }, (v) =>
          patch((x) => {
            if (x.altitude_kind.kind === 'sextant_hs') x.altitude_kind.height_of_eye_m = v;
          }),
        )
      : null,
    alt.kind === 'sextant_hs'
      ? numberField({ id: 'sfl-f-ic', label: 'Index correction (added)', value: alt.index_correction_arcmin, min: -60, max: 60, step: 0.1, unit: '′' }, (v) =>
          patch((x) => {
            if (x.altitude_kind.kind === 'sextant_hs') x.altitude_kind.index_correction_arcmin = v;
          }),
        )
      : null,
    alt.kind === 'sextant_hs'
      ? numberField({ id: 'sfl-f-p', label: 'Air pressure', value: alt.pressure_hpa, min: 800, max: 1100, step: 1, unit: 'hPa' }, (v) =>
          patch((x) => {
            if (x.altitude_kind.kind === 'sextant_hs') x.altitude_kind.pressure_hpa = v;
          }),
        )
      : null,
    alt.kind === 'sextant_hs'
      ? numberField({ id: 'sfl-f-t', label: 'Air temperature', value: alt.temperature_c, min: -40, max: 50, step: 1, unit: '°C' }, (v) =>
          patch((x) => {
            if (x.altitude_kind.kind === 'sextant_hs') x.altitude_kind.temperature_c = v;
          }),
        )
      : null,
    h(
      'details',
      { class: 'sfl-bodies sfl-field--wide' },
      h('summary', {}, `The bodies in this scenario (${s.sources.length})`),
      h('ul', {}, ...s.sources.map((b) => h('li', {}, sourceText(b)))),
      h('p', { class: 'sfl-help' }, 'The sky belongs to the scenario; choose another packaged scenario to change the bodies.'),
    ),
  );

  const choices = env.state.get().sim.choices;
  const solverGroup = fieldGroup(
    'What the solver is asked to do',
    'Used for Generate and solve and for every repetition of the experiment.',
    'solver',
    checkField({ id: 'sfl-f-robust', label: 'Robust weighting', checked: choices.robust, help: 'A sight that disagrees strongly with the rest pulls less; the covariance is then approximate.' }, (on) =>
      setSim(env, { choices: { ...env.state.get().sim.choices, robust: on } }),
    ),
    checkField({ id: 'sfl-f-estbias', label: 'Estimate a shared altitude bias', checked: choices.estimateBias, help: 'Adds one unknown shared by every sight. Needs bodies well spread round the sky.' }, (on) =>
      setSim(env, { choices: { ...env.state.get().sim.choices, estimateBias: on } }),
    ),
  );

  const form = h(
    'form',
    { class: 'sfl-editor', 'aria-label': 'Scenario', novalidate: true },
    field('Scenario name', s.name, (v) => patch((x) => void (x.name = v))),
    truthGroup,
    reportedGroup,
    skyGroup,
    solverGroup,
  );
  // Enter in a field commits it; it must never submit (and reload) the page.
  form.addEventListener('submit', (event) => event.preventDefault());
  return form;
}

function field(label: string, value: string, onCommit: (v: string) => void): HTMLElement {
  return textField({ id: 'sfl-f-name', label, value }, onCommit);
}

// ---------------------------------------------------------------------------------------
// Results

function runPanel(env: LearnEnv, sim: SimState): { el: HTMLElement; fig: Figure | null } {
  if (sim.runStatus === 'running') {
    return { el: h('section', { class: 'sfl-panel-box', 'aria-busy': 'true' }, h('h3', { class: 'sfl-h3' }, 'Last run'), h('p', { class: 'sfl-muted' }, 'Simulating and solving…')), fig: null };
  }
  if (sim.runError) {
    return {
      el: h('section', { class: 'sfl-panel-box' }, h('h3', { class: 'sfl-h3' }, 'Last run'), h('div', { class: 'sf-notice sf-notice--error', role: 'alert' }, icon('caution'), h('span', {}, sim.runError))),
      fig: null,
    };
  }
  const run = sim.run;
  if (!run) {
    return {
      el: h(
        'section',
        { class: 'sfl-panel-box sfl-panel-box--empty' },
        h('h3', { class: 'sfl-h3' }, 'Last run'),
        h('p', { class: 'sfl-muted' }, 'Press “Generate and solve”: the core simulates the sights, the solver gets the session alone, and the answer is compared with the answer key here.'),
      ),
      fig: null,
    };
  }
  const fmt = env.fmt();
  const facts = factsOf(run.result, run.truth.position);
  const why = explain(null, run, facts, fmt);
  const stale = JSON.stringify(run.scenario) !== JSON.stringify(sim.scenario);
  const fig = figure(run.result, run.truth, env.figureEnv(run.scenario.name), {
    misfit: { input: { session: run.session, mode: EPHEMERIS_MODE, options: run.options } },
    view: env.state.get().chartView,
    onView: (v) => env.state.patch({ chartView: v }),
    title: run.scenario.name,
  });
  const download = button({
    label: `Download the session: ${run.session.observations.length} sight${run.session.observations.length === 1 ? '' : 's'}, no answer key inside`,
    icon: 'external',
    size: 'sm',
    variant: 'outline',
    tip: 'The session file exactly as the solver received it, in the workbench’s JSON format',
    onClick: () => {
      const blob = new Blob([JSON.stringify(run.session, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `${run.scenario.name || 'session'}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  });
  // Hand the session to the Navigate view: only what the solver received, labelled
  // SIMULATED there; the answer key (run.truth) stays here (navigate/handoff.ts).
  const openInNavigate = button({
    label: 'Open in Navigate',
    icon: 'sextant',
    size: 'sm',
    variant: 'secondary',
    tip: 'Work these simulated sights in the Navigate view: every correction, the fix and the other methods. The answer key stays here.',
    onClick: () => {
      handOffToNavigate(env.ctx.store, {
        session: run.session,
        from: `the Learn simulator’s “${run.scenario.name || 'session'}”`,
        mode: EPHEMERIS_MODE,
        solve: { robust: run.options.robust !== null, estimate_shared_bias: run.options.estimate_shared_bias },
      });
      env.ctx.store.patch({ view: 'navigate' });
    },
  });
  const el = h(
    'section',
    { class: 'sfl-panel-box', 'data-kind': run.result.kind },
    h('div', { class: 'sfl-result__head' }, h('h3', { class: 'sfl-h3' }, `Last run: ${run.scenario.name}`), h('div', { class: 'sfl-result__badges' }, kindChip(run.result), simulatedBadge(), env.engineLabel() === 'mock adapter' ? mockBadge() : null)),
    stale ? h('p', { class: 'sf-notice sf-notice--caution' }, icon('info'), h('span', {}, 'The scenario has changed since this run. Generate and solve again to see the change.')) : null,
    tiles(facts, fmt),
    fig.el,
    h('div', { class: 'sfl-explain' }, ...why.happened.map((p) => h('p', {}, p)), ...why.why.map((p) => h('p', { class: 'sfl-muted' }, p))),
    warningsList(run.result.warnings),
    facts.kind === 'unique' ? residualChart(facts) : null,
    run.reduced && run.reduced.length ? correctionTable(run.reduced) : null,
    answerKey(run.truth, fmt),
    h('details', { class: 'sfl-more' }, h('summary', {}, 'All the numbers'), numbersList(run.result, facts, fmt)),
    h('div', { class: 'sfl-actions' }, openInNavigate, download),
  );
  return { el, fig };
}

function experimentPanel(env: LearnEnv, sim: SimState): HTMLElement {
  const reps = numberField(
    { id: 'sfl-f-reps', label: 'Repetitions', value: sim.repetitions, min: 1, max: MAX_REPETITIONS, step: 10, integer: true, help: `Up to ${MAX_REPETITIONS}. Each takes a few milliseconds and the page waits while they run.` },
    (v) => setSim(env, { repetitions: v }),
  );
  const run = button({
    label: sim.expStatus === 'running' ? 'Running…' : 'Run the coverage experiment',
    icon: 'speed',
    variant: 'primary',
    attrs: sim.expStatus === 'running' ? { disabled: true, 'aria-busy': 'true' } : {},
    onClick: () => void runExperiment(env),
  });
  let body: HTMLElement;
  if (sim.expError) body = h('div', { class: 'sf-notice sf-notice--error', role: 'alert' }, icon('caution'), h('span', {}, sim.expError));
  else if (sim.expStatus === 'running') body = h('p', { class: 'sfl-muted', 'aria-busy': 'true' }, `Running ${sim.repetitions} repetitions…`);
  else if (sim.summary && sim.summaryScenario) {
    const stale = JSON.stringify(sim.summaryScenario) !== JSON.stringify(sim.scenario);
    body = h(
      'div',
      {},
      stale ? h('p', { class: 'sf-notice sf-notice--caution' }, icon('info'), h('span', {}, 'The scenario has changed since this experiment ran.')) : null,
      experimentResult(sim.summary, sim.summaryScenario, env.fmt()),
    );
  } else body = h('p', { class: 'sfl-muted' }, 'Not run yet.');
  return h(
    'section',
    { class: 'sfl-panel-box sfl-exp', 'aria-labelledby': 'sfl-exp-title' },
    h('div', { class: 'sfl-result__head' }, h('h3', { class: 'sfl-h3', id: 'sfl-exp-title' }, 'Coverage experiment'), h('div', { class: 'sfl-result__badges' }, simulatedBadge(), env.engineLabel() === 'mock adapter' ? mockBadge() : null)),
    h(
      'p',
      { class: 'sfl-lede' },
      'Repeat the scenario with fresh random noise each time (seed, seed + 1, …), solve every repetition from its sights alone (no starting point, no prior), ' +
        'and count how often the truth lands inside that run’s 95 % ellipse. An honest error model scores close to 95 %; the interval says how sure that number is.',
    ),
    h('div', { class: 'sfl-exp__controls' }, reps, run),
    body,
  );
}

// ---------------------------------------------------------------------------------------
// The tab

export function simulatorTab(env: LearnEnv): { el: HTMLElement; destroy(): void } {
  const picker = h('select', { id: 'sfl-sim-source', class: 'sf-input sfl-input sfl-select', 'aria-label': 'Start from a packaged scenario' });
  const description = h('p', { class: 'sfl-sim__desc' });
  const go = button({ label: 'Generate and solve', icon: 'play', variant: 'primary', onClick: () => void generateAndSolve(env) });
  const reset = button({
    label: 'Reset',
    size: 'sm',
    variant: 'outline',
    tip: 'Put every field back to the packaged scenario',
    onClick: () => {
      const name = env.state.get().sim.source;
      void env.demos().then((demos) => {
        const demo = demos.find((d) => d.name === name);
        if (demo) setSim(env, { scenario: structuredClone(demo.scenario), editorVersion: env.state.get().sim.editorVersion + 1 });
      });
    },
  });
  const head = h(
    'section',
    { class: 'sfl-sim__head' },
    h(
      'div',
      { class: 'sfl-sim__source' },
      h('label', { class: 'sf-label', for: 'sfl-sim-source' }, 'Start from a packaged scenario'),
      h('div', { class: 'sfl-field__row' }, picker, reset),
      description,
    ),
    h('div', { class: 'sfl-sim__go' }, go),
  );
  const editorSlot = h('div', { class: 'sfl-sim__editor' });
  const runSlot = h('div', { class: 'sfl-sim__run' });
  const expSlot = h('div', { class: 'sfl-sim__exp' });
  const el = h(
    'div',
    { class: 'sfl-sim' },
    head,
    h('div', { class: 'sfl-sim__grid' }, editorSlot, h('div', { class: 'sfl-sim__results' }, runSlot, expSlot)),
  );

  let fig: Figure | null = null;
  // Results already there when the tab opens are not "new": no scrolling to them.
  let lastRun: SimState['run'] = env.state.get().sim.run;
  let lastSummary: SimState['summary'] = env.state.get().sim.summary;
  const titleOf = (name: string): string => STORIES.find((s) => s.id === name)?.title ?? name;
  /** When the editor and the results are stacked, bring a new result into view. */
  const bringIntoView = (el: HTMLElement): void => {
    const grid = el.closest('.sfl-sim__grid');
    const stacked = grid ? getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length === 1 : false;
    if (stacked) el.scrollIntoView({ block: 'start' });
  };

  void env.demos().then((demos) => {
    picker.replaceChildren(...demos.map((d) => h('option', { value: d.name }, `${titleOf(d.name)} (${d.name})`)));
    const sim = env.state.get().sim;
    if (!sim.scenario && demos[0]) {
      setSim(env, { scenario: structuredClone(demos[0].scenario), source: demos[0].name, editorVersion: sim.editorVersion + 1 });
    }
    picker.value = env.state.get().sim.source ?? '';
    const d = demos.find((x) => x.name === env.state.get().sim.source);
    description.textContent = d?.description ?? '';
    env.markReady();
  });
  picker.addEventListener('change', () => {
    void env.demos().then((demos) => {
      const demo = demos.find((d) => d.name === picker.value);
      if (!demo) return;
      description.textContent = demo.description;
      setSim(env, {
        scenario: structuredClone(demo.scenario),
        source: demo.name,
        run: null,
        runError: null,
        summary: null,
        summaryScenario: null,
        expError: null,
        editorVersion: env.state.get().sim.editorVersion + 1,
      });
    });
  });

  const stops = [
    env.state.select(
      (st) => st.sim.editorVersion,
      () => {
        const sim = env.state.get().sim;
        const focused = document.activeElement?.id;
        editorSlot.replaceChildren(sim.scenario ? editor(env, sim.scenario) : h('p', { class: 'sfl-muted' }, 'Loading the packaged scenarios…'));
        if (focused) document.getElementById(focused)?.focus();
        if (sim.source) {
          picker.value = sim.source;
          void env.demos().then((demos) => {
            description.textContent = demos.find((x) => x.name === sim.source)?.description ?? '';
          });
        }
      },
      { immediate: true },
    ),
    env.state.select(
      (st) => [st.sim.run, st.sim.runStatus, st.sim.runError, st.sim.scenario] as const,
      () => {
        const sim = env.state.get().sim;
        fig?.destroy();
        const built = runPanel(env, sim);
        fig = built.fig;
        runSlot.replaceChildren(built.el);
        go.disabled = sim.runStatus === 'running' || !sim.scenario;
        if (built.fig) void built.fig.ready.then(() => env.markReady());
        if (sim.run && sim.run !== lastRun) bringIntoView(runSlot);
        lastRun = sim.run;
      },
      { immediate: true, equals: (a, b) => a.every((v, i) => Object.is(v, b[i])) },
    ),
    env.state.select(
      (st) => [st.sim.summary, st.sim.expStatus, st.sim.expError, st.sim.scenario] as const,
      () => {
        const sim = env.state.get().sim;
        expSlot.replaceChildren(experimentPanel(env, sim));
        if (sim.expStatus === 'idle' && sim.summary) env.markReady();
        if (sim.summary && sim.summary !== lastSummary) bringIntoView(expSlot);
        lastSummary = sim.summary;
      },
      { immediate: true, equals: (a, b) => a.every((v, i) => Object.is(v, b[i])) },
    ),
    env.onFmtChange(() => {
      const sim = env.state.get().sim;
      fig?.destroy();
      const built = runPanel(env, sim);
      fig = built.fig;
      runSlot.replaceChildren(built.el);
      expSlot.replaceChildren(experimentPanel(env, sim));
    }),
  ];

  return {
    el,
    destroy: () => {
      for (const stop of stops) stop();
      fig?.destroy();
      el.remove();
    },
  };
}
