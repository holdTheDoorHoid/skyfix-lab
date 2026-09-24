/**
 * Applying a theme: `data-theme` on `<html>`, the browser's `color-scheme`, and the
 * mobile address-bar colour. OWNER: shell-design agent.
 *
 * Until the person picks a theme, the page follows the system (`prefers-color-scheme`:
 * light or dark). The red night-vision theme is only ever chosen on purpose.
 */

export type ThemeName = 'light' | 'dark' | 'night';

export const THEMES: readonly { id: ThemeName; label: string; hint: string }[] = [
  { id: 'light', label: 'Light', hint: 'Light map, dark panel' },
  { id: 'dark', label: 'Dark', hint: 'Navy map and panel' },
  { id: 'night', label: 'Night vision', hint: 'Red on black, keeps your eyes adapted to the dark' },
];

/** The system's preference, as one of our themes. */
export function systemTheme(win: Pick<Window, 'matchMedia'> | undefined = globalThis.window): ThemeName {
  try {
    return win?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The address-bar colour per theme: the app strip's colour (tokens.css `--chrome-bg-0`). */
const THEME_COLOR: Record<ThemeName, string> = {
  light: '#131a21',
  dark: '#060c17',
  night: '#000000',
};

/** Set the theme on the document. Returns the theme applied. */
export function applyTheme(theme: ThemeName, doc: Document = document): ThemeName {
  const root = doc.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
  let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = doc.createElement('meta');
    meta.name = 'theme-color';
    doc.head.appendChild(meta);
  }
  meta.content = THEME_COLOR[theme];
  return theme;
}

/** The theme currently on the document. */
export function currentTheme(doc: Document = document): ThemeName {
  const t = doc.documentElement.dataset.theme;
  return t === 'dark' || t === 'night' ? t : 'light';
}

/**
 * Follow the system's light/dark preference while `shouldFollow()` is true (the person
 * has not picked a theme). Returns the function that stops listening.
 */
export function followSystemTheme(
  onChange: (theme: ThemeName) => void,
  shouldFollow: () => boolean = () => true,
  win: Pick<Window, 'matchMedia'> | undefined = globalThis.window,
): () => void {
  let query: MediaQueryList | undefined;
  try {
    query = win?.matchMedia?.('(prefers-color-scheme: dark)');
  } catch {
    query = undefined;
  }
  if (!query) return () => undefined;
  const listener = (): void => {
    if (shouldFollow()) onChange(query.matches ? 'dark' : 'light');
  };
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** Notify when `data-theme` changes on the document (for views drawing with WebGL or canvas). */
export function onThemeChange(listener: (theme: ThemeName) => void, doc: Document = document): () => void {
  const observer = new MutationObserver(() => listener(currentTheme(doc)));
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
