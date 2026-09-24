/** Entry point: pick an adapter, load the catalogue, mount the interface. */

import './styles.css';
import { selectApi } from './api/index.js';
import { mount } from './app.js';
import { Store, VIEWS, type ViewId } from './store.js';

async function start(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('no #app element');

  const selection = await selectApi();
  const store = new Store(selection.api, { apiNotice: selection.fallbackReason });

  const hash = globalThis.location?.hash.replace('#', '') as ViewId | undefined;
  if (hash && VIEWS.some((v) => v.id === hash)) store.state.view = hash;

  if (selection.fallbackReason) store.notice('caution', selection.fallbackReason);
  if (selection.api.kind === 'mock') {
    store.notice(
      'caution',
      'Running the mock adapter. Numbers on screen are illustrative, not results from the numerical core.',
    );
  }

  mount(store, root);

  void selection.api
    .version()
    .then((version) => store.set({ coreVersion: version }))
    .catch(() => store.set({ coreVersion: 'unavailable' }));
  void selection.api
    .catalog()
    .then((names) => store.set({ bodyCatalog: names }))
    .catch(() => undefined);
}

void start().catch((error: unknown) => {
  const root = document.getElementById('app');
  if (root) {
    root.textContent = `SkyFix Lab failed to start: ${String(error)}`;
  }
});
