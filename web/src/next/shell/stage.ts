/**
 * The stage: the main area that shows the current view. Views come from the registry
 * (registry.ts) by folder. A view that cannot be loaded (its code did not arrive: a
 * connection lost before the page was saved for offline use) says so in its place. The
 * page title follows the view. OWNER: shell-design agent.
 */

import { h } from '../../dom.js';
import { disposer, type Ctx, type Mounted } from '../component.js';
import type { ViewId } from '../state.js';
import { icon } from '../theme/icons.js';
import { componentOf, registry as defaultRegistry, VIEW_FOLDERS, type Registry } from './registry.js';
import { VIEW_META, type ViewMeta } from './views.js';

/** The page a view shows when it could not be loaded. Plain words, never a stack trace. */
export function viewError(host: HTMLElement, meta: ViewMeta, message: string): Mounted {
  const el = h(
    'div',
    { class: 'sf-view-error sf-on-stage', role: 'alert' },
    h(
      'div',
      { class: 'sf-view-error__card' },
      h('div', { class: 'sf-view-error__icon' }, icon(meta.icon)),
      h('h1', { class: 'sf-view-error__title' }, meta.title),
      h('p', { class: 'sf-view-error__lead' }, `This view could not be loaded: ${message}`),
      h('p', { class: 'sf-view-error__note' }, 'The other views and the panel beside this still work. Reloading the page usually brings it back.'),
    ),
  );
  host.replaceChildren(el);
  return { destroy: () => el.remove() };
}

export function stage(ctx: Ctx, host: HTMLElement, reg: Registry = defaultRegistry): { destroy(): void } {
  const { store } = ctx;
  const d = disposer();
  let folder = '';
  let mounted: Mounted | null = null;
  let token = 0;

  const show = (view: ViewId): void => {
    const meta = VIEW_META[view];
    document.title = `${meta.title} · SkyFix Lab`;
    if (VIEW_FOLDERS[view] === folder) return; // same component (map <-> globe): it follows state.view itself
    folder = VIEW_FOLDERS[view];
    const mine = ++token;
    mounted?.destroy();
    mounted = null;
    const slot = h('div', { class: 'sf-stage__view', 'data-view': folder });
    host.replaceChildren(slot);
    const loader = reg.view(view);
    if (!loader) {
      mounted = viewError(slot, meta, 'it is not in this build');
      return;
    }
    slot.setAttribute('aria-busy', 'true');
    slot.append(h('div', { class: 'sf-stage__loading' }, h('span', { class: 'sf-spinner', 'aria-hidden': 'true' }), `Loading ${meta.title}…`));
    void loader()
      .then((mod) => {
        if (mine !== token) return;
        const component = componentOf(mod);
        slot.replaceChildren();
        slot.removeAttribute('aria-busy');
        mounted = component ? component(slot, ctx) : viewError(slot, meta, 'it has no view component');
      })
      .catch((error: unknown) => {
        if (mine !== token) return;
        console.error(error);
        slot.removeAttribute('aria-busy');
        mounted = viewError(slot, meta, error instanceof Error ? error.message : String(error));
        ctx.notices.push('error', `The ${meta.title} view could not be loaded.`, { key: `view-${folder}` });
      });
  };

  show(store.get().view);
  d.add(store.select((s) => s.view, show));
  d.add(() => {
    token += 1;
    mounted?.destroy();
  });
  return { destroy: () => d.dispose() };
}
