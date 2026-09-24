/**
 * Running a scenario: simulate with the core, then solve, keeping the truth apart. OWNER:
 * learn agent.
 *
 * The honesty rules this file enforces (docs/SIMULATOR.md section 1, CONVENTIONS 8-9):
 *
 * - `simulate` returns a session and a truth document. Only the SESSION is passed on to
 *   `solve`; the truth is held beside the result as the answer key and read by nothing
 *   but the comparison and the drawing. `solveOptionsFor` is a function of the session
 *   and the chosen variant only, so it cannot see the truth.
 * - `SolveOptions.initializer` is never set here. The solver starts from the session's
 *   own assumed position (a dead-reckoning position the simulator discloses in the
 *   session notes) or from its global search.
 * - `guardAgainstTruth` refuses a run in which the solver would be started at, or pulled
 *   towards, the answer: an initializer within 1 NM of the truth, or a prior centred
 *   within 3 sigma (and at least 1 NM) of it. That is the Rust experiment runner's own
 *   guard (`truth_guard_radius_nm`), applied here to single runs too.
 */

import type { DemoEntry, Experiment, ReduceEntry, Scenario, SkyfixApi } from '../../api/adapter.js';
import { NM_M, defaultSolveOptions, type FixResult, type LatLon, type Session, type SolveOptions, type Truth } from '../../types.js';
import { distanceM } from './geo.js';
import type { StoryId, VariantId } from './stories.js';

/** The adapter calls a run needs (tests pass a fake with just these). */
export type LearnApi = Pick<SkyfixApi, 'kind' | 'description' | 'demos' | 'simulate' | 'solve' | 'reduce' | 'experiment'>;

/**
 * Supplied directions win; anything else is looked up in the bundled star catalogue.
 * The real-star demo needs the second half; every other demo carries its own directions.
 */
export const EPHEMERIS_MODE = 'auto' as const;

/** Robust (Huber) weighting as the Rust default `RobustOptions` has it. */
export const ROBUST_DEFAULT = { huber_k: 1.5, max_reweight_iterations: 10 } as const;

/** Declared clock doubt for the clock story's variant, seconds (docs/DEMOS.md section 4). */
export const CLOCK_SIGMA_S = 60;

export interface Variant {
  id: VariantId;
  /** Chip text while it is on ("Robust weighting on"). */
  label: string;
  /** What changed, in a sentence. */
  describe: string;
  /** How the solve options change. */
  options?: (options: SolveOptions) => SolveOptions;
  /** How the scenario changes (before simulating). */
  scenario?: (scenario: Scenario, demos: readonly DemoEntry[]) => Scenario;
}

/** The body the third-star variant adds: the south-west star of the Philadelphia demo. */
export const THIRD_STAR = { from: 'philadelphia-stars', body: 'sim-Delta' } as const;

export const VARIANTS: Record<VariantId, Variant> = {
  robust: {
    id: 'robust',
    label: 'Robust weighting on',
    describe: 'Robust (Huber) weighting, k = 1.5: a sight that disagrees strongly with the rest is given less weight.',
    options: (o) => ({ ...o, robust: { ...ROBUST_DEFAULT } }),
  },
  'clock-sigma': {
    id: 'clock-sigma',
    label: `Clock doubt ${CLOCK_SIGMA_S} s`,
    describe: `The solver is told the clock may be off by ${CLOCK_SIGMA_S} seconds (1 sigma).`,
    options: (o) => ({ ...o, clock_uncertainty_s: CLOCK_SIGMA_S }),
  },
  'estimate-bias': {
    id: 'estimate-bias',
    label: 'Estimating a shared bias',
    describe: 'The solver estimates one altitude bias shared by every sight, alongside the position.',
    options: (o) => ({ ...o, estimate_shared_bias: true }),
  },
  'third-star': {
    id: 'third-star',
    label: 'Third star added',
    describe: 'A third star, in the south-west, is sighted at the same moment as the other two.',
    scenario: (s, demos) => {
      const donor = demos.find((d) => d.name === THIRD_STAR.from);
      const body = donor?.scenario.sources.find((b) => b.name === THIRD_STAR.body);
      if (!body) throw new Error(`The third star (${THIRD_STAR.body}) is not in the ${THIRD_STAR.from} demo.`);
      if (donor!.scenario.start_utc !== s.start_utc) {
        throw new Error('The third star belongs to a scenario that starts at another time.');
      }
      return { ...s, sources: [...s.sources, structuredClone(body)], schedule: { ...s.schedule, count: s.schedule.count + 1 } };
    },
  },
};

/** Which story a variant belongs to (the result panel offers it only there). */
export const VARIANT_STORY: Record<VariantId, StoryId> = {
  robust: 'one-bad-sight',
  'clock-sigma': 'clock-offset',
  'estimate-bias': 'shared-bias',
  'third-star': 'two-sight-ambiguous',
};

/** Solver choices the Simulator exposes (the stories set them through variants). */
export interface SolverChoices {
  robust: boolean;
  estimateBias: boolean;
}

export const NO_SOLVER_CHOICES: SolverChoices = { robust: false, estimateBias: false };

/**
 * What the solver is told for this session. Depends on the SESSION and the chosen
 * variant only: the truth cannot reach it. The clock doubt the session declares is
 * propagated (CONVENTIONS section 6); the initializer is left for the core to take from
 * the session's own assumed position.
 */
