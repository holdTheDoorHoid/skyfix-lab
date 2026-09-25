/**
 * Whether an instant is one Navigate offers sights for (CONVENTIONS 15.1): sights,
 * predicted readings and plans only in the **validated** tier, where the accuracy figures
 * hold; in the labelled tier (the core's estimates before 1550 and after 2650) the
 * view says why not, with the uncertainty of the Earth's rotation then; outside the engine's
 * coverage it says what the engine covers. OWNER: navigate2 agent.
 *
 * chip2 (CONVENTIONS 15.2, VERIFICATION_2 V18): a sight's time is read as UT, the Earth's own
 * clock, so the uncertain rotation does not move a fix by itself; it moves the bodies' places
 * at that time (the Moon's 0.55″ for each second of ΔT). The chip beside a sight's time is the
 * clock's (`CLOCK`); the caution names what it moves (`position('Moon')`).
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
import { arcminText, chipOf, CLOCK, dtChip, position, timeInfoAt, type DtChip } from '../time/chip.js';
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
  /** The engine's time information at the instant, or null. */
  info: TimeInfo | null;
  /** The clock's ± chip at the instant (σ(ΔT); chip2 `CLOCK`), for beside a sight's time. */
  clock: DtChip | null;
  /** How far the Moon's place moves with it then (chip2 `position`), for the far-future caution. */
  moonPlace: DtChip | null;
}

/** A sight's date in words, in the display calendar with its name before the reform: `28 May 585 BC (Julian)`. */
export function dateWords(jd: number): string {
  return formatCivilDate(jd, UTC_ZONE, 'day-month-year', { calendar: true });
}

/** The tier at `jd` and, outside the validated one, the sentence that says why no sights. */
export function sightTierAt(source: EngineSource, jd: number): SightTier {
  const tier = tierAt(source, jd);
  const info = timeInfoAt(source, jd);
  const sigma = info && Number.isFinite(info.delta_t_sigma_s) ? info.delta_t_sigma_s : null;
  const clock = chipOf(info, CLOCK);
  // The Moon's place only matters where sights are offered and the date is far (the caution).
  const moonPlace = tier === 'validated' && clock?.shown ? dtChip(source, jd, position('Moon'), info) : null;
  if (tier === 'validated') return { tier, offered: true, sentence: null, deltaTSigmaS: sigma, info, clock, moonPlace };
  const when = dateWords(jd);
  if (tier === 'labelled') {
    // verify2 (V18): the reason that stands is that positions then are estimates; the Earth's
    // rotation, known only roughly, is said beside it (a sight's own UT does not move with it).
    const rough = clock?.shown ? ` (${clock.text})` : '';
    return {
      tier,
      offered: false,
      sentence: `No sights for ${when}: positions then are estimates, and the Earth’s rotation is known only roughly${rough}. ${sightsOnlyText(source)}`,
      deltaTSigmaS: sigma,
      info,
      clock,
      moonPlace,
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
    clock,
    moonPlace,
  };
}

/**
 * A caution for the validated tier when the clock carries its ± chip (σ(ΔT) over 30 s: the far
 * future, CONVENTIONS 15.1-15.2). A sight's time is read as UT, the Earth's own clock, so the
 * uncertain rotation does not move the fix by itself; it moves the bodies' places at that
 * time, which the fix inherits: the Moon's by its angular speed × σ (chip2 `position`), the
 * Sun's and the planets' far less, the stars' not at all (verify2, V18). Null when no chip is due.
 */
export function rotationCaution(t: SightTier): string | null {
  if (!t.offered || !t.clock?.shown) return null;
  const moon = t.moonPlace?.value !== null && t.moonPlace?.value !== undefined ? `the Moon’s by about ${arcminText(t.moonPlace.value).slice(1)}` : 'the Moon’s most';
  return `The Earth’s rotation then is known only to ${t.clock.text} (ΔT). A sight’s time is read as UT, the Earth’s own clock, so that does not move the fix by itself; it moves the bodies’ places at that time: ${moon}, the Sun’s and the planets’ far less, the stars’ not at all.`;
}
