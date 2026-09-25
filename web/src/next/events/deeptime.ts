/**
 * Deep time in the Events view: the years the engine covers (instead of the old fixed
 * "1990 to 2060"), whether a list's times carry the Earth-rotation uncertainty, and the
 * data pack that would extend a list the coverage cut short. OWNER: events2 agent.
 *
 * Built on the time-ui agent's shared helpers (`web/src/next/time/`): `coverageBounds`,
 * `tierAt`, `timeInfoAt`, the ±ΔT chip, `formatYear`, `packForDate`. What is here is only
 * what the lists add: the coverage in words for a list's notes, one sentence for a list
 * whose times carry an uncertainty, and the note with a Get button under a cut-short list.
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import type { ExplorerEngine, TimeInfo } from '../engine/types.js';
import { msFromJd, wallClock, type Zone } from '../time.js';
import { calendarTag, calendarTip, chipNeeded, coverageBounds, formatYear, gregorianDateOfMs, packForDate, sigmaText, timeInfoAt } from '../time/index.js';

/** The Gregorian (wire) year of a UTC Julian date, astronomical numbering (the engine's years). */
export function wireYear(jd: number): number {
  return gregorianDateOfMs(msFromJd(jd)).year;
}

/** A year as the settings write it: `2026`, `585 BC`, `AD 79`. */
export function yearText(year: number): string {
  return formatYear(year);
}

/** `1990 to 2060`, `2000 BC to AD 3000`: the years the engine covers now. */
export function coverageYears(engine: ExplorerEngine): string {
  const c = coverageBounds(engine);
  if (!c) return 'the years this engine covers';
  const a = wireYear(c.start);
  const b = wireYear(c.end);
  return `${formatYear(a)} to ${formatYear(b, undefined, { era: a <= 0 ? 'always' : 'auto' })}`;
}

/** "Eclipses are computed for 1990 to 2060" and the like (`what` is plural), with the engine's own years. */
export function coveredSentence(engine: ExplorerEngine, what: string): string {
  return `${what} are computed for ${coverageYears(engine)}`;
}

/**
 * True when some time in a list between `start` and `end` needs its ±ΔT chip. The
 * uncertainty grows steadily away from the present on either side (CONVENTIONS 15.2), so
 * within a list's months or years the two ends speak for the rest: a list inside the
 * observed years asks `time_info` twice instead of once a row.
 */
export function chipsIn(engine: ExplorerEngine, start: number, end: number): boolean {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return chipNeeded(timeInfoAt(engine, start)) || chipNeeded(timeInfoAt(engine, end)) || chipNeeded(timeInfoAt(engine, (start + end) / 2));
}

/** `time_info` for a row, only when the list needs chips at all (see `chipsIn`). */
export function rowTimeInfo(engine: ExplorerEngine, jd: number, listNeedsChips: boolean): TimeInfo | null {
  return listNeedsChips ? timeInfoAt(engine, jd) : null;
}

/** One sentence for a list whose times carry an uncertainty; '' when none does. */
export function listUncertaintySentence(engine: ExplorerEngine, jds: readonly number[]): string {
  let worst: TimeInfo | null = null;
  let labelled = false;
  for (const jd of jds) {
    const info = timeInfoAt(engine, jd);
    if (!info || !chipNeeded(info)) continue;
    if (info.tier === 'labelled') labelled = true;
    if (!worst || info.delta_t_sigma_s > worst.delta_t_sigma_s) worst = info;
  }
  if (!worst) return '';
  return `${labelled ? 'Estimates outside the validated years: ' : ''}the Earth’s rotation at these dates is known only roughly, so each clock time carries the uncertainty shown beside it (up to ${sigmaText(worst.delta_t_sigma_s)}).`;
}

/**
 * What calendar a list's dates are in, when it is not the everyday one: the Julian calendar
 * before 15 October 1582 (or the proleptic Gregorian one there, when Settings asks for ISO
 * dates), in time-ui's words; '' when every date is an ordinary Gregorian one.
 */
export function calendarNote(jds: readonly number[], zone: Zone): string {
  for (const jd of jds) {
    if (!Number.isFinite(jd)) continue;
    const w = wallClock(jd, zone);
    if (calendarTag(w)) return calendarTip(w);
  }
  return '';
}

/**
 * A note under a list the coverage cut short: where it stops and, when a data pack would
 * extend it, a Get button (the "not saved on this device" state of the packs brief).
 * `edge` is an instant beyond which the list could not go.
 */
export function truncatedNote(ctx: Ctx, what: string, edge: number): HTMLElement {
  const note = h('div', { class: 'sfe-truncated' });
  note.append(h('p', { class: 'sfe-note' }, `${coveredSentence(ctx.engine, what)}; the list stops there.`));
  const pack = packForDate(ctx.packs, edge);
  if (pack) {
    const size = pack.bytes > 0 ? ` (${(pack.bytes / 1e6).toFixed(pack.bytes >= 1e7 ? 0 : 1)} MB)` : '';
    const get = h(
      'button',
      { type: 'button', class: 'sf-btn sf-btn--secondary sf-btn--sm sfe-getpack', 'data-tip': pack.description },
      `Get the ${pack.label} pack${size}`,
    );
    const status = h('span', { class: 'sfe-note', role: 'status', 'aria-live': 'polite' }, pack.saved ? '' : 'Not saved on this device.');
    get.addEventListener('click', () => {
      get.disabled = true;
      status.textContent = `Getting the ${pack.label} pack…`;
      // Loading a pack redraws every view (component.ts redrawEverything): the list grows by itself.
      ctx.packs
        .get(pack.name)
        .then((ok) => {
          status.textContent = ok ? `The ${pack.label} pack is saved on this device.` : `The ${pack.label} pack could not be got: see Settings → Data packs.`;
          get.disabled = false;
        })
        .catch(() => {
          status.textContent = `The ${pack.label} pack could not be got: see Settings → Data packs.`;
          get.disabled = false;
        });
    });
    note.append(h('p', { class: 'sfe-packline' }, get, status));
  }
  return note;
}
