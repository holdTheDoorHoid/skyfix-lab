/**
 * The Moon calendar: a month of days, each with the Moon's phase disc, how much of it is
 * lit, the named phases on the days they happen, and moonrise and moonset. OWNER: charts
 * agent.
 *
 * - The disc is the engine's Moon at local noon (`sky_state`): the illuminated fraction
 *   and the bright limb's direction, north up for observers north of the equator and south
 *   up south of it, as people there see it.
 * - Waxing or waning comes from the engine's principal phases (`moon_phases`).
 * - Moonrise and moonset: `day_events_batch` over the month's local days. Some days have
 *   none (the Moon rises about 50 minutes later each day), and the calendar says so.
 * - ◀ ▶ step the app's time by a month; choosing a day moves the app to that day, keeping
 *   the time of day; a rise or set time moves it to that moment.
 * - Perigee and apogee (charts2 agent, expansion programme Q5): the Moon's nearest and
 *   farthest points of the month (`moon_apsides`, the moondetail engine), marked on their
 *   days with the distance, and the supermoons and micromoons on their full Moons. The search
 *   takes a tenth of a second or so, so it runs once the time settles and the marks appear
 *   after the calendar.
 * - Save (charts2): a picture of the month (drawn for the picture, in light colours), the
 *   table as CSV, print.
 */

import { h } from '../../dom.js';
import { disposer, memoize, observerKey, watch, type Ctx } from '../component.js';
import { isMoonDetailEngine, type MoonApsides, type PhaseEvent } from '../engine/types.js';
import { setTime, stepTime } from '../playback.js';
import { displayZone, engineObserver, eventOptions, type ExplorerState } from '../state.js';
import { wallClock, zoneLabel, type Zone } from '../time.js';
import { phaseDisc } from '../theme/glyphs.js';
import { fallbackLimbFromUp, limbFromUp } from './disc.js';
import {
  clockAt,
  clockUtcFast,
  dateLong,
  dateShort,
  MONTHS_LONG,
  MONTHS_SHORT,
  offsetOn,
  percent,
  WEEKDAYS_SHORT,
  zoneNameAt,
} from './format.js';
import { OutsideCoverageError } from './coverage.js';
import {
  applyMode,
  bindTimeButtons,
  scrollToCurrent,
  card,
  errorText,
  message,
  mockBadge,
  observeWidth,
  phaseGlyph,
  stepperNav,
  table,
  timeButtonText,
  type ChartComponent,
} from './frame.js';
import { apsidesOn, APSIS_WORDS, computeMoonMonth, monthGrid, PHASE_NAMES, syzygyWords, type MoonDay, type MoonInput, type MoonMonth } from './moon-data.js';
import { clamp } from './scale.js';
import { jdAtWallHours, localDateOf, sameDate, zoneKey } from './windows.js';
import { attachExport } from './export-menu.js';
import { settler } from './settle.js';
import { calendarPicture } from './moon-picture.js';
import { formatDistance } from '../shell/format.js';

const moonMemo = memoize(
  (ctx: Ctx, input: MoonInput) => computeMoonMonth(ctx.engine, input),
  (ctx, input) =>
    [ctx.engine.kind, observerKey(input.observer), zoneKey(input.zone), input.year, input.month, input.options.horizon, input.options.height_of_eye_m].join('|'),
  6,
);

