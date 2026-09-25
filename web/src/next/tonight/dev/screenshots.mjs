#!/usr/bin/env node
/**
 * Screenshots of the Tonight view for review, written to docs/design/local/tonight-<case>.png
 * (git-ignored working copies). Development tool only: Node built-ins and a local Chrome, no
 * npm dependency. OWNER: tonight agent. The Chrome driver is the one of
 * events/dev/screenshots.mjs; each case waits for the view's own signal that the fortnight
 * ahead is filled in (`.sft[data-coming="done"]`).
 *
 *   npm run wasm                                          # once, for the real engine
 *   npx vite --port 5419 --strictPort --host 127.0.0.1    # in web/, in another terminal
 *   node src/next/tonight/dev/screenshots.mjs             # every case
 *   node src/next/tonight/dev/screenshots.mjs light night-phone
 *
 * Environment: BASE (default http://127.0.0.1:5419), CHROME (default google-chrome),
 * OUT (default docs/design/local).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://127.0.0.1:5419';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(here, '../../../../../docs/design/local'));

const DESKTOP = { width: 1440, height: 900, scale: 1 };
const TALL = { width: 1440, height: 2200, scale: 1 };
const PHONE = { width: 390, height: 844, scale: 2 };

function at(place, lat, lon, tz, utc) {
  const p = new URLSearchParams({ v: '1', lat: String(lat), lon: String(lon), place, tz, t: utc, body: 'Moon', view: 'tonight' });
  return `/#${p}`;
}
const PHILLY = (utc) => at('Philadelphia City Hall', 39.9526, -75.1652, 'America/New_York', utc);
const SYDNEY = (utc) => at('Sydney', -33.8688, 151.2093, 'Australia/Sydney', utc);
const TROMSO = (utc) => at('Tromsø', 69.6492, 18.9553, 'Europe/Oslo', utc);
const SAN_FRANCISCO = (utc) => at('San Francisco', 37.7749, -122.4194, 'America/Los_Angeles', utc);

const night = { settings: { theme: 'night' } };
const light = { settings: { theme: 'light' } };
const dark = { settings: { theme: 'dark' } };
const done = `document.querySelector('.sft')?.dataset.coming === 'done'`;
const scroll = (y) => ({ run: `document.querySelector('.sft').scrollTop = ${y}` });

/** name -> [path, viewport, preferences, steps, emulated media]. */
const SHOTS = {
  light: [PHILLY('2026-09-24T23:30:00Z'), DESKTOP, light, [{ until: done }]],
  'light-full': [PHILLY('2026-09-24T23:30:00Z'), TALL, light, [{ until: done }]],
  'light-lower': [PHILLY('2026-09-24T23:30:00Z'), TALL, light, [{ until: done }, scroll(1400), { wait: 300 }]],
  dark: [PHILLY('2026-09-24T23:30:00Z'), DESKTOP, dark, [{ until: done }]],
  night: [PHILLY('2026-09-24T23:30:00Z'), DESKTOP, night, [{ until: done }]],
  'night-full': [PHILLY('2026-09-24T23:30:00Z'), TALL, night, [{ until: done }]],
  'phone-light': [PHILLY('2026-09-24T23:30:00Z'), PHONE, light, [{ until: done }]],
  'phone-night': [PHILLY('2026-09-24T23:30:00Z'), PHONE, night, [{ until: done }]],
  'phone-dark-lower': [PHILLY('2026-09-24T23:30:00Z'), PHONE, dark, [{ until: done }, scroll(900), { wait: 300 }]],
  'phone-light-timeline': [PHILLY('2026-09-24T23:30:00Z'), PHONE, light, [{ until: done }, scroll(250), { wait: 300 }]],
  perseids: [PHILLY('2026-08-13T02:00:00Z'), TALL, dark, [{ until: done }]],
  sydney: [SYDNEY('2026-06-15T10:00:00Z'), TALL, light, [{ until: done }]],
  tromso: [TROMSO('2026-06-21T20:00:00Z'), DESKTOP, light, [{ until: done }]],
  'san-francisco': [SAN_FRANCISCO('2026-09-25T03:00:00Z'), TALL, light, [{ until: done }]],
  'eclipse-2026-08-28': [PHILLY('2026-08-28T02:00:00Z'), DESKTOP, light, [{ until: done }]],
  'year-2200': [PHILLY('2200-09-24T23:30:00Z'), DESKTOP, light, [{ until: done }]],
  print: [PHILLY('2026-09-24T23:30:00Z'), { width: 1100, height: 1500, scale: 1 }, dark, [{ until: done }], 'print'],
  // The printed sheet itself: Chrome's PDF on Letter and A4 paper (must be one page each).
  sheet: [PHILLY('2026-09-24T23:30:00Z'), DESKTOP, dark, [{ until: done }], 'pdf'],
  'sheet-perseids': [PHILLY('2026-08-13T02:00:00Z'), DESKTOP, light, [{ until: done }], 'pdf'],
};

