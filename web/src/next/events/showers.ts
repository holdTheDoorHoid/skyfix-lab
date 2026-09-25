/**
 * The Meteors tab: the year's meteor showers (`meteor_showers`) as a calendar — when each is
 * active and peaks, its zenithal hourly rate, how much the Moon gets in the way — with, for
 * the place, the rate to expect at best on the peak night, and tonight's expected rates
 * (`tonight`). Rates are estimates from a stated model and say so. OWNER: events2 agent.
 *
 * The year with the place is one engine call of a few hundred milliseconds of WebAssembly:
 * the calendar is drawn first from the call without the place (fast), and the place's
 * rates follow in the background (search.ts).
 */

import { h, s as svgEl } from '../../dom.js';
import { disposer } from '../component.js';
import { isDeepSkyEngine, type ShowerDates, type ShowerYear, type SkyConditionsInput, type Tonight } from '../engine/types.js';
import { dateLong, monthName } from '../shell/format.js';
import { displayZone } from '../state.js';
import { msFromJd, roundToMinute } from '../time.js';
import { gregorianDateOfMs, formatYear } from '../time/index.js';
import { phaseDisc } from '../theme/glyphs.js';
import { button } from '../theme/primitives.js';
import { calendarNote, chipsIn, coveredSentence, rowTimeInfo, wireYear } from './deeptime.js';
import { errorText, watchAll, type TabComponent, type TabEnv } from './env.js';
import { addToCalendarButton, exportMenu } from './export-ui.js';
import { fileWords, screenWords, type EventItem, type Words } from './items.js';
import { coverageKey, observerOf } from './listtab.js';
import { nextAfter } from './model.js';
import { eventRow, splitView, type Badge, type Row } from './rows.js';
import { moonGlare, moonWords, nightWords, rateText, showerId, showerItem, tonightLine } from './sky-model.js';
import { rangeWords } from '../time/tier.js';
import { skyConditions } from '../sky/conditions.js';
import { skyChoiceSelect } from '../sky/sky-choice.js';

/** Showers this strong or variable get a bar in the year strip; the list has them all. */
export const STRIP_MIN_ZHR = 10;


/** Cached per year, place and sky: the year without the place (fast) and with it. */
interface YearCache {
  key: string;
  plain: ShowerYear | null;
  site: ShowerYear | null;
  error: string | null;
}

