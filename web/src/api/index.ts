/**
 * THE ONE PLACE THE ADAPTER IS CHOSEN.
 *
 * The WebAssembly package is the implementation. The mock is a development convenience
 * and is reachable ONLY with `?api=mock`; it is never substituted silently.
 *
 * In a production build a missing package is a hard failure, not a quiet downgrade:
 * `vite.config.ts` refuses to build without it, and this module refuses to start.
 * In development it falls back to the mock with a loud message, so that `npm run dev`
 * works before the first `npm run wasm`.
 */

import type { SkyfixApi } from './adapter.js';
import { MockApi } from './mock.js';
import { WasmApi, wasmPackagePresent } from './wasm.js';

export type ApiChoice = 'auto' | 'mock';

export function requestedApi(search: string): ApiChoice {
  return new URLSearchParams(search).get('api') === 'mock' ? 'mock' : 'auto';
}

export interface ApiSelection {
  api: SkyfixApi;
  requested: ApiChoice;
  /** Set when the mock is running. Shown to the user, every view. */
  mockReason: string | null;
}

/** Overridable for tests; `import.meta.env.PROD` in the browser. */
export function isProductionBuild(): boolean {
  return Boolean(import.meta.env?.PROD);
}

export async function selectApi(search = globalThis.location?.search ?? ''): Promise<ApiSelection> {
  const requested = requestedApi(search);
  if (requested === 'mock') {
    return {
      api: new MockApi(),
      requested,
      mockReason:
        'You asked for the mock adapter with ?api=mock. It is a UI development stand-in: its numbers are illustrative, not results from the numerical core. Remove ?api=mock to use the real one.',
    };
  }

  if (!wasmPackagePresent()) {
    if (isProductionBuild()) {
      throw new Error(
        'This build contains no WebAssembly package, so there is nothing to compute with. ' +
          'Rebuild with `npm run wasm --prefix web` followed by `npm run build --prefix web`. ' +
          'The mock adapter is a development tool and is not used to produce results.',
      );
    }
    return {
      api: new MockApi(),
      requested,
      mockReason:
        'No WebAssembly package has been built yet, so this development server is running the mock adapter. Its numbers are illustrative. Build the real one with `npm run wasm --prefix web`.',
    };
  }

  // A package that fails to load is a fault to report, not a reason to show made-up
  // numbers: let it propagate to the fatal-error screen in main.ts.
  const api = await WasmApi.load();
  return { api, requested, mockReason: null };
}

export type { SkyfixApi };
