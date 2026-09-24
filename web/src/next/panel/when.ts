/**
 * "When is it at…?": the times on the day shown when the selected body stands at a chosen
 * height above the horizon — SunCalc's reverse calculation in navigator form ("when is the
 * Sun at 30° this afternoon?"). The times come from the engine's `find_altitude` (apparent
 * altitude, the height a person sees); pressing one makes it the time shown. Offered for
 * every body. OWNER: shell-design agent (added by the polish pass).
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import { observerKey } from '../component.js';
import type { AltitudeCrossing } from '../engine/types.js';
import { setTime } from '../playback.js';
import { attempt, clampToCoverage, dayOf, setText } from '../shell/derived.js';
import { bearing3, compassPoint, dateShort, eventTime, formatAngle } from '../shell/format.js';
import { displayZone, engineObserver, type ExplorerState } from '../state.js';
import { icon } from '../theme/icons.js';
import { FIND_ALT_MAX, FIND_ALT_MIN, parseAltitude } from './sun-tools.js';

/** The height each page asks about first, and what the person typed since (per explorer). */
const asked = new WeakMap<object, string>();

let seq = 0;

export interface WhenTool {
  el: HTMLElement;
  /** Called by the Selected card on each of its renders. */
  update(s: ExplorerState, body: string): void;
}

export function whenTool(ctx: Ctx): WhenTool {
  const { store, engine } = ctx;
  const id = `sf-when-${++seq}`;
  const input = h('input', {
    class: 'sf-input sf-num sf-when__input',
    id,
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    value: asked.get(store) ?? '30',
    'aria-describedby': `${id}-hint`,
  });
  const hint = h('p', { class: 'sf-when__hint', id: `${id}-hint` }, `Degrees above the horizon, as it looks: ${FIND_ALT_MIN} to ${FIND_ALT_MAX} (below 0 for twilight). Degrees and minutes work too: 30 15.`);
  const status = h('p', { class: 'sf-when__status', role: 'status', 'aria-live': 'polite' });
  const list = h('ul', { class: 'sf-when__list', 'aria-label': 'Times' });
  const el = h(
    'details',
    { class: 'sf-details sf-when' },
    h('summary', {}, 'When is it at…?', icon('chevron-down')),
    h(
      'div',
      { class: 'sf-when__body' },
      h('div', { class: 'sf-when__ask' }, h('label', { class: 'sf-when__label', for: id }, 'Height above the horizon'), input, h('span', { class: 'sf-when__unit' }, '°')),
      hint,
      status,
      list,
    ),
  ) as HTMLDetailsElement;

  let last: { s: ExplorerState; body: string } | null = null;
  let key = '';

  const fill = (s: ExplorerState, body: string, altitude: number | null): void => {
    const zone = displayZone(s);
    const [a, b] = dayOf(s);
    const day = dateShort(a + 0.5, zone);
    if (altitude === null) {
      list.replaceChildren();
      input.setAttribute('aria-invalid', 'true');
      setText(status, `Type a height from ${FIND_ALT_MIN}° to ${FIND_ALT_MAX}°.`);
      return;
    }
    input.removeAttribute('aria-invalid');
    const span = clampToCoverage(ctx, a, b);
    const found: AltitudeCrossing[] | null = span
      ? attempt(ctx, 'engine-find-altitude', `Finding when ${body} is at ${altitude}°`, () => engine.findAltitude(engineObserver(s), body, span[0], span[1], altitude))
      : null;
    const at = formatAngle(altitude, s.settings.angleFormat, 'coarse');
    if (!found) {
      list.replaceChildren();
      setText(status, span ? `Not computed for ${day}.` : `${day} is outside the years the core covers.`);
      return;
    }
    setText(
      status,
      found.length === 0
        ? `${body} is never at ${at} on ${day}.`
        : `${body} at ${at} on ${day}: ${found.length === 1 ? 'once' : `${found.length} times`}. Press a time to show it.`,
    );
    list.replaceChildren(
      ...found.map((c) => {
        const time = eventTime(c.jd_utc, zone);
        const way = c.rising ? 'rising' : 'sinking';
        const toward = `${bearing3(c.az_deg)} ${compassPoint(c.az_deg)}`;
        const btn = h(
          'button',
          { type: 'button', class: 'sf-when__time', 'aria-label': `Show ${time}: ${body} ${way} through ${at}, toward ${toward}` },
          icon(c.rising ? 'rise' : 'set'),
          h('span', { class: 'sf-num sf-when__clock' }, time),
          h('span', { class: 'sf-when__what' }, `${way}, toward `, h('span', { class: 'sf-num' }, toward)),
        );
        btn.addEventListener('click', () => setTime(store, c.jd_utc));
        return h('li', {}, btn);
      }),
    );
  };

  const run = (): void => {
    if (!last || !el.open) return;
    const { s, body } = last;
    const altitude = parseAltitude(input.value);
    const [a, b] = dayOf(s);
    const zone = displayZone(s);
    const next = `${body}|${a}|${b}|${observerKey(engineObserver(s))}|${altitude}|${s.settings.angleFormat}|${zone.kind === 'iana' ? zone.zone : zone.name}`;
    if (next === key) return;
    key = next;
    fill(s, body, altitude);
  };

  input.addEventListener('input', () => {
    asked.set(store, input.value);
    run();
  });
  el.addEventListener('toggle', run);

  return {
    el,
    update(s, body) {
      last = { s, body };
      run();
    },
  };
}
