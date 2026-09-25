/**
 * The Events view (EXPLORER_PLAN §2): what happens in the sky and when, as lists you can
 * click. OWNER: eclipse agent; events2 agent (expansion programme Q4) for the Moon and
 * Planets groups, meteors, the Earth's perihelion, calendar files and tables, deep time.
 * Mounted by the shell's registry as the `events` view.
 *
 *   Eclipses  upcoming or past (ten years), solar and lunar, "seen from here"; a card with
 *             what the place sees and "Show on the map" (map/README.md)
 *   Moon      phases · perigee, apogee and supermoons · occultations of stars and planets
 *             seen from here (and elsewhere on Earth)
 *   Planets   highlights (oppositions, elongations, closest approaches) · conjunctions ·
 *             retrograde loops · transits of Mercury and Venus · Jupiter's moons, night by night
 *   Meteors   the year's showers: peak, rate, the Moon, tonight's expected rate
 *   Seasons   equinoxes and solstices, and the Earth's perihelion and aphelion
 *
 * Every event is a button: it sets the explorer's time (and the selected body; the place
 * too for the point of greatest eclipse). The lists are anchored at the explorer's time,
 * but a jump made from this view does not move them (the item clicked stays where it was):
 * they follow the time bar, the clock and playback, and a button re-anchors them after a
 * jump. Times are in the display zone with UTC (or UT) beside or on hover (CONVENTIONS
 * 13.8, 15.2); a far date's times carry the ±ΔT chip. Each list has a Save menu: a
 * calendar file (.ics) and a table (.csv). Long searches run in pieces between frames
 * (search.ts) and wait while the time bar is dragged.
 *
 * Themed only through design tokens (events.css): the displayed theme is
 * `<html data-theme>`, and nothing here reads `settings.theme`.
 */

import '../theme/index.js';
import './events.css';
import { h } from '../../dom.js';
import { disposer, type Component, type Mounted } from '../component.js';
import { fastPlayback, setTime } from '../playback.js';
import { dateMedium } from '../shell/format.js';
import { createStore, displayZone, type ExplorerStore } from '../state.js';
import { roundToMinute, zoneShortName } from '../time.js';
import { button } from '../theme/primitives.js';
import { eclipsesTab } from './eclipses.js';
import { watchAll, type EventsTab, type EventsUi, type JumpOptions, type TabComponent, type TabEnv } from './env.js';
import { moonGroup, planetsGroup } from './groups.js';
import { seasonsTab } from './lists.js';
import { sharedSearches } from './shared.js';
import { showersTab } from './showers.js';

const TABS: readonly { id: EventsTab; label: string; tip: string; tab: TabComponent }[] = [
  { id: 'eclipses', label: 'Eclipses', tip: 'Solar and lunar eclipses, and what you would see of them', tab: eclipsesTab },
  { id: 'moon', label: 'Moon', tip: 'Phases, perigee and supermoons, and the stars and planets the Moon hides', tab: moonGroup },
  {
    id: 'planets',
    label: 'Planets',
    tip: 'Oppositions and elongations, close approaches, retrograde loops, transits and Jupiter’s moons',
    tab: planetsGroup,
  },
  { id: 'meteors', label: 'Meteors', tip: 'The year’s meteor showers, the Moon at their peaks and tonight’s expected rate', tab: showersTab },
  { id: 'seasons', label: 'Seasons', tip: 'Equinoxes and solstices, and the Earth closest to and farthest from the Sun', tab: seasonsTab },
];

type Remembered = Omit<EventsUi, 'anchor'>;

