#!/usr/bin/env node
/**
 * Screenshots of the explorer's design mockup (web/next/mockup.html) for design review,
 * written to docs/design/. Development tool only: Node built-ins and a local Chrome, no
 * npm dependency.
 *
 *   npx vite --port 5190 --strictPort          # in web/, in another terminal
 *   node scripts/design-screenshots.mjs        # all shots
 *   node scripts/design-screenshots.mjs map-dark evening-night
 *
 * Why not `chrome --headless --screenshot`: MapLibre draws in a web worker and on
 * animation frames, which Chrome's virtual time does not wait for, so those shots come
 * out without a map. This script drives Chrome over the DevTools protocol and waits for
 * the mockup's own "ready" signal (`<html data-ready="1">`, set once the map is idle and
 * the fonts are loaded).
 *
 * Environment: BASE (default http://localhost:5190), CHROME (default google-chrome),
 * OUT (default ../docs/design relative to this file).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:5190';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(here, '../../docs/design'));

const DESKTOP = { width: 1440, height: 900, scale: 1 };
const PHONE = { width: 390, height: 844, scale: 2 };

/** name -> [fragment, viewport]. Phones are shot at device pixel ratio 2 (780 x 1688 pixels). */
const SHOTS = {
  'map-light': ['theme=light', DESKTOP],
  'map-dark': ['theme=dark', DESKTOP],
  'map-night': ['theme=night', DESKTOP],
  'map-light-phone': ['theme=light', PHONE],
  'map-dark-phone': ['theme=dark', PHONE],
  'map-night-phone': ['theme=night', PHONE],
  'evening-light': ['theme=light&moment=evening', DESKTOP],
  'evening-night': ['theme=night&moment=evening', DESKTOP],
  'evening-night-phone': ['theme=night&moment=evening', PHONE],
  'evening-dark-panel': ['theme=dark&moment=evening&scroll=470', DESKTOP],
  'kit-light': ['theme=light&screen=kit', { width: 1440, height: 3560, scale: 1 }],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(name, fragment, view) {
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
    await send('Page.navigate', { url: `${BASE}/next/mockup.html#${fragment}` });
    let ready = false;
    for (const start = Date.now(); Date.now() - start < 45_000 && !ready; ) {
      await sleep(250);
      const r = await send('Runtime.evaluate', {
        expression: "document.documentElement.dataset.ready === '1'",
        returnByValue: true,
      }).catch(() => null);
      ready = r?.result?.value === true;
    }
    await sleep(700);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
    ws.close();
    console.log(`${name}.png${ready ? '' : '  (not ready: the map may be missing)'}`);
  } finally {
    chrome.kill('SIGTERM');
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const [name, [fragment, view]] of Object.entries(SHOTS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  await shoot(name, fragment, view);
}
