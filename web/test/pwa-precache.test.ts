/**
 * The precache list generator (web/plugins/precache.ts), on a small built site shaped
 * like Vite's output: which files the app's pages reach, what is left out, and how the
 * version follows the content.
 */

import { describe, expect, it } from 'vitest';
import { listedFiles, pageAddress, precacheList, revisionOf, type PrecacheInput } from '../plugins/precache.ts';

const enc = new TextEncoder();

/** A built site, laid out as since the switch-over: the explorer at the root, the original
 * workbench at classic/, the /next/ redirect page; a lazy view, the WebAssembly module, a
 * font through CSS, a map worker, development-only chunks, a developer page, data files. */
function site(overrides: Record<string, string> = {}): Map<string, Uint8Array> {
  const text: Record<string, string> = {
    'classic/index.html':
      '<script type="module" src="../assets/classic-AAAA1111.js"></script><link rel="stylesheet" href="../assets/classic-BBBB2222.css">',
    'index.html':
      '<link rel="manifest" href="./manifest.webmanifest"><script type="module" src="./assets/explorer-CCCC3333.js"></script><link rel="modulepreload" href="./assets/dom-DDDD4444.js">',
    'next/index.html': '<script>location.replace("../" + location.search + location.hash)</script>',
    'next/dev-map.html': '<script type="module" src="../assets/devMap-EEEE5555.js"></script>',
    'assets/classic-AAAA1111.js': 'import"./dom-DDDD4444.js";const w=()=>import("./skyfix_wasm-FFFF6666.js");',
    'assets/classic-BBBB2222.css': 'body{margin:0}',
    'assets/explorer-CCCC3333.js':
      'import"./dom-DDDD4444.js";const s=()=>import("./shell-GGGG7777.js"),m=()=>import("./mock-HHHH8888.js"),w=()=>import("./skyfix_wasm-FFFF6666.js");',
    'assets/dom-DDDD4444.js': 'export const h=1;',
    'assets/shell-GGGG7777.js': 'const v=()=>import("./map-IIII9999.js");const f=new URL("inter-latin-JJJJ0000.woff2",import.meta.url);',
    'assets/shell-KKKK1111.css': '@font-face{src:url(./jetbrains-mono-LLLL2222.woff2)}',
    'assets/map-IIII9999.js': 'new Worker(new URL("maplibre-gl-worker-MMMM3333.js",import.meta.url));/* shell-KKKK1111.css */',
    'assets/maplibre-gl-worker-MMMM3333.js': 'self.onmessage=()=>{};',
    'assets/skyfix_wasm-FFFF6666.js': 'new URL("skyfix_wasm_bg-NNNN4444.wasm",import.meta.url)',
    'assets/mock-HHHH8888.js': 'import"./mockdata-OOOO5555.js";',
    'assets/mockdata-OOOO5555.js': 'export const stars=[];',
    'assets/devMap-EEEE5555.js': 'import"./map-IIII9999.js";import"./devonly-PPPP6666.js";',
    'assets/devonly-PPPP6666.js': '',
    'assets/mockup-QQQQ7777.geojson': '{}',
    'manifest.webmanifest': '{"icons":[{"src":"icons/icon-192.png"}]}',
    'data/basemap/manifest.json': '{"files":[{"path":"land-110m.geojson"},{"path":"lakes-50m.geojson"}]}',
    'data/basemap/land-110m.geojson': '{"type":"FeatureCollection","features":[]} assets/devonly-PPPP6666.js',
    'data/basemap/lakes-50m.geojson': '{"type":"FeatureCollection","features":[]}',
    'data/gazetteer.json': '{"places":[]}',
    ...overrides,
  };
  const files = new Map<string, Uint8Array>(Object.entries(text).map(([k, v]) => [k, enc.encode(v)]));
  files.set('assets/skyfix_wasm_bg-NNNN4444.wasm', new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  files.set('assets/inter-latin-JJJJ0000.woff2', new Uint8Array([119, 79, 70, 50]));
  files.set('assets/jetbrains-mono-LLLL2222.woff2', new Uint8Array([119, 79, 70, 50, 2]));
  files.set('icons/icon-192.png', new Uint8Array([137, 80, 78, 71]));
  return files;
}

function input(files = site(), more: Partial<PrecacheInput> = {}): PrecacheInput {
  return {
    files,
    pages: ['index.html', 'classic/index.html'],
    extra: [...listedFiles('data/basemap/manifest.json', '{"files":[{"path":"land-110m.geojson"},{"path":"lakes-50m.geojson"}]}'), 'data/gazetteer.json', 'manifest.webmanifest', 'icons/icon-192.png'],
    exclude: new Set(['assets/mock-HHHH8888.js']),
    ...more,
  };
}

const urls = (inp: PrecacheInput): string[] => precacheList(inp).entries.map((e) => e.url);

describe('precacheList', () => {
  it('follows the pages to everything they can load, lazy views included', () => {
    expect(urls(input())).toEqual([
      'assets/classic-AAAA1111.js',
      'assets/classic-BBBB2222.css',
      'assets/dom-DDDD4444.js',
      'assets/explorer-CCCC3333.js',
      'assets/inter-latin-JJJJ0000.woff2',
      'assets/jetbrains-mono-LLLL2222.woff2',
      'assets/map-IIII9999.js',
      'assets/maplibre-gl-worker-MMMM3333.js',
      'assets/shell-GGGG7777.js',
      'assets/shell-KKKK1111.css',
      'assets/skyfix_wasm-FFFF6666.js',
      'assets/skyfix_wasm_bg-NNNN4444.wasm',
      'classic/index.html',
      'data/basemap/lakes-50m.geojson',
      'data/basemap/land-110m.geojson',
      'data/basemap/manifest.json',
      'data/gazetteer.json',
      'icons/icon-192.png',
      'index.html',
      'manifest.webmanifest',
    ]);
    // The /next/ redirect page is neither an app page nor reached from one.
    expect(urls(input())).not.toContain('next/index.html');
  });

  it('neither stores nor follows excluded files, and never includes developer pages', () => {
    const list = precacheList(input());
    expect(list.entries.map((e) => e.url)).not.toContain('assets/mock-HHHH8888.js');
    // Reached only through the excluded mock engine.
    expect(list.entries.map((e) => e.url)).not.toContain('assets/mockdata-OOOO5555.js');
    // A developer page and what only it loads.
    expect(list.entries.map((e) => e.url)).not.toContain('next/dev-map.html');
    expect(list.entries.map((e) => e.url)).not.toContain('assets/devMap-EEEE5555.js');
    // Data files are leaves: a name inside them is not a reference.
    expect(list.entries.map((e) => e.url)).not.toContain('assets/devonly-PPPP6666.js');
    expect(list.unreached).toEqual([
      'assets/devMap-EEEE5555.js',
      'assets/devonly-PPPP6666.js',
      'assets/mock-HHHH8888.js',
      'assets/mockdata-OOOO5555.js',
      'assets/mockup-QQQQ7777.geojson',
    ]);
  });

  it('reports site files outside assets/ that nobody precaches (a new data file, a developer page, a redirect)', () => {
    const files = site({ 'data/stars.json': '[]' });
    expect(precacheList(input(files)).unlisted).toEqual(['data/stars.json', 'next/dev-map.html', 'next/index.html']);
  });

  it('follows an excluded file’s dependencies when an app file also needs them', () => {
    const files = site({ 'assets/dom-DDDD4444.js': 'import"./mockdata-OOOO5555.js";' });
    expect(urls(input(files))).toContain('assets/mockdata-OOOO5555.js');
  });

  it('records each file’s content hash and size, and the total', () => {
    const files = site();
    const list = precacheList(input(files));
    for (const entry of list.entries) {
      const bytes = files.get(entry.url) as Uint8Array;
      expect(entry.rev).toBe(revisionOf(bytes));
      expect(entry.bytes).toBe(bytes.byteLength);
    }
    expect(list.bytes).toBe(list.entries.reduce((s, e) => s + e.bytes, 0));
  });

  it('changes version when any precached file changes, and only then', () => {
    const base = precacheList(input()).version;
    expect(precacheList(input()).version).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    // A precached file: new version.
    expect(precacheList(input(site({ 'data/gazetteer.json': '{"places":[1]}' }))).version).not.toBe(base);
    expect(precacheList(input(site({ 'assets/dom-DDDD4444.js': 'export const h=2;' }))).version).not.toBe(base);
    // A file nobody precaches: same version.
    expect(precacheList(input(site({ 'assets/devonly-PPPP6666.js': 'changed' }))).version).toBe(base);
  });

  it('does not take a generic name in a script for a reference to a page', () => {
    const files = site({ 'assets/dom-DDDD4444.js': 'const a="index.html",b="dev-map.html";' });
    const list = urls(input(files));
    expect(list).not.toContain('next/dev-map.html');
    expect(list.filter((u) => u.endsWith('index.html'))).toEqual(['classic/index.html', 'index.html']);
  });

  it('fails loudly when a page or a listed file is missing from the build', () => {
    expect(() => precacheList(input(site(), { pages: ['index.html', 'about.html'] }))).toThrow(/page about\.html/);
    expect(() => precacheList(input(site(), { extra: ['data/stars.bin'] }))).toThrow(/data\/stars\.bin/);
  });

  it('refuses paths outside the site', () => {
    expect(() => precacheList(input(site(), { extra: ['/etc/passwd'] }))).toThrow(/relative/);
    expect(() => precacheList(input(site(), { extra: ['../secret'] }))).toThrow(/relative/);
  });
});

describe('listedFiles', () => {
  it('lists a manifest’s files relative to it, and the manifest itself', () => {
    expect(listedFiles('data/basemap/manifest.json', '{"files":[{"path":"land-110m.geojson"},{"path":"sub/x.geojson"}]}')).toEqual([
      'data/basemap/manifest.json',
      'data/basemap/land-110m.geojson',
      'data/basemap/sub/x.geojson',
    ]);
  });

  it('rejects a manifest without a file list or with a pathless file', () => {
    expect(() => listedFiles('m.json', '{}')).toThrow(/files/);
    expect(() => listedFiles('m.json', '{"files":[{}]}')).toThrow(/path/);
  });
});

describe('pageAddress', () => {
  it('turns an index page into its directory address', () => {
    expect(pageAddress('index.html')).toBe('./');
    expect(pageAddress('classic/index.html')).toBe('classic/');
    expect(pageAddress('print.html')).toBe('print.html');
  });
});
