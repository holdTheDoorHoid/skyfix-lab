/**
 * Which numerical core the Learn view talks to. OWNER: learn agent.
 *
 * The stories and the simulator need `simulate`, `solve`, `reduce`, `demos` and
 * `experiment`: the workbench's `SkyfixApi` (src/api), which the explorer's `Ctx` does not
 * carry. This is the one place Learn obtains it, following the explorer's engine policy:
 *
 * - the explorer is running its WebAssembly engine -> the WebAssembly adapter (the same
 *   package; its initialisation is idempotent);
 * - the explorer is running the mock engine (`?engine=mock`, or a development server with
 *   no package) -> the workbench's mock adapter, with a notice. The ten packaged
 *   demonstrations are the core's own, so the mock cannot run them and says so.
 *
 * One adapter per page (per store). If the shell later puts a `SkyfixApi` on `Ctx`, only
 * `learnApi` changes.
 */

import type { Ctx } from '../component.js';
import type { LearnApi } from './run.js';

export interface ApiHandle {
  api: LearnApi;
  /** Shown to the person when the numbers are not the real core's. */
  notice: string | null;
}

const handles = new WeakMap<object, Promise<ApiHandle>>();

export const MOCK_NOTICE =
  'Mock adapter: the explorer is running its mock engine, so the Learn view uses the workbench’s mock adapter. ' +
  'Its numbers are illustrative, and the ten packaged demonstrations need the real WebAssembly core.';

async function load(ctx: Pick<Ctx, 'engine'>): Promise<ApiHandle> {
  if (ctx.engine.kind !== 'mock') {
    const { WasmApi, wasmPackagePresent } = await import('../../api/wasm.js');
    if (wasmPackagePresent()) return { api: await WasmApi.load(), notice: null };
  }
  const { MockApi } = await import('../../api/mock.js');
  return { api: new MockApi(), notice: MOCK_NOTICE };
}

/** The adapter for this page, loaded once. */
export function learnApi(ctx: Pick<Ctx, 'engine' | 'store'>): Promise<ApiHandle> {
  let handle = handles.get(ctx.store);
  if (!handle) {
    handle = load(ctx);
    handles.set(ctx.store, handle);
    // A failed load is reported, and the next caller may try again.
    handle.catch(() => handles.delete(ctx.store));
  }
  return handle;
}
