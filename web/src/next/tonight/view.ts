/**
 * The Tonight view (expansion programme Q2): one scrolling, printable page of what the night
 * at the explorer's place holds — when it is dark, the night's timeline, the Moon, the
 * planets, the best deep-sky objects, meteor showers, the Milky Way, the next fourteen days,
 * the nearest tide station and the photographers' golden and blue hours. OWNER: tonight agent.
 *
 * Which night: night.ts (the current one while it is dark, the coming one from astronomical
 * dawn on); ◀ ▶ step a night by moving the explorer's time, so every view agrees. Every time
 * on the page is a button that sets the explorer's time; planets, objects and radiants open
 * the Sky view on them (sky/sky-link.ts); "Coming up" opens Events.
 *
 * Work is staged so the page answers at once (data.ts has the measured costs): the night's
 * core (the deep-sky engine's `tonight`, the rising and setting, golden hours, the Milky Way)
 * is drawn first; the Moon's and the planets' details come in the next task; the fortnight
 * ahead fills in one engine call per task; the tides and the terminator's features last.
 * While the time bar is dragged or plays, the numbers of a new night wait for the time to
 * settle (the page dims meanwhile); inside one night only the "now" marker moves.
 *
 * Printing prints this page alone as a sheet (`<html data-print-view="tonight">`, tonight.css).
 */

import './tonight.css';
import { h } from '../../dom.js';
import { disposer, watch, type Component } from '../component.js';
import { isDeepSkyEngine, isTidesEngine, type Dso } from '../engine/types.js';
import { setTime } from '../playback.js';
import { displayZone, shallowEqual, type ExplorerState, type ExplorerStore } from '../state.js';
import { bearing3, compassPoint, formatLat, formatLon } from '../shell/format.js';
import { bodyGlyph, phaseDisc } from '../theme/glyphs.js';
import { icon } from '../theme/icons.js';
import { badge, button, iconButton } from '../theme/primitives.js';
import { limbFromUp } from '../charts/disc.js';
import {
  chooseNight,
  DEFAULT_SKY,
  stepNightTime,
  loadCore,
  loadDetail,
  loadFeatures,
  nightMiddle,
  nightQuery,
  queryKey,
  type NightCore,
  type NightDetail,
  type NightQuery,
  type SkyChoice,
} from './data.js';
import { COMING_SOURCES, groupByDay, mergeComing, type ComingItem, type ComingResult } from './coming.js';
import { clock, clockPlain, dayTitle, type Fmt } from './format.js';
import {
  dsoRows,
  featuresMoment,
  headerModel,
  relativeNight,
  lightRows,
  milkyWayModel,
  moonModel,
  planetsModel,
  showerRows,
  type DsoRow,
} from './model.js';
import { openMilkyWayPlanner } from '../panel/photo.js';
import { showInSky } from '../sky/sky-link.js';
import { datumWords, markDeclined, stationWhere, tideCard, tideHeight, tidesLoaded, TIDES_PACK, TIDES_REASON, type TideCard } from './tides.js';
import { mayHaveTideStation } from './tide-cells.js';
import { formatBytes } from '../packs/manifest.js';
import { timelineModel, timelineView, type TimelineModel } from './timeline.js';
import { chipNeeded, timeInfoForSpan, uncertaintyChip, type ChipInfo } from '../time/chip.js';
import { formatCivilDate } from '../time/format.js';
import { scaleLabel } from '../time/scale.js';
import { UTC_ZONE, zoneShortName } from '../time.js';
import { eventsTargetFor, showEvents } from '../events/link.js';

// -------------------------------------------------------------------------------------
// The view's own memory (per explorer, while the page lives)
// -------------------------------------------------------------------------------------

interface Remembered {
  sky: SkyChoice;
  /** Deep-sky objects shown (8, then more). */
  shown: number;
  /** The list of the night's moments is open (open at first on a wide screen). */
  moments: boolean | null;
  /**
   * The night this view last moved the explorer's time within: a best moment at dawn (a planet
   * "as dawn comes") lies after astronomical dawn, where the rule would already show the next
   * night; the view keeps showing the night it came from while the time stays where it put it
   * (as Events keeps its lists after a jump). Any other change of time lets the rule decide.
   */
  pin: { jd: number; n: number; lat: number; lon: number } | null;
}

const memory = new WeakMap<ExplorerStore, Remembered>();

function remembered(store: ExplorerStore): Remembered {
  let m = memory.get(store);
  if (!m) {
    m = { sky: { ...DEFAULT_SKY }, shown: DSO_FIRST, moments: null, pin: null };
    memory.set(store, m);
  }
  return m;
}

/** Deep-sky objects listed at first, and added by each "Show more". */
export const DSO_FIRST = 8;

const BORTLE: readonly { value: number; label: string }[] = [
  { value: 1, label: '1 · Excellent dark site' },
  { value: 2, label: '2 · Truly dark site' },
  { value: 3, label: '3 · Rural sky' },
  { value: 4, label: '4 · Rural and suburban edge' },
  { value: 5, label: '5 · Suburban sky' },
  { value: 6, label: '6 · Bright suburban sky' },
  { value: 7, label: '7 · Suburban and urban edge' },
  { value: 8, label: '8 · City sky' },
  { value: 9, label: '9 · Inner-city sky' },
];

/** How long the time must be still before a new night's numbers are worked out, ms. */
export const SETTLE_MS = 200;
/** While the time keeps moving (the time bar dragged, playback), a new night at least this often, ms. */
export const MAX_WAIT_MS = 4000;

function fmtWith(s: ExplorerState, dt: ChipInfo | null): Fmt {
  return { zone: displayZone(s), angle: s.settings.angleFormat, units: s.settings.units, dt };
}

