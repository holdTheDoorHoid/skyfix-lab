/**
 * The one interface the whole UI talks to. Two implementations: `wasm.ts` (the real
 * `skyfix-core`, `skyfix-ephemeris` and `skyfix-sim` through `crates/skyfix-wasm`) and
 * `mock.ts`, which exists only for UI work with no WebAssembly build to hand and is
 * reachable only with `?api=mock`. `index.ts` picks one.
 *
 * Every shape here is the JSON the WASM adapter emits. `types.ts` mirrors
 * `skyfix_core::types`; the simulator shapes below mirror `skyfix_sim::scenario` and
 * `skyfix_sim::experiment` (docs/SIMULATOR.md is normative for their meaning).
 */

import type {
  AssumedPositionRole,
  FixResult,
  LatLon,
  ReducedSight,
  Session,
  SolveOptions,
  Truth,
  Warning,
} from '../types.js';

/** `parse_session` result. */
export interface ParsedSession {
  session: Session;
  warnings: Warning[];
}

/** One `reduce` array element. A rejected sight never aborts the batch. */
export type ReduceEntry =
  | { status: 'ok'; sight: ReducedSight }
  | { status: 'error'; id: string; message: string };

/** `simulate` result. Truth is a sibling of the session, never inside it. */
export interface SimulationOutput {
  session: Session;
  truth: Truth;
}

export interface ProviderCoverage {
  provider: string;
  start_utc: string;
  end_utc: string;
  bodies: string[];
  notes: string;
  accuracy_arcmin: number;
}

export interface CoverageReport {
  providers: ProviderCoverage[];
  modes: string[];
}

/** Which direction source `reduce` and `solve` should use. */
export type EphemerisMode = 'supplied' | 'auto';

export const EPHEMERIS_MODES: readonly { value: EphemerisMode; label: string; note: string }[] = [
  {
    value: 'supplied',
    label: 'Supplied directions only',
    note: 'Only the GHA and declination written into each observation are used. A sight without one is rejected. This is the brief’s "first numerical slice": it isolates the solver from the astronomy.',
  },
  {
    value: 'auto',
    label: 'Supplied, else the offline star provider',
    note: 'A supplied direction still wins. Anything else is looked up in the bundled star catalogue at the recorded time.',
  },
];

// ---------------------------------------------------------------------------
// Simulator: mirrors skyfix_sim::scenario (docs/SIMULATOR.md)
// ---------------------------------------------------------------------------

/**
 * A body the schedule can draw on. `supplied` carries its own direction and needs no
 * astronomy at all; `named` is a real body the provider must resolve.
 */
export type BodySource =
  | {
      source: 'supplied';
      name: string;
      gha_deg_at_start: number;
      dec_deg: number;
      /** GHA advances linearly at this rate; declination is constant. */
      gha_rate_deg_per_hour: number;
    }
  | { source: 'named'; name: string };

export type Ordering = 'round_robin' | 'sequential';

export interface Schedule {
  /** Sights *scheduled*, before `missing_fraction` drops any. */
  count: number;
  /** True seconds between consecutive scheduled sights. */
  spacing_s: number;
  ordering: Ordering;
}

export interface WrongSight {
  /** 0-based index into the EMITTED observations, after any are dropped. */
  index: number;
  /** Arcminutes added to that one altitude, on top of noise and bias. */
  error_arcmin: number;
}

export type GeometryPreset =
  | { preset: 'as_given' }
  | { preset: 'clustered'; window_deg: number }
  | { preset: 'well_spread'; keep: number | null };

export type EmittedAltitude =
  | { kind: 'observed_ho' }
  | {
      kind: 'sextant_hs';
      height_of_eye_m: number;
      index_correction_arcmin: number;
      pressure_hpa: number;
      temperature_c: number;
    };

export type AssumedPositionMode =
  | { mode: 'none' }
  | { mode: 'offset_from_truth'; distance_nm: number; bearing_deg: number }
  | { mode: 'explicit'; lat_deg: number; lon_deg: number }
  | { mode: 'truth' };

export interface AssumedPositionSpec {
  mode: AssumedPositionMode;
  role: AssumedPositionRole;
}

/** Which time the direction written into the session is evaluated at. */
export type AlmanacLookup = 'recorded_time' | 'true_time';

