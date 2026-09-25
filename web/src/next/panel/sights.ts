/**
 * The panel's "Tonight's star sights" section: a slot. OWNER of the section: shell-design
 * agent; OWNER of its content: the agent building sight planning (`plan_sights`).
 *
 * `src/next/navigate/slots/star-sights.ts` fills it: its default export is a `Component`
 * (component.ts), mounted into the section's body and destroyed with the panel
 * (shell/registry.ts).
 */

import { h } from '../../dom.js';
import { disposer, type Ctx, type Mounted } from '../component.js';
import { componentOf, registry } from '../shell/registry.js';
import { section } from '../theme/primitives.js';

export function sightsSection(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const d = disposer();
  const loader = registry.slot('star-sights');
  const sec = section('Tonight’s star sights', { class: 'sf-sights' });
  const host = h('div', { class: 'sf-sights__slot', 'data-slot': 'star-sights' });
  sec.body.append(host);
  if (!loader) {
    // Not in this build: say so plainly rather than promise it.
    host.textContent = 'The star-sight planner is not in this build.';
    return { el: sec.el, destroy: () => d.dispose() };
  }
  let mounted: Mounted | null = null;
  let alive = true;
  void loader()
    .then((mod) => {
      const component = componentOf(mod);
      if (!alive || !component) return;
      mounted = component(host, ctx);
    })
    .catch((error: unknown) => {
      console.error(error);
      host.textContent = 'The star-sight planner could not be loaded.';
    });
  d.add(() => {
    alive = false;
    mounted?.destroy();
  });
  return { el: sec.el, destroy: () => d.dispose() };
}