export const showersTab: TabComponent = (host, env) => {
  const { ctx, ui } = env;
  const d = disposer();
  const root = h('div', { class: 'sfe-tabbody sfe-list2 sfe-showers' });
  host.append(root);
  d.add(() => root.remove());
  const ds = isDeepSkyEngine(ctx.engine) ? ctx.engine : null;
  if (!ds) {
    root.append(h('p', { class: 'sfe-message', role: 'alert' }, 'This build of the numerical core has no meteor showers. Rebuild it with: npm run wasm --prefix web'));
    return { destroy: () => d.dispose() };
  }

  // --- Controls ----------------------------------------------------------------------------
  const yearOf = (): number => ui.get().showerYear ?? wireYear(ui.get().anchor);
  const yearLabel = h('span', { class: 'sfe-year-step__label', 'aria-live': 'polite' });
  const prev = button({ icon: 'chevron-left', variant: 'ghost', size: 'sm', ariaLabel: 'The year before', onClick: () => ui.patch({ showerYear: yearOf() - 1 }) });
  const next = button({ icon: 'chevron-right', variant: 'ghost', size: 'sm', ariaLabel: 'The year after', onClick: () => ui.patch({ showerYear: yearOf() + 1 }) });
  const thisYear = button({ label: 'This year', variant: 'ghost', size: 'sm', tip: 'The year of the explorer’s time', onClick: () => ui.patch({ showerYear: null }) });
  const yearStep = h('div', { class: 'sfe-year-step', role: 'group', 'aria-label': 'Year' }, prev, yearLabel, next, thisYear);
  // How dark the sky is: the stored setting Settings, the Sky view and Tonight share
  // (sky/sky-choice.ts; polish2, list items 37 and 45: it was this tab's own four classes).
  const skyChoice = skyChoiceSelect(ctx.store, { class: 'sf-input sfe-sky', label: 'How dark your sky is' });
  const darkness = { el: h('label', { class: 'sfe-sky-choice' }, h('span', {}, 'Your sky'), skyChoice.el) };
  const tonightBox = h('div', { class: 'sfe-tonight' });
  const status = h('p', { class: 'sfe-status', role: 'status', 'aria-live': 'polite' });
  const strip = h('div', { class: 'sfe-figure' });
  const listHost = h('div', { class: 'sfe-list2__rows' });
  const notes = h('div', { class: 'sfe-notes' });
  const split = splitView(root);
  d.add(() => split.destroy());

  let showers: ShowerDates[] = [];
  const itemsFor = (w: Words): EventItem[] => showers.map((sd) => showerItem(sd, w));
  const save = exportMenu(ctx, ui, {
    title: () => `Meteor showers ${formatYear(yearOf())}`,
    fileParts: () => ['meteor-showers', yearOf()],
    items: (w) => itemsFor(w),
    local: true,
    notes: () => [RATE_NOTE],
  });
  d.add(() => save.destroy());
  split.list.append(listHost, notes);
  root.append(h('div', { class: 'sfe-controls' }, yearStep, darkness.el, save.el), status, tonightBox, strip, split.el);

  // --- Data --------------------------------------------------------------------------------
  let cache: YearCache = { key: '', plain: null, site: null, error: null };
  let timer: ReturnType<typeof setTimeout> | null = null;
  d.add(() => {
    if (timer !== null) clearTimeout(timer);
  });
  const conditions = (): SkyConditionsInput => skyConditions(ctx.store.get().settings);
  const skyKey = (): string => JSON.stringify(conditions());
  const keyNow = (): string => {
    const { key } = observerOf(ctx.store.get());
    return `${yearOf()}|${key}|${skyKey()}|${coverageKey(env)}`;
  };
  /** The place's rates, in the background once the page is still. */
  const scheduleSite = (): void => {
    if (timer !== null) clearTimeout(timer);
    const want = cache.key;
    const run = (): void => {
      timer = null;
      if (cache.key !== want || cache.site) return;
      const wait = env.pace();
      if (wait > 0) {
        timer = setTimeout(run, wait);
        return;
      }
      try {
        cache.site = ds.meteorShowers(yearOf(), observerOf(ctx.store.get()).observer, conditions());
      } catch (error) {
        cache.error = errorText(error);
      }
      ctx.scheduler.schedule(render);
    };
    timer = setTimeout(run, 30);
  };

  let tonight: { key: string; value: Tonight | null } = { key: '', value: null };
  const tonightNow = (): Tonight | null => {
    const s = ctx.store.get();
    const { observer, key } = observerOf(s);
    const k = `${Math.round(ui.get().anchor * 48)}|${key}|${skyKey()}`;
    if (tonight.key === k) return tonight.value;
    let value: Tonight | null = null;
    try {
      value = ds.tonight(observer, ui.get().anchor, { ...conditions(), limit: 1 });
    } catch {
      value = null;
    }
    tonight = { key: k, value };
    return value;
  };

  // --- Drawing -----------------------------------------------------------------------------
  let rows: { item: EventItem; row: Row; sd: ShowerDates }[] = [];
  let builtKey = '';
  let card: { el: HTMLElement; id: string } | null = null;
  const render = (): void => {
    const s = ctx.store.get();
    const u = ui.get();
    const year = yearOf();
    yearLabel.textContent = formatYear(year);
    skyChoice.sync(s);
    thisYear.hidden = u.showerYear === null;
    const key = keyNow();
    if (key !== cache.key) {
      cache = { key, plain: null, site: null, error: null };
      try {
        cache.plain = ds.meteorShowers(year, null, conditions());
      } catch (error) {
        cache.error = errorText(error);
      }
      if (!cache.error) scheduleSite();
    }
    const data = cache.site ?? cache.plain;
    showers = data ? [...data.showers].sort((a, b) => a.peak.jd_utc - b.peak.jd_utc) : [];
    const w = screenWords(s);
    const zone = displayZone(s);
    const items = itemsFor(w);
    const chips = items.length ? chipsIn(ctx.engine, items[0]!.start, items[items.length - 1]!.start) : false;
    const bk = JSON.stringify([key, !!cache.site, u.shower, s.settings.hourCycle, s.settings.angleFormat, zone, chips]);
    if (bk !== builtKey) {
      builtKey = bk;
      rows = showers.map((sd, i) => {
        const item = items[i]!;
        const badges: Badge[] = [{ text: `ZHR ${sd.shower.zhr}`, tone: sd.shower.zhr >= 50 ? 'accent' : 'plain', tip: 'Zenithal hourly rate: meteors an hour at the peak under a perfect sky with the radiant overhead' }];
        const glare = moonGlare(sd.moon_illuminated_fraction);
        badges.push({ text: `Moon ${Math.round(sd.moon_illuminated_fraction * 100)}%`, tone: glare === 'bright' ? 'muted' : glare === 'dark' ? 'accent' : 'plain', tip: moonWords(sd.moon_illuminated_fraction) });
        if (sd.shower.variable) badges.push({ text: 'Variable', tone: 'muted', tip: 'Some years far richer or poorer than its ZHR' });
        if (sd.at_site) badges.push({ text: `Here ${rateText(sd.at_site.expected_rate_per_hour).replace('about ', '~').replace(' an hour', '/h')}`, tone: 'plain', tip: 'Expected at best at your place on the peak night (an estimate)' });
        const row = eventRow({
          item,
          zone,
          glyph: meteorGlyph(),
          badges,
          timeInfo: rowTimeInfo(ctx.engine, item.start, chips),
          onJump: () => env.jump(item.jump),
          add: addToCalendarButton(ctx, ui, () => showerItem(sd, fileWords(ctx.store.get())), `${item.title}, ${w.dateYear(item.start)}`),
          onSelect: () => ui.patch({ shower: u.shower === sd.shower.code ? null : sd.shower.code }),
          data: { shower: sd.shower.code },
        });
        row.setSelected(sd.shower.code === u.shower);
        return { item, row, sd };
      });
      const byMonth = new Map<number, HTMLOListElement>();
      const groups: HTMLElement[] = [];
      for (const r of rows) {
        const m = gregorianDateOfMs(msFromJd(r.item.start)).month;
        let ol = byMonth.get(m);
        if (!ol) {
          ol = h('ol', { class: 'sfe-ev2-list', 'aria-label': `Meteor showers peaking in ${monthName(m)}` });
          byMonth.set(m, ol);
          groups.push(h('h3', { class: 'sfe-year' }, monthName(m)), ol);
        }
        ol.append(r.row.el);
      }
      listHost.replaceChildren(...groups);
      const years = cache.error ? rangeWords(cache.error) : null;
      if (!rows.length)
        listHost.append(
          h(
            'p',
            { class: 'sfe-message' },
            years
              ? `No meteor showers for ${formatYear(year)}: they are worked out only for ${years}.`
              : cache.error
                ? `Meteor showers could not be computed for ${formatYear(year)}: ${cache.error}. ${coveredSentence(ctx.engine, 'Meteor showers')}.`
                : `No meteor showers in ${formatYear(year)}.`,
          ),
        );
      strip.replaceChildren(yearStrip(showers, year, u.anchor));
      const cal = items.length ? calendarNote([items[0]!.start, items[items.length - 1]!.start], zone) : '';
      notes.replaceChildren(
        h('p', { class: 'sfe-note' }, RATE_NOTE),
        ...(cal ? [h('p', { class: 'sfe-note' }, cal)] : []),
        // No source line (verify2): nothing on screen credits anything but OpenStreetMap; the
        // table's sources are in THIRD_PARTY.md, which About links.
      );
      renderCard(w);
      save.refresh();
    }
    renderTonight(w);
    const text = cache.error && !rows.length ? '' : `${rows.length} showers peak in ${formatYear(year)}${cache.site ? '' : '; working out the rates at your place…'}`;
    if (status.textContent !== text) status.textContent = text;
    root.dataset.state = cache.site || cache.error ? 'done' : 'searching';
    markNext();
  };

  const renderTonight = (w: Words): void => {
    const t = tonightNow();
    const lines = t?.showers.filter((n) => n.expected_rate_per_hour >= 0.5 || n.variable) ?? [];
    const k = JSON.stringify([tonight.key, lines.map((n) => tonightLine(n, w))]);
    if (tonightBox.dataset.key === k) return;
    tonightBox.dataset.key = k;
    const head = h('h3', { class: 'sfe-card__sub' }, 'The night of the time shown');
    if (!t) {
      tonightBox.replaceChildren(head, h('p', { class: 'sfe-note' }, 'Tonight’s rates could not be worked out for this place and date.'));
      return;
    }
    const moon = t.night.moon;
    const dark = moon.up_hours + moon.down_hours;
    const moonLine = `${moonWords(moon.illuminated_fraction)}${moon.up_hours > 0.1 ? `; it is up for ${moon.up_hours.toFixed(1)} of the night’s ${dark.toFixed(1)} dark hours` : '; it is down all through the dark hours'}.`;
    tonightBox.replaceChildren(
      head,
      lines.length
        ? h('ul', { class: 'sfe-tonight__list' }, ...lines.map((n) => h('li', {}, `${tonightLine(n, w)}.`)))
        : h('p', {}, 'No shower gives more than the odd meteor tonight: about 5 to 10 random ones an hour still streak across a dark sky.'),
      h('p', { class: 'sfe-note' }, moonLine),
    );
  };

  const renderCard = (w: Words): void => {
    const code = ui.get().shower;
    const r = code ? rows.find((x) => x.sd.shower.code === code) : undefined;
    const id = r ? `${r.item.id}|${builtKey}` : 'empty';
    if (card && card.id === id) {
      split.place(card.el, r?.row.anchor ?? null);
      return;
    }
    const el = r ? showerCard(r.sd, r.item, w, env) : h('div', { class: 'sfe-card sfe-card--empty' }, h('p', {}, 'Choose a shower to see when and where to look from your place, and how much the Moon gets in the way.'));
    card = { el, id };
    split.place(el, r?.row.anchor ?? null);
  };

  const markNext = (): void => {
    const now = ctx.store.get().time.jd_utc;
    const nxt = nextAfter(rows.map((r) => ({ jd_utc: r.item.start, r })), now);
    for (const r of rows) r.row.setNext(nxt?.r === r);
  };

  d.add(
    watchAll(
      env,
      (s, u) => [u.anchor, u.showerYear, u.shower, s.settings.skyQuality, s.settings.skyBortle, s.settings.skyNelm, s.observer.lat_deg, s.observer.lon_deg, s.observer.height_m, s.observer.zone, s.settings.timeDisplay, s.settings.hourCycle, s.settings.angleFormat] as const,
      () => render(),
    ),
  );
  d.add(ctx.store.select((s) => s.time.jd_utc, () => ctx.scheduler.schedule(markNext)));
  d.add(() => {
    ctx.scheduler.cancel(render);
    ctx.scheduler.cancel(markNext);
  });
  return { destroy: () => d.dispose() };
};