/**
 * `skyfix_sim::scenario::Scenario`. Fields marked TRUTH seed the generator and are
 * never written into the session; fields marked REPORTED are what the estimator is told
 * and need not match.
 */
export interface Scenario {
  name: string;
  description: string;
  /** TRUTH. */
  seed: number;
  /** TRUTH. The observer's real position. */
  truth: LatLon;
  /** First TRUE observation time, RFC 3339 UTC with a trailing Z. */
  start_utc: string;
  sources: BodySource[];
  schedule: Schedule;
  /** TRUTH. 1-sigma independent per-sight altitude noise, arcminutes. */
  altitude_noise_arcmin: number;
  /** TRUTH. Added to EVERY sight. Positive = every altitude reads too high. */
  shared_altitude_bias_arcmin: number;
  /** TRUTH. recorded_time − true_time, seconds. Positive = the clock runs fast. */
  clock_offset_s: number;
  /** Exact count dropped: round(count × missing_fraction). */
  missing_fraction: number;
  /** TRUTH. One deliberate blunder. */
  wrong_sight: WrongSight | null;
  geometry: GeometryPreset;
  altitude_kind: EmittedAltitude;
  /** REPORTED. null means "report the true noise", the honest case. */
  reported_sigma_arcmin: number | null;
  /** REPORTED. session.clock.uncertainty_s; need not match clock_offset_s. */
  reported_clock_uncertainty_s: number;
  assumed_position: AssumedPositionSpec;
  almanac_lookup: AlmanacLookup;
  /** When false, `named` bodies are emitted with no geocentric block. */
  emit_supplied_directions: boolean;
}

/** One packaged demo, straight from `skyfix_sim::demos`. */
export interface DemoEntry {
  name: string;
  description: string;
  /** True when the scenario names real bodies, so an astronomy provider is required. */
  requires_provider: boolean;
  scenario: Scenario;
}

// ---------------------------------------------------------------------------
// Experiments: mirrors skyfix_sim::experiment
// ---------------------------------------------------------------------------

export interface Experiment {
  scenario: Scenario;
  solve_options: SolveOptions;
  repetitions: number;
}

export interface RunRecord {
  repetition: number;
  seed: number;
  result_kind: string;
  converged: boolean;
  sights_used: number;
  error_m: number | null;
  error_north_m: number | null;
  error_east_m: number | null;
  sigma_north_m: number | null;
  sigma_east_m: number | null;
  clock_sigma_east_m: number | null;
  ellipse_semi_major_m: number | null;
  ellipse_semi_minor_m: number | null;
  ellipse_orientation_deg: number | null;
  mahalanobis: number | null;
  inside_ellipse95: boolean | null;
  residual_rms_arcmin: number | null;
  max_abs_residual_arcmin: number | null;
  chi2: number | null;
  dof: number | null;
  shared_bias_arcmin: number | null;
  note: string;
}

export interface Aggregate {
  repetitions: number;
  evaluated: number;
  result_kind_counts: [string, number][];
  /** Fraction of runs whose truth fell inside the nominal 95 % ellipse. */
  coverage_fraction: number | null;
  coverage_stderr: number | null;
  /** Wilson score interval, which stays sensible near 0 and 1. */
  coverage_ci95: [number, number] | null;
  mean_error_m: number | null;
  rms_error_m: number | null;
  mean_error_north_m: number | null;
  mean_error_east_m: number | null;
  mean_predicted_sigma_m: number | null;
  rms_predicted_sigma_m: number | null;
  error_to_sigma_ratio: number | null;
  mean_residual_rms_arcmin: number | null;
}

export interface ExperimentSummary {
  name: string;
  description: string;
  runs: RunRecord[];
  aggregate: Aggregate;
  notes: string[];
}

/** The adapter refuses more than this: the solver runs on the page's own thread. */
export const MAX_REPETITIONS = 1000;

// ---------------------------------------------------------------------------
// Planner: mirrors skyfix_core::planner (docs/PLANNER.md)
// ---------------------------------------------------------------------------

/** What the ranking minimises. All three are properties of the geometry, not brightness. */
export type Objective = 'min_trace' | 'min_max_eigenvalue' | 'min_condition_number';

