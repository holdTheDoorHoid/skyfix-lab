/**
 * The panel's Place section: the place's name, its coordinates in the chosen format, its
 * time zone (guessed from the place, with the reason, or pinned), and the height of eye.
 * "Edit" opens exact entry of all of them. OWNER: shell-design agent.
 */

import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import { formatZoneDescription, listTimeZones, parseLatLon, zoneDescription } from '../geo/index.js';
import { setAttr, setText } from '../shell/derived.js';
import { formatLat, formatLength, formatLon, lengthToMetres, metresToUnits } from '../shell/format.js';
import { zoneChoiceFromGuess, type PlaceService } from '../shell/place.js';
import { placeZone, shallowEqual, zonePinned, type ExplorerState } from '../state.js';
import { icon } from '../theme/icons.js';
import { button, popover, section } from '../theme/primitives.js';
import { formatOffset, msFromJd, zoneLabel, zoneOffsetMs, zoneShortName, type ZoneChoice } from '../time.js';

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** The place's name: its label, or where it is ("Near Philadelphia, …"), or its coordinates. */
export function placeName(s: ExplorerState, place: PlaceService): string {
  if (s.observer.label) return s.observer.label;
  const described = place.describe(s.observer.lat_deg, s.observer.lon_deg);
  return described ? capitalise(described) : 'A position you chose';
}

function zoneReason(s: ExplorerState, place: PlaceService): string {
  const o = s.observer;
  if (o.zone.kind === 'utc') return 'You chose UTC. It stays when you change the place.';
  if (zonePinned(o.zone)) {
    return o.zone.kind === 'nautical'
      ? 'You chose nautical zone time. It stays when you change the place.'
      : `You chose ${o.zone.zone}. It stays when you change the place.`;
  }
  const guess = place.guess(o.lat_deg, o.lon_deg);
  if (guess) return guess.source === 'sea' ? guess.reason : `From the place: ${guess.reason}`;
  if (o.zone.kind === 'nautical') {
    const zd = zoneDescription(o.lon_deg);
    return `Nautical zone time from the longitude: ZD ${formatZoneDescription(zd)}.`;
  }
  return 'From the place.';
}

