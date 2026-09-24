/**
 * The panel's "Tonight's star sights" section: a slot. OWNER of the section: shell-design
 * agent; OWNER of its content: the agent building sight planning (`plan_sights`).
 *
 * To fill it, add `src/next/<folder>/slots/star-sights.ts` whose default export is a
 * `Component` (component.ts); it is mounted into the section's body and destroyed with
 * the panel (shell/registry.ts). Until then the section says when the next nautical
 * twilight is, which is already useful, and that the list is coming.
 */

import { h } from '../../dom.js';
import { disposer, watch, type Ctx, type Mounted } from '../component.js';
import { aroundToday, setText } from '../shell/derived.js';
import { eventTime, otherDay, relative } from '../shell/format.js';
import { componentOf, registry } from '../shell/registry.js';
import { brightening, nextRun } from '../shell/sky.js';
import { currentDayWindow, displayZone, shallowEqual } from '../state.js';
import { icon } from '../theme/icons.js';
import { badge, section } from '../theme/primitives.js';
import { zoneShortName } from '../time.js';

export function sightsSection(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const { store } = ctx;
  const d = disposer();
  const loader = registry.slot('star-sights');
  const sec = section('Tonight’s star sights', {
    class: 'sf-sights',
    aside: loader ? null : badge('soon', { text: 'Coming' }),
  });
  const host = h('div', { class: 'sf-sights__slot', 'data-slot': 'star-sights' });
  sec.body.append(host);

  if (loader) {
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

  // Placeholder: when the next nautical twilight is, from the engine's sky phases.
  const when = h('strong', {});
  const detail = h('span', {});
  host.append(
    h(
      'div',
      { class: 'sf-card sf-card--dashed sf-sights__card' },
      icon('sextant'),
      h('div', {}, when, detail),
    ),
  );
  const render = (): void => {
    const s = store.get();
    const jd = s.time.jd_utc;
    const zone = displayZone(s);
    const around = aroundToday(ctx, s, 'Sun');
    if (!around) {
      setText(when, 'Not computed for this moment.');
      setText(detail, '');
      return;
    }
    const run = nextRun(around.phases, jd, 'nautical');
    if (!run) {
      setText(when, 'No nautical twilight in the next day or two here.');
      setText(detail, ' Star sights need a visible horizon and visible stars at once.');
      return;
    }
    const z = zoneShortName(jd, zone);
    const day = otherDay(run.jd_start, jd, zone);
    const morning = brightening(around.phases, (run.jd_start + run.jd_end) / 2) === true;
    const span = `${eventTime(run.jd_start, zone)}–${eventTime(run.jd_end, zone)} ${z}`;
    if (run.jd_start <= jd) setText(when, `Now, until ${eventTime(run.jd_end, zone)} ${z} (${relative(jd, run.jd_end)})`);
    else setText(when, `${morning ? 'Morning' : 'Evening'} nautical twilight${day ? `, ${day}` : ''}: ${span}`);
    setText(detail, ' The horizon and the bright stars are both visible then. The best stars to shoot, with predicted sextant readings and bearings, will be listed here.');
  };
  d.add(
    watch(
      ctx,
      (s) => [Math.floor(s.time.jd_utc * 1440), currentDayWindow(s)[0], s.observer, s.settings.timeDisplay] as const,
      render,
      { equals: shallowEqual },
    ),
  );
  return { el: sec.el, destroy: () => d.dispose() };
}
