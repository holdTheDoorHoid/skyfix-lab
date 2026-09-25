/**
 * The panel's Place section: the place's name, its coordinates in the chosen format, its
 * time zone (guessed from the place, with the reason, or pinned), and the height of eye.
 * "Edit" opens exact entry of all of them. OWNER: shell-design agent; the site elevation, and
 * the zone's words under local mean time (from the time-ui helpers): navigate2 agent.
 */

import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import { fastPlayback } from '../playback.js';
import { formatZoneDescription, listTimeZones, parseLatLon, zoneDescription } from '../geo/index.js';
import { setAttr, setText } from '../shell/derived.js';
import { formatLat, formatLength, formatLon, lengthToMetres, metresToUnits } from '../shell/format.js';
import { zoneChoiceFromGuess, type PlaceService } from '../shell/place.js';
import { placeZone, shallowEqual, zonePinned, type ExplorerState } from '../state.js';
import { icon } from '../theme/icons.js';
import { button, popover, section } from '../theme/primitives.js';
import { formatOffset, isLmtZone, msFromJd, zoneOffsetMs, zoneShortName, type Zone, type ZoneChoice } from '../time.js';
import { lmtReason, zoneTooltip } from '../time/zones.js';

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** The place's name: its label, or where it is ("Near Philadelphia, …"), or its coordinates. */
export function placeName(s: ExplorerState, place: PlaceService): string {
  if (s.observer.label) return s.observer.label;
  const described = place.describe(s.observer.lat_deg, s.observer.lon_deg);
  return described ? capitalise(described) : 'A position you chose';
}

