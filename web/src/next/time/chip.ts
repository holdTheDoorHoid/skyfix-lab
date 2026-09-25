/**
 * The ±ΔT chip: how far a clock time can be trusted when the Earth's rotation at that
 * date is known only roughly (CONVENTIONS 15.1-15.2). OWNER: time-ui agent.
 *
 * The engine's time scale TT runs evenly; the clock (UT) follows the Earth's rotation,
 * which is measured only since the 1600s and predicted only roughly. ΔT = TT − UT carries
 * a standard uncertainty (`time_info.delta_t_sigma_s`): 15 s in AD 1000, 3 min in 585 BC,
 * an hour at 2000 BC, 10 s in 2060, 15 min in 2650. Positions on the sky are not affected;
 * every clock time of an event at a place, and every eclipse path, is.
 *
 * Rule for every view: beside any time shown, render the chip. It shows itself when σ
 * exceeds 30 s (half the display precision of a time to the minute), and always in the
 * labelled tier, so a labelled-tier time never appears without it. Everything else hides.
 *
 * ```ts
 * import { timeInfoAt, uncertaintyChip, setUncertaintyChip } from '../time/index.js';
 * const chip = uncertaintyChip(timeInfoAt(ctx, jd));   // once
 * setUncertaintyChip(chip, timeInfoAt(ctx, jd));        // on every redraw
 * ```
 */

import { h } from '../../dom.js';
import type { ExplorerEngine, TimeInfo } from '../engine/types.js';
import { isTimeEngine } from '../engine/types.js';
import { engineOf, type EngineSource } from './tier.js';

/** Above this many seconds of σ(ΔT) a time to the minute carries its chip. */
export const CHIP_THRESHOLD_S = 30;

/** The σ and tier a chip needs (a whole `TimeInfo` will do). */
export type ChipInfo = Pick<TimeInfo, 'delta_t_sigma_s' | 'tier'> & Partial<Pick<TimeInfo, 'jd_utc' | 'scale'>>;

/** True when a time at this instant must be shown with its uncertainty. */
export function chipNeeded(info: ChipInfo | null | undefined): boolean {
  if (!info || !Number.isFinite(info.delta_t_sigma_s)) return false;
  return info.tier === 'labelled' || info.delta_t_sigma_s > CHIP_THRESHOLD_S;
}

/**
 * A standard uncertainty in words, rounded the way it is meant: `±45 s`, `±12 min`, `±1.5 h`,
 * `±2 h`. Seconds below 90 s, minutes below an hour, hours (one decimal below ten) above.
 */
export function sigmaText(sigmaS: number): string {
  if (!Number.isFinite(sigmaS) || sigmaS < 0) return '';
  if (sigmaS < 89.5) return `±${Math.max(1, Math.round(sigmaS))} s`;
  if (sigmaS < 59.5 * 60) return `±${Math.round(sigmaS / 60)} min`;
  const hours = sigmaS / 3600;
  const text = hours < 9.95 ? hours.toFixed(1).replace(/\.0$/, '') : String(Math.round(hours));
  return `±${text} h`;
}

/** The chip's text for an instant, or '' when none is needed: for tables, CSV and aria labels. */
export function uncertaintyText(info: ChipInfo | null | undefined): string {
  return chipNeeded(info) ? sigmaText(info!.delta_t_sigma_s) : '';
}

/** `18:40 ±12 min`, or the time alone when no chip is needed. */
export function withUncertainty(timeText: string, info: ChipInfo | null | undefined): string {
  const u = uncertaintyText(info);
  return u ? `${timeText} ${u}` : timeText;
}

/** The chip's tooltip: what the number means, in plain words. */
export function uncertaintyTip(info: ChipInfo | null | undefined): string {
  if (!info) return '';
  const s = sigmaText(info.delta_t_sigma_s).slice(1);
  const band = info.tier === 'labelled' ? ' These years are an estimate outside the validated span.' : '';
  return `The Earth’s rotation at this date is known only to ±${s} (ΔT, the difference between the Earth’s clock and an even one), so every clock time here carries that uncertainty. Positions on the sky are not affected; local times of rising and setting, eclipse contacts and eclipse paths are.${band}`;
}

/**
 * The chip itself: a small `±12 min` label with its tooltip, hidden when no chip is needed.
 * Append it once beside a time and keep it current with `setUncertaintyChip`.
 */
export function uncertaintyChip(info: ChipInfo | null | undefined): HTMLElement {
  const el = h('span', { class: 'sf-dt-chip', tabindex: 0, hidden: true });
  setUncertaintyChip(el, info);
  return el;
}

/** Bring a chip up to date (cheap: it writes only what changed). */
export function setUncertaintyChip(el: HTMLElement, info: ChipInfo | null | undefined): void {
  const needed = chipNeeded(info);
  if (el.hidden === needed) el.hidden = !needed;
  if (!needed) return;
  const text = sigmaText(info!.delta_t_sigma_s);
  if (el.textContent !== text) el.textContent = text;
  const tip = uncertaintyTip(info);
  if (el.dataset.tip !== tip) el.dataset.tip = tip;
  const label = `Uncertain by ${text.slice(1)}: ${tip}`;
  if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
  el.dataset.tier = info!.tier;
}

// ---------------------------------------------------------------------------------
// time_info, asked cheaply
// ---------------------------------------------------------------------------------

const recent = new WeakMap<object, { coverage: unknown; map: Map<number, TimeInfo> }>();
const RECENT_MAX = 64;

/**
 * `time_info` for an instant, or null when the engine has no time scales (the mock and
 * older modules still work). Remembered for the last few dozen instants per engine, so a
 * frame that shows the same time in several places asks once, and forgotten when the
 * engine's coverage report changes (a data pack was loaded: the tiers moved). About 0.1 ms
 * in WebAssembly.
 */
export function timeInfoAt(source: EngineSource, jd: number): TimeInfo | null {
  if (!Number.isFinite(jd)) return null;
  const engine: ExplorerEngine = engineOf(source);
  if (!isTimeEngine(engine)) return null;
  let coverage: unknown = null;
  try {
    coverage = engine.coverage();
  } catch {
    coverage = null;
  }
  let entry = recent.get(engine);
  if (!entry || entry.coverage !== coverage) recent.set(engine, (entry = { coverage, map: new Map() }));
  const map = entry.map;
  const hit = map.get(jd);
  if (hit) return hit;
  let info: TimeInfo;
  try {
    info = engine.timeInfo(jd);
  } catch {
    return null;
  }
  if (map.size >= RECENT_MAX) map.delete(map.keys().next().value as number);
  map.set(jd, info);
  return info;
}

/**
 * The uncertainty that applies to a whole day or night (a list of rise and set times, a
 * table row): σ changes by well under a second a day, so the day's middle speaks for it.
 */
export function timeInfoForSpan(source: EngineSource, jdStart: number, jdEnd: number): TimeInfo | null {
  return timeInfoAt(source, Math.round(((jdStart + jdEnd) / 2) * 1440) / 1440);
}
