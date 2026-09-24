#!/usr/bin/env node
/**
 * Screenshots of the Charts view for review, written to docs/design/charts-*.png.
 * Development tool only: Node built-ins and a local Chrome, no npm dependency. OWNER:
 * charts agent. Modelled on web/scripts/design-screenshots.mjs (shell-design agent).
 *
 *   npx vite --port 5193 --strictPort                     # in web/, in another terminal
 *   node src/next/charts/dev/screenshots.mjs              # all shots
 *   node src/next/charts/dev/screenshots.mjs day-light year-tromso
 *
 * It drives Chrome over the DevTools protocol in real time (not virtual time, so the
 * planet chart's month-by-month work completes and the page's own timings are real) and
 * waits for the developer page's "ready" signal (`<html data-ready="1">`: fonts loaded and
 * the chart drawn in full).
 *
 * Environment: BASE (default http://localhost:5193), CHROME (default google-chrome),
 * OUT (default docs/design at the repository root).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:5193';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(here, '../../../../../docs/design'));

const DESKTOP = { width: 1440, height: 1000, scale: 1 };
const TALL = { width: 1440, height: 1180, scale: 1 };
const PHONE = { width: 390, height: 844, scale: 2 };

const PHILLY = 'place=philadelphia&date=2026-09-24T21:10';
const TROMSO_JUNE = 'place=tromso&date=2026-06-21T13:00';
const TROMSO_DEC = 'place=tromso&date=2026-12-21T12:00';
const SYDNEY = 'place=sydney&date=2026-09-24T19:00';

/** name -> [fragment, viewport]. */
const SHOTS = {
  'day-light': [`${PHILLY}&theme=light&tab=day`, DESKTOP],
  'day-dark': [`${PHILLY}&theme=dark&tab=day&body=Vega`, DESKTOP],
  'day-night': [`${PHILLY}&theme=night&tab=day&body=Vega`, DESKTOP],
  'day-tromso-june': [`${TROMSO_JUNE}&theme=light&tab=day`, DESKTOP],
  'day-tromso-december': [`${TROMSO_DEC}&theme=light&tab=day`, DESKTOP],
  'day-sydney': [`${SYDNEY}&theme=light&tab=day&body=Canopus`, DESKTOP],
  'day-phone': [`${PHILLY}&theme=light&tab=day`, PHONE],
  'year-light': [`${PHILLY}&theme=light&tab=year`, DESKTOP],
  'year-dark': [`${PHILLY}&theme=dark&tab=year`, DESKTOP],
  'year-night': [`${PHILLY}&theme=night&tab=year`, DESKTOP],
  'year-tromso': [`${TROMSO_JUNE}&theme=light&tab=year`, DESKTOP],
  'year-sydney': [`${SYDNEY}&theme=dark&tab=year`, DESKTOP],
  'year-phone': [`${PHILLY}&theme=light&tab=year`, PHONE],
  'year-table': [`${PHILLY}&theme=light&tab=year&mode=table`, DESKTOP],
  'moon-light': [`${PHILLY}&theme=light&tab=moon`, TALL],
  'moon-night': [`${PHILLY}&theme=night&tab=moon`, TALL],
  'moon-sydney': [`${SYDNEY}&theme=dark&tab=moon`, TALL],
  'moon-tromso-december': [`${TROMSO_DEC}&theme=light&tab=moon`, TALL],
  'moon-phone': [`${PHILLY}&theme=light&tab=moon`, PHONE],
  'planets-light': [`${PHILLY}&theme=light&tab=planets`, DESKTOP],
  'planets-dark': [`${PHILLY}&theme=dark&tab=planets`, DESKTOP],
  'planets-night': [`${PHILLY}&theme=night&tab=planets`, DESKTOP],
  'planets-tromso': [`${TROMSO_JUNE}&theme=light&tab=planets`, DESKTOP],
  'planets-sydney': [`${SYDNEY}&theme=light&tab=planets`, DESKTOP],
  'planets-table': [`${PHILLY}&theme=light&tab=planets&mode=table`, DESKTOP],
  // Not a picture: warm and cold timings in this browser, printed (see harness.ts `bench`).
  bench: [`${PHILLY}&bench=1`, DESKTOP],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(name, fragment, view) {
  const port = 9900 + Math.floor(Math.random() * 90);
  const profile = mkdtempSync(join(tmpdir(), 'skyfix-charts-shot-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
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
    await send('Page.navigate', { url: `${BASE}/next/dev-charts.html#${fragment}` });
    let ready = false;
    for (const start = Date.now(); Date.now() - start < 120_000 && !ready; ) {
      await sleep(250);
      const r = await send('Runtime.evaluate', {
        expression: "document.documentElement.dataset.ready === '1'",
        returnByValue: true,
      }).catch(() => null);
      ready = r?.result?.value === true;
    }
    await sleep(400);
    const timing = await send('Runtime.evaluate', {
      expression: "document.querySelector('.dev-bench')?.textContent ?? document.querySelector('.dev-timings')?.textContent ?? ''",
      returnByValue: true,
    }).catch(() => null);
    if (name === 'bench') {
      console.log(timing?.result?.value ?? '(no bench output)');
      ws.close();
      return;
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `charts-${name}.png`), Buffer.from(shot.data, 'base64'));
    ws.close();
    console.log(`charts-${name}.png  ${timing?.result?.value ?? ''}${ready ? '' : '  (NOT READY)'}`);
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
