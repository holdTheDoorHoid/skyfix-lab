/**
 * The night's timeline: one bar from before sunset to after sunrise with the sky's twilight
 * bands, golden and blue hour, the Moon above the horizon, the Milky Way core's dark window
 * and the moonless darkness best for faint objects; below it, every moment as a button.
 * Clicking the bar anywhere, or a moment, sets the explorer's time. OWNER: tonight agent
 * (expansion programme Q2).
 *
 * `timelineModel` is pure (tested with the mock engine); `timelineView` draws it with plain
 * positioned elements (percentages of the span, so it needs no resize handling) and moves
 * only the "now" marker when the time changes inside the night.
 */

import { h } from '../../dom.js';
import type { SkyPhase, SunLightWindow } from '../engine/types.js';
import type { ChipSubject } from '../time/chip.js';
import { axisTime } from '../shell/format.js';
import { jdFromWallClock, MS_PER_HOUR, msFromJd, wallClock, jdFromMs } from '../time.js';
import { darknessOf, type NightCore } from './data.js';
import { clock, clockPlain, duration, MOON_SUN_TURNING, MOON_TURNING, percentLit, SUN_TURNING, type Fmt } from './format.js';
import { bodyEvents, galacticTurning, moonlessDark, moonUp, sunsetSunrise } from './model.js';
import { intersect, type Span } from './night.js';

const HOUR = 1 / 24;

export interface Band {
  start: number;
  end: number;
}

export type Lane = 'sky' | 'light' | 'moon' | 'core' | 'deep';

export interface Moment {
  jd: number;
  /** Plain words: `Darkness begins`. */
  label: string;
  /** The astronomer's or navigator's term, shown beside with Navigator's terms on. */
  term?: string;
  lane: Lane | 'tide';
  key: string;
  /** What sets its time, for its ± chip (chip2); absent: the lane's (`momentSubject`). */
  chip?: ChipSubject;
}

export interface TimelineModel {
  start: number;
  end: number;
  sky: (Band & { phase: SkyPhase })[];
  light: (Band & { kind: SunLightWindow['kind']; label: string })[];
  moon: Band[];
  moonLabel: string;
  core: (Band & { moonUp: boolean })[];
  /** What sets the core's times (chip2 `galacticTurning`): darkness, and the Moon where it splits them. */
  coreBy: ChipSubject;
  deep: Band[];
  moments: Moment[];
  ticks: { jd: number; label: string; odd: boolean }[];
  /** A sentence for screen readers: what the bar shows. */
  summary: string;
}

/**
 * What sets a moment's time, for its ± chip (chip2): its own when it says (the Milky Way core's
 * best), else the Sun's turning for the sky's and the light's lanes, the Moon's for moonrise and
 * moonset (and the tides, which follow it), the faster of both where darkness meets the Moon.
 */
export function momentSubject(m: Pick<Moment, 'lane' | 'chip'>): ChipSubject {
  if (m.chip) return m.chip;
  return m.lane === 'sky' || m.lane === 'light' ? SUN_TURNING : m.lane === 'moon' || m.lane === 'tide' ? MOON_TURNING : MOON_SUN_TURNING;
}

/** The span the bar covers: an hour before sunset to an hour after sunrise, inside the night. */
export function timelineSpan(core: NightCore): Span {
  const { n } = core.q;
  const { set, rise } = sunsetSunrise(core);
  const start = set !== null ? set - HOUR : n + 0.25;
  const end = rise !== null ? rise + HOUR : Math.max(start + 0.5, n + 0.75);
  return [Math.max(n, start), Math.min(n + 1, end)];
}

function clip(a: number, b: number, span: Span): Band | null {
  const s = intersect([a, b], span);
  return s ? { start: s[0], end: s[1] } : null;
}

const SUN_WORDS: Partial<Record<string, [string, string]>> = {
  set: ['Sunset', ''],
  civil_dusk: ['Blue hour ends', 'civil dusk'],
  nautical_dusk: ['Horizon fades', 'nautical dusk'],
  astronomical_dusk: ['Darkness begins', 'astronomical dusk'],
  astronomical_dawn: ['Darkness ends', 'astronomical dawn'],
  nautical_dawn: ['Horizon appears', 'nautical dawn'],
  civil_dawn: ['Blue hour begins', 'civil dawn'],
  rise: ['Sunrise', ''],
};