export const OBJECTIVES: readonly { value: Objective; label: string; note: string }[] = [
  {
    value: 'min_trace',
    label: 'Smallest overall uncertainty',
    note: 'Minimise the total variance: the best average position uncertainty.',
  },
  {
    value: 'min_max_eigenvalue',
    label: 'Smallest worst direction',
    note: 'Minimise the largest axis of the ellipse: shrink the direction you are weakest in.',
  },
  {
    value: 'min_condition_number',
    label: 'Roundest ellipse',
    note: 'Minimise the ratio between the axes: balance the geometry rather than shrink it.',
  },
];

export type ScoreBasis = 'objective' | 'log_det_growth';

export interface PlanCandidate {
  body: string;
  altitude_deg: number;
  azimuth_deg: number;
  sigma_arcmin: number;
  magnitude: number | null;
  note: string;
}

export interface PlanOptions {
  select: number;
  min_altitude_deg: number;
  max_altitude_deg: number;
  already_taken: PlanCandidate[];
  objective: Objective;
  base_sigma_arcmin: number;
}

export function defaultPlanOptions(): PlanOptions {
  return {
    select: 4,
    min_altitude_deg: 15,
    max_altitude_deg: 75,
    already_taken: [],
    objective: 'min_trace',
    base_sigma_arcmin: 1,
  };
}

/** Conditioning of a candidate sight set. Nulls mean singular, exactly as elsewhere. */
export interface PlanMetrics {
  sight_count: number;
  sigma_north_m: number | null;
  sigma_east_m: number | null;
  trace_sigma_m: number | null;
  semi_major_sigma_m: number | null;
  semi_minor_sigma_m: number | null;
  semi_major_azimuth_deg: number | null;
  geometric_dilution_m_per_arcmin: number | null;
  condition_number: number | null;
  rank: number;
  max_azimuth_gap_deg: number;
  singular: boolean;
}

export interface PlannedBody {
  body: string;
  altitude_deg: number;
  azimuth_deg: number;
  score: number;
  rationale: string;
  /** 1-based position in the greedy selection. */
  step: number;
  score_units: string;
  score_basis: ScoreBasis;
  sigma_arcmin: number;
  magnitude: number | null;
}

export interface ExcludedBody {
  body: string;
  altitude_deg: number;
  azimuth_deg: number;
  reason: string;
}

export interface Plan {
  /** The planner discloses the position it assumed, every time. */
  approximate_position: LatLon;
  utc: string;
  bodies: PlannedBody[];
  notes: string[];
  objective: Objective;
  baseline: PlanMetrics;
  predicted: PlanMetrics;
  /** Metrics after each successive pick, so the improvement is visible. */
  progression: PlanMetrics[];
  excluded: ExcludedBody[];
}

// ---------------------------------------------------------------------------

export interface SkyfixApi {
  /** Which implementation this is. Shown in the header; never hidden from the user. */
  readonly kind: 'wasm' | 'mock';
  /** One line the About view shows verbatim. */
  readonly description: string;

  init(): Promise<void>;
  version(): Promise<string>;
  parseSession(json: string): Promise<ParsedSession>;
  reduce(session: Session, mode: EphemerisMode): Promise<ReduceEntry[]>;
  solve(session: Session, options: SolveOptions, mode: EphemerisMode): Promise<FixResult>;
  /** `[[lat_deg, lon_deg], ...]` around the circle of position. */
  circlePoints(
    latGp: number,
    lonGp: number,
    zenithDistanceDeg: number,
    n: number,
  ): Promise<[number, number][]>;
  simulate(scenario: Scenario): Promise<SimulationOutput>;
  /** The packaged demonstrations, in demo order. */
  demos(): Promise<DemoEntry[]>;
  experiment(experiment: Experiment): Promise<ExperimentSummary>;
  catalog(): Promise<string[]>;
  coverage(): Promise<CoverageReport>;
  /**
   * Rank the bodies worth observing from an APPROXIMATE position. That position is a
   * planning input and never becomes a prior on a fix; every plan names it.
   */
  plan(position: LatLon, utc: string, options: PlanOptions): Promise<Plan>;
}

/** Deep copy that is safe for the plain JSON these types are. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
