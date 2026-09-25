/**
 * The installable app: the web app manifest (web/public/manifest.webmanifest), its icons,
 * the pages since the original workbench was retired (the explorer at the site root;
 * next/ and classic/ forwarding to it), and which pages a production build ships
 * (web/vite.config.ts): those three, never the developer pages.
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
  it('names the app and opens the explorer at the site root, relative to the site', () => {
    expect(manifest.name).toBe('SkyFix Lab');
    expect(manifest.short_name).toBe('SkyFix');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.display).toBe('standalone');
    // The identity has not changed since the explorer lived at ./next/, so copies installed
    // then are the same app and take the new start page. Resolved against the origin:
    // https://holdthedoorhoid.github.io/skyfix-lab/.
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
    expect(read('index.html')).toContain(`<meta name="theme-color" content="${chrome}" />`);
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

describe('the pages', () => {
  const explorer = read('index.html');
  const moved = read('next/index.html');
  const retired = read('classic/index.html');

  it('the explorer is the home page, and links the manifest and the iOS icon', () => {
    expect(explorer).toContain('<script type="module" src="/src/next/main.ts"></script>');
    expect(explorer).toContain('Simulation and analysis workbench. Not a navigation instrument.');
    // Public paths; Vite makes them relative to the page.
    expect(explorer).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(explorer).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
    for (const href of explorer.matchAll(/href="\/([^"]+)"/g)) expect(existsSync(resolve(PUBLIC, href[1]!)), href[1]).toBe(true);
  });

  it('next/ only forwards to the home page, keeping the query and the fragment (share links)', () => {
    expect(moved).toContain("location.replace('../' + location.search + location.hash);");
    expect(moved).toContain('<meta http-equiv="refresh" content="0; url=../" />');
    // The script runs before the refresh, which would drop the fragment.
    expect(moved.indexOf('location.replace')).toBeLessThan(moved.indexOf('http-equiv="refresh"'));
    expect(moved).toContain('<meta name="robots" content="noindex" />');
    expect(moved).not.toMatch(/type="module"|src=/);
  });

  it('classic/ (the retired workbench) only forwards to the explorer, saying where its views went', () => {
    // Its mapping is checked against the worker's in pwa-policy.test.ts.
    expect(retired).toContain('<meta name="robots" content="noindex" />');
    expect(retired).not.toMatch(/type="module"|src=/);
    expect(retired.replace(/\s+/g, ' ')).toContain('Everything it did is in the explorer');
  });

  it('the worker answers the same forwards: next/ and classic/ to the home page', () => {
    const config = (viteConfig as (env: { command: 'build'; mode: string }) => UserConfig)({ command: 'build', mode: 'production' });
    const input = config.build?.rollupOptions?.input as Record<string, string>;
    expect(input.next).toBe(resolve(WEB, 'next/index.html'));
    expect(input.classic).toBe(resolve(WEB, 'classic/index.html'));
    expect(read('vite.config.ts')).toMatch(/next: \{ file: 'next\/index\.html', from: 'next\/', to: '\.\/' \}/);
    expect(read('vite.config.ts')).toMatch(/classic: \{ file: 'classic\/index\.html', from: 'classic\/', to: '\.\/', fragments: CLASSIC_VIEWS \}/);
  });

  it('starts offline support from the entry module', () => {
    expect(read('src/next/main.ts')).toMatch(/^startPwa\(\);$/m);
  });

  it('never links the retired workbench, nor one level up (that leaves the site)', () => {
    for (const file of ['src/next/main.ts', 'src/next/shell/appbar.ts', 'src/next/about/view.ts']) {
      const text = read(file);
      expect(text, file).not.toContain("'classic/'");
      expect(text, file).not.toMatch(/href(: | = )'\.\.\/'/);
    }
    expect(existsSync(resolve(WEB, 'src/next/shell/placeholder.ts'))).toBe(false);
    for (const gone of ['src/main.ts', 'src/app.ts', 'src/store.ts', 'src/styles.css', 'src/views', 'src/pwa/workbench-prompt.ts']) {
      expect(existsSync(resolve(WEB, gone)), gone).toBe(false);
    }
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

  const shipped = ['classic/index.html', 'index.html', 'next/index.html'];

  it('builds only the app page and the two forwarding pages', () => {
    delete process.env.SKYFIX_DEV_PAGES;
    expect(inputs('build')).toEqual(shipped);
  });

  it('serves every developer page in development', () => {
    expect(devPages).toEqual(expect.arrayContaining(['next/mockup.html', 'next/dev-map.html']));
    expect(inputs('serve')).toEqual([...shipped, ...devPages].sort());
  });

  it('builds them locally on request (SKYFIX_DEV_PAGES=1)', () => {
    process.env.SKYFIX_DEV_PAGES = '1';
    expect(inputs('build')).toEqual([...shipped, ...devPages].sort());
  });

  it('precaches only files that exist in public/ or come from the build', () => {
    const config = (viteConfig as (env: { command: 'build'; mode: string }) => UserConfig)({ command: 'build', mode: 'production' });
    expect((config.plugins ?? []).map((p) => (p as { name?: string }).name)).toContain('skyfix-pwa');
    for (const file of ['data/gazetteer.json', 'data/basemap/manifest.json', 'manifest.webmanifest']) {
      expect(existsSync(resolve(PUBLIC, file)), file).toBe(true);
    }
    // Built by the packs plugin, which must come before the pwa plugin.
    const names = (config.plugins ?? []).map((p) => (p as { name?: string }).name);
    expect(names.indexOf('skyfix-packs')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('skyfix-packs')).toBeLessThan(names.indexOf('skyfix-pwa'));
    expect(existsSync(resolve(PUBLIC, 'data/packs/manifest.json'))).toBe(false);
  });
});