/** The locale's first day of the week (0 = Sunday), Sunday when the browser cannot say. */
export function firstWeekday(locale?: string): number {
  try {
    const loc = new Intl.Locale(locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US')) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info && Number.isInteger(info.firstDay)) return info.firstDay % 7;
  } catch {
    // fall through
  }
  return 0;
}

export function moonInputFor(state: ExplorerState): MoonInput {
  const zone = displayZone(state);
  const date = localDateOf(state.time.jd_utc, zone);
  return { observer: engineObserver(state), zone, year: date.year, month: date.month, options: eventOptions(state) };
}

/** The phase disc of one day (the design system's disc), `size` px across. */
function disc(day: MoonDay, size: number, southUp: boolean): SVGSVGElement {
  const limb =
    day.brightLimbDeg !== null ? limbFromUp(day.brightLimbDeg, southUp) : fallbackLimbFromUp(day.waxing ?? true, southUp);
  return phaseDisc({ illuminated: day.illuminated ?? 0, limbFromUpDeg: limb, size });
}

export const moonCalendar: ChartComponent = (host, ctx, ui) => {
  const { store } = ctx;
  const d = disposer();
  const c = card('moon', 'Moon phases');
  host.append(c.root);
  d.add(() => c.root.remove());

  let data: MoonMonth | null = null;
  let failure: string | null = null;
  let width = 0;
  let focusKey: string | null = null;
  // Perigee and apogee (charts2): searched when the time settles, remembered per month.
  let apsides: MoonApsides | null = null;
  const apsidesCache = new Map<string, MoonApsides | null>();
  const settle = settler();
  d.add(() => settle.cancel());

  const nav = stepperNav(c.nav, 'Previous month', 'Next month', (dir) => stepTime(store, { unit: 'month', count: dir }));
  const phaseList = h('div', { class: 'sfc-cal-phases' });
  c.legend.replaceChildren(phaseList);

  function recompute(): void {
    const input = moonInputFor(store.get());
    try {
      data = moonMemo(ctx, input);
      failure = null;
      c.root.dataset.compute = `moon ${data.timing.totalMs.toFixed(0)} ms (engine ${data.timing.engineMs.toFixed(0)})`;
    } catch (error) {
      data = null;
      failure = error instanceof OutsideCoverageError ? error.message : `The engine could not compute this month: ${errorText(error)}`;
    }
  }

  function apsidesWindow(): { key: string; start: number; end: number } | null {
    if (!data || !data.days.length) return null;
    const start = data.days[0]!.day.jd_start;
    const end = data.days[data.days.length - 1]!.day.jd_end;
    return { key: `${ctx.engine.kind}|${start}|${end}`, start, end };
  }

  function loadApsides(): void {
    const w = apsidesWindow();
    const engine = ctx.engine;
    if (!w || !isMoonDetailEngine(engine)) {
      apsides = null;
      return;
    }
    if (apsidesCache.has(w.key)) {
      settle.cancel();
      apsides = apsidesCache.get(w.key) ?? null;
      return;
    }
    apsides = null;
    settle.request(() => {
      let value: MoonApsides | null = null;
      try {
        value = engine.moonApsides(w.start, w.end);
      } catch {
        value = null;
      }
      apsidesCache.set(w.key, value);
      while (apsidesCache.size > 6) apsidesCache.delete(apsidesCache.keys().next().value as string);
      if (apsidesWindow()?.key !== w.key) return;
      apsides = value;
      ctx.scheduler.schedule(frame);
      if (ui.get().mode === 'table') renderTable();
    });
  }

  function renderHeader(): void {
    const st = store.get();
    const input = moonInputFor(st);
    c.title.replaceChildren(`Moon phases · ${MONTHS_LONG[input.month - 1]} ${input.year}`);
    if (ctx.engine.kind === 'mock') c.title.append(mockBadge(ctx.engine.description));
    const place = st.observer.label || `${st.observer.lat_deg.toFixed(3)}°, ${st.observer.lon_deg.toFixed(3)}°`;
    c.subtitle.textContent = `${place} · ${zoneLabel(st.time.jd_utc, input.zone)} · ${
      st.observer.lat_deg < 0 ? 'discs drawn south up, as seen from the southern hemisphere' : 'discs drawn north up'
    }`;
    nav.textContent = `${MONTHS_SHORT[input.month - 1]} ${input.year}`;
  }

  function eventText(ev: Pick<PhaseEvent, 'jd_utc'>, zone: Zone): { local: string; utc: string; date: string } {
    const day = data?.days.find((x) => ev.jd_utc >= x.day.jd_start && ev.jd_utc < x.day.jd_end);
    const off = day ? offsetOn(day.day, ev.jd_utc, zone) : 0;
    const local = clockAt(ev.jd_utc, off);
    return {
      local: `${local} ${zoneNameAt(ev.jd_utc, zone, off)}`,
      utc: clockUtcFast(ev.jd_utc),
      date: day ? dateShort(day.day.date) : dateShort(localDateOf(ev.jd_utc, zone)),
    };
  }

  function renderPhaseList(): void {
    if (!data) {
      phaseList.replaceChildren();
      return;
    }
    const zone = data.input.zone;
    const south = store.get().observer.lat_deg < 0;
    const units = store.get().settings.units;
    phaseList.replaceChildren(
      ...data.events.map((ev) => {
        const t = eventText(ev, zone);
        return h(
          'span',
          { title: `${t.local} · ${t.utc}` },
          phaseGlyph(ev.kind, 7, 7, 7, south),
          h('strong', {}, PHASE_NAMES[ev.kind]),
          `${t.date.replace(/ \d{4}$/, '')}, ${t.local}`,
        );
      }),
      ...(apsides?.apsides ?? []).map((a) => {
        const t = eventText(a, zone);
        return h(
          'span',
          { title: `${t.local} · ${t.utc}: ${APSIS_WORDS[a.kind].long}` },
          h('span', { class: `sfc-apsis-mark sfc-apsis-mark--${a.kind}`, 'aria-hidden': 'true' }),
          h('strong', {}, APSIS_WORDS[a.kind].name),
          `${t.date.replace(/ \d{4}$/, '')}, ${t.local} · ${formatDistance(a.distance_km, units)}`,
        );
      }),
    );
  }

  function draw(): void {
    renderHeader();
    renderPhaseList();
    if (failure !== null) {
      message(c.plot, failure);
      c.root.dataset.ready = '1';
      return;
    }
    if (!data) return;
    const st = store.get();
    const zone = data.input.zone;
    const south = st.observer.lat_deg < 0;
    const selectedDate = localDateOf(st.time.jd_utc, zone);
    const first = firstWeekday();
    const rows = monthGrid(data.days, first);
    const cellW = width > 0 ? (width - 6 * 4) / 7 : 120;
    const size = Math.round(clamp(cellW * 0.36, 22, 58));

    const grid = h('div', { class: 'sfc-cal', role: 'grid', 'aria-label': `Moon phases, ${MONTHS_LONG[data.input.month - 1]} ${data.input.year}`, 'data-own-keys': '' });
    const head = h('div', { role: 'row', style: 'display: contents' });
    for (let i = 0; i < 7; i += 1) {
      head.append(h('div', { class: 'sfc-cal-wd', role: 'columnheader' }, WEEKDAYS_SHORT[(first + i) % 7]!));
    }
    grid.append(head);
    const buttons: HTMLButtonElement[] = [];
    for (const row of rows) {
      const r = h('div', { role: 'row', style: 'display: contents' });
      for (const md of row) {
        if (!md) {
          r.append(h('div', { class: 'sfc-cal-blank', role: 'gridcell', 'aria-hidden': 'true' }));
          continue;
        }
        const date = md.day.date;
        const current = sameDate(date, selectedDate);
        const times = h('span', { class: 'sfc-cal-times' });
        const riseTexts: string[] = [];
        const setTexts: string[] = [];
        for (const [list, cls, words] of [
          [md.rises, 'sfc-cal-rise', riseTexts],
          [md.sets, 'sfc-cal-set', setTexts],
        ] as const) {
          for (const jd of list) {
            const off = offsetOn(md.day, jd, zone);
            const local = clockAt(jd, off);
            words.push(local);
            times.append(
              h(
                'span',
                { class: cls, 'data-jd': String(jd), title: `${cls === 'sfc-cal-rise' ? 'Moonrise' : 'Moonset'} ${local} ${zoneNameAt(jd, zone, off)} · ${clockUtcFast(jd)}` },
                local,
              ),
            );
          }
        }
        if (!md.rises.length && !md.sets.length) {
          times.append(h('span', { class: 'sfc-muted' }, md.alwaysAbove ? 'up all day' : md.alwaysBelow ? 'down all day' : '—'));
        }
        const lit = md.illuminated === null ? null : percent(md.illuminated);
        const marks = apsidesOn(apsides, md.day);
        const units = st.settings.units;
        const badges = marks.length
          ? h(
              'span',
              { class: 'sfc-cal-badges' },
              ...marks.map((m) => h('span', { class: `sfc-cal-badge sfc-cal-badge--${m.kind}`, title: m.title(units, zone) }, m.short)),
            )
          : null;
        const label = [
          dateLong(date),
          md.error ? `no data (${md.error})` : `${md.name}${lit ? `, ${lit} lit` : ''}`,
          md.principal ? `${PHASE_NAMES[md.principal.kind]} at ${eventText(md.principal, zone).local}` : '',
          riseTexts.length ? `moonrise ${riseTexts.join(' and ')}` : md.alwaysAbove ? 'the Moon is up all day' : md.alwaysBelow ? 'the Moon stays down all day' : 'no moonrise',
          setTexts.length ? `moonset ${setTexts.join(' and ')}` : md.alwaysAbove || md.alwaysBelow ? '' : 'no moonset',
          ...marks.map((m) => m.title(units, zone)),
        ]
          .filter(Boolean)
          .join('; ');
        const cell = h(
          'button',
          {
            type: 'button',
            class: `sfc-cal-day${md.principal ? ' sfc-cal-day--principal' : ''}`,
            'aria-label': label,
            'aria-current': current ? 'date' : undefined,
            'data-key': md.day.key,
            tabindex: '-1',
          },
          h('span', { class: 'sfc-cal-num' }, String(date.day)),
          lit ? h('span', { class: 'sfc-cal-pct' }, lit) : null,
          disc(md, size, south),
          h(
            'span',
            {
              class: 'sfc-cal-name',
              title: md.principal
                ? `${PHASE_NAMES[md.principal.kind]} ${eventText(md.principal, zone).local} · ${eventText(md.principal, zone).utc}`
                : `${md.name}${md.ageDays !== null ? `, ${md.ageDays.toFixed(1)} days after new Moon` : ''}`,
            },
            md.principal ? `${PHASE_NAMES[md.principal.kind]} ${eventText(md.principal, zone).local.split(' ')[0]}` : md.name,
          ),
          badges,
          times,
        );
        cell.addEventListener('click', (event) => {
          const target = (event.target as Element | null)?.closest?.('[data-jd]');
          if (target) {
            setTime(store, Number(target.getAttribute('data-jd')));
            return;
          }
          const w = wallClock(store.get().time.jd_utc, zone);
          focusKey = md.day.key;
          setTime(store, jdAtWallHours(date, w.hour + w.minute / 60, zone));
        });
        buttons.push(cell);
        r.append(h('div', { role: 'gridcell', style: 'display: contents' }, cell));
      }
      grid.append(r);
    }

    // Roving focus: one tab stop, arrows move by a day or a week.
    const active = buttons.find((b) => b.getAttribute('data-key') === focusKey) ?? buttons.find((b) => b.getAttribute('aria-current') === 'date') ?? buttons[0];
    if (active) active.tabIndex = 0;
    grid.addEventListener('keydown', (event) => {
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      const step =
        event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? 7 : event.key === 'ArrowUp' ? -7 : event.key === 'Home' ? -i : event.key === 'End' ? buttons.length - 1 - i : 0;
      if (!step) return;
      event.preventDefault();
      const j = clamp(i + step, 0, buttons.length - 1);
      buttons[i]!.tabIndex = -1;
      buttons[j]!.tabIndex = 0;
      buttons[j]!.focus();
      focusKey = buttons[j]!.getAttribute('data-key');
    });

    const hadFocus = c.plot.contains(document.activeElement);
    c.plot.replaceChildren(grid);
    if (hadFocus) (buttons.find((b) => b.getAttribute('data-key') === focusKey) ?? active)?.focus();
    renderCaption();
    if (ui.get().mode === 'table') renderTable();
    c.root.dataset.ready = '1';
  }

  function renderCaption(): void {
    c.caption.replaceChildren(
      h(
        'span',
        { class: 'sfc-muted' },
        'Each disc is the Moon at local noon; the percentage is how much of it is lit. ↑ moonrise, ↓ moonset, local times (hover for UTC). Choose a day to go to it; choose a time to go to that moment.',
      ),
    );
    c.notes.replaceChildren(...(data?.errors ?? []).map((e) => h('p', { class: 'sfc-note' }, e)));
  }

  function renderTable(): void {
    if (!data) {
      c.tableWrap.replaceChildren(h('p', { class: 'sfc-message' }, failure ?? 'Nothing to show.'));
      return;
    }
    const zone = data.input.zone;
    const t = table(`The Moon, ${MONTHS_LONG[data.input.month - 1]} ${data.input.year} (local times, ${zoneLabel(data.days[0]!.day.jd_start + 0.5, zone)}; UTC on hover)`, [
      'Date',
      'Phase at noon',
      'Lit',
      'Age',
      'Moonrise',
      'Moonset',
      'Principal phase',
    ]);
    const currentKey = localDateOf(store.get().time.jd_utc, zone);
    for (const md of data.days) {
      const times = (list: readonly number[], none: string): Node[] =>
        list.length
          ? list.flatMap((jd, i) => {
              const off = offsetOn(md.day, jd, zone);
              const local = clockAt(jd, off);
              const b = timeButtonText(jd, local, `${local} ${zoneNameAt(jd, zone, off)}`, clockUtcFast(jd));
              return i ? [document.createTextNode(', '), b] : [b];
            })
          : [h('span', { class: 'sfc-muted' }, none)];
      const noneText = md.alwaysAbove ? 'up all day' : md.alwaysBelow ? 'down all day' : 'none';
      const principal = md.principal;
      const pt = principal ? eventText(principal, zone) : null;
      t.body.append(
        h(
          'tr',
          { class: sameDate(md.day.date, currentKey) ? 'sfc-row-current' : '' },
          h('th', { scope: 'row' }, dateShort(md.day.date)),
          h('td', { class: 'sfc-text' }, md.error ? `— (${md.error})` : md.name),
          h('td', {}, md.illuminated === null ? '—' : percent(md.illuminated)),
          h('td', {}, md.ageDays === null ? '—' : `${md.ageDays.toFixed(1)} d`),
          h('td', {}, ...times(md.rises, noneText)),
          h('td', {}, ...times(md.sets, noneText)),
          h(
            'td',
            { class: 'sfc-text' },
            principal && pt
              ? h('span', {}, `${PHASE_NAMES[principal.kind]} `, timeButtonText(principal.jd_utc, pt.local.split(' ')[0]!, pt.local, pt.utc))
              : '',
          ),
        ),
      );
    }
    const tables: HTMLElement[] = [t.table];
    if (apsides && (apsides.apsides.length || apsides.syzygies.length)) {
      const units = store.get().settings.units;
      const at = table(`Nearest and farthest: perigee and apogee, ${MONTHS_LONG[data.input.month - 1]} ${data.input.year} (centre to centre)`, [
        'Date',
        'Time',
        'Event',
        'Distance',
        'Size against the mean',
      ]);
      for (const a of apsides.apsides) {
        const day = data.days.find((x) => a.jd_utc >= x.day.jd_start && a.jd_utc < x.day.jd_end);
        if (!day) continue;
        at.body.append(
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, dateShort(day.day.date)),
            h('td', {}, timeButtonText(a.jd_utc, clockAt(a.jd_utc, offsetOn(day.day, a.jd_utc, zone)), eventText(a, zone).local, clockUtcFast(a.jd_utc))),
            h('td', { class: 'sfc-text' }, APSIS_WORDS[a.kind].long),
            h('td', { 'data-csv': a.distance_km.toFixed(0) }, formatDistance(a.distance_km, units)),
            h('td', { 'data-csv': a.diameter_vs_mean_percent.toFixed(2) }, `${a.diameter_vs_mean_percent >= 0 ? '+' : '−'}${Math.abs(a.diameter_vs_mean_percent).toFixed(1)} %`),
          ),
        );
      }
      for (const sz of apsides.syzygies) {
        if (!(sz.supermoon || sz.micromoon)) continue;
        const day = data.days.find((x) => sz.jd_utc >= x.day.jd_start && sz.jd_utc < x.day.jd_end);
        if (!day) continue;
        at.body.append(
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, dateShort(day.day.date)),
            h('td', {}, timeButtonText(sz.jd_utc, clockAt(sz.jd_utc, offsetOn(day.day, sz.jd_utc, zone)), eventText(sz, zone).local, clockUtcFast(sz.jd_utc))),
            h('td', { class: 'sfc-text' }, syzygyWords(sz)),
            h('td', { 'data-csv': sz.distance_km.toFixed(0) }, formatDistance(sz.distance_km, units)),
            h('td', { 'data-csv': sz.diameter_vs_mean_percent.toFixed(2) }, `${sz.diameter_vs_mean_percent >= 0 ? '+' : '−'}${Math.abs(sz.diameter_vs_mean_percent).toFixed(1)} %`),
          ),
        );
      }
      tables.push(at.table);
    }
    c.tableWrap.replaceChildren(...tables);
    c.root.dataset.ready = '1';
  }

  // --- wiring ------------------------------------------------------------------------------
  let dataDirty = true;
  function frame(): void {
    if (dataDirty) {
      dataDirty = false;
      recompute();
      loadApsides();
    }
    draw();
  }

  d.add(
    watch(
      ctx,
      (st) => {
        const input = moonInputFor(st);
        return `${observerKey(input.observer)}|${zoneKey(input.zone)}|${input.year}|${input.month}|${input.options.horizon}|${input.options.height_of_eye_m}`;
      },
      () => {
        dataDirty = true;
        frame();
      },
    ),
  );
  // The selected day follows the time; redraw when the date changes.
  d.add(
    watch(
      ctx,
      (st) => {
        const zone = displayZone(st);
        const date = localDateOf(st.time.jd_utc, zone);
        return `${date.year}-${date.month}-${date.day}`;
      },
      () => draw(),
      { immediate: false },
    ),
  );
  d.add(
    ui.select(
      (u) => u.mode,
      (mode) => {
        applyMode(c, mode);
        c.legend.hidden = false;
        if (mode === 'table') {
          renderTable();
          scrollToCurrent(c);
        }
      },
      { immediate: true },
    ),
  );
  d.add(
    observeWidth(c.plot, (w) => {
      const before = width;
      width = w;
      if (Math.abs(before - w) > 8) ctx.scheduler.schedule(frame);
    }),
  );
  d.add(bindTimeButtons(c.tableWrap, ctx));
  d.add(() => ctx.scheduler.cancel(frame));
  d.add(
    attachExport(c, {
      fileParts: () => {
        const i = moonInputFor(store.get());
        return ['moon-phases', `${i.year}-${String(i.month).padStart(2, '0')}`];
      },
      picture: () =>
        data
          ? calendarPicture(data, {
              apsides,
              south: store.get().observer.lat_deg < 0,
              firstWeekday: firstWeekday(),
              units: store.get().settings.units,
              title: `Moon phases, ${MONTHS_LONG[data.input.month - 1]} ${data.input.year}`,
            })
          : null,
      tables: () => {
        renderTable();
        return [...c.tableWrap.querySelectorAll('table')];
      },
      labels: () => ['Each disc is the Moon at local noon. Perigee and apogee: centre-to-centre distance (the moondetail engine).'],
    }),
  );

  return { destroy: () => d.dispose() };
};
