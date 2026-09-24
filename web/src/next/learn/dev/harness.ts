/**
 * DEVELOPER PAGE for the Learn view (`/next/dev-learn.html`). OWNER: learn agent.
 *
 * Boots the explorer's engine, store and scheduler as `main.ts` does and mounts the Learn
 * view alone, under a thin bar with the engine and a theme switch. Everything is settable
 * from the address (query or fragment), so screenshots are reproducible:
 *
 *   ?tab=primer
 *   ?tab=stories&story=clock-offset
 *   ?story=one-bad-sight&variant=robust&view=globe
 *   ?tab=simulator&sim=shared-bias&run=1&experiment=50
 *   &theme=dark|night   &units=nautical   &angles=decimal   &engine=mock
 *   &then=map          press "Show on map" once the story has run
 *
 * Like the shell, the page follows the store's view: when "Show on map" switches it to
 * `map`, the explorer's real Map view is mounted in place of Learn (loaded on demand) with
 * a "Back to Learn" button, so the overlays can be seen where they are meant to be drawn.
 *
 * The page sets `<html data-ready="1">` once the view has settled (the story run and its
 * picture, the globe's coastlines, the fonts). Nothing here is persisted: the store gets
 * no storage, so this page never touches the explorer's saved preferences.
 */

import { h } from '../../../dom.js';
import { createScheduler, memoEngine, type Ctx } from '../../component.js';
import { selectEngine } from '../../engine/index.js';
import { createNotices } from '../../notices.js';
import { createExplorerStore, type AngleFormat, type Units } from '../../state.js';
import { applyTheme, installTooltips, type ThemeName } from '../../theme/index.js';
import type { ChartView } from '../chart-model.js';
import { TABS, type Tab } from '../env.js';
import { learnView } from '../index.js';
import { isStoryId } from '../stories.js';
import type { VariantId } from '../stories.js';

const THEMES: ThemeName[] = ['light', 'dark', 'night'];
const VARIANTS: VariantId[] = ['robust', 'clock-sigma', 'estimate-bias', 'third-star'];

