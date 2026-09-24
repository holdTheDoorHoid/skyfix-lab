/**
 * DEVELOPER HARNESS for the Almanac view: `next/dev-almanac.html`. OWNER: almanac agent.
 *
 * Boots the engine (the same policy as the explorer: the WebAssembly core, or the mock
 * with `?engine=mock`), a store, a scheduler and the memoised engine, and mounts the view
 * alone. Query parameters, for screenshots:
 *
 *   ?date=YYYY-MM-DD   the UT date to open on (default: now)
 *   ?hour=HH           the UT hour (default 12)
 *   ?theme=light|dark|night
 *
 * Nothing outside `almanac/` imports from here.
 */

import '@fontsource-variable/inter';
import './dev.css';
import { createScheduler, memoEngine, type Ctx } from '../component.js';
import { selectEngine } from '../engine/index.js';
import { createNotices } from '../notices.js';
import { createExplorerStore } from '../state.js';
import { almanacView } from './almanac.js';
import { jdOfUtDate } from './layout.js';

const THEMES = ['light', 'dark', 'night'] as const;
type Theme = (typeof THEMES)[number];

function setTheme(theme: Theme, buttons: Map<Theme, HTMLButtonElement>): void {
  document.documentElement.dataset.theme = theme;
  for (const [t, b] of buttons) b.setAttribute('aria-pressed', String(t === theme));
}

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;
  const params = new URLSearchParams(location.search);

  const bar = document.createElement('div');
  bar.className = 'dev-bar';
  const label = document.createElement('span');
  label.textContent = 'Almanac harness · Simulation and analysis workbench. Not a navigation instrument.';
  bar.append(label);
  const buttons = new Map<Theme, HTMLButtonElement>();
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t[0]!.toUpperCase() + t.slice(1);
    b.addEventListener('click', () => setTheme(t, buttons));
    buttons.set(t, b);
    bar.append(b);
  }
  const requested = params.get('theme');
  setTheme(THEMES.includes(requested as Theme) ? (requested as Theme) : 'light', buttons);

  const noticeList = document.createElement('ul');
  noticeList.className = 'dev-notices';
  const host = document.createElement('main');
  app.replaceChildren(bar, noticeList, host);

  const selection = await selectEngine();
  const notices = createNotices();
  notices.subscribe((list) => {
    noticeList.replaceChildren(
      ...list.map((n) => {
        const li = document.createElement('li');
        li.textContent = `${n.level.toUpperCase()}: ${n.text}`;
        return li;
      }),
    );
  });
  selection.notices.forEach((n, i) => notices.push(n.level, n.text, { key: `engine-${i}`, persistent: true }));
  const engineLabel = document.createElement('span');
  engineLabel.textContent = `engine: ${selection.engine.kind}`;
  bar.append(engineLabel);

  const store = createExplorerStore({ storage: null });
  const date = params.get('date');
  const hour = Number(params.get('hour') ?? '12');
  const jd0 = date ? jdOfUtDate(date) : null;
  if (jd0 !== null) {
    store.patch({ time: { jd_utc: jd0 + (Number.isFinite(hour) ? hour : 12) / 24, live: false, playing: false } });
  }
  const scheduler = createScheduler();
  const engine = memoEngine(selection.engine, { freeze: import.meta.env.DEV });
  const ctx: Ctx = { store, engine, notices, scheduler };
  const page = almanacView(host, ctx);
  if (import.meta.env.DEV) (globalThis as { __almanac?: unknown }).__almanac = { ctx, page };
}

main().catch((error: unknown) => {
  console.error(error);
  const app = document.getElementById('app');
  if (app) app.textContent = `The almanac harness cannot start: ${error instanceof Error ? error.message : String(error)}`;
});
