/**
 * Coverage tiers for the interface (CONVENTIONS 15.1; EXPLORER_API "explorer_coverage() —
 * tiers"). OWNER: time-ui agent.
 *
 * - **validated** (1550-01-01 to 2650-01-22, the span of JPL DE440): the accuracy figures
 *   hold; sights are offered.
 * - **labelled** (2000 BC to AD 3000, with the Deep time pack): estimates, shown with the
 *   Earth-rotation uncertainty (time/chip.ts); no sights.
 * - **outside**: nothing is computed, and the page says why.
 *
 * `tierAt` asks the engine's own `tierAt` when it has one (deeptime agent), else works the
 * tier out from `explorer_coverage()` (its `validated_*` fields, or its whole span when it
 * reports no tiers), else the engine's `time_info(jd).tier`. Every helper takes a `Ctx` or
 * an engine, so views and plain functions can call it alike.
 */

import type { CoverageTier, ExplorerCoverage, ExplorerEngine, PackService, PackState } from '../engine/types.js';
import { isCoverageTierEngine, isTimeEngine } from '../engine/types.js';
import { jdFromIso, msFromJd } from '../time.js';
import { gregorianDateOfMs } from './civil.js';
import { formatYear, MONTHS_LONG } from './format.js';

/** An engine, or anything that carries one (a `Ctx`). */
export type EngineSource = ExplorerEngine | { readonly engine: ExplorerEngine };

export function engineOf(source: EngineSource): ExplorerEngine {
  const maybe = source as { engine?: unknown };
  return typeof maybe.engine === 'object' && maybe.engine !== null && 'coverage' in (maybe.engine as object)
    ? (maybe.engine as ExplorerEngine)
    : (source as ExplorerEngine);
}

/** The validated tier by contract (CONVENTIONS 15.1), for words when the engine reports no tiers. */
export const CONTRACT_VALIDATED_START_UTC = '1550-01-01T00:00:00Z';
export const CONTRACT_VALIDATED_END_UTC = '2650-01-22T00:00:00Z';

export interface CoverageBounds {
  /** The outermost instants the engine answers with the packs loaded now. */
  readonly start: number;
  readonly end: number;
  readonly startUtc: string;
  readonly endUtc: string;
  /** The validated tier: the whole span when the engine reports no tiers. */
  readonly validatedStart: number;
  readonly validatedEnd: number;
  readonly validatedStartUtc: string;
  readonly validatedEndUtc: string;
  /** The engine reports tiers (`validated_start_utc` and `validated_end_utc`). */
  readonly tiered: boolean;
  readonly packsLoaded: readonly string[];
}

const boundsCache = new WeakMap<object, CoverageBounds | null>();

function readBounds(c: ExplorerCoverage): CoverageBounds | null {
  const start = jdFromIso(c.start_utc);
  const end = jdFromIso(c.end_utc);
  if (start === null || end === null || !(end > start)) return null;
  const vs = c.validated_start_utc ? jdFromIso(c.validated_start_utc) : null;
  const ve = c.validated_end_utc ? jdFromIso(c.validated_end_utc) : null;
  const tiered = vs !== null && ve !== null && ve > vs;
  return {
    start,
    end,
    startUtc: c.start_utc,
    endUtc: c.end_utc,
    validatedStart: tiered ? vs : start,
    validatedEnd: tiered ? ve : end,
    validatedStartUtc: tiered ? c.validated_start_utc! : c.start_utc,
    validatedEndUtc: tiered ? c.validated_end_utc! : c.end_utc,
    tiered,
    packsLoaded: c.packs_loaded ?? [],
  };
}

/**
 * The engine's coverage as Julian dates, or null when it does not say. Worked out once per
 * coverage report (the memoised engine keeps one until a pack is loaded).
 */
export function coverageBounds(source: EngineSource): CoverageBounds | null {
  let c: ExplorerCoverage;
  try {
    c = engineOf(source).coverage();
  } catch {
    return null;
  }
  if (!c || typeof c !== 'object') return null;
  if (!boundsCache.has(c)) boundsCache.set(c, readBounds(c));
  return boundsCache.get(c) ?? null;
}

/** The coverage tier of an instant (CONVENTIONS 15.1). Cheap: it can be asked every frame. */
export function tierAt(source: EngineSource, jd: number): CoverageTier {
  if (!Number.isFinite(jd)) return 'outside';
  const engine = engineOf(source);
  if (isCoverageTierEngine(engine)) {
    try {
      return engine.tierAt(jd);
    } catch {
      // fall through to the coverage report
    }
  }
  const b = coverageBounds(engine);
  if (b) {
    if (jd < b.start || jd > b.end) return 'outside';
    return jd >= b.validatedStart && jd <= b.validatedEnd ? 'validated' : 'labelled';
  }
  if (isTimeEngine(engine)) {
    try {
      return engine.timeInfo(jd).tier;
    } catch {
      return 'outside';
    }
  }
  return 'validated';
}

/** Sights, predicted readings and the planner are offered only in the validated tier. */
export function sightsOffered(source: EngineSource, jd: number): boolean {
  return tierAt(source, jd) === 'validated';
}

// ---------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------

/** The Gregorian (wire) year of an instant. */
function wireYear(jd: number): number {
  return gregorianDateOfMs(msFromJd(jd)).year;
}

/** `1 January 1550`: a wire date (proleptic Gregorian, as the engine states its coverage). */
export function wireDateText(iso: string): string {
  const jd = jdFromIso(iso);
  if (jd === null) return iso;
  const d = gregorianDateOfMs(msFromJd(jd));
  return `${d.day} ${MONTHS_LONG[d.month - 1]} ${formatYear(d.year)}`;
}

