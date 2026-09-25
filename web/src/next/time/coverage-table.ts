/**
 * The coverage table of About / Help (time-ui agent; CONVENTIONS 15.1): for each group of
 * bodies, the years whose positions are validated against JPL's DE440 and the years shown
 * as estimates (both in the core since the deeptime merge), each with how closely it is checked; a banner
 * when the time shown lies outside the validated years; and how far a clock time can be
 * trusted in each age (the uncertainty in the Earth's rotation, ΔT), from the engine.
 *
 * The table reads `explorer_coverage()`: its groups' `tiers` when the engine reports them
 * (deeptime agent), else the one span it has, validated. The ΔT rows come from `time_info`
 * when the engine has time scales, else they are left out.
 */

import './time.css';
import { h } from '../../dom.js';
import { watch, type Ctx } from '../component.js';
import type { CoverageGroup, CoverageTierSpan, ExplorerCoverage, ExplorerEngine } from '../engine/types.js';
import { badge } from '../theme/primitives.js';
import { jdFromWallClock, UTC_ZONE } from '../time.js';
import { sigmaText, timeInfoAt } from './chip.js';
import { formatYear } from './format.js';
import { coverageBounds, engineOf, packForDate, tierAt, tierNotice, wireDateText, type EngineSource } from './tier.js';
import { TIER_NOTICE_KEY } from './services.js';

/** Years at which the ΔT uncertainty is listed (astronomical), from 2000 BC to AD 3000. */
export const SIGMA_YEARS: readonly number[] = [-1999, -999, -499, 1, 500, 1000, 1500, 1700, 1900, 2026, 2100, 2200, 2500, 3000];

export interface SigmaRow {
  year: number;
  /** Standard uncertainty of ΔT at 1 July of the year, seconds. */
  sigmaS: number;
}

/** The ΔT uncertainty through the ages, from the engine's model (empty without time scales). */
export function sigmaRows(source: EngineSource): SigmaRow[] {
  const out: SigmaRow[] = [];
  for (const year of SIGMA_YEARS) {
    const jd = jdFromWallClock({ year, month: 7, day: 1, calendar: year < 1583 ? 'julian' : 'gregorian' }, UTC_ZONE);
    const info = timeInfoAt(source, jd);
    if (info) out.push({ year, sigmaS: info.delta_t_sigma_s });
  }
  return out;
}

function span(t: Pick<CoverageTierSpan, 'start_utc' | 'end_utc'>): string {
  return `${wireDateText(t.start_utc)} to ${wireDateText(t.end_utc)}`;
}

function within(accuracy: number | null | undefined): string {
  return accuracy === null || accuracy === undefined || !Number.isFinite(accuracy) ? '—' : `${accuracy}′`;
}

/** A group's two tiers: what the engine reports, else its one span, validated. */
export function groupTiers(group: CoverageGroup, coverage: ExplorerCoverage): { validated: CoverageTierSpan | null; labelled: CoverageTierSpan | null } {
  const tiers = group.tiers ?? [];
  const validated =
    tiers.find((t) => t.tier === 'validated') ??
    (group.validated
      ? { tier: 'validated' as const, start_utc: coverage.validated_start_utc ?? coverage.start_utc, end_utc: coverage.validated_end_utc ?? coverage.end_utc, accuracy_arcmin: group.accuracy_arcmin }
      : null);
  const labelled = tiers.find((t) => t.tier === 'labelled') ?? null;
  return { validated, labelled };
}

