/**
 * The app strip across the top: the name, the honesty banner (always visible, never
 * dismissible), the engine badge, and Theme, Share, Settings and Help. On a phone the
 * theme lives in Settings. OWNER: shell-design agent.
 */

import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import { type Theme } from '../state.js';
import { icon } from '../theme/icons.js';
import { badge, button, iconButton, logoMark, popover, segmented } from '../theme/primitives.js';
import { settingsPanel } from './settings.js';
import { sharePanel } from './share.js';

export const HONESTY = 'Simulation and analysis workbench. Not a navigation instrument.';

function help(ctx: Ctx): HTMLElement {
  const key = (...keys: string[]): HTMLElement => h('span', { class: 'sf-help__keys' }, ...keys.map((k) => h('span', { class: 'sf-kbd' }, k)));
  const row = (keys: HTMLElement, text: string): HTMLElement => h('div', { class: 'sf-help__row' }, keys, h('span', {}, text));
  return h(
    'div',
    { class: 'sf-help' },
    h('div', { class: 'sf-popover__title' }, 'Keys for time'),
    row(key('←', '→'), '10 minutes back or on'),
    row(key('Shift', '←', '→'), 'an hour'),
    row(key('Alt', '←', '→'), 'a day'),
    row(key('PgUp', 'PgDn'), 'a month (with Shift, a year)'),
    row(key('Space'), 'play or pause'),
    row(key('N'), 'now: follow the clock'),
    row(key('Esc'), 'close a menu'),
    h('div', { class: 'sf-popover__title' }, 'This page'),
    h(
      'p',
      { class: 'sf-help__text' },
      'Choose a place and a moment; the panel says where the Sun, the Moon, the planets and the navigational stars are from there, and when they rise and set. ',
      ctx.engine.kind === 'wasm'
        ? 'Every number comes from the SkyFix Lab core, running in this page with no network.'
        : 'MOCK ENGINE: every number is illustrative.',
    ),
    h('p', { class: 'sf-help__text' }, h('strong', {}, HONESTY)),
    h('p', { class: 'sf-help__text' }, h('a', { href: '../' }, 'The current workbench'), ' (sights, corrections, the fix and the simulator) is one level up.'),
  );
}

export function appbar(ctx: Ctx): { el: HTMLElement; destroy(): void } {
  const { store, engine } = ctx;
  const d = disposer();

  const engineBadge =
    engine.kind === 'wasm'
      ? badge('wasm', {
          tip: 'Every number on this page comes from the SkyFix Lab numerical core (Rust, compiled to WebAssembly), running in this page.',
        })
      : badge('mock', { short: 'Mock', tip: engine.description });

  const themes = segmented<Theme>({
    label: 'Theme',
    value: store.get().settings.theme,
    size: 'sm',
    options: [
      { value: 'system', label: 'Automatic theme', icon: 'auto', iconOnly: true, tip: 'Automatic: light or dark, as this device is set' },
      { value: 'light', label: 'Light theme', icon: 'sun', iconOnly: true, tip: 'Light: light map, dark panel' },
      { value: 'dark', label: 'Dark theme', icon: 'moon', iconOnly: true, tip: 'Dark: navy map and panel' },
      { value: 'night', label: 'Night vision theme', icon: 'eye', iconOnly: true, tip: 'Night vision: red on black, keeps your eyes adapted to the dark' },
    ],
    onChange: (v) => store.patch({ settings: { theme: v } }),
  });
  d.add(watch(ctx, (s) => s.settings.theme, (t) => themes.set(t)));

  const shareButton = button({ label: 'Share', icon: 'share', variant: 'ghost', size: 'sm', class: 'sf-appbar__share', tip: 'Make a link to this place and time' });
  const settingsButton = iconButton('settings', 'Settings', { size: 'sm', tip: 'Settings: theme, times, angles, units' });
  const helpButton = iconButton('help', 'Help and keys', { size: 'sm', class: 'sf-appbar__wide', tip: 'Help and keys' });

  const share = sharePanel(ctx);
  const sharePop = popover(shareButton, share.el, { label: 'Share this view', placement: 'bottom-end', onOpen: share.refresh });
  const settings = settingsPanel(ctx);
  const settingsPop = popover(settingsButton, settings.el, { label: 'Settings', placement: 'bottom-end' });
  const helpPop = popover(helpButton, help(ctx), { label: 'Help and keys', placement: 'bottom-end' });
  d.add(() => sharePop.destroy());
  d.add(() => settingsPop.destroy());
  d.add(() => helpPop.destroy());
  d.add(settings.destroy);

  const el = h(
    'header',
    { class: 'sf-appbar' },
    h('a', { class: 'sf-brand', href: '#map', 'aria-label': 'SkyFix Lab: the map' }, logoMark(20), h('span', { class: 'sf-brand__text' }, 'SkyFix Lab')),
    h('span', { class: 'sf-appbar__rule', 'aria-hidden': 'true' }),
    h('div', { class: 'sf-honesty', role: 'note' }, h('span', { class: 'sf-honesty__text' }, icon('caution'), HONESTY), engineBadge),
    h('div', { class: 'sf-appbar__end' }, h('span', { class: 'sf-appbar__wide' }, themes.el), shareButton, settingsButton, helpButton),
  );
  return { el, destroy: () => d.dispose() };
}
