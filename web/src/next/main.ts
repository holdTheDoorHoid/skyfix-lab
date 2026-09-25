/**
 * Explorer entry point: the site's home page (`/next/` until the switch-over on 2026-09-24,
 * which now forwards here). OWNER: shell agents (docs/EXPLORER_PLAN.md section 4).
 *
 * Boot order: choose the engine (engine/index.ts policy) -> notices -> store (stored
 * preferences; a share link in the address is applied and removed, now or when pasted) -> frame
 * scheduler -> memoised engine -> the data packs saved on this device, loaded into the
 * engine (packs/, at most START_BUDGET_MS) -> playback clock and time keys -> mount the page.
 *
 * The page mounted is the explorer's shell (`shell/`). The developer harness
 * (`harness/`, a plain page of engine outputs) is still there for checking numbers: add
 * `?harness` to the address. It is a separate chunk that a normal load never fetches.
 */

import { createScheduler, memoEngine, type Component, type Ctx, type Mounted } from './component.js';
import { selectEngine } from './engine/index.js';
import { createNotices } from './notices.js';
import { startPacks } from './packs/index.js';
import { bindTimeKeys, startPlayback } from './playback.js';
import { startPwa } from './pwa/index.js';
import { startInstallOffer } from './shell/install.js';
import { createExplorerStore, listenForShareLinks } from './state.js';

const BANNER = 'Simulation and analysis workbench. Not a navigation instrument.';

/**
 * A page with no engine has nothing to show, so it says that, in place of the
 * interface. It never quietly substitutes the mock.
 */
function fatal(root: HTMLElement, message: string): void {
  const banner = document.createElement('p');
  banner.textContent = BANNER;
  banner.style.fontWeight = '600';
  const heading = document.createElement('h1');
  heading.textContent = 'The SkyFix Lab explorer cannot start';
  const text = document.createElement('p');
  text.textContent = message;
  const back = document.createElement('p');
  const link = document.createElement('a');
  link.href = 'docs/';
  link.textContent = 'The manual';
  back.append(link, ' describes what the explorer needs, and the command-line tool that does the same calculations.');
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.maxWidth = '42rem';
  box.style.margin = '2rem auto';
  box.style.padding = '0 1rem';
  box.style.fontFamily = 'system-ui, sans-serif';
  box.append(banner, heading, text, back);
  root.replaceChildren(box);
}

export interface Booted {
  ctx: Ctx;
  page: Mounted;
  stop(): void;
}

/** The page to mount: the shell, or the developer harness when the address asks for it. */
async function pageComponent(): Promise<Component> {
  if (new URLSearchParams(globalThis.location?.search ?? '').has('harness')) {
    document.body.style.overflow = 'auto';
    return (await import('./harness/harness.js')).harness;
  }
  return (await import('./shell/shell.js')).shell;
}

export async function boot(root: HTMLElement): Promise<Booted> {
  const [selection, page0] = await Promise.all([selectEngine(), pageComponent()]);
  const notices = createNotices();
  selection.notices.forEach((n, i) =>
    notices.push(n.level, n.text, { key: `engine-${i}`, persistent: n.level !== 'info' }),
  );
  const store = createExplorerStore();
  const stopShareLinks = listenForShareLinks(store);
  const scheduler = createScheduler();
  const engine = memoEngine(selection.engine, { freeze: import.meta.env.DEV });
  // Saved packs go into the engine before the first view mounts, so every view starts with
  // the whole engine (a visitor with no packs pays one cache lookup).
  const packs = startPacks(selection.engine, () => engine.invalidate());
  await packs.ready;
  const ctx: Ctx = { store, engine, notices, scheduler, packs: packs.service };
  const stopPlayback = startPlayback(store, scheduler);
  const unbindKeys = bindTimeKeys(window, store);
  const page = page0(root, ctx);
  return {
    ctx,
    page,
    stop() {
      page.destroy();
      packs.service.destroy();
      stopShareLinks();
      unbindKeys();
      stopPlayback();
      scheduler.destroy();
    },
  };
}

const app = document.getElementById('app');
if (app) {
  boot(app)
    .then((booted) => {
      // `data-ready` once the first frame is painted with its fonts (screenshot tooling
      // and tests wait for it; nothing else reads it).
      void document.fonts?.ready.then(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => (document.documentElement.dataset.ready = '1'))),
      );
      // Development only: inspect the running page from the console
      // (`__skyfix.ctx.store.get()`, `__skyfix.ctx.scheduler.flush()`).
      if (import.meta.env.DEV) (globalThis as { __skyfix?: Booted }).__skyfix = booted;
    })
    .catch((error: unknown) => {
      console.error(error);
      fatal(app, error instanceof Error ? error.message : String(error));
    });
}

// Offline use: the service worker, the Offline chip and the update prompt (release agent).
// Outside `boot`, so a page that failed to start can still be offered a fixed version.
startPwa();
// "Install": the browser's install event can come before the shell has loaded; keep it.
startInstallOffer();