/** Whole local hours inside the span, every `every` hours. */
export function hourTicks(span: Span, f: Pick<Fmt, 'zone'>): { jd: number; label: string; odd: boolean }[] {
  const w = wallClock(span[0], f.zone);
  let t = jdFromWallClock({ year: w.year, month: w.month, day: w.day, hour: w.hour + 1 }, f.zone);
  const out: { jd: number; label: string; odd: boolean }[] = [];
  for (let i = 0; t < span[1] && i < 48; i += 1) {
    const hour = wallClock(t, f.zone).hour;
    out.push({ jd: t, label: axisTime(t, f.zone), odd: hour % 2 === 1 });
    t = jdFromMs(msFromJd(t) + MS_PER_HOUR);
  }
  return out;
}

export function timelineModel(core: NightCore, f: Fmt): TimelineModel {
  const span = timelineSpan(core);
  const sky = (core.day?.phases ?? []).map((p) => {
    const b = clip(p.jd_start, p.jd_end, span);
    return b ? { ...b, phase: p.phase } : null;
  });
  const light = (core.sunHours?.windows ?? []).map((w) => {
    const b = clip(w.jd_start, w.jd_end, span);
    return b ? { ...b, kind: w.kind, label: w.kind === 'golden' ? 'Golden hour' : 'Blue hour' } : null;
  });
  const moon = moonUp(core)
    .map((s) => clip(s[0], s[1], span))
    .filter((b): b is Band => b !== null);
  const k = core.tonight?.night.moon.illuminated_fraction ?? null;
  const coreBands = (core.galactic?.windows ?? []).map((w) => {
    const b = clip(w.jd_start, w.jd_end, span);
    return b ? { ...b, moonUp: w.moon_up } : null;
  });
  const deep = moonlessDark(core)
    .map((s) => clip(s[0], s[1], span))
    .filter((b): b is Band => b !== null);

  const moments: Moment[] = [];
  for (const e of bodyEvents(core, 'Sun')?.events ?? []) {
    const words = SUN_WORDS[e.kind];
    if (!words || e.jd_utc < span[0] || e.jd_utc > span[1]) continue;
    moments.push({ jd: e.jd_utc, label: words[0], ...(words[1] ? { term: words[1] } : {}), lane: 'sky', key: `sun-${e.kind}` });
  }
  for (const w of core.sunHours?.windows ?? []) {
    if (w.kind !== 'golden') continue;
    if (w.period === 'evening' && !w.open_start && w.jd_start >= span[0]) moments.push({ jd: w.jd_start, label: 'Golden hour begins', lane: 'light', key: 'golden-start' });
    if (w.period === 'morning' && !w.open_end && w.jd_end <= span[1]) moments.push({ jd: w.jd_end, label: 'Golden hour ends', lane: 'light', key: 'golden-end' });
  }
  for (const e of bodyEvents(core, 'Moon')?.events ?? []) {
    if ((e.kind !== 'rise' && e.kind !== 'set') || e.jd_utc < span[0] || e.jd_utc > span[1]) continue;
    moments.push({ jd: e.jd_utc, label: e.kind === 'rise' ? 'Moonrise' : 'Moonset', lane: 'moon', key: `moon-${e.kind}-${e.jd_utc}` });
  }
  const g = core.galactic?.windows ?? [];
  const coreBy = galacticTurning(g);
  if (g.length) {
    const best = g.reduce((a, w) => (w.best.alt_deg > a.best.alt_deg ? w : a), g[0]!);
    moments.push({ jd: best.best.jd_utc, label: 'Milky Way core at its best', lane: 'core', key: 'core-best', chip: coreBy });
  }
  moments.sort((a, b) => a.jd - b.jd);

  const d = darknessOf(core);
  const parts: string[] = [];
  const { set, rise } = sunsetSunrise(core);
  // chip2: each time carries what sets it: the Sun's turning, the Moon's, or the faster of both.
  if (set !== null && rise !== null) parts.push(`Sunset ${clock(set, f, SUN_TURNING)}, sunrise ${clock(rise, f, SUN_TURNING)}.`);
  if (d) parts.push(`Darkest ${clock(d.start, f, SUN_TURNING)} to ${clock(d.end, f, SUN_TURNING)}.`);
  if (moon.length) parts.push(`The Moon up ${moon.map((b) => `${clock(b.start, f, MOON_TURNING)} to ${clock(b.end, f, MOON_TURNING)}`).join(' and ')}.`);
  if (deep.length) parts.push(`Moonless darkness ${deep.map((b) => `${clock(b.start, f, MOON_SUN_TURNING)} to ${clock(b.end, f, MOON_SUN_TURNING)}`).join(' and ')}.`);
  return {
    start: span[0],
    end: span[1],
    sky: sky.filter((b): b is Band & { phase: SkyPhase } => b !== null),
    light: light.filter((b): b is Band & { kind: SunLightWindow['kind']; label: string } => b !== null),
    moon,
    moonLabel: k === null ? 'Moon up' : `Moon up · ${percentLit(k)} lit`,
    core: coreBands.filter((b): b is Band & { moonUp: boolean } => b !== null),
    coreBy,
    deep,
    moments,
    ticks: hourTicks(span, f),
    summary: parts.join(' '),
  };
}

