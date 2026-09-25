/**
 * "When is it at…?": the times on the day shown when the selected body stands at a chosen
 * height above the horizon — SunCalc's reverse calculation in navigator form ("when is the
 * Sun at 30° this afternoon?") — or crosses a chosen bearing ("when is the Moon over that
 * church?"). Heights come from the engine's `find_altitude` (apparent altitude, the height a
 * person sees), bearings from the suntools engine's `find_azimuth` (while the body is above
 * the horizon); pressing a time makes it the time shown. The bearing is the one the
 * alignment finder uses (`photoBearing`): typed, or picked on the map, where it is drawn.
 * Offered for every body. OWNER: photo agent (expansion programme Q8; first written by the
 * shell-design agent's polish pass).
 */

import { h } from '../../dom.js';
import type { Ctx } from '../component.js';
import { observerKey } from '../component.js';
import { isSunToolsEngine, type AltitudeCrossing, type AzimuthCrossing } from '../engine/types.js';
import { setTime } from '../playback.js';
import { attempt, clampToCoverage, dayOf, setText } from '../shell/derived.js';
import { bearing3, compassPoint, dateShort, eventTime, formatAngle } from '../shell/format.js';
import { displayZone, engineObserver, type ExplorerState } from '../state.js';
import { icon } from '../theme/icons.js';
import { segmented } from '../theme/primitives.js';
import { deltaTNote, outsideWords, photoBearing, Settler, toolChip } from './photo.js';
import { turning } from '../time/chip.js';
import { FIND_ALT_MAX, FIND_ALT_MIN, parseAltitude, parseBearing } from './sun-tools.js';

export type WhenMode = 'height' | 'bearing';

/** The height each page asks about first, and what the person typed since (per explorer). */
const asked = new WeakMap<object, string>();
/** Height or bearing, per explorer. */
const modes = new WeakMap<object, WhenMode>();

let seq = 0;

export interface WhenTool {
  el: HTMLElement;
  /** Called by the Selected card on each of its renders; `moving` while the time is dragged or playing. */
  update(s: ExplorerState, body: string, moving?: boolean): void;
  destroy(): void;
}

