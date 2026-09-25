/**
 * The session's index-error log and watch log as small tables: every entry with its time,
 * value and note, a remove button, and a row to add one ("Now" or the time bar's time).
 * OWNER: navigate2 agent (expansion programme). The rules are in logs.ts; the value the
 * core took at each sight is shown in that sight's workings (workings.ts).
 */

import { h } from '../../dom.js';
import { isoUtc, jdNow } from '../time.js';
import type { NavCtx } from './context.js';
import { fmtArcmin, utcInputText, utcText } from './format.js';
import { checkLogRow, LOG_LIMITS, logRows, withLogRow, withoutLogRow, type LogKind, type LogRow } from './logs.js';
import { parseNumber, parseUtcInput } from './parse.js';
import { LOG_TEXT } from './text.js';
import { btn, field, para, textInput } from './ui.js';
import { scaleLabel } from '../time/scale.js';

/** A logged value in words: `−1.5′`, `+4.0 s`. */
export function fmtLogValue(kind: LogKind, value: number): string {
  if (kind === 'index') return fmtArcmin(value, 1);
  const t = Math.abs(value).toFixed(value !== 0 && Math.abs(value) < 10 ? 1 : 0);
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${t} s`;
}

export function logEditor(nc: NavCtx, kind: LogKind, track: (fn: () => void) => void): { el: HTMLElement; refresh(): void } {
  const store = nc.working.store;
  const text = LOG_TEXT[kind];
  const limits = LOG_LIMITS[kind];
  const valueLabel = kind === 'index' ? 'Index correction to add (′)' : 'Correction to add to the watch (s)';

  const table = h('table', { class: 'sf-table sfn-table sfn-log__table' });
  const empty = para(kind === 'index' ? 'No entries: the single index correction above is used for every sight.' : 'No entries: the known watch correction above is used for every sight.', 'sfn-note sfn-muted');
  const unused = para('', 'sfn-note');
  const status = h('p', { class: 'sfn-status', role: 'status' });

  const time = textInput({ placeholder: 'yyyy-mm-dd hh:mm:ss', size: 19 });
  const value = textInput({ inputmode: 'decimal', size: 7, placeholder: kind === 'index' ? '-1.2' : '+4' });
  const note = textInput({ placeholder: 'Optional', size: 14 });
  // The clock's word of the time bar's instant (UT outside 1972-2035; polish2).
  const timeField = field(`When (${scaleLabel(nc.ctx.store.get().time.jd_utc)})`, time);
  const valueField = field(valueLabel, value, { help: kind === 'index' ? 'On the arc 1.5′ → −1.5.' : 'Watch slow by 4 s → +4.' });
  const noteField = field('Note', note);
  const now = btn('Now', () => {
    time.value = utcInputText(isoUtc(jdNow()).replace(/\.\d+Z$/, 'Z'));
  }, { variant: 'ghost', tip: 'This computer’s clock' });
  const bar = btn('Time bar', () => {
    time.value = utcInputText(isoUtc(nc.ctx.store.get().time.jd_utc).replace(/\.\d+Z$/, 'Z'));
  }, { variant: 'ghost', tip: 'The explorer’s time bar' });
  const add = btn('Add to the log', () => {
    const t = parseUtcInput(time.value);
    timeField.setError(t.ok ? null : t.error);
    const v = parseNumber(value.value, { what: limits.what, min: -limits.max, max: limits.max, unit: limits.unit });
    valueField.setError(v.ok ? null : v.error);
    if (!t.ok || !v.ok) return;
    const row = checkLogRow(kind, { utc: t.value, value: v.value, note: note.value });
    if (!row.ok) {
      valueField.setError(row.error);
      return;
    }
    const out = withLogRow(store.get().session, kind, row.value);
    store.patch({ session: out.session });
    status.textContent = out.replaced
      ? `Replaced the entry at ${utcText(row.value.utc)} (one value per instant).`
      : `Logged ${fmtLogValue(kind, row.value.value)} at ${utcText(row.value.utc)}.`;
    value.value = '';
    note.value = '';
  }, { icon: 'plus', variant: 'outline' });

  const details = h(
    'details',
    { class: 'sfn-advanced sfn-log' },
    h('summary', {}, text.title, ' ', h('span', { class: 'sfn-term' }, `· ${text.term}`), h('span', { class: 'sfn-log__count' })),
    para(text.explain, 'sfn-note'),
    h('div', { class: 'sfn-table-scroll' }, table),
    empty,
    unused,
    h(
      'div',
      { class: 'sfn-log__add' },
      h('div', { class: 'sfn-log__time' }, timeField.el, h('div', { class: 'sfn-entry__time-buttons' }, now, bar)),
      valueField.el,
      noteField.el,
      h('div', { class: 'sfn-log__actions' }, add),
    ),
    status,
  );

  const remove = (row: LogRow): void => {
    const before = store.get().session;
    store.patch({ session: withoutLogRow(before, kind, row.utc) });
    const undo = btn('Undo', () => {
      store.patch({ session: withLogRow(store.get().session, kind, row).session });
      status.textContent = 'Restored.';
    }, { variant: 'outline' });
    status.replaceChildren(`Removed the entry at ${utcText(row.utc)}. `, undo);
  };

  const refresh = (): void => {
    const s = store.get().session;
    const rows = logRows(s, kind);
    const count = details.querySelector('.sfn-log__count')!;
    count.textContent = rows.length ? ` (${rows.length})` : '';
    empty.hidden = rows.length > 0;
    table.hidden = rows.length === 0;
    table.replaceChildren(
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'When'), h('th', { scope: 'col', class: 'sfn-num' }, kind === 'index' ? 'IC (added)' : 'Watch + (s)'), h('th', { scope: 'col' }, 'Note'), h('th', { scope: 'col' }, h('span', { class: 'sf-sr' }, 'Remove')))),
      h(
        'tbody',
        {},
        ...rows.map((r) =>
          h(
            'tr',
            {},
            h('td', { class: 'sfn-num' }, utcText(r.utc)),
            h('td', { class: 'sfn-num' }, fmtLogValue(kind, r.value)),
            h('td', {}, r.note || '—'),
            h('td', {}, btn('', () => remove(r), { icon: 'close', variant: 'ghost', ariaLabel: `Remove the entry at ${utcText(r.utc)}` })),
          ),
        ),
      ),
    );
    const single = kind === 'index' ? s.instrument.index_correction_arcmin : s.clock.correction_s;
    unused.hidden = !(rows.length > 0 && single !== 0);
    unused.textContent =
      kind === 'index'
        ? `While the log has entries, the single index correction above (${fmtLogValue('index', single)}) is not used.`
        : `While the log has entries, the known watch correction above (${fmtLogValue('watch', single)}) is not used.`;
    if (rows.length > 0) (details as HTMLDetailsElement).open = true;
  };
  track(store.select((w) => (kind === 'index' ? w.session.instrument : w.session.clock), refresh));
  refresh();
  return { el: details, refresh };
}
