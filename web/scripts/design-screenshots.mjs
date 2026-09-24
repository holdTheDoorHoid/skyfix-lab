#!/usr/bin/env node
/**
 * Screenshots of the explorer for design review, written to docs/design/local/ (ignored by
 * git: working images; only a few curated copies are committed in docs/design/): the live
 * page at /next/ (the real engine, at a fixed moment given by a share link) and the static
 * design mockup at /next/mockup.html. Development tool only: Node built-ins and a local
 * Chrome, no npm dependency.
 *
 *   npx vite --port 5190 --strictPort          # in web/, in another terminal
 *   npm run wasm                               # once, for the real engine
 *   node scripts/design-screenshots.mjs        # every shot
 *   node scripts/design-screenshots.mjs app-dark mockup-kit-light
 *
 * Why not `chrome --headless --screenshot`: MapLibre and the explorer draw on animation
 * frames, which Chrome's virtual time does not wait for. This script drives Chrome over
 * the DevTools protocol and waits for the page's own "ready" signal (`<html
 * data-ready="1">`: the first frame painted with its fonts, or the mockup's map idle).
 *
 * Environment: BASE (default http://localhost:5190), CHROME (default google-chrome),
 * OUT (default ../../docs/design/local relative to this file).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:5190';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(here, '../../docs/design/local'));

const DESKTOP = { width: 1440, height: 900, scale: 1 };
const PHONE = { width: 390, height: 844, scale: 2 };

/** A share link (state.ts `encodeShare`): Philadelphia City Hall on 24 September 2026. */
function moment(utc, body) {
  const p = new URLSearchParams({
    v: '1',
    lat: '39.9526',
    lon: '-75.1652',
    place: 'Philadelphia City Hall',
    tz: 'America/New_York',
    t: utc,
    body,
    view: 'map',
  });
  return `#${p}`;
}
const AFTERNOON = moment('2026-09-24T20:30:00Z', 'Sun'); // 16:30 EDT
const EVENING = moment('2026-09-24T23:35:00Z', 'Moon'); // 19:35 EDT, nautical twilight

/** Settings stored before the page loads (the explorer keeps only settings and layers). */
const night = { settings: { theme: 'night' } };

/**
 * name -> [path with fragment, viewport, colour scheme, stored preferences].
 * Phones are shot at device pixel ratio 2 (780 x 1688 pixels).
 */
const SHOTS = {
  'app-light': [`/next/${AFTERNOON}`, DESKTOP, 'light'],
  'app-dark': [`/next/${AFTERNOON}`, DESKTOP, 'dark'],
  'app-night': [`/next/${EVENING}`, DESKTOP, 'dark', night],
  'app-evening-dark': [`/next/${EVENING}`, DESKTOP, 'dark'],
  'app-light-phone': [`/next/${AFTERNOON}`, PHONE, 'light'],
  'app-dark-phone': [`/next/${AFTERNOON}`, PHONE, 'dark'],
  'app-night-phone': [`/next/${EVENING}`, PHONE, 'dark', night],
  'app-about-light': [`/next/${AFTERNOON.replace('view=map', 'view=about')}`, DESKTOP, 'light'],
  'app-globe-dark': [`/next/${EVENING.replace('view=map', 'view=globe')}`, DESKTOP, 'dark'],
  'app-sky-dark': [`/next/${EVENING.replace('view=map', 'view=sky')}`, DESKTOP, 'dark'],
  'app-sky-night-phone': [`/next/${EVENING.replace('view=map', 'view=sky')}`, PHONE, 'dark', night],
  'app-charts-light': [`/next/${AFTERNOON.replace('view=map', 'view=charts')}`, DESKTOP, 'light'],
  'app-charts-night': [`/next/${EVENING.replace('view=map', 'view=charts')}`, DESKTOP, 'dark', night],
  'map-light': ['/next/mockup.html#theme=light', DESKTOP],
  'map-dark': ['/next/mockup.html#theme=dark', DESKTOP],
  'map-night': ['/next/mockup.html#theme=night', DESKTOP],
  'map-light-phone': ['/next/mockup.html#theme=light', PHONE],
  'map-dark-phone': ['/next/mockup.html#theme=dark', PHONE],
  'map-night-phone': ['/next/mockup.html#theme=night', PHONE],
  'evening-light': ['/next/mockup.html#theme=light&moment=evening', DESKTOP],
  'evening-night': ['/next/mockup.html#theme=night&moment=evening', DESKTOP],
  'evening-night-phone': ['/next/mockup.html#theme=night&moment=evening', PHONE],
  'evening-dark-panel': ['/next/mockup.html#theme=dark&moment=evening&scroll=470', DESKTOP],
  'kit-light': ['/next/mockup.html#theme=light&screen=kit', { width: 1440, height: 3560, scale: 1 }],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(name, path, view, scheme, prefs) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'skyfix-shot-'));
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
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
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
    await send('Emulation.setDeviceMetricsOverride', {
      width: view.width,
      height: view.height,
      deviceScaleFactor: view.scale,
      mobile: view.width < 768,
    });
    if (view.width < 768) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    if (scheme) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    if (prefs) {
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { localStorage.setItem('skyfix.explorer.prefs.v1', ${JSON.stringify(JSON.stringify(prefs))}); } catch {}`,
      });
    }
    await send('Page.navigate', { url: `${BASE}${path}` });
    // The page's first frame; on the Map and Globe views also the map's detail data and place
    // names (map/map-view.ts sets them on its root when they have loaded).
    const map = /[#&]view=(map|globe)\b/.test(path);
    const expression = [
      "document.documentElement.dataset.ready === '1'",
      ...(map ? ["document.querySelector('.sfm')?.dataset.detail === '1'", "document.querySelector('.sfm')?.dataset.places === '1'"] : []),
    ].join(' && ');
    let ready = false;
    for (const start = Date.now(); Date.now() - start < 90_000 && !ready; ) {
      await sleep(250);
      const r = await send('Runtime.evaluate', { expression, returnByValue: true }).catch(() => null);
      ready = r?.result?.value === true;
    }
    await sleep(map ? 4000 : 1500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
    ws.close();
    console.log(`${name}.png${ready ? '' : '  (not ready: the page may be incomplete)'}`);
  } finally {
    chrome.kill('SIGTERM');
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const [name, [path, view, scheme, prefs]] of Object.entries(SHOTS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  await shoot(name, path, view, scheme, prefs);
}