export function whenTool(ctx: Ctx): WhenTool {
  const { store, engine } = ctx;
  const id = `sf-when-${++seq}`;
  const bearing = photoBearing(ctx);
  let mode: WhenMode = modes.get(store) ?? 'height';

  // --- height --------------------------------------------------------------------------
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
  const heightAsk = h(
    'div',
    { class: 'sf-when__ask' },
    h('label', { class: 'sf-when__label', for: id }, 'Height above the horizon'),
    input,
    h('span', { class: 'sf-when__unit' }, '°'),
  );

  // --- bearing -------------------------------------------------------------------------
  const azInput = h('input', {
    class: 'sf-input sf-num sf-when__input',
    id: `${id}-az`,
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: '245',
    value: bearing.get().text,
    'aria-describedby': `${id}-hint`,
  });
  const pickBtn = h(
    'button',
    { type: 'button', class: 'sf-btn sf-btn--ghost sf-btn--sm sf-btn--icon sf-when__pick', 'aria-label': 'Pick the bearing on the map', 'data-tip': 'Pick the bearing on the map: click the point it should run to' },
    icon('target'),
  );
  const bearingAsk = h(
    'div',
    { class: 'sf-when__ask' },
    h('label', { class: 'sf-when__label', for: `${id}-az` }, 'Bearing from here'),
    azInput,
    h('span', { class: 'sf-when__unit' }, '°'),
    pickBtn,
  );

  const modeSeg = segmented<WhenMode>({
    label: 'Look for a height or a bearing',
    size: 'sm',
    value: mode,
    options: [
      { value: 'height', label: 'Height', tip: 'When it stands at a height above the horizon' },
      { value: 'bearing', label: 'Bearing', tip: 'When it passes a direction from here, such as a street or a landmark' },
    ],
    onChange: (m) => {
      mode = m;
      modes.set(store, m);
      sync();
      key = '';
      run();
    },
  });

  const hint = h('p', { class: 'sf-when__hint', id: `${id}-hint` });
  const statusText = h('span', {});
  const chip = toolChip();
  const status = h('p', { class: 'sf-when__status', role: 'status', 'aria-live': 'polite' }, statusText, ' ', chip.el);
  const list = h('ul', { class: 'sf-when__list', 'aria-label': 'Times' });
  const el = h(
    'details',
    { class: 'sf-details sf-when' },
    h('summary', {}, 'When is it at…?', icon('chevron-down')),
    h('div', { class: 'sf-when__body' }, h('div', { class: 'sf-when__modes' }, modeSeg.el), heightAsk, bearingAsk, hint, status, list),
  ) as HTMLDetailsElement;

  let last: { s: ExplorerState; body: string; moving: boolean } | null = null;
  let key = '';
  const settler = new Settler();
  let releaseRay: (() => void) | null = null;

  const sync = (): void => {
    heightAsk.hidden = mode !== 'height';
    bearingAsk.hidden = mode !== 'bearing';
    setText(
      hint,
      mode === 'height'
        ? `Degrees above the horizon, as it looks: ${FIND_ALT_MIN} to ${FIND_ALT_MAX} (below 0 for twilight). Degrees and minutes work too: 30 15.`
        : 'Degrees from true north, clockwise: 90 east, 180 south, 270 west; or a compass point such as WNW. Only while it is above the horizon.',
    );
    const holding = el.open && mode === 'bearing';
    if (holding && !releaseRay) releaseRay = bearing.holdRay();
    else if (!holding && releaseRay) {
      releaseRay();
      releaseRay = null;
    }
  };
  sync();

  const button = (jd: number, rising: boolean, label: string, what: HTMLElement, clockText: string): HTMLElement => {
    const b = h(
      'button',
      { type: 'button', class: 'sf-when__time', 'aria-label': label },
      icon(rising ? 'rise' : 'set'),
      h('span', { class: 'sf-num sf-when__clock' }, clockText),
      what,
    );
    b.addEventListener('click', () => setTime(store, jd));
    return h('li', {}, b);
  };

  const fillHeight = (s: ExplorerState, body: string, altitude: number | null): void => {
    const zone = displayZone(s);
    const [a, b] = dayOf(s);
    const day = dateShort(a + 0.5, zone);
    if (altitude === null) {
      list.replaceChildren();
      input.setAttribute('aria-invalid', 'true');
      setText(statusText, `Type a height from ${FIND_ALT_MIN}° to ${FIND_ALT_MAX}°.`);
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
      setText(statusText, span ? `Not computed for ${day}.` : outsideWords(ctx, day));
      return;
    }
    setText(
      status,
      found.length === 0
        ? `${body} is never at ${at} on ${day}.`
        : `${body} at ${at} on ${day}: ${found.length === 1 ? 'once' : `${found.length} times`}. Press a time to show it.`,
    );
    // The body at a height or on a bearing: set by the Earth's turning (chip2).
    chip.set(ctx, turning(body), a, b);
    const dt = deltaTNote(ctx, (a + b) / 2, turning(body));
    list.replaceChildren(
      ...found.map((c) => {
        const time = `${eventTime(c.jd_utc, zone)}${dt}`;
        const way = c.rising ? 'rising' : 'sinking';
        const toward = `${bearing3(c.az_deg)} ${compassPoint(c.az_deg)}`;
        return button(
          c.jd_utc,
          c.rising,
          `Show ${time}: ${body} ${way} through ${at}, toward ${toward}`,
          h('span', { class: 'sf-when__what' }, `${way}, toward `, h('span', { class: 'sf-num' }, toward)),
          time,
        );
      }),
    );
  };

  const fillBearing = (s: ExplorerState, body: string): void => {
    const zone = displayZone(s);
    const [a, b] = dayOf(s);
    const day = dateShort(a + 0.5, zone);
    const az = bearing.get().azimuth;
    azInput.toggleAttribute('aria-invalid', azInput.value.trim() !== '' && az === null);
    if (!isSunToolsEngine(engine)) {
      list.replaceChildren();
      setText(statusText, 'Bearings are not available in this engine: rebuild the WebAssembly package.');
      return;
    }
    if (az === null) {
      list.replaceChildren();
      setText(statusText, 'Type a bearing, or pick one on the map.');
      return;
    }
    const span = clampToCoverage(ctx, a, b);
    const found: AzimuthCrossing[] | null = span
      ? attempt(ctx, 'engine-find-azimuth', `Finding when ${body} is at ${az}°`, () => engine.findAzimuth(engineObserver(s), body, span[0], span[1], az))
      : null;
    const on = `${az.toFixed(1)}°`;
    if (!found) {
      list.replaceChildren();
      setText(statusText, span ? `Not computed for ${day}.` : outsideWords(ctx, day));
      return;
    }
    setText(
      status,
      found.length === 0
        ? `${body} does not pass ${on} ${compassPoint(az)} above the horizon on ${day}.`
        : `${body} on ${on} on ${day}: ${found.length === 1 ? 'once' : `${found.length} times`}. Press a time to show it.`,
    );
    // The body at a height or on a bearing: set by the Earth's turning (chip2).
    chip.set(ctx, turning(body), a, b);
    const dt = deltaTNote(ctx, (a + b) / 2, turning(body));
    const f = s.settings.angleFormat;
    list.replaceChildren(
      ...found.map((c) => {
        const time = `${eventTime(c.jd_utc, zone)}${dt}`;
        const way = c.rising ? 'climbing' : 'sinking';
        const high = formatAngle(c.alt_apparent_deg, f, 'coarse');
        return button(
          c.jd_utc,
          c.rising,
          `Show ${time}: ${body} on ${on}, ${way}, ${high} high`,
          h('span', { class: 'sf-when__what' }, `${way}, `, h('span', { class: 'sf-num' }, high), ' high'),
          time,
        );
      }),
    );
  };

  const run = (): void => {
    if (!last || !el.open) return;
    const { s, body, moving } = last;
    const [a, b] = dayOf(s);
    const zone = displayZone(s);
    const what = mode === 'height' ? `h${parseAltitude(input.value)}` : `z${bearing.get().azimuth}`;
    const next = `${body}|${a}|${b}|${observerKey(engineObserver(s))}|${what}|${s.settings.angleFormat}|${s.settings.hourCycle}|${zone.kind === 'iana' ? zone.zone : zone.name}`;
    if (next === key) return;
    key = next;
    // A day of crossings is a millisecond or two: while the time bar is dragged across days,
    // worked out once it settles.
    settler.request(
      next,
      moving,
      () => {
        list.removeAttribute('data-stale');
        const cur = last ?? { s, body };
        if (mode === 'height') fillHeight(store.get(), cur.body, parseAltitude(input.value));
        else fillBearing(store.get(), cur.body);
      },
      () => list.setAttribute('data-stale', ''),
    );
  };

  input.addEventListener('input', () => {
    asked.set(store, input.value);
    run();
  });
  azInput.addEventListener('input', () => {
    bearing.setTyped(azInput.value, parseBearing(azInput.value));
  });
  pickBtn.addEventListener('click', () => {
    if (bearing.picking()) {
      bearing.cancelPick();
      return;
    }
    const s = store.get();
    if (s.view !== 'map' && s.view !== 'globe') store.patch({ view: 'map' });
    bearing.pick({ lat_deg: s.observer.lat_deg, lon_deg: s.observer.lon_deg });
  });
  const stopBearing = bearing.subscribe((v) => {
    if (document.activeElement !== azInput && azInput.value !== v.text) azInput.value = v.text;
    pickBtn.setAttribute('aria-pressed', String(bearing.picking()));
    if (mode === 'bearing') {
      key = '';
      run();
    }
  });
  el.addEventListener('toggle', () => {
    sync();
    run();
  });

  return {
    el,
    update(s, body, moving = false) {
      last = { s, body, moving };
      run();
    },
    destroy() {
      stopBearing();
      settler.cancel();
      releaseRay?.();
      releaseRay = null;
    },
  };
}
