/**
 * The side panel (a bottom sheet on phones): the view switcher, the place search, and the
 * sections Place, Now, Selected, In the sky now, and Tonight's star sights.
 * OWNER: shell-design agent.
 */

import './panel.css';
import { h } from '../../dom.js';
import { disposer, type Ctx } from '../component.js';
import type { PlaceService } from '../shell/place.js';
import { nowSection } from './now.js';
import { placeSection } from './place.js';
import { placeSearch } from './search.js';
import { selectedSection } from './selected.js';
import { sightsSection } from './sights.js';
import { skyNowSection } from './skynow.js';
import { viewSwitcher } from './switcher.js';

export interface PanelParts {
  el: HTMLElement;
  grab: HTMLElement;
  destroy(): void;
}

export function panel(ctx: Ctx, place: PlaceService, options: { onPlaceChosen?: () => void } = {}): PanelParts {
  const d = disposer();
  const parts = [
    viewSwitcher(ctx),
    placeSearch(ctx, { place, ...(options.onPlaceChosen ? { onChosen: options.onPlaceChosen } : {}) }),
    placeSection(ctx, place),
    nowSection(ctx),
    selectedSection(ctx),
    skyNowSection(ctx),
    sightsSection(ctx),
  ];
  for (const p of parts) d.add(p.destroy);
  const [switcher, search, placeSec, now, selected, skyNow, sights] = parts.map((p) => p.el) as HTMLElement[];
  const grab = h('div', { class: 'sf-panel__grab', role: 'button', tabindex: 0 });
  const el = h(
    'aside',
    { class: 'sf-panel', id: 'sf-panel', 'aria-label': 'Place, time and sky' },
    grab,
    switcher!,
    search!,
    h(
      'div',
      { class: 'sf-panel__scroll' },
      placeSec!,
      now!,
      selected!,
      skyNow!,
      sights!,
      h(
        'p',
        { class: 'sf-panel__end' },
        ctx.engine.kind === 'wasm'
          ? 'Every number here comes from the SkyFix Lab core, running in this page. '
          : 'MOCK ENGINE: every number here is illustrative, not a result of the SkyFix Lab core. ',
        'Your place is never saved or sent; only Share puts it in a link, when you ask.',
      ),
    ),
  );
  return { el, grab, destroy: () => d.dispose() };
}
