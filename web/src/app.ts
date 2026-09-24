/** The shell: header banner, session-kind badge, navigation, notices, active view. */

import { button, clear, h } from './dom.js';
import type { Store, ViewId } from './store.js';
import { VIEWS } from './store.js';
import { renderObservations } from './views/observations.js';
import { renderCorrections } from './views/corrections.js';
import { renderFix } from './views/fix.js';
import { renderSimulator } from './views/simulator.js';
import { renderPlanner } from './views/planner.js';
import { renderAbout } from './views/about.js';

const BANNER = 'Simulation and analysis workbench. Not a navigation instrument.';

function kindBadge(kind: 'simulated' | 'real'): HTMLElement {
  return h(
    'span',
    {
      class: `kind-badge kind-${kind}`,
      title:
        kind === 'simulated'
          ? 'Every altitude in this session was generated, not measured.'
          : 'These altitudes came from an instrument.',
    },
    kind === 'simulated' ? '◇ SIMULATED' : '● REAL',
  );
}

const API_BADGE_TEXT: Record<'wasm' | 'mock' | 'hybrid', string> = {
  wasm: '■ WASM core',
  hybrid: '◨ WASM core, partly mocked',
  mock: '△ MOCK adapter',
};

function apiBadge(store: Store): HTMLElement {
  return h(
    'span',
    { class: `api-badge api-${store.api.kind}`, title: store.api.description },
    API_BADGE_TEXT[store.api.kind],
  );
}

function renderHeader(store: Store, header: HTMLElement): void {
  clear(header);
  header.appendChild(
    h(
      'div',
      { class: 'banner', role: 'note' },
      h('span', { class: 'banner-text' }, BANNER),
      h('span', { class: 'badges' }, kindBadge(store.state.session.meta.kind), apiBadge(store)),
    ),
  );
  header.appendChild(
    h(
      'div',
      { class: 'titlebar' },
      h('h1', {}, 'SkyFix Lab'),
      h(
        'span',
        { class: 'session-name' },
        store.state.session.meta.name || 'Untitled session',
        h('span', { class: 'muted' }, ` · ${store.state.session.observations.length} sight(s)`),
      ),
    ),
  );
}

function renderNav(store: Store, nav: HTMLElement, onSelect: (id: ViewId) => void): void {
  clear(nav);
  const tablist = h('div', { class: 'tablist', role: 'tablist', 'aria-label': 'Views' });
  const buttons: HTMLButtonElement[] = [];
  VIEWS.forEach((view, index) => {
    const selected = store.state.view === view.id;
    const tab = h(
      'button',
      {
        type: 'button',
        class: selected ? 'tab selected' : 'tab',
        role: 'tab',
        id: `tab-${view.id}`,
        'aria-selected': selected ? 'true' : 'false',
        'aria-controls': 'view-panel',
      },
      view.label,
    ) as HTMLButtonElement;
    tab.tabIndex = selected ? 0 : -1;
    tab.addEventListener('click', () => onSelect(view.id));
    tab.addEventListener('keydown', (event) => {
      const keys: Record<string, number> = {
        ArrowRight: index + 1,
        ArrowLeft: index - 1,
        Home: 0,
        End: VIEWS.length - 1,
      };
      const target = keys[event.key];
      if (target === undefined) return;
      event.preventDefault();
      const next = (target + VIEWS.length) % VIEWS.length;
      onSelect(VIEWS[next]!.id);
      buttons[next]?.focus();
    });
    buttons.push(tab);
    tablist.appendChild(tab);
  });
  nav.appendChild(tablist);
}

function renderNotices(store: Store, container: HTMLElement): void {
  clear(container);
  if (store.state.notices.length === 0) return;
  const list = h('ul', { class: 'notices', role: 'status', 'aria-live': 'polite' });
  for (const notice of store.state.notices) {
    list.appendChild(
      h(
        'li',
        { class: `notice notice-${notice.level}` },
        h('span', { class: 'notice-tag' }, notice.level === 'error' ? 'Error' : notice.level === 'caution' ? 'Caution' : 'Note'),
        notice.text,
      ),
    );
  }
  container.appendChild(list);
  container.appendChild(button('Dismiss messages', () => store.dismissNotices(), { class: 'small' }));
}

export function mount(store: Store, root: HTMLElement): void {
  clear(root);
  const header = h('header', { class: 'app-header' });
  const nav = h('nav', { class: 'app-nav' });
  const notices = h('div', { class: 'notice-area' });
  const panel = h('main', { class: 'view', id: 'view-panel', role: 'tabpanel' });
  root.append(header, nav, notices, panel);

  const select = (id: ViewId): void => {
    if (store.state.view === id) return;
    store.set({ view: id });
    if (globalThis.location) {
      const url = new URL(globalThis.location.href);
      url.hash = id;
      history.replaceState(null, '', url);
    }
  };

  const draw = (): void => {
    renderHeader(store, header);
    renderNav(store, nav, select);
    renderNotices(store, notices);
    panel.setAttribute('aria-labelledby', `tab-${store.state.view}`);
    switch (store.state.view) {
      case 'observations':
        renderObservations(store, panel);
        break;
      case 'corrections':
        renderCorrections(store, panel);
        break;
      case 'fix':
        renderFix(store, panel);
        break;
      case 'simulator':
        renderSimulator(store, panel);
        break;
      case 'planner':
        renderPlanner(store, panel);
        break;
      case 'about':
        renderAbout(store, panel);
        break;
    }
  };

  store.subscribe(draw);
  draw();
}
