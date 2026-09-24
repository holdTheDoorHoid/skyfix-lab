/**
 * THE ONE PLACE THE EXPLORER ENGINE IS CHOSEN (mirrors `src/api/index.ts`).
 *
 * - `?engine=mock` in the address: the mock, with a notice on every view.
 * - Otherwise the WebAssembly core. If it is missing, or was built without the explorer
 *   exports:
 *   - in development (`npm run dev`), fall back to the mock with a loud notice that says
 *     exactly what is missing, so interface work can go on before the Rust lands;
 *   - in a production build, stop with a clearly worded error. A production page never
 *     shows mock numbers unless someone asked for them by name.
 * - A package that is present but fails to load is a fault: it propagates (fatal), in
 *   development too.
 *
 * The mock is loaded with a dynamic import, so it is a separate chunk that a normal page
 * load never downloads.
 */

import type { NoticeLevel } from '../notices.js';
import type { ExplorerEngine } from './types.js';
import { loadWasmEngine, type WasmLoad } from './wasm.js';

export type EngineChoice = 'auto' | 'mock';

export function requestedEngine(search: string): EngineChoice {
  return new URLSearchParams(search).get('engine') === 'mock' ? 'mock' : 'auto';
}

export interface EngineNotice {
  level: NoticeLevel;
  text: string;
}

export interface EngineSelection {
  engine: ExplorerEngine;
  requested: EngineChoice;
  /** Show these to the person; the ones about the mock should stay on screen (persistent). */
  notices: EngineNotice[];
}

/** The explorer cannot start: no core, or a core without the explorer. */
export class EngineUnavailableError extends Error {
  readonly missing: readonly string[];
  constructor(message: string, missing: readonly string[]) {
    super(message);
    this.name = 'EngineUnavailableError';
    this.missing = missing;
  }
}

export function isProductionBuild(): boolean {
  return Boolean(import.meta.env?.PROD);
}

export interface SelectEngineOptions {
  /** Default: `location.search`. */
  search?: string;
  /** Default: `import.meta.env.PROD`. */
  production?: boolean;
  /** Injectable for tests. */
  loadWasm?: () => Promise<WasmLoad>;
  loadMock?: () => Promise<ExplorerEngine>;
}

async function loadMockEngine(): Promise<ExplorerEngine> {
  const { MockEngine } = await import('./mock.js');
  return new MockEngine();
}

function nameList(names: readonly string[]): string {
  return names.join(', ');
}

export const MOCK_REQUESTED_NOTICE =
  'Mock engine, because the address asks for it (?engine=mock). It stands in for the real one while the ' +
  'interface is built: every number on this page is illustrative, not a result from the SkyFix Lab numerical ' +
  'core. Remove ?engine=mock from the address to use the real one.';

function developmentNotice(load: Exclude<WasmLoad, { status: 'ready' }>): string {
  if (load.status === 'absent') {
    return (
      'MOCK ENGINE: no WebAssembly package has been built, so this development server is running the mock. ' +
      'Every number on this page is illustrative. Build the real core with: npm run wasm --prefix web (then reload).'
    );
  }
  return (
    `MOCK ENGINE: the WebAssembly package in web/src/wasm-pkg${load.version ? ` (core ${load.version})` : ''} ` +
    `does not have the explorer functions ${nameList(load.missing)}. It was probably built before the Rust ` +
    'explorer work landed. This development server is running the mock instead, so every number on this page ' +
    'is illustrative. Rebuild with: npm run wasm --prefix web (then reload).'
  );
}

function productionMessage(load: Exclude<WasmLoad, { status: 'ready' }>): string {
  const tail =
    ' The mock engine is a development tool and is never used to produce results. Rebuild the site with ' +
    'npm run wasm --prefix web followed by npm run build --prefix web.';
  if (load.status === 'absent') {
    return `This build of the SkyFix Lab explorer contains no WebAssembly core, so there is nothing to compute with.${tail}`;
  }
  return (
    `This build's WebAssembly core${load.version ? ` (${load.version})` : ''} does not have the explorer ` +
    `functions ${nameList(load.missing)}, so the explorer cannot run.${tail}`
  );
}

export async function selectEngine(options: SelectEngineOptions = {}): Promise<EngineSelection> {
  const requested = requestedEngine(options.search ?? globalThis.location?.search ?? '');
  const production = options.production ?? isProductionBuild();
  const loadMock = options.loadMock ?? loadMockEngine;

  if (requested === 'mock') {
    return {
      engine: await loadMock(),
      requested,
      notices: [{ level: 'caution', text: MOCK_REQUESTED_NOTICE }],
    };
  }

  const load = await (options.loadWasm ?? loadWasmEngine)();
  if (load.status === 'ready') {
    const notices: EngineNotice[] = load.missingOptional.map((name) => ({
      level: 'info' as const,
      text:
        name === 'constellation_boundaries'
          ? 'This build has no constellation boundaries yet (constellation_boundaries is not exported), so boundary lines are not drawn.'
          : `This build does not export the optional function ${name}.`,
    }));
    return { engine: load.engine, requested, notices };
  }

  const missing = load.status === 'incomplete' ? load.missing : [];
  if (production) throw new EngineUnavailableError(productionMessage(load), missing);

  const text = developmentNotice(load);
  console.warn(text);
  return { engine: await loadMock(), requested, notices: [{ level: 'caution', text }] };
}

export type { ExplorerEngine };
