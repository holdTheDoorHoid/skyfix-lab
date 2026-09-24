/**
 * The Navigate view (EXPLORER_PLAN section 2). OWNER: navigate agent.
 *
 * Sights entered body first, each with its corrections worked out live; then a method:
 *
 *   Fix             least squares, with the old workbench's options and result kinds
 *   Noon sight      latitude (strong) and longitude (weak) from a run around the peak
 *   Polaris         latitude from the Pole Star, with the Almanac's a0, a1, a2
 *   Running fix     sights brought to one instant along the dead-reckoning run
 *   Average a run   many quick sights of one body made into one good one
 *   Lunar distance  Greenwich time from the Moon
 *   Plan sights     tonight's twilight windows and bodies, and the planner at any moment
 *
 * Every capability of the old Observations, Corrections, Fix and Planner tabs is here:
 * session editing (name, kind, notes, observer, instrument, clock, the assumed position and
 * its role), sights (add, edit, delete; Hs/Ha/Ho, limbs, sigma, horizon override, your own
 * GHA and declination), JSON and CSV import and export, the ephemeris mode, every
 * correction step, the solve options, the four result kinds, residuals, the position plot,
 * the planner, and the warnings in the core's vocabulary. New: GPX export, examples,
 * autosave in this browser, and the result drawn on the explorer's map.
 *
 * Mount with the component contract:
 *
 * ```ts
 * import { navigate, tonight } from './navigate/index.js';
 * navigate(stageHost, ctx);        // the view, for view === 'navigate'
 * tonight(panelSectionHost, ctx);  // the side panel's "Tonight's star sights"
 * ```
 */

import '../theme/index.js';
import './navigate.css';
import type { SkyfixApi } from '../../api/adapter.js';
import { fromCsv, toCsv } from '../../csv.js';
import { h } from '../../dom.js';
import { disposer, type Component, type Ctx, type Mounted } from '../component.js';
import { badge } from '../theme/primitives.js';
import { icon } from '../theme/icons.js';
import { navToolsFor, sessionApiFor } from './api.js';
import { sightBodiesFor, type NavCtx } from './context.js';
import { EXAMPLES, exampleById } from './examples.js';
import { fileStem } from './gpx.js';
import { averageMethod } from './methods/average.js';
import { fixMethod } from './methods/fix.js';
import { lunarMethod } from './methods/lunar.js';
import { noonMethod } from './methods/noon.js';
import { planMethod } from './methods/plan.js';
import { polarisMethod } from './methods/polaris.js';
import { runningMethod } from './methods/running.js';
import { defaultWorking, emptySession, type Working } from './model.js';
import { overlayServiceFor } from './overlays.js';
import { createReductions } from './reductions.js';
import { sessionPanel } from './session-panel.js';
import { sightsPanel } from './sights.js';
import { AUTOSAVE_TEXT, HONESTY, METHODS, type MethodId } from './text.js';
import { btn, download, errorText, kids, notice, para, pickFile, uid, warningList } from './ui.js';
import { seedFromExplorer, workingFor, type WorkingOptions } from './working.js';

export interface NavigateOptions {
  /** Where the working session is kept (default: this browser's localStorage; null: never). */
  storage?: Storage | null;
  /** Open on this method instead of the one last used. */
  method?: MethodId;
  /** Load this example first (developer page). */
  example?: string;
}

const METHOD_MOUNT: Record<MethodId, (host: HTMLElement, nc: NavCtx) => Mounted> = {
  fix: fixMethod,
  noon: noonMethod,
  polaris: polarisMethod,
  running: runningMethod,
  average: averageMethod,
  lunar: lunarMethod,
  plan: planMethod,
};

