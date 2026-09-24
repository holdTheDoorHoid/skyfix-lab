/** Entry point: pick an adapter, load the catalogue and the demos, mount the interface. */

import './styles.css';
import { selectApi } from './api/index.js';
import { mount } from './app.js';
import { startWorkbenchPwa } from './pwa/workbench-prompt.js';
import { Store, VIEWS, type ViewId } from './store.js';

/**
 * A build with no numerical core has nothing to say, so it says that, in place of the
 * interface. It never quietly substitutes the mock.
 */
function fatal(message: string): void {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'fatal';
  const heading = document.createElement('h1');
  heading.textContent = 'SkyFix Lab cannot start';
  const text = document.createElement('p');
  text.textContent = message;
  const banner = document.createElement('p');
  banner.className = 'fatal-banner';
  banner.textContent = 'Simulation and analysis workbench. Not a navigation instrument.';
  box.append(banner, heading, text);
  root.appendChild(box);
}

async function start(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('no #app element');

  const selection = await selectApi();
  const store = new Store(selection.api, { apiNotice: selection.mockReason });

  const hash = globalThis.location?.hash.replace('#', '') as ViewId | undefined;
  if (hash && VIEWS.some((v) => v.id === hash)) store.state.view = hash;

  if (selection.mockReason) store.notice('caution', selection.mockReason);

  mount(store, root);

  void selection.api
    .version()
    .then((version) => store.set({ coreVersion: version }))
    .catch(() => store.set({ coreVersion: 'unavailable' }));
  void selection.api
    .catalog()
    .then((names) => store.set({ bodyCatalog: names }))
    .catch((error: unknown) => store.notice('error', `Body catalogue: ${String(error)}`));
  void selection.api
    .demos()
    .then((demos) => {
      const first = demos[0];
      store.set({
        demos,
        simulation: first
          ? { ...store.state.simulation, scenario: structuredClone(first.scenario) }
          : store.state.simulation,
      });
    })
    .catch((error: unknown) => store.notice('error', `Packaged demos: ${String(error)}`));
}

void start().catch((error: unknown) => {
  fatal(error instanceof Error ? error.message : String(error));
});

// Offline use (service worker), independent of whether the page started: a fixed
// version can still be offered to a page that failed.
startWorkbenchPwa();