// -------------------------------------------------------------------------------------
// Drawing
// -------------------------------------------------------------------------------------

export interface TimelineView {
  el: HTMLElement;
  /** Draw a night (or a sentence when there is none). */
  draw(model: TimelineModel | null, f: Fmt, message?: string): void;
  /** Move the "now" marker (the explorer's time); hidden outside the span. */
  setNow(jd: number, f: Fmt): void;
  destroy(): void;
}

const LANES: readonly { lane: Lane; label: string }[] = [
  { lane: 'sky', label: 'Sky' },
  { lane: 'light', label: 'Light' },
  { lane: 'moon', label: 'Moon' },
  { lane: 'core', label: 'Milky Way' },
  { lane: 'deep', label: 'Faint objects' },
];

const PHASE_NAMES: Record<SkyPhase, string> = {
  day: 'Day',
  civil: 'Civil twilight',
  nautical: 'Nautical twilight',
  astronomical: 'Astronomical twilight',
  night: 'Night',
};

function pct(x: number, m: TimelineModel): string {
  return `${(((x - m.start) / (m.end - m.start)) * 100).toFixed(3)}%`;
}

function bandEl(b: Band, m: TimelineModel, cls: string, text: string, tip: string, attrs: Record<string, string> = {}): HTMLElement {
  const el = h('div', { class: `sft-tl__band ${cls}`, title: tip, ...attrs }, h('span', { class: 'sft-tl__bandtext' }, text));
  el.style.left = pct(b.start, m);
  el.style.width = `${(((b.end - b.start) / (m.end - m.start)) * 100).toFixed(3)}%`;
  return el;
}

/**
 * The timeline element. `onPick(jd)` is called with a clicked instant (rounded to the minute
 * by the caller if it wants).
 */