export function placeSection(ctx: Ctx, place: PlaceService): { el: HTMLElement; destroy(): void } {
  const { store } = ctx;
  const d = disposer();
  const edit = button({ label: 'Edit', icon: 'edit', variant: 'ghost', size: 'sm', tip: 'Exact position, time zone and height of eye' });
  const sec = section('Place', { class: 'sf-place', aside: edit });

  const name = h('p', { class: 'sf-place__name' });
  const lat = h('span', {});
  const lon = h('span', {});
  const coords = h('p', { class: 'sf-place__coords' }, lat, lon);

  const zoneValue = h('span', { class: 'sf-kv__v' });
  const pin = h(
    'button',
    { type: 'button', class: 'sf-btn sf-btn--ghost sf-btn--sm sf-btn--icon sf-pin', 'aria-pressed': 'false' },
    icon('pin'),
  );
  const zoneRow = h(
    'div',
    { class: 'sf-kv sf-kv--zone' },
    icon('clock'),
    h('span', { class: 'sf-kv__k' }, 'Time zone'),
    h('span', { class: 'sf-zone' }, zoneValue, pin),
  );
  const reason = h('p', { class: 'sf-place__reason' });
  const eyeValue = h('span', { class: 'sf-kv__v' });
  const eyeRow = h(
    'button',
    { type: 'button', class: 'sf-kv sf-kv--button', 'data-tip': 'Your eye above the sea: sets the dip of the horizon for sights' },
    icon('eyeheight'),
    h('span', { class: 'sf-kv__k' }, 'Height of eye'),
    eyeValue,
  );
  sec.body.append(name, coords, zoneRow, reason, eyeRow);

  const render = (): void => {
    const s = store.get();
    const o = s.observer;
    const f = s.settings.angleFormat;
    setText(name, placeName(s, place));
    setText(lat, formatLat(o.lat_deg, f));
    setText(lon, formatLon(o.lon_deg, f));
    const zone = placeZone(s);
    const jd = s.time.jd_utc;
    const offset = formatOffset(zoneOffsetMs(msFromJd(jd), zone));
    const short = zoneShortName(jd, zone);
    zoneValue.replaceChildren(short, ...(short === offset ? [] : [' ', h('small', {}, offset)]));
    setAttr(zoneValue, 'data-tip', zoneLabel(jd, zone));
    const pinned = zonePinned(o.zone);
    setAttr(pin, 'aria-pressed', String(pinned));
    setAttr(pin, 'aria-label', pinned ? 'Unpin the time zone: follow the place again' : 'Pin the time zone: keep it when the place changes');
    setAttr(pin, 'data-tip', pinned ? 'Pinned. Press to follow the place’s time zone again.' : 'Keep this time zone when the place changes');
    setText(reason, zoneReason(s, place));
    setText(eyeValue, formatLength(s.settings.height_of_eye_m, s.settings.units));
  };
  d.add(
    watch(ctx, (s) => [s.observer, s.settings.angleFormat, s.settings.units, s.settings.height_of_eye_m, Math.floor(s.time.jd_utc * 24)] as const, render, {
      equals: shallowEqual,
    }),
  );
  d.add(place.subscribe(render));

  pin.addEventListener('click', () => {
    const o = store.get().observer;
    if (zonePinned(o.zone)) {
      store.patch({ observer: { zone: zoneChoiceFromGuess(place.guess(o.lat_deg, o.lon_deg)) } });
    } else {
      const { kind } = o.zone;
      store.patch({ observer: { zone: kind === 'iana' ? { kind, zone: o.zone.zone } : kind === 'nautical' ? { kind } : { kind: 'utc' } } });
    }
  });

  // --- the editor -------------------------------------------------------------------
  const editor = placeEditor(ctx, place, () => pop.close());
  const pop = popover(edit, editor.el, { label: 'Edit the place', placement: 'bottom-end', onOpen: editor.fill });
  eyeRow.addEventListener('click', () => pop.open());
  d.add(() => pop.destroy());

  return { el: sec.el, destroy: () => d.dispose() };
}

