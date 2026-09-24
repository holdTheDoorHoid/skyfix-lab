/**
 * The time bar's calendar: a month grid with day, month and year stepping. OWNER:
 * shell-design agent. Weeks start on Monday (ISO 8601); days outside the month are
 * shown dimmed and are still choosable. Rendering only: the time bar wires the choice to
 * the store (a calendar step in the display zone, keeping the clock time).
 *
 * Keys in the grid (WAI-ARIA date picker): arrows move a day or a week, Page Up and Page
 * Down a month (with Shift, a year), Home and End the start and end of the week, Enter or
 * Space chooses. `onMoveFocus` asks the owner to show another date's month and focus it.
 */

import { h } from '../../dom.js';
import { daysInMonth } from '../time.js';
import { iconButton } from '../theme/primitives.js';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export interface CalendarOptions {
  /** The month shown. */
  view: { year: number; month: number };
  selected: CalendarDate;
  today?: CalendarDate;
  /** The date that has the keyboard focus (default: the selected date, if shown). */
  focus?: CalendarDate;
  onChoose?: (date: CalendarDate) => void;
  /** Step the month shown by `months` (±1 month, ±12 a year). */
  onStep?: (months: number) => void;
  onToday?: () => void;
  /** Keyboard: show `date`'s month (if needed) and focus it. */
  onMoveFocus?: (date: CalendarDate) => void;
}

function same(a: CalendarDate | undefined, b: CalendarDate): boolean {
  return !!a && a.year === b.year && a.month === b.month && a.day === b.day;
}

function utcDate(d: CalendarDate): Date {
  const js = new Date(Date.UTC(2000, 0, 1));
  js.setUTCFullYear(d.year, d.month - 1, d.day);
  return js;
}

function fromUtc(js: Date): CalendarDate {
  return { year: js.getUTCFullYear(), month: js.getUTCMonth() + 1, day: js.getUTCDate() };
}

/** Day of the week of a date, 0 = Monday. */
function isoWeekday(d: CalendarDate): number {
  return (utcDate(d).getUTCDay() + 6) % 7;
}

/** A date moved by days, or by months (the day clamped to the month's length). */
export function shiftDate(d: CalendarDate, step: { days?: number; months?: number }): CalendarDate {
  if (step.months) {
    const index = d.month - 1 + step.months;
    const year = d.year + Math.floor(index / 12);
    const month = (((index % 12) + 12) % 12) + 1;
    return { year, month, day: Math.min(d.day, daysInMonth(year, month)) };
  }
  const js = utcDate(d);
  js.setUTCDate(js.getUTCDate() + (step.days ?? 0));
  return fromUtc(js);
}

export function calendar(options: CalendarOptions): HTMLElement {
  const { year, month } = options.view;
  const first = isoWeekday({ year, month, day: 1 });
  const cells: CalendarDate[] = [];
  const prevMonth = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const prevDays = daysInMonth(prevMonth.year, prevMonth.month);
  for (let i = first - 1; i >= 0; i -= 1) cells.push({ ...prevMonth, day: prevDays - i });
  for (let d = 1; d <= daysInMonth(year, month); d += 1) cells.push({ year, month, day: d });
  for (let d = 1; cells.length % 7 !== 0 || cells.length < 42; d += 1) cells.push({ ...nextMonth, day: d });

  const focusDate =
    options.focus ?? (options.selected.year === year && options.selected.month === month ? options.selected : { year, month, day: 1 });

  const grid = h('div', { class: 'sf-cal__grid', role: 'grid', 'aria-label': `${MONTHS[month - 1]} ${year}`, 'data-own-keys': '' });
  grid.append(...DOW.map((d) => h('span', { class: 'sf-cal__dow', role: 'columnheader', 'aria-hidden': 'true' }, d)));
  for (const c of cells) {
    const selected = same(options.selected, c);
    const b = h(
      'button',
      {
        type: 'button',
        class: 'sf-cal__day',
        role: 'gridcell',
        'aria-selected': String(selected),
        'aria-current': same(options.today, c) ? 'date' : undefined,
        'data-outside': c.month !== month ? '' : undefined,
        'data-today': same(options.today, c) ? '' : undefined,
        'data-date': `${c.year}-${c.month}-${c.day}`,
        tabindex: same(focusDate, c) ? 0 : -1,
        'aria-label': `${c.day} ${MONTHS[c.month - 1]} ${c.year}`,
      },
      String(c.day),
    );
    b.addEventListener('click', () => options.onChoose?.(c));
    b.addEventListener('keydown', (e) => {
      const shift = e.shiftKey;
      const target =
        e.key === 'ArrowLeft'
          ? shiftDate(c, { days: -1 })
          : e.key === 'ArrowRight'
            ? shiftDate(c, { days: 1 })
            : e.key === 'ArrowUp'
              ? shiftDate(c, { days: -7 })
              : e.key === 'ArrowDown'
                ? shiftDate(c, { days: 7 })
                : e.key === 'PageUp'
                  ? shiftDate(c, { months: shift ? -12 : -1 })
                  : e.key === 'PageDown'
                    ? shiftDate(c, { months: shift ? 12 : 1 })
                    : e.key === 'Home'
                      ? shiftDate(c, { days: -isoWeekday(c) })
                      : e.key === 'End'
                        ? shiftDate(c, { days: 6 - isoWeekday(c) })
                        : null;
      if (!target) return;
      e.preventDefault();
      if (target.year === year && target.month === month) {
        grid.querySelector<HTMLElement>(`[data-date="${target.year}-${target.month}-${target.day}"]`)?.focus();
      } else {
        options.onMoveFocus?.(target);
      }
    });
    grid.append(b);
  }
  const step = (n: number) => () => options.onStep?.(n);
  const prevYear = iconButton('chevrons-left', 'Previous year', { size: 'sm', onClick: step(-12) });
  const prev = iconButton('chevron-left', 'Previous month', { size: 'sm', onClick: step(-1) });
  const next = iconButton('chevron-right', 'Next month', { size: 'sm', onClick: step(1) });
  const nextYear = iconButton('chevrons-right', 'Next year', { size: 'sm', onClick: step(12) });
  const today = h('button', { type: 'button', class: 'sf-btn sf-btn--ghost sf-btn--sm' }, 'Today');
  today.addEventListener('click', () => options.onToday?.());
  return h(
    'div',
    { class: 'sf-cal' },
    h(
      'div',
      { class: 'sf-cal__head' },
      prevYear,
      prev,
      h('span', { class: 'sf-cal__title', 'aria-live': 'polite' }, `${MONTHS[month - 1]} ${year}`),
      next,
      nextYear,
    ),
    grid,
    h(
      'div',
      { class: 'sf-cal__foot' },
      today,
      h('span', { class: 'sf-kbd-hint' }, h('span', { class: 'sf-kbd' }, 'PgUp'), ' ', h('span', { class: 'sf-kbd' }, 'PgDn'), ' month'),
    ),
  );
}
