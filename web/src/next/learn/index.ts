/**
 * The Learn view (EXPLORER_PLAN section 2). OWNER: learn agent.
 *
 * Three tabs on one page:
 *
 *   How it works     five illustrated steps, each linked to a demonstration
 *   Demonstrations   the ten packaged scenarios as guided stories: run one, see the answer
 *                    against the answer key, read what happened and why, try the next thing
 *   Simulator        the workbench's scenario editor, generate-and-solve with the truth
 *                    comparison, and the coverage experiment with its verdict band
 *
 * Mount with the standard component contract (the shell's registry, for view `learn`):
 *
 * ```ts
 * import { learn } from './learn/index.js';
 * const view = learn(host, ctx); // later: view.destroy()
 * ```
 *
 * Honesty rules (run.ts, chart-model.ts): the simulated truth is only ever the answer key
 * beside a result and never reaches the solver; result kinds are always named; a
 * suppressed ellipse is never drawn; everything simulated says so.
 */

import '../theme/index.js';
import './learn.css';
import { h } from '../../dom.js';
import type { DemoEntry } from '../../api/adapter.js';
import { disposer, type Component, type Ctx, type Mounted } from '../component.js';
import { createStore, shallowEqual, type ExplorerStore } from '../state.js';
import { icon } from '../theme/index.js';
import { learnApi, type ApiHandle } from './api.js';
import type { ChartView } from './chart-model.js';
import { initialSim, TABS, type LearnEnv, type LearnState, type SimulatorRequest, type StoryRunState, type Tab } from './env.js';
import { makeFmt } from './facts.js';
import { loadLand } from './land.js';
import { showOnMap } from './mapbridge.js';
import { primerTab } from './primer.js';
import { runStory } from './run.js';
import { applyPreset, generateAndSolve, runExperiment, simulatorTab } from './simulator.js';
import { storiesTab } from './stories-view.js';
import type { StoryId, VariantId } from './stories.js';

export interface LearnOptions {
  /** The tab to open with. Default: where the person left it on this page, else "How it works". */
  tab?: Tab;
  /** Run this story on opening (the developer page uses it). */
  story?: StoryId | null;
  variant?: VariantId | null;
  /** Open the Simulator with this request. */
  simulator?: SimulatorRequest | null;
  /** The picture to prefer (close-up or globe). */
  view?: ChartView | null;
  /** The adapter to use instead of `learnApi(ctx)` (tests, the developer page). */
  api?: Promise<ApiHandle>;
  /** Offer "Show on map" (default true: the map's overlay service needs no map on screen). */
  mapActions?: boolean;
}

const TAB_LABEL: Record<Tab, { label: string; tip: string }> = {
  primer: { label: 'How it works', tip: 'Five illustrated steps: from one star to a position you can trust' },
  stories: { label: 'Demonstrations', tip: 'The ten packaged demonstrations, run and explained' },
  simulator: { label: 'Simulator', tip: 'Edit a scenario, solve it, and test its uncertainty with a coverage experiment' },
};

/** The Learn state of each page, kept while the page is open (per explorer store). */
const pages = new WeakMap<ExplorerStore, LearnState>();

let uidSeq = 0;

