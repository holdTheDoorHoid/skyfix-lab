/**
 * The installable app: the web app manifest (web/public/manifest.webmanifest), its icons,
 * the explorer page's links to them, and which pages a production build ships
 * (web/vite.config.ts): the app's two pages, never the developer pages.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { UserConfig } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import viteConfig from '../vite.config.ts';

const WEB = resolve(import.meta.dirname, '..');
const PUBLIC = resolve(WEB, 'public');
const read = (path: string): string => readFileSync(resolve(WEB, path), 'utf8');

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}
const manifest = JSON.parse(read('public/manifest.webmanifest')) as Record<string, unknown> & { icons: Icon[] };

/** The light theme's value of a token in tokens.css (the theme the page starts in). */
function lightToken(name: string): string {
  const css = read('src/next/theme/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = /:root,\s*:root\[data-theme='light'\]\s*\{([^}]*)\}/.exec(css)?.[1];
  const value = block && new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1];
  if (!value) throw new Error(`no ${name} in the light theme`);
  return value.trim();
}

/** Width, height and colour type from a PNG's IHDR chunk. */
function png(path: string): { width: number; height: number; colourType: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes[25]! };
}

describe('web app manifest', () => {
  it('names the app and opens the explorer, relative to the site', () => {
    expect(manifest.name).toBe('SkyFix Lab');
    expect(manifest.short_name).toBe('SkyFix');
    expect(manifest.start_url).toBe('./next/');
    expect(manifest.scope).toBe('./next/');
    expect(manifest.display).toBe('standalone');
    // A fixed identity, so moving start_url to ./ (release phase 2) keeps installed copies
    // the same app. Resolved against the origin: https://holdthedoorhoid.github.io/skyfix-lab/.
    expect(manifest.id).toBe('skyfix-lab/');
    for (const key of ['start_url', 'scope', 'id']) expect(String(manifest[key])).not.toMatch(/^\/|^[a-z]+:/i);
  });

  it('takes its colours from the design tokens', () => {
    const chrome = lightToken('--chrome-bg-0');
    expect(manifest.theme_color).toBe(chrome);
    // The page's own background (base.css: html, body use --chrome-bg-0), so the splash
    // screen hands over to the page without a flash.
    expect(manifest.background_color).toBe(chrome);
    expect(read('src/next/theme/base.css')).toMatch(/background:\s*var\(--chrome-bg-0\)/);
    // The address-bar colour before and after the theme code runs.
    expect(read('next/index.html')).toContain(`<meta name="theme-color" content="${chrome}" />`);
    expect(read('src/next/theme/theme.ts')).toContain(`light: '${chrome}'`);
  });

  it('has 192 and 512 pixel icons and a maskable one, all present at their stated sizes', () => {
    const pngs = manifest.icons.filter((i) => i.type === 'image/png');
    expect(pngs.map((i) => `${i.sizes} ${i.purpose}`).sort()).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
    for (const icon of manifest.icons) {
      expect(icon.src).not.toMatch(/^\/|^[a-z]+:/i);
      const file = resolve(PUBLIC, icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      if (icon.type !== 'image/png') continue;
      const [w, h] = icon.sizes.split('x').map(Number);
      const info = png(file);
      expect([info.width, info.height]).toEqual([w, h]);
      // A maskable icon is cropped by the launcher: no transparent pixels to show through.
      if (icon.purpose === 'maskable') expect(info.colourType).toBe(2);
    }
  });

  it('has an opaque 180 pixel icon for iOS home screens', () => {
    expect(png(resolve(PUBLIC, 'icons/apple-touch-icon.png'))).toEqual({ width: 180, height: 180, colourType: 2 });
  });
});

describe('the explorer page', () => {
  const html = read('next/index.html');

  it('links the manifest and icons by their public paths (Vite makes them relative)', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
    for (const href of html.matchAll(/href="\/([^"]+)"/g)) expect(existsSync(resolve(PUBLIC, href[1]!)), href[1]).toBe(true);
  });

  it('starts offline support from its entry module', () => {
    expect(read('src/next/main.ts')).toMatch(/^startPwa\(\);$/m);
    expect(read('src/main.ts')).toMatch(/^startWorkbenchPwa\(\);$/m);
  });
});

describe('what a production build ships', () => {
  const saved = process.env.SKYFIX_DEV_PAGES;
  afterEach(() => {
    if (saved === undefined) delete process.env.SKYFIX_DEV_PAGES;
    else process.env.SKYFIX_DEV_PAGES = saved;
  });

  const inputs = (command: 'build' | 'serve'): string[] => {
    const config = (viteConfig as (env: { command: 'build' | 'serve'; mode: string }) => UserConfig)({ command, mode: 'production' });
    return Object.values((config.build?.rollupOptions?.input ?? {}) as Record<string, string>)
      .map((p) => p.slice(WEB.length + 1))
      .sort();
  };
  const devPages = readdirSync(resolve(WEB, 'next'))
    .filter((f) => f.endsWith('.html') && f !== 'index.html')
    .map((f) => `next/${f}`);

  it('builds only the app pages', () => {
    delete process.env.SKYFIX_DEV_PAGES;
    expect(inputs('build')).toEqual(['index.html', 'next/index.html']);
  });

  it('serves every developer page in development', () => {
    expect(devPages).toEqual(expect.arrayContaining(['next/mockup.html', 'next/dev-map.html']));
    expect(inputs('serve')).toEqual(['index.html', 'next/index.html', ...devPages].sort());
  });

  it('builds them locally on request (SKYFIX_DEV_PAGES=1)', () => {
    process.env.SKYFIX_DEV_PAGES = '1';
    expect(inputs('build')).toEqual(['index.html', 'next/index.html', ...devPages].sort());
  });

  it('precaches only files that exist in public/ or come from the build', () => {
    const config = (viteConfig as (env: { command: 'build'; mode: string }) => UserConfig)({ command: 'build', mode: 'production' });
    expect((config.plugins ?? []).map((p) => (p as { name?: string }).name)).toContain('skyfix-pwa');
    for (const file of ['data/gazetteer.json', 'data/basemap/manifest.json', 'manifest.webmanifest']) {
      expect(existsSync(resolve(PUBLIC, file)), file).toBe(true);
    }
  });
});
