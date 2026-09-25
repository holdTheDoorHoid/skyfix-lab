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
import { iconButton, installTooltips } from '../theme/primitives.js';
import { timebar } from '../timebar/timebar.js';
import { startTimeServices } from '../time/services.js';
import { appbar } from './appbar.js';
import { setHourCycle } from './format.js';
import { noticeBar } from './noticebar.js';
import { startPlaceService } from './place.js';
import { startRouter } from './router.js';
import { stage } from './stage.js';
import { startThemeController } from './themes.js';
import { createTour, tourDismissed } from './tour.js';

export const shell: Component = (host, ctx) => {
  const { store } = ctx;
  const d = disposer();
  d.add(startThemeController(store));
  // The 12- or 24-hour clock is read by the format functions (format.ts). Set at once, and
  // on every change before the next frame draws (every `watch` then draws again).
  setHourCycle(store.get().settings.hourCycle);
  d.add(store.select((s) => s.settings.hourCycle, setHourCycle));
  // Deep time (time-ui agent): the calendar and year style kept in step the same way, the
  // tier notice (outside the years the core covers, or a historical / far-future estimate)
  // and the Deep time pack when a date needs it (time/services.ts).
  d.add(startTimeServices(ctx));
  const place = startPlaceService(store, ctx.notices);
  d.add(place.destroy);

  const bar = appbar(ctx);
  const time = timebar(ctx);
  const viewHost = h('div', { class: 'sf-stage__fill' });
  const notices = noticeBar(ctx);
  // The panel switch leads the app strip (as a sidebar switch does in most apps), so it
  // never covers a view's own controls; phones drag the bottom sheet instead.
  const toggle = iconButton('panel', 'Hide the panel', { size: 'sm', class: 'sf-panel-toggle', tip: 'Hide the panel' });
  toggle.setAttribute('aria-controls', 'sf-panel');
  toggle.setAttribute('aria-expanded', 'true');
  bar.el.prepend(toggle);
  const stageEl = h('main', { class: 'sf-stage', id: 'sf-stage' }, viewHost, notices.el);
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

  // The first-run tour: once, beside the page, never over it (tour.ts). After the first
  // frame, so the parts it points at have their places.
  const tour = createTour(ctx);
  d.add(tour.destroy);
  if (!tourDismissed()) {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => tour.open()));
    d.add(() => cancelAnimationFrame(id));
  }

  toggle.addEventListener('click', () => {
    const closing = app.dataset.panel !== 'closed';
    app.dataset.panel = closing ? 'closed' : 'open';
    toggle.setAttribute('aria-expanded', String(!closing));
    toggle.setAttribute('aria-label', closing ? 'Show the panel' : 'Hide the panel');
    toggle.dataset.tip = closing ? 'Show the panel' : 'Hide the panel';
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

  return {
    destroy() {
      d.dispose();
      app.remove();
    },
  };
};