function placeEditor(ctx: Ctx, place: PlaceService, done: () => void): { el: HTMLElement; fill: () => void } {
  const { store } = ctx;
  const pos = h('input', { class: 'sf-input sf-num', id: 'sf-edit-pos', type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const posError = h('p', { class: 'sf-editor__error', role: 'alert' });
  const label = h('input', { class: 'sf-input', id: 'sf-edit-name', type: 'text', maxlength: 120, placeholder: 'Optional' });
  const zone = h('select', { class: 'sf-input', id: 'sf-edit-zone' });
  const eye = h('input', { class: 'sf-input sf-num', id: 'sf-edit-eye', type: 'number', min: 0, max: 500, step: 'any', inputmode: 'decimal' });
  const eyeUnit = h('span', { class: 'sf-editor__unit' });
  const horizon = h('select', { class: 'sf-input', id: 'sf-edit-horizon' });
  horizon.append(
    h('option', { value: 'standard' }, 'Sea-level horizon'),
    h('option', { value: 'dip' }, 'Dipped for my height of eye'),
  );
  const apply = button({ label: 'Apply', variant: 'primary', size: 'sm', attrs: { type: 'submit' } });
  const cancel = button({ label: 'Cancel', variant: 'ghost', size: 'sm' });
  const field = (id: string, text: string, control: HTMLElement, hint?: string): HTMLElement =>
    h('div', { class: 'sf-editor__field' }, h('label', { class: 'sf-label', for: id }, text), control, hint ? h('p', { class: 'sf-editor__hint' }, hint) : null);
  const form = h(
    'form',
    { class: 'sf-editor', novalidate: true },
    h('div', { class: 'sf-popover__title' }, 'The place'),
    field('sf-edit-pos', 'Position', pos, 'Any usual form: 39 57.2 N 75 09.9 W, or 39.9526, −75.1652.'),
    posError,
    field('sf-edit-name', 'Name', label),
    field('sf-edit-zone', 'Time zone', zone),
    field('sf-edit-eye', 'Height of eye', h('div', { class: 'sf-editor__with-unit' }, eye, eyeUnit), 'Your eye above the sea: it sets the dip of the horizon.'),
    field('sf-edit-horizon', 'Rise and set', horizon),
    h('div', { class: 'sf-editor__actions' }, cancel, apply),
  );

  const fill = (): void => {
    const s = store.get();
    const o = s.observer;
    pos.value = `${formatLat(o.lat_deg, 'dm')}, ${formatLon(o.lon_deg, 'dm')}`;
    posError.textContent = '';
    label.value = o.label;
    const g = place.data().gazetteer;
    const guess = place.guess(o.lat_deg, o.lon_deg);
    const following = guess?.zone.kind === 'iana' ? guess.zone.id : `nautical zone time, ZD ${formatZoneDescription(zoneDescription(o.lon_deg))}`;
    zone.replaceChildren(
      h('option', { value: 'follow' }, `Follow the place (${following})`),
      h('option', { value: 'nautical' }, `Nautical zone time (ZD ${formatZoneDescription(zoneDescription(o.lon_deg))})`),
      h('option', { value: 'utc' }, 'UTC'),
      h('optgroup', { label: 'Time zones' }, ...listTimeZones(g?.zones ?? []).filter((z) => z !== 'UTC').map((z) => h('option', { value: `iana:${z}` }, z))),
    );
    zone.value = !zonePinned(o.zone) ? 'follow' : o.zone.kind === 'iana' ? `iana:${o.zone.zone}` : o.zone.kind;
    if (!zone.value) zone.value = 'follow';
    eye.value = String(Number(metresToUnits(s.settings.height_of_eye_m, s.settings.units).toFixed(2)));
    eyeUnit.textContent = s.settings.units === 'imperial' ? 'ft' : 'm';
    horizon.value = s.settings.horizon;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const s = store.get();
    const parsed = parseLatLon(pos.value);
    if (!parsed.ok) {
      posError.textContent = parsed.error;
      pos.focus();
      return;
    }
    const { lat_deg, lon_deg } = parsed.value;
    const moved = Math.abs(lat_deg - s.observer.lat_deg) > 1e-9 || Math.abs(lon_deg - s.observer.lon_deg) > 1e-9;
    const choice = zone.value;
    const nextZone: ZoneChoice =
      choice === 'follow'
        ? zoneChoiceFromGuess(place.guess(lat_deg, lon_deg))
        : choice === 'nautical'
          ? { kind: 'nautical' }
          : choice === 'utc'
            ? { kind: 'utc' }
            : { kind: 'iana', zone: choice.slice(5) };
    const eyeM = lengthToMetres(Number(eye.value), s.settings.units);
    // The old name no longer applies to a new position unless the person typed one.
    const typed = label.value.trim();
    const nextLabel = moved && typed === s.observer.label ? '' : typed;
    store.batch(() => {
      store.patch({
        observer: { lat_deg, lon_deg, ...(moved ? { height_m: 0 } : {}), label: nextLabel, zone: nextZone },
      });
      store.patch({
        settings: {
          horizon: horizon.value === 'dip' ? 'dip' : 'standard',
          ...(Number.isFinite(eyeM) && eyeM >= 0 && eyeM <= 500 ? { height_of_eye_m: Number(eyeM.toFixed(2)) } : {}),
        },
      });
    });
    done();
  });
  cancel.addEventListener('click', done);
  return { el: form, fill };
}
