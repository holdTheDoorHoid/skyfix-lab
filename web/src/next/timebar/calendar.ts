/**
 * The time bar's calendar: a month grid with day, month and year stepping, and a year
 * field for any year (BC or AD) with steps of 10, 100 and 1000 years. OWNER: time-ui agent
 * (from the shell-design agent's first version). Weeks start on Monday (ISO 8601); days
 * outside the month are shown dimmed and are still choosable. Rendering only: the time bar
 * wires the choices to the store (a calendar step in the display zone, keeping the clock
 * time).
 *
 * Dates are in the display calendar (time/civil.ts): Julian before 15 October 1582 unless
 * Settings chose ISO. The grid is built from day numbers, so October 1582 shows its 21 days
 * (Thursday the 4th is followed by Friday the 15th) and every weekday is right in any year.
 *
 * Keys in the grid (WAI-ARIA date picker): arrows move a day or a week, Page Up and Page
 * Down a month (with Shift, a year; with Ctrl, a century; Ctrl and Shift, a millennium),
 * Home and End the start and end of the week, Enter or Space chooses. `onMoveFocus` asks
 * the owner to show another date's month and focus it.
 */

import { h } from '../../dom.js';
import type { CalendarKind } from '../engine/types.js';
import { addDaysToDate, addMonthsToDate, calendarMode, dateFromJdn, eraOfYear, jdnFromDate, monthSpan, weekdayOfJdn } from '../time/civil.js';
import { calendarName, formatYear, monthYear, MONTHS_LONG, parseYear, yearForms } from '../time/format.js';
import { button, iconButton, segmented } from '../theme/primitives.js';

const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
  /** The calendar of the date, when known (the grid's cells carry it). */
  calendar?: CalendarKind;
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
  /**
   * Move the time by whole years (±10, ±100, ±1000), keeping the month, day and clock time.
   * Without it the year steps and the year field are not drawn.
   */
  onYearStep?: (years: number) => void;
  /** Go to a typed year (astronomical), keeping the month, day and clock time. */
  onGoToYear?: (year: number) => void;
}

function same(a: CalendarDate | undefined, b: CalendarDate): boolean {
  return !!a && a.year === b.year && a.month === b.month && a.day === b.day;
}

/** Day of the week of a date, 0 = Monday. */
function isoWeekday(d: CalendarDate): number {
  return (weekdayOfJdn(jdnFromDate(d)) + 6) % 7;
}

/** A date moved by days, or by months (the day clamped to the month's length), in the display calendar. */
export function shiftDate(d: CalendarDate, step: { days?: number; months?: number }): CalendarDate {
  if (step.months) return addMonthsToDate(d, step.months);
  return addDaysToDate(d, step.days ?? 0);
}

function key(d: CalendarDate): string {
  return `${d.year}-${d.month}-${d.day}`;
}

/** A plain note under the month's name: which calendar its dates are in, when it is not today's. */
function calendarNote(year: number, month: number): string {
  const [first, last] = monthSpan(year, month);
  const a = dateFromJdn(first);
  const b = dateFromJdn(last);
  if (a.calendar !== b.calendar) return '4 October (Julian) was followed by 15 October (Gregorian)';
  const name = calendarName(a);
  return name === 'Gregorian calendar' ? '' : name[0]!.toUpperCase() + name.slice(1);
}

