/**
 * Keeps the theme on screen in step with the setting: `system` follows the device's light
 * or dark preference (never night vision) until the person picks a theme. OWNER:
 * shell-design agent.
 */

import type { ExplorerStore, Theme } from '../state.js';
import { applyTheme, followSystemTheme, systemTheme, type ThemeName } from '../theme/theme.js';

/** The theme to show for a setting, given whether the device prefers dark. */
export function effectiveTheme(setting: Theme, systemDark: boolean): ThemeName {
  if (setting === 'system') return systemDark ? 'dark' : 'light';
  return setting;
}

export const THEME_CHOICES: readonly { value: Theme; label: string; hint: string }[] = [
  { value: 'system', label: 'Automatic', hint: 'Light or dark, as this device is set' },
  { value: 'light', label: 'Light', hint: 'Light map, dark panel' },
  { value: 'dark', label: 'Dark', hint: 'Navy map and panel' },
  { value: 'night', label: 'Night vision', hint: 'Red on black: keeps your eyes adapted to the dark' },
];

/** Apply the theme now and whenever the setting or the device preference changes. */
export function startThemeController(store: ExplorerStore, win: Window = window): () => void {
  const apply = (): void => {
    applyTheme(effectiveTheme(store.get().settings.theme, systemTheme(win) === 'dark'));
  };
  apply();
  const stopSelect = store.select((s) => s.settings.theme, apply);
  const stopSystem = followSystemTheme(apply, () => store.get().settings.theme === 'system', win);
  return () => {
    stopSelect();
    stopSystem();
  };
}
