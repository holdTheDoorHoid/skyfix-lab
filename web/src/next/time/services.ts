/**
 * What the shell runs for deep time (time-ui agent): the display calendar and the year
 * style kept equal to the settings, the tier notice (a historical or far-future estimate,
 * or outside the years the core covers), and a pack asked for when the time leaves the
 * covered years and a pack the site offers would reach them (CONVENTIONS 15.1, 15.5; none
 * does today: both tiers are in the core).
 *
 * The notice changes only when the tier, the side of the validated band or the coverage
 * report does (the notice bar redraws on every change and is read aloud), so it names the
 * years, not the moment: the time bar shows the moment.
 */

import { watch, type Ctx } from '../component.js';
import { setCalendarMode } from './civil.js';
import { setYearStyle } from './format.js';
import { coverageBounds, packForDate, packReason, tierAt, tierNotice } from './tier.js';

/** The notice's key: one at a time (it replaces the shell's old coverage notice). */
export const TIER_NOTICE_KEY = 'coverage';

/** The tier of an instant, the side of the covered years it lies on, and the report's span. */
function tierKey(ctx: Ctx, jd: number): string {
  const tier = tierAt(ctx, jd);
  if (tier === 'validated') return 'validated';
  const b = coverageBounds(ctx);
  const side = b ? (jd < b.validatedStart ? 'before' : 'after') : jd < 2_451_545 ? 'before' : 'after';
  return `${tier}|${side}|${b ? `${b.startUtc}|${b.endUtc}` : ''}`;
}

export function startTimeServices(ctx: Ctx): () => void {
  const { store } = ctx;
  const stops: (() => void)[] = [];

  // The calendar and the year style are read by the formatting functions (time/civil.ts,
  // time/format.ts): set at once, and on every change before the next frame draws (every
  // `watch` then draws again: component.ts `displayForm`).
  setCalendarMode(store.get().settings.calendar);
  setYearStyle(store.get().settings.yearStyle);
  stops.push(store.select((s) => s.settings.calendar, setCalendarMode));
  stops.push(store.select((s) => s.settings.yearStyle, setYearStyle));

  // One prompt per crossing; the pack service itself remembers "Not now" for the page.
  let asked = '';
  const show = (): void => {
    const jd = store.get().time.jd_utc;
    const tier = tierAt(ctx, jd);
    const pack = tier === 'outside' ? packForDate(ctx.packs, jd) : null;
    const notice = tierNotice(ctx, jd, { dateText: 'The time shown', pack });
    if (!notice) {
      ctx.notices.dismissKey(TIER_NOTICE_KEY);
      asked = '';
      return;
    }
    // The same words again (a redraw for the clock's form, a pack loaded elsewhere) leave the
    // notice as it is, folded or not.
    const same = ctx.notices.list().some((n) => n.key === TIER_NOTICE_KEY && n.text === notice.text && n.level === notice.level);
    if (!same) ctx.notices.push(notice.level, notice.text, { key: TIER_NOTICE_KEY, persistent: notice.persistent });
    const want = pack ? `${pack.name}|${notice.side}` : '';
    if (pack && asked !== want) {
      asked = want;
      void ctx.packs.ensure(pack.name, packReason(jd, ctx, pack)).catch(() => false);
    }
  };
  // `${settings.yearStyle}` joins the key: the notice writes years ("2000 BC").
  stops.push(watch(ctx, (s) => `${tierKey(ctx, s.time.jd_utc)}|${s.settings.yearStyle}`, show));

  return () => {
    for (const stop of stops.splice(0)) stop();
  };
}