const RATE_NOTE =
  'Rates are estimates from a simple model: the shower’s ZHR, falling off away from the peak, times the height of its radiant and the darkness of your sky (with the Moon’s light). Real showers vary from year to year; the peak dates are the IMO’s, from the Sun’s position.';

/** A small streak: the list's glyph for a shower. */
function meteorGlyph(): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: 22, height: 22, class: 'sfe-meteor', 'aria-hidden': 'true' }) as SVGSVGElement;
  svg.append(svgEl('path', { d: 'M4 20 17 7', class: 'sfe-meteor__trail' }), svgEl('circle', { cx: 17.5, cy: 6.5, r: 2.4, class: 'sfe-meteor__head' }));
  return svg;
}

/** The year at a glance: the stronger showers' activity as bars, their peaks as dots, the Moon at each peak. */
function yearStrip(showers: readonly ShowerDates[], year: number, anchor: number): Element {
  const major = showers.filter((s) => s.shower.zhr >= STRIP_MIN_ZHR || s.shower.variable);
  const t0 = jdOf(year, 1, 1);
  const t1 = jdOf(year + 1, 1, 1);
  const W = 720;
  const left = 8;
  const right = 8;
  const rowH = 16;
  const top = 18;
  const H = top + Math.max(1, major.length) * rowH + 8;
  const x = (jd: number): number => left + ((Math.min(t1, Math.max(t0, jd)) - t0) / (t1 - t0)) * (W - left - right);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sfe-strip', role: 'img' }) as SVGSVGElement;
  for (let m = 1; m <= 12; m += 1) {
    const a = x(jdOf(year, m, 1));
    svg.append(svgEl('line', { x1: a, x2: a, y1: 12, y2: H - 4, class: 'sfe-strip__tick' }));
    const t = svgEl('text', { x: a + 3, y: 10, class: 'sfe-strip__month' });
    t.textContent = monthName(m).slice(0, 3);
    svg.append(t);
  }
  const described: string[] = [];
  major.forEach((s, i) => {
    const y = top + i * rowH;
    const a = x(s.start.jd_utc);
    const b = x(s.end.jd_utc);
    const p = x(s.peak.jd_utc);
    if (s.end.jd_utc > s.start.jd_utc) svg.append(svgEl('rect', { x: a, y: y + 4, width: Math.max(2, b - a), height: rowH - 9, rx: 3, class: 'sfe-strip__bar' }));
    const dot = svgEl('circle', { cx: p, cy: y + rowH / 2 - 0.5, r: 3.6, class: `sfe-strip__peak sfe-strip__peak--${moonGlare(s.moon_illuminated_fraction)}` });
    svg.append(dot);
    const label = svgEl('text', { x: p > W - 150 ? p - 7 : p + 7, y: y + rowH / 2 + 3, class: 'sfe-strip__name', 'text-anchor': p > W - 150 ? 'end' : 'start' });
    label.textContent = `${s.shower.name} ${s.shower.zhr}`;
    svg.append(label);
    described.push(`${s.shower.name}, peak ${monthName(gregorianDateOfMs(msFromJd(s.peak.jd_utc)).month)} ${gregorianDateOfMs(msFromJd(s.peak.jd_utc)).day}, ZHR ${s.shower.zhr}, Moon ${Math.round(s.moon_illuminated_fraction * 100)}% lit`);
  });
  if (anchor >= t0 && anchor <= t1) svg.append(svgEl('line', { x1: x(anchor), x2: x(anchor), y1: 12, y2: H - 4, class: 'sfe-strip__now' }));
  svg.setAttribute('aria-label', `The year’s main meteor showers: ${described.join('; ')}.`);
  const legend = h(
    'p',
    { class: 'sfe-note sfe-strip__legend' },
    h('span', { class: 'sfe-strip__key sfe-strip__key--dark' }),
    ' peak with little moonlight ',
    h('span', { class: 'sfe-strip__key sfe-strip__key--some' }),
    ' some ',
    h('span', { class: 'sfe-strip__key sfe-strip__key--bright' }),
    ' bright moonlight · bars: when each is active',
  );
  return h('figure', { class: 'sfe-strip-fig' }, svg, h('figcaption', {}, legend));
}

