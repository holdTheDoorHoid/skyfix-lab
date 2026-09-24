/**
 * The one interface the whole UI talks to. Two implementations:
 * `wasm.ts` (real `skyfix-core` through `crates/skyfix-wasm`) and `mock.ts`
 * (hand-written fixtures plus a clearly-labelled stand-in, used while the numerical
 * core is still `todo!()`). `index.ts` picks one.
 *
 * Every shape here is the JSON the WASM adapter emits; see types.ts for the mirror of
 * `skyfix_core::types` and `crates/skyfix-wasm/src/lib.rs` for the adapter-owned ones.
 */

import type {
  FixResult,
  HorizonMode,
  LatLon,
  ReducedSight,
  Session,
  SolveOptions,
  Truth,
  Warning,
} from '../types.js';
import { SCENARIO_SCHEMA } from '../types.js';

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

/** Which direction source `reduce` should use. */
export type EphemerisMode = 'supplied' | 'auto';

export type GeometryPreset = 'good' | 'clustered' | 'two_body' | 'single_sight' | 'custom';

export const GEOMETRY_PRESETS: readonly { value: GeometryPreset; label: string; note: string }[] = [
  {
    value: 'good',
    label: 'Good geometry',
    note: 'Bodies spread around the horizon: both position components well constrained.',
  },
  {
    value: 'clustered',
    label: 'Clustered azimuths',
    note: 'Every body in one narrow sector: the across-sector direction is barely constrained.',
  },
  {
    value: 'two_body',
    label: 'Two bodies (ambiguous)',
    note: 'Exactly two sights: two circle intersections, neither promoted.',
  },
  {
    value: 'single_sight',
    label: 'One sight (underdetermined)',
    note: 'One altitude constrains you to a circle, never to a point.',
  },
  { value: 'custom', label: 'Custom body list', note: 'Use the bodies named below.' },
];

export interface WrongSight {
  /** 0-based index into the generated sights. */
  index: number;
  /** Altitude error added to that one sight, arcminutes. */
  error_arcmin: number;
}

/** Mirrors `skyfix_wasm::Scenario`. Degrees / arcminutes / seconds on the wire. */
export interface Scenario {
  schema: string;
  name: string;
  seed: number;
  /** Where the sights are generated from. Never copied into the session. */
  truth_position: LatLon;
  utc: string;
  geometry: GeometryPreset;
  bodies: string[];
  sight_count: number;
  /** The sigma written into each observation: what the solver is told. */
  sigma_arcmin: number;
  /** Independent per-sight noise actually injected, 1-sigma arcminutes. */
  noise_arcmin: number;
  /** A common offset added to every altitude. Averaging cannot remove it. */
  shared_altitude_bias_arcmin: number;
  /** A common error added to every recorded time, seconds. */
  clock_offset_s: number;
  clock_uncertainty_s: number;
  /** Fraction of generated sights dropped, [0, 1). */
  missing_fraction: number;
  wrong_sight: WrongSight | null;
  height_of_eye_m: number;
  index_correction_arcmin: number;
  horizon: HorizonMode;
}

export function defaultScenario(): Scenario {
  return {
    schema: SCENARIO_SCHEMA,
    name: 'Philadelphia four-star',
    seed: 20261001,
    truth_position: { lat_deg: 39.9526, lon_deg: -75.1652 },
    utc: '2026-10-01T01:30:00Z',
    geometry: 'good',
    bodies: [],
    sight_count: 4,
    sigma_arcmin: 1.0,
    noise_arcmin: 1.0,
    shared_altitude_bias_arcmin: 0,
    clock_offset_s: 0,
    clock_uncertainty_s: 0,
    missing_fraction: 0,
    wrong_sight: null,
    height_of_eye_m: 2.0,
    index_correction_arcmin: 0,
    horizon: 'sea',
  };
}

export interface SkyfixApi {
  /**
   * Which implementation this is. Shown in the header; never hidden from the user.
   * `hybrid` means the WASM package is loaded but some of its exports are still
   * `not implemented`, so those calls are served by the mock — see `mockedCalls`.
   */
  readonly kind: 'wasm' | 'mock' | 'hybrid';
  /** One line the About and header banner show verbatim. */
  readonly description: string;
  /** Names of the calls that are NOT coming from the numerical core. */
  readonly mockedCalls: readonly string[];

  init(): Promise<void>;
  version(): Promise<string>;
  parseSession(json: string): Promise<ParsedSession>;
  reduce(session: Session, mode: EphemerisMode): Promise<ReduceEntry[]>;
  solve(session: Session, options: SolveOptions): Promise<FixResult>;
  /** `[[lat_deg, lon_deg], ...]` around the circle of position. */
  circlePoints(
    latGp: number,
    lonGp: number,
    zenithDistanceDeg: number,
    n: number,
  ): Promise<[number, number][]>;
  simulate(scenario: Scenario): Promise<SimulationOutput>;
  catalog(): Promise<string[]>;
  coverage(): Promise<CoverageReport>;
}