const DEFAULTS: Remembered = {
  tab: 'eclipses',
  moonSub: 'phases',
  planetSub: 'events',
  eclipseDirection: 'upcoming',
  eclipseYears: 10,
  eclipseKind: 'all',
  seenOnly: false,
  selected: null,
  planetDirection: 'upcoming',
  apsisDirection: 'upcoming',
  occultationDirection: 'upcoming',
  occultationsAll: false,
  occultation: null,
  conjunctionDirection: 'upcoming',
  conjunctionKinds: { planets: true, moon: true, stars: true },
  conjunctionsSeenOnly: false,
  transitDirection: 'upcoming',
  transit: null,
  jupiterSeenOnly: true,
  showerYear: null,
  shower: null,
  skyDarkness: 5,
  namePlace: true,
};

/** Per explorer (store), so leaving the view and coming back keeps the tabs and the choices. */
const memory = new WeakMap<ExplorerStore, Remembered>();

/** A time change this recent counts as a drag of the time bar: background searches wait. */
const SETTLE_MS = 300;
/** While playing, background searches take a piece at most this often. */
const PLAYING_PACE_MS = 250;

let tabSeq = 0;

const view: Component = (host, ctx) => {
  const d = disposer();
  const remembered = memory.get(ctx.store) ?? DEFAULTS;
  const ui = createStore<EventsUi>({ ...DEFAULTS, ...remembered, anchor: ctx.store.get().time.jd_utc });
  d.add(
    ui.subscribe((u) => {
      const { anchor: _anchor, ...keep } = u;
      memory.set(ctx.store, keep);
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

  // The pace of background searches: none while the page is still; they wait while a
  // pointer is pressed anywhere on the page (dragging the time bar or the map, scrolling by
  // touch) and until the time has been still for SETTLE_MS (keys, the wheel), and take a
  // piece at most every PLAYING_PACE_MS while playing. The live clock's ticks do not count.
  let lastMove = Number.NEGATIVE_INFINITY;
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  d.add(
    ctx.store.select(
      (s) => s.time.jd_utc,
      () => {
        if (!ctx.store.get().time.live) lastMove = now();
      },
    ),
  );
  const pressed = new Set<number>();
  if (typeof document !== 'undefined') {
    const down = (e: PointerEvent): void => {
      pressed.add(e.pointerId);
    };
    const up = (e: PointerEvent): void => {
      pressed.delete(e.pointerId);
    };
    const clear = (): void => pressed.clear();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', clear);
    d.add(() => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', clear);
    });
  }
  const pace = (): number => {
    if (pressed.size) return SETTLE_MS;
    if (ctx.store.get().time.playing) return PLAYING_PACE_MS;
    const since = now() - lastMove;
    return since < SETTLE_MS ? Math.ceil(SETTLE_MS - since) + 20 : 0;
  };
  const shared = sharedSearches(ctx.store);
  shared.pace = pace;
  d.add(() => shared.pause());
  const env: TabEnv = { ctx, ui, jump, pace, shared };

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
        const text = `From ${dateMedium(roundToMinute(anchor), zone)} · ${place} · times in ${zoneShortName(now, zone)}`;
        if (context.textContent !== text) context.textContent = text;
        const behind = Math.abs(now - anchor) > 1 / 1440;
        if (reanchor.hidden === behind) reanchor.hidden = !behind;
        if (behind) {
          const label = reanchor.querySelector('.sf-btn__label');
          const next = `List from ${dateMedium(roundToMinute(now), zone)}`;
          if (label && label.textContent !== next) label.textContent = next;
        }
      },
    ),
  );

  // The anchor follows the explorer's time, except after a jump made from this view, and
  // while time plays faster than eight days a second (CONVENTIONS 15.6: the lists hold still
  // and catch up once it stops or slows, rather than searching afresh every frame).
  d.add(
    ctx.store.select(
      (s) => s.time.jd_utc,
      (jd) => {
        if (ownJump !== null && jd === ownJump) return;
        ownJump = null;
        if (fastPlayback(ctx.store.get())) return;
        ui.patch({ anchor: jd });
      },
    ),
  );
  d.add(
    ctx.store.select(
      (s) => fastPlayback(s),
      (fast) => {
        if (!fast) ui.patch({ anchor: ctx.store.get().time.jd_utc });
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
