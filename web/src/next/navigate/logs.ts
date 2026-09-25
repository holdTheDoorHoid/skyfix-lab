/**
 * The session's two error logs (CONVENTIONS section 10, sailings agent's schema): the
 * index-error log (`instrument.index_error_log`, the index correction in arcminutes,
 * ADDED to a reading) and the watch log (`clock.watch_log`, the correction in seconds ADDED
 * to the watch). Pure functions over a session; the core reads the logs at each sight's time
 * (interpolated, or the nearest entry held outside the log's span, never extrapolated) and
 * says which value it used (`ReducedSight.index_correction_from_log`,
 * `clock_correction_from_log`). OWNER: navigate2 agent (expansion programme).
 *
 * Rules the core enforces, kept here so a bad entry is refused at the field and never
 * reaches it: RFC 3339 `Z` times, finite values, distinct instants. Entries are kept in
 * time order, and a log with no entries is removed from the session, so an older file and
 * its outputs stay byte-identical.
 */

import type { IndexErrorLogEntry, Session, WatchLogEntry } from '../../types.js';
import { jdFromIso } from '../time.js';
import type { Parsed } from './parse.js';

export type LogKind = 'index' | 'watch';

/** One entry of either log, as the table shows it (`value`: arcminutes or seconds). */
export interface LogRow {
  utc: string;
  value: number;
  note: string;
}

/** The limits a value may take: an index correction within a degree, a watch within a day. */
export const LOG_LIMITS: Record<LogKind, { max: number; unit: string; what: string }> = {
  index: { max: 60, unit: '′', what: 'The index correction' },
  watch: { max: 86_400, unit: 's', what: 'The watch correction' },
};

/** The log's entries in time order, as rows. */
export function logRows(session: Session, kind: LogKind): LogRow[] {
  const rows: LogRow[] =
    kind === 'index'
      ? (session.instrument.index_error_log ?? []).map((e) => ({ utc: e.utc, value: e.ic_arcmin, note: e.note ?? '' }))
      : (session.clock.watch_log ?? []).map((e) => ({ utc: e.utc, value: e.correction_s, note: e.note ?? '' }));
  return sortRows(rows);
}

function sortRows(rows: LogRow[]): LogRow[] {
  return [...rows].sort((a, b) => (jdFromIso(a.utc) ?? 0) - (jdFromIso(b.utc) ?? 0));
}

/** Whether two RFC 3339 instants are the same instant (the core refuses two entries at one). */
function sameInstant(a: string, b: string): boolean {
  const ja = jdFromIso(a);
  const jb = jdFromIso(b);
  return ja !== null && jb !== null && Math.abs(ja - jb) * 86_400 < 1e-3;
}

function withRows(session: Session, kind: LogKind, rows: LogRow[]): Session {
  const sorted = sortRows(rows);
  if (kind === 'index') {
    const instrument = { ...session.instrument };
    delete instrument.index_error_log;
    const log: IndexErrorLogEntry[] = sorted.map((r) => ({ utc: r.utc, ic_arcmin: r.value, note: r.note }));
    return { ...session, instrument: log.length ? { ...instrument, index_error_log: log } : instrument };
  }
  const clock = { ...session.clock };
  delete clock.watch_log;
  const log: WatchLogEntry[] = sorted.map((r) => ({ utc: r.utc, correction_s: r.value, note: r.note }));
  return { ...session, clock: log.length ? { ...clock, watch_log: log } : clock };
}

/** Check an entry before it goes in: a sentence when it is not usable. */
export function checkLogRow(kind: LogKind, row: LogRow): Parsed<LogRow> {
  const limits = LOG_LIMITS[kind];
  if (jdFromIso(row.utc) === null) return { ok: false, error: `${row.utc} is not a UTC time (for example 2026-10-01 01:30:00).` };
  if (!Number.isFinite(row.value)) return { ok: false, error: `${limits.what} must be a number.` };
  if (Math.abs(row.value) > limits.max) return { ok: false, error: `${limits.what} must be within ±${limits.max} ${limits.unit}.` };
  return { ok: true, value: { utc: row.utc, value: row.value, note: row.note.trim() } };
}

/**
 * Add an entry, or replace the one at the same instant (a log holds one value per instant).
 * Returns the new session and whether an entry was replaced.
 */
export function withLogRow(session: Session, kind: LogKind, row: LogRow): { session: Session; replaced: boolean } {
  const rows = logRows(session, kind);
  const at = rows.findIndex((r) => sameInstant(r.utc, row.utc));
  if (at >= 0) rows[at] = row;
  else rows.push(row);
  return { session: withRows(session, kind, rows), replaced: at >= 0 };
}

/** Remove the entry at this instant (the log disappears from the session when it empties). */
export function withoutLogRow(session: Session, kind: LogKind, utc: string): Session {
  return withRows(
    session,
    kind,
    logRows(session, kind).filter((r) => !sameInstant(r.utc, utc)),
  );
}

/**
 * The value a log gives at an instant, by the core's rule (`skyfix_core::error_logs`):
 * linear between the entries either side, an entry's own value at its instant, a one-entry
 * log as a constant, and the nearest entry held outside the span. Null for an empty log or
 * an unreadable time. (The watch log is read at a sight's recorded time.)
 */
export function logValueAt(rows: readonly LogRow[], utc: string): { value: number; hoursOutside: number } | null {
  const jd = jdFromIso(utc);
  const pts = sortRows([...rows])
    .map((r) => ({ jd: jdFromIso(r.utc), value: r.value }))
    .filter((p): p is { jd: number; value: number } => p.jd !== null);
  if (jd === null || pts.length === 0) return null;
  if (pts.length === 1) return { value: pts[0]!.value, hoursOutside: 0 };
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (jd <= first.jd) return { value: first.value, hoursOutside: (first.jd - jd) * 24 };
  if (jd >= last.jd) return { value: last.value, hoursOutside: (jd - last.jd) * 24 };
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (jd <= b.jd) return { value: a.value + ((jd - a.jd) / (b.jd - a.jd)) * (b.value - a.value), hoursOutside: 0 };
  }
  return { value: last.value, hoursOutside: 0 };
}

/**
 * The watch correction the core adds to a sight recorded at `utc`: the watch log's value
 * there, else the session's single known correction (seconds).
 */
export function watchCorrectionAt(session: Session, utc: string): number {
  const rows = logRows(session, 'watch');
  return rows.length ? (logValueAt(rows, utc)?.value ?? 0) : session.clock.correction_s;
}

/** A one-line summary for the session's header ("IC log 3 entries"). */
export function logSummary(session: Session): string {
  const parts: string[] = [];
  const i = session.instrument.index_error_log?.length ?? 0;
  const w = session.clock.watch_log?.length ?? 0;
  if (i) parts.push(`index-error log ${i} entr${i === 1 ? 'y' : 'ies'}`);
  if (w) parts.push(`watch log ${w} entr${w === 1 ? 'y' : 'ies'}`);
  return parts.join(' · ');
}