export function navigateView(options: NavigateOptions = {}): Component {
  return (host: HTMLElement, ctx: Ctx): Mounted => {
    const d = disposer();
    const root = h('div', { class: 'sfn sf-on-stage' });
    host.append(root);
    d.add(() => root.remove());
    root.append(h('p', { class: 'sfn-loading', role: 'status' }, 'Loading the navigation tools…'));
    const workingOptions: WorkingOptions = options.storage === undefined ? {} : { storage: options.storage };
    const working = workingFor(ctx.store, workingOptions);
    let destroyed = false;
    d.add(() => {
      destroyed = true;
    });
    void sessionApiFor(ctx.engine)
      .then((api) => {
        if (destroyed) return;
        build(api);
      })
      .catch((error: unknown) => {
        if (destroyed) return;
        root.replaceChildren(notice('error', h('strong', {}, 'Navigate cannot start: '), errorText(error)));
      });

    function build(api: SkyfixApi): void {
      root.replaceChildren();
      const tools = navToolsFor(ctx.engine);
      const nav = 'tools' in tools ? tools.tools : null;
      const reductions = createReductions(working.store, api);
      d.add(() => reductions.dispose());
      const statusLine = h('div', { class: 'sfn-say', role: 'status', 'aria-live': 'polite' });
      const nc: NavCtx = {
        ctx,
        working,
        api,
        nav,
        navMissing: 'missing' in tools ? tools.missing : null,
        reductions: reductions.store,
        overlays: overlayServiceFor(ctx),
        bodies: sightBodiesFor(ctx, nav),
        say(text, level = 'info') {
          statusLine.replaceChildren(notice(level, text));
        },
      };

      // --- Header ---------------------------------------------------------------------------
      const title = h('div', { class: 'sfn-head__title' });
      const renderTitle = (): void => {
        const s = working.store.get().session;
        title.replaceChildren(
          ...kids(
          h('h1', {}, icon('sextant'), 'Navigate'),
          h('span', { class: 'sfn-head__session' }, s.meta.name || 'Untitled session'),
          badge(s.meta.kind === 'simulated' ? 'simulated' : 'real', {
            text: s.meta.kind === 'simulated' ? 'SIMULATED' : 'REAL',
            tip: s.meta.kind === 'simulated' ? 'Generated, not measured' : 'Measured with an instrument',
          }),
          ctx.engine.kind === 'mock' ? badge('mock', { tip: 'Every number here is illustrative' }) : null,
          ),
        );
      };
      d.add(working.store.select((w) => w.session.meta, renderTitle));
      renderTitle();

      // Examples: this view's own, then the simulator's packaged demonstrations.
      const exampleSelect = h('select', { class: 'sf-input sfn-select', 'aria-label': 'Example sessions' });
      exampleSelect.append(h('option', { value: '' }, 'Try an example…'));
      const ownGroup = h('optgroup', { label: 'Methods, with worked examples' });
      for (const e of EXAMPLES) ownGroup.append(h('option', { value: `x:${e.id}` }, e.title));
      exampleSelect.append(ownGroup);
      const demoGroup = h('optgroup', { label: 'Simulator demonstrations' });
      let demos: Awaited<ReturnType<SkyfixApi['demos']>> = [];
      void api
        .demos()
        .then((list) => {
          demos = list;
          for (const demo of list) demoGroup.append(h('option', { value: `d:${demo.name}` }, demo.name));
          if (list.length) exampleSelect.append(demoGroup);
        })
        .catch(() => undefined);
      const loadExample = btn('Load', () => void load(exampleSelect.value), { variant: 'outline' });

      const replaceWorking = (next: Working, message: string): void => {
        const before = working.store.get();
        working.store.set(next);
        const undo = btn('Undo', () => {
          working.store.set(before);
          nc.say('Restored your previous session.');
        }, { variant: 'outline' });
        statusLine.replaceChildren(notice('info', message, ' ', undo));
      };

      async function load(value: string): Promise<void> {
        if (!value) {
          nc.say('Choose an example first.', 'caution');
          return;
        }
        try {
          if (value.startsWith('x:')) {
            const e = exampleById(value.slice(2));
            if (!e) return;
            replaceWorking(e.build(nav), `Loaded the example “${e.title}”. ${e.blurb}`);
          } else {
            const demo = demos.find((x) => x.name === value.slice(2));
            if (!demo) return;
            const out = await api.simulate(demo.scenario);
            replaceWorking({ ...defaultWorking(), session: out.session, method: 'fix', mode: demo.requires_provider ? 'auto' : 'supplied' }, `Loaded the simulator’s “${demo.name}”: ${demo.description} Its truth is kept out of the session.`);
          }
        } catch (error) {
          nc.say(`Could not load it: ${errorText(error)}`, 'error');
        }
      }

      const open = btn('Open…', () =>
        pickFile('.json,.csv,application/json,text/csv', (name, text) => void openFile(name, text)),
      { icon: 'external', variant: 'ghost', tip: 'A session file: JSON (skyfix.session/1) or CSV' });
      async function openFile(name: string, text: string): Promise<void> {
        const csv = /\.csv$/i.test(name) || /^\s*(#|id,)/.test(text);
        try {
          let messages: string[] = [];
          let json = text;
          if (csv) {
            const parsed = fromCsv(text, emptySession({ name: name.replace(/\.csv$/i, '') }));
            messages = parsed.messages;
            json = JSON.stringify(parsed.session);
          }
          const parsed = await api.parseSession(json);
          replaceWorking(
            { ...working.store.get(), session: parsed.session, excluded: [], planned: [] },
            `Opened ${name}${csv ? ' (CSV, read in the browser, then checked by the core)' : ''}: ${parsed.session.observations.length} sight${parsed.session.observations.length === 1 ? '' : 's'}.`,
          );
          const all = [...messages.map((m) => ({ code: 'other' as const, message: `CSV: ${m}` })), ...parsed.warnings];
          if (all.length) statusLine.append(h('div', { class: 'sfn-say__warnings' }, warningList(all)));
        } catch (error) {
          nc.say(`Could not open ${name}: ${errorText(error)}`, 'error');
        }
      }
      const saveJson = btn('JSON', () => {
        const s = working.store.get().session;
        download(`${fileStem(s.meta.name)}.json`, `${JSON.stringify(s, null, 2)}\n`, 'application/json');
      }, { variant: 'ghost', tip: 'The session as skyfix.session/1 JSON' });
      const saveCsv = btn('CSV', () => {
        const s = working.store.get().session;
        download(`${fileStem(s.meta.name)}.csv`, toCsv(s), 'text/csv');
      }, { variant: 'ghost', tip: 'One sight per row, the session’s settings in # lines' });
      const fresh = btn('New session', () =>
        replaceWorking({ ...seedFromExplorer(ctx.store), method: working.store.get().method }, 'Started a new, empty session at the map’s place.'),
      { variant: 'ghost', icon: 'plus' });

      const header = h(
        'header',
        { class: 'sfn-head' },
        title,
        h(
          'div',
          { class: 'sfn-head__actions' },
          h('div', { class: 'sfn-head__group' }, exampleSelect, loadExample),
          h('div', { class: 'sfn-head__group', role: 'group', 'aria-label': 'Files' }, open, h('span', { class: 'sfn-head__label' }, 'Save'), saveJson, saveCsv, fresh),
        ),
      );

      // --- Method tabs (WAI-ARIA tabs, arrows move) ---------------------------------------------
      const panelId = uid('sfn-method-panel');
      const tablist = h('div', { class: 'sf-seg sfn-tabs', role: 'tablist', 'aria-label': 'Navigation methods' });
      const tabs = METHODS.map((m, i) => {
        const tab = h('button', { type: 'button', class: 'sf-seg__opt', role: 'tab', id: `${panelId}-${m.id}`, 'aria-controls': panelId, 'data-tip': m.title }, m.label);
        tab.addEventListener('click', () => working.store.patch({ method: m.id }));
        tab.addEventListener('keydown', (event) => {
          const n = METHODS.length;
          const j = event.key === 'ArrowRight' ? (i + 1) % n : event.key === 'ArrowLeft' ? (i - 1 + n) % n : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : -1;
          if (j < 0) return;
          event.preventDefault();
          working.store.patch({ method: METHODS[j]!.id });
          tabs[j]?.focus();
        });
        tablist.append(tab);
        return tab;
      });

      // --- Layout ------------------------------------------------------------------------------
      const left = h('div', { class: 'sfn-col sfn-col--sights' });
      const right = h('div', { class: 'sfn-col sfn-col--method', role: 'tabpanel', id: panelId, tabindex: '-1' });
      const nav404 = nc.navMissing ? notice('caution', nc.navMissing) : null;
      const autosave = h('div', { class: 'sfn-autosave' });
      root.append(
        ...kids(
          header,
          ctx.engine.kind === 'mock' ? notice('caution', h('strong', {}, 'Mock engine. '), 'Every number here is illustrative, from low-precision formulas; nothing comes from the SkyFix Lab core.') : null,
          nav404,
          h('nav', { class: 'sfn-methods', 'aria-label': 'Method' }, tablist),
          statusLine,
          h('div', { class: 'sfn-grid' }, left, right),
          h('footer', { class: 'sfn-foot' }, autosave, para(HONESTY, 'sfn-honesty')),
        ),
      );
      const session = sessionPanel(left, nc);
      const sights = sightsPanel(left, nc);
      d.add(() => session.destroy());
      d.add(() => sights.destroy());

      let mounted: Mounted | null = null;
      let mountedId: MethodId | null = null;
      const mountMethod = (id: MethodId): void => {
        if (id === mountedId) return;
        mounted?.destroy();
        right.replaceChildren();
        right.setAttribute('aria-labelledby', `${panelId}-${id}`);
        tabs.forEach((t, i) => {
          const on = METHODS[i]!.id === id;
          t.setAttribute('aria-selected', String(on));
          t.tabIndex = on ? 0 : -1;
        });
        mounted = METHOD_MOUNT[id](right, nc);
        mountedId = id;
      };
      d.add(working.store.select((w) => w.method, mountMethod));
      d.add(() => mounted?.destroy());
      mountMethod(working.store.get().method);

      // --- Autosave ------------------------------------------------------------------------------
      const renderAutosave = (): void => {
        const a = working.autosave.get();
        const toggle = h('input', { type: 'checkbox', checked: a.enabled, disabled: !a.available });
        toggle.addEventListener('change', () => working.setAutosave(toggle.checked));
        const forget = btn('Forget the saved copy', () => {
          working.forget();
          nc.say('The saved copy is gone from this browser, and autosave is off. Your sights stay on screen until you close the page.');
        }, { variant: 'ghost' });
        forget.hidden = !a.savedUtc;
        autosave.replaceChildren(
          h('label', { class: 'sf-check sfn-check' }, toggle, h('span', {}, 'Keep my sights in this browser')),
          h(
            'span',
            { class: 'sfn-note sfn-muted' },
            !a.available
              ? ' This browser does not let the page store anything (private window or blocked site data), so nothing is kept.'
              : a.failed
                ? ' The last save did not work (the browser refused it).'
                : a.enabled && a.savedUtc
                  ? ` Saved ${a.savedUtc.slice(11, 19)} UTC.`
                  : '',
          ),
          forget,
          para(AUTOSAVE_TEXT, 'sfn-note sfn-muted'),
        );
      };
      d.add(working.autosave.subscribe(renderAutosave));
      renderAutosave();

      if (options.example) {
        const e = exampleById(options.example);
        if (e) {
          try {
            working.store.set(e.build(nav));
          } catch (error) {
            nc.say(`Could not load the example: ${errorText(error)}`, 'error');
          }
        }
      }
      if (options.method) working.store.patch({ method: options.method });
    }

    return { destroy: () => d.dispose() };
  };
}

/** The Navigate view: mount it for `view === 'navigate'`. */
export const navigate: Component = (host, ctx) => navigateView()(host, ctx);

export { tonight, tonightSights, type TonightOptions } from './tonight.js';
export { overlayLayers, publishOverlays, clearOverlays, OVERLAY_PREFIX } from './overlays.js';
export { workingFor } from './working.js';
