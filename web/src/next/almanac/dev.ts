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

import '../theme/index.js';
import './dev.css';
import { createScheduler, memoEngine, type Ctx } from '../component.js';
import { selectEngine } from '../engine/index.js';
import { createNotices } from '../notices.js';
import { createExplorerStore } from '../state.js';
import { applyTheme, badge, button, installTooltips, setPressed, type ThemeName } from '../theme/index.js';
import { almanacView } from './almanac.js';
import { jdOfUtDate } from './layout.js';
import { NO_PACKS } from '../packs/service.js';

const THEMES: readonly ThemeName[] = ['light', 'dark', 'night'];

function setTheme(theme: ThemeName, buttons: Map<ThemeName, HTMLButtonElement>): void {
  applyTheme(theme);
  for (const [t, b] of buttons) setPressed(b, t === theme);
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
  const spacer = document.createElement('span');
  spacer.className = 'dev-bar__spacer';
  bar.append(spacer);
  const buttons = new Map<ThemeName, HTMLButtonElement>();
  for (const t of THEMES) {
    const b = button({
      label: t[0]!.toUpperCase() + t.slice(1),
      size: 'sm',
      variant: 'ghost',
      pressed: false,
      onClick: () => setTheme(t, buttons),
    });
    buttons.set(t, b);
    bar.append(b);
  }
  // `?paper=a4` or `?paper=letter` fixes the printed sheet size, for checking both.
  const paper = params.get('paper');
  if (paper === 'a4' || paper === 'letter') {
    const style = document.createElement('style');
    style.textContent = `@page { size: ${paper === 'a4' ? 'A4' : 'letter'} portrait; }`;
    document.head.append(style);
  }
  const requested = params.get('theme');
  setTheme(THEMES.includes(requested as ThemeName) ? (requested as ThemeName) : 'light', buttons);
  bar.classList.add('sf-on-chrome');

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
  bar.insertBefore(badge(selection.engine.kind === 'wasm' ? 'wasm' : 'mock'), spacer);
  installTooltips();

  const store = createExplorerStore({ storage: null });
  const date = params.get('date');
  const hour = Number(params.get('hour') ?? '12');
  const jd0 = date ? jdOfUtDate(date) : null;
  if (jd0 !== null) {
    store.patch({ time: { jd_utc: jd0 + (Number.isFinite(hour) ? hour : 12) / 24, live: false, playing: false } });
  }
  const scheduler = createScheduler();
  const engine = memoEngine(selection.engine, { freeze: import.meta.env.DEV });
  const ctx: Ctx = { store, engine, notices, scheduler, packs: NO_PACKS };
  const page = almanacView(host, ctx);
  if (import.meta.env.DEV) (globalThis as { __almanac?: unknown }).__almanac = { ctx, page };
}

main().catch((error: unknown) => {
  console.error(error);
  const app = document.getElementById('app');
  if (app) app.textContent = `The almanac harness cannot start: ${error instanceof Error ? error.message : String(error)}`;
});
