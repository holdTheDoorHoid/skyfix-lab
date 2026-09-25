/**
 * The navigation tools of the real engine: `NavEngine` (noon sight, Polaris, averaging,
 * running fix; `crates/skyfix-wasm/src/nav.rs`) and `NavSkyEngine` (sight bodies,
 * predicted sextant readings, lunar distance, tonight's sights; `navsky.rs`). Wire format:
 * docs/EXPLORER_API.md, "Wave 1 — navigation methods" and "Wave 2 — Moon and planet
 * sights". OWNER: navigate agent.
 *
 * Like `wasm.ts`, this only serialises inputs to the JSON strings the exports take and
 * passes the results through. `WasmEngine` composes it as `engine.nav` when the package
 * has every export below; a package built before the navigation work has no `nav`, and
 * the Navigate view says exactly which functions are missing.
 */

import type { Session } from '../../types.js';
import type {
  AveragedSight,
  AveragingOptions,
  EphemerisMode,
  LunarDistanceInput,
  LunarDistanceResult,
  NavEngine,
  NavSkyEngine,
  NoonSightOptions,
  NoonSightResult,
  PolarisOptions,
  PolarisResult,
  PredictedSight,
  RunningFixOutput,
  RunningFixRequest,
  SightBodyInfo,
  SightInstrument,
  SightLimb,
  SightObserver,
  SightPlan,
} from './types.js';

/** The exports the navigation tools need, all of them (wave 1 and wave 2). */
export const NAV_EXPORTS = [
  'noon_sight',
  'polaris_latitude',
  'average_sights',
  'running_fix',
  'sight_bodies',
  'predict_sextant',
  'lunar_distance',
  'plan_sights',
] as const;

export type NavExportName = (typeof NAV_EXPORTS)[number];

/** The wasm-bindgen functions these tools call (EXPLORER_API signatures). */
export interface NavWasmExports {
  noon_sight(sessionJson: string, optionsJson: string, ephemerisMode: string): unknown;
  polaris_latitude(sessionJson: string, optionsJson: string, ephemerisMode: string): unknown;
  average_sights(sessionJson: string, optionsJson: string, ephemerisMode: string): unknown;
  running_fix(sessionJson: string, requestJson: string, ephemerisMode: string): unknown;
  sight_bodies(): unknown;
  predict_sextant(observerJson: string, instrumentJson: string, body: string, limb: string, jdUtc: number): unknown;
  lunar_distance(inputJson: string): unknown;
  plan_sights(observerJson: string, jdStart: number, jdEnd: number, instrumentJson: string): unknown;
}

/** Both navigation interfaces, as one object (`ExplorerEngine.nav`). */
export type NavTools = NavEngine & NavSkyEngine;

/** The navigation exports a package lacks (empty when it has them all). */
export function missingNavExports(module: object): NavExportName[] {
  return NAV_EXPORTS.filter((name) => typeof (module as Record<string, unknown>)[name] !== 'function');
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Only the contract fields of a sight observer (a UI object may carry more). */
export function sightObserverJson(o: SightObserver): string {
  const out: Record<string, number> = { lat_deg: o.lat_deg, lon_deg: o.lon_deg };
  if (o.height_of_eye_m !== undefined) out.height_of_eye_m = o.height_of_eye_m;
  if (o.pressure_hpa !== undefined) out.pressure_hpa = o.pressure_hpa;
  if (o.temperature_c !== undefined) out.temperature_c = o.temperature_c;
  return JSON.stringify(out);
}

/** An instrument document; `{}` means every default (0′ index correction, sea horizon). */
export function instrumentJson(i: SightInstrument | undefined): string {
  // A shore horizon is an object: `{"shore": {"distance_nm": d}}`.
  const out: Record<string, number | string | object> = {};
  if (i?.name !== undefined) out.name = i.name;
  if (i?.index_correction_arcmin !== undefined) out.index_correction_arcmin = i.index_correction_arcmin;
  if (i?.horizon !== undefined) out.horizon = i.horizon;
  return JSON.stringify(out);
}

/** Options documents drop `undefined` fields, so the Rust serde defaults apply. */
export function optionsDocument(options: object | undefined): string {
  return JSON.stringify(options ?? {});
}

/**
 * The navigation tools over an initialised package, or null when it lacks any of
 * `NAV_EXPORTS` (see `missingNavExports`).
 */
export function createWasmNav(module: object): NavTools | null {
  if (missingNavExports(module).length > 0) return null;
  const x = module as NavWasmExports;
  const call = <T>(name: string, fn: () => unknown): T => {
    try {
      return fn() as T;
    } catch (error) {
      throw new Error(`${name}: ${errorText(error)}`);
    }
  };
  let bodies: SightBodyInfo[] | null = null;
  const mode = (m: EphemerisMode | undefined): string => m ?? 'auto';
  return {
    noonSight: (session: Session, options?: NoonSightOptions, m?: EphemerisMode): NoonSightResult =>
      call('noon_sight', () => x.noon_sight(JSON.stringify(session), optionsDocument(options), mode(m))),
    polarisLatitude: (session: Session, options?: PolarisOptions, m?: EphemerisMode): PolarisResult =>
      call('polaris_latitude', () => x.polaris_latitude(JSON.stringify(session), optionsDocument(options), mode(m))),
    averageSights: (session: Session, options?: AveragingOptions, m?: EphemerisMode): AveragedSight =>
      call('average_sights', () => x.average_sights(JSON.stringify(session), optionsDocument(options), mode(m))),
    runningFix: (session: Session, request: RunningFixRequest, m?: EphemerisMode): RunningFixOutput =>
      call('running_fix', () => x.running_fix(JSON.stringify(session), JSON.stringify(request), mode(m))),
    sightBodies: (): SightBodyInfo[] => {
      bodies ??= call<SightBodyInfo[]>('sight_bodies', () => x.sight_bodies());
      return bodies;
    },
    predictSextant: (
      observer: SightObserver,
      instrument: SightInstrument,
      body: string,
      limb: SightLimb,
      jdUtc: number,
    ): PredictedSight =>
      call('predict_sextant', () =>
        x.predict_sextant(sightObserverJson(observer), instrumentJson(instrument), body, limb, jdUtc),
      ),
    lunarDistance: (input: LunarDistanceInput): LunarDistanceResult =>
      call('lunar_distance', () => x.lunar_distance(JSON.stringify(input))),
    planSights: (observer: SightObserver, jdStart: number, jdEnd: number, instrument: SightInstrument): SightPlan =>
      call('plan_sights', () =>
        x.plan_sights(sightObserverJson(observer), jdStart, jdEnd, instrumentJson(instrument)),
      ),
  };
}
