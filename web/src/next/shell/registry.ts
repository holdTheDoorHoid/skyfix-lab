/**
 * Where views and panel slots come from. OWNER: shell-design agent.
 *
 * VIEWS. Each view lives in its own folder and is found by file name, so a view merged
 * later needs no change here:
 *
 *   src/next/<folder>/view.ts        export default (host, ctx) => ({ destroy })
 *
 * A view with another entry file gets one line in `VIEW_ENTRIES` (Charts: `charts/index.ts`).
 *
 * `VIEW_FOLDERS` says which folder serves which view id (`map` and `globe` are both the
 * map agent's). A folder that is not there yet shows a friendly "coming soon" page
 * (`placeholder.ts`). The component takes over the stage element it is given: it fills
 * it (the stage is `position: relative`, the host `position: absolute; inset: 0`), keeps
 * clear of the panel tab in the top-left 28 x 56 px, and reads the phone sheet's height
 * from the stage's `--stage-inset-bottom` custom property when it has to keep something in
 * view. It is destroyed when another folder's view is chosen; switching between two ids
 * served by the same folder (`map` <-> `globe`) keeps it mounted, and the component
 * follows `state.view` itself.
 *
 * PANEL SLOTS. A section of the side panel that another agent fills:
 *
 *   src/next/<folder>/slots/<slot>.ts   export default (host, ctx) => ({ destroy })
 *
 * Today there is one slot, `star-sights` ("Tonight's star sights"). When no module
 * provides it, the panel shows its own placeholder there.
 */

import type { Component } from '../component.js';
import type { ViewId } from '../state.js';

export interface ViewModule {
  default?: Component;
  view?: Component;
}

export type ModuleLoader = () => Promise<ViewModule>;

/** The folder that serves each view. */
export const VIEW_FOLDERS: Record<ViewId, string> = {
  map: 'map',
  globe: 'map',
  sky: 'sky',
  charts: 'charts',
  navigate: 'navigate',
  almanac: 'almanac',
  events: 'events',
  learn: 'learn',
  about: 'about',
};

export const SLOT_NAMES = ['star-sights'] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export interface Registry {
  /** The loader for a view, or null when its folder has no `view.ts` (yet). */
  view(id: ViewId): ModuleLoader | null;
  /** The loader for a panel slot, or null when no folder provides it. */
  slot(name: SlotName): ModuleLoader | null;
}

/**
 * Views whose entry is not `<folder>/view.ts`: one line each, by folder. Such a folder
 * must exist (the import is checked at build time), so add its line when it is merged.
 */
export const VIEW_ENTRIES: Record<string, ModuleLoader> = {
  charts: () => import('../charts/index.js').then((m) => ({ default: m.charts })),
};

/** A registry over explicit module maps (the keys are paths as `import.meta.glob` gives them). */
export function createRegistry(
  views: Record<string, ModuleLoader>,
  slots: Record<string, ModuleLoader>,
  entries: Record<string, ModuleLoader> = {},
): Registry {
  return {
    view(id) {
      const folder = VIEW_FOLDERS[id];
      return entries[folder] ?? views[`../${folder}/view.ts`] ?? null;
    },
    slot(name) {
      const key = Object.keys(slots)
        .filter((k) => k.endsWith(`/slots/${name}.ts`))
        .sort()[0];
      return key ? (slots[key] ?? null) : null;
    },
  };
}

/** The component a view module exports: `default`, or a named `view`. */
export function componentOf(mod: ViewModule): Component | null {
  return mod.default ?? mod.view ?? null;
}

/** The registry of this build: every `view.ts` and `slots/*.ts` present under src/next/. */
export const registry: Registry = createRegistry(
  import.meta.glob<ViewModule>('../*/view.ts'),
  import.meta.glob<ViewModule>('../*/slots/*.ts'),
  VIEW_ENTRIES,
);
