/**
 * Fonts for the map's labels, with nothing fetched from anywhere but the site. OWNER: map
 * agent.
 *
 * MapLibre normally draws text from pre-rendered glyph files (PBF ranges) on a glyph
 * server. MapLibre 6 draws every glyph itself instead (TinySDF on a canvas) when the style
 * has no `glyphs` URL, using the `text-font` names as CSS font families and taking the
 * weight and style from words in the name ("Semibold", "Italic"). So the map registers the
 * site's own Inter files (OFL, bundled from @fontsource-variable/inter, the same files the
 * interface uses) under three family names of its own, and asks for those names in
 * `text-font`. No glyph files are generated or committed, and no CDN is involved.
 */

import latinExtItalic from '@fontsource-variable/inter/files/inter-latin-ext-wght-italic.woff2?url';
import latinExt from '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url';
import latinItalic from '@fontsource-variable/inter/files/inter-latin-wght-italic.woff2?url';
import latin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import vietnameseItalic from '@fontsource-variable/inter/files/inter-vietnamese-wght-italic.woff2?url';
import vietnamese from '@fontsource-variable/inter/files/inter-vietnamese-wght-normal.woff2?url';

/** `text-font` stacks. The weight and style words are what MapLibre reads. */
export const MAP_FONTS = {
  regular: ['SkyFix Map Regular'],
  semibold: ['SkyFix Map Semibold'],
  italic: ['SkyFix Map Italic'],
} as const;

// Unicode ranges of the @fontsource subsets (their wght.css).
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const VIETNAMESE =
  'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB';

let registered: Promise<void> | null = null;

/**
 * Register the families once per page and start loading them (about 250 KB, same origin).
 * Resolves when they are ready; a failure is not fatal (labels then use the system
 * sans-serif), so the promise always resolves.
 */
export function registerMapFonts(): Promise<void> {
  if (registered) return registered;
  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) {
    registered = Promise.resolve();
    return registered;
  }
  const faces: FontFace[] = [];
  const add = (family: string, url: string, range: string, style: 'normal' | 'italic') => {
    const face = new FontFace(family, `url(${url}) format('woff2')`, {
      style,
      weight: '100 900',
      unicodeRange: range,
      display: 'block',
    });
    document.fonts.add(face);
    faces.push(face);
  };
  for (const family of [MAP_FONTS.regular[0], MAP_FONTS.semibold[0]]) {
    add(family, latin, LATIN, 'normal');
    add(family, latinExt, LATIN_EXT, 'normal');
    add(family, vietnamese, VIETNAMESE, 'normal');
  }
  add(MAP_FONTS.italic[0], latinItalic, LATIN, 'italic');
  add(MAP_FONTS.italic[0], latinExtItalic, LATIN_EXT, 'italic');
  add(MAP_FONTS.italic[0], vietnameseItalic, VIETNAMESE, 'italic');
  // The same files back several families; the browser fetches each URL once.
  registered = Promise.allSettled(faces.map((f) => f.load())).then(() => undefined);
  return registered;
}