/** The table, with its banner and the ΔT rows; it follows the time shown and loaded packs. */
export function coverageTable(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const el = h('div', { class: 'sf-coverage' });
  const banner = h('p', { class: 'sf-notice sf-notice--caution sf-coverage__banner', role: 'note', hidden: true });
  const tableHost = h('div', { class: 'sf-about__table' });
  const note = h('p', { class: 'sf-coverage__note' });
  const sigmaHost = h('div', { class: 'sf-about__table sf-coverage__sigma-wrap' });
  el.append(banner, tableHost, note, sigmaHost);

  const build = (engine: ExplorerEngine): void => {
    let coverage: ExplorerCoverage;
    try {
      coverage = engine.coverage();
    } catch (error) {
      tableHost.replaceChildren(h('p', {}, `The engine did not say: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const b = coverageBounds(engine);
    const pack = packForDate(ctx.packs, jdFromWallClock({ year: 1000, month: 1, day: 1, calendar: 'julian' }, UTC_ZONE));
    const rows = coverage.groups.map((g) => {
      const { validated, labelled } = groupTiers(g, coverage);
      return h(
        'tr',
        {},
        h('th', { scope: 'row' }, g.name),
        h('td', {}, g.provider),
        h(
          'td',
          {},
          validated ? h('span', { class: 'sf-coverage__span' }, span(validated)) : '—',
          validated ? h('br', {}) : null,
          validated ? `within ${within(validated.accuracy_arcmin)}` : null,
        ),
        labelled
          ? h('td', {}, h('span', { class: 'sf-coverage__span' }, span(labelled)), h('br', {}), `within ${within(labelled.accuracy_arcmin)}`)
          : h('td', { class: 'sf-muted' }, pack ? `With the ${pack.label} pack (Settings → Data packs)` : 'Not in this build'),
        h('td', {}, g.validated ? badge('real', { text: 'Validated' }) : badge('soon', { text: 'Not validated' })),
      );
    });
    tableHost.replaceChildren(
      h(
        'table',
        { class: 'sf-table' },
        h('caption', { class: 'sf-coverage__caption' }, 'The years each group of bodies is validated for, and the years shown as estimates'),
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col' }, 'Bodies'),
            h('th', { scope: 'col' }, 'Source'),
            h('th', { scope: 'col' }, 'Validated years'),
            h('th', { scope: 'col' }, 'Estimates'),
            h('th', { scope: 'col' }, 'Status'),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
    );
    note.textContent = b?.tiered
      ? 'Validated years are checked against JPL’s DE440 ephemeris; estimates outside them against its long companion DE441, per century (ACCURACY.md). Sights are offered only in the validated years.'
      : `This build answers ${span({ start_utc: coverage.start_utc, end_utc: coverage.end_utc })}, all of it validated against JPL’s ephemerides. Sights are offered only in validated years.`;
    const sigma = sigmaRows(engine);
    sigmaHost.replaceChildren(
      ...(sigma.length
        ? [
            h(
              'table',
              { class: 'sf-table sf-coverage__sigma' },
              h('caption', { class: 'sf-coverage__caption' }, 'How far a clock time can be trusted: the uncertainty in the Earth’s rotation (ΔT)'),
              h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Year'), h('th', { scope: 'col', class: 'sf-num-r' }, 'Clock times ±'))),
              h(
                'tbody',
                {},
                ...sigma.map((r) =>
                  h('tr', {}, h('th', { scope: 'row' }, formatYear(r.year, undefined, { era: r.year < 1000 ? 'always' : 'auto' })), h('td', { class: 'sf-num-r' }, r.sigmaS < 1 ? 'under 1 s' : sigmaText(r.sigmaS).slice(1))),
                ),
              ),
            ),
          ]
        : []),
    );
  };

  // The banner says what the shell's notice says (time/services.ts): shown only where that
  // notice is not on screen (a page without the shell), never the same sentence twice
  // (polish2: About showed the Historical-estimate notice twice).
  const showBanner = (): void => {
    const n = tierNotice(ctx, ctx.store.get().time.jd_utc, { dateText: 'The time shown' });
    const said = ctx.notices.list().some((x) => x.key === TIER_NOTICE_KEY);
    banner.hidden = !n || said;
    banner.textContent = n && !said ? n.text : '';
  };
  const stop = watch(
    ctx,
    (s) => `${tierAt(ctx, s.time.jd_utc)}|${s.settings.yearStyle}`,
    () => {
      const engine = engineOf(ctx);
      build(engine);
      showBanner();
    },
  );
  const stopNotices = ctx.notices.subscribe(() => showBanner());
  return {
    el,
    destroy() {
      stop();
      stopNotices();
      el.remove();
    },
  };
}
