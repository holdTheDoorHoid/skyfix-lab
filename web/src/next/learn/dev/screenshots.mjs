#!/usr/bin/env node
/**
 * Screenshots of the Learn view (web/next/dev-learn.html) for review, written to
 * docs/design/local/learn-<case>.png (git-ignored working copies; a few curated ones are
 * copied by hand to docs/design/). Development tool only: Node built-ins and a local
 * Chrome, no npm dependency. OWNER: learn agent. Modelled on web/scripts/map-screenshots.mjs.
 *
 *   npx vite --port 5197 --strictPort                      # in web/, in another terminal
 *   node src/next/learn/dev/screenshots.mjs                 # every case
 *   node src/next/learn/dev/screenshots.mjs clock map-clock # some cases
 *
 * It drives Chrome over the DevTools protocol in real time (MapLibre draws on animation
 * frames and in a worker, which `chrome --screenshot` with virtual time does not wait for)
 * and waits for the page's own signal, `<html data-ready="1">`.
 *
 * Environment: BASE (default http://localhost:5197), CHROME (default google-chrome),
 * OUT (default docs/design/local at the repository root).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:5197';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(here, '../../../../../docs/design/local'));

const DESKTOP = { width: 1440, height: 1000, scale: 1 };
const TALL = { width: 1440, height: 2400, scale: 1 };
const PHONE = { width: 390, height: 844, scale: 2 };

/** name -> [query, viewport] */
const SHOTS = {
  primer: ['tab=primer', TALL],
  welcome: ['tab=stories', DESKTOP],
  clock: ['story=clock-offset', DESKTOP],
  'clock-dark': ['story=clock-offset&theme=dark', DESKTOP],
  bias: ['story=shared-bias', TALL],
  'one-bad': ['story=one-bad-sight', TALL],
  'one-bad-robust': ['story=one-bad-sight&variant=robust', DESKTOP],
  single: ['story=single-sight', DESKTOP],
  two: ['story=two-sight-ambiguous', DESKTOP],
  'two-night': ['story=two-sight-ambiguous&theme=night', DESKTOP],
  'healthy-globe': ['story=philadelphia-stars&view=globe', DESKTOP],
  simulator: ['tab=simulator&sim=shared-bias&run=1&experiment=50', { width: 1440, height: 3000, scale: 1 }],
  'map-clock': ['story=clock-offset&then=map', DESKTOP],
  'phone-story': ['story=clock-offset', PHONE],
  'phone-primer': ['tab=primer', PHONE],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withChrome(view, fn) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'skyfix-learn-shot-'));
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
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
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
    await send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: view.scale, mobile: view.width < 768 });
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
    await sleep(200);
  }
  return false;
}

async function shoot(name, query, view) {
  await withChrome(view, async (send) => {
    await send('Page.navigate', { url: `${BASE}/next/dev-learn.html?${query}` });
    const ready = await waitFor(send, "document.documentElement.dataset.ready === '1'", 90_000);
    await sleep(700);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `learn-${name}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`learn-${name}.png${ready ? '' : '  (NOT READY: the page may be incomplete)'}`);
  });
}

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const [name, [query, view]] of Object.entries(SHOTS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  await shoot(name, query, view);
}
