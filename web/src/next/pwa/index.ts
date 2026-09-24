/**
 * The explorer's offline support: registers the service worker and shows, when there is
 * something to say, the connection and update dock (`dock.ts`). OWNER: release agent.
 *
 * The dock's code and styles load only when needed (offline, a new version, the first
 * install finished), so a normal visit downloads nothing extra. They are in the precache
 * like every other part of the explorer.
 */

import { startServiceWorker } from '../../pwa/register.js';
import type { Dock } from './dock.js';

let dock: Promise<Dock> | null = null;

function withDock(use: (dock: Dock) => void): void {
  dock ??= import('./dock.js').then((m) => m.createDock());
  dock.then(use).catch((error: unknown) => console.warn('SkyFix Lab: could not show the connection notice.', error));
}

/** Call once, when the explorer page starts. */
export function startPwa(win: Window = window): void {
  const syncOnline = (): void => {
    const offline = win.navigator.onLine === false;
    // Nothing to load while online and nothing was shown yet.
    if (offline || dock) withDock((d) => d.setOffline(offline));
  };
  win.addEventListener('online', syncOnline);
  win.addEventListener('offline', syncOnline);
  syncOnline();

  startServiceWorker({
    onUpdateReady: (update) => withDock((d) => d.showUpdate(update)),
    onUpdatedElsewhere: (reload) => withDock((d) => d.showUpdatedElsewhere(reload)),
    onOfflineReady: () => withDock((d) => d.showOfflineReady()),
  });
}
