/**
 * The Almanac view's date entry (almanac2 agent): a year of any size with its era, the
 * month, the day and the calendar, replacing `<input type="date">` (proleptic Gregorian,
 * years 1-9999 only in most browsers). The year is read by the shared `parseYear`, as the
 * time bar's year field reads it: `585 BC`, `−584`, `-0584` or a bare number in the era
 * beside it. Changing a field commits the date; the calendar label beside it (the shared
 * `calendarName`) says which calendar the date is in.
 */

import { h } from '../../dom.js';
import { segmented } from '../theme/primitives.js';
import { eraOfYear, parseYear } from '../time/index.js';
import { calendarLabel, MONTHS, type CalendarChoice, type DateEntryValue, type ShownDate } from './dates.js';

export interface DateEntry {
  el: HTMLElement;
  /** Show a date (unless the person is typing in a field). */
  set(date: ShownDate, choice: CalendarChoice): void;
  /** The calendar chosen. */
  calendar(): CalendarChoice;
  /** An error sentence under the fields, or none. */
  error(text: string | null): void;
  destroy(): void;
}

let entryCounter = 0;

export function dateEntry(options: {
  onSubmit: (value: DateEntryValue, calendar: CalendarChoice) => void;
  onCalendar: (calendar: CalendarChoice) => void;
  initialCalendar: CalendarChoice;
}): DateEntry {
  entryCounter += 1;
  const id = (k: string): string => `alm-entry-${entryCounter}-${k}`;
  const year = h('input', {
    id: id('year'),
    class: 'sf-input sf-num alm-year',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Year',
    'data-tip': 'Any year: 1066, 585 BC, AD 79, or astronomical −584 (ISO 8601 -0584). A bare number takes the era beside it; Up and Down step it.',
  });
  const era = segmented<'BC' | 'AD'>({
    label: 'Era',
    value: 'AD',
    size: 'sm',
    class: 'alm-era',
    options: [
      { value: 'BC', label: 'BC', tip: 'Before Christ: 585 BC is the astronomers’ year −584 (there is no year 0 in BC and AD)' },
      { value: 'AD', label: 'AD', tip: 'Anno Domini: the years after 1 BC' },
    ],
    onChange: () => submit(),
  });
  const month = h(
    'select',
    { id: id('month'), class: 'sf-input alm-month', 'aria-label': 'Month' },
    ...MONTHS.map((m, i) => h('option', { value: String(i + 1) }, m)),
  );
  const day = h('input', {
    id: id('day'),
    class: 'sf-input alm-day',
    type: 'number',
    inputmode: 'numeric',
    min: 1,
    max: 31,
    step: 1,
    'aria-label': 'Day',
  });
  const cal = h(
    'select',
    {
      id: id('cal'),
      class: 'sf-input alm-calsel',
      'aria-label': 'Calendar',
      title: 'Display calendar: as Settings shows dates (the Julian calendar before 15 October 1582, the Gregorian from then, unless Settings asks for ISO 8601)',
    },
    h('option', { value: 'auto' }, 'Display calendar'),
    h('option', { value: 'julian' }, 'Julian'),
    h('option', { value: 'gregorian' }, 'Gregorian'),
  );
  cal.value = options.initialCalendar;
  const tag = h('span', { class: 'alm-cal', 'aria-live': 'polite' });
  const err = h('p', { class: 'alm-entry-error', role: 'alert', hidden: true });
  const el = h(
    'div',
    { class: 'alm-entry', role: 'group', 'aria-label': 'UT date' },
    h('label', { class: 'alm-date-label', for: id('year') }, 'UT date'),
    h('span', { class: 'alm-entry-fields' }, year, era.el, month, day),
    cal,
    tag,
    err,
  );

  const read = (): DateEntryValue => ({
    yearText: year.value,
    era: era.value(),
    month: Number(month.value),
    day: Number(day.value),
  });
  function submit(): void {
    options.onSubmit(read(), cal.value as CalendarChoice);
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') submit();
  };
  // Up and Down step the typed year, as a number field does (and as the time bar's does).
  const onYearKey = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const y = parseYear(year.value, era.value());
    if (y === null) return;
    event.preventDefault();
    const next = eraOfYear(y + (event.key === 'ArrowUp' ? 1 : -1));
    year.value = String(next.eraYear);
    era.set(next.era);
  };
  for (const control of [year, day]) {
    control.addEventListener('change', submit);
    control.addEventListener('keydown', onKey);
  }
  year.addEventListener('keydown', onYearKey);
  month.addEventListener('change', submit);
  const onCal = (): void => options.onCalendar(cal.value as CalendarChoice);
  cal.addEventListener('change', onCal);

  const setTag = (date: ShownDate): void => {
    tag.textContent = calendarLabel(date);
    tag.className = `alm-cal alm-cal--${date.calendar}`;
  };

  return {
    el,
    set(date, choice) {
      const typing = el.contains(document.activeElement) && document.activeElement !== cal;
      if (!typing) {
        year.value = String(date.era_year);
        era.set(date.era);
        month.value = String(date.month);
        day.value = String(date.day);
      }
      cal.value = choice;
      setTag(date);
    },
    calendar: () => cal.value as CalendarChoice,
    error(text) {
      err.hidden = !text;
      err.textContent = text ?? '';
    },
    destroy() {
      for (const control of [year, day]) {
        control.removeEventListener('change', submit);
        control.removeEventListener('keydown', onKey);
      }
      year.removeEventListener('keydown', onYearKey);
      month.removeEventListener('change', submit);
      cal.removeEventListener('change', onCal);
    },
  };
}
