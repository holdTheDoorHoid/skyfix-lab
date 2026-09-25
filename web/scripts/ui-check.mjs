#!/usr/bin/env node
/**
 * Check the whole explorer in a real browser, the way the polish pass did: serves a built
 * site under /skyfix-lab/ (as GitHub Pages does), drives a local headless Chrome over the
 * DevTools protocol, and checks, on every view:
 *
 *   1. in the light, dark and night themes, at 1440 x 900 and at 390 x 844 (a phone):
 *      the honesty banner is on screen, the engine badge says WASM, nothing scrolls
 *      sideways, no two controls overlap, no text is cut off, the view ends where the
 *      phone's bottom sheet begins, and the console stays free of errors and warnings;
 *   2. in the night theme, no pixel carries blue, green or white light (a screenshot is
 *      sampled; the theme's red-orange accent is allowed);
 *   3. switching views many times leaves no listeners, DOM nodes or canvases behind;
 *   4. the time keys move the time, and typing in a field never does;
 *   5. the address bar never carries the place, and storage holds no position until a
 *      sight is entered in Navigate;
 *   6. dragging the time bar on each view: frame times, reported (not judged: a headless
 *      browser draws WebGL and canvas in software, so the map and sky are far slower here
 *      than on a real screen).
 *   7. (charts2) every Charts tab and sub-view (Day, Year, the five Sun charts, the two Moon
 *      charts, Planets, Tides) in each theme and size: drawn, no overlap or cut-off text, no
 *      sideways scroll, a clean console, no blue or white light in the night theme; the
 *      tides pack's one prompt and Get; the Save menu writing a real PNG and CSV; each
 *      chart's compute time and the frame times of a drag on the Sun path, reported.
 *      than on a real screen);
 *   7. deep time (time-ui agent): a BC date in the Julian calendar with its era, local mean
 *      time and UT on the clock, the ±ΔT chip, the calendar's century step and October 1582,
 *      UTC inside 1972-2035; playback at ten years a second on the Map view (frame times
 *      and script time per frame, reported) and the Sky view.
 *   8. the Selected card's photographer and astronomer tools (photo agent, expansion Q8):
 *      golden and blue hour, the alignment finder (Manhattanhenge) and picking its bearing
 *      on the map, the Moon's details, the Milky Way planner, RA/Dec and the magnetic
 *      bearing, the predicted sextant reading, the tides line once the pack is got in
 *      Settings, the night theme and the phone layout with every drawer open, and what the
 *      open drawers add to a time-bar drag (judged when the machine is quiet enough).
 *   9. the Almanac (almanac2 agent): every tab (daily pages as a three-date opening and as
 *      one date, increments, altitude corrections, Polaris, arc to time) in each theme and
 *      size: drawn, no overlap or cut-off text, no sideways scroll, a clean console, no blue
 *      or white light in the night theme; every tab printed to PDF on A4 and on US Letter
 *      as exactly the sheets it promises (one per page: 2, 2, 1, 5, 3, 1, and 30 for "Print
 *      all"), black on white whatever the theme; the time to compute an opening, reported.
 *
 * Screenshots and a JSON summary go to docs/design/local/ (git-ignored). Development tool
 * only: Node built-ins and a local Chrome, no npm dependency. OWNER: polish pass.
 *
 *   npm run build --prefix web && node web/scripts/ui-check.mjs
 *   SITE=site node web/scripts/ui-check.mjs          # the assembled Pages site
 *   ONLY=views,night node web/scripts/ui-check.mjs    # some of: views,night,leaks,keys,privacy,scrub,charts
 *   ONLY=views,night node web/scripts/ui-check.mjs    # some of: views,night,leaks,keys,privacy,scrub,time
 *   ONLY=views,night node web/scripts/ui-check.mjs    # some of: views,night,leaks,keys,privacy,scrub,photo
 *   ONLY=almanac node web/scripts/ui-check.mjs        # the Almanac's tabs, screenshots and printed sheets
 *   ONLY=almanac ALMANAC_SCREEN=0 node web/scripts/ui-check.mjs   # its printed sheets only
 *
 * Environment: SITE (default web/dist), PREFIX (/skyfix-lab/), CHROME (google-chrome),
 * OUT (docs/design/local), VIEWS, THEMES, SIZES, SWITCHES (default 50).
 * Exit status 1 if any check fails.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../..');
const SITE = resolve(REPO, process.env.SITE ?? 'web/dist');
const PREFIX = process.env.PREFIX ?? '/skyfix-lab/';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(REPO, 'docs/design/local'));
const PORT = Number(process.env.PORT ?? 9100 + Math.floor(Math.random() * 400));
const BASE = `http://127.0.0.1:${PORT}${PREFIX}`;
const VIEWS = (process.env.VIEWS ?? 'map,sky,charts,navigate,almanac,events,learn,about').split(',');
const THEMES = (process.env.THEMES ?? 'light,dark,night').split(',');
const SIZES = (process.env.SIZES ?? 'desktop,phone').split(',');
const ONLY = new Set((process.env.ONLY ?? 'views,night,leaks,keys,privacy,scrub,charts,time,photo,almanac').split(','));
/** charts2: the Charts view's tabs and sub-views, `tab` or `tab/sub`. */
const CHART_VIEWS = (process.env.CHARTS ?? 'day,year,sun/path,sun/analemma,sun/bearings,sun/eot,sun/solar,moon/phases,moon/year,planets,tides').split(',');
const SWITCHES = Number(process.env.SWITCHES ?? 50);
const DIMS = { desktop: [1440, 900, false], phone: [390, 844, true] };
const MOMENT = 'v=1&lat=39.9526&lon=-75.1652&place=Philadelphia&tz=America%2FNew_York&t=2026-09-24T16:00:00Z&body=Moon';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------
// The site, like GitHub Pages
// ---------------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, BASE);
    if (!url.pathname.startsWith(PREFIX)) return void res.writeHead(404).end();
    let file = join(SITE, decodeURIComponent(url.pathname.slice(PREFIX.length)));
    if (file !== SITE && !file.startsWith(SITE + sep)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!url.pathname.endsWith('/')) return void res.writeHead(301, { location: `${url.pathname}/` }).end();
      file = join(file, 'index.html');
    }
    if (!existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': body.length });
    res.end(body);
  });
  return new Promise((ok) => server.listen(PORT, '127.0.0.1', () => ok(server)));
}

// ---------------------------------------------------------------------------------
// Chrome over the DevTools protocol
// ---------------------------------------------------------------------------------

async function launch(profile) {
  const debugPort = 9500 + Math.floor(Math.random() * 400);
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: 'ignore' },
  );
  let target = null;
  for (let i = 0; i < 100 && !target; i += 1) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page') ?? null;
    } catch {
      await sleep(100);
    }
  }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.fail(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
    else p.ok(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const mid = ++id;
      pending.set(mid, { ok, fail, method });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  const messages = [];
  on('Runtime.consoleAPICalled', (p) => messages.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`));
  on('Runtime.exceptionThrown', (p) => messages.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`));
  on('Log.entryAdded', (p) => messages.push(`${p.entry.level}: ${p.entry.text}`));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Network.setBypassServiceWorker', { bypass: true });
  await send('Performance.enable');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        // navigating
      }
      await sleep(120);
    }
    return false;
  };
  return {
    send,
    evaluate,
    waitFor,
    messages,
    close() {
      ws.close();
      chrome.kill();
    },
  };
}

// ---------------------------------------------------------------------------------
// Screenshots as pixels (Chrome writes 8-bit RGB or RGBA, not interlaced)
// ---------------------------------------------------------------------------------

function decodePng(buf) {
  let p = 8;
  let w = 0;
  let h = 0;
  let bpp = 4;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bpp = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const pp = a + b - c;
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (Math.abs(pp - a) <= Math.abs(pp - b) && Math.abs(pp - a) <= Math.abs(pp - c) ? a : Math.abs(pp - b) <= Math.abs(pp - c) ? b : c) : 0;
      cur[i] = (line[i] + pred) & 255;
    }
    for (let x = 0; x < w; x++) cur.copy(out, (y * w + x) * 3, x * bpp, x * bpp + 3);
    prev = cur;
  }
  return { w, h, rgb: out };
}

