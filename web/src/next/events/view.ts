/**
 * The Events view (EXPLORER_PLAN §2): eclipses, Moon phases, equinoxes and solstices, and
 * the planets' oppositions, conjunctions, elongations and closest approaches.
 * OWNER: eclipse agent. Mounted by the shell's registry as the `events` view.
 *
 *   Eclipses  upcoming or past (ten years), solar and lunar, "seen from here"; a card with
 *             what the place sees (a timeline of the contacts with the Sun's or Moon's
 *             height at each, magnitude, obscuration, a plain-language account) and
 *             "Show on the map" (map/README.md, the map service)
 *   Moon      the principal phases for the coming months
 *   Seasons   equinoxes and solstices, the year before and four after
 *   Planets   a year of planet events, ahead or back
 *
 * Every event is a button: it sets the explorer's time (and the selected body; the place
 * too for the point of greatest eclipse). The lists are anchored at the explorer's time,
 * but a jump made from this view does not move them (the item clicked stays where it was):
 * they follow the time bar, the clock and playback, and a button re-anchors them after a
 * jump. Times are in the display zone with UTC beside or on hover (CONVENTIONS 13.8);
 * event times are rounded to the minute, eclipse contacts shown to the second.
 *
 * Themed only through design tokens (events.css): the displayed theme is
 * `<html data-theme>`, and nothing here reads `settings.theme`.
 */

import '../theme/index.js';
import './events.css';
import { h } from '../../dom.js';
import { disposer, type Component, type Mounted } from '../component.js';
import { setTime } from '../playback.js';
import { dateMedium } from '../shell/format.js';
import { createStore, displayZone, type ExplorerStore } from '../state.js';
import { roundToMinute, zoneShortName } from '../time.js';
import { button } from '../theme/primitives.js';
import { eclipsesTab } from './eclipses.js';
import { watchAll, type EventsTab, type EventsUi, type JumpOptions, type TabComponent, type TabEnv } from './env.js';
import { moonTab, planetsTab, seasonsTab } from './lists.js';

const TABS: readonly { id: EventsTab; label: string; tip: string; tab: TabComponent }[] = [
  { id: 'eclipses', label: 'Eclipses', tip: 'Solar and lunar eclipses, and what you would see of them', tab: eclipsesTab },
  { id: 'moon', label: 'Moon phases', tip: 'New Moon, first quarter, full Moon and last quarter for the coming months', tab: moonTab },
  { id: 'seasons', label: 'Seasons', tip: 'Equinoxes and solstices', tab: seasonsTab },
  { id: 'planets', label: 'Planets', tip: 'Oppositions, conjunctions, greatest elongations and closest approaches', tab: planetsTab },
];

type Remembered = Omit<EventsUi, 'anchor'>;

const DEFAULTS: Remembered = {
  tab: 'eclipses',
  eclipseDirection: 'upcoming',
  eclipseKind: 'all',
  seenOnly: false,
  selected: null,
  planetDirection: 'upcoming',
};

/** Per explorer (store), so leaving the view and coming back keeps the tab and the selection. */
const memory = new WeakMap<ExplorerStore, Remembered>();

let tabSeq = 0;