export function solveOptionsFor(
  session: Session,
  variant: VariantId | null = null,
  choices: SolverChoices = NO_SOLVER_CHOICES,
): SolveOptions {
  let options: SolveOptions = { ...defaultSolveOptions(), clock_uncertainty_s: session.clock.uncertainty_s };
  if (choices.robust) options = { ...options, robust: { ...ROBUST_DEFAULT } };
  if (choices.estimateBias) options = { ...options, estimate_shared_bias: true };
  const change = variant ? VARIANTS[variant].options : undefined;
  return change ? change(options) : options;
}

/**
 * Options for a coverage experiment on `scenario`. The experiment runner solves each
 * repetition with exactly these (it does not read the session's clock or assumed
 * position), so the clock doubt the scenario reports is passed on here, as a single run
 * does. No initializer and no prior: every repetition starts from the solver's own search.
 */
export function experimentFor(scenario: Scenario, repetitions: number, choices: SolverChoices = NO_SOLVER_CHOICES): Experiment {
  let options: SolveOptions = { ...defaultSolveOptions(), clock_uncertainty_s: scenario.reported_clock_uncertainty_s };
  if (choices.robust) options = { ...options, robust: { ...ROBUST_DEFAULT } };
  if (choices.estimateBias) options = { ...options, estimate_shared_bias: true };
  return { scenario, solve_options: options, repetitions };
}

/** A run refused because it would start the solver at the answer. */
export class TruthLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TruthLeakError';
  }
}

/** Radius inside which a starting point or prior centre counts as the answer, NM. */
export function truthGuardRadiusNm(priorSigmaNm: number | null): number {
  const floor = 1;
  return priorSigmaNm !== null && Number.isFinite(priorSigmaNm) && priorSigmaNm > 0 ? Math.max(3 * priorSigmaNm, floor) : floor;
}

/**
 * Throw `TruthLeakError` when the solver would be started at or pulled towards the truth,
 * through the options or through the session's own assumed position.
 */
export function guardAgainstTruth(session: Session, options: SolveOptions, truth: LatLon): void {
  const nm = (p: LatLon): number => distanceM(p, truth) / NM_M;
  const check = (what: string, p: LatLon | null, sigmaNm: number | null): void => {
    if (!p || !Number.isFinite(p.lat_deg) || !Number.isFinite(p.lon_deg)) return;
    const d = nm(p);
    const limit = truthGuardRadiusNm(sigmaNm);
    if (d <= limit) {
      throw new TruthLeakError(
        `Refused: ${what} is ${d.toFixed(3)} NM from the truth, inside the ${limit.toFixed(1)} NM guard. ` +
          'A run that starts the solver at the answer, or pulls it there, measures nothing; the truth is only ever the answer key.',
      );
    }
  };
  check('the solver’s starting point', options.initializer, null);
  if (options.prior) check('the position prior', options.prior.center, options.prior.sigma_nm);
  const role = session.observer.assumed_position_role;
  const assumed = session.observer.assumed_position;
  if (role.role === 'initializer') check('the session’s assumed position', assumed, null);
  else if (role.role === 'prior') check('the session’s assumed position (a prior)', assumed, role.sigma_nm);
}

/** Everything one run produced. `truth` is the answer key and nothing else reads it. */
export interface Run {
  /** The story, or null for a Simulator run. */
  story: StoryId | null;
  variant: VariantId | null;
  /** The scenario that was simulated (after any variant). */
  scenario: Scenario;
  /** The simulated session: everything the solver was given. */
  session: Session;
  /** What the solver was told. */
  options: SolveOptions;
  result: FixResult;
  /** The corrections, when the session holds raw readings (else null). */
  reduced: ReduceEntry[] | null;
  /** ANSWER KEY. Simulated truth; never passed to the solver. */
  truth: Truth;
  /** Wall time of simulate + solve, ms. */
  ms: number;
}

export interface RunRequest {
  scenario: Scenario;
  story?: StoryId | null;
  variant?: VariantId | null;
  choices?: SolverChoices;
  /** The packaged demos (the third-star variant borrows a body from one). */
  demos?: readonly DemoEntry[];
}

function hasRawReadings(session: Session): boolean {
  return session.observations.some((o) => o.altitude_kind !== 'observed_ho');
}

/** Simulate, then solve the session alone. Throws `TruthLeakError` rather than cheat. */
export async function simulateAndSolve(api: LearnApi, request: RunRequest): Promise<Run> {
  const variant = request.variant ?? null;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let scenario = structuredClone(request.scenario);
  const changeScenario = variant ? VARIANTS[variant].scenario : undefined;
  if (changeScenario) scenario = changeScenario(scenario, request.demos ?? []);

  const { session, truth } = await api.simulate(scenario);
  const options = solveOptionsFor(session, variant, request.choices);
  guardAgainstTruth(session, options, truth.position);
  const result = await api.solve(session, options, EPHEMERIS_MODE);
  const reduced = hasRawReadings(session) ? await api.reduce(session, EPHEMERIS_MODE) : null;
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { story: request.story ?? null, variant, scenario, session, options, result, reduced, truth, ms: t1 - t0 };
}

/** Run a packaged story (optionally with a variant). */
export async function runStory(
  api: LearnApi,
  demos: readonly DemoEntry[],
  story: StoryId,
  variant: VariantId | null = null,
): Promise<Run> {
  const demo = demos.find((d) => d.name === story);
  if (!demo) {
    throw new Error(
      api.kind === 'mock'
        ? `The "${story}" demonstration needs the real numerical core; the mock engine does not have it.`
        : `The core has no packaged demonstration called "${story}".`,
    );
  }
  return simulateAndSolve(api, { scenario: demo.scenario, story, variant, demos });
}