/**
 * Pixels with blue light (any grey or white has it too) or yellow-green light, beyond a
 * trace. The night theme's red-orange accent (#ff4400: green at a quarter of red, no blue)
 * and its antialiased edges pass.
 */
function lightNotRed({ w, h, rgb }) {
  let count = 0;
  let worst = null;
  for (let i = 0; i < w * h; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    if ((b > 32 && b > 0.2 * r) || (g > 40 && g > 0.45 * r)) {
      count += 1;
      const m = Math.max(g, b);
      if (!worst || m > worst.m) worst = { x: i % w, y: Math.floor(i / w), r, g, b, m };
    }
  }
  return { count, worst };
}

// ---------------------------------------------------------------------------------
// In-page layout checks
// ---------------------------------------------------------------------------------

const LAYOUT = String.raw`(() => {
  const vw = innerWidth, vh = innerHeight, de = document.documentElement;
  const visible = (el) => { if (!el || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }))) return false; const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh; };
  const clip = (el) => { const r = el.getBoundingClientRect(); let L = r.left, T = r.top, R = r.right, B = r.bottom; for (let a = el.parentElement; a; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const q = a.getBoundingClientRect(); L = Math.max(L, q.left); T = Math.max(T, q.top); R = Math.min(R, q.right); B = Math.min(B, q.bottom); } } return { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T }; };
  const name = (el) => el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] + ' "' + (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) + '"';
  const hon = document.querySelector('.sf-honesty__text');
  const ctl = [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [role=tab], [role=switch], .sf-float, .sf-legend, .sf-attribution')].filter(visible).map((el) => ({ el, r: clip(el) })).filter((x) => x.r.width > 1 && x.r.height > 1);
  const overlaps = [];
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    const a = ctl[i], b = ctl[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 2 && h > 2) overlaps.push(name(a.el) + ' / ' + name(b.el));
  }
  const clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement) || !visible(el) || el.clientWidth <= 1) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    const c = clip(el);
    if (c.width > 1 && (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis') clipped.push(name(el));
  }
  const view = document.querySelector('.sf-stage__view'), panel = document.querySelector('#sf-panel');
  const vr = view?.getBoundingClientRect(), pr = panel?.getBoundingClientRect();
  return JSON.stringify({
    hscroll: Math.max(de.scrollWidth, document.body.scrollWidth) > de.clientWidth + 1,
    honesty: hon ? visible(hon) && /Not a navigation instrument/.test(hon.textContent) : false,
    badge: document.querySelector('.sf-honesty .sf-badge')?.textContent.trim() ?? '',
    overlaps: overlaps.slice(0, 10),
    clipped: clipped.slice(0, 10),
    underSheet: vw < 768 && vr && pr ? Math.round(vr.bottom - pr.top) : 0,
  });
})()`;