/** The validated years in words: `1550 and 2650` (the contract's when the engine reports no tiers). */
export function validatedYears(source: EngineSource): { from: string; to: string } {
  const b = coverageBounds(source);
  const a = b?.tiered ? b.validatedStart : jdFromIso(CONTRACT_VALIDATED_START_UTC)!;
  const z = b?.tiered ? b.validatedEnd : jdFromIso(CONTRACT_VALIDATED_END_UTC)!;
  return { from: formatYear(wireYear(a)), to: formatYear(wireYear(z)) };
}

/**
 * What Navigate and the panel's sights say instead of results outside the validated tier:
 * "Sights are offered only between 1550 and 2650."
 */
export function sightsOnlyText(source: EngineSource): string {
  const { from, to } = validatedYears(source);
  return `Sights are offered only between ${from} and ${to}, the years whose positions are checked against JPL’s DE440 ephemeris.`;
}

/** A tier's name for a table or a badge. */
export function tierName(tier: CoverageTier): string {
  return tier === 'validated' ? 'Validated' : tier === 'labelled' ? 'Estimate' : 'Not covered';
}

export interface TierNotice {
  readonly level: 'info' | 'caution';
  readonly text: string;
  /** Stays on screen while the time is in this tier (the labelled band). */
  readonly persistent: boolean;
  /** What distinguishes this notice from another of the same tier (before or after the band). */
  readonly side: 'before' | 'after' | '';
}

/**
 * The sentence the page shows for a tier, or null inside the validated tier.
 *
 * - labelled: "Historical estimate: …" before the validated band, "Far-future estimate: …"
 *   after it, naming the pack that supplies it;
 * - outside: "… is outside the years the SkyFix Lab core covers (…), so nothing can be
 *   computed for it", naming the real bounds, and the pack that would extend them.
 */
export function tierNotice(
  source: EngineSource,
  jd: number,
  options: { dateText?: string; pack?: Pick<PackState, 'label'> | null } = {},
): TierNotice | null {
  const tier = tierAt(source, jd);
  if (tier === 'validated') return null;
  const b = coverageBounds(source);
  const { from, to } = validatedYears(source);
  if (tier === 'labelled') {
    const before = b ? jd < b.validatedStart : wireYear(jd) < 1550;
    const loaded = b?.packsLoaded.length ? ` from the ${packWords(b.packsLoaded)}` : '';
    const text = before
      ? `Historical estimate: before ${from} the positions${loaded} are estimates, checked against JPL’s long ephemeris DE441 but not to the accuracy of ${from} to ${to}, and every clock time carries the uncertainty in the Earth’s rotation shown beside it (±). Sights are offered only between ${from} and ${to}.`
      : `Far-future estimate: after ${to} the positions${loaded} are estimates, and the Earth’s rotation cannot be predicted exactly, so every clock time carries the uncertainty shown beside it (±). Sights are offered only between ${from} and ${to}.`;
    return { level: 'caution', text, persistent: true, side: before ? 'before' : 'after' };
  }
  const what = options.dateText ?? 'This date';
  const span = b ? `${wireDateText(b.startUtc)} to ${wireDateText(b.endUtc)}` : '';
  const pack = options.pack ? ` The ${options.pack.label} pack extends this: get it in Settings → Data packs.` : '';
  const text = span
    ? `${what} is outside the years the SkyFix Lab core covers (${span}, Gregorian calendar), so nothing can be computed for it. Choose a date in that range, or press Now.${pack}`
    : `${what} is outside the years the SkyFix Lab core covers, so nothing can be computed for it. Choose another date, or press Now.${pack}`;
  return { level: 'caution', text, persistent: false, side: b && jd < b.start ? 'before' : 'after' };
}

function packWords(names: readonly string[]): string {
  const words = names.map((n) => (n === 'deep-time' ? 'Deep time pack' : `${n} pack`));
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

// ---------------------------------------------------------------------------------
// The Deep time pack
// ---------------------------------------------------------------------------------

/** Years an entry of a pack's `provides` covers: `ephemeris:-2000..3000` -> [-2000, 3000]. */
export function providedYears(entry: string): [number, number] | null {
  const m = /^ephemeris:([+-]?\d+)\.\.([+-]?\d+)$/.exec(entry.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return Number.isInteger(a) && Number.isInteger(b) && b >= a ? [a, b] : null;
}

/**
 * A pack that would let the engine answer at `jd`: this build can install it, it is not
 * loaded yet, and it provides an ephemeris span holding the date's year. Null when none
 * (nothing to offer: the date is covered, or no pack reaches it, or packs are not in this
 * build). The deep-time pack is the one the contract plans.
 */
export function packForDate(packs: Pick<PackService, 'status'> | null | undefined, jd: number): PackState | null {
  if (!packs || !Number.isFinite(jd)) return null;
  let list: PackState[];
  try {
    list = packs.status();
  } catch {
    return null;
  }
  const year = wireYear(jd);
  for (const p of list) {
    if (p.loaded || !p.supported) continue;
    for (const entry of p.provides) {
      const span = providedYears(entry);
      if (span && year >= span[0] && year <= span[1]) return p;
    }
  }
  return null;
}

/** Why a view needs the pack, the sentence its prompt opens with. */
export function packReason(jd: number, source: EngineSource): string {
  const b = coverageBounds(source);
  const { from, to } = validatedYears(source);
  const before = b ? jd < b.start : wireYear(jd) < 1550;
  return before
    ? `Positions before ${from} need the Deep time pack, which extends the explorer back to ${formatYear(-1999)}.`
    : `Positions after ${to} need the Deep time pack, which extends the explorer to ${formatYear(3000, 'era', { era: 'always' })}.`;
}

