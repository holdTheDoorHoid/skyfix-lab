/**
 * THE ONE PLACE THE ADAPTER IS CHOSEN.
 *
 * Default: the WASM package when `src/wasm-pkg/` exists, the mock otherwise. Override
 * with `?api=mock` or `?api=wasm` in the URL.
 *
 * The WASM package is built from a workspace whose numerical core is still being
 * written, so exports whose Rust is stubbed answer `not implemented: <name>`. Rather
 * than showing the user a wall of errors, this module PROBES the package once at
 * startup and wires the stubbed calls to the mock, reporting exactly which ones.
 * When `skyfix-core` lands and the cargo features are switched on, the probe finds
 * nothing missing and the hybrid disappears on its own.
 */

import type { FixResult, Session, SolveOptions } from '../types.js';
import { SESSION_SCHEMA } from '../types.js';
import type {
  CoverageReport,
  EphemerisMode,
  ParsedSession,
  ReduceEntry,
  Scenario,
  SimulationOutput,
  SkyfixApi,
} from './adapter.js';
import { defaultScenario } from './adapter.js';
import { MockApi } from './mock.js';
import { WasmApi, wasmPackagePresent } from './wasm.js';

export type ApiChoice = 'auto' | 'wasm' | 'mock';

export function requestedApi(search: string): ApiChoice {
  const value = new URLSearchParams(search).get('api');
  return value === 'mock' || value === 'wasm' ? value : 'auto';
}

export interface ApiSelection {
  api: SkyfixApi;
  requested: ApiChoice;
  /** Set when the requested implementation could not be used in full. */
  fallbackReason: string | null;
}

const PROBE_SESSION: Session = {
  schema: SESSION_SCHEMA,
  meta: { name: 'probe', notes: '', kind: 'simulated' },
  observer: {
    height_of_eye_m: 0,
    pressure_hpa: 1010,
    temperature_c: 10,
    assumed_position: null,
    assumed_position_role: { role: 'initializer' },
  },
  instrument: { name: '', index_correction_arcmin: 0, horizon: 'sea' },
  clock: { uncertainty_s: 0, correction_s: 0 },
  observations: [],
};

function isNotImplemented(error: unknown): boolean {
  return /not implemented/i.test(error instanceof Error ? error.message : String(error));
}

async function probe(api: SkyfixApi): Promise<{ core: boolean; sim: boolean }> {
  let core = true;
  let sim = true;
  try {
    await api.parseSession(JSON.stringify(PROBE_SESSION));
  } catch (error) {
    if (isNotImplemented(error)) core = false;
  }
  try {
    await api.simulate(defaultScenario());
  } catch (error) {
    if (isNotImplemented(error)) sim = false;
  }
  return { core, sim };
}

/**
 * The WASM package for what it implements, the mock for what it does not, and an
 * explicit list of which is which. Never silently substitutes one for the other.
 */
export class HybridApi implements SkyfixApi {
  readonly kind = 'hybrid' as const;
  readonly description: string;
  readonly mockedCalls: readonly string[];

  constructor(
    private readonly wasm: SkyfixApi,
    private readonly mock: SkyfixApi,
    private readonly have: { core: boolean; sim: boolean },
  ) {
    const mocked: string[] = [];
    if (!have.core) mocked.push('parse_session', 'reduce', 'solve');
    if (!have.sim) mocked.push('simulate');
    this.mockedCalls = mocked;
    this.description =
      `skyfix-core is compiled in, but ${mocked.join(', ')} ` +
      `${mocked.length === 1 ? 'is' : 'are'} still stubbed in Rust, so ${mocked.length === 1 ? 'it is' : 'they are'} ` +
      'being served by the mock adapter. Those numbers are illustrative, not results.';
  }

  async init(): Promise<void> {
    await this.wasm.init();
  }
  version(): Promise<string> {
    return this.wasm.version();
  }
  parseSession(json: string): Promise<ParsedSession> {
    return (this.have.core ? this.wasm : this.mock).parseSession(json);
  }
  reduce(session: Session, mode: EphemerisMode): Promise<ReduceEntry[]> {
    return (this.have.core ? this.wasm : this.mock).reduce(session, mode);
  }
  solve(session: Session, options: SolveOptions): Promise<FixResult> {
    return (this.have.core ? this.wasm : this.mock).solve(session, options);
  }
  circlePoints(
    latGp: number,
    lonGp: number,
    zenithDistanceDeg: number,
    n: number,
  ): Promise<[number, number][]> {
    return this.wasm.circlePoints(latGp, lonGp, zenithDistanceDeg, n);
  }
  simulate(scenario: Scenario): Promise<SimulationOutput> {
    return (this.have.sim ? this.wasm : this.mock).simulate(scenario);
  }
  catalog(): Promise<string[]> {
    return this.wasm.catalog();
  }
  coverage(): Promise<CoverageReport> {
    return this.wasm.coverage();
  }
}

export async function selectApi(search = globalThis.location?.search ?? ''): Promise<ApiSelection> {
  const requested = requestedApi(search);
  if (requested === 'mock') {
    return { api: new MockApi(), requested, fallbackReason: null };
  }
  if (!wasmPackagePresent()) {
    return {
      api: new MockApi(),
      requested,
      fallbackReason:
        requested === 'wasm'
          ? 'No WebAssembly package was built (web/src/wasm-pkg is missing). Running the mock adapter instead.'
          : 'No WebAssembly package was built, so the mock adapter is running. Build it with `npm run wasm`.',
    };
  }
  try {
    const wasm = await WasmApi.load();
    const have = await probe(wasm);
    if (have.core && have.sim) return { api: wasm, requested, fallbackReason: null };
    const hybrid = new HybridApi(wasm, new MockApi(), have);
    return { api: hybrid, requested, fallbackReason: hybrid.description };
  } catch (error) {
    return {
      api: new MockApi(),
      requested,
      fallbackReason: `The WebAssembly package failed to load (${
        error instanceof Error ? error.message : String(error)
      }). Running the mock adapter instead.`,
    };
  }
}

export type { SkyfixApi };