export function calendar(options: CalendarOptions): HTMLElement {
  const { year, month } = options.view;
  const [first, last] = monthSpan(year, month);
  const lead = (weekdayOfJdn(first) + 6) % 7;
  const cells: CalendarDate[] = [];
  const count = Math.max(42, Math.ceil((lead + last - first + 1) / 7) * 7);
  for (let i = 0; i < count; i += 1) cells.push(dateFromJdn(first - lead + i));

  const focusDate =
    options.focus ?? (options.selected.year === year && options.selected.month === month ? options.selected : dateFromJdn(first));
  const title = monthYear(year, month);

  const grid = h('div', { class: 'sf-cal__grid', role: 'grid', 'aria-label': title, 'data-own-keys': '' });
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
        'data-outside': c.month !== month || c.year !== year ? '' : undefined,
        'data-today': same(options.today, c) ? '' : undefined,
        'data-date': key(c),
        tabindex: same(focusDate, c) ? 0 : -1,
        'aria-label': `${c.day} ${MONTHS_LONG[c.month - 1]} ${formatYear(c.year)}`,
      },
      String(c.day),
    );
    b.addEventListener('click', () => options.onChoose?.(c));
    b.addEventListener('keydown', (e) => {
      const shift = e.shiftKey;
      const pageMonths = e.ctrlKey ? (shift ? 12_000 : 1_200) : shift ? 12 : 1;
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
                  ? shiftDate(c, { months: -pageMonths })
                  : e.key === 'PageDown'
                    ? shiftDate(c, { months: pageMonths })
                    : e.key === 'Home'
                      ? shiftDate(c, { days: -isoWeekday(c) })
                      : e.key === 'End'
                        ? shiftDate(c, { days: 6 - isoWeekday(c) })
                        : null;
      if (!target) return;
      e.preventDefault();
      if (target.year === year && target.month === month) {
        grid.querySelector<HTMLElement>(`[data-date="${key(target)}"]`)?.focus();
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
  const note = calendarNote(year, month);
  const titleEl = h('span', { class: 'sf-cal__title', 'aria-live': 'polite' }, title);
  if (year < 1000 || year > 9999) titleEl.dataset.tip = yearForms(year);
  return h(
    'div',
    { class: 'sf-cal', 'data-mode': calendarMode() },
    h('div', { class: 'sf-cal__head' }, prevYear, prev, titleEl, next, nextYear),
    note ? h('p', { class: 'sf-cal__note' }, note) : null,
    grid,
    options.onYearStep || options.onGoToYear ? yearControls(options) : null,
    h(
      'div',
      { class: 'sf-cal__foot' },
      today,
      h(
        'span',
        { class: 'sf-kbd-hint', 'data-tip': 'With Shift, a year; with Ctrl, a century; with Ctrl and Shift, a millennium' },
        h('span', { class: 'sf-kbd' }, 'PgUp'),
        ' ',
        h('span', { class: 'sf-kbd' }, 'PgDn'),
        ' month',
      ),
    ),
  );
}

/**
 * The year row: a field for any year with a BC/AD switch and Go, and steps of 10, 100 and
 * 1000 years either way. The field starts at the month shown.
 */
function yearControls(options: CalendarOptions): HTMLElement {
  const shown = options.view.year;
  const { eraYear, era } = eraOfYear(shown);
  const id = 'sf-cal-year';
  const input = h('input', {
    class: 'sf-input sf-num sf-cal__year-input',
    id,
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    spellcheck: 'false',
    value: String(eraYear),
    'aria-describedby': 'sf-cal-year-error',
  });
  const eraSwitch = segmented<'BC' | 'AD'>({
    label: 'Era',
    value: era,
    size: 'sm',
    options: [
      { value: 'BC', label: 'BC', tip: 'Before Christ: 585 BC is the astronomers’ year −584 (there is no year 0 in BC and AD)' },
      { value: 'AD', label: 'AD', tip: 'Anno Domini: the years after 1 BC' },
    ],
  });
  const error = h('p', { class: 'sf-editor__error sf-cal__error', id: 'sf-cal-year-error', role: 'alert' });
  const go = button({ label: 'Go', variant: 'primary', size: 'sm', attrs: { type: 'submit' }, tip: 'Go to this year, keeping the day and the time' });
  const form = h(
    'form',
    { class: 'sf-cal__year', 'aria-label': 'Go to a year' },
    h('label', { class: 'sf-cal__year-label', for: id }, 'Year'),
    input,
    eraSwitch.el,
    go,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const typed = input.value.trim();
    // A sign or an era in the text wins over the switch; a bare number takes the switch's era.
    const year = parseYear(typed, eraSwitch.value());
    if (year === null) {
      error.textContent = 'Type a year such as 1066, 585 BC or −584.';
      input.focus();
      return;
    }
    error.textContent = '';
    options.onGoToYear?.(year);
  });
  input.addEventListener('keydown', (e) => {
    // Up and Down step the typed year, as a number field does.
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const year = parseYear(input.value, eraSwitch.value());
    if (year === null) return;
    e.preventDefault();
    const nextYear = year + (e.key === 'ArrowUp' ? 1 : -1);
    const next = eraOfYear(nextYear);
    input.value = String(next.eraYear);
    eraSwitch.set(next.era);
  });
  const stepButton = (years: number): HTMLElement => {
    const label = `${years > 0 ? '+' : '−'}${Math.abs(years)}`;
    const words = `${Math.abs(years)} years ${years > 0 ? 'later' : 'earlier'}`;
    const keys = Math.abs(years) === 100 ? ' (Ctrl+Page Down / Up)' : Math.abs(years) === 1000 ? ' (Ctrl+Shift+Page Down / Up)' : '';
    return button({
      label,
      variant: 'ghost',
      size: 'sm',
      class: 'sf-cal__step',
      ariaLabel: words,
      tip: `${words[0]!.toUpperCase()}${words.slice(1)}, the same day and time${keys}`,
      onClick: () => options.onYearStep?.(years),
    });
  };
  const steps = options.onYearStep
    ? h('div', { class: 'sf-cal__steps', role: 'group', 'aria-label': 'Step by years' }, ...[-1000, -100, -10, 10, 100, 1000].map(stepButton))
    : null;
  return h('div', { class: 'sf-cal__years' }, options.onGoToYear ? form : null, error, steps);
}
