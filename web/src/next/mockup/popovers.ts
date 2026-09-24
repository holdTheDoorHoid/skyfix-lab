/**
 * DESIGN MOCKUP: the popovers of the time bar, the app strip and the map, wired to their
 * buttons so the mockup can be clicked through. Nothing here changes any state.
 */

import { h } from '../../dom.js';
import { button, menu, popover, switchRow, type Popover } from '../theme/primitives.js';
import { calendar, type CalendarDate } from '../timebar/calendar.js';
import { PLAYBACK_SPEEDS } from '../playback.js';

const SHORT_SPEED: Record<number, string> = {
  1: '×1',
  60: '1 min/s',
  600: '10 min/s',
  3600: '1 h/s',
  21600: '6 h/s',
  86400: '1 d/s',
  604800: '1 wk/s',
  2629746: '1 mo/s',
};

export function wirePopovers(root: HTMLElement, day: CalendarDate, onStage: boolean): Popover[] {
  const out: Popover[] = [];

  const speedButton = root.querySelector<HTMLElement>('.sf-tb-speed');
  if (speedButton) {
    const content = h(
      'div',
      {},
      h('div', { class: 'sf-popover__title' }, 'Playback speed'),
      menu(
        'Playback speed',
        PLAYBACK_SPEEDS.map((s) => ({ value: String(s.speed), label: s.label, hint: SHORT_SPEED[s.speed] ?? '' })),
        '3600',
        () => out[0]?.close(),
      ),
    );
    out.push(popover(speedButton, content, { label: 'Playback speed', role: 'menu', placement: 'bottom-end' }));
  }

  const dateButton = root.querySelector<HTMLElement>('.sf-tb-date__label');
  if (dateButton) {
    let view = { year: day.year, month: day.month };
    const host = h('div', {});
    const draw = (): void => {
      host.replaceChildren(
        calendar({
          view,
          selected: day,
          today: day,
          onStep: (n) => {
            const m = view.month - 1 + n;
            view = { year: view.year + Math.floor(m / 12), month: (((m % 12) + 12) % 12) + 1 };
            draw();
          },
          onChoose: () => pop.close(),
          onToday: () => {
            view = { year: day.year, month: day.month };
            draw();
          },
        }),
      );
    };
    draw();
    const pop = popover(dateButton, host, { label: 'Choose a date', placement: 'bottom-start' });
    out.push(pop);
  }

  const layersButton = root.querySelector<HTMLElement>('.sf-layers-btn');
  if (layersButton) {
    const content = h(
      'div',
      { class: 'sf-layers' },
      h('div', { class: 'sf-popover__title' }, 'On the map'),
      switchRow({ label: 'Day and night shading', checked: true }),
      switchRow({ label: 'Compass at the place', checked: true }),
      switchRow({ label: 'Today’s paths', checked: true }),
      switchRow({ label: 'Ground points', note: 'where each body is overhead', checked: true }),
      switchRow({ label: 'Circles of position', checked: false }),
      switchRow({ label: 'Latitude and longitude grid', checked: false }),
      h('div', { class: 'sf-popover__title' }, 'Online'),
      switchRow({ label: 'Street map', note: 'OpenStreetMap, needs the internet', checked: false }),
    );
    out.push(popover(layersButton, content, { label: 'Map layers', placement: 'bottom-end', onStage }));
  }

  const shareButton = root.querySelector<HTMLElement>('.sf-share-btn');
  if (shareButton) {
    const link = h('input', {
      class: 'sf-input sf-num',
      readonly: true,
      value: 'https://…/next/#v=1&lat=39.9526&lon=-75.1652&t=2026-09-24T20:30:00Z',
      'aria-label': 'Share link',
    });
    const content = h(
      'div',
      { class: 'sf-share' },
      h('div', { class: 'sf-popover__title' }, 'Share this view'),
      h(
        'p',
        { class: 'sf-share__text' },
        'A link that opens this place, time and body. It is made only now, because you asked; the address bar never carries your position on its own.',
      ),
      h('label', { class: 'sf-check' }, h('input', { type: 'checkbox', checked: true }), ' Include the place'),
      h('div', { class: 'sf-share__row' }, link, button({ label: 'Copy', icon: 'check', variant: 'primary', size: 'sm' })),
    );
    out.push(popover(shareButton, content, { label: 'Share this view', placement: 'bottom-end' }));
  }

  return out;
}
