/**
 * The Almanac view's date entry (almanac2 agent): a year of any size with its era, the
 * month, the day and the calendar, replacing `<input type="date">` (proleptic Gregorian,
 * years 1-9999 only in most browsers). Changing a field commits the date; the calendar
 * label beside it says which calendar the date is in.
 */

import { h } from '../../dom.js';
import type { CalendarKind } from '../engine/types.js';
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
    class: 'sf-input alm-year',
    type: 'number',
    inputmode: 'numeric',
    min: 1,
    max: 99999,
    step: 1,
    'aria-label': 'Year',
  });
  const era = h(
    'select',
    { id: id('era'), class: 'sf-input alm-era', 'aria-label': 'Era' },
    h('option', { value: 'AD' }, 'AD'),
    h('option', { value: 'BC' }, 'BC'),
  );
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
      title: 'Auto: the Julian calendar before 15 October 1582, the Gregorian from then',
    },
    h('option', { value: 'auto' }, 'Auto calendar'),
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
    h('span', { class: 'alm-entry-fields' }, year, era, month, day),
    cal,
    tag,
    err,
  );

  const read = (): DateEntryValue => ({
    eraYear: Number(year.value),
    era: era.value === 'BC' ? 'BC' : 'AD',
    month: Number(month.value),
    day: Number(day.value),
  });
  const submit = (): void => options.onSubmit(read(), cal.value as CalendarChoice);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') submit();
  };
  for (const control of [year, day]) {
    control.addEventListener('change', submit);
    control.addEventListener('keydown', onKey);
  }
  for (const control of [era, month]) control.addEventListener('change', submit);
  const onCal = (): void => options.onCalendar(cal.value as CalendarChoice);
  cal.addEventListener('change', onCal);

  const setTag = (c: CalendarKind): void => {
    tag.textContent = calendarLabel(c);
    tag.className = `alm-cal alm-cal--${c}`;
  };

  return {
    el,
    set(date, choice) {
      const typing = el.contains(document.activeElement) && document.activeElement !== cal;
      if (!typing) {
        year.value = String(date.era_year);
        era.value = date.era;
        month.value = String(date.month);
        day.value = String(date.day);
      }
      cal.value = choice;
      setTag(date.calendar);
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
      for (const control of [era, month]) control.removeEventListener('change', submit);
      cal.removeEventListener('change', onCal);
    },
  };
}