function fmtKey(s: ExplorerState): string {
  const z = displayZone(s);
  return [z.kind === 'iana' ? z.zone : `${z.name}${z.offsetMs}`, s.settings.angleFormat, s.settings.units, s.settings.hourCycle, s.settings.navigatorTerms].join('|');
}

/** A card: a titled section of the page. */
function card(id: string, title: string, iconName: Parameters<typeof icon>[0]): { el: HTMLElement; head: HTMLElement; body: HTMLElement; aside: HTMLElement } {
  const titleId = `sft-${id}-title`;
  const aside = h('div', { class: 'sft-card__aside' });
  const head = h('header', { class: 'sft-card__head' }, h('h2', { class: 'sft-card__title', id: titleId }, icon(iconName), title), aside);
  const body = h('div', { class: 'sft-card__body' });
  const el = h('section', { class: `sft-card sft-card--${id}`, 'aria-labelledby': titleId, 'data-card': id }, head, body);
  return { el, head, body, aside };
}

/**
 * A time that sets the explorer's time: the local clock, UTC (or UT outside 1972-2035) in its
 * name and tooltip, and time-ui's ±ΔT chip beside it when the night's times are uncertain.
 */
function timeButton(jd: number, f: Fmt, text?: string): HTMLElement {
  const local = text ?? clockPlain(jd, f);
  const utc = `${clockPlain(jd, { zone: UTC_ZONE })} ${scaleLabel(jd)}`;
  const b = h('button', { type: 'button', class: 'sft-time', 'data-jd': String(jd), title: `${local} · ${utc}: show this moment`, 'aria-label': `${local}, ${utc}. Show this moment.` }, local);
  return chipNeeded(f.dt) ? h('span', { class: 'sft-timewrap' }, b, uncertaintyChip(f.dt)) : b;
}

/** `replaceChildren` that skips the parts a card leaves out. */
function fill(el: HTMLElement, ...children: (Node | string | null | undefined | false)[]): void {
  el.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
}

function para(text: string, cls = 'sft-p'): HTMLParagraphElement {
  return h('p', { class: cls }, text);
}

function missingText(what: string): HTMLElement {
  return para(`Not available in this build of the engine (${what}). Rebuild the WebAssembly package to see it.`, 'sft-p sft-muted');
}

// -------------------------------------------------------------------------------------
// The view
// -------------------------------------------------------------------------------------

