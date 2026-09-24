/**
 * The misfit grid of the real engine: `misfit_grid` and `misfit_default_bounds`
 * (`crates/skyfix-wasm/src/misfit.rs`). Wire format: docs/EXPLORER_API.md, "Misfit grid".
 * OWNER: misfit agent.
 *
 * Like `wasm.ts`, this only serialises the inputs to the JSON strings the exports take and
 * passes the results through; `chi2` arrives as a real `Float64Array`. `WasmEngine`
 * composes it as `engine.misfit` when the package has both exports.
 */

import type { Session, SolveOptions } from '../../types.js';
import type { EphemerisMode, MisfitBounds, MisfitDefaultBounds, MisfitEngine, MisfitGrid } from './types.js';

/** The exports the misfit grid needs. */
export const MISFIT_EXPORTS = ['misfit_grid', 'misfit_default_bounds'] as const;

/** Most nodes along either axis (`skyfix_core::misfit::MAX_AXIS`). */
export const MISFIT_MAX_AXIS = 1024;

/** The wasm-bindgen functions (EXPLORER_API signatures). */
export interface MisfitWasmExports {
  misfit_grid(
    sessionJson: string,
    ephemerisMode: string,
    optionsJson: string,
    boundsJson: string,
    nLat: number,
    nLon: number,
  ): unknown;
  misfit_default_bounds(sessionJson: string, ephemerisMode: string, optionsJson: string): unknown;
}

/** The misfit exports a package lacks (empty when it has both). */
export function missingMisfitExports(module: object): string[] {
  return MISFIT_EXPORTS.filter((name) => typeof (module as Record<string, unknown>)[name] !== 'function');
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

/** The four contract fields of a box, or `""` (the default frame) for none. */
export function misfitBoundsJson(bounds: MisfitBounds | null | undefined): string {
  if (!bounds) return '';
  const { south_deg, north_deg, west_deg, east_deg } = bounds;
  return JSON.stringify({ south_deg, north_deg, west_deg, east_deg });
}

/** A solve-options document; `{}` means every default (serde fills the rest). */
export function misfitOptionsJson(options: Partial<SolveOptions> | null | undefined): string {
  return JSON.stringify(options ?? {});
}

/** Throws unless `n` is a whole number of nodes the engine accepts. */
export function checkAxis(name: string, n: number): number {
  if (!Number.isInteger(n) || n < 2 || n > MISFIT_MAX_AXIS) {
    throw new Error(`${name} must be a whole number of nodes from 2 to ${MISFIT_MAX_AXIS}, got ${n}`);
  }
  return n;
}

/** The misfit grid over an initialised package, or null when it lacks an export. */
export function createWasmMisfit(module: object): MisfitEngine | null {
  if (missingMisfitExports(module).length > 0) return null;
  const x = module as MisfitWasmExports;
  const call = <T>(name: string, fn: () => unknown): T => {
    try {
      return fn() as T;
    } catch (error) {
      throw new Error(`${name}: ${errorText(error)}`);
    }
  };
  return {
    misfitGrid: (
      session: Session,
      mode: EphemerisMode,
      options: Partial<SolveOptions> | null,
      bounds: MisfitBounds | null,
      nLat: number,
      nLon: number,
    ): MisfitGrid => {
      checkAxis('n_lat', nLat);
      checkAxis('n_lon', nLon);
      return call('misfit_grid', () =>
        x.misfit_grid(JSON.stringify(session), mode, misfitOptionsJson(options), misfitBoundsJson(bounds), nLat, nLon),
      );
    },
    misfitDefaultBounds: (session: Session, mode: EphemerisMode, options: Partial<SolveOptions> | null): MisfitDefaultBounds =>
      call('misfit_default_bounds', () =>
        x.misfit_default_bounds(JSON.stringify(session), mode, misfitOptionsJson(options)),
      ),
  };
}