/** The UTC Julian date of a Gregorian date's midnight. */
function jdOf(year: number, month: number, day: number): number {
  const dt = new Date(0);
  dt.setUTCFullYear(year, month - 1, day);
  dt.setUTCHours(0, 0, 0, 0);
  return dt.getTime() / 86_400_000 + 2_440_587.5;
}

function showerCard(sd: ShowerDates, item: EventItem, w: Words, env: TabEnv): HTMLElement {
  const { ctx, ui } = env;
  const zone = displayZone(ctx.store.get());
  const s = sd.shower;
  const parts: Element[] = [];
  parts.push(h('div', { class: 'sfe-summary' }, h('p', {}, item.sentence)));
  const facts = h(
    'dl',
    { class: 'sfe-facts' },
    h('dt', {}, 'Active'),
    h('dd', {}, `${w.date(sd.start.jd_utc)} to ${w.date(sd.end.jd_utc)}`),
    h('dt', {}, 'Peak'),
    h('dd', {}, `${w.dateYear(sd.peak.jd_utc)} ${w.time(sd.peak.jd_utc)}`),
    h('dt', {}, 'Rate at the peak'),
    h('dd', {}, `ZHR ${s.zhr}${s.variable ? ' (variable)' : ''}`),
    h('dt', {}, 'Meteors’ speed'),
    h('dd', {}, `${s.v_inf_kms} km/s${s.v_inf_kms >= 55 ? ': fast, often leaving trains' : s.v_inf_kms <= 30 ? ': slow' : ''}`),
    h('dt', {}, 'Radiant'),
    h('dd', {}, `RA ${(s.ra_deg / 15).toFixed(1)} h, Dec ${s.dec_deg >= 0 ? '+' : '−'}${Math.abs(s.dec_deg).toFixed(0)}° (J2000)`),
    h('dt', {}, 'Parent'),
    h('dd', {}, s.parent ?? 'unknown'),
  );
  const moon = phaseDisc({ illuminated: sd.moon_illuminated_fraction, size: 44, label: `The Moon at the peak, ${Math.round(sd.moon_illuminated_fraction * 100)}% lit` });
  parts.push(h('div', { class: 'sfe-shower__facts' }, facts, h('div', { class: 'sfe-shower__moon' }, moon, h('span', { class: 'sfe-note' }, moonWords(sd.moon_illuminated_fraction)))));
  if (sd.at_site) {
    parts.push(h('h4', { class: 'sfe-card__sub' }, 'The peak night at your place'));
    parts.push(h('p', {}, nightWords(sd.at_site, w)));
    if (sd.at_site.reason) parts.push(h('p', { class: 'sfe-note' }, sd.at_site.reason));
    if (sd.at_site.best) {
      const go = button({
        label: 'Go to the best moment',
        icon: 'clock',
        size: 'sm',
        variant: 'secondary',
        onClick: () => env.jump(sd.at_site!.best!.jd_utc),
      });
      parts.push(h('div', { class: 'sfe-actions' }, go));
    }
  }
  parts.push(h('p', { class: 'sfe-note' }, RATE_NOTE));
  const add = addToCalendarButton(ctx, ui, () => showerItem(sd, fileWords(ctx.store.get())), `${item.title}, ${w.dateYear(item.start)}`);
  parts.push(h('div', { class: 'sfe-actions' }, add, h('span', { class: 'sfe-note' }, 'Add to a calendar')));
  return h(
    'article',
    { class: 'sfe-card sfe-card--shower', 'aria-labelledby': `sfe-sh-${s.code}`, 'data-shower': s.code },
    h('header', { class: 'sfe-card__head' }, h('p', { class: 'sfe-card__kicker' }, meteorGlyph(), h('span', {}, `${s.name} (${s.code})`)), h('h3', { class: 'sfe-card__title', id: `sfe-sh-${s.code}` }, dateLong(roundToMinute(sd.peak.jd_utc), zone))),
    ...parts,
  );
}

export { showerId };
