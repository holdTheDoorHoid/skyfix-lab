/**
 * Views read the theme on screen (`<html data-theme>`: theme/theme.ts `currentTheme`,
 * `onThemeChange`), never the `theme` setting, which may be `system` (the device decides,
 * and can change its mind without the setting changing). Only the code that APPLIES the
 * setting may read it: the shell's theme controller and its two controls, the store, and
 * the developer pages, which are their own shells.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../src/next');
const ALLOWED = new Set(['state.ts', 'shell/themes.ts', 'shell/appbar.ts', 'shell/settings.ts']);
const DEV = /(^|\/)(dev|mockup|harness)(\/|$)|\/dev\.ts$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** The source without its comments (a comment may say "nothing here reads settings.theme"). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('theme reads', () => {
  it('no view reads settings.theme; they read the theme on the document', () => {
    const offenders = files(ROOT)
      .map((path) => relative(ROOT, path).split('\\').join('/'))
      .filter((rel) => !ALLOWED.has(rel) && !DEV.test(rel))
      .filter((rel) => /settings\??\.theme\b|\.settings\.theme\b/.test(code(readFileSync(join(ROOT, rel), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
