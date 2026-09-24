/**
 * The explorer's shell (EXPLORER_PLAN §2): the app strip with the honesty banner, the
 * time bar, the side panel (a bottom sheet on phones) and the stage that shows the
 * current view. It also runs the services every view relies on: the theme, the view in
 * the address bar, and the place service (gazetteer, time-zone guess). OWNER:
 * shell-design agent.
 *
 *   ┌──────────────── app strip: name · honesty banner · engine ─────────────────┐
 *   ├──────────────── time bar: date · clock · ribbon · Now · Play ──────────────┤
 *   │ panel: views · search · Place · Now · Selected · Sky now │ stage: the view │
 *   └──────────────────────────────────────────────────────────┴─────────────────┘
 */

import '../theme/index.js';
import './shell.css';
import { h } from '../../dom.js';
import { disposer, watch, type Component } from '../component.js';
import { panel } from '../panel/panel.js';
import { bottomSheet } from '../panel/sheet.js';
import { icon } from '../theme/icons.js';
import { installTooltips } from '../theme/primitives.js';
import { timebar } from '../timebar/timebar.js';
import { displayZone } from '../state.js';
import { UTC_ZONE } from '../time.js';
import { appbar } from './appbar.js';
import { coverageSpan, covered } from './derived.js';
import { dateMedium } from './format.js';
import { noticeBar } from './noticebar.js';
import { startPlaceService } from './place.js';
import { startRouter } from './router.js';
import { stage } from './stage.js';
import { startThemeController } from './themes.js';

export const shell: Component = (host, ctx) => {
  const { store } = ctx;
  const d = disposer();
  d.add(startThemeController(store));
  const place = startPlaceService(store, ctx.notices);
  d.add(place.destroy);

  const bar = appbar(ctx);
  const time = timebar(ctx);
  const viewHost = h('div', { class: 'sf-stage__fill' });
  const notices = noticeBar(ctx);
  const toggle = h(
    'button',
    { type: 'button', class: 'sf-panel-toggle', 'aria-controls': 'sf-panel', 'aria-expanded': 'true', 'aria-label': 'Hide the panel', 'data-tip': 'Hide the panel' },
    icon('chevron-left'),
  );
  const stageEl = h('main', { class: 'sf-stage', id: 'sf-stage' }, viewHost, toggle, notices.el);
  let sheet: ReturnType<typeof bottomSheet> | null = null;
  const side = panel(ctx, place, {
    // On a phone, step the sheet aside after a place is chosen so the map shows it.
    onPlaceChosen: () => {
      if (matchMedia('(max-width: 767px)').matches) sheet?.set('min');
    },
  });
  const app = h('div', { class: 'sf-app', 'data-panel': 'open', 'data-sheet': 'peek' }, bar.el, time.el, side.el, stageEl);
  host.replaceChildren(app);
  for (const part of [bar, time, side, notices]) d.add(part.destroy);

  const views = stage(ctx, viewHost);
  d.add(views.destroy);
  d.add(startRouter(store));
  sheet = bottomSheet(app, side.el, side.grab, stageEl);
  d.add(sheet.destroy);
  d.add(installTooltips(document.body));

  toggle.addEventListener('click', () => {
    const closing = app.dataset.panel !== 'closed';
    app.dataset.panel = closing ? 'closed' : 'open';
    toggle.setAttribute('aria-expanded', String(!closing));
    toggle.setAttribute('aria-label', closing ? 'Show the panel' : 'Hide the panel');
    toggle.dataset.tip = closing ? 'Show the panel' : 'Hide the panel';
    toggle.replaceChildren(icon(closing ? 'chevron-right' : 'chevron-left'));
  });

  d.add(
    watch(ctx, (s) => s.settings.navigatorTerms, (on) => {
      app.dataset.terms = on ? 'on' : 'off';
    }),
  );
  d.add(
    watch(ctx, (s) => s.time.live, (live) => {
      app.dataset.live = live ? 'on' : 'off';
    }),
  );

  // Outside the years the core covers nothing is computed; say so once, in plain words.
  const span = coverageSpan(ctx);
  if (span) {
    d.add(
      watch(ctx, (s) => covered(ctx, s.time.jd_utc), (inside) => {
        if (inside) {
          ctx.notices.dismissKey('coverage');
          return;
        }
        const s = store.get();
        const zone = displayZone(s);
        ctx.notices.push(
          'caution',
          `${dateMedium(s.time.jd_utc, zone)} is outside the years the SkyFix Lab core covers (${dateMedium(span[0], UTC_ZONE)} to ${dateMedium(span[1], UTC_ZONE)}), so nothing can be computed for it. Choose a date in that range, or press Now.`,
          { key: 'coverage' },
        );
      }),
    );
  }

  return {
    destroy() {
      d.dispose();
      app.remove();
    },
  };
};
