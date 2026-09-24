#!/usr/bin/env node
/**
 * Screenshots of the Events view for review, written to docs/design/local/events-<case>.png
 * (git-ignored working copies; at most three curated ones are copied by hand into
 * docs/design/). Development tool only: Node built-ins and a local Chrome, no npm
 * dependency. OWNER: eclipse agent. The Chrome driver is the one of
 * web/scripts/design-screenshots.mjs, plus steps: after the page is ready, each case runs
 * clicks in the page and waits for the view's own signals (`.sfe[data-tab]`,
 * `.sfe-eclipses[data-local="done"]`, the map's `.sfm[data-detail][data-places]`).
 *
 *   npm run wasm                                          # once, for the real engine
 *   npx vite --port 5197 --strictPort                     # in web/, in another terminal
 *   node src/next/events/dev/screenshots.mjs              # every case
 *   node src/next/events/dev/screenshots.mjs eclipse-light map-2024
 *
 * Environment: BASE (default http://localhost:5197), CHROME (default google-chrome),
 * OUT (default docs/design/local).
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

const DESKTOP = { width: 1440, height: 900, scale: 1 };
const PHONE = { width: 390, height: 844, scale: 2 };

/** A share link (state.ts `encodeShare`) opening the Events view. */
function at(place, lat, lon, tz, utc, body = 'Sun') {
  const p = new URLSearchParams({ v: '1', lat: String(lat), lon: String(lon), place, tz, t: utc, body, view: 'events' });
  return `/#${p}`;
}
const DALLAS = (utc) => at('Dallas', 32.7767, -96.797, 'America/Chicago', utc);
const PHILLY = (utc) => at('Philadelphia City Hall', 39.9526, -75.1652, 'America/New_York', utc);
const SYDNEY = (utc) => at('Sydney', -33.8688, 151.2093, 'Australia/Sydney', utc);

const night = { settings: { theme: 'night' } };

const tab = (id) => `document.querySelector('.sfe-tabs [id$="-${id}"]').click()`;
const eclipse = (id) => `document.querySelector('.sfe-row[data-eclipse="${id}"]').click()`;
const showOnMap = `document.querySelector('.sfe-card .sfe-actions .sf-btn').click()`;
/** Choose an eclipse, wait for its card, and put it on the map. */
const toMap = (id) => [
  { until: listed },
  { run: eclipse(id) },
  { until: `!!document.querySelector('.sfe-card[data-eclipse="${id}"] .sfe-actions .sf-btn')` },
  { run: showOnMap },
  { until: mapReady },
  { wait: 5000 },
];
const listed = `document.querySelector('.sfe-eclipses')?.dataset.local === 'done'`;
const onTab = (id) => `document.querySelector('.sfe')?.dataset.tab === '${id}'`;
const mapReady = `document.querySelector('.sfm')?.dataset.detail === '1' && document.querySelector('.sfm')?.dataset.places === '1'`;

/**
 * name -> [path, viewport, colour scheme, stored preferences, steps]. A step is
 * `{ run }` (JavaScript to evaluate), `{ until }` (an expression to wait for) or `{ wait }` (ms).
 */
