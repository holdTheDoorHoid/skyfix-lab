/**
 * The settings popover: theme, how times, angles and units are shown, navigator terms,
 * the horizon used for rise and set, and the data packs saved on this device. Changes apply
 * at once and are remembered on this device (settings only; never the place). OWNER:
 * shell-design agent; the 12/24-hour clock and Data packs: packs agent; the Sights
 * section's index correction: navigate2 agent.
 */

import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import { packsSettings } from '../packs/settings-section.js';
import { lengthToMetres, metresToUnits } from './format.js';
import { shallowEqual, type AngleFormat, type HorizonOption, type HourCycle, type Theme, type TimeDisplay, type Units } from '../state.js';
import { segmented, switchRow, type Segmented } from '../theme/primitives.js';

export function settingsPanel(ctx: Ctx): { el: HTMLElement; refresh(): void; destroy(): void } {
  const { store } = ctx;
  const d = disposer();
  const s0 = store.get().settings;
  const set = <K extends keyof typeof s0>(key: K, value: (typeof s0)[K]): void => store.patch({ settings: { [key]: value } });

  const theme = segmented<Theme>({
    label: 'Theme',
    value: s0.theme,
    size: 'sm',
    options: [
      { value: 'system', label: 'Auto', icon: 'auto', tip: 'Light or dark, as this device is set' },
      { value: 'light', label: 'Light', icon: 'sun' },
      { value: 'dark', label: 'Dark', icon: 'moon' },
      { value: 'night', label: 'Night', icon: 'eye', tip: 'Night vision: red on black, keeps your eyes adapted to the dark' },
    ],
    onChange: (v) => set('theme', v),
  });
  const times = segmented<TimeDisplay>({
    label: 'Times',
    value: s0.timeDisplay,
    size: 'sm',
    options: [
      { value: 'local', label: 'Local first' },
      { value: 'utc', label: 'UTC first' },
    ],
    onChange: (v) => set('timeDisplay', v),
  });
  const cycle = segmented<HourCycle>({
    label: 'Clock',
    value: s0.hourCycle,
    size: 'sm',
    options: [
      { value: 'h23', label: '24-hour', tip: '18:40' },
      { value: 'h12', label: '12-hour', tip: '6:40 PM. UTC stays on the 24-hour clock.' },
    ],
    onChange: (v) => set('hourCycle', v),
  });
  const angles = segmented<AngleFormat>({
    label: 'Angles',
    value: s0.angleFormat,
    size: 'sm',
    options: [
      { value: 'dm', label: '26° 02.3′', tip: 'Degrees and minutes, as navigators write them' },
      { value: 'dms', label: '26° 02′ 17″', tip: 'Degrees, minutes and seconds' },
      { value: 'decimal', label: '26.038°', tip: 'Decimal degrees' },
    ],
    onChange: (v) => set('angleFormat', v),
  });
  const units = segmented<Units>({
    label: 'Units',
    value: s0.units,
    size: 'sm',
    options: [
      { value: 'metric', label: 'Metric', tip: 'Metres and kilometres' },
      { value: 'nautical', label: 'Nautical', tip: 'Metres and nautical miles' },
      { value: 'imperial', label: 'Imperial', tip: 'Feet and statute miles' },
    ],
    onChange: (v) => set('units', v),
  });
  const horizon = segmented<HorizonOption>({
    label: 'Rise and set',
    value: s0.horizon,
    size: 'sm',
    options: [
      { value: 'standard', label: 'Sea level', tip: 'Rise and set on a sea-level horizon (the almanac’s)' },
      { value: 'dip', label: 'Dipped', tip: 'Rise and set on the horizon you see from your height of eye' },
    ],
    onChange: (v) => set('horizon', v),
  });
  const terms = switchRow({
    label: 'Navigator’s terms',
    note: 'altitude, azimuth, GHA … beside the plain words',
    checked: s0.navigatorTerms,
    onChange: (v) => set('navigatorTerms', v),
  });
  const packs = packsSettings(ctx.packs);
  d.add(packs.destroy);
  const eye = h('input', { class: 'sf-input sf-num', type: 'number', min: 0, max: 500, step: 'any', inputmode: 'decimal', id: 'sf-set-eye' });
  const eyeUnit = h('span', { class: 'sf-editor__unit' });
  eye.addEventListener('change', () => {
    const m = lengthToMetres(Number(eye.value), store.get().settings.units);
    if (Number.isFinite(m) && m >= 0 && m <= 500) set('height_of_eye_m', Number(m.toFixed(2)));
  });
  // Sights section, navigate2 (expansion programme): the stored index correction, added to
  // every reading (on the arc 1.5′ → −1.5), used by Tonight's sights and new sessions.
  const ic = h('input', { class: 'sf-input sf-num', type: 'number', min: -60, max: 60, step: 0.1, inputmode: 'decimal', id: 'sf-set-ic' });
  ic.addEventListener('change', () => {
    const v = Number(ic.value);
    if (ic.value.trim() !== '' && Number.isFinite(v) && v >= -60 && v <= 60) set('index_correction_arcmin', Number(v.toFixed(2)));
    else ic.value = String(store.get().settings.index_correction_arcmin);
  });

  const row = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
    h('div', { class: 'sf-settings__row' }, h('span', { class: 'sf-settings__label' }, label), control, hint ? h('span', { class: 'sf-settings__hint' }, hint) : null);
  const el = h(
    'div',
    { class: 'sf-settings' },
    h('div', { class: 'sf-popover__title' }, 'Display'),
    row('Theme', theme.el),
    row('Times', times.el),
    row('Clock', cycle.el),
    row('Angles', angles.el),
    row('Units', units.el),
    terms,
    h('div', { class: 'sf-popover__title' }, 'Sights'),
    row('Rise and set', horizon.el),
    h(
      'div',
      { class: 'sf-settings__row' },
      h('label', { class: 'sf-settings__label', for: 'sf-set-eye' }, 'Height of eye'),
      h('div', { class: 'sf-editor__with-unit' }, eye, eyeUnit),
    ),
    h(
      'div',
      { class: 'sf-settings__row' },
      h('label', { class: 'sf-settings__label', for: 'sf-set-ic' }, 'Index correction'),
      h('div', { class: 'sf-editor__with-unit' }, ic, h('span', { class: 'sf-editor__unit' }, '′ added')),
    ),
    h('p', { class: 'sf-settings__note' }, 'Index correction: on the arc 1.5′ → −1.5. Used by tonight’s sights and new sessions in Navigate.'),
    h('p', { class: 'sf-settings__note' }, 'Settings are remembered on this device. Your place is not.'),
    packs.el,
  );

  const segs: [Segmented<string>, (s: typeof s0) => string][] = [
    [theme as Segmented<string>, (s) => s.theme],
    [times as Segmented<string>, (s) => s.timeDisplay],
    [cycle as Segmented<string>, (s) => s.hourCycle],
    [angles as Segmented<string>, (s) => s.angleFormat],
    [units as Segmented<string>, (s) => s.units],
    [horizon as Segmented<string>, (s) => s.horizon],
  ];
  d.add(
    watch(
      ctx,
      (s) => s.settings,
      (s) => {
        for (const [seg, pick] of segs) seg.set(pick(s));
        terms.setAttribute('aria-checked', String(s.navigatorTerms));
        if (document.activeElement !== eye) eye.value = String(Number(metresToUnits(s.height_of_eye_m, s.units).toFixed(2)));
        if (document.activeElement !== ic) ic.value = String(s.index_correction_arcmin);
        eyeUnit.textContent = s.units === 'imperial' ? 'ft' : 'm';
      },
      { equals: shallowEqual },
    ),
  );
  return { el, refresh: packs.refresh, destroy: () => d.dispose() };
}
