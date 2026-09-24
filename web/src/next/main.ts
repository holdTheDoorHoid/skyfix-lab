/**
 * Explorer entry point (`/next/`). OWNER: shell agents (docs/EXPLORER_PLAN.md section 4).
 *
 * Boot order: choose the engine (engine/index.ts policy) -> notices -> store (stored
 * preferences; a share link in the address is applied and removed, now or when pasted) -> frame
 * scheduler -> memoised engine -> playback clock and time keys -> mount the page.
 *
 * The page mounted today is the developer harness (`harness/`); the shell replaces that
 * one import. The rest of the boot sequence is meant to stay.
 */

import { createScheduler, memoEngine, type Ctx, type Mounted } from './component.js';
import { selectEngine } from './engine/index.js';
import { harness } from './harness/harness.js';
import { createNotices } from './notices.js';
import { bindTimeKeys, startPlayback } from './playback.js';
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
  link.href = '../';
  link.textContent = 'The current workbench is one level up.';
  back.append(link);
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

export async function boot(root: HTMLElement): Promise<Booted> {
  const selection = await selectEngine();
  const notices = createNotices();
  selection.notices.forEach((n, i) =>
    notices.push(n.level, n.text, { key: `engine-${i}`, persistent: n.level !== 'info' }),
  );
  const store = createExplorerStore();
  const stopShareLinks = listenForShareLinks(store);
  const scheduler = createScheduler();
  const engine = memoEngine(selection.engine, { freeze: import.meta.env.DEV });
  const ctx: Ctx = { store, engine, notices, scheduler };
  const stopPlayback = startPlayback(store, scheduler);
  const unbindKeys = bindTimeKeys(window, store);
  const page = harness(root, ctx);
  return {
    ctx,
    page,
    stop() {
      page.destroy();
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
      // Development only: inspect the running page from the console
      // (`__skyfix.ctx.store.get()`, `__skyfix.ctx.scheduler.flush()`).
      if (import.meta.env.DEV) (globalThis as { __skyfix?: Booted }).__skyfix = booted;
    })
    .catch((error: unknown) => {
      console.error(error);
      fatal(app, error instanceof Error ? error.message : String(error));
    });
}
