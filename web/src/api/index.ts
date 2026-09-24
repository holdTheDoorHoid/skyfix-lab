/**
 * THE ONE PLACE THE ADAPTER IS CHOSEN.
 *
 * Default: the WASM package when `src/wasm-pkg/` exists, the mock otherwise.
 * Override with `?api=mock` or `?api=wasm` in the URL. The choice is shown in the
 * header on every view; a mock result is never presented as a real one.
 */

import type { SkyfixApi } from './adapter.js';
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
  /** Set when the requested implementation could not be used. Shown to the user. */
  fallbackReason: string | null;
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
          : null,
    };
  }
  try {
    const api = await WasmApi.load();
    return { api, requested, fallbackReason: null };
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