const view: Component = (host, ctx) => {
  const d = disposer();
  const remembered = memory.get(ctx.store) ?? DEFAULTS;
  const ui = createStore<EventsUi>({ ...remembered, anchor: ctx.store.get().time.jd_utc });
  d.add(
    ui.subscribe((u) => {
      memory.set(ctx.store, {
        tab: u.tab,
        eclipseDirection: u.eclipseDirection,
        eclipseKind: u.eclipseKind,
        seenOnly: u.seenOnly,
        selected: u.selected,
        planetDirection: u.planetDirection,
      });
    }),
  );

  // A jump made here is remembered so the time watcher can tell it from the time bar's.
  let ownJump: number | null = null;
  const jump = (jd: number, options: JumpOptions = {}): void => {
    if (!Number.isFinite(jd)) return;
    ownJump = jd;
    ctx.store.batch(() => {
      if (options.observer) ctx.store.patch({ observer: options.observer });
      setTime(ctx.store, jd);
      if (options.body) ctx.store.patch({ selection: { body: options.body } });
    });
  };
  const env: TabEnv = { ctx, ui, jump };

  const root = h('section', { class: 'sfe sf-on-stage', 'aria-label': 'Events' });
  host.append(root);
  d.add(() => root.remove());

  // --- Tabs (WAI-ARIA tabs with automatic activation, as the Charts view) ---------------
  const seq = ++tabSeq;
  const panelId = `sfe-panel-${seq}`;
  const tablist = h('div', { class: 'sf-seg sfe-tabs', role: 'tablist', 'aria-label': 'Events' });
  const panel = h('div', { class: 'sfe-panel', role: 'tabpanel', id: panelId, tabindex: '-1' });
  const tabButtons = TABS.map((t, i) => {
    const b = h(
      'button',
      { type: 'button', class: 'sf-seg__opt', role: 'tab', id: `${panelId}-${t.id}`, 'aria-controls': panelId, 'data-tip': t.tip },
      t.label,
    );
    b.addEventListener('click', () => ui.patch({ tab: t.id }));
    b.addEventListener('keydown', (event) => {
      let j: number | null = null;
      if (event.key === 'ArrowRight') j = (i + 1) % TABS.length;
      else if (event.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
      else if (event.key === 'Home') j = 0;
      else if (event.key === 'End') j = TABS.length - 1;
      if (j === null) return;
      event.preventDefault();
      ui.patch({ tab: TABS[j]!.id });
      tabButtons[j]?.focus();
    });
    tablist.append(b);
    return b;
  });

  // --- Where and when the lists are for ---------------------------------------------------
  const context = h('p', { class: 'sfe-context' });
  const reanchor = button({
    label: 'List from the time shown',
    size: 'sm',
    variant: 'ghost',
    icon: 'clock',
    class: 'sfe-reanchor',
    tip: 'Build the lists around the explorer’s time instead',
    onClick: () => {
      ownJump = null;
      ui.patch({ anchor: ctx.store.get().time.jd_utc });
    },
  });
  root.append(h('div', { class: 'sfe-bar' }, tablist, h('div', { class: 'sfe-where' }, context, reanchor)), panel);

  d.add(
    watchAll(
      env,
      (s, u) => [u.anchor, s.time.jd_utc, s.observer.label, s.observer.lat_deg, s.observer.lon_deg, s.settings.timeDisplay, s.observer.zone] as const,
      ([anchor, now]) => {
        const s = ctx.store.get();
        const zone = displayZone(s);
        const place = s.observer.label || 'your place';
        context.textContent = `From ${dateMedium(roundToMinute(anchor), zone)} · ${place} · times in ${zoneShortName(now, zone)}`;
        const behind = Math.abs(now - anchor) > 1 / 1440;
        reanchor.hidden = !behind;
        if (behind) {
          const label = reanchor.querySelector('.sf-btn__label');
          if (label) label.textContent = `List from ${dateMedium(roundToMinute(now), zone)}`;
        }
      },
    ),
  );

  // The anchor follows the explorer's time, except after a jump made from this view.
  d.add(
    ctx.store.select(
      (s) => s.time.jd_utc,
      (jd) => {
        if (ownJump !== null && jd === ownJump) return;
        ownJump = null;
        ui.patch({ anchor: jd });
      },
    ),
  );

  // --- Mount the chosen tab ----------------------------------------------------------------
  let mounted: Mounted | null = null;
  let mountedTab: EventsTab | null = null;
  const mount = (tab: EventsTab): void => {
    if (tab === mountedTab) return;
    mounted?.destroy();
    panel.replaceChildren();
    const def = TABS.find((t) => t.id === tab) ?? TABS[0]!;
    panel.setAttribute('aria-labelledby', `${panelId}-${def.id}`);
    root.dataset.tab = def.id;
    mounted = def.tab(panel, env);
    mountedTab = def.id;
  };
  d.add(() => {
    mounted?.destroy();
    mounted = null;
  });
  d.add(
    ui.select(
      (u) => u.tab,
      (tab) => {
        tabButtons.forEach((b, i) => {
          const on = TABS[i]!.id === tab;
          b.setAttribute('aria-selected', String(on));
          b.tabIndex = on ? 0 : -1;
        });
        mount(tab);
      },
      { immediate: true },
    ),
  );

  return { destroy: () => d.dispose() };
};

export default view;
