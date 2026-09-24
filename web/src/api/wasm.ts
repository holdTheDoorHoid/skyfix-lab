/**
 * The real adapter: `crates/skyfix-wasm` compiled to WebAssembly.
 *
 * The package is a build artefact and is not committed, so it is discovered with
 * `import.meta.glob`: when `src/wasm-pkg/` is absent the glob is simply empty and the
 * bundle builds without it. Rebuild it with `npm run wasm` (see web/README.md).
 *
 * Nothing here is loaded over the network: Vite emits the `.wasm` file as a local asset
 * next to the page.
 */

import type { FixResult, Session, SolveOptions } from '../types.js';
import type {
  CoverageReport,
  EphemerisMode,
  ParsedSession,
  ReduceEntry,
  Scenario,
  SimulationOutput,
  SkyfixApi,
} from './adapter.js';

/** The subset of the generated glue this adapter uses. */
interface WasmExports {
  default: (input?: unknown) => Promise<unknown>;
  init: () => void;
  version: () => string;
  parse_session: (json: string) => unknown;
  reduce: (sessionJson: string, ephemerisMode: string) => unknown;
  solve: (sessionJson: string, optionsJson: string) => unknown;
  circle_points: (latGp: number, lonGp: number, zenithDistanceDeg: number, n: number) => unknown;
  simulate: (scenarioJson: string) => unknown;
  catalog: () => unknown;
  coverage: () => unknown;
}

const packageModules = import.meta.glob('../wasm-pkg/skyfix_wasm.js');

/** True when a WASM package has been built into `src/wasm-pkg/`. */
export function wasmPackagePresent(): boolean {
  return Object.keys(packageModules).length > 0;
}

/** wasm-bindgen throws the `Err` value; turn it into a readable Error. */
function rethrow(context: string, error: unknown): never {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : JSON.stringify(error);
  throw new Error(`${context}: ${message}`);
}

export class WasmApi implements SkyfixApi {
  readonly kind = 'wasm' as const;
  readonly description = 'skyfix-core compiled to WebAssembly. Runs entirely in this browser.';
  readonly mockedCalls = [] as const;

  private constructor(private readonly exports: WasmExports) {}

  static async load(): Promise<WasmApi> {
    const loader = Object.values(packageModules)[0];
    if (!loader) {
      throw new Error(
        'no WASM package in web/src/wasm-pkg. Build it with `npm run wasm`, or append ?api=mock to the URL.',
      );
    }
    const module = (await loader()) as WasmExports;
    await module.default();
    module.init();
    return new WasmApi(module);
  }

  async init(): Promise<void> {
    this.exports.init();
  }

  async version(): Promise<string> {
    return this.exports.version();
  }

  async parseSession(json: string): Promise<ParsedSession> {
    try {
      return this.exports.parse_session(json) as ParsedSession;
    } catch (error) {
      return rethrow('parse_session', error);
    }
  }

  async reduce(session: Session, mode: EphemerisMode): Promise<ReduceEntry[]> {
    try {
      return this.exports.reduce(JSON.stringify(session), mode) as ReduceEntry[];
    } catch (error) {
      return rethrow('reduce', error);
    }
  }

  async solve(session: Session, options: SolveOptions): Promise<FixResult> {
    try {
      return this.exports.solve(JSON.stringify(session), JSON.stringify(options)) as FixResult;
    } catch (error) {
      return rethrow('solve', error);
    }
  }

  async circlePoints(
    latGp: number,
    lonGp: number,
    zenithDistanceDeg: number,
    n: number,
  ): Promise<[number, number][]> {
    return this.exports.circle_points(latGp, lonGp, zenithDistanceDeg, n) as [number, number][];
  }

  async simulate(scenario: Scenario): Promise<SimulationOutput> {
    try {
      return this.exports.simulate(JSON.stringify(scenario)) as SimulationOutput;
    } catch (error) {
      return rethrow('simulate', error);
    }
  }

  async catalog(): Promise<string[]> {
    return this.exports.catalog() as string[];
  }

  async coverage(): Promise<CoverageReport> {
    return this.exports.coverage() as CoverageReport;
  }
}
