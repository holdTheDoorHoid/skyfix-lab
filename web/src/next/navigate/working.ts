/**
 * The working session's store, one per explorer page, shared by the Navigate view and the
 * "Tonight's star sights" panel section (so "Use these bodies" there lands in the view's
 * sight list). It is created on first use from the saved copy (autosave.ts) or, with none,
 * from the explorer's place and instrument settings, and it saves itself while autosave
 * is on and it holds something the person entered (model.ts `hasOwnData`; until then the
 * explorer's place stays out of storage). OWNER: navigate agent.
 */

import { createStore, safeLocalStorage, type ExplorerStore, type Store } from '../state.js';
import { isoUtc, jdNow } from '../time.js';
import { AUTOSAVE_KEY, forgetWorking, loadWorking, saveWorking } from './autosave.js';
import { defaultWorking, hasOwnData, type Working } from './model.js';

export type WorkingStore = Store<Working>;

export interface AutosaveState {
  /** The person's choice. */
  enabled: boolean;
  /** Whether this browser lets the page store anything at all. */
  available: boolean;
  /** When the last copy was written (RFC 3339 UTC), or null. */
  savedUtc: string | null;
  /** The last attempt failed (quota, blocked storage). */
  failed: boolean;
}

export interface WorkingHandle {
  store: WorkingStore;
  autosave: Store<AutosaveState>;
  setAutosave(enabled: boolean): void;
  /** Remove the saved copy now (and keep autosave off). */
  forget(): void;
  /** Stop saving (tests). */
  dispose(): void;
}

export interface WorkingOptions {
  /** Where to keep the copy. Default: `safeLocalStorage()`. `null`: never saved. */
  storage?: Storage | null;
  /** Milliseconds to wait after the last change before saving. Default 400. */
  delayMs?: number;
  now?: () => number;
}

/** A new session from the explorer's place and instrument settings. */
export function seedFromExplorer(explorer: ExplorerStore): Working {
  const s = explorer.get();
  return defaultWorking({
    position: { lat_deg: s.observer.lat_deg, lon_deg: s.observer.lon_deg },
    heightOfEyeM: s.settings.height_of_eye_m,
    indexCorrectionArcmin: s.settings.index_correction_arcmin,
    pressureHpa: s.settings.pressure_hpa,
    temperatureC: s.settings.temperature_c,
  });
}

export function createWorking(explorer: ExplorerStore, options: WorkingOptions = {}): WorkingHandle {
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
  const now = options.now ?? (() => Date.now());
  const loaded = loadWorking(storage);
  const store = createStore<Working>(loaded.working ?? seedFromExplorer(explorer));
  const autosave = createStore<AutosaveState>({
    enabled: loaded.autosave && storage !== null,
    available: storage !== null,
    savedUtc: loaded.savedUtc,
    failed: false,
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    if (!autosave.get().enabled) return;
    if (!hasOwnData(store.get())) {
      // Nothing of the person's own (model.ts `hasOwnData`): keep nothing, and drop an
      // older copy (the last sight was deleted, or a new session was started).
      forgetWorking(storage, false);
      autosave.patch({ savedUtc: null, failed: false });
      return;
    }
    const at = isoUtc(jdNow(now()));
    const ok = saveWorking(storage, store.get(), at);
    autosave.patch({ savedUtc: ok ? at : autosave.get().savedUtc, failed: !ok });
  };
  const schedule = (): void => {
    if (!autosave.get().enabled) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, options.delayMs ?? 400);
  };
  const unsubscribe = store.subscribe(schedule);
  const onHide = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      flush();
    }
  };
  globalThis.addEventListener?.('pagehide', onHide);
  return {
    store,
    autosave,
    setAutosave(enabled) {
      if (enabled && !storage) return;
      autosave.patch({ enabled });
      if (enabled) flush();
      else {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        forgetWorking(storage, true);
        autosave.patch({ savedUtc: null });
      }
    },
    forget() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      forgetWorking(storage, true);
      autosave.patch({ enabled: false, savedUtc: null });
    },
    dispose() {
      unsubscribe();
      globalThis.removeEventListener?.('pagehide', onHide);
      if (timer !== null) clearTimeout(timer);
    },
  };
}

const handles = new WeakMap<ExplorerStore, WorkingHandle>();

/**
 * The page's working session (one per explorer store). The first caller's options decide
 * where it is kept; later callers share it.
 */
export function workingFor(explorer: ExplorerStore, options: WorkingOptions = {}): WorkingHandle {
  let handle = handles.get(explorer);
  if (!handle) {
    handle = createWorking(explorer, options);
    handles.set(explorer, handle);
  }
  return handle;
}

export { AUTOSAVE_KEY };