const SHOTS = {
  'eclipse-light': [DALLAS('2024-03-20T15:00:00Z'), DESKTOP, 'light', null, [{ until: listed }, { run: eclipse('2024-04-08-solar') }, { wait: 800 }]],
  'eclipse-light-lower': [DALLAS('2024-03-20T15:00:00Z'), DESKTOP, 'light', null, [{ until: listed }, { run: eclipse('2024-04-08-solar') }, { wait: 800 }, { run: "document.querySelector('.sfe').scrollTop = 520" }, { wait: 300 }]],
  'eclipse-dark': [DALLAS('2024-03-20T15:00:00Z'), DESKTOP, 'dark', null, [{ until: listed }, { run: eclipse('2024-04-08-solar') }, { wait: 800 }]],
  'eclipse-night': [DALLAS('2024-03-20T15:00:00Z'), DESKTOP, 'dark', night, [{ until: listed }, { run: eclipse('2024-04-08-solar') }, { wait: 800 }]],
  'lunar-light': [PHILLY('2025-03-01T15:00:00Z'), DESKTOP, 'light', null, [{ until: listed }, { run: eclipse('2025-03-14-lunar') }, { wait: 800 }]],
  'partial-dark': [PHILLY('2024-03-20T15:00:00Z'), DESKTOP, 'dark', null, [{ until: listed }, { run: eclipse('2024-04-08-solar') }, { wait: 800 }]],
  'sydney-light': [SYDNEY('2026-09-24T02:00:00Z'), DESKTOP, 'light', null, [{ until: listed }, { run: eclipse('2028-07-22-solar') }, { wait: 800 }]],
  'moon-light': [PHILLY('2026-09-24T15:00:00Z'), DESKTOP, 'light', null, [{ run: tab('moon') }, { until: onTab('moon') }, { wait: 500 }]],
  'seasons-dark': [SYDNEY('2026-09-24T02:00:00Z'), DESKTOP, 'dark', null, [{ run: tab('seasons') }, { until: onTab('seasons') }, { wait: 500 }]],
  'planets-light': [PHILLY('2026-09-24T15:00:00Z'), DESKTOP, 'light', null, [{ run: tab('planets') }, { until: onTab('planets') }, { wait: 500 }]],
  'phone-dark': [DALLAS('2024-03-20T15:00:00Z'), PHONE, 'dark', null, [{ until: listed }, { run: eclipse('2024-04-08-solar') }, { wait: 800 }]],
  'phone-night-planets': [PHILLY('2026-09-24T15:00:00Z'), PHONE, 'dark', night, [{ run: tab('planets') }, { until: onTab('planets') }, { wait: 500 }]],
  'map-2024': [DALLAS('2024-03-20T15:00:00Z'), DESKTOP, 'light', null, toMap('2024-04-08-solar')],
  'map-2024-dark': [DALLAS('2024-03-20T15:00:00Z'), DESKTOP, 'dark', null, toMap('2024-04-08-solar')],
  'map-2021-antarctic': [DALLAS('2021-11-20T15:00:00Z'), DESKTOP, 'light', null, toMap('2021-12-04-solar')],
  'map-2023-hybrid': [DALLAS('2023-04-01T15:00:00Z'), DESKTOP, 'light', null, toMap('2023-04-20-solar')],
  'map-2026-polar': [DALLAS('2026-08-01T15:00:00Z'), DESKTOP, 'light', null, toMap('2026-08-12-solar')],
  'map-2021-annular-polar': [DALLAS('2021-06-01T15:00:00Z'), DESKTOP, 'light', null, toMap('2021-06-10-solar')],
  'map-lunar': [PHILLY('2025-03-01T15:00:00Z'), DESKTOP, 'dark', null, toMap('2025-03-14-lunar')],
  'map-2024-phone': [DALLAS('2024-03-20T15:00:00Z'), PHONE, 'dark', null, toMap('2024-04-08-solar')],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(name, path, view, scheme, prefs, steps) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'skyfix-events-shot-'));
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
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true }).catch((e) => ({ error: e }));
      return r?.result?.value;
    };
    const until = async (expression, ms = 90_000) => {
      for (const start = Date.now(); Date.now() - start < ms; ) {
        if ((await evaluate(expression)) === true) return true;
        await sleep(200);
      }
      return false;
    };

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
    // A fresh profile is a first visit: keep the first-run tour (shell/tour.ts) out of the shots.
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('skyfix.explorer.tour.v1', 'done'); } catch {}` });
    await send('Page.navigate', { url: `${BASE}${path}` });
    let ok = await until("document.documentElement.dataset.ready === '1' && !!document.querySelector('.sfe')");
    for (const step of steps ?? []) {
      if (step.run) await evaluate(step.run);
      if (step.until) ok = (await until(step.until)) && ok;
      if (step.wait) await sleep(step.wait);
    }
    await sleep(600);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `events-${name}.png`), Buffer.from(shot.data, 'base64'));
    ws.close();
    console.log(`events-${name}.png${ok ? '' : '  (a wait timed out: the page may be incomplete)'}`);
  } finally {
    chrome.kill('SIGTERM');
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const [name, [path, view, scheme, prefs, steps]] of Object.entries(SHOTS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  await shoot(name, path, view, scheme, prefs, steps);
}