function zoneReason(s: ExplorerState, place: PlaceService, zone: Zone): string {
  const o = s.observer;
  if (o.zone.kind === 'utc') return 'You chose UTC. It stays when you change the place.';
  if (zonePinned(o.zone)) {
    return o.zone.kind === 'nautical'
      ? 'You chose nautical zone time. It stays when you change the place.'
      : `You chose ${o.zone.zone}. It stays when you change the place.`;
  }
  // Before 1850 a zone that follows the place is local mean time (time-ui, CONVENTIONS 15.3):
  // say that, not the reason for the zone it replaces (navigate2, from the time-ui agent's finding).
  if (zone.kind === 'fixed' && isLmtZone(zone)) return lmtReason(s.time.jd_utc, o.lon_deg, zone.offsetMs);
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
  // navigate2: the site's elevation, shown when it is set (edited in the editor).
  const elevValue = h('span', { class: 'sf-kv__v' });
  const elevRow = h('div', { class: 'sf-kv', 'data-tip': 'Your site above sea level: small effects on the Moon, eclipse times and the magnetic field' }, icon('eyeheight'), h('span', { class: 'sf-kv__k' }, 'Site elevation'), elevValue);
  sec.body.append(name, coords, zoneRow, reason, eyeRow, elevRow);

  const render = (): void => {
    const s = store.get();
    const o = s.observer;
    const f = s.settings.angleFormat;
    setText(name, placeName(s, place));
    setText(lat, formatLat(o.lat_deg, f));
    setText(lon, formatLon(o.lon_deg, f));
    const zone = placeZone(s);
    const jd = s.time.jd_utc;
    // The offset from the clock in its own word: `UT−5:00:40` outside 1972-2035 (time-ui).
    const offset = formatOffset(zoneOffsetMs(msFromJd(jd), zone), jd);
    const short = zoneShortName(jd, zone);
    zoneValue.replaceChildren(short, ...(short === offset ? [] : [' ', h('small', {}, offset)]));
    setAttr(zoneValue, 'data-tip', zoneTooltip(jd, zone, o.lon_deg));
    const pinned = zonePinned(o.zone);
    setAttr(pin, 'aria-pressed', String(pinned));
    setAttr(pin, 'aria-label', pinned ? 'Unpin the time zone: follow the place again' : 'Pin the time zone: keep it when the place changes');
    setAttr(pin, 'data-tip', pinned ? 'Pinned. Press to follow the place’s time zone again.' : 'Keep this time zone when the place changes');
    setText(reason, zoneReason(s, place, zone));
    setText(eyeValue, formatLength(s.settings.height_of_eye_m, s.settings.units));
    elevRow.hidden = !o.height_m;
    setText(elevValue, formatLength(o.height_m, s.settings.units));
  };
  d.add(
    // The zone's name and offset follow the hour, except during fast playback (a new hour
    // every frame; polish2, list item 18): they are drawn again when time slows.
    watch(ctx, (s) => [s.observer, s.settings.angleFormat, s.settings.units, s.settings.height_of_eye_m, fastPlayback(s) ? -1 : Math.floor(s.time.jd_utc * 24)] as const, render, {
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
      // The person's own choice: it stays when the place moves (`guessed: false`).
      store.patch({
        observer: { zone: kind === 'iana' ? { kind, zone: o.zone.zone, guessed: false } : kind === 'nautical' ? { kind, guessed: false } : { kind: 'utc' } },
      });
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
  // navigate2 (expansion programme): the site's elevation (the engine observer's height_m).
  const elev = h('input', { class: 'sf-input sf-num', id: 'sf-edit-elev', type: 'number', min: -500, max: 9000, step: 'any', inputmode: 'decimal' });
  const elevUnit = h('span', { class: 'sf-editor__unit' });
  const elevNote = h('p', { class: 'sf-editor__hint', 'aria-live': 'polite' });
  const gps = button({ label: 'From this device', variant: 'ghost', size: 'sm', tip: 'The height your device’s location service reports, if it gives one; used in this page only' });
  let elevShown = '';
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
    field('sf-edit-elev', 'Site elevation', h('div', { class: 'sf-editor__with-unit' }, elev, elevUnit, gps), ELEVATION_TEXT),
    elevNote,
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
    elev.value = String(Number(metresToUnits(o.height_m, s.settings.units).toFixed(1)));
    elevShown = elev.value;
    elevUnit.textContent = s.settings.units === 'imperial' ? 'ft' : 'm';
    elevNote.textContent = '';
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
          ? { kind: 'nautical', guessed: false }
          : choice === 'utc'
            ? { kind: 'utc' }
            : { kind: 'iana', zone: choice.slice(5), guessed: false };
    const eyeM = lengthToMetres(Number(eye.value), s.settings.units);
    // The old name no longer applies to a new position unless the person typed one.
    const typed = label.value.trim();
    const nextLabel = moved && typed === s.observer.label ? '' : typed;
    // The elevation: as typed when it was changed; else unknown (0) at a new position.
    const elevM = lengthToMetres(Number(elev.value), s.settings.units);
    const elevTyped = elev.value !== elevShown && elev.value.trim() !== '' && Number.isFinite(elevM) && elevM >= -500 && elevM <= 9000;
    const height = elevTyped ? { height_m: Number(elevM.toFixed(1)) } : moved ? { height_m: 0 } : {};
    store.batch(() => {
      store.patch({
        observer: { lat_deg, lon_deg, ...height, label: nextLabel, zone: nextZone },
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
  gps.addEventListener('click', () => {
    const geo = globalThis.navigator?.geolocation;
    if (!geo) {
      elevNote.textContent = 'This browser cannot give its location, so type the elevation.';
      return;
    }
    elevNote.textContent = 'Asking the device…';
    geo.getCurrentPosition(
      (pos) => {
        const { altitude, altitudeAccuracy } = pos.coords;
        if (altitude === null || !Number.isFinite(altitude)) {
          elevNote.textContent = 'The device gave a position but no height (many do not). Type the elevation.';
          return;
        }
        const units = store.get().settings.units;
        elev.value = String(Number(metresToUnits(altitude, units).toFixed(1)));
        elevNote.textContent = `From this device: ${formatLength(altitude, units)} above the WGS84 ellipsoid${altitudeAccuracy !== null && Number.isFinite(altitudeAccuracy) ? `, to within about ${formatLength(altitudeAccuracy, units)}` : ''}. Apply to use it; it stays in this page.`;
      },
      () => {
        elevNote.textContent = 'The device did not give its height. Type the elevation.';
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
  return { el: form, fill };
}

/**
 * What the site's elevation changes, measured with the engine (navigate2, 2026-09-25): at
 * 1000 m the Moon stands 0.45″ lower, the 2024-04-08 eclipse's contacts over Texas come up
 * to 0.67 s later, the magnetic field is 25 nT (0.05 %) weaker.
 */
export const ELEVATION_TEXT =
  'Your site above sea level (strictly, above the WGS84 ellipsoid, as a GPS reports it). Its effects are small: at 1000 m the Moon stands 0.5″ lower, eclipse contacts shift by under a second, the magnetic field is 0.05 % weaker. It is not your height of eye, which sets the dip.';