function params(): URLSearchParams {
  const p = new URLSearchParams(location.search);
  for (const [k, v] of new URLSearchParams(location.hash.replace(/^#/, ''))) p.set(k, v);
  return p;
}

async function boot(root: HTMLElement): Promise<void> {
  const p = params();
  const theme = (THEMES as string[]).includes(p.get('theme') ?? '') ? (p.get('theme') as ThemeName) : 'light';
  applyTheme(theme);
  const selection = await selectEngine();
  const notices = createNotices();
  selection.notices.forEach((n, i) => notices.push(n.level, n.text, { key: `engine-${i}`, persistent: n.level !== 'info' }));
  const units = (['metric', 'nautical', 'imperial'] as Units[]).includes(p.get('units') as Units) ? (p.get('units') as Units) : 'metric';
  const angles = (['dm', 'dms', 'decimal'] as AngleFormat[]).includes(p.get('angles') as AngleFormat) ? (p.get('angles') as AngleFormat) : 'dm';
  const store = createExplorerStore({ storage: null, initial: { settings: { theme, units, angleFormat: angles }, view: 'learn' } });
  const scheduler = createScheduler();
  const engine = memoEngine(selection.engine, { freeze: import.meta.env.DEV });
  const ctx: Ctx = { store, engine, notices, scheduler };

  const themeSelect = h('select', { 'aria-label': 'Theme' });
  for (const t of THEMES) themeSelect.append(h('option', { value: t, selected: t === theme }, t));
  themeSelect.addEventListener('change', () => {
    applyTheme(themeSelect.value as ThemeName);
    store.patch({ settings: { theme: themeSelect.value as ThemeName } });
  });
  const unitSelect = h('select', { 'aria-label': 'Units' });
  for (const u of ['metric', 'nautical', 'imperial']) unitSelect.append(h('option', { value: u, selected: u === units }, u));
  unitSelect.addEventListener('change', () => store.patch({ settings: { units: unitSelect.value as Units } }));
  const bar = h(
    'div',
    { class: 'dev-bar' },
    h('strong', {}, 'Learn · developer page'),
    h('span', { class: `dev-engine dev-engine--${selection.engine.kind}` }, selection.engine.kind === 'mock' ? 'MOCK engine (illustrative numbers)' : 'WASM core'),
    themeSelect,
    unitSelect,
    h('span', { class: 'dev-honesty' }, 'Simulation and analysis workbench. Not a navigation instrument.'),
  );
  const noticeList = h('div', { class: 'dev-notices' });
  const renderNotices = (): void => {
    noticeList.replaceChildren(...notices.list().map((n) => h('p', { class: `dev-notice dev-notice--${n.level}` }, n.text)));
  };
  notices.subscribe(renderNotices);
  renderNotices();
  const stage = h('main', { class: 'dev-stage' });
  const mapStage = h('div', { class: 'dev-stage dev-map', hidden: true });
  root.replaceChildren(bar, noticeList, stage, mapStage);

  const style = document.createElement('style');
  style.textContent = `
    #app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
    .dev-bar { display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; padding:6px 16px;
      background: var(--chrome-bg-0); color: var(--chrome-ink); font: 12px/1.4 var(--font-ui); }
    .dev-bar select { font: inherit; background: var(--chrome-raised); color: inherit;
      border: 1px solid var(--chrome-line-strong); border-radius: 6px; padding: 2px 6px; }
    .dev-engine { padding: 1px 8px; border-radius: 999px; font-weight: 600; }
    .dev-engine--mock { background: var(--caution); color: var(--on-caution); }
    .dev-engine--wasm { background: var(--ok); color: var(--chrome-bg-0); }
    .dev-honesty { color: var(--chrome-ink-2); }
    .dev-notices p { margin: 0; padding: 4px 16px; font: 12px/1.4 var(--font-ui);
      background: var(--caution); color: var(--on-caution); }
    .dev-stage { flex: 1; min-height: 0; background: var(--stage-bg); }
    .dev-stage[hidden] { display: none; }
    .dev-map { position: relative; }
    .dev-back { position: absolute; left: 12px; bottom: 12px; z-index: 5; }
  `;
  document.head.append(style);
  installTooltips(document.body);

  const story = p.get('story');
  const tab = (TABS as string[]).includes(p.get('tab') ?? '') ? (p.get('tab') as Tab) : isStoryId(story) ? 'stories' : undefined;
  const variant = (VARIANTS as string[]).includes(p.get('variant') ?? '') ? (p.get('variant') as VariantId) : null;
  const sim = p.get('sim');
  const view = p.get('view') === 'globe' || p.get('view') === 'sheet' ? (p.get('view') as ChartView) : null;
  const experiment = Number(p.get('experiment'));
  learnView({
    ...(tab ? { tab } : {}),
    story: isStoryId(story) ? story : null,
    variant,
    view,
    simulator:
      tab === 'simulator' && isStoryId(sim)
        ? { story: sim, run: p.get('run') === '1', ...(Number.isFinite(experiment) && experiment > 0 ? { experiment } : {}) }
        : null,
  })(stage, ctx);

  // Follow the store's view as the shell does: the Map view when Learn sends overlays to it.
  let map: { destroy(): void } | null = null;
  let mapReady = false;
  const follow = async (view: string): Promise<void> => {
    const onMap = view === 'map' || view === 'globe';
    stage.hidden = onMap;
    mapStage.hidden = !onMap;
    if (onMap && !map) {
      const { createMapView } = await import('../../map/map-view.js');
      const back = h('button', { type: 'button', class: 'sf-btn sf-btn--primary dev-back' }, 'Back to Learn');
      back.addEventListener('click', () => store.patch({ view: 'learn' }));
      mapStage.append(back);
      map = createMapView({
        onReady: (m) => {
          // Settled: the detailed land loaded, tiles in, and the camera still.
          const check = (): void => {
            const detail = mapStage.querySelector<HTMLElement>('.sfm')?.dataset.detail === '1';
            if (detail && m.loaded() && m.areTilesLoaded() && !m.isMoving()) setTimeout(() => (mapReady = true), 600);
            else setTimeout(check, 150);
          };
          check();
        },
      })(mapStage, ctx);
    }
  };
  store.select((s) => s.view, (v) => void follow(v));
  if (p.get('then') === 'map') {
    const press = (): void => {
      const button = [...stage.querySelectorAll<HTMLButtonElement>('.sfl-figure__bar button')].find((b) => b.textContent?.includes('Show on map'));
      if (button && stage.querySelector('.sfl')?.getAttribute('data-state') === 'ready') button.click();
      else setTimeout(press, 100);
    };
    press();
  }

  // "Ready" for screenshots: fonts loaded and the view settled.
  const ready = (): void => {
    const view = stage.querySelector<HTMLElement>('.sfl');
    const settled = p.get('then') === 'map' ? mapReady : view?.dataset.state === 'ready';
    if (settled && document.fonts.status === 'loaded') document.documentElement.dataset.ready = '1';
    else setTimeout(ready, 100);
  };
  void document.fonts.ready.then(ready);
  if (import.meta.env.DEV) (globalThis as { __learn?: unknown }).__learn = { ctx, store };
}

const app = document.getElementById('app');
if (app) {
  boot(app).catch((error: unknown) => {
    console.error(error);
    app.textContent = `The Learn developer page could not start: ${error instanceof Error ? error.message : String(error)}`;
  });
}
