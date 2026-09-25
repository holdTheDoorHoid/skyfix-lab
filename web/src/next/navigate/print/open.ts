/**
 * Opening Navigate's printables from the view: one sight's worksheet, or every sight of a
 * fix with the plotting sheet. The figures are the live reductions (the core's `reduce`) and
 * the fix the solve returned. OWNER: navigate2 agent (expansion programme).
 */

import type { FixResult, Observation, ReducedSight, Session } from '../../../types.js';
import { isTimeEngine, type ExplorerEngine } from '../../engine/types.js';
import { angleFormat, kindOf, type NavCtx } from '../context.js';
import { plottingSheet } from './plotting.js';
import { openPrintPreview } from './preview.js';
import { worksheetSheet, type WorksheetInput } from './worksheet.js';

/** The Earth's rotation, degrees of GHA per second of UT1 (360.9856° a day). */
const DEG_PER_UT1_SECOND = 360.985_647_366 / 86_400;

/**
 * GHA ♈ at a sight's instant for the worksheet's star lines, on the session's UT1, or null.
 * The explorer's sidereal time uses its own UT1 − UTC (the IERS history, or a value set for
 * the page); a session with its own `clock.dut1_s` has its directions on that one, so the
 * explorer's GHA ♈ is moved by the difference at the Earth's rotation rate (15.04″ a second).
 * GHA ♈ + SHA is then the star's GHA as the core gave it.
 */
export function ghaAriesFor(engine: ExplorerEngine, session: Session, sight: ReducedSight, isStar: boolean): number | null {
  if (!isStar || sight.direction_source === 'supplied') return null;
  try {
    const gha = engine.sidereal(sight.jd_utc).gha_aries_deg;
    const own = session.clock.dut1_s;
    if (typeof own !== 'number') return gha;
    if (!isTimeEngine(engine)) return null;
    const explorer = engine.timeInfo(sight.jd_utc).dut1_s;
    return gha + (own - explorer) * DEG_PER_UT1_SECOND;
  } catch {
    return null;
  }
}

function inputFor(nc: NavCtx, session: Session, obs: Observation, sight: ReducedSight): WorksheetInput {
  return { session, obs, sight, ghaAriesDeg: ghaAriesFor(nc.ctx.engine, session, sight, kindOf(nc, sight.body) === 'star'), format: angleFormat(nc) };
}

/** The reduced sights of these observations, from the live reductions (those the core could reduce). */
export function reducedOf(nc: NavCtx, observations: readonly Observation[]): { obs: Observation; sight: ReducedSight }[] {
  const byId = nc.reductions.get().byId;
  const out: { obs: Observation; sight: ReducedSight }[] = [];
  for (const obs of observations) {
    const e = byId.get(obs.id);
    if (e?.status === 'ok') out.push({ obs, sight: e.sight });
  }
  return out;
}

/** One sight's worksheet. */
export function openSightWorksheet(nc: NavCtx, obs: Observation, sight: ReducedSight): void {
  const session = nc.working.store.get().session;
  openPrintPreview(`Worksheet: ${sight.body}, ${sight.id}`, [worksheetSheet(inputFor(nc, session, obs, sight))]);
}

/** The plotting sheet and a worksheet for every sight of a fix. */
export function openFixPrintables(nc: NavCtx, session: Session, result: FixResult | null): void {
  const pairs = reducedOf(nc, session.observations);
  const fix = result && result.kind === 'unique' ? result.fix.position : null;
  const pages = [
    plottingSheet({ session, sights: pairs.map((p) => p.sight), fix, fixLabel: 'Fix', format: angleFormat(nc) }),
    ...pairs.map((p) => worksheetSheet(inputFor(nc, session, p.obs, p.sight))),
  ];
  openPrintPreview('Plotting sheet and worksheets', pages, `The plotting sheet and ${pairs.length} worksheet${pairs.length === 1 ? '' : 's'}; they print black on white, one to a page.`);
}
