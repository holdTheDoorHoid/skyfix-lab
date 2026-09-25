/**
 * Optional data packs in the explorer (EXPANSION_PLAN §3, "Offline first → optional
 * packs"): the service every component reaches through `ctx.packs`, built for this page.
 * OWNER: packs agent.
 *
 *   manifest.ts          the site's list of packs (data/packs/manifest.json)
 *   storage.ts           the app's own cache, skyfix-lab-packs-1@<site>
 *   service.ts           ensure / get / remove / status, and loading saved packs
 *   prompt.ts            the one-line prompt a view's `ensure` shows
 *   settings-section.ts  Settings → Data packs
 *
 * A view that needs a pack asks for it in plain words and carries on either way:
 *
 *   if (await ctx.packs.ensure('deep-time', 'Positions before 1550 need the Deep time pack')) redraw();
 */

import { revision } from '../../sw/policy.js';
import { MANIFEST_PATH } from './manifest.js';
import { domPrompter } from './prompt.js';
import { createPackService, type PackServiceImpl } from './service.js';
import { cachePackStorage } from './storage.js';

export { NO_PACKS, type PackServiceImpl } from './service.js';
export { packsSettings } from './settings-section.js';

/**
 * The site's root address. Built pages keep their modules in `<root>/assets/`
 * (web/plugins/pwa.ts insists), so the root is one level above this module; the
 * development server serves the explorer at `/`.
 */
export function siteRoot(moduleUrl: string = import.meta.url, pageUrl: string = globalThis.location?.href ?? moduleUrl): string {
  return import.meta.env.PROD ? new URL('../', moduleUrl).href : new URL('/', pageUrl).href;
}

/** Content hashes with Web Crypto, where the page is allowed it (a secure address). */
async function digest(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  return revision(bytes.slice());
}

/** How long start-up may wait for saved packs before the page is shown anyway. */
export const START_BUDGET_MS = 3000;

export interface StartedPacks {
  service: PackServiceImpl;
  /** Resolves when the saved packs are loaded, or after `START_BUDGET_MS`, whichever is first. */
  ready: Promise<void>;
}

/**
 * The page's pack service. `onLoaded` runs after each pack goes into the engine (the
 * explorer drops its memoised results then). Saved packs start loading at once.
 */
export function startPacks(engine: unknown, onLoaded: (name: string) => void, root: string = siteRoot()): StartedPacks {
  const service = createPackService({
    engine,
    storage: cachePackStorage(root),
    manifestUrl: new URL(MANIFEST_PATH, root).href,
    prompter: domPrompter(),
    digest,
    onLoaded,
  });
  const started = service.start();
  const ready = Promise.race([started, new Promise<void>((r) => setTimeout(r, START_BUDGET_MS))]);
  return { service, ready };
}