// ---------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function main() {
  // The explorer is the home page (the switch-over, 2026-09-24); next/ and classic/ (the
  // retired workbench) only forward here.
  if (!existsSync(join(SITE, 'index.html')) || !existsSync(join(SITE, 'classic/index.html'))) {
    throw new Error(`${SITE} is not a built site with the explorer at its root: build first (npm run build --prefix web)`);
  }
  mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const scratch = mkdtempSync(join(tmpdir(), 'skyfix-ui-check-'));
  const page = await launch(join(scratch, 'profile'));
  const { send, evaluate, waitFor, messages } = page;
  const summary = { views: [], leaks: null, scrub: {} };
  const viewport = (w, h, mobile) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const open = async (hash, { theme = 'dark', fresh = true } = {}) => {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(100);
    if (fresh) {
      await send('Page.navigate', { url: `${BASE}?setup` });
      await waitFor('document.readyState === "complete"');
      await evaluate(`localStorage.clear(); localStorage.setItem('skyfix.explorer.prefs.v1', JSON.stringify({ settings: { theme: '${theme}' } })); localStorage.setItem('skyfix.explorer.tour.v1', 'done'); true`);
      await send('Page.navigate', { url: 'about:blank' });
      await sleep(100);
    }
    await send('Page.navigate', { url: `${BASE}#${hash}` });
    await waitFor(`document.documentElement.dataset.ready === '1'`);
    await waitFor(`(() => { const v = document.querySelector('.sf-stage__view'); return v && !v.hasAttribute('aria-busy') && v.children.length > 0; })()`);
    if (/view=(map|globe)|^(map|globe)$/.test(hash)) await waitFor(`document.querySelector('.sfm')?.dataset.detail === '1'`);
    await sleep(1200);
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(join(OUT, `ui-${name}.png`), buf);
    return buf;
  };

  try {
    // 1-2. Every view, theme and size.
    if (ONLY.has('views') || ONLY.has('night')) {
      for (const size of SIZES) {
        const [w, h, mobile] = DIMS[size];
        await viewport(w, h, mobile);
        for (const theme of THEMES) {
          for (const view of VIEWS) {
            messages.length = 0;
            await open(`${MOMENT}&view=${view}`, { theme });
            const L = JSON.parse(await evaluate(LAYOUT));
            const png = await shot(`${size}-${theme}-${view}`);
            const tag = `${view}, ${theme}, ${size}`;
            const noise = messages.filter((m) => /^(error|warning|warn|exception)/.test(m));
            if (ONLY.has('views')) {
              check(`${tag}: honesty banner on screen, engine WASM`, L.honesty && /WASM/.test(L.badge), L.badge);
              check(`${tag}: no sideways scroll, overlap or cut-off text`, !L.hscroll && !L.overlaps.length && !L.clipped.length, [...L.overlaps, ...L.clipped].join('; '));
              if (mobile) check(`${tag}: the view ends where the sheet begins`, L.underSheet <= 0, `${L.underSheet}px under the sheet`);
              check(`${tag}: console clean`, noise.length === 0, noise.slice(0, 3).join(' | '));
            }
            if (theme === 'night' && ONLY.has('night')) {
              const n = lightNotRed(decodePng(png));
              check(`${tag}: no blue, green or white light`, n.count < 50, n.count ? `${n.count} px, worst ${JSON.stringify(n.worst)}` : '');
            }
            summary.views.push({ size, theme, view, layout: L, messages: noise });
          }
        }
      }
    }

    await viewport(1440, 900, false);

    // 3. Switching views: nothing left behind.
    if (ONLY.has('leaks')) {
      await open('map');
      const order = ['sky', 'charts', 'navigate', 'almanac', 'events', 'learn', 'about', 'globe', 'map'];
      const cycle = async (n) => {
        for (let i = 0; i < n; i++) {
          const v = order[i % order.length];
          await evaluate(`location.hash = '#${v}'; true`);
          await sleep(v === 'map' || v === 'globe' ? 900 : 450);
        }
        await evaluate(`location.hash = '#about'; true`);
        await sleep(800);
      };
      const measure = async () => {
        await send('HeapProfiler.enable');
        for (let i = 0; i < 3; i++) await send('HeapProfiler.collectGarbage');
        const m = Object.fromEntries((await send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        const dom = JSON.parse(await evaluate(`JSON.stringify({ canvases: document.querySelectorAll('canvas').length, maps: document.querySelectorAll('.maplibregl-map').length, popovers: document.querySelectorAll('.sf-popover').length })`));
        return { listeners: m.JSEventListeners, nodes: m.Nodes, heapMB: +(m.JSHeapUsedSize / 1e6).toFixed(1), ...dom };
      };
      await cycle(order.length);
      const a = await measure();
      messages.length = 0;
      await cycle(SWITCHES);
      const b = await measure();
      summary.leaks = { before: a, after: b, switches: SWITCHES };
      check(`${SWITCHES} view switches: no listeners, nodes, canvases or maps left behind`, b.listeners <= a.listeners && b.nodes <= a.nodes + 20 && b.canvases <= a.canvases && b.maps <= a.maps && b.popovers <= a.popovers, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      check(`${SWITCHES} view switches: console clean`, !messages.some((m) => /^(error|warning|warn|exception)/.test(m)), messages.slice(0, 3).join(' | '));
    }

    // 4. Time keys.
    if (ONLY.has('keys')) {
      await open(`${MOMENT}&view=about`);
      const clockText = `[...document.querySelectorAll('.sf-timebar button')].map((b) => b.getAttribute('aria-label') || '').filter((l) => /^(Date|Time):/.test(l)).join(' / ')`;
      const press = async (key, modifiers = 0) => {
        const code = { ArrowRight: 39, ArrowLeft: 37 }[key] ?? 0;
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, modifiers });
        if (key.length === 1) await send('Input.dispatchKeyEvent', { type: 'char', key, text: key, modifiers });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers });
        await sleep(120);
      };
      await evaluate(`document.activeElement?.blur(); true`);
      const t0 = await evaluate(clockText);
      await press('ArrowRight');
      const t1 = await evaluate(clockText);
      check('→ moves the time 10 minutes', /12:10:00/.test(t1), `${t0} -> ${t1}`);
      await press('ArrowRight', 1); // Alt
      const t2 = await evaluate(clockText);
      check('Alt+→ moves the date a day', /Friday 25 September/.test(t2), t2);
      await evaluate(`document.querySelector('.sf-search input').focus(); true`);
      const t3 = await evaluate(clockText);
      for (const k of ['ArrowRight', 'n', ' ']) await press(k);
      check('typing in the place search never moves the time', (await evaluate(clockText)) === t3);
    }

    // 5. Privacy.
    if (ONLY.has('privacy')) {
      await open('map');
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1000, y: 320, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1000, y: 320, button: 'left', clickCount: 1 });
      await sleep(1000);
      await evaluate(`location.hash = '#navigate'; true`);
      await sleep(2500);
      const s = JSON.parse(await evaluate(`JSON.stringify({ url: location.href, keys: Object.keys(localStorage), values: Object.values(localStorage).join(' ') })`));
      check('the address bar never carries the place', !/lat|lon|-?\d{1,3}\.\d{3,}/.test(new URL(s.url).hash + new URL(s.url).search), s.url);
      check('storage holds settings and the tour flag, never a position', !s.keys.includes('skyfix.navigate.working.v1') && !/lat_deg|lon_deg/.test(s.values), s.keys.join(', '));
    }

    // 8. The Selected card's photographer and astronomer tools (photo agent, expansion Q8).
    if (ONLY.has('photo')) await photoChecks({ send, evaluate, waitFor, messages, open, shot, viewport, summary });

    // 6. Dragging the time bar.
    if (ONLY.has('scrub')) {
      for (const view of VIEWS) {
        await open(`${MOMENT}&view=${view}`);
        const hb = JSON.parse(await evaluate(`JSON.stringify((() => { const r = document.querySelector('.sf-ribbon__handle').getBoundingClientRect(); const t = document.querySelector('.sf-ribbon').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: t.left, right: t.right }; })())`));
        await evaluate(`window.__f = []; (function loop(t) { window.__f.push(t); if (window.__f.length < 100000) requestAnimationFrame(loop); })(performance.now()); true`);
        const m0 = Object.fromEntries((await send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        const f0 = await evaluate('window.__f.length');
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hb.x, y: hb.y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 60; i++) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hb.x + (hb.right - 40 - hb.x) * (i / 60), y: hb.y, button: 'left', buttons: 1 });
          await sleep(16);
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hb.right - 40, y: hb.y, button: 'left', clickCount: 1 });
        await sleep(300);
        const m1 = Object.fromEntries((await send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        const ts = JSON.parse(await evaluate(`JSON.stringify(window.__f.slice(${f0}))`));
        const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
        const q = (p) => +(d[Math.min(d.length - 1, Math.floor(p * d.length))] ?? 0).toFixed(1);
        const r = { frames: d.length, medianMs: q(0.5), p95Ms: q(0.95), scriptMsPerFrame: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / Math.max(1, d.length)).toFixed(2) };
        summary.scrub[view] = r;
        console.log(`info  dragging the time bar on ${view}: ${JSON.stringify(r)}`);
      }
    }
    // 7. The Charts view (charts2): every tab and sub-view, the tides pack, the Save menu.
    if (ONLY.has('charts')) {
      summary.charts = { views: [], timings: {}, exports: [], scrub: null };
      const openChart = async (spec) => {
        const [tab, sub] = spec.split('/');
        await evaluate(`document.querySelector('.sfc-tabs [data-tab=${tab}]')?.click(); true`);
        if (sub) {
          await waitFor(`!!document.querySelector('.sfc-subtabs [data-sub=${sub}]')`, 5000);
          await evaluate(`document.querySelector('.sfc-subtabs [data-sub=${sub}]')?.click(); true`);
        }
        return waitFor(`(() => { const c = document.querySelector('.sfc-card'); return !!c && c.dataset.ready === '1' && !c.hasAttribute('data-computing'); })()`, 20000);
      };
      let packChecked = false;
      for (const size of SIZES) {
        const [w, h, mobile] = DIMS[size];
        await viewport(w, h, mobile);
        for (const theme of THEMES) {
          for (const spec of CHART_VIEWS) {
            messages.length = 0;
            await open(`${MOMENT}&view=charts`, { theme });
            const tag = `charts ${spec}, ${theme}, ${size}`;
            if (spec === 'tides' && !packChecked) {
              // The first visit asks once for the pack; Get downloads it and draws the tides.
              await evaluate(`document.querySelector('.sfc-tabs [data-tab=tides]')?.click(); true`);
              const asked = await waitFor(`[...document.querySelectorAll('.sf-packs-prompt button')].some((b) => /^Get/.test(b.textContent.trim()))`, 10000);
              check(`${tag}: the tides pack is offered once, with its size`, asked);
              await evaluate(`[...document.querySelectorAll('.sf-packs-prompt button')].find((b) => /^Get/.test(b.textContent.trim()))?.click(); true`);
              const loaded = await waitFor(`!!document.querySelector('.sfc-card--tides .sfc-plot svg')`, 30000);
              check(`${tag}: Get downloads the pack and the tides are drawn`, loaded);
              packChecked = true;
            }
            const drawn = await openChart(spec);
            await sleep(500);
            const info = JSON.parse(await evaluate(`JSON.stringify((() => { const c = document.querySelector('.sfc-card'); return { compute: c?.dataset.compute ?? '', message: c?.querySelector('.sfc-message')?.textContent ?? '', svg: !!c?.querySelector('.sfc-plot svg, .sfc-cal') }; })())`));
            const L = JSON.parse(await evaluate(LAYOUT));
            const png = await shot(`charts-${size}-${theme}-${spec.replace('/', '-')}`);
            const noise = messages.filter((m) => /^(error|warning|warn|exception)/.test(m));
            check(`${tag}: drawn`, drawn && info.svg && !info.message, info.message);
            check(`${tag}: no sideways scroll, overlap or cut-off text`, !L.hscroll && !L.overlaps.length && !L.clipped.length, [...L.overlaps, ...L.clipped].join('; '));
            if (mobile) check(`${tag}: the view ends where the sheet begins`, L.underSheet <= 0, `${L.underSheet}px under the sheet`);
            check(`${tag}: console clean`, noise.length === 0, noise.slice(0, 3).join(' | '));
            if (theme === 'night') {
              const n = lightNotRed(decodePng(png));
              check(`${tag}: no blue, green or white light`, n.count < 50, n.count ? `${n.count} px, worst ${JSON.stringify(n.worst)}` : '');
            }
            if (info.compute) summary.charts.timings[`${spec} ${size} ${theme}`] = info.compute;
            summary.charts.views.push({ spec, size, theme, layout: L, messages: noise, compute: info.compute });
          }
        }
      }
      await viewport(1440, 900, false);

      // "Show on the map" marks the tide station and opens the map.
      await open(`${MOMENT}&view=charts`);
      await openChart('tides');
      await evaluate(`[...document.querySelectorAll('.sfc-card--tides button')].find((b) => /Show on the map/.test(b.textContent))?.click(); true`);
      const onMap = await waitFor(`/^Map/.test(document.title)`, 10000);
      check('Tides: Show on the map opens the map with the station marked', onMap, await evaluate('document.title'));

      // The Save menu writes a real picture and a real CSV file (into a scratch folder).
      const downloads = join(scratch, 'downloads');
      mkdirSync(downloads, { recursive: true });
      await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      for (const spec of ['sun/path', 'tides', 'moon/phases', 'day']) {
        await open(`${MOMENT}&view=charts`, { theme: 'night' });
        await openChart(spec);
        for (const action of ['png', 'csv']) {
          await evaluate(`document.querySelector('.sfc-card .sfc-save').click(); true`);
          await sleep(250);
          await evaluate(`document.querySelector('[data-action=${action}]').click(); true`);
          const saved = await waitFor(`/^Saved /.test(document.querySelector('.sfc-card .sfc-status')?.textContent ?? '')`, 15000);
          const status = await evaluate(`document.querySelector('.sfc-card .sfc-status')?.textContent ?? ''`);
          const name = (/^Saved (.+)\.$/.exec(status) ?? [])[1] ?? '';
          await sleep(700);
          const file = join(downloads, name);
          const ok = saved && name && existsSync(file);
          const head = ok ? readFileSync(file).subarray(0, 16) : Buffer.alloc(0);
          const valid = action === 'png' ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : head.toString('utf8').startsWith('\uFEFF# SkyFix Lab');
          check(`Save ${action.toUpperCase()} on ${spec}: a real file`, ok && valid, `${status} ${ok ? statSync(file).size + ' bytes' : ''}`);
          summary.charts.exports.push({ spec, action, name, bytes: ok ? statSync(file).size : 0 });
        }
      }

      // Dragging the time bar over the sun path: frame times, reported.
      await open(`${MOMENT}&view=charts`);
      await openChart('sun/path');
      const hb = JSON.parse(await evaluate(`JSON.stringify((() => { const r = document.querySelector('.sf-ribbon__handle').getBoundingClientRect(); const t = document.querySelector('.sf-ribbon').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: t.left, right: t.right }; })())`));
      await evaluate(`window.__f = []; (function loop(t) { window.__f.push(t); if (window.__f.length < 100000) requestAnimationFrame(loop); })(performance.now()); true`);
      const f0 = await evaluate('window.__f.length');
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hb.x, y: hb.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 60; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hb.x + (hb.right - 40 - hb.x) * (i / 60), y: hb.y, button: 'left', buttons: 1 });
        await sleep(16);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hb.right - 40, y: hb.y, button: 'left', clickCount: 1 });
      await sleep(300);
      const ts = JSON.parse(await evaluate(`JSON.stringify(window.__f.slice(${f0}))`));
      const d = ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b);
      const q = (p) => +(d[Math.min(d.length - 1, Math.floor(p * d.length))] ?? 0).toFixed(1);
      summary.charts.scrub = { frames: d.length, medianMs: q(0.5), p95Ms: q(0.95) };
      console.log(`info  dragging the time bar on the sun path: ${JSON.stringify(summary.charts.scrub)}`);
      console.log(`info  chart compute times: ${JSON.stringify(summary.charts.timings)}`);
    }

    // 7. Deep time (time-ui agent).
    if (ONLY.has('time')) {
      const PLACE = 'v=1&lat=39.9526&lon=-75.1652&place=Philadelphia&tz=America%2FNew_York&body=Sun';
      const bar = `JSON.stringify((() => {
        const q = (s) => document.querySelector(s);
        const shown = (s) => (q(s) && !q(s).hidden ? q(s).textContent.trim() : '');
        return { date: shown('.sf-tb-date__label'), tag: shown('.sf-tb-date__cal'), zone: shown('.sf-tb-clock__zone'), other: shown('.sf-tb-clock__utc'), chip: shown('.sf-tb-clock__chip'), chipTip: q('.sf-tb-clock__chip')?.dataset.tip ?? '' };
      })())`;
      for (const [size, [w, h, mobile]] of Object.entries(DIMS)) {
        await viewport(w, h, mobile);
        messages.length = 0;
        await open(`${PLACE}&t=-0584-05-22T12:00:00Z&view=map`, { theme: size === 'phone' ? 'night' : 'light' });
        const T = JSON.parse(await evaluate(bar));
        await shot(`time-bc-${size}-${size === 'phone' ? 'night' : 'light'}`);
        check(`585 BC (${size}): the date is Julian and carries its era`, /28 May 585 BC/.test(T.date) && T.tag === 'Julian', JSON.stringify(T));
        check(`585 BC (${size}): the clock is local mean time with UT beside it`, T.zone === 'LMT' && / UT$/.test(T.other), `${T.zone} · ${T.other}`);
        check(`585 BC (${size}): the ±ΔT chip is shown and explained`, /^±\d+ min$/.test(T.chip) && /Earth’s rotation/.test(T.chipTip), T.chip);
        // The time bar's own controls (what deep time changes: a longer date, the Julian tag,
        // the chip): no overlap or cut-off text among them, and no sideways scroll.
        const L = JSON.parse(await evaluate(LAYOUT.replace("'button, a[href], input, select, textarea, [role=button], [role=tab], [role=switch], .sf-float, .sf-legend, .sf-attribution'", "'.sf-timebar button, .sf-timebar input, .sf-timebar [role=slider], .sf-timebar .sf-cal-tag, .sf-timebar .sf-dt-chip'").replace("document.querySelectorAll('body *')", "document.querySelectorAll('.sf-timebar *')")));
        check(`585 BC (${size}): the time bar has no sideways scroll, overlap or cut-off text`, !L.hscroll && !L.overlaps.length && !L.clipped.length, [...L.overlaps, ...L.clipped].join('; '));
        check(`585 BC (${size}): console clean`, !messages.some((m) => /^(error|warning|warn|exception)/.test(m)), messages.slice(0, 3).join(' | '));
      }
      await viewport(1440, 900, false);
      await open(`${PLACE}&t=-0584-05-22T12:00:00Z&view=about`);
      await evaluate(`document.querySelector('.sf-tb-date__label').click(); true`);
      await sleep(500);
      const title = await evaluate(`document.querySelector('.sf-cal__title')?.textContent ?? ''`);
      await shot('time-calendar-bc');
      await evaluate(`[...document.querySelectorAll('.sf-cal__step')].find((b) => b.textContent.trim() === '+100')?.click(); true`);
      await sleep(500);
      const after = JSON.parse(await evaluate(bar)).date;
      check('the calendar steps a century: 28 May 585 BC + 100 years is 28 May 485 BC', title === 'May 585 BC' && /28 May 485 BC/.test(after), `${title} -> ${after}`);
      await open(`${PLACE}&t=1582-10-14T17:00:00Z&view=about`);
      await evaluate(`document.querySelector('.sf-tb-date__label').click(); true`);
      await sleep(500);
      const oct = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.sf-cal__day:not([data-outside])')].map((b) => b.textContent))`));
      check('October 1582 has its 21 days: the 4th (Julian) is followed by the 15th (Gregorian)', oct.length === 21 && oct[3] === '4' && oct[4] === '15', oct.join(' '));
      await open(`${PLACE}&t=2026-09-24T16:00:00Z&view=about`);
      const now = JSON.parse(await evaluate(bar));
      check('2026: the clock is EDT with UTC beside it, and no chip', now.zone === 'EDT' && / UTC$/.test(now.other) && now.chip === '' && now.tag === '', JSON.stringify(now));
      // Playback at ten years a second from 1990 (inside today's coverage). Frame times are
      // reported, as in the scrub check (headless Chrome draws WebGL in software, and a loaded
      // machine starves it); what is judged does not depend on the machine: while time runs
      // that fast the time bar computes no day's events and rebuilds nothing, and it draws the
      // day in full again once paused.
      for (const view of ['about', 'map', 'sky']) {
        await open(`${PLACE}&t=1990-01-02T16:00:00Z&view=${view}`);
        await evaluate(`document.querySelector('.sf-tb-speed').click(); true`);
        await sleep(300);
        await evaluate(`[...document.querySelectorAll('.sf-menu__item')].find((b) => /^10 years per second/.test(b.textContent))?.click(); true`);
        // The first fast frame draws the bar once; from then on only its day moves.
        await waitFor(`document.querySelector('.sf-timebar').classList.contains('sf-timebar--fast')`, 20000);
        await sleep(300);
        await evaluate(`window.__tick = document.querySelector('.sf-ribbon__tick'); true`);
        await evaluate(`window.__f = []; (function loop(t) { window.__f.push(t); if (window.__f.length < 100000) requestAnimationFrame(loop); })(performance.now()); true`);
        const m0 = Object.fromEntries((await send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        const f0 = await evaluate('window.__f.length');
        await sleep(3000);
        const m1 = Object.fromEntries((await send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        const ts = JSON.parse(await evaluate(`JSON.stringify(window.__f.slice(${f0}))`));
        const year = JSON.parse(await evaluate(bar)).date;
        const fast = JSON.parse(await evaluate(`JSON.stringify({ fast: document.querySelector('.sf-timebar').classList.contains('sf-timebar--fast'), same: window.__tick === document.querySelector('.sf-ribbon__tick') && window.__tick?.isConnected })`));
        await evaluate(`document.querySelector('.sf-tb-play').click(); true`);
        await waitFor(`!document.querySelector('.sf-timebar').classList.contains('sf-timebar--fast') && document.querySelectorAll('.sf-ribbon__seg').length > 0`, 20000);
        const after = JSON.parse(await evaluate(`JSON.stringify({ fast: document.querySelector('.sf-timebar').classList.contains('sf-timebar--fast'), segments: document.querySelectorAll('.sf-ribbon__seg').length })`));
        const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
        const q = (p) => +(d[Math.min(d.length - 1, Math.floor(p * d.length))] ?? 0).toFixed(1);
        const r = { frames: d.length, medianMs: q(0.5), p95Ms: q(0.95), scriptMsPerFrame: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / Math.max(1, d.length)).toFixed(2), reached: year };
        summary.scrub[`${view}-10y/s`] = r;
        console.log(`info  playing at 10 years a second on ${view}: ${JSON.stringify(r)}`);
        check(
          `playing at 10 years a second on ${view}: time runs, the time bar computes no day's events and rebuilds nothing, and draws the day again once paused`,
          /20[0-2]\d|199\d/.test(year) && fast.fast && fast.same && !after.fast && after.segments > 0,
          JSON.stringify({ ...fast, after, reached: year }),
        );
      }
    }
    // 9. The Almanac (almanac2 agent): the tabs on screen, and printed on A4 and US Letter.
    if (ONLY.has('almanac')) {
      summary.almanac = { views: [], prints: [], timings: {} };
      // 8 March 2016, Bowditch's worked examples' date: the opening of 7, 8 and 9 March.
      const AT = 'v=1&lat=39.9526&lon=-75.1652&place=Philadelphia&tz=America%2FNew_York&t=2016-03-08T21:00:00Z&body=Moon';
      const TABS = ['pages', 'increments', 'altitude', 'polaris', 'arc'];
      const SHEETS = { opening: 2, day: 2, increments: 1, altitude: 5, polaris: 3, arc: 1 };
      const openTab = async (tab) => {
        await evaluate(`document.querySelector('.alm-tabs [id$="-${tab}"]')?.click(); true`);
        return waitFor(`(() => { const r = document.querySelector('.almanac'); return r?.dataset.tab === '${tab}' && r.querySelectorAll('.alm-panel .alm-page').length > 0; })()`, 30000);
      };
      const setMode = async (mode) => {
        const label = mode === 'opening' ? 'Three dates' : 'One date';
        await evaluate(`[...document.querySelectorAll('.alm-subbar .sf-seg__opt')].find((b) => b.textContent.trim() === '${label}')?.click(); true`);
        return waitFor(`document.querySelectorAll('.alm-spread .alm-page${mode === 'opening' ? '.alm-opening' : ':not(.alm-opening)'}').length === 2`, 30000);
      };
      // Pages of a PDF: the page tree's /Count (Chrome writes one tree).
      const pdfPages = (data) => {
        const text = Buffer.from(data, 'base64').toString('latin1');
        const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map((m) => Number(m[1] ?? m[2]));
        return counts.length ? Math.max(...counts) : (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
      };
      const PAPERS = { A4: [8.27, 11.69], Letter: [8.5, 11] };
      const MARGIN = 10 / 25.4;
      // Each sheet's height laid out for print at the paper's printable width, in mm.
      const sheetHeights = async (pw, what = '') => {
        await send('Emulation.setEmulatedMedia', { media: 'print' });
        await send('Emulation.setDeviceMetricsOverride', { width: Math.round((pw - 2 * MARGIN) * 96), height: 900, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
        const mm = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.alm-page')].filter((p) => p.getClientRects().length > 0).map((p) => Math.round((p.getBoundingClientRect().height / 96) * 254) / 10))`));
        if (what && process.env.ALMANAC_PRINT_SHOTS === '1') {
          // The sheets as the printer lays them out, one image (for looking, not judged).
          const height = await evaluate('Math.ceil(document.documentElement.scrollHeight)');
          const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.round((pw - 2 * MARGIN) * 96), height: Math.min(height, 16000), scale: 1 } });
          writeFileSync(join(OUT, `ui-almanac-printlayout-${what}.png`), Buffer.from(r.data, 'base64'));
        }
        await send('Emulation.setEmulatedMedia', { media: '' });
        await viewport(1440, 900, false);
        return mm;
      };
      const printed = async (what, expected, papers = Object.keys(PAPERS), before = async () => {}) => {
        for (const paper of papers) {
          const [pw, ph] = PAPERS[paper];
          await before();
          const heights = await sheetHeights(pw, paper === 'A4' ? what : '');
          const r = await send('Page.printToPDF', { paperWidth: pw, paperHeight: ph, marginTop: MARGIN, marginBottom: MARGIN, marginLeft: MARGIN, marginRight: MARGIN, printBackground: true });
          const n = pdfPages(r.data);
          if (paper === 'A4') writeFileSync(join(OUT, `ui-almanac-print-${what}.pdf`), Buffer.from(r.data, 'base64'));
          const room = Math.round((ph - 2 * MARGIN) * 254) / 10;
          const tallest = heights.length ? Math.max(...heights) : 0;
          check(`almanac ${what} printed on ${paper}: ${expected} sheet${expected === 1 ? '' : 's'}, one per page`, n === expected, `${n} pages; tallest sheet ${tallest} of ${room} mm`);
          summary.almanac.prints.push({ what, paper, pages: n, expected, sheetHeightsMm: heights, roomMm: room });
        }
      };
      // In print, black on white whatever the theme: every colour the printed sheets use
      // (text, rules, fills, the zone chart's strokes) is a grey, and the paper is white.
      // Read from the styles, not the pixels: a screenshot's text carries the screen's
      // subpixel colour fringes, which a PDF does not.
      const INK = String.raw`JSON.stringify((() => {
        const chroma = (c) => {
          if (!c || c === 'none' || c === 'transparent' || c === 'currentcolor') return 0;
          let m = /^rgba?\(([^)]*)\)$/.exec(c);
          if (m) {
            const [r, g, b, a = 1] = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
            return a === 0 ? 0 : Math.max(r, g, b) - Math.min(r, g, b);
          }
          m = /^color\(srgb ([^)]*)\)$/.exec(c);
          if (m) {
            const [r, g, b, a = 1] = m[1].split(/[\s\/]+/).filter(Boolean).map(Number);
            return a === 0 ? 0 : 255 * (Math.max(r, g, b) - Math.min(r, g, b));
          }
          m = /^ok(?:lch|lab)\(([^)]*)\)$/.exec(c);
          if (m) {
            const v = m[1].split(/[\s\/]+/).filter(Boolean).map(Number);
            return /lch/.test(c) ? 400 * v[1] : 400 * Math.hypot(v[1], v[2]);
          }
          return url(c) ? 0 : 999;
        };
        const url = (c) => /^url\(/.test(c);
        const bad = [];
        const root = document.querySelector('.almanac');
        for (const el of [root, ...root.querySelectorAll('*')]) {
          if (!el.getClientRects().length) continue;
          const cs = getComputedStyle(el);
          for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor', 'fill', 'stroke', 'outlineColor', 'textDecorationColor']) {
            if (chroma(cs[prop]) > 6) bad.push(el.tagName.toLowerCase() + '.' + String(el.className.baseVal ?? el.className).split(' ')[0] + ' ' + prop + ' ' + cs[prop]);
          }
          if (cs.boxShadow !== 'none' && /rgb/.test(cs.boxShadow) && chroma((/rgba?\([^)]*\)/.exec(cs.boxShadow) ?? [''])[0]) > 6) bad.push(el.tagName.toLowerCase() + ' box-shadow ' + cs.boxShadow);
        }
        const paper = [document.documentElement, document.body, root].map((el) => getComputedStyle(el).backgroundColor);
        const white = (c) => /^rgba?\(255, 255, 255(, 1)?\)$/.test(c) || c === 'rgba(0, 0, 0, 0)';
        return { bad: [...new Set(bad)].slice(0, 8), count: bad.length, paper, paperWhite: paper.every(white) && white(paper[2]) && paper[2] !== 'rgba(0, 0, 0, 0)' };
      })())`;
      const inkCheck = async (what) => {
        await send('Emulation.setEmulatedMedia', { media: 'print' });
        await sleep(300);
        const r = JSON.parse(await evaluate(INK));
        writeFileSync(join(OUT, `ui-almanac-print-${what}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        await send('Emulation.setEmulatedMedia', { media: '' });
        check(`almanac ${what} in print: black on white`, r.count === 0 && r.paperWhite, r.count || !r.paperWhite ? `${r.count} coloured: ${r.bad.join('; ')}; paper ${r.paper.join(', ')}` : '');
      };

      for (const size of process.env.ALMANAC_SCREEN === '0' ? [] : SIZES) {
        const [w, h, mobile] = DIMS[size];
        await viewport(w, h, mobile);
        for (const theme of THEMES) {
          messages.length = 0;
          await open(`${AT}&view=almanac`, { theme });
          for (const tab of TABS) {
            const modes = tab === 'pages' ? ['opening', 'day'] : [tab];
            for (const mode of modes) {
              const drawn = await openTab(tab);
              if (tab === 'pages') await setMode(mode);
              await sleep(400);
              const tag = `almanac ${mode}, ${theme}, ${size}`;
              const L = JSON.parse(await evaluate(LAYOUT));
              const png = await shot(`almanac-${mode}-${size}-${theme}`);
              const noise = messages.filter((m) => /^(error|warning|warn|exception)/.test(m));
              check(`${tag}: drawn`, drawn);
              check(`${tag}: no sideways scroll, overlap or cut-off text`, !L.hscroll && !L.overlaps.length && !L.clipped.length, [...L.overlaps, ...L.clipped].join('; '));
              if (mobile) check(`${tag}: the view ends where the sheet begins`, L.underSheet <= 0, `${L.underSheet}px under the sheet`);
              check(`${tag}: console clean`, noise.length === 0, noise.slice(0, 3).join(' | '));
              if (theme === 'night') {
                const n = lightNotRed(decodePng(png));
                check(`${tag}: no blue, green or white light`, n.count < 50, n.count ? `${n.count} px, worst ${JSON.stringify(n.worst)}` : '');
              }
              summary.almanac.views.push({ mode, size, theme, layout: L, messages: noise });
            }
          }
        }
      }

      // Printing, on the desktop, in the night theme (the paper must not care).
      await viewport(1440, 900, false);
      await open(`${AT}&view=almanac`, { theme: 'night' });
      for (const tab of TABS) {
        const modes = tab === 'pages' ? ['opening', 'day'] : [tab];
        for (const mode of modes) {
          await openTab(tab);
          if (tab === 'pages') await setMode(mode);
          await sleep(300);
          await printed(mode, SHEETS[mode]);
          if (mode === 'opening' || mode === 'altitude') await inkCheck(mode);
        }
      }
      // The busiest year for Venus and Mars (2018: fifteen runs of dates) still prints A2 on one sheet.
      await open(`${AT.replace('t=2016-03-08T21', 't=2018-10-15T21')}&view=almanac`, { theme: 'night' });
      await openTab('altitude');
      await sleep(300);
      await printed('altitude-2018', SHEETS.altitude);
      // "Print all 30 pages" of increments: the copy made for printing, removed once printed
      // (printing to PDF fires afterprint, so it is made again for each paper).
      await openTab('increments');
      let all = true;
      await printed('increments-all', 30, Object.keys(PAPERS), async () => {
        await evaluate(`window.print = () => {}; [...document.querySelectorAll('.alm-subbar button')].find((b) => /Print all/.test(b.textContent))?.click(); true`);
        all &&= await waitFor(`document.querySelector('.almanac')?.dataset.printAll === '1' && document.querySelectorAll('.alm-print-all .alm-page').length === 30`, 30000);
      });
      check('almanac increments: "Print all 30 pages" builds the thirty sheets', all);
      check('almanac increments: the thirty sheets are removed after printing', await waitFor(`document.querySelector('.almanac')?.dataset.printAll === undefined && !document.querySelector('.alm-print-all .alm-page')`, 5000));

      // The screenshots named in the report: the opening's two facing pages side by side (a
      // 2560-class screen: the pages sit side by side where the view is wide enough for both),
      // an increments page, the Moon's corrections; light, and the opening at night.
      for (const [theme, name] of [['light', 'light'], ['night', 'night']]) {
        await viewport(2600, 1750, false);
        await open(`${AT}&view=almanac`, { theme });
        await openTab('pages');
        await setMode('opening');
        await sleep(500);
        const side = await evaluate(`(() => { const [a, b] = document.querySelectorAll('.alm-spread .alm-page'); return !!a && !!b && Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) < 1; })()`);
        check(`almanac opening on a 2600 px screen (${name}): the two pages face each other`, side);
        await shot(`almanac-opening-pair-${name}`);
      }
      await viewport(1440, 1500, false);
      await open(`${AT}&view=almanac`, { theme: 'light' });
      await openTab('increments');
      await shot('almanac-increments-page-light');
      await openTab('altitude');
      await evaluate(`(() => { const m = document.querySelector('.alm-moon-sheet'); m?.scrollIntoView({ block: 'start' }); return true; })()`);
      await sleep(400);
      await shot('almanac-moon-corrections-light');

      // Computing an opening in the browser: the next opening, from the click to the pages.
      await viewport(1440, 900, false);
      await open(`${AT}&view=almanac`, { theme: 'light' });
      await openTab('pages');
      await setMode('opening');
      const times = [];
      for (let i = 0; i < 4; i++) {
        const before = await evaluate(`document.querySelector('.alm-spread .alm-head-date')?.textContent ?? ''`);
        const t0 = Date.now();
        await evaluate(`document.querySelector('.alm-subbar [aria-label="Next"]')?.click(); true`);
        await waitFor(`(document.querySelector('.alm-spread .alm-head-date')?.textContent ?? '') !== ${JSON.stringify(before)}`, 30000);
        times.push(Date.now() - t0);
      }
      summary.almanac.timings.openingMs = times;
      console.log(`info  an opening (three daily pages) in the browser, click to pages: ${times.join(', ')} ms`);
    }
  } finally {
    page.close();
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(join(OUT, 'ui-check.json'), JSON.stringify({ results, ...summary }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} of ${results.length} checks passed; screenshots and ui-check.json in ${OUT}`);
  if (failed) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------
// 7. The Selected card's tools (photo agent, expansion programme Q8)
// ---------------------------------------------------------------------------------

/** Manhattan's 42nd Street at sunset on 24 May 2026 (Manhattanhenge), and a moonlit evening in Philadelphia. */
const MANHATTAN = 'v=1&lat=40.7527&lon=-73.9772&place=Manhattan%2C%2042nd%20Street&tz=America%2FNew_York&t=2026-05-24T23:40:00Z&body=Sun&view=map';
const MOONLIT = 'v=1&lat=39.9526&lon=-75.1652&place=Philadelphia&tz=America%2FNew_York&t=2026-09-24T02:00:00Z&body=Moon&view=map';

async function photoChecks({ send, evaluate, waitFor, messages, open, shot, viewport, summary }) {
  const js = (v) => JSON.stringify(v);
  const text = (sel) => evaluate(`document.querySelector(${js(sel)})?.textContent?.trim() ?? null`);
  const scrollPanelTo = (sel, offset = 8) =>
    evaluate(`(() => { const s = document.querySelector('.sf-panel__scroll'); const el = document.querySelector(${js(sel)}); if (!s || !el) return false; s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - ${offset}; return true; })()`);
  const openDrawers = (sels) => evaluate(`${js(sels)}.map((sel) => { const d = document.querySelector(sel); if (d) d.open = true; return Boolean(d); }).every(Boolean)`);
  const noise = () => messages.filter((m) => /^(error|warning|warn|exception)/.test(m));
  const typeInto = (sel, value) =>
    evaluate(`(() => { const i = document.querySelector(${js(sel)}); if (!i) return false; i.focus(); i.value = ${js(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); return true; })()`);
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const out = {};

  // --- Desktop, light: the Sun at Manhattan (a tall window, for the finder's days) ----------
  await viewport(1440, 1200, false);
  messages.length = 0;
  await open(MANHATTAN, { theme: 'light' });
  const light = JSON.parse(
    await evaluate(`JSON.stringify([...document.querySelectorAll('.sf-photo-light tbody tr')].map((r) => [r.dataset.kind, ...[...r.querySelectorAll('td')].map((c) => c.textContent.trim())]))`),
  );
  check('photo: golden and blue hour beside the twilight table, morning and evening', light.length === 2 && light.every((r) => r.slice(1).every((c) => /^\d\d:\d\d–\d\d:\d\d$/.test(c))), js(light));
  const mag = await evaluate(`(() => { const m = document.querySelector('.sf-photo-mag'); return m && !m.hidden ? [m.textContent, m.dataset.tip] : null; })()`);
  check('photo: the magnetic bearing under the true one, the variation and the model in its tooltip', mag && /° \d\d′ magnetic$/.test(mag[0]) && /^Variation \d+\.\d° [EW], World Magnetic Model 2025, ±/.test(mag[1]), js(mag));
  const pos = await text('.sf-photo-coord .sf-kv__v');
  check('photo: right ascension and declination on the card', /^RA \d+h \d\dm \d\ds Dec [+−]\d+° \d\d′$/.test(pos ?? ''), pos);
  await openDrawers(['.sf-photo-align']);
  await typeInto('.sf-photo-align input[id$="-az"]', '299');
  await evaluate(`document.querySelector('.sf-photo-align .sf-photo__find').click(); true`);
  await waitFor(`document.querySelectorAll('.sf-photo-align .sf-photo__row').length > 0`, 20000);
  const days = JSON.parse(
    await evaluate(`JSON.stringify([...document.querySelectorAll('.sf-photo-align .sf-photo__row')].map((r) => [r.querySelector('.sf-photo__date').textContent, r.classList.contains('sf-photo__row--best')]))`),
  );
  const best = days.filter((d) => d[1]).map((d) => d[0]);
  out.manhattan = { days: days.map((d) => d[0]), best };
  check('photo: the alignment finder gives Manhattanhenge 2026, best 24 May and 18 July (ACCURACY 14)', best.join(',') === 'Sun 24 May,Sat 18 Jul', js(out.manhattan));
  check('photo: the bearing is drawn on the map (the dial turns see-through)', await waitFor(`document.querySelector('.sfm')?.classList.contains('sfm--drawings')`, 5000));
  await scrollPanelTo('.sf-photo-light', 120);
  await sleep(400);
  await shot('photo-desktop-light-sun');
  const L1 = JSON.parse(await evaluate(LAYOUT));
  check('photo: Sun card with the finder open: no sideways scroll, overlap or cut-off text', !L1.hscroll && !L1.overlaps.length && !L1.clipped.length, [...L1.overlaps, ...L1.clipped].join('; '));
  // Pick the bearing on the map: the next click answers it, and the place stays.
  const place0 = await text('.sf-place__name');
  await evaluate(`document.querySelector('.sf-photo-align .sf-photo__pick').click(); true`);
  const prompt = await waitFor(`document.querySelector('.sfm-pick') && !document.querySelector('.sfm-pick').hidden`, 5000);
  await click(1100, 330);
  await sleep(600);
  const picked = await evaluate(`[document.querySelector('.sf-photo-align input[id$="-az"]').value, document.querySelector('.sfm-pick')?.hidden, document.querySelector('.sf-photo-align .sf-photo__sub').textContent]`);
  check('photo: Pick on the map: a prompt, then the click sets the bearing, not the place', prompt && picked[0] !== '299' && /^\d+\.\d$/.test(picked[0]) && picked[1] === true && (await text('.sf-place__name')) === place0 && /^Picked on the map/.test(picked[2]), js({ prompt, picked, place0 }));
  // "When is it at…?" by bearing: the times the Sun crosses 250° today.
  await openDrawers(['.sf-when']);
  await evaluate(`[...document.querySelectorAll('.sf-when .sf-seg__opt')].find((b) => b.dataset.value === 'bearing')?.click(); true`);
  await typeInto('.sf-when input[id$="-az"]', '250');
  const crossed = await waitFor(`document.querySelectorAll('.sf-when .sf-when__time').length > 0`, 10000);
  const whenText = await evaluate(`[document.querySelector('.sf-when .sf-when__status')?.textContent, document.querySelector('.sf-when .sf-when__time')?.getAttribute('aria-label')]`);
  check('photo: "When is it at…?" by bearing lists when the Sun crosses 250°', crossed && /^Sun on 250\.0° on /.test(whenText?.[0] ?? '') && /^Show \d\d:\d\d: Sun on 250\.0°, (climbing|sinking), /.test(whenText?.[1] ?? ''), js(whenText));
  check('photo: Sun card: console clean', noise().length === 0, noise().slice(0, 3).join(' | '));

  // --- Desktop, light: the Moon, then the night theme --------------------------------------------
  await viewport(1440, 1000, false);
  for (const theme of ['light', 'night']) {
    messages.length = 0;
    await open(MOONLIT, { theme });
    await openDrawers(['.sf-photo-mw', '.sf-selected details.sf-details[data-term]']);
    // The planner draws when it opens; the details' reading in the card's next frame.
    await waitFor(`document.querySelectorAll('.sf-photo-moon__feat').length > 0 && !document.querySelector('.sf-photo-mw [data-stale]') && /\\d/.test(document.querySelector('.sf-photo-predict .sf-kv__v')?.textContent ?? '')`, 20000);
    await sleep(300);
    const moon = JSON.parse(
      await evaluate(`JSON.stringify({
        size: document.querySelector('.sf-photo-moon .sf-kv__v')?.textContent,
        lib: document.querySelector('.sf-photo-moon__lib')?.textContent,
        perigee: [...document.querySelectorAll('.sf-photo-moon .sf-kv')].find((r) => /perigee/.test(r.textContent))?.querySelector('.sf-kv__v')?.textContent,
        feats: document.querySelectorAll('.sf-photo-moon__feat').length,
        planner: document.querySelector('.sf-photo-mw .sf-photo__lines')?.textContent,
        predict: document.querySelector('.sf-photo-predict .sf-kv__v')?.textContent,
        predictNote: document.querySelector('.sf-photo-predict .sf-photo__sub')?.textContent,
        detailsOpen: document.querySelector('.sf-selected details.sf-details[data-term]')?.open,
      })`),
    );
    if (theme === 'light') {
      out.moon = moon;
      check('photo: Moon card: size, libration, perigee, features on the terminator', /^\d\d\.\d′$/.test(moon.size ?? '') && /^(Tipped to show|It faces us)/.test(moon.lib ?? '') && /^\w{3} \d+ \w{3} \d\d:\d\d$/.test(moon.perigee ?? '') && moon.feats > 0, js(moon));
      check('photo: the Milky Way planner and the predicted sextant reading', /Milky Way’s core/.test(moon.planner ?? '') && /^\d+° \d\d\.\d′$/.test(moon.predict ?? ''), js({ planner: moon.planner?.slice(0, 80), predict: moon.predict, note: moon.predictNote, open: moon.detailsOpen }));
    }
    await scrollPanelTo('.sf-moon', 8);
    await sleep(400);
    const png = await shot(`photo-desktop-${theme}-moon`);
    const L = JSON.parse(await evaluate(LAYOUT));
    check(`photo: Moon card, ${theme}: no sideways scroll, overlap or cut-off text`, !L.hscroll && !L.overlaps.length && !L.clipped.length, [...L.overlaps, ...L.clipped].join('; '));
    if (theme === 'night') {
      const n = lightNotRed(decodePng(png));
      check('photo: Moon card and planner in the night theme: no blue, green or white light', n.count < 50, n.count ? `${n.count} px, worst ${js(n.worst)}` : '');
    }
    check(`photo: Moon card, ${theme}: console clean`, noise().length === 0, noise().slice(0, 3).join(' | '));
  }

  // --- The tides line: hidden until the pack is got in Settings → Data packs -------------------
  messages.length = 0;
  await open(MOONLIT, { theme: 'dark' });
  const before = await evaluate(`document.querySelector('.sf-photo-tide')?.hidden`);
  await evaluate(`document.querySelector('button[aria-label="Settings"]').click(); true`);
  const got = await waitFor(`Boolean(document.querySelector('.sf-packs-row[data-pack="tides-us"] button'))`, 10000);
  if (got) await evaluate(`[...document.querySelectorAll('.sf-packs-row[data-pack="tides-us"] button')].find((b) => /Get/.test(b.textContent))?.click(); true`);
  const shown = await waitFor(`(() => { const t = document.querySelector('.sf-photo-tide'); return t && !t.hidden && /Next high water/.test(t.textContent); })()`, 20000);
  const tide = await evaluate(`[document.querySelector('.sf-photo-tide')?.textContent, document.querySelector('.sf-photo-tide')?.dataset.tip]`);
  out.tide = tide?.[0];
  check('photo: the tides line appears in Place once the tides pack is got, labelled a prediction', before === true && shown && /predicted, not observed/.test(tide?.[0] ?? '') && /NOAA/.test(tide?.[1] ?? ''), js({ before, got, tide: tide?.[0] }));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  // Its link opens the Charts view on the Tides tab (charts2's showCharts).
  await evaluate(`[...document.querySelectorAll('.sf-photo-tide .sf-link')].find((b) => /Tides chart/.test(b.textContent))?.click(); true`);
  const tidesTab = await waitFor(`location.hash === '#charts' && document.querySelector('.sfc-tabs [data-tab="tides"]')?.getAttribute('aria-selected') === 'true'`, 15000);
  check('photo: "Tides chart" opens Charts on its Tides tab', tidesTab, await evaluate(`location.hash + ' ' + (document.querySelector('.sfc-tabs [aria-selected="true"]')?.textContent ?? '')`));
  // A planet's size in the sky (planetdetail's planet_disc).
  await open(MOONLIT.replace('body=Moon', 'body=Jupiter'), { theme: 'dark' });
  const jupiter = await waitFor(`[...document.querySelectorAll('.sf-selected .sf-kv')].some((r) => /Size in the sky/.test(r.textContent) && /\\d+\\.\\d″$/.test(r.querySelector('.sf-kv__v')?.textContent ?? ''))`, 10000);
  check('photo: a planet’s size in the sky', jupiter, await evaluate(`[...document.querySelectorAll('.sf-selected .sf-kv')].find((r) => /Size in the sky/.test(r.textContent))?.textContent ?? 'no row'`));
  check('photo: getting the tides pack: console clean', noise().length === 0, noise().slice(0, 3).join(' | '));

  // --- Phone, dark: the Sun card with the finder --------------------------------------------------
  await viewport(390, 844, true);
  messages.length = 0;
  await open(MANHATTAN, { theme: 'dark' });
  await openDrawers(['.sf-photo-align']);
  await typeInto('.sf-photo-align input[id$="-az"]', '299');
  await evaluate(`document.querySelector('.sf-photo-align .sf-photo__find').click(); true`);
  await waitFor(`document.querySelectorAll('.sf-photo-align .sf-photo__row').length > 0`, 20000);
  // The layout as the other phone checks judge it, with the sheet at half height, as it
  // opens (at full height the map's own controls lie under it, which an overlap test
  // cannot see) ...
  await scrollPanelTo('.sf-photo-align', 8);
  await sleep(500);
  const LP = JSON.parse(await evaluate(LAYOUT));
  check('photo: phone, Sun card with the finder open: no sideways scroll, overlap or cut-off text', !LP.hscroll && !LP.overlaps.length && !LP.clipped.length && LP.underSheet <= 0, [...LP.overlaps, ...LP.clipped, LP.underSheet > 0 ? `${LP.underSheet}px under the sheet` : ''].join('; '));
  // ... and the picture at full height, the finder's days in view.
  await evaluate(`document.querySelector('.sf-panel__grab').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); true`);
  await scrollPanelTo('.sf-photo-light', 60);
  await sleep(500);
  await shot('photo-phone-dark-sun');
  check('photo: phone: console clean', noise().length === 0, noise().slice(0, 3).join(' | '));

  // --- What the open drawers add to a time-bar drag (on About: no map drawing) ----------------
  await viewport(1440, 900, false);
  const drag = async (hash, drawers) => {
    await open(hash, { theme: 'dark' });
    if (drawers) await openDrawers(['.sf-when', '.sf-photo-align', '.sf-photo-mw', '.sf-selected details.sf-details[data-term]']);
    await sleep(1500);
    const hb = JSON.parse(await evaluate(`JSON.stringify((() => { const r = document.querySelector('.sf-ribbon__handle').getBoundingClientRect(); const t = document.querySelector('.sf-ribbon').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, right: t.right }; })())`));
    await evaluate(`window.__f = []; (function loop(t) { window.__f.push(t); if (window.__f.length < 100000) requestAnimationFrame(loop); })(performance.now()); true`);
    const m0 = Object.fromEntries((await send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const f0 = await evaluate('window.__f.length');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hb.x, y: hb.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 60; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hb.x + (hb.right - 40 - hb.x) * (i / 60), y: hb.y, button: 'left', buttons: 1 });
      await sleep(16);
    }
    const m1 = Object.fromEntries((await send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const frames = (await evaluate('window.__f.length')) - f0;
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hb.right - 40, y: hb.y, button: 'left', clickCount: 1 });
    await sleep(600);
    return +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / Math.max(1, frames)).toFixed(2);
  };
  // A warm-up, then each case three times, interleaved; the least of each (the machine's
  // other work only ever adds).
  const STAR = MOONLIT.replace('body=Moon', 'body=Sirius').replace('view=map', 'view=about');
  const MOON = MOONLIT.replace('view=map', 'view=about');
  await drag(MOON, true);
  const runs = { star: [], moonClosed: [], moonOpen: [] };
  for (let i = 0; i < 3; i++) {
    runs.star.push(await drag(STAR, false));
    runs.moonClosed.push(await drag(MOON, false));
    runs.moonOpen.push(await drag(MOON, true));
  }
  const least = (a) => Math.min(...a);
  out.drag = {
    starMsPerFrame: least(runs.star),
    moonClosedMsPerFrame: least(runs.moonClosed),
    moonOpenMsPerFrame: least(runs.moonOpen),
    addedByDrawersMs: +(least(runs.moonOpen) - least(runs.moonClosed)).toFixed(2),
    addedOverStarMs: +(least(runs.moonOpen) - least(runs.star)).toFixed(2),
    runs,
  };
  console.log(`info  photo: dragging the time bar on About (script ms a frame): ${js(out.drag)}`);
  // Judged only on a machine quiet enough to measure: when even a star's frame takes more
  // than a frame's 16 ms, other work on the machine sets the numbers, not the page.
  if (out.drag.starMsPerFrame <= 16) {
    check('photo: the Moon card with every drawer open adds under 5 ms of script to a time-bar frame', out.drag.addedOverStarMs < 5, js(out.drag));
  } else {
    console.log(`info  photo: the drawers' cost is not judged: the machine was too busy (a star's frame took ${out.drag.starMsPerFrame} ms of script)`);
  }
  summary.photo = out;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
