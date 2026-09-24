#!/usr/bin/env node
/**
 * Render the app icons (web/public/icons/*.png) from their SVG sources with a local
 * headless Chrome. The PNGs are committed; run this after changing an SVG. Development
 * tool only: Node built-ins and Chrome, no npm dependency. OWNER: release agent.
 *
 *   node scripts/render-icons.mjs        # in web/
 *
 * Environment: CHROME (default google-chrome).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ICONS = resolve(here, '../public/icons');
const CHROME = process.env.CHROME ?? 'google-chrome';

/** [source SVG, output PNG, pixel size, keep transparency] */
const RENDERS = [
  ['icon.svg', 'icon-192.png', 192, true],
  ['icon.svg', 'icon-512.png', 512, true],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512, false],
  // iOS masks home-screen icons itself and paints transparent corners black: full bleed.
  ['icon-maskable.svg', 'apple-touch-icon.png', 180, false],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const port = 9900 + Math.floor(Math.random() * 90);
  const profile = mkdtempSync(join(tmpdir(), 'skyfix-icons-'));
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--hide-scrollbars', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'],
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
    for (const [source, output, size, transparent] of RENDERS) {
      await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setDefaultBackgroundColorOverride', transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
      // An SVG with a viewBox and no size fills the viewport.
      const html = `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="${pathToFileURL(join(ICONS, source)).href}">`;
      const file = join(profile, `${output}.html`);
      writeFileSync(file, html);
      await send('Page.navigate', { url: pathToFileURL(file).href });
      await sleep(400);
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
        captureBeyondViewport: false,
      });
      writeFileSync(join(ICONS, output), Buffer.from(shot.data, 'base64'));
      console.log(`${output}  ${size}x${size}  from ${source}`);
    }
    ws.close();
  } finally {
    chrome.kill();
    await sleep(200);
    rmSync(profile, { recursive: true, force: true });
  }
}

await main();
