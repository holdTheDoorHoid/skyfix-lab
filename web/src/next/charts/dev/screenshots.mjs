#!/usr/bin/env node
/**
 * Screenshots of the Charts view for review, written to docs/design/local/charts-*.png
 * (git-ignored; curated copies go to docs/design/ by hand).
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
 * OUT (default docs/design/local at the repository root).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:5193';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(here, '../../../../../docs/design/local'));

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
  'planets-phone': [`${PHILLY}&theme=dark&tab=planets`, PHONE],
  'day-table': [`${PHILLY}&theme=light&tab=day&mode=table`, DESKTOP],
  'moon-table': [`${PHILLY}&theme=dark&tab=moon&mode=table`, DESKTOP],
  'day-dst-spring': [`place=philadelphia&date=2026-03-08T12:00&theme=light&tab=day`, DESKTOP],
  'day-at-sea': [`place=atsea&date=2026-09-24T12:00&theme=dark&tab=day`, DESKTOP],
  'year-out-of-coverage': [`place=philadelphia&date=2061-06-01T12:00&theme=light&tab=year`, DESKTOP],
  'year-santiago': [`place=santiago&date=2026-09-24T12:00&theme=light&tab=year`, DESKTOP],
  // charts2 agent (expansion programme Q5): the Sun and Tides tabs, the Moon through the year.
  'sun-path-light': [`${PHILLY}&theme=light&tab=sun&sub=path`, DESKTOP],
  'sun-path-across': [`${PHILLY}&theme=light&tab=sun&sub=path&variant=across`, DESKTOP],
  'sun-path-night': [`${PHILLY}&theme=night&tab=sun&sub=path`, DESKTOP],
  'sun-path-tromso': [`${TROMSO_JUNE}&theme=dark&tab=sun&sub=path`, DESKTOP],
  'sun-path-quito': [`place=quito-noon&date=2026-06-21T12:00&theme=light&tab=sun&sub=path&variant=across`, DESKTOP],
  'sun-path-phone': [`${PHILLY}&theme=light&tab=sun&sub=path`, PHONE],
  'analemma-light': [`${PHILLY}&theme=light&tab=sun&sub=analemma`, TALL],
  'analemma-dark': [`${SYDNEY}&theme=dark&tab=sun&sub=analemma`, TALL],
  'analemma-tromso': [`${TROMSO_JUNE}&theme=light&tab=sun&sub=analemma`, TALL],
  'bearings-light': [`${PHILLY}&theme=light&tab=sun&sub=bearings`, TALL],
  'bearings-tromso': [`${TROMSO_JUNE}&theme=dark&tab=sun&sub=bearings`, TALL],
  'eot-light': [`${PHILLY}&theme=light&tab=sun&sub=eot`, TALL],
  'eot-night': [`${PHILLY}&theme=night&tab=sun&sub=eot`, TALL],
  'solar-light': [`${PHILLY}&theme=light&tab=sun&sub=solar`, TALL],
  'solar-night': [`${PHILLY}&theme=night&tab=sun&sub=solar`, TALL],
  'solar-phone': [`${PHILLY}&theme=dark&tab=sun&sub=solar`, PHONE],
  'moon-year-light': [`${PHILLY}&theme=light&tab=moon&sub=year`, TALL],
  'moon-year-night': [`${PHILLY}&theme=night&tab=moon&sub=year`, TALL],
  'moon-apsides': [`${PHILLY}&theme=light&tab=moon&sub=phases`, TALL],
  'tides-light': [`place=sanfrancisco&date=2026-09-24T13:00&theme=light&tab=tides&packs=tides-us`, DESKTOP],
  'tides-week': [`place=annapolis&date=2026-09-24T13:00&theme=dark&tab=tides&span=week&packs=tides-us`, DESKTOP],
  'tides-night': [`place=sanfrancisco&date=2026-09-24T13:00&theme=night&tab=tides&packs=tides-us`, DESKTOP],
  'tides-phone': [`place=sanfrancisco&date=2026-09-24T13:00&theme=light&tab=tides&packs=tides-us`, PHONE],
  'tides-nopack': [`place=sanfrancisco&date=2026-09-24T13:00&theme=light&tab=tides`, DESKTOP],
  'tides-table': [`place=sanfrancisco&date=2026-09-24T13:00&theme=light&tab=tides&mode=table&packs=tides-us`, DESKTOP],
  // Save → Print, seen as print media on an A4-sized page (the print dialog stubbed).
  'print-sun-path': [`${PHILLY}&theme=night&tab=sun&sub=path`, DESKTOP],
  'print-bearings': [`${PHILLY}&theme=dark&tab=sun&sub=bearings`, TALL],
  'print-tides-table': [`place=sanfrancisco&date=2026-09-24T13:00&theme=light&tab=tides&mode=table&packs=tides-us`, DESKTOP],
  'print-moon': [`${PHILLY}&theme=night&tab=moon&sub=phases`, TALL],
  'print-year': [`${PHILLY}&theme=dark&tab=year`, DESKTOP],
  // Files made by each card's Save menu (picture and CSV), saved into OUT by the browser.
  'export-sun-path': [`${PHILLY}&theme=night&tab=sun&sub=path`, DESKTOP],
  'export-analemma': [`${PHILLY}&theme=dark&tab=sun&sub=analemma`, TALL],
  'export-solar': [`${PHILLY}&theme=light&tab=sun&sub=solar`, TALL],
  'export-tides': [`place=sanfrancisco&date=2026-09-24T13:00&theme=dark&tab=tides&packs=tides-us`, DESKTOP],
  'export-moon': [`${PHILLY}&theme=light&tab=moon&sub=phases`, TALL],
  'export-year': [`${PHILLY}&theme=light&tab=year`, DESKTOP],
  // Not a picture: warm and cold timings in this browser, printed (see harness.ts `bench`).
  bench: [`${PHILLY}&bench=1&packs=tides-us`, DESKTOP],
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
    if (name.startsWith('print-')) {
      // charts2: Save → Print, with the browser's print dialog stubbed, seen as print media.
      await send('Runtime.evaluate', { expression: "window.print = () => {}; document.querySelector('.sfc-card .sfc-save').click(); true", returnByValue: true });
      await sleep(250);
      await send('Runtime.evaluate', { expression: "document.querySelector('[data-action=print]').click(); true", returnByValue: true });
      await sleep(300);
      await send('Emulation.setEmulatedMedia', { media: 'print' });
      await send('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: 1, mobile: false });
      await sleep(600);
      const printed = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(OUT, `charts-${name}.png`), Buffer.from(printed.data, 'base64'));
      ws.close();
      console.log(`charts-${name}.png`);
      return;
    }
    if (name.startsWith('export-')) {
      // charts2: use the card's own Save menu, and let the browser save the files here.
      await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT });
      const done = [];
      for (const action of ['png', 'csv']) {
        await send('Runtime.evaluate', { expression: "document.querySelector('.sfc-card .sfc-save').click(); true", returnByValue: true });
        await sleep(250);
        await send('Runtime.evaluate', { expression: `document.querySelector('[data-action=${action}]').click(); true`, returnByValue: true });
        let status = '';
        for (let i = 0; i < 40 && !/^Saved/.test(status); i += 1) {
          await sleep(250);
          const r = await send('Runtime.evaluate', { expression: "document.querySelector('.sfc-card .sfc-status')?.textContent ?? ''", returnByValue: true });
          status = r?.result?.value ?? '';
        }
        done.push(status || `${action}: no status`);
      }
      await sleep(800);
      ws.close();
      console.log(`${name}: ${done.join(' | ')}`);
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