/** Pages in a PDF Chrome wrote (its page objects). */
function pdfPages(buf) {
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(name, path, view, prefs, steps, media) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'skyfix-tonight-shot-'));
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${view.width},${view.height}`, 'about:blank'],
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
      if (msg.method === 'Runtime.exceptionThrown') logs.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
      if (msg.method === 'Runtime.consoleAPICalled' && /error|warn/.test(msg.params.type)) logs.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
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
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true }).catch((e) => ({ error: e }));
      return r?.result?.value;
    };
    const until = async (expression, ms = 120_000) => {
      for (const start = Date.now(); Date.now() - start < ms; ) {
        if ((await evaluate(expression)) === true) return true;
        await sleep(200);
      }
      return false;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: view.scale, mobile: view.width < 768 });
    if (view.width < 768) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    if (media === 'print') await send('Emulation.setEmulatedMedia', { media });
    if (prefs) await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('skyfix.explorer.prefs.v1', ${JSON.stringify(JSON.stringify(prefs))}); } catch {}` });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('skyfix.explorer.tour.v1', 'done'); } catch {}` });
    await send('Page.navigate', { url: `${BASE}${path}` });
    let ok = await until("document.documentElement.dataset.ready === '1' && !!document.querySelector('.sft')");
    for (const step of steps ?? []) {
      if (step.run) await evaluate(step.run);
      if (step.until) ok = (await until(step.until)) && ok;
      if (step.wait) await sleep(step.wait);
    }
    await sleep(700);
    if (media === 'pdf') {
      const papers = { letter: [8.5, 11], a4: [8.27, 11.69] };
      const pages = {};
      for (const [paper, [w, h]] of Object.entries(papers)) {
        const pdf = await send('Page.printToPDF', { paperWidth: w, paperHeight: h, printBackground: true, preferCSSPageSize: false });
        const buf = Buffer.from(pdf.data, 'base64');
        writeFileSync(join(OUT, `tonight-${name}-${paper}.pdf`), buf);
        pages[paper] = pdfPages(buf);
      }
      ws.close();
      console.log(`tonight-${name}-{letter,a4}.pdf pages ${JSON.stringify(pages)}${logs.length ? `\n  ${logs.join('\n  ')}` : ''}`);
      return;
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `tonight-${name}.png`), Buffer.from(shot.data, 'base64'));
    const timing = await evaluate(`JSON.stringify({ core: document.querySelector('.sft')?.dataset.coreMs })`);
    ws.close();
    console.log(`tonight-${name}.png ${timing}${ok ? '' : '  (a wait timed out: the page may be incomplete)'}${logs.length ? `\n  ${logs.join('\n  ')}` : ''}`);
  } finally {
    chrome.kill('SIGTERM');
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const [name, [path, view, prefs, steps, media]] of Object.entries(SHOTS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  await shoot(name, path, view, prefs, steps, media);
}