export function learnView(options: LearnOptions = {}): Component {
  return (host: HTMLElement, ctx: Ctx): Mounted => {
    const d = disposer();
    const uid = `sfl-${++uidSeq}`;
    const saved = pages.get(ctx.store);
    const state = createStore<LearnState>(
      saved ?? { tab: options.tab ?? 'primer', story: null, chartView: options.view ?? null, sim: initialSim() },
    );
    if (saved && options.tab) state.patch({ tab: options.tab });
    d.add(state.subscribe((s) => pages.set(ctx.store, s)));
    pages.set(ctx.store, state.get());

    const handle = options.api ?? learnApi(ctx);
    let settled: ApiHandle | null = null;
    void handle.then((x) => (settled = x)).catch(() => undefined);
    let demosPromise: Promise<readonly DemoEntry[]> | null = null;

    const root = h('div', { class: 'sfl sf-on-stage', 'data-state': 'loading' });
    host.append(root);
    d.add(() => root.remove());

    let runSeq = 0;
    const setStory = (story: StoryRunState): void => state.set({ ...state.get(), story });

    const env: LearnEnv = {
      ctx,
      state,
      api: () => handle,
      demos: () => {
        demosPromise ??= handle.then(({ api }) => api.demos());
        demosPromise.catch(() => {
          demosPromise = null;
        });
        return demosPromise;
      },
      fmt: () => {
        const s = ctx.store.get().settings;
        return makeFmt(s.units, s.angleFormat);
      },
      onFmtChange: (listener) =>
        ctx.store.select((s) => [s.settings.units, s.settings.angleFormat] as const, () => listener(), { equals: shallowEqual }),
      figureEnv: (title) => ({
        fmt: env.fmt,
        land: () => loadLand(),
        ...(options.mapActions === false ? {} : { showOnMap: (model) => showOnMap(ctx, model, title) }),
      }),
      engineLabel: () => (settled?.api.kind === 'mock' ? 'mock adapter' : 'WebAssembly core'),
      runStory: async (id, variant, opts = {}) => {
        const seq = ++runSeq;
        const scroll = Boolean(opts.scroll);
        state.batch(() => {
          state.patch({ tab: 'stories' });
          setStory({ id, variant, status: 'running', run: null, error: null, scroll });
        });
        try {
          const { api } = await handle;
          const demos = await env.demos();
          const run = await runStory(api, demos, id, variant);
          if (seq === runSeq) setStory({ id, variant, status: 'done', run, error: null, scroll });
        } catch (error) {
          if (seq === runSeq) setStory({ id, variant, status: 'error', run: null, error: error instanceof Error ? error.message : String(error), scroll });
        }
      },
      openSimulator: async (request) => {
        state.patch({ tab: 'simulator' });
        const demos = await env.demos();
        const base = request.scenario ?? demos.find((x) => x.name === request.story)?.scenario;
        if (!base) return;
        const cur = state.get().sim;
        state.set({
          ...state.get(),
          sim: {
            ...cur,
            scenario: applyPreset(base, request.preset),
            source: request.story ?? cur.source,
            run: null,
            runError: null,
            summary: null,
            summaryScenario: null,
            expError: null,
            repetitions: request.experiment ?? cur.repetitions,
            editorVersion: cur.editorVersion + 1,
          },
        });
        if (request.run) await generateAndSolve(env);
        if (request.experiment) await runExperiment(env);
      },
      selectTab: (tab) => state.patch({ tab }),
      markReady: () => {
        root.dataset.state = 'ready';
      },
      reveal: (el) => {
        const stacked = typeof matchMedia === 'function' && matchMedia('(max-width: 899px)').matches;
        if (stacked) el.scrollIntoView({ block: 'start' });
        el.focus({ preventScroll: true });
      },
    };

    // --- header and tabs ------------------------------------------------------------------
    const tablist = h('div', { class: 'sf-seg sfl-tabs', role: 'tablist', 'aria-label': 'Learn' });
    const panel = h('div', { class: 'sfl-panel', role: 'tabpanel', id: `${uid}-panel`, tabindex: '-1' });
    const tabButtons = TABS.map((t, i) => {
      const b = h(
        'button',
        { type: 'button', class: 'sf-seg__opt', role: 'tab', id: `${uid}-tab-${t}`, 'aria-controls': `${uid}-panel`, 'data-tip': TAB_LABEL[t].tip },
        TAB_LABEL[t].label,
      );
      b.addEventListener('click', () => state.patch({ tab: t }));
      b.addEventListener('keydown', (event) => {
        let j: number | null = null;
        if (event.key === 'ArrowRight') j = (i + 1) % TABS.length;
        else if (event.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
        else if (event.key === 'Home') j = 0;
        else if (event.key === 'End') j = TABS.length - 1;
        if (j === null) return;
        event.preventDefault();
        state.patch({ tab: TABS[j]! });
        tabButtons[j]?.focus();
      });
      tablist.append(b);
      return b;
    });
    const notices = h('div', { class: 'sfl-notices' });
    root.append(
      h(
        'header',
        { class: 'sfl-head' },
        h(
          'div',
          { class: 'sfl-head__titles' },
          h('h1', { class: 'sfl-h1' }, icon('learn'), 'Learn'),
          h('p', { class: 'sfl-head__lede' }, 'How a position comes out of star sights, and how far to trust it. Every demonstration here is a simulation with a known answer.'),
        ),
        tablist,
      ),
      notices,
      panel,
    );

    void handle
      .then(({ notice }) => {
        if (notice) notices.append(h('p', { class: 'sf-notice sf-notice--caution', role: 'status' }, icon('caution'), h('span', {}, notice)));
      })
      .catch((error: unknown) => {
        notices.append(
          h(
            'p',
            { class: 'sf-notice sf-notice--error', role: 'alert' },
            icon('caution'),
            h('span', {}, `The numerical core could not be loaded, so nothing here can run: ${error instanceof Error ? error.message : String(error)}`),
          ),
        );
        root.dataset.state = 'ready';
      });

    let mounted: { destroy(): void } | null = null;
    let mountedTab: Tab | null = null;
    const mount = (tab: Tab): void => {
      tabButtons.forEach((b, i) => {
        const on = TABS[i] === tab;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      if (tab === mountedTab) return;
      mounted?.destroy();
      panel.replaceChildren();
      panel.setAttribute('aria-labelledby', `${uid}-tab-${tab}`);
      const built = tab === 'primer' ? primerTab(env) : tab === 'stories' ? storiesTab(env) : simulatorTab(env);
      panel.append(built.el);
      mounted = built;
      mountedTab = tab;
      root.scrollTop = 0;
    };
    d.add(state.select((s) => s.tab, mount, { immediate: true }));
    d.add(() => {
      mounted?.destroy();
      mounted = null;
    });

    if (options.story) void env.runStory(options.story, options.variant ?? null);
    else if (options.simulator) void env.openSimulator(options.simulator);

    return { destroy: () => d.dispose() };
  };
}

/** The Learn view: mount it for the `learn` view id. */
export const learn: Component = (host, ctx) => learnView()(host, ctx);

export { STORIES, STORY_IDS, GROUPS, type Story, type StoryId } from './stories.js';
export { runStory, simulateAndSolve, solveOptionsFor, guardAgainstTruth, TruthLeakError, type Run } from './run.js';
export { chartModel, type ChartModel } from './chart-model.js';
export { STEPS } from './primer.js';
