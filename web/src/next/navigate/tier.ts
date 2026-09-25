/**
 * Whether an instant is one Navigate offers sights for (CONVENTIONS 15.1): sights,
 * predicted readings and plans only in the **validated** tier, where the accuracy figures
 * hold; in the labelled tier (the deep-time pack's 2000 BC to 1549 and 2651 to AD 3000) the
 * view says why not, with the uncertainty of the Earth's rotation that makes it so; outside
 * the engine's coverage it says what the engine covers. OWNER: navigate2 agent.
 *
 * The tier comes from the engine's `time_info` (timescales agent); a build without it falls
 * back to the coverage span. time-ui: the shared `tierAt` helper and its chip replace
 * `sightTierAt`'s lookup here once web/src/next/time/ is on main.
 */

import { isTimeEngine, type CoverageTier, type ExplorerEngine, type TimeInfo } from '../engine/types.js';
import { formatDate, jdFromIso, UTC_ZONE } from '../time.js';

export interface SightTier {
  tier: CoverageTier;
  /** True only in the validated tier. */
  offered: boolean;
  /** Why sights are not offered (null when they are). */
  sentence: string | null;
  /** The Earth-rotation (ΔT) standard uncertainty then, seconds, when the engine says. */
  deltaTSigmaS: number | null;
}

function year(utc: string | undefined): string | null {
  if (!utc) return null;
  const jd = jdFromIso(utc);
  if (jd !== null) return formatDate(jd, UTC_ZONE).slice(0, 4).replace(/^-/, '−');
  const m = /^([+-]?\d{4,})-/.exec(utc);
  return m ? m[1]!.replace(/^\+/, '') : null;
}

/** The validated span as the engine reports it ("1550 to 2650"), or its whole coverage. */
export function validatedSpan(engine: ExplorerEngine): string {
  try {
    const c = engine.coverage();
    const a = year(c.validated_start_utc ?? c.start_utc);
    const b = year(c.validated_end_utc ?? c.end_utc);
    return a && b ? `${a} to ${b}` : 'the validated span';
  } catch {
    return 'the validated span';
  }
}

/** A duration for the sentence: ±12 s, ±3 min, ±1.5 h. */
function sigmaWords(s: number): string {
  if (s < 90) return `±${Math.round(s)} s`;
  if (s < 5400) return `±${Math.round(s / 60)} min`;
  return `±${(s / 3600).toFixed(1)} h`;
}

/**
 * A date in words that is right for any year: from the engine's civil date (Julian before
 * 1582-10-15, years BC as such) when it gives one, else the ISO date. time-ui: its calendar
 * formatter replaces this once web/src/next/time/ is on main.
 */
export function dateWords(info: TimeInfo | null, jd: number): string {
  if (!info) return formatDate(jd, UTC_ZONE);
  const c = info.civil;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][c.month - 1] ?? String(c.month);
  return `${c.day} ${month} ${c.era_year}${c.era === 'BC' ? ' BC' : ''}${c.calendar === 'julian' ? ' (Julian)' : ''}`;
}

/** The tier at `jd` and, outside the validated one, the sentence that says why no sights. */
export function sightTierAt(engine: ExplorerEngine, jd: number): SightTier {
  let tier: CoverageTier = 'validated';
  let sigma: number | null = null;
  let info: TimeInfo | null = null;
  if (isTimeEngine(engine)) {
    try {
      info = engine.timeInfo(jd);
      tier = info.tier;
      sigma = info.delta_t_sigma_s;
    } catch {
      tier = 'outside';
    }
  } else {
    try {
      const c = engine.coverage();
      const a = jdFromIso(c.start_utc);
      const b = jdFromIso(c.end_utc);
      tier = a !== null && b !== null && (jd < a || jd > b) ? 'outside' : 'validated';
    } catch {
      tier = 'validated';
    }
  }
  if (tier === 'validated') return { tier, offered: true, sentence: null, deltaTSigmaS: sigma };
  const when = dateWords(info, jd);
  const span = validatedSpan(engine);
  if (tier === 'labelled') {
    const arcmin = sigma !== null ? (sigma * 15.041) / 60 : 0;
    const lonText = arcmin >= 120 ? `${(arcmin / 60).toFixed(1)}° of longitude` : `${arcmin.toFixed(1)}′ of longitude`;
    const lon = sigma !== null ? ` (${sigmaWords(sigma)} of time, ${lonText})` : '';
    return {
      tier,
      offered: false,
      sentence:
        `No sights for ${when}: positions then are labelled estimates, because the Earth’s rotation is known only roughly${lon}. ` +
        `Sights, predicted readings and plans are offered only from ${span}, where the accuracy figures hold.`,
      deltaTSigmaS: sigma,
    };
  }
  return {
    tier,
    offered: false,
    sentence: `No sights for ${when}: this build’s almanac places the Sun, the Moon, the planets and the stars from ${span} only.`,
    deltaTSigmaS: sigma,
  };
}
