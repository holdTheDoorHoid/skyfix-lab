/**
 * Registering the service worker and noticing new versions. OWNER: release agent.
 * Shared by both pages (the workbench at `/`, the explorer at `/next/`); each page draws
 * its own prompt through the hooks. The worker is src/sw/sw.ts.
 *
 * The rules:
 * - Production builds only: the development server has no sw.js, and a worker there
 *   would fight hot reloading.
 * - A new version never takes over by itself. It waits until the person presses Reload
 *   (`UpdateHandle.apply`) or every tab of the site is closed. Nothing here reloads a
 *   page unless the person asked for it.
 * - The first install is not an update: the page simply becomes available offline.
 * - If another tab applied an update, this tab is told (it still runs the old code) but
 *   is not reloaded.
 */

export interface UpdateHandle {
  /** Let the waiting version take over, then reload this tab. Only on the person's request. */
  apply(): void;
}

export interface PwaHooks {
  /** A new version is installed and waiting. */
  onUpdateReady?(update: UpdateHandle): void;
  /** Another tab applied an update; `reload` loads the new version in this one. */
  onUpdatedElsewhere?(reload: () => void): void;
  /** The first install finished: the site now works offline on this device. */
  onOfflineReady?(): void;
}

/** The parts of `ServiceWorker` used here. */
export interface WorkerLike extends EventTarget {
  readonly state: string;
  postMessage(message: unknown): void;
}

/** The parts of `ServiceWorkerRegistration` used here. */
export interface RegistrationLike extends EventTarget {
  readonly installing: WorkerLike | null;
  readonly waiting: WorkerLike | null;
  readonly active: WorkerLike | null;
  update(): Promise<unknown>;
}

/** The parts of `navigator.serviceWorker` used here. */
export interface ContainerLike extends EventTarget {
  readonly controller: WorkerLike | null;
  register(url: string, options?: RegistrationOptions): Promise<RegistrationLike>;
}

/** Everything this module touches in the browser, so tests can pass fakes. */
export interface PwaEnv {
  readonly container: ContainerLike;
  reload(): void;
  isOnline(): boolean;
  isVisible(): boolean;
  /** Call `listener` when the page comes back online or into view. Returns the stop function. */
  onWake(listener: () => void): () => void;
  now(): number;
  setTimeout(callback: () => void, ms: number): void;
  setInterval(callback: () => void, ms: number): () => void;
}

/** Ask the server for a new sw.js at most this often while the page stays open. */
export const CHECK_EVERY_MS = 60 * 60 * 1000;
/** …and when the page wakes up, if the last check is at least this old. */
export const WAKE_CHECK_AFTER_MS = 15 * 60 * 1000;
/** After Reload, give the new version this long to take over before reloading anyway. */
export const TAKEOVER_TIMEOUT_MS = 4000;

export interface Registered {
  readonly registration: RegistrationLike;
  /** Look for a new version now (rate-limited like the automatic checks unless `force`). */
  check(force?: boolean): void;
  stop(): void;
}

/**
 * Register the worker at `scriptUrl` (its directory is the scope: the whole site) and
 * report versions through `hooks`.
 */
export async function registerServiceWorker(scriptUrl: string, hooks: PwaHooks, env: PwaEnv): Promise<Registered> {
  const { container } = env;
  // Is this page served by a worker? Not on a first visit, nor after a hard reload.
  let controlled = container.controller !== null;
  let applying = false;
  const registration = await container.register(scriptUrl, { scope: new URL('./', scriptUrl).href });
  // No worker had finished installing before this page loaded: this is the first install.
  const firstInstall = registration.active === null;

  const offered = new WeakSet<WorkerLike>();
  const offer = (worker: WorkerLike): void => {
    // A page with no worker behind it has nothing to replace.
    if (!controlled || offered.has(worker)) return;
    offered.add(worker);
    hooks.onUpdateReady?.({
      apply() {
        if (applying) return;
        applying = true;
        worker.postMessage({ type: 'SKIP_WAITING' });
        // `controllerchange` normally reloads; this covers a worker that never takes over.
        env.setTimeout(() => env.reload(), TAKEOVER_TIMEOUT_MS);
      },
    });
  };

  let offlineReadySent = false;
  const watch = (worker: WorkerLike): void => {
    const onState = (): void => {
      if (worker.state === 'installed' && registration.waiting === worker) offer(worker);
      if (worker.state === 'activated' && firstInstall && !offlineReadySent) {
        offlineReadySent = true;
        hooks.onOfflineReady?.();
      }
      if (worker.state === 'activated' || worker.state === 'redundant') worker.removeEventListener('statechange', onState);
    };
    worker.addEventListener('statechange', onState);
  };

  if (registration.waiting) offer(registration.waiting);
  if (registration.installing) watch(registration.installing);
  const onUpdateFound = (): void => {
    if (registration.installing) watch(registration.installing);
  };
  registration.addEventListener('updatefound', onUpdateFound);

  const onControllerChange = (): void => {
    if (applying) {
      env.reload();
      return;
    }
    if (!controlled) {
      // The first install took charge of this page (clients.claim): nothing changed for it.
      controlled = true;
      return;
    }
    hooks.onUpdatedElsewhere?.(() => env.reload());
  };
  container.addEventListener('controllerchange', onControllerChange);

  let lastCheck = env.now();
  const check = (force = false): void => {
    if (!env.isOnline() || !env.isVisible()) return;
    if (!force && env.now() - lastCheck < WAKE_CHECK_AFTER_MS) return;
    lastCheck = env.now();
    registration.update().catch(() => undefined);
  };
  const stopWake = env.onWake(() => check());
  const stopTimer = env.setInterval(() => check(true), CHECK_EVERY_MS);

  return {
    registration,
    check,
    stop() {
      stopWake();
      stopTimer();
      registration.removeEventListener('updatefound', onUpdateFound);
      container.removeEventListener('controllerchange', onControllerChange);
    },
  };
}

// ---------------------------------------------------------------------------------
// In the browser
// ---------------------------------------------------------------------------------

/**
 * sw.js sits at the site root and every built module in `<root>/assets/` (Vite's
 * `assetsDir`; web/plugins/pwa.ts refuses any other). A variable, not a literal, so Vite
 * does not try to resolve it as an import at build time.
 */
const WORKER_FROM_MODULE = '../sw.js';

export function serviceWorkerUrl(moduleUrl: string = import.meta.url): string {
  return new URL(WORKER_FROM_MODULE, moduleUrl).href;
}

function browserEnv(): PwaEnv {
  return {
    container: navigator.serviceWorker,
    reload: () => location.reload(),
    isOnline: () => navigator.onLine !== false,
    isVisible: () => document.visibilityState !== 'hidden',
    onWake(listener) {
      const onVisibility = (): void => {
        if (document.visibilityState === 'visible') listener();
      };
      window.addEventListener('online', listener);
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        window.removeEventListener('online', listener);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    },
    now: () => Date.now(),
    setTimeout: (callback, ms) => void window.setTimeout(callback, ms),
    setInterval(callback, ms) {
      const id = window.setInterval(callback, ms);
      return () => window.clearInterval(id);
    },
  };
}

/**
 * Register the service worker once the page has loaded (so its downloads never compete
 * with the page's own), in production builds on a secure origin. Failures are logged and
 * otherwise ignored: the page works without offline support.
 */
export function startServiceWorker(hooks: PwaHooks): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  const go = (): void => {
    registerServiceWorker(serviceWorkerUrl(), hooks, browserEnv()).catch((error: unknown) => {
      console.warn('SkyFix Lab: offline use is not available in this browser session.', error);
    });
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}
