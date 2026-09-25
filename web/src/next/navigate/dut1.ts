/**
 * What "automatic" UT1 − UTC means for a session, in words (CONVENTIONS 6 and 15.2): the
 * core builds a session's providers once, at its earliest sight, with the session's
 * `clock.dut1_s` when given and otherwise the engine's own value (`time_info`): the IERS
 * history, IERS Bulletin A's prediction, 0 assumed with ±0.9 s, or no DUT1 at all on the UT
 * scale (after 2035 and before 1972, where the clock is UT1 itself). OWNER: navigate2 agent.
 */

import type { ExplorerEngine, TimeInfo } from '../engine/types.js';
import { isTimeEngine } from '../engine/types.js';
import { jdFromIso } from '../time.js';
import type { Session } from '../../types.js';

export interface Dut1Line {
  level: 'note' | 'caution';
  text: string;
}

/** Arcminutes of longitude per second of UT1: 15.04″ a second, 0.2507′. */
export const ARCMIN_PER_SECOND = 15.041_07 / 60;

const s3 = (v: number): string => `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v).toFixed(3)} s`;

/** The instant the core takes DUT1 at: the earliest sight, or `fallbackJd` with none. */
export function dut1Instant(session: Session, fallbackJd: number): { jd: number; from: 'sights' | 'time bar' } {
  let best: number | null = null;
  for (const o of session.observations) {
    const jd = jdFromIso(o.utc);
    if (jd !== null && (best === null || jd < best)) best = jd;
  }
  return best === null ? { jd: fallbackJd, from: 'time bar' } : { jd: best, from: 'sights' };
}

/** The engine's time information, or null when this build has none (older package). */
export function timeInfoAt(engine: ExplorerEngine, jd: number): TimeInfo | null {
  if (!isTimeEngine(engine)) return null;
  try {
    return engine.timeInfo(jd);
  } catch {
    return null;
  }
}

/**
 * The sentence under the DUT1 field. `typed` is the session's value (null: automatic);
 * `info` the engine's time information at the session's instant; `when` a date in words.
 */
export function dut1Line(typed: number | null, info: TimeInfo | null, when: string): Dut1Line {
  const longitude = (sigma: number): string => `${(sigma * ARCMIN_PER_SECOND).toFixed(2)}′ of longitude`;
  if (typed !== null) {
    if (info?.scale === 'ut') {
      return {
        level: 'caution',
        text: `On ${when} the app’s clock is UT (UT1) itself, not UTC, so UT1 − UTC does not apply: the ${s3(typed)} typed here is not used. Leave it blank.`,
      };
    }
    return {
      level: 'note',
      text: `Every Greenwich hour angle uses UT1 = UTC ${typed < 0 ? '−' : '+'} ${Math.abs(typed)} s, from your time signal (±0.05 s). Leave blank for automatic.`,
    };
  }
  if (!info) return { level: 'note', text: 'Blank: automatic, the engine’s own value (this build of the core cannot say which).' };
  switch (info.dut1_source) {
    case 'iers':
      return info.dut1_sigma_s <= 0.002
        ? { level: 'note', text: `Automatic: ${s3(info.dut1_s)} on ${when}, from the IERS history (±${info.dut1_sigma_s.toFixed(3)} s). Type your time signal’s DUT1 only to override it.` }
        : {
            level: 'note',
            text: `Automatic: ${s3(info.dut1_s)} on ${when}, IERS Bulletin A’s prediction (±${info.dut1_sigma_s.toFixed(2)} s, ${longitude(info.dut1_sigma_s)}). Your time signal’s DUT1, typed here, is better.`,
          };
    case 'assumed':
      return {
        level: 'caution',
        text: `Automatic: assumed 0 s ±${info.dut1_sigma_s.toFixed(1)} s. UT1 − UTC is not known for ${when}, which leaves up to ±${longitude(info.dut1_sigma_s)} in every sight. Type the DUT1 your time signal gives to remove it.`,
      };
    case 'model':
      return { level: 'note', text: `On ${when} the app’s clock is UT (UT1) itself: DUT1 is 0 by definition and nothing needs typing here.` };
    case 'user':
      return { level: 'note', text: `Automatic: ${s3(info.dut1_s)}, the explorer-wide value set for this page (±${info.dut1_sigma_s.toFixed(2)} s).` };
  }
}
