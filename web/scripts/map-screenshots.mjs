#!/usr/bin/env node
/**
 * Screenshots of the explorer's map (web/next/dev-map.html) for review, written to
 * docs/design/local/map-<case>.png (git-ignored working copies; a few curated ones are
 * copied by hand to docs/design/map-view-<case>.png). Development tool only: Node built-ins and a local Chrome,
 * no npm dependency. OWNER: map agent.
 *
 *   npx vite --port 5191 --strictPort                  # in web/, in another terminal
 *   node scripts/map-screenshots.mjs                   # every case
 *   node scripts/map-screenshots.mjs light globe-dark  # some cases
 *   node scripts/map-screenshots.mjs --bench           # also time 240 frames of scrubbing
 *
 * Like design-screenshots.mjs this drives Chrome over the DevTools protocol, because
 * MapLibre draws in a worker and on animation frames, which `chrome --screenshot` does not
 * wait for. It waits for the map's own signals: `<html data-map-ready="1">`, the 1:50m data
 * and place names loaded (`.sfm[data-detail="1"][data-places="1"]`), tiles loaded, no motion.
 *
 * Environment: BASE (default http://localhost:5191), CHROME (default google-chrome),
 * OUT (default ../../docs/design/local relative to this file), ENGINE (e.g. `mock`).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:5191';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(here, '../../docs/design/local'));
const ENGINE = process.env.ENGINE ? `&engine=${process.env.ENGINE}` : '';

const DESKTOP = { width: 1440, height: 900, scale: 1 };
const PHONE = { width: 390, height: 844, scale: 2 };

const PHL = 'lat=39.9526&lon=-75.1652&place=Philadelphia%20City%20Hall&tz=America/New_York';
const AFTERNOON = 't=2026-09-24T20:30:00Z';

/** name -> [query, share fragment, viewport] */
const SHOTS = {
  light: ['theme=light', `${PHL}&${AFTERNOON}&body=Sun&view=map`, DESKTOP],
  dark: ['theme=dark', `${PHL}&${AFTERNOON}&body=Sun&view=map`, DESKTOP],
  night: ['theme=night', `${PHL}&${AFTERNOON}&body=Sun&view=map`, DESKTOP],
  'globe-light': ['theme=light&layers=graticule', `${PHL}&${AFTERNOON}&body=Sun&view=globe`, DESKTOP],
  'globe-dark': ['theme=dark&layers=circles', `${PHL}&t=2026-09-24T23:35:00Z&body=Moon&view=globe`, DESKTOP],
  'moon-evening': ['theme=light', `${PHL}&t=2026-09-24T23:35:00Z&body=Moon&view=map`, DESKTOP],
  // Tromso, 21 June at 23:30 local: the Sun never sets.
  'midnight-sun': [
    'theme=light&zoom=3',
    'lat=69.6492&lon=18.9553&place=Troms%C3%B8&tz=Europe/Oslo&t=2026-06-21T21:30:00Z&body=Sun&view=map',
    DESKTOP,
  ],
  // Suva, Fiji at sunrise: the terminator, the circle of equal altitude and the altitude rings
  // cross the antimeridian.
  antimeridian: [
    'theme=light&zoom=2.2&layers=circles,altitudeRings,graticule',
    'lat=-18.1416&lon=178.4419&place=Suva%2C%20Fiji&tz=Pacific/Fiji&t=2026-09-24T18:40:00Z&body=Sun&view=map',
    DESKTOP,
  ],
  // Philadelphia to London: the great circle and the rhumb line.
  measure: ['theme=light&zoom=2.3&measure=39.9526,-75.1652;51.5074,-0.1278', `${PHL}&${AFTERNOON}&body=Sun&view=map`, DESKTOP],
  // Overlays drawn by another view through the map service (Navigate, Events).
  overlays: ['theme=dark&zoom=1.6&overlay=demo', `${PHL}&${AFTERNOON}&body=Venus&view=map`, DESKTOP],
  'light-phone': ['theme=light', `${PHL}&${AFTERNOON}&body=Sun&view=map`, PHONE],
  'night-phone': ['theme=night', `${PHL}&t=2026-09-24T23:35:00Z&body=Moon&view=map`, PHONE],
  'globe-night': ['theme=night', `${PHL}&t=2026-09-24T23:35:00Z&body=Moon&view=globe`, DESKTOP],
};

const READY = [
  "document.documentElement.dataset.mapReady === '1'",
  "document.querySelector('.sfm')?.dataset.detail === '1'",
  "document.querySelector('.sfm')?.dataset.places === '1'",
  'window.__map?.loaded()',
  'window.__map?.areTilesLoaded()',
  '!window.__map?.isMoving()',
].join(' && ');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withChrome(view, fn) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'skyfix-map-shot-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${view.width},${view.height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    let page = null;
    for (let i = 0; i < 100 && !page; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        page = list.find((t) => t.type === 'page') ?? null;
      } catch {
        await sleep(100);
      }
    }
    if (!page) throw new Error('Chrome did not start');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, fail) => {
      ws.onopen = ok;
      ws.onerror = fail;
    });
    let id = 0;
    const pending = new Map();
    const logs = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') logs.push(msg.params.exceptionDetails.exception?.description ?? 'exception');
      if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
        logs.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      const p = msg.id && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.fail(new Error(JSON.stringify(msg.error)));
      else p.ok(msg.result);
    };
    const send = (method, params = {}) =>
      new Promise((ok, fail) => {
        const mid = ++id;
        pending.set(mid, { ok, fail });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: view.width,
      height: view.height,
      deviceScaleFactor: view.scale,
      mobile: view.width < 768,
    });
    if (view.width < 768) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const result = await fn(send);
    ws.close();
    for (const l of logs) if (!/vite|DevTools/.test(l)) console.log(`    console: ${l}`);
    return result;
  } finally {
    chrome.kill('SIGTERM');
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

async function waitFor(send, expression, timeoutMs) {
  for (const start = Date.now(); Date.now() - start < timeoutMs; ) {
    const r = await send('Runtime.evaluate', { expression: `(() => { try { return ${expression}; } catch { return false; } })()`, returnByValue: true }).catch(() => null);
    if (r?.result?.value === true) return true;
    await sleep(250);
  }
  return false;
}

async function shoot(name, query, fragment, view) {
  await withChrome(view, async (send) => {
    await send('Page.navigate', { url: `${BASE}/next/dev-map.html?bare=1&${query}${ENGINE}#v=1&${fragment}` });
    const ready = await waitFor(send, READY, 90_000);
    await sleep(1200);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `map-${name}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`map-${name}.png${ready ? '' : '  (NOT READY: the map may be incomplete)'}`);
  });
}

async function bench() {
  return withChrome(DESKTOP, async (send) => {
    await send('Page.navigate', { url: `${BASE}/next/dev-map.html?bare=1&theme=light&bench=240${ENGINE}#v=1&${PHL}&${AFTERNOON}&body=Sun&view=map` });
    await waitFor(send, READY, 90_000);
    const done = await waitFor(send, "window.__mapBench !== undefined", 400_000);
    const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__mapBench)', returnByValue: true });
    console.log(done ? `bench: ${r.result.value}` : 'bench: did not finish');
  });
}

mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const wanted = args.filter((a) => !a.startsWith('--'));
for (const [name, [query, fragment, view]] of Object.entries(SHOTS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  await shoot(name, query, fragment, view);
}
if (args.includes('--bench')) await bench();
