/**
 * Whether an instant is one Navigate offers sights for (CONVENTIONS 15.1): sights,
 * predicted readings and plans only in the **validated** tier, where the accuracy figures
 * hold; in the labelled tier (the core's estimates before 1550 and after 2650) the
 * view says why not, with the uncertainty of the Earth's rotation that makes it so; outside
 * the engine's coverage it says what the engine covers. OWNER: navigate2 agent.
 *
 * Built on the shared helpers of web/src/next/time/ (time-ui agent): the tier is `tierAt`
 * (so Navigate, the time bar and the notices always agree), σ(ΔT) comes from the cached
 * `timeInfoAt`, the date is written through the display calendar (`formatCivilDate`: Julian
 * before 1582-10-15, years BC as the settings write them), and the closing words are the
 * shared `sightsOnlyText`. That sentence names the validated years the engine reports; a build
 * whose engine reports no tiers (every year it covers is validated) is told by the years it
 * covers instead, since the shared sentence would then fall back to the contract's years.
 */

import type { CoverageTier, TimeInfo } from '../engine/types.js';
import { UTC_ZONE } from '../time.js';
import { chipNeeded, sigmaText, timeInfoAt } from '../time/chip.js';
import { formatCivilDate } from '../time/format.js';
import { coverageBounds, sightsOnlyText, tierAt, wireDateText, type EngineSource } from '../time/tier.js';

export interface SightTier {
  tier: CoverageTier;
  /** True only in the validated tier. */
  offered: boolean;
  /** Why sights are not offered (null when they are). */
  sentence: string | null;
  /** The Earth-rotation (ΔT) standard uncertainty then, seconds, when the engine says. */
  deltaTSigmaS: number | null;
  /** The engine's time information at the instant (for the ±ΔT chip), or null. */
  info: TimeInfo | null;
}

/** A sight's date in words, in the display calendar with its name before the reform: `28 May 585 BC (Julian)`. */
export function dateWords(jd: number): string {
  return formatCivilDate(jd, UTC_ZONE, 'day-month-year', { calendar: true });
}

/** Arcminutes of longitude for a σ of the Earth's rotation, as words: `45.1° of longitude`, `7.5′ of longitude`. */
function longitudeWords(sigmaS: number): string {
  const arcmin = (sigmaS * 15.041) / 60;
  return arcmin >= 120 ? `${(arcmin / 60).toFixed(1)}° of longitude` : `${arcmin.toFixed(1)}′ of longitude`;
}

/** The tier at `jd` and, outside the validated one, the sentence that says why no sights. */
export function sightTierAt(source: EngineSource, jd: number): SightTier {
  const tier = tierAt(source, jd);
  const info = timeInfoAt(source, jd);
  const sigma = info && Number.isFinite(info.delta_t_sigma_s) ? info.delta_t_sigma_s : null;
  if (tier === 'validated') return { tier, offered: true, sentence: null, deltaTSigmaS: sigma, info };
  const when = dateWords(jd);
  if (tier === 'labelled') {
    const lon = sigma !== null ? ` (${sigmaText(sigma)} of time, ${longitudeWords(sigma)})` : '';
    return {
      tier,
      offered: false,
      sentence: `No sights for ${when}: positions then are estimates, because the Earth’s rotation is known only roughly${lon}. ${sightsOnlyText(source)}`,
      deltaTSigmaS: sigma,
      info,
    };
  }
  const b = coverageBounds(source);
  // The span as the shared notice writes it (time/tier.ts `tierNotice`): the wire's calendar, named.
  const span = b ? ` (${wireDateText(b.startUtc)} to ${wireDateText(b.endUtc)}, Gregorian calendar)` : '';
  return {
    tier,
    offered: false,
    sentence: `No sights for ${when}: it is outside the years the SkyFix Lab core covers${span}, so nothing can be computed for it.${b?.tiered ? ` ${sightsOnlyText(source)}` : ''}`,
    deltaTSigmaS: sigma,
    info,
  };
}

/**
 * A caution for the validated tier when clock times there carry the ±ΔT chip (σ over 30 s:
 * the far future, CONVENTIONS 15.1): the bodies' places are right, but every sight's clock
 * time, and so every fix's longitude, inherits the Earth's rotation's uncertainty (15″ of
 * longitude a second). Null when no chip is due.
 */
export function rotationCaution(t: SightTier): string | null {
  if (!t.offered || t.deltaTSigmaS === null || !chipNeeded(t.info)) return null;
  const lon = longitudeWords(t.deltaTSigmaS).replace(' of longitude', '');
  return `The Earth’s rotation then is known only to ${sigmaText(t.deltaTSigmaS)} (ΔT), so every fix’s longitude is uncertain by ±${lon}. The bodies’ places are not affected.`;
}