const view: Component = (host, ctx) => {
  const { store, engine } = ctx;
  const d = disposer();
  const mem = remembered(store);

  // --- the page's frame ---------------------------------------------------------------
  const kicker = h('p', { class: 'sft-kicker' });
  const dateEl = h('h1', { class: 'sft-title', id: 'sft-title' });
  const placeEl = h('p', { class: 'sft-place' });
  const summaryEl = h('div', { class: 'sft-summary', 'aria-live': 'polite' });
  const status = h('p', { class: 'sft-status', role: 'status' });
  const prev = iconButton('chevron-left', 'The night before', { size: 'sm', variant: 'secondary', tip: 'The night before', onClick: () => stepNight(-1) });
  const next = iconButton('chevron-right', 'The night after', { size: 'sm', variant: 'secondary', tip: 'The night after', onClick: () => stepNight(1) });
  const tonightBtn = button({ label: 'Tonight', icon: 'clock', size: 'sm', variant: 'ghost', tip: 'Back to the coming night, following the clock', onClick: () => goTonight() });
  const printBtn = button({ label: 'Print', icon: 'almanac', size: 'sm', variant: 'secondary', class: 'sft-print', tip: 'Print a one-page sheet of this night', onClick: () => window.print() });
  const mock = engine.kind === 'mock' ? badge('mock', { tip: engine.description }) : null;
  const header = h(
    'header',
    { class: 'sft-head' },
    h('div', { class: 'sft-head__titles' }, kicker, dateEl, placeEl),
    h('div', { class: 'sft-head__nav', role: 'group', 'aria-label': 'Choose the night' }, prev, next, tonightBtn, printBtn, mock),
    summaryEl,
    status,
  );

  const timeline = timelineView((jd) => moveTo(Math.round(jd * 1440) / 1440));
  const tl = card('timeline', 'The night', 'clock');
  const tlMoments = h('ol', { class: 'sft-moments' });
  // Every moment as a button: the timeline's keyboard route (and its words). Open at first on
  // a wide screen, where it takes three lines; the person's choice is kept while the page lives.
  const wide = typeof matchMedia === 'function' && matchMedia('(min-width: 768px)').matches;
  const tlTable = h('details', { class: 'sft-details', open: mem.moments ?? wide }, h('summary', {}, 'Every moment of the night'), tlMoments);
  tlTable.addEventListener('toggle', () => {
    if (!printing) mem.moments = tlTable.open;
  });
  tl.body.append(timeline.el, tlTable);

  const moonCard = card('moon', 'Moon', 'moon');
  const planetsCard = card('planets', 'Planets', 'sky');
  const deepCard = card('deep', 'Deep sky', 'target');
  const showersCard = card('showers', 'Meteor showers', 'sky');
  const milkyCard = card('milky', 'Milky Way', 'sky');
  const comingCard = card('coming', 'Coming up', 'events');
  const tidesCard = card('tides', 'Tides', 'list');
  const photoCard = card('photo', 'Photography', 'sun');
  const notesEl = h('footer', { class: 'sft-foot' });

  // The sky's darkness, for the deep-sky ranking and the meteor rates.
  const bortle = h(
    'select',
    { class: 'sft-select', 'aria-label': 'How dark your sky is (Bortle class)', title: 'How dark your sky is: the Bortle scale, 1 the darkest' },
    ...BORTLE.map((b) => h('option', { value: String(b.value), selected: b.value === mem.sky.bortle }, b.label)),
  );
  bortle.addEventListener('change', () => {
    mem.sky = { bortle: Number(bortle.value) };
    request(true);
  });
  deepCard.aside.append(h('label', { class: 'sft-sky' }, h('span', {}, 'Your sky'), bortle));

  // Two columns on a wide page, each stacking its cards; one column (the brief's order) on a narrow one.
  const grid = h(
    'div',
    { class: 'sft-grid' },
    h('div', { class: 'sft-col sft-col--a' }, moonCard.el, planetsCard.el, deepCard.el),
    h('div', { class: 'sft-col sft-col--b' }, showersCard.el, milkyCard.el, comingCard.el, tidesCard.el, photoCard.el),
  );
  const inner = h('div', { class: 'sft-inner' }, header, tl.el, grid, notesEl);
  const root = h('article', { class: 'sft sf-on-stage', 'aria-labelledby': 'sft-title' }, inner);
  host.append(root);
  d.add(() => root.remove());
  d.add(() => timeline.destroy());

  // Printing prints this view and nothing around it (tonight.css).
  const html = document.documentElement;
  html.dataset.printView = 'tonight';
  d.add(() => {
    if (html.dataset.printView === 'tonight') delete html.dataset.printView;
  });

  // The sheet prints every moment of the night (a closed <details> would print closed).
  let wasOpen = false;
  let printing = false;
  const beforePrint = (): void => {
    wasOpen = tlTable.open;
    printing = true;
    tlTable.open = true;
  };
  const afterPrint = (): void => {
    tlTable.open = wasOpen;
    printing = false;
  };
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', afterPrint);
  d.add(() => {
    window.removeEventListener('beforeprint', beforePrint);
    window.removeEventListener('afterprint', afterPrint);
  });

  // Every time on the page sets the explorer's time (one delegated handler).
  const onTime = (event: Event): void => {
    const target = (event.target as Element | null)?.closest?.('.sft-time[data-jd]');
    if (!target || !root.contains(target)) return;
    event.stopPropagation();
    const jd = Number(target.getAttribute('data-jd'));
    if (Number.isFinite(jd)) moveTo(jd);
  };
  root.addEventListener('click', onTime);
  d.add(() => root.removeEventListener('click', onTime));

  // --- state ------------------------------------------------------------------------------
  let core: NightCore | null = null;
  let detail: NightDetail | null = null;
  let coming: Map<string, ComingResult> | null = null;
  let comingDone = false;
  let comingErrors: string[] = [];
  let comingMissing: string[] = [];
  let tides: TideCard | null = null;
  let tidePending = false;
  /** The person pressed Get: the pack service's card asks (a saved pack loads with no question). */
  let tideAsking = false;
  let manifestAsked = false;
  let tlModel: TimelineModel | null = null;
  let shownKey = '';
  let shownFmt = '';
  let generation = 0;
  let realNight: number | null = null;
  let catalog: readonly Dso[] | null = null;
  let constellations: Map<string, string> | null = null;
  /** How to write things now: the settings, and the shown night's Earth-rotation uncertainty (time-ui's chip rule). */
  const fmtOf = (s: ExplorerState): Fmt => fmtWith(s, core?.covered ? timeInfoForSpan(ctx, core.q.n, core.q.n + 1) : null);

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms = 0): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };
  d.add(() => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  });

  // --- drawing --------------------------------------------------------------------------------
  const drawHeader = (s: ExplorerState, f: Fmt): void => {
    const o = s.observer;
    const zoneName = core?.covered ? ` · times in ${zoneShortName(core.q.n + 0.5, f.zone)}` : '';
    placeEl.textContent = `${o.label || 'Your place'} · ${formatLat(o.lat_deg, s.settings.angleFormat)} ${formatLon(o.lon_deg, s.settings.angleFormat)}${zoneName}`;
    if (!core) return;
    if (!core.covered) {
      // Nothing to compute: the night's date (the calendar works without the engine) and why.
      kicker.textContent = relativeNight(core.q.n, realNight);
      dateEl.replaceChildren(formatCivilDate(core.q.n + 0.25, f.zone, 'long', { calendar: true }));
      tonightBtn.hidden = false;
      fill(summaryEl, para('This night is outside the years the SkyFix Lab core covers, so nothing can be worked out for it. Choose another date, or press Tonight.', 'sft-lead'));
      return;
    }
    const m = headerModel(core, detail, f, Date.now() / 86_400_000 + 2_440_587.5, realNight);
    kicker.textContent = m.kicker;
    // The night's Earth-rotation uncertainty beside its date (time-ui's chip: shown only when it matters).
    dateEl.replaceChildren(m.date, chipNeeded(f.dt) ? uncertaintyChip(f.dt) : '');
    tonightBtn.hidden = m.kicker === 'Tonight';
    summaryEl.replaceChildren(...m.sentences.map((t) => para(t, 'sft-lead')));
  };

  const drawTimeline = (f: Fmt): void => {
    if (!core || !core.covered) {
      timeline.draw(null, f, core ? 'This night is outside the years the core covers.' : 'Working out the night…');
      tlMoments.replaceChildren();
      return;
    }
    if (!core.day) {
      timeline.draw(null, f, `The Sun’s and the Moon’s times could not be worked out: ${core.errors[0] ?? 'no answer from the engine'}.`);
      return;
    }
    tlModel = timelineModel(core, f);
    timeline.draw(tlModel, f);
    timeline.setNow(store.get().time.jd_utc, f);
    const terms = store.get().settings.navigatorTerms;
    tlMoments.replaceChildren(
      ...tlModel.moments.map((m) =>
        h('li', { class: 'sft-moment', 'data-lane': m.lane }, timeButton(m.jd, f), h('span', {}, m.label, m.term && terms ? h('span', { class: 'sft-term' }, ` · ${m.term}`) : null)),
      ),
    );
  };

  const drawMoon = (s: ExplorerState, f: Fmt): void => {
    const body = moonCard.body;
    if (!core?.covered) return void fill(body);
    if (!core.tonight && !detail?.moon) return void fill(body, isDeepSkyEngine(engine) ? para(core.errors[0] ?? 'Working out the Moon…', 'sft-p sft-muted') : missingText('deep sky: tonight'));
    const m = moonModel(core, detail, f);
    if (!m) return void fill(body, para('Working out the Moon…', 'sft-p sft-muted'));
    const limbPa = detail?.moon?.bright_limb_angle_deg ?? (m.waxing ? 270 : 90);
    const southUp = s.observer.lat_deg < 0;
    const disc = phaseDisc({ illuminated: m.illuminated, limbFromUpDeg: limbFromUp(limbPa, southUp), size: 64, label: `${m.name}, ${m.lit}, drawn ${southUp ? 'south' : 'north'} up as it looks facing the equator` });
    const rows = h(
      'dl',
      { class: 'sft-rows' },
      ...m.rows.flatMap((r) => [h('dt', {}, r.key), h('dd', { title: r.tip ?? '' }, r.jd !== undefined ? timeButton(r.jd, f, r.value) : r.value)]),
    );
    const upClose = button({
      label: 'See it up close',
      icon: 'eye',
      size: 'sm',
      variant: 'secondary',
      tip: 'Open the Sky view on the Moon at the middle of the night',
      onClick: () => {
        const moonSpans = tlModel?.moon ?? [];
        const now = store.get().time.jd_utc;
        const upNow = moonSpans.some((b) => now >= b.start && now <= b.end);
        const jd = upNow ? null : moonSpans.length ? (moonSpans[0]!.start + moonSpans[0]!.end) / 2 : nightMiddle(core!);
        pinAt(jd);
        showInSky(ctx, { kind: 'body', name: 'Moon', inset: true }, jd);
      },
    });
    fill(
      body,
      h('div', { class: 'sft-moon' }, h('div', { class: 'sft-moon__disc' }, disc), h('div', {}, h('p', { class: 'sft-big' }, m.name), para(m.lit, 'sft-p sft-muted'))),
      rows,
      para(m.moonless),
      m.note ? para(m.note, 'sft-p sft-note') : null,
      m.terminator ? para(m.terminator, 'sft-p sft-muted') : null,
      h('div', { class: 'sft-actions' }, upClose),
    );
  };

  const drawPlanets = (f: Fmt): void => {
    const body = planetsCard.body;
    if (!core?.covered) return void fill(body);
    if (!isDeepSkyEngine(engine)) return void fill(body, missingText('deep sky: tonight'));
    const m = planetsModel(core, detail, f);
    if (!m) return void fill(body, para(core.errors[0] ?? 'Working out the planets…', 'sft-p sft-muted'));
    const list = h(
      'ul',
      { class: 'sft-list' },
      ...m.rows.map((r) => {
        const open = h(
          'button',
          { type: 'button', class: 'sft-row sft-row--button', 'data-body': r.body, title: `Show ${r.body} in the Sky view at ${clock(r.best.jd_utc, f)}` },
          bodyGlyph(r.body, { kind: 'planet', size: 20 }),
          h('span', { class: 'sft-row__text' }, r.line),
          icon('chevron-right', { class: 'sft-row__go' }),
        );
        open.addEventListener('click', () => {
          const now = store.get().time.jd_utc;
          const p = core?.tonight?.planets.find((x) => x.body === r.body);
          const upNow = p?.up_from && p.up_until && now >= p.up_from.jd_utc && now <= p.up_until.jd_utc;
          const jd = upNow ? null : r.best.jd_utc;
          pinAt(jd);
          showInSky(ctx, { kind: 'body', name: r.body }, jd);
        });
        return h('li', {}, open, ...r.extra.map((x) => para(x, 'sft-p sft-extra')));
      }),
    );
    fill(body, m.rows.length ? list : para('No planet is 10° up while the sky is dark tonight.'), m.others ? para(m.others, 'sft-p sft-muted') : null);
  };

  const drawDeep = (f: Fmt): void => {
    const body = deepCard.body;
    if (!core?.covered) return void fill(body);
    if (!isDeepSkyEngine(engine)) return void fill(body, missingText('deep sky'));
    if (!core.tonight) return void fill(body, para(core.errors[0] ?? 'Working out the deep sky…', 'sft-p sft-muted'));
    // The objects' descriptions and the constellations' names arrive in the next task
    // (`ensureCatalogs`): the star field's catalogue costs a first visit a noticeable moment.
    const rows = dsoRows(core, catalog, constellations ?? new Map(), f);
    const shown = rows.slice(0, mem.shown);
    const list = h('ol', { class: 'sft-list sft-list--dso' }, ...shown.map((r) => dsoItem(r, f)));
    const more =
      rows.length > shown.length
        ? button({
            label: `Show ${Math.min(DSO_FIRST, rows.length - shown.length)} more`,
            size: 'sm',
            variant: 'ghost',
            icon: 'plus',
            onClick: () => {
              mem.shown += DSO_FIRST;
              drawDeep(fmtOf(store.get()));
              // The list was drawn again: the keyboard goes to the first object added.
              deepCard.body.querySelectorAll<HTMLElement>('.sft-dso')[shown.length]?.querySelector('button')?.focus();
            },
          })
        : null;
    const c = core.tonight.conditions;
    const dark = core.tonight.night.darkness;
    fill(
      body,
      rows.length
        ? list
        : para(dark ? 'No object from the list climbs 20° while the sky is dark here tonight.' : 'The sky does not get dark enough tonight for faint objects.'),
      more ? h('div', { class: 'sft-actions' }, more) : null,
      para(
        `Ranked for a sky showing stars to magnitude ${c.nelm.toFixed(1)} overhead (Bortle ${c.bortle ?? '—'}), with the Moon’s light and each object’s height: an estimate by stated rules, not a promise. Objects with a name get a small boost.`,
        'sft-p sft-muted sft-small',
      ),
    );
  };

  /** The deep-sky catalogue (descriptions) and the constellations' names, once per page. */
  const ensureCatalogs = (): void => {
    if (!isDeepSkyEngine(engine)) return;
    if (!catalog) {
      try {
        catalog = engine.dsoCatalog().objects;
      } catch {
        catalog = [];
      }
    }
    if (!constellations) {
      constellations = new Map();
      try {
        for (const c of engine.starfieldCatalog().constellations) constellations.set(c.abbr, c.name);
      } catch {
        // abbreviations stay
      }
    }
  };

  const dsoItem = (r: DsoRow, f: Fmt): HTMLElement => {
    const show = button({
      label: 'Show in Sky',
      icon: 'sky',
      size: 'sm',
      variant: 'secondary',
      tip: `Open the Sky view at ${clock(r.best.jd_utc, f)}, when ${r.title.split(' · ')[0]} is best placed`,
      onClick: () => {
        pinAt(r.best.jd_utc);
        showInSky(ctx, { kind: 'deep_sky', id: r.id, label: r.title, ra_j2000_deg: r.ra_j2000_deg, dec_j2000_deg: r.dec_j2000_deg }, r.best.jd_utc);
      },
    });
    show.setAttribute('aria-label', `Show ${r.title} in the Sky view`);
    return h(
      'li',
      { class: 'sft-dso', 'data-id': r.id },
      h('div', { class: 'sft-dso__head' }, h('strong', {}, r.title), h('span', { class: 'sft-muted' }, r.what)),
      para(r.when, 'sft-p'),
      r.description ? para(r.description, 'sft-p sft-muted') : null,
      r.moon ? para(r.moon, 'sft-p sft-muted') : null,
      h('div', { class: 'sft-actions' }, show),
    );
  };

  const drawShowers = (f: Fmt): void => {
    const body = showersCard.body;
    if (!core?.covered) return void fill(body);
    if (!isDeepSkyEngine(engine)) return void fill(body, missingText('meteor showers'));
    if (!core.tonight) return void fill(body, para(core.errors[0] ?? 'Working out the showers…', 'sft-p sft-muted'));
    const rows = showerRows(core, f);
    const nextPeak = comingDone ? mergeComing(coming ?? new Map()).find((i) => i.kind === 'shower') : undefined;
    if (!rows.length) {
      fill(
        body,
        para('No meteor shower is active tonight: only the few sporadic meteors of any night.'),
        nextPeak ? para(`Next: the ${nextPeak.title.replace(/ peak$/, '')} at their peak, ${dayTitle(nextPeak.jd, f.zone)}.`, 'sft-p sft-muted') : null,
      );
      return;
    }
    fill(
      body,
      h(
        'ul',
        { class: 'sft-list' },
        ...rows.map((r) => {
          const see = r.best
            ? button({
                label: 'See the radiant',
                icon: 'sky',
                size: 'sm',
                variant: 'secondary',
                tip: `Open the Sky view at ${clock(r.best.jd_utc, f)} on the ${r.name}’ radiant`,
                onClick: () => {
                  const s = core?.tonight?.showers.find((x) => x.code === r.code);
                  if (!s) return;
                  pinAt(r.best!.jd_utc);
                  showInSky(ctx, { kind: 'radiant', code: s.code, label: s.name, ra_j2000_deg: s.radiant_ra_deg, dec_j2000_deg: s.radiant_dec_deg }, r.best!.jd_utc);
                },
              })
            : null;
          return h(
            'li',
            { class: 'sft-shower', 'data-code': r.code },
            h('div', { class: 'sft-dso__head' }, h('strong', {}, r.name), h('span', { class: 'sft-muted' }, r.rate)),
            para(r.when),
            para(r.moon, 'sft-p sft-muted'),
            para(r.reason, 'sft-p sft-muted'),
            see ? h('div', { class: 'sft-actions' }, see) : null,
          );
        }),
      ),
      para('Rates are estimates: the shower’s ZHR, cut by the radiant’s height and by how many faint meteors your sky and the Moon hide. Real showers vary.', 'sft-p sft-muted sft-small'),
    );
  };

  const drawMilky = (f: Fmt): void => {
    const body = milkyCard.body;
    if (!core?.covered) return void fill(body);
    const m = milkyWayModel(core, f);
    if (!m) return void fill(body, isDeepSkyEngine(engine) ? para(core.errors[0] ?? 'Working out the Milky Way…', 'sft-p sft-muted') : missingText('sun tools and deep sky'));
    const best = m.best;
    const plan = best
      ? button({
          label: 'Plan a photo',
          icon: 'target',
          size: 'sm',
          variant: 'secondary',
          tip: 'Go to the best moment and open the Milky Way planner on the Selected card',
          onClick: () => planPhoto(best.jd),
        })
      : null;
    const look = best
      ? button({
          label: 'Show in Sky',
          icon: 'sky',
          size: 'sm',
          variant: 'ghost',
          tip: `Open the Sky view at ${clock(best.jd, f)}, looking ${compassPoint(best.az)}`,
          onClick: () => {
            pinAt(best.jd);
            showInSky(ctx, { kind: 'direction', label: 'The Milky Way’s core', alt_deg: best.alt, az_deg: best.az }, best.jd);
          },
        })
      : null;
    fill(
      body,
      para(m.headline, 'sft-p sft-lead2'),
      best ? h('p', { class: 'sft-p' }, 'Best at ', timeButton(best.jd, f), `: ${best.text} (bearing ${bearing3(best.az)}).`) : null,
      ...m.lines.map((x) => para(x)),
      h('div', { class: 'sft-actions' }, plan, look),
    );
  };

  const drawComing = (f: Fmt): void => {
    const body = comingCard.body;
    if (!core?.covered) return void fill(body);
    const items = mergeComing(coming ?? new Map());
    const groups = groupByDay(items, f, (jd) => dayTitle(jd, f.zone));
    const list = h(
      'div',
      { class: 'sft-coming' },
      ...groups.map((g) =>
        h(
          'section',
          { class: 'sft-day' },
          h('h3', { class: 'sft-day__date' }, g.date),
          h('ul', { class: 'sft-list' }, ...g.items.map((i) => comingItem(i, f))),
        ),
      ),
    );
    const notes: HTMLElement[] = [];
    if (!comingDone) notes.push(para('Looking two weeks ahead…', 'sft-p sft-muted'));
    else if (!items.length) notes.push(para('Nothing notable in the next two weeks beyond the Moon’s phases.', 'sft-p sft-muted'));
    if (comingMissing.length) notes.push(para(`Not in this build of the engine: ${comingMissing.join(', ')}.`, 'sft-p sft-muted sft-small'));
    for (const e of comingErrors) notes.push(para(`Could not work out ${e}.`, 'sft-p sft-muted sft-small'));
    fill(body, items.length ? list : '', ...notes);
  };

  const comingItem = (i: ComingItem, f: Fmt): HTMLElement => {
    const open = h(
      'button',
      { type: 'button', class: 'sft-row sft-row--button', 'data-kind': i.kind, title: `Open Events at ${clock(i.jd, f)}` },
      h('span', { class: 'sft-row__time' }, clock(i.jd, f)),
      h('span', { class: 'sft-row__text' }, h('strong', {}, i.title), i.detail ? h('span', { class: 'sft-muted' }, ` ${i.detail}`) : null),
      icon('chevron-right', { class: 'sft-row__go' }),
    );
    // The time carries the night's ± uncertainty in its text when time-ui's rule asks for it (`clock`).
    // Events opens on the list of the item's kind at its moment, with its card when it has
    // one (events/link.ts `showEvents`; polish2, list item 41: it opened whatever tab Events
    // remembered).
    open.addEventListener('click', () => {
      store.batch(() => {
        pinAt(i.jd);
        showEvents(store, eventsTargetFor(i.kind) ?? 'eclipses', { jd: i.jd, body: i.body, id: i.ref ?? null });
      });
    });
    return h('li', { class: i.seen ? 'sft-coming__item' : 'sft-coming__item is-unseen' }, open);
  };

  const drawTides = (s: ExplorerState, f: Fmt): void => {
    const body = tidesCard.body;
    const t = tides;
    if (!t || t.kind === 'hidden') {
      tidesCard.el.hidden = true;
      fill(body);
      return;
    }
    tidesCard.el.hidden = false;
    if (t.kind === 'loading') {
      const text = tideAsking
        ? 'Getting the tides pack: the card at the bottom of the view asks before anything is downloaded, and shows its progress.'
        : 'Loading the tides pack saved on this device…';
      return void fill(body, para(text, 'sft-p sft-muted'));
    }
    if (t.kind === 'error') return void fill(body, para(`Tides could not be worked out: ${t.message}`, 'sft-p sft-muted'));
    if (t.kind === 'offer') {
      // The size is the site's list's (asked for once, see `learnPackSize`).
      learnPackSize();
      const size = t.bytes ? formatBytes(t.bytes) : '';
      const get = button({
        label: `Get tide predictions (US stations${size ? `, ${size}` : ''})`,
        icon: 'plus',
        size: 'sm',
        variant: 'secondary',
        tip: 'Downloaded once and saved on this device; nothing about you is sent',
        onClick: () => getTides(t.declined),
      });
      fill(
        body,
        para(
          t.declined
            ? 'Tide predictions are not saved on this device.'
            : 'A NOAA tide station may be within 100 nautical miles of this place. Its high and low waters tonight come from an optional data pack.',
          'sft-p',
        ),
        h('div', { class: 'sft-actions' }, get),
      );
      return;
    }
    const st = t.station;
    const units = s.settings.units;
    const zone = f;
    const rows = t.extremes.map((e) =>
      h('li', { class: 'sft-tide' }, timeButton(e.jd_utc, zone), h('span', {}, e.kind === 'high' ? 'High water' : 'Low water'), h('span', { class: 'sft-num' }, tideHeight(e.height_m, units))),
    );
    fill(
      body,
      rows.length ? h('ul', { class: 'sft-list sft-list--tides' }, ...rows) : para('No high or low water between sunset and sunrise.', 'sft-p'),
      para(
        `${st.name}${st.state ? `, ${st.state}` : ''}: ${stationWhere(st, units, compassPoint(st.bearing_deg))}. Predicted, not observed: weather and surge are not included. Heights above ${datumWords(t.datum)}.`,
        'sft-p sft-muted sft-small',
      ),
      st.kind === 'subordinate' ? para(`A subordinate station: times and heights are offsets from ${st.reference_name ?? 'a reference station'}, as NOAA’s tables give them.`, 'sft-p sft-muted sft-small') : null,
      h(
        'div',
        { class: 'sft-actions' },
        button({
          label: 'Tides chart',
          icon: 'charts',
          size: 'sm',
          variant: 'secondary',
          tip: 'The predicted tide curve for this station in Charts',
          // Loaded when asked: the Charts view's code stays out of this view's.
          onClick: () => void import('../charts/index.js').then((m) => m.showCharts(store, 'tides')),
        }),
      ),
    );
    tidesCard.el.title = t.label;
  };

  const drawPhoto = (f: Fmt): void => {
    const body = photoCard.body;
    if (!core?.covered) return void fill(body);
    const rows = lightRows(core, f);
    if (!rows) return void fill(body, missingText('sun tools: golden and blue hours'));
    const evening = rows.filter((r) => r.period === 'evening');
    const morning = rows.filter((r) => r.period === 'morning');
    const other = rows.filter((r) => r.period === 'other');
    const block = (title: string, list: typeof rows): HTMLElement | null =>
      list.length
        ? h(
            'div',
            { class: 'sft-light' },
            h('h3', { class: 'sft-day__date' }, title),
            h(
              'ul',
              { class: 'sft-list' },
              ...list.map((r) => h('li', { class: `sft-lightrow sft-lightrow--${r.kind}` }, h('span', { class: 'sft-swatch', 'data-kind': r.kind, 'aria-hidden': 'true' }), h('span', {}, r.label), timeButton(r.jd, f, r.range))),
            ),
          )
        : null;
    fill(
      body,
      block('This evening', evening) ?? para('No golden or blue hour this evening.', 'sft-p sft-muted'),
      block('Tomorrow morning', morning) ?? para('No golden or blue hour tomorrow morning.', 'sft-p sft-muted'),
      block('Around the clock', other),
      para('Golden hour: the Sun between 6° up and 4° down; blue hour: 4° to 6° down. Photographers’ conventions, not physical boundaries.', 'sft-p sft-muted sft-small'),
    );
  };

  const drawNotes = (): void => {
    const notes: HTMLElement[] = [];
    if (core?.missing.length) notes.push(para(`This build of the engine has no ${core.missing.join(' and no ')}: those parts of the page are left out.`, 'sft-p sft-small'));
    for (const n of core?.tonight?.notes ?? []) notes.push(para(n, 'sft-p sft-small'));
    const errs = [...(core?.errors ?? []), ...(detail?.errors ?? []), ...(core?.tonight?.errors ?? [])];
    for (const e of errs) notes.push(para(e, 'sft-p sft-small'));
    notes.push(para('Darkness, rising and setting are for a clear sky and a level horizon. Every number comes from the SkyFix Lab core running in this page.', 'sft-p sft-small'));
    fill(notesEl, ...notes);
  };

  const drawAll = (): void => {
    const s = store.get();
    const f = fmtOf(s);
    root.dataset.mock = engine.kind === 'mock' ? 'true' : 'false';
    // Outside the core's years only the header speaks: empty cards would say nothing.
    const outside = core !== null && !core.covered;
    tl.el.hidden = outside;
    grid.hidden = outside;
    drawHeader(s, f);
    drawTimeline(f);
    drawMoon(s, f);
    drawPlanets(f);
    drawDeep(f);
    drawShowers(f);
    drawMilky(f);
    drawComing(f);
    drawTides(s, f);
    drawPhoto(f);
    drawNotes();
    shownFmt = fmtKey(s);
  };

  // --- work -----------------------------------------------------------------------------------
  /** The night the explorer's time belongs to (night.ts), or the one this view pinned it in. */
  const nightOf = (s: ExplorerState): number | null => {
    const p = mem.pin;
    if (p && p.jd === s.time.jd_utc && p.lat === s.observer.lat_deg && p.lon === s.observer.lon_deg) return p.n;
    mem.pin = null;
    return chooseNight(ctx, s);
  };

  /** Remember the shown night when the view moves the time to a moment of it (see `Remembered.pin`). */
  const pinAt = (jd: number | null): void => {
    const n = core?.covered ? core.q.n : null;
    const o = store.get().observer;
    mem.pin = jd !== null && n !== null && jd >= n && jd < n + 1 ? { jd, n, lat: o.lat_deg, lon: o.lon_deg } : null;
  };

  /** Move the explorer's time to a moment of this night (the timeline, a time button). */
  const moveTo = (jd: number): void => {
    pinAt(jd);
    setTime(store, jd);
  };

  const runComing = (gen: number, q: NightQuery, f: Fmt, index: number): void => {
    if (gen !== generation) return;
    if (index >= COMING_SOURCES.length) {
      comingDone = true;
      drawComing(fmtOf(store.get()));
      drawShowers(fmtOf(store.get()));
      root.dataset.coming = 'done';
      later(() => runLast(gen));
      return;
    }
    const source = COMING_SOURCES[index]!;
    if (!source.available(ctx)) comingMissing.push(source.label);
    else {
      try {
        coming!.set(source.id, source.run(ctx, q, f));
      } catch (error) {
        comingErrors.push(`${source.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    later(() => runComing(gen, q, f, index + 1));
  };

  const runLast = (gen: number): void => {
    if (gen !== generation || !core) return;
    if (detail && core.covered) {
      detail.features = loadFeatures(ctx, core, featuresMoment(core));
      drawMoon(store.get(), fmtOf(store.get()));
    }
  };

  /**
   * The tides pack's size comes from the site's list of packs, which the pack service reads
   * when first needed: ask for it once, as the page opens, where the offer may be shown, so
   * the button can say how big the download is.
   */
  const learnPackSize = (): void => {
    if (manifestAsked || !isTidesEngine(engine) || tidesLoaded(ctx)) return;
    if (ctx.packs.status().some((p) => p.name === TIDES_PACK)) return;
    const o = store.get().observer;
    if (!mayHaveTideStation(o.lat_deg, o.lon_deg)) return;
    manifestAsked = true;
    void ctx.packs.refresh();
  };

  const refreshTides = (): void => {
    if (!core) return;
    const s = store.get();
    const span = tlModel ? [tlModel.start, tlModel.end] : [core.q.n + 0.25, core.q.n + 0.75];
    tides = tideCard(ctx, s.observer.lat_deg, s.observer.lon_deg, span[0]!, span[1]!, tidePending);
    // A copy saved on this device but not loaded yet: load it without a question.
    if (tides.kind === 'offer' && !tidePending && ctx.packs.status().find((p) => p.name === TIDES_PACK)?.saved) {
      tidePending = true;
      void ctx.packs.ensure(TIDES_PACK, TIDES_REASON).then(() => {
        tidePending = false;
        refreshTides();
      });
    }
    drawTides(s, fmtOf(s));
  };

  const getTides = (declined: boolean): void => {
    tidePending = true;
    tideAsking = true;
    refreshTides();
    const done = (ok: boolean): void => {
      tidePending = false;
      tideAsking = false;
      if (!ok) markDeclined(ctx);
      refreshTides();
      tidesCard.body.querySelector<HTMLElement>('button, .sft-time')?.focus();
    };
    // Declined once this session: the service will not ask again, so this is the explicit Get.
    void (declined ? ctx.packs.get(TIDES_PACK) : ctx.packs.ensure(TIDES_PACK, TIDES_REASON)).then(done, () => done(false));
  };

  /** Work out the night now (generation-guarded; the later stages each in their own task). */
  const compute = (): void => {
    const s = store.get();
    const n = nightOf(s);
    const gen = ++generation;
    realNight = realNightNow(s);
    root.removeAttribute('data-stale');
    root.dataset.coming = 'pending';
    status.textContent = '';
    if (n === null) {
      core = { q: nightQuery(s, localNoon(s), mem.sky), covered: false, day: null, tonight: null, sunHours: null, galactic: null, missing: [], errors: [] };
      detail = null;
      coming = new Map();
      comingDone = true;
      shownKey = `outside|${s.observer.lat_deg}|${s.observer.lon_deg}`;
      drawAll();
      return;
    }
    const q = nightQuery(s, n, mem.sky);
    shownKey = queryKey(q);
    const t0 = performance.now();
    core = loadCore(ctx, q);
    const t1 = performance.now();
    detail = null;
    coming = new Map();
    comingDone = false;
    comingErrors = [];
    comingMissing = [];
    drawAll();
    root.dataset.stage = 'core';
    // What the engines took for the night's core, and what the page took to draw it (ui-check).
    root.dataset.coreMs = String(Math.round(t1 - t0));
    root.dataset.drawMs = String(Math.round(performance.now() - t1));
    later(() => {
      if (gen !== generation || !core) return;
      detail = loadDetail(ctx, core);
      ensureCatalogs();
      const f = fmtOf(store.get());
      drawHeader(store.get(), f);
      drawMoon(store.get(), f);
      drawPlanets(f);
      drawDeep(f);
      drawNotes();
      refreshTides();
      root.dataset.stage = 'detail';
      later(() => runComing(gen, q, f, 0));
    });
  };

  const localNoon = (s: ExplorerState): number => {
    const shift = s.observer.lon_deg / 360;
    return Math.floor(s.time.jd_utc + shift) - shift;
  };

  const realNightNow = (s: ExplorerState): number | null => {
    const nowJd = Date.now() / 86_400_000 + 2_440_587.5;
    try {
      return chooseNight(ctx, s, nowJd);
    } catch {
      return null;
    }
  };

  // Waiting for the time to settle (the time bar dragged, playback).
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstPending = 0;
  const request = (immediate: boolean): void => {
    if (timer !== null) clearTimeout(timer);
    const now = performance.now();
    if (immediate || shownKey === '') {
      timer = null;
      compute();
      return;
    }
    if (timer === null) firstPending = now;
    root.dataset.stale = 'true';
    status.textContent = 'Working out the night…';
    const wait = now - firstPending >= MAX_WAIT_MS ? 0 : SETTLE_MS;
    timer = setTimeout(() => {
      timer = null;
      compute();
    }, wait);
  };
  d.add(() => {
    if (timer !== null) clearTimeout(timer);
  });

  const stepNight = (dir: -1 | 1): void => {
    const s = store.get();
    const jd = stepNightTime(ctx, s, dir, nightOf(s));
    mem.pin = null;
    setTime(store, jd);
    request(true);
  };

  const goTonight = (): void => {
    store.patch({ time: { jd_utc: Date.now() / 86_400_000 + 2_440_587.5, live: true, playing: false } });
    request(true);
  };

  /** The best moment, then the photo agent's Milky Way planner on the Selected card (the panel shown first). */
  const planPhoto = (jd: number): void => {
    pinAt(jd);
    setTime(store, jd);
    const app = document.querySelector<HTMLElement>('.sf-app');
    if (app?.dataset.panel === 'closed') document.querySelector<HTMLElement>('.sf-panel-toggle')?.click();
    openMilkyWayPlanner(ctx);
  };

  // --- following the explorer ------------------------------------------------------------------
  d.add(
    watch(
      ctx,
      (s) =>
        [
          s.time.jd_utc,
          s.observer.lat_deg,
          s.observer.lon_deg,
          s.observer.height_m,
          s.observer.label,
          s.observer.zone,
          s.settings.timeDisplay,
          s.settings.hourCycle,
          s.settings.units,
          s.settings.angleFormat,
          s.settings.horizon,
          s.settings.height_of_eye_m,
          s.settings.navigatorTerms,
        ] as const,
      () => {
        const s = store.get();
        const n = nightOf(s);
        const key = n === null ? `outside|${s.observer.lat_deg}|${s.observer.lon_deg}` : queryKey(nightQuery(s, n, mem.sky));
        if (key !== shownKey) {
          request(false);
        } else {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
            root.removeAttribute('data-stale');
            status.textContent = '';
          }
          if (fmtKey(s) !== shownFmt) drawAll();
        }
        timeline.setNow(s.time.jd_utc, fmtOf(s));
      },
      { equals: shallowEqual },
    ),
  );
  // A pack loaded or removed (the tides pack): the tides card may change.
  d.add(ctx.packs.subscribe(() => refreshTides()));
  learnPackSize();

  return { destroy: () => d.dispose() };
};

export default view;