export function timelineView(onPick: (jd: number) => void): TimelineView {
  const plot = h('div', { class: 'sft-tl__plot' });
  const lanes = new Map<Lane, HTMLElement>();
  const labels = h('div', { class: 'sft-tl__labels', 'aria-hidden': 'true' });
  for (const { lane, label } of LANES) {
    const row = h('div', { class: 'sft-tl__lane', 'data-lane': lane });
    lanes.set(lane, row);
    plot.append(row);
    labels.append(h('div', { class: 'sft-tl__label', 'data-lane': lane }, label));
  }
  const now = h('div', { class: 'sft-tl__now', hidden: true }, h('span', { class: 'sft-tl__nowlabel' }));
  const hover = h('div', { class: 'sft-tl__hover', hidden: true }, h('span', { class: 'sft-tl__hoverlabel' }));
  plot.append(now, hover);
  const axis = h('div', { class: 'sft-tl__axis', 'aria-hidden': 'true' });
  const summary = h('p', { class: 'sft-sr' });
  const note = h('p', { class: 'sft-tl__note', hidden: true });
  const el = h(
    'div',
    { class: 'sft-tl', role: 'group', 'aria-label': 'The night from sunset to sunrise' },
    summary,
    h('div', { class: 'sft-tl__grid' }, labels, h('div', { class: 'sft-tl__main' }, plot, axis)),
    note,
  );
  let model: TimelineModel | null = null;
  let fmt: Fmt | null = null;

  const jdAt = (clientX: number): number | null => {
    if (!model) return null;
    const r = plot.getBoundingClientRect();
    if (r.width <= 0) return null;
    const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return model.start + x * (model.end - model.start);
  };
  const onClick = (e: MouseEvent): void => {
    const jd = jdAt(e.clientX);
    if (jd !== null) onPick(jd);
  };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || !model || !fmt) return;
    const jd = jdAt(e.clientX);
    if (jd === null) return;
    hover.hidden = false;
    hover.style.left = pct(jd, model);
    // A moment under the pointer, not an event: the clock alone (chip2).
    (hover.firstChild as HTMLElement).textContent = clockPlain(jd, fmt);
  };
  const onLeave = (): void => {
    hover.hidden = true;
  };
  plot.addEventListener('click', onClick);
  plot.addEventListener('pointermove', onMove);
  plot.addEventListener('pointerleave', onLeave);

  return {
    el,
    draw(m, f, message) {
      model = m;
      fmt = f;
      for (const lane of lanes.values()) lane.replaceChildren();
      axis.replaceChildren();
      note.hidden = !message;
      note.textContent = message ?? '';
      el.dataset.empty = m ? 'false' : 'true';
      if (!m) {
        summary.textContent = message ?? '';
        now.hidden = true;
        return;
      }
      summary.textContent = m.summary;
      const sky = lanes.get('sky')!;
      for (const b of m.sky) {
        sky.append(bandEl(b, m, `sft-tl__band--${b.phase}`, b.end - b.start > 0.03 ? PHASE_NAMES[b.phase] : '', `${PHASE_NAMES[b.phase]} ${clock(b.start, f, SUN_TURNING)}–${clock(b.end, f, SUN_TURNING)}`, { 'data-phase': b.phase }));
      }
      const light = lanes.get('light')!;
      for (const b of m.light) light.append(bandEl(b, m, `sft-tl__band--${b.kind}`, b.label, `${b.label} ${clock(b.start, f, SUN_TURNING)}–${clock(b.end, f, SUN_TURNING)} (${duration(b.end - b.start)})`));
      const moon = lanes.get('moon')!;
      for (const b of m.moon) moon.append(bandEl(b, m, 'sft-tl__band--moon', m.moonLabel, `${m.moonLabel}: ${clock(b.start, f, MOON_TURNING)}–${clock(b.end, f, MOON_TURNING)}`));
      if (!m.moon.length) moon.append(h('span', { class: 'sft-tl__empty' }, 'The Moon is down'));
      const core = lanes.get('core')!;
      for (const b of m.core) {
        core.append(bandEl(b, m, `sft-tl__band--core${b.moonUp ? ' is-moonlit' : ''}`, b.moonUp ? 'Core up, moonlit' : 'Core up', `The Milky Way’s core 10° or more up in darkness ${clock(b.start, f, m.coreBy)}–${clock(b.end, f, m.coreBy)}${b.moonUp ? ', with the Moon up' : ''}`));
      }
      if (!m.core.length) core.append(h('span', { class: 'sft-tl__empty' }, 'The core is not up in the dark'));
      const deep = lanes.get('deep')!;
      for (const b of m.deep) deep.append(bandEl(b, m, 'sft-tl__band--deep', 'Moonless dark', `Moonless darkness ${clock(b.start, f, MOON_SUN_TURNING)}–${clock(b.end, f, MOON_SUN_TURNING)} (${duration(b.end - b.start)}): best for faint objects`));
      if (!m.deep.length) deep.append(h('span', { class: 'sft-tl__empty' }, 'No moonless darkness'));
      for (const t of m.ticks) {
        const tick = h('span', { class: 'sft-tl__tick', 'data-odd': t.odd ? 'true' : 'false' }, t.label);
        tick.style.left = pct(t.jd, m);
        axis.append(tick);
      }
    },
    setNow(jd, f) {
      if (!model || jd < model.start || jd > model.end) {
        now.hidden = true;
        return;
      }
      now.hidden = false;
      now.style.left = pct(jd, model);
      const label = now.firstChild as HTMLElement;
      // The explorer's own time, not an event: the clock alone (its chip is on the time bar).
      const text = clockPlain(jd, f);
      if (label.textContent !== text) label.textContent = text;
      now.dataset.side = (jd - model.start) / (model.end - model.start) > 0.85 ? 'left' : 'right';
    },
    destroy() {
      plot.removeEventListener('click', onClick);
      plot.removeEventListener('pointermove', onMove);
      plot.removeEventListener('pointerleave', onLeave);
      el.remove();
    },
  };
}
