/**
 * Deep time for every view (EXPANSION_PLAN Q1; CONVENTIONS 15). OWNER: time-ui agent.
 *
 * - `civil.ts`   calendar arithmetic: Julian before 1582-10-15, Gregorian after (or
 *                proleptic Gregorian, the ISO setting); day numbers, weekdays, month and
 *                year lengths, stepping across the 1582 reform.
 * - `format.ts`  the calendar formatter: `formatYear` (585 BC, −584, -0584), dates in the
 *                display calendar, the calendar's name and tag, `parseYear`.
 * - `scale.ts`   the clock's scale (`scaleLabel`: UTC in 1972-2035, UT outside), local
 *                mean time.
 * - `tier.ts`    `tierAt` (validated / labelled / outside), the coverage bounds, the
 *                notices' sentences, the pack a date needs (none ships today).
 * - `chip.ts`    the ±ΔT chip (`uncertaintyChip`, `setUncertaintyChip`,
 *                `uncertaintyText`) and a cheap `timeInfoAt`.
 * - `zones.ts`   words about a zone: `lmtReason` (local mean time before 1850) and
 *                `zoneTooltip` (with the tz database's caution before 1970).
 *
 * Rules for views (brief2-wave2-common): show every time through the display calendar
 * (`wallClock`, `formatCivilDate`); put the chip beside any time shown; never offer sights
 * outside the validated tier (`sightsOffered`, `sightsOnlyText`); call
 * `ctx.packs.ensure(pack.name, packReason(jd, ctx, pack))` before asking the engine for a
 * date only a pack covers (`packForDate`; since the deeptime merge no pack does).
 */

import './time.css';

export * from './civil.js';
export * from './format.js';
export * from './scale.js';
export * from './tier.js';
export * from './chip.js';
export * from './zones.js';
