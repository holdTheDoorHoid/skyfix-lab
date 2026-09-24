/**
 * Where the Navigate view's numbers come from. OWNER: navigate agent.
 *
 * - `engine.nav` (engine/wasm-nav.ts, engine/mock-nav.ts): noon sight, Polaris, averaging,
 *   running fix, sight bodies, predicted readings, lunar distance, tonight's sights.
 * - The workbench's session adapter `SkyfixApi` (src/api, reused as the task asks): parse,
 *   reduce, solve, circle points, the old planner. With the WASM engine it is the same
 *   package (`WasmApi.load()` re-uses the module the explorer already initialised); with
 *   the mock engine it is the mock session adapter over the mock's own directions.
 */

import type { SkyfixApi } from '../../api/adapter.js';
import type { ExplorerEngine } from '../engine/types.js';
import { NAV_EXPORTS, type NavTools } from '../engine/wasm-nav.js';

const cache = new WeakMap<object, Promise<SkyfixApi>>();

/** The session adapter for this engine (one per engine object). */
export function sessionApiFor(engine: ExplorerEngine): Promise<SkyfixApi> {
  let promise = cache.get(engine);
  if (!promise) {
    promise =
      engine.kind === 'mock'
        ? import('../engine/mock-nav.js').then((m) => m.createMockSessionApi(engine))
        : import('../../api/wasm.js').then((m) => m.WasmApi.load());
    cache.set(engine, promise);
  }
  return promise;
}

/** The navigation tools, or the sentence that says why there are none. */
export function navToolsFor(engine: ExplorerEngine): { tools: NavTools } | { missing: string } {
  if (engine.nav) return { tools: engine.nav };
  return {
    missing:
      `This build's engine has no navigation tools: its WebAssembly package predates the exports ${NAV_EXPORTS.join(', ')}. ` +
      'The fix still works; the other methods need a rebuilt package (npm run wasm --prefix web, then reload).',
  };
}
