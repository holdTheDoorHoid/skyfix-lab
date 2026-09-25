#!/usr/bin/env node
/**
 * Check the whole explorer in a real browser, the way the polish pass did: serves a built
 * site under /skyfix-lab/ (as GitHub Pages does), drives a local headless Chrome over the
 * DevTools protocol, and checks, on every view:
 *
 *   1. (views) in the light, dark and night themes, at 1440 x 900 and at 390 x 844 (a
 *      phone): the honesty banner is on screen, the engine badge says WASM, nothing scrolls
 *      sideways, no two controls overlap, no text is cut off, the view ends where the
 *      phone's bottom sheet begins, and the console stays free of errors and warnings;
 *   2. (night) in the night theme, no pixel carries blue, green or white light (a
 *      screenshot is sampled; the theme's red-orange accent is allowed);
 *   3. (leaks) switching views many times leaves no listeners, DOM nodes or canvases behind;
 *   4. (keys) the time keys move the time, and typing in a field never does;
 *   5. (privacy) the address bar never carries the place, and storage holds no position
 *      until a sight is entered in Navigate;
 *   6. (scrub) dragging the time bar on each view: frame times, reported (not judged: a
 *      headless browser draws WebGL and canvas in software, so the map and sky are far
 *      slower here than on a real screen);
 *   7. (charts, charts2 agent) every Charts tab and sub-view (Day, Year, the five Sun charts,
 *      the two Moon charts, Planets, Tides): drawn, no overlap or cut-off text, no sideways
 *      scroll, a clean console, no blue or white light in the night theme; the tides pack's
 *      one prompt and Get; the Save menu writing a real PNG and CSV; each chart's compute
 *      time and the frame times of a drag on the Sun path, reported. By default in the light
 *      and night themes on a laptop and the night theme on a phone (CHART_MATRIX; FULL=1 for
 *      every theme and size, about 20 minutes more);
 *   8. (time, time-ui agent) deep time: a BC date in the Julian calendar with its era, local
 *      mean time and UT on the clock, the ±ΔT chip, the calendar's century step and October
 *      1582, UTC inside 1972-2035; playback at ten years a second on the Map view (frame
 *      times and script time per frame, reported) and the Sky view;
 *   9. (almanac, almanac2 agent) every Almanac tab (daily pages as a three-date opening and
 *      as one date, increments, altitude corrections, Polaris, arc to time) in each theme
 *      and size: drawn, no overlap or cut-off text, no sideways scroll, a clean console, no
 *      blue or white light in the night theme; every tab printed to PDF on A4 and on US
 *      Letter as exactly the sheets it promises (one per page: 2, 2, 1, 5, 3, 1, and 30 for
 *      "Print all"), black on white whatever the theme; the time to compute an opening,
 *      reported;
 *  10. (navigate2) Navigate's Compass and Passage tabs, the route on the map, the star
 *      finder and the print preview of the worksheets and plotting sheet: each works, lays
 *      out without overlap or cut-off text, keeps the console clean, and in the night theme
 *      shows no blue, green or white light (the preview's paper included);
 *  11. (photo, photo agent) the Selected card's photographer and astronomer tools: golden
 *      and blue hour, the alignment finder (Manhattanhenge) and picking its bearing on the
 *      map, the Moon's details, the Milky Way planner, RA/Dec and the magnetic bearing, the
 *      predicted sextant reading, the tides line once the pack is got in Settings (and the
 *      pack removed again there), the night theme and the phone layout with every drawer
 *      open, and what the open drawers add to a time-bar drag (judged when the machine is
 *      quiet enough);
 *  12. (tonight, tonight agent) the Tonight view: eight tabs with Tonight and without About,
 *      About from the Help menu and at #about; the night of the moment with every card
 *      filled in, drawn within 300 ms of the engines' answer (the engines' own time
 *      reported); a moment of the night and ◀ ▶ moving the explorer's time; a planet
 *      opening the Sky view; the printed sheet on one page of Letter and of A4;
 *  13. (sky2, sky2 agent) the Sky view's astronomy layers: at night the Milky Way and
 *      deep-sky objects, the panel's Tonight's sights ringed; the Sky view's search (M31 →
 *      its card with the best time tonight) and the panel's "Sky objects" group (Jupiter →
 *      its card → its close-up with the four moons); tonight's ranking; a field of view;
 *      "How dark is your sky" (a city sky hides the Milky Way and most deep-sky objects);
 *      the dome's zoom; the picture saved as a real PNG with its caption; photo's hooks (the
 *      Moon card's "See it up close", the Milky Way planner's "Show in Sky"); Tonight's
 *      "Show in Sky" and "See it up close" centring the zoomed dome; the night theme
 *      red-only with the card and the close-up open; the phone layout (frame times are the
 *      developer page's bench: headless Chrome here runs few animation frames);
 *  14. (events, events2 agent) every Events tab and sub-list (Eclipses; Moon: phases,
 *      perigee, occultations; Planets: highlights, close approaches, retrograde, transits,
 *      Jupiter's moons; Meteors; Seasons) in each theme and size: filled in, no overlap or
 *      cut-off text, no sideways scroll, the view ending where the sheet begins, a clean
 *      console, no blue or white light in the night theme; the occultation, transit and
 *      shower cards with their drawings; the Save menu writing a real calendar file (RFC
 *      5545 basics) and table; a background search that waits while the time bar is
 *      dragged and finishes once it is let go; a solar eclipse card offering the Lunar limb
 *      pack once and, with it, limb-corrected;
 *  15. (far, polish2 agent) every view and its tabs at 28 May 585 BC and 1 January 2999, on
 *      a laptop (dark) and a phone (night): no overlap, cut-off text or sideways scroll (the
 *      notices take their own band), no literal "UTC" on a UT date, no "1990"/"2060" and no
 *      raw engine message on screen, no control without a name, every labelled-tier time on
 *      the Selected card with its ± chip, and no blue or white light at night.
 *
 * The blocks run in that order. Screenshots and a JSON summary go to docs/design/local/
 * (git-ignored). Development tool only: Node built-ins and a local Chrome, no npm
 * dependency. OWNER: polish pass.
 *
 *   npm run build --prefix web && node web/scripts/ui-check.mjs
 *   SITE=site node web/scripts/ui-check.mjs          # the assembled Pages site
 *   ONLY=views,night node web/scripts/ui-check.mjs    # some blocks, by the names in brackets above:
 *        views,night,leaks,keys,privacy,scrub,charts,time,almanac,navigate2,photo,tonight,sky2,events,far
 *   ONLY=charts CHARTS=sun/path,tides node web/scripts/ui-check.mjs      # some charts (tab or tab/sub)
 *   ONLY=charts FULL=1 node web/scripts/ui-check.mjs  # every chart in every theme and size
 *   ONLY=almanac ALMANAC_SCREEN=0 node web/scripts/ui-check.mjs          # the Almanac's printed sheets only
 *   ONLY=events EVENTS=moon/occultations,meteors node web/scripts/ui-check.mjs   # some Events lists
 *   ONLY=far FAR_VIEWS=sky,events node web/scripts/ui-check.mjs          # far dates on some views
 *
 * Environment: SITE (default web/dist), PREFIX (/skyfix-lab/), CHROME (google-chrome),
 * OUT (docs/design/local), VIEWS, THEMES, SIZES, SWITCHES (default 50), CHARTS, EVENTS,
 * CHART_MATRIX (default desktop:light,desktop:night,phone:night), FULL, FAR_VIEWS.
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
const VIEWS = (process.env.VIEWS ?? 'map,sky,tonight,charts,navigate,almanac,events,learn,about').split(',');
const THEMES = (process.env.THEMES ?? 'light,dark,night').split(',');
const SIZES = (process.env.SIZES ?? 'desktop,phone').split(',');
const ONLY = new Set((process.env.ONLY ?? 'views,night,leaks,keys,privacy,scrub,charts,time,almanac,navigate2,photo,tonight,sky2,events,far').split(','));
/** events2: the Events view's tabs and sub-lists, `tab` or `tab/sub`. */
const EVENT_VIEWS = (process.env.EVENTS ?? 'eclipses,moon/phases,moon/apsides,moon/occultations,planets/events,planets/conjunctions,planets/retrograde,planets/transits,planets/jupiter,meteors,seasons').split(',');
/**
 * polish2: the size and theme pairs the Charts block walks (a full walk is 66 page loads,
 * about 20 minutes on the shared machine); FULL=1 for every pair of SIZES and THEMES.
 */
const CHART_MATRIX = new Set(process.env.FULL === '1' ? SIZES.flatMap((z) => THEMES.map((t) => `${z}:${t}`)) : (process.env.CHART_MATRIX ?? 'desktop:light,desktop:night,phone:night').split(','));
/** polish2: the views the far-dates block walks (with their tabs). */
const FAR_VIEWS = (process.env.FAR_VIEWS ?? 'map,sky,tonight,charts,navigate,almanac,events,learn,about').split(',');
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
      const order = ['sky', 'tonight', 'charts', 'navigate', 'almanac', 'events', 'learn', 'about', 'globe', 'map'];
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
      // Two rounds first: a view's first visit loads its code and may read data once (the
      // Tonight view reads the site's pack list, which fills Settings → Data packs); on a slow
      // machine a view can be left before it has mounted, so one round may not be enough.
      await cycle(order.length * 2);
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
          // The default matrix is smaller (polish2, list item 22): FULL=1 for all of it.
          if (!CHART_MATRIX.has(`${size}:${theme}`)) continue;
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

    // 8. Deep time (time-ui agent).
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
              // A label wider than its button spills into the next one without either box
              // overlapping (the layout check above cannot see it).
              const spill = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.almanac button, .almanac select')].filter((b) => b.getClientRects().length > 0 && b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim().slice(0, 30)))`));
              check(`${tag}: every button's label fits it`, spill.length === 0, spill.join('; '));
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
      // Before 1767, and outside the validated tier, the opening's right page carries more notes
      // (the first almanac's year, the historical estimate): still two sheets (polish2).
      await open(`${AT.replace(/t=[^&]+/, 't=-0584-05-22T12:00:00Z')}&view=almanac`, { theme: 'night' });
      await openTab('pages');
      await setMode('opening');
      await sleep(300);
      await printed('opening-585bc', SHEETS.opening);
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

    // 10. Navigate's expansion (navigate2): Compass, Passage, the star finder, the printables.
    if (ONLY.has('navigate2')) {
      const tab = (name) => `(() => { const t = [...document.querySelectorAll('.sfn-tabs [role=tab]')].find((x) => x.textContent === ${JSON.stringify(name)}); t?.click(); return !!t; })()`;
      const setField = (root, label, value) =>
        `(() => { const r = document.querySelector(${JSON.stringify(root)}); const l = r && [...r.querySelectorAll('label')].find((x) => x.textContent.startsWith(${JSON.stringify(label)})); const i = l && document.getElementById(l.getAttribute('for')); if (!i) return false; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true; })()`;
      for (const size of SIZES) {
        const [w, h, mobile] = DIMS[size];
        await viewport(w, h, mobile);
        for (const theme of ['light', 'night']) {
          const tag = `navigate2, ${theme}, ${size}`;
          const nightCheck = async (png, what) => {
            if (theme !== 'night') return;
            const n = lightNotRed(decodePng(png));
            check(`${tag}: ${what}: no blue, green or white light`, n.count < 50, n.count ? `${n.count} px, worst ${JSON.stringify(n.worst)}` : '');
          };
          const layout = async (what) => {
            const L = JSON.parse(await evaluate(LAYOUT));
            check(`${tag}: ${what}: no sideways scroll, overlap or cut-off text`, !L.hscroll && !L.overlaps.length && !L.clipped.length, [...L.overlaps, ...L.clipped].join('; '));
          };
          messages.length = 0;
          await open(`${MOMENT}&view=navigate`, { theme });
          await waitFor(`!!document.querySelector('.sfn-tabs')`);
          // Compass: the variation here, then a bearing of the Sun.
          await evaluate(tab('Compass'));
          const variation = await waitFor(`/Variation .* \\(WMM2025\\)/.test(document.querySelector('.sfn-variation')?.textContent ?? '')`, 15000);
          check(`${tag}: Compass: the variation at the place, with its model`, variation);
          await evaluate(setField('.sfn-method--compass', 'The compass read', '100'));
          const sentence = await waitFor(`/^Compass error .*; variation .*; deviation .*\\.$/.test(document.querySelector('.sfn-compass__sentence')?.textContent ?? '')`, 15000);
          check(`${tag}: Compass: a bearing gives compass error, variation and deviation`, sentence, await evaluate(`document.querySelector('.sfn-compass__sentence')?.textContent ?? ''`));
          await sleep(300);
          await layout('Compass');
          await nightCheck(await shot(`navigate2-compass-${size}-${theme}`), 'Compass');
          // Passage: two waypoints, a speed, a departure.
          await evaluate(tab('Passage'));
          await waitFor(`!!document.querySelector('.sfn-method--passage')`);
          for (const [pos, name] of [['36 55.6 N, 076 00.2 W', 'Cape Henry'], ['32 22.8 N, 064 40.8 W', 'Bermuda']]) {
            await evaluate(setField('.sfn-method--passage', 'Add a waypoint', pos));
            await evaluate(setField('.sfn-method--passage', 'Its name', name));
            await evaluate(`[...document.querySelectorAll('.sfn-method--passage button')].find((b) => b.textContent.trim() === 'Add')?.click(); true`);
            await sleep(250);
          }
          await evaluate(setField('.sfn-method--passage', 'Speed (knots)', '6'));
          await evaluate(setField('.sfn-method--passage', 'Departure (UTC)', '2026-09-24 12:00:00'));
          const planned = await waitFor(`/NM in 1 leg, .* at 6 kn: arriving/.test(document.querySelector('.sfn-method--passage .sfn-compass__sentence')?.textContent ?? '')`, 15000);
          check(`${tag}: Passage: a great-circle leg with its distance, time and arrival`, planned, await evaluate(`document.querySelector('.sfn-method--passage .sfn-compass__sentence')?.textContent ?? ''`));
          await sleep(300);
          await layout('Passage');
          await nightCheck(await shot(`navigate2-passage-${size}-${theme}`), 'Passage');
          // The route on the map ("Show on the map"), then back to Navigate.
          await evaluate(`[...document.querySelectorAll('.sfn-method--passage button')].find((b) => b.textContent.trim() === 'Show on the map')?.click(); true`);
          const onMap = await waitFor(`location.hash.includes('map') && document.querySelector('.sfm')?.dataset.detail === '1'`, 30000);
          await sleep(2500);
          check(`${tag}: Passage: "Show on the map" opens the map with the route`, onMap);
          await nightCheck(await shot(`navigate2-passage-map-${size}-${theme}`), 'the route on the map');
          await evaluate(`location.hash = '#navigate'; true`);
          await waitFor(`!!document.querySelector('.sfn-tabs')`, 15000);
          // The star finder, in the Plan tab.
          await evaluate(tab('Plan sights'));
          const finder = await waitFor(`document.querySelectorAll('.sfn-sfcard .sfn-sf__star').length === 58`, 15000);
          check(`${tag}: the star finder draws the 58 stars and its template`, finder && (await evaluate(`!!document.querySelector('.sfn-sf__turn[transform^="rotate("]')`)));
          await evaluate(`document.querySelector('.sfn-sfcard')?.scrollIntoView({ block: 'start' }); true`);
          await sleep(300);
          await layout('Plan sights with the star finder');
          await nightCheck(await shot(`navigate2-starfinder-${size}-${theme}`), 'star finder');
          // The printables: an example's fix, then its worksheets and plotting sheet.
          await evaluate(`(() => { const s = document.querySelector('.sfn-head select'); s.value = 'x:dusk-stars'; s.dispatchEvent(new Event('change')); [...document.querySelectorAll('.sfn-head button')].find((b) => b.textContent.trim() === 'Load')?.click(); return true; })()`);
          await evaluate(tab('Fix'));
          await waitFor(`!!document.querySelector('.sfn-method--fix .sfn-method__results .sf-btn') && [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Print worksheets and plotting sheet') && !b.disabled)`, 20000);
          await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Print worksheets and plotting sheet'))?.click(); true`);
          const sheets = await waitFor(`document.querySelectorAll('.sfn-print-root .sfn-sheet').length === 6 && document.documentElement.dataset.printView === 'navigate-sheet'`, 10000);
          check(`${tag}: Print: the plotting sheet and five worksheets in the preview`, sheets);
          await sleep(300);
          await nightCheck(await shot(`navigate2-print-${size}-${theme}`), 'print preview');
          await evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
          await sleep(200);
          check(`${tag}: Print: Esc closes the preview and clears the print view`, await evaluate(`!document.querySelector('.sfn-print-root') && !document.documentElement.dataset.printView`));
          // Dates (the time-ui helpers, once): a date before 1582 typed as a sight's time is read
          // as Julian and named so, the clock's word is UT, the sight is refused with the reason;
          // the Place panel says local mean time in 1800, with UT in its offset.
          if (theme === 'light' && size === SIZES[0]) {
            await evaluate(tab('Fix'));
            // 1500: before the reform and, since the deeptime merge, before the validated tier
            // (1550 to 2650), so the sight is refused (polish2: the date was 1550).
            await evaluate(setField('.sfn-entry', 'Time of the sight', '1500-03-01 12:00:00'));
            await sleep(150);
            const D = JSON.parse(await evaluate(`JSON.stringify((() => { const l = [...document.querySelectorAll('.sfn-entry label')].find((x) => x.textContent.startsWith('Time of the sight')); const f = l?.closest('.sfn-field'); return { label: l?.textContent ?? '', help: f?.querySelector('.sfn-help')?.textContent ?? '', tier: document.querySelector('.sfn-entry__tier')?.textContent ?? '', blocked: !!document.querySelector('.sfn-entry__actions button')?.disabled }; })())`));
            check(`${tag}: a sight's date before 1582 is read as Julian, on UT, and refused with the reason`, D.label === 'Time of the sight (UT)' && /Sun 1 Mar 1500, Julian calendar/.test(D.help) && /^No sights for 1 March 1500 \(Julian\)/.test(D.tier) && D.blocked, JSON.stringify(D));
            await evaluate(setField('.sfn-entry', 'Time of the sight', ''));
            // 1500: local mean time (before 1850) and outside the validated tier (polish2: was 1800).
            await open(`${MOMENT.replace(/&t=[^&]+/, '&t=1500-06-01T12:00:00Z')}&view=navigate`, { theme });
            await waitFor(`!!document.querySelector('.sfn-tabs') && /LMT/.test(document.querySelector('.sf-place .sf-kv--zone')?.textContent ?? '')`, 15000);
            const P = JSON.parse(await evaluate(`JSON.stringify({ zone: document.querySelector('.sf-place .sf-kv--zone')?.textContent ?? '', reason: document.querySelector('.sf-place__reason')?.textContent ?? '', tierline: document.querySelector('.sfn-tierline')?.textContent ?? '' })`));
            check(`${tag}: the Place panel in 1500: local mean time, UT in the offset, and why`, /LMT\s*UT−5:00:40/.test(P.zone) && /^Local mean time at 75° 09\.9′ W \(UT−5:00:40\)/.test(P.reason), JSON.stringify(P));
            check(`${tag}: Navigate says the time bar is outside the validated span`, /^The time bar is outside the validated span\. Navigate offers no sights/.test(P.tierline), P.tierline);
          }
          const noise = messages.filter((m) => /^(error|warning|warn|exception)/.test(m));
          check(`${tag}: console clean`, noise.length === 0, noise.slice(0, 3).join(' | '));
        }
      }
      await viewport(1440, 900, false);
    }

    // 11. The Selected card's photographer and astronomer tools (photo agent, expansion Q8).
    if (ONLY.has('photo')) await photoChecks({ send, evaluate, waitFor, messages, open, shot, viewport, summary });
    await viewport(1440, 900, false);

    // 12. The Tonight view (tonight agent).
    if (ONLY.has('tonight')) {
      await viewport(1440, 900, false);
      summary.tonight = {};
      const filled = `document.querySelector('.sft')?.dataset.coming === 'done'`;
      const timeLabel = `[...document.querySelectorAll('.sf-timebar button')].map((b) => b.getAttribute('aria-label') || '').filter((l) => /^(Date|Time):/.test(l)).join(' / ')`;
      messages.length = 0;
      await open(`${MOMENT}&view=tonight`);
      await waitFor(filled, 60000);
      const T = JSON.parse(await evaluate(`JSON.stringify((() => {
        const q = (s) => document.querySelector(s);
        const all = (s) => [...document.querySelectorAll(s)];
        const r = q('.sft');
        return {
          tabs: all('.sf-views__tab').map((b) => b.dataset.view),
          current: q('.sf-views__tab[aria-current=page]')?.dataset.view ?? '',
          date: q('.sft-title')?.textContent.trim() ?? '',
          sentences: all('.sft-lead').length,
          moments: all('.sft-moment .sft-time').length,
          dso: all('.sft-dso').length,
          planets: all('.sft-card--planets .sft-row').length,
          coming: all('.sft-coming__item').length,
          light: all('.sft-lightrow').length,
          coreMs: Number(r?.dataset.coreMs ?? NaN),
          drawMs: Number(r?.dataset.drawMs ?? NaN),
        };
      })())`));
      summary.tonight.page = T;
      check('Tonight: eight tabs, Tonight among them and About not', T.tabs.length === 8 && T.tabs.includes('tonight') && !T.tabs.includes('about') && T.current === 'tonight', T.tabs.join(','));
      check('Tonight at noon EDT on 24 September 2026 is the night of Thursday 24 September, with its summary', /^Thursday 24 September/.test(T.date) && T.sentences >= 2, `${T.date} · ${T.sentences} sentences`);
      check('Tonight: every card is filled in', T.moments >= 8 && T.dso === 8 && T.planets >= 2 && T.coming >= 3 && T.light === 4, JSON.stringify(T));
      check('Tonight: drawn within 300 ms of the engines answering', T.drawMs < 300, `${T.drawMs} ms to draw; the engines took ${T.coreMs} ms for the night's core (reported, not judged)`);
      console.log(`info  Tonight: the engines took ${T.coreMs} ms for the night's core, the page ${T.drawMs} ms to draw it`);
      check('Tonight: console clean', !messages.some((m) => /^(error|warning|warn|exception)/.test(m)), messages.slice(0, 3).join(' | '));

      // A moment of the night sets the explorer's time.
      const sunset = await evaluate(`(() => { const b = [...document.querySelectorAll('.sft-moment')].find((m) => /Sunset/.test(m.textContent))?.querySelector('.sft-time'); b?.click(); return b?.textContent ?? ''; })()`);
      // The time bar redraws in the next frame; a loaded machine can make that late.
      await waitFor(`(${timeLabel}).includes(${JSON.stringify(`Time: ${sunset}`)})`, 10000);
      const after = await evaluate(timeLabel);
      check('Tonight: a moment of the night moves the explorer there', sunset && after.includes(`Time: ${sunset}`), `${sunset} -> ${after}`);

      // ◀ ▶ step a night, moving the explorer's time.
      await evaluate(`document.querySelector('.sft-head__nav button[aria-label="The night after"]').click(); true`);
      await waitFor(`/^Friday 25 September/.test(document.querySelector('.sft-title')?.textContent ?? '')`, 20000);
      const nextDate = await evaluate(`document.querySelector('.sft-title').textContent.trim()`);
      await evaluate(`document.querySelector('.sft-head__nav button[aria-label="The night before"]').click(); true`);
      await evaluate(`document.querySelector('.sft-head__nav button[aria-label="The night before"]').click(); true`);
      await waitFor(`/^Wednesday 23 September/.test(document.querySelector('.sft-title')?.textContent ?? '')`, 20000);
      const prevDate = await evaluate(`document.querySelector('.sft-title').textContent.trim()`);
      await waitFor(`/Wednesday 23 September/.test(${timeLabel})`, 10000);
      const bar = await evaluate(timeLabel);
      check('Tonight: ▶ and ◀ step a night and the time bar follows', /^Friday 25 September/.test(nextDate) && /^Wednesday 23 September/.test(prevDate) && /Wednesday 23 September/.test(bar), `${nextDate} · ${prevDate} · ${bar}`);

      // A planet opens the Sky view with it selected.
      await open(`${MOMENT}&view=tonight`);
      await waitFor(filled, 60000);
      const planet = await evaluate(`(() => { const b = document.querySelector('.sft-card--planets .sft-row[data-body]'); b?.click(); return b?.dataset.body ?? ''; })()`);
      const sky = await waitFor(`/^Sky/.test(document.title)`, 20000);
      check('Tonight: a planet opens the Sky view with it selected', planet && sky, `${planet} · ${await evaluate('document.title')}`);

      // About: from the Help menu, and at #about.
      await open(`${MOMENT}&view=tonight`);
      await evaluate(`document.querySelector('button[aria-label="Help and keys"]').click(); true`);
      await sleep(400);
      await evaluate(`document.querySelector('.sf-help__about').click(); true`);
      const aboutFromHelp = await waitFor(`/^About/.test(document.title) && !!document.querySelector('.sf-about')`, 20000);
      await open('about');
      const aboutAtHash = await waitFor(`/^About/.test(document.title) && !!document.querySelector('.sf-about')`, 20000);
      const tabbable = await evaluate(`[...document.querySelectorAll('.sf-views__tab')].filter((b) => b.tabIndex === 0).length`);
      check('About opens from the Help menu and at #about, and the tab strip stays in the Tab order', aboutFromHelp && aboutAtHash && tabbable === 1, `help ${aboutFromHelp}, #about ${aboutAtHash}, tabbable ${tabbable}`);
      // About's links (polish2): the manual, every data source and its licence, and the source
      // code. The manual is built from docs/*.md, so each page it links to must have its file.
      const aboutLinks = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.sf-about a[href]')].map((a) => a.getAttribute('href')))`));
      const manualPage = (href) => { const m = /^docs\/(?:([A-Za-z_]+)\.html)?(?:#.*)?$/.exec(href); return !!m && existsSync(join(REPO, 'docs', m[1] ? `${m[1]}.md` : 'SUMMARY.md')); };
      const wantedLinks = ['docs/', 'docs/THIRD_PARTY.html', 'https://github.com/holdTheDoorHoid/skyfix-lab'];
      check('About links the manual, every source and its licence, and the source code; each manual page exists', wantedLinks.every((w) => aboutLinks.includes(w)) && aboutLinks.filter((l) => l.startsWith('docs/')).every(manualPage), aboutLinks.join(' '));

      // The printed sheet: one page of Letter and one of A4.
      await open(`${MOMENT}&view=tonight`);
      await waitFor(filled, 60000);
      const pages = {};
      for (const [paper, [w, h]] of Object.entries({ letter: [8.5, 11], a4: [8.27, 11.69] })) {
        const pdf = Buffer.from((await send('Page.printToPDF', { paperWidth: w, paperHeight: h, printBackground: true })).data, 'base64');
        writeFileSync(join(OUT, `ui-tonight-sheet-${paper}.pdf`), pdf);
        pages[paper] = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
      }
      summary.tonight.sheet = pages;
      check('Tonight: the printed sheet is one page of Letter and one of A4', pages.letter === 1 && pages.a4 === 1, JSON.stringify(pages));
    }

    // 13. The Sky view's astronomy layers (sky2 agent, expansion Q3).
    if (ONLY.has('sky2')) await skyChecks({ send, evaluate, waitFor, messages, open, shot, viewport, summary });
    await viewport(1440, 900, false);

    // 14. The Events view (events2): every tab and sub-list, the cards, the Save menu, and a
    // background search that waits for the time bar.
    if (ONLY.has('events')) {
      summary.events = { views: [], files: [], drag: null };
      const EV_MOMENT = 'v=1&lat=39.9526&lon=-75.1652&place=Philadelphia&tz=America%2FNew_York&t=2026-09-25T16:00:00Z&body=Moon';
      const ready = {
        eclipses: `document.querySelector('.sfe-eclipses')?.dataset.local === 'done'`,
        'moon/phases': `!!document.querySelector('.sfe-phases')`,
        'moon/apsides': `document.querySelector('.sfe-aps')?.dataset.state === 'done'`,
        'moon/occultations': `document.querySelector('.sfe-occ')?.dataset.state === 'done'`,
        'planets/events': `!!document.querySelector('.sfe-pe-list')`,
        'planets/conjunctions': `document.querySelector('.sfe-conj')?.dataset.state === 'done'`,
        'planets/retrograde': `document.querySelector('.sfe-retro')?.dataset.state === 'done'`,
        'planets/transits': `document.querySelector('.sfe-transits')?.dataset.state === 'done'`,
        'planets/jupiter': `document.querySelector('.sfe-jup')?.dataset.state === 'done'`,
        meteors: `document.querySelector('.sfe-showers')?.dataset.state === 'done'`,
        seasons: `!!document.querySelector('.sfe-season-table') && !/Computing/.test(document.querySelector('.sfe-tabbody')?.textContent ?? '')`,
      };
      const openEvents = async (spec) => {
        const [tab, sub] = spec.split('/');
        await evaluate(`document.querySelector('.sfe-tabs [id$="-${tab}"]')?.click(); true`);
        if (sub) {
          await waitFor(`!!document.querySelector('.sfe-subtabs [data-sub="${sub}"]')`, 5000);
          await evaluate(`document.querySelector('.sfe-subtabs [data-sub="${sub}"]')?.click(); true`);
        }
        return waitFor(ready[spec] ?? 'true', 60000);
      };
      for (const size of SIZES) {
        const [w, h, mobile] = DIMS[size];
        await viewport(w, h, mobile);
        for (const theme of THEMES) {
          for (const spec of EVENT_VIEWS) {
            messages.length = 0;
            await open(`${EV_MOMENT}&view=events`, { theme });
            const filled = await openEvents(spec);
            await sleep(400);
            const info = JSON.parse(await evaluate(`JSON.stringify({ rows: document.querySelectorAll('.sfe-ev2, .sfe-row, .sfe-pe, .sfe-phases td, .sfe-season-table td').length, alert: document.querySelector('.sfe-tabbody [role=alert], .sfe-eclipses [role=alert]')?.textContent ?? '' })`));
            const L = JSON.parse(await evaluate(LAYOUT));
            const png = await shot(`events-${size}-${theme}-${spec.replace('/', '-')}`);
            const tag = `events ${spec}, ${theme}, ${size}`;
            const noise = messages.filter((m) => /^(error|warning|warn|exception)/.test(m));
            check(`${tag}: filled in`, filled && info.rows > 0 && !info.alert, info.alert || `${info.rows} rows`);
            check(`${tag}: no sideways scroll, overlap or cut-off text`, !L.hscroll && !L.overlaps.length && !L.clipped.length, [...L.overlaps, ...L.clipped].join('; '));
            if (mobile) check(`${tag}: the view ends where the sheet begins`, L.underSheet <= 0, `${L.underSheet}px under the sheet`);
            check(`${tag}: console clean`, noise.length === 0, noise.slice(0, 3).join(' | '));
            if (theme === 'night') {
              const n = lightNotRed(decodePng(png));
              check(`${tag}: no blue, green or white light`, n.count < 50, n.count ? `${n.count} px, worst ${JSON.stringify(n.worst)}` : '');
            }
            summary.events.views.push({ spec, size, theme, layout: L, messages: noise, rows: info.rows });
          }
        }
      }
      await viewport(1440, 900, false);

      // The cards: an occultation seen from here, a transit, a meteor shower, with their drawings.
      const cards = [
        ['moon/occultations', `.sfe-occ .sfe-ev2__open`, `.sfe-card--occ svg.sfe-occ__disc`, 'occultation'],
        ['planets/transits', `.sfe-transits .sfe-ev2__open`, `.sfe-card--transit svg.sfe-tr__svg`, 'transit'],
        ['meteors', `.sfe-showers [data-shower="PER"] .sfe-ev2__open`, `.sfe-card--shower .sfe-facts`, 'shower'],
      ];
      for (const theme of ['light', 'night']) {
        for (const [spec, row, drawn, name] of cards) {
          messages.length = 0;
          await open(`${EV_MOMENT}&view=events`, { theme });
          await openEvents(spec);
          await evaluate(`document.querySelector('${row}')?.click(); true`);
          const ok = await waitFor(`!!document.querySelector('${drawn}')`, 10000);
          await sleep(400);
          await evaluate(`document.querySelector('.sfe-cardcol .sfe-card')?.scrollIntoView({ block: 'nearest' }); true`);
          const L = JSON.parse(await evaluate(LAYOUT));
          const png = await shot(`events-card-${name}-${theme}`);
          check(`events: the ${name} card opens with its drawing (${theme})`, ok);
          check(`events: the ${name} card has no overlap or cut-off text (${theme})`, !L.hscroll && !L.overlaps.length && !L.clipped.length, [...L.overlaps, ...L.clipped].join('; '));
          check(`events: the ${name} card keeps the console clean (${theme})`, !messages.some((m) => /^(error|warning|warn|exception)/.test(m)), messages.slice(0, 3).join(' | '));
          if (theme === 'night') {
            const n = lightNotRed(decodePng(png));
            check(`events: the ${name} card shows no blue, green or white light`, n.count < 50, n.count ? `${n.count} px, worst ${JSON.stringify(n.worst)}` : '');
          }
        }
      }

      // The Save menu writes a real calendar file and a real table (into a scratch folder).
      const evDownloads = join(scratch, 'event-downloads');
      mkdirSync(evDownloads, { recursive: true });
      await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: evDownloads });
      for (const [spec, action] of [['moon/occultations', 'ics'], ['moon/occultations', 'csv'], ['meteors', 'ics'], ['planets/conjunctions', 'ics']]) {
        await open(`${EV_MOMENT}&view=events`, { theme: 'night' });
        await openEvents(spec);
        await evaluate(`document.querySelector('.sfe-save__btn').click(); true`);
        await sleep(300);
        await evaluate(`document.querySelector('.sfe-save__menu [data-action=${action}]').click(); true`);
        const saved = await waitFor(`/^Saved /.test(document.querySelector('.sfe-save__status')?.textContent ?? '')`, 15000);
        const status = await evaluate(`document.querySelector('.sfe-save__status')?.textContent ?? ''`);
        const name = (/^Saved (.+)\.$/.exec(status) ?? [])[1] ?? '';
        await sleep(700);
        const file = join(evDownloads, name);
        const got = saved && name && existsSync(file);
        const text = got ? readFileSync(file, 'utf8') : '';
        let valid = false;
        if (action === 'ics') {
          const lines = text.split('\r\n');
          const events = text.match(/\r\nBEGIN:VEVENT\r\n/g)?.length ?? 0;
          valid =
            text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:') &&
            text.endsWith('END:VCALENDAR\r\n') &&
            !/[^\r]\n/.test(text) &&
            lines.every((l) => Buffer.byteLength(l, 'utf8') <= 75) &&
            events > 0 &&
            events === (text.match(/\r\nDTSTART:\d{8}T\d{6}Z\r\n/g)?.length ?? -1) &&
            events === (text.match(/\r\nUID:/g)?.length ?? -1);
        } else {
          valid = text.startsWith('﻿# SkyFix Lab') && /\r\nInstant,Scale,Local date,/.test(text);
        }
        check(`Save ${action.toUpperCase()} on ${spec}: a real file`, got && valid, `${status} ${got ? `${statSync(file).size} bytes` : ''}`);
        summary.events.files.push({ spec, action, name, bytes: got ? statSync(file).size : 0 });
      }

      // The eclipse list reaches a century (or a millennium) in ten-year pieces, a page of rows at a time.
      await open(`${EV_MOMENT}&view=events`, { theme: 'light' });
      await openEvents('eclipses');
      await evaluate(`document.querySelector('.sfe-eclipses [role=radiogroup][aria-label="How far"] [data-value="100"]').click(); true`);
      await sleep(300);
      const reached = await waitFor(`document.querySelector('.sfe-eclipses')?.dataset.search === 'done' && document.querySelector('.sfe-eclipses')?.dataset.local === 'done'`, 120000);
      const E = JSON.parse(await evaluate(`JSON.stringify({ status: document.querySelector('.sfe-eclipses .sfe-status')?.textContent ?? '', rows: document.querySelectorAll('.sfe-eclipses .sfe-row').length, more: document.querySelector('.sfe-eclipses .sfe-more')?.textContent ?? '' })`));
      await shot('events-eclipses-century');
      check('events: the eclipse list reaches a century, in pages of rows, and says which years it holds', reached && /\d+ eclipses (in the next 100 years|from .+ to .+ \(the years computed\))/.test(E.status) && E.rows > 0 && E.rows <= 120 && (E.rows < 120 || /^Show (the other \d+|\d+ more of \d+)$/.test(E.more)), JSON.stringify(E));

      // The lunar limb (P12) on a solar eclipse card: the pack offered once; with it, the
      // corrected contacts labelled and the beads approximate; once saved, used without asking.
      const DALLAS_2024 = 'v=1&lat=32.7767&lon=-96.797&place=Dallas&tz=America%2FChicago&t=2024-03-20T15:00:00Z&body=Sun&view=events';
      const limbCard = `JSON.stringify({ limb: document.querySelector('.sfe-card .sfe-limb')?.innerText ?? '', time: [...document.querySelectorAll('.sfe-card th')].map((t) => t.innerText).join(' | '), beads: document.querySelector('.sfe-card .sfe-beads')?.previousElementSibling?.innerText ?? '', prompt: document.querySelector('.sf-packs-prompt')?.innerText ?? '' })`;
      for (const theme of ['light', 'night']) {
        messages.length = 0;
        await open(DALLAS_2024, { theme });
        await openEvents('eclipses');
        await evaluate(`document.querySelector('.sfe-row[data-eclipse="2024-04-08-solar"]')?.click(); true`);
        const asked = await waitFor(`/Lunar limb/.test(document.querySelector('.sf-packs-prompt')?.innerText ?? '')`, theme === 'light' ? 15000 : 4000);
        if (theme === 'light') {
          const mean = JSON.parse(await evaluate(limbCard));
          check('events: a solar eclipse card offers the Lunar limb pack, and says its times are the mean limb\'s', asked && /^Mean limb/.test(mean.limb) && !/limb-corrected/.test(mean.time), JSON.stringify(mean).slice(0, 300));
          await evaluate(`[...document.querySelectorAll('.sf-packs-prompt button')].find((b) => /^Get/.test(b.innerText.trim()))?.click(); true`);
        } else {
          check('events: once saved, the Lunar limb pack is used without asking again', !asked, asked ? 'the prompt came back' : '');
        }
        const corrected = await waitFor(`/^Limb-corrected/.test(document.querySelector('.sfe-card .sfe-limb')?.innerText ?? '')`, 120000);
        await waitFor(`!document.querySelector('.sf-packs-prompt')`, 10000);
        await evaluate(`document.querySelector('.sfe-card .sfe-limb')?.scrollIntoView({ block: 'start' }); true`);
        await sleep(400);
        const C = JSON.parse(await evaluate(limbCard));
        const L = JSON.parse(await evaluate(LAYOUT));
        const png = await shot(`events-card-eclipse-limb-${theme}`);
        check(`events: with the pack the eclipse card is limb-corrected, its beads approximate (${theme})`, corrected && /limb-corrected/.test(C.time) && /approximate/i.test(C.beads), JSON.stringify(C).slice(0, 300));
        check(`events: the limb-corrected card has no overlap or cut-off text (${theme})`, !L.hscroll && !L.overlaps.length && !L.clipped.length, [...L.overlaps, ...L.clipped].join('; '));
        check(`events: the limb-corrected card keeps the console clean (${theme})`, !messages.some((m) => /^(error|warning|warn|exception)/.test(m)), messages.slice(0, 3).join(' | '));
        if (theme === 'night') {
          const n = lightNotRed(decodePng(png));
          check('events: the limb-corrected card shows no blue, green or white light', n.count < 50, n.count ? `${n.count} px, worst ${JSON.stringify(n.worst)}` : '');
        }
      }

      // A background search waits while the time bar is dragged, and finishes once it is let go.
      await open(`${EV_MOMENT}&view=events`, { theme: 'dark' });
      await evaluate(`document.querySelector('.sfe-tabs [id$="-planets"]').click(); true`);
      await waitFor(`!!document.querySelector('.sfe-subtabs [data-sub="conjunctions"]')`, 5000);
      await evaluate(`document.querySelector('.sfe-subtabs [data-sub="conjunctions"]').click(); true`);
      await sleep(150);
      const hb = JSON.parse(await evaluate(`JSON.stringify((() => { const r = document.querySelector('.sf-ribbon__handle').getBoundingClientRect(); const t = document.querySelector('.sf-ribbon').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: t.left, right: t.right }; })())`));
      await evaluate(`window.__f = []; (function loop(t) { window.__f.push(t); if (window.__f.length < 100000) requestAnimationFrame(loop); })(performance.now()); true`);
      const progress = `(() => { const m = /(\\d+)%/.exec(document.querySelector('.sfe-conj .sfe-status')?.textContent ?? ''); return m ? Number(m[1]) : (document.querySelector('.sfe-conj')?.dataset.state === 'done' ? 100 : -1); })()`;
      const p0 = await evaluate(progress);
      const f0 = await evaluate('window.__f.length');
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hb.x, y: hb.y, button: 'left', clickCount: 1 });
      const during = [];
      for (let i = 1; i <= 90; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hb.x + ((hb.right - 60 - hb.x) * (i % 30)) / 30, y: hb.y, button: 'left', buttons: 1 });
        await sleep(16);
        if (i % 15 === 0) during.push(await evaluate(progress));
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hb.x, y: hb.y, button: 'left', clickCount: 1 });
      const ts = JSON.parse(await evaluate(`JSON.stringify(window.__f.slice(${f0}))`));
      const finished = await waitFor(`document.querySelector('.sfe-conj')?.dataset.state === 'done'`, 60000);
      const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
      const q = (p) => +(d[Math.min(d.length - 1, Math.floor(p * d.length))] ?? 0).toFixed(1);
      summary.events.drag = { progressBefore: p0, progressDuring: during, frames: d.length, medianMs: q(0.5), p95Ms: q(0.95), finished };
      console.log(`info  dragging the time bar over a running search: ${JSON.stringify(summary.events.drag)}`);
      // While the pointer holds the time bar the search makes no progress (the list's months
      // move by a day at most, inside the window being searched), and it finishes once the
      // pointer lets go. Judged only when the search was running during the drag (on a fast
      // machine it may have finished before the drag began).
      if (during.length > 1 && during[0] >= 0 && during[0] < 100) {
        const stalled = during.every((v) => v === during[0]);
        check('events: a background search waits while the time bar is dragged, and finishes after', stalled && finished, JSON.stringify({ p0, during, finished }));
      } else {
        console.log(`info  the search was not running during the drag (${JSON.stringify(during)}): not judged`);
      }
    }


    // 15. Far dates (polish2): every view and its tabs at 28 May 585 BC in Philadelphia and
    // 21 June 2999 in Tromsø (the midnight sun), on a laptop in the dark theme and on a phone
    // in the night theme. The clock there is UT, both dates are estimates (the labelled
    // tier), and the notices stay up: what a visitor reads must still be right.
    if (ONLY.has('far')) {
      summary.far = [];
      const FAR = [
        ['585 BC', 'v=1&lat=39.9526&lon=-75.1652&place=Philadelphia&tz=America%2FNew_York&t=-0584-05-22T12:00:00Z&body=Moon'],
        ['AD 2999', 'v=1&lat=69.6492&lon=18.9553&place=Troms%C3%B8&tz=Europe%2FOslo&t=2999-06-21T21:30:00Z&body=Moon'],
      ];
      // Words a visitor must not read at a UT date: a clock time or a label in UTC, and an
      // engine's raw message (its function name, a Julian date, an RFC 3339 instant).
      const FAR_WORDS = String.raw`(() => {
        const text = [document.querySelector('.sf-timebar'), document.querySelector('#sf-panel'), document.querySelector('.sf-stage')].map((e) => e?.innerText ?? '').join('\n');
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        // Learn's simulator names the scale of its own scenario's time, not the time bar's.
        const utc = document.querySelector('.sf-stage__view')?.dataset.view === 'learn' ? [] : lines.filter((l) => /\b\d{1,2}:\d{2}(?::\d{2})?\s*UTC\b|\(UTC[,)]|\bin UTC\b|hover for UTC|UTC[−+-]\d/.test(l));
        const raw = lines.filter((l) => /jd_utc|starfield_|almanac_(?:opening|day):|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z|outside the ephemeris coverage \(/.test(l));
        const vw = innerWidth, vh = innerHeight;
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true })); };
        const nameOf = (el) => (el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ') || el.textContent || el.getAttribute('title') || '').trim();
        const unnamed = [...document.querySelectorAll('button, [role=button], a[href], [role=tab], select, input:not([type=hidden])')].filter((el) => visible(el) && !nameOf(el) && !(el.labels && el.labels.length)).map((el) => el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]);
        return JSON.stringify({ utc: utc.slice(0, 4), raw: raw.slice(0, 4), unnamed: unnamed.slice(0, 4) });
      })()`;
      const tabsOf = (strip) => `(() => { const ls = [...document.querySelectorAll('.sf-stage__view [role=tablist]')].filter((t) => t.offsetParent !== null); return ls[${strip}] ? [...ls[${strip}].querySelectorAll('[role=tab]')].map((t) => t.textContent.trim()) : []; })()`;
      const clickTab = (strip, i) => `(() => { const ls = [...document.querySelectorAll('.sf-stage__view [role=tablist]')].filter((t) => t.offsetParent !== null); ls[${strip}]?.querySelectorAll('[role=tab]')[${i}]?.click(); return true; })()`;
      const settle = async () => {
        await sleep(900);
        await waitFor(`!document.querySelector('.sf-stage__view [aria-busy=true], .sf-stage__view [data-computing]')`, 12000);
        await sleep(300);
      };
      for (const [size, theme] of [['desktop', 'dark'], ['phone', 'night']]) {
        const [w, h, mobile] = DIMS[size];
        await viewport(w, h, mobile);
        for (const [when, hash] of FAR) {
          for (const view of FAR_VIEWS) {
            messages.length = 0;
            await open(`${hash}&view=${view}`, { theme });
            const found = { layout: [], words: [], unnamed: [], light: [] };
            const look = async (where) => {
              const L = JSON.parse(await evaluate(LAYOUT));
              if (L.hscroll || L.overlaps.length || L.clipped.length || (mobile && L.underSheet > 0)) found.layout.push(`${where}: ${[...L.overlaps, ...L.clipped, L.hscroll ? 'sideways scroll' : '', mobile && L.underSheet > 0 ? `${L.underSheet}px under the sheet` : ''].filter(Boolean).join('; ')}`);
              const W = JSON.parse(await evaluate(FAR_WORDS));
              if (W.utc.length || W.raw.length) found.words.push(`${where}: ${[...W.utc, ...W.raw].join(' | ')}`);
              if (W.unnamed.length) found.unnamed.push(`${where}: ${W.unnamed.join(', ')}`);
              if (theme === 'night') {
                const n = lightNotRed(decodePng(await shot(`far-${size}-${theme}-${when.replace(' ', '')}-${view}-${where.replace(/\W+/g, '_').slice(0, 24)}`)));
                if (n.count >= 50) found.light.push(`${where}: ${n.count} px, worst ${JSON.stringify(n.worst)}`);
              }
            };
            await look(view);
            const top = JSON.parse(JSON.stringify(await evaluate(tabsOf(0))));
            for (let i = 0; i < top.length; i++) {
              await evaluate(clickTab(0, i));
              await settle();
              await look(`${view}/${top[i]}`);
              const sub = await evaluate(tabsOf(1));
              for (let j = 1; j < sub.length; j++) {
                await evaluate(clickTab(1, j));
                await settle();
                await look(`${view}/${top[i]}/${sub[j]}`);
              }
            }
            const tag = `far ${when}, ${view}, ${theme}, ${size}`;
            const noise = messages.filter((m) => /^(error|warning|warn|exception)/.test(m));
            check(`${tag}: no sideways scroll, overlap or cut-off text`, !found.layout.length, found.layout.slice(0, 3).join(' || '));
            check(`${tag}: no literal UTC at a UT date and no raw engine message`, !found.words.length, found.words.slice(0, 3).join(' || '));
            check(`${tag}: every control has a name`, !found.unnamed.length, found.unnamed.slice(0, 3).join(' || '));
            if (theme === 'night') check(`${tag}: no blue, green or white light`, !found.light.length, found.light.slice(0, 2).join(' || '));
            check(`${tag}: console clean`, noise.length === 0, noise.slice(0, 3).join(' | '));
            summary.far.push({ when, view, size, theme, ...found, messages: noise });
          }
          // The Selected card (the Moon): its rise, highest and set carry the ± chip.
          await open(`${hash}&view=about`, { theme });
          const chips = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.sf-evcard')].filter((c) => !c.classList.contains('sf-evcard--none')).map((c) => { const k = c.querySelector('.sf-dt-chip'); return k && !k.hidden ? k.textContent.trim() : ''; }))`));
          check(`far ${when}, ${size}: the Selected card's times carry the ± chip`, chips.length > 0 && chips.every((t) => /^±/.test(t)), JSON.stringify(chips));
          // The time bar's rise, transit and set labels never print over each other (the
          // Moon's short arcs at Tromsø put three within three hours: ribbon.ts clashingLabels).
          const ribbon = JSON.parse(await evaluate(`JSON.stringify((() => { const all = [...document.querySelectorAll('.sf-ribbon__label')]; const r = all.filter((e) => !e.hasAttribute('data-clash')).map((e) => e.getBoundingClientRect()).sort((a, b) => a.left - b.left); const bad = []; for (let i = 1; i < r.length; i++) if (r[i].left < r[i - 1].right) bad.push([Math.round(r[i - 1].left), Math.round(r[i].left)]); return { labels: all.length, shown: r.length, bad }; })())`));
          check(`far ${when}, ${size}: the time bar's rise, transit and set labels do not overlap`, ribbon.bad.length === 0, JSON.stringify(ribbon));
        }
      }
      await viewport(1440, 900, false);
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
// 11. The Selected card's tools (photo agent, expansion programme Q8)
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
  // Charts → Tides (block 7) got the pack earlier in a full run: remove it first, then open
  // the page again so the engine starts without it (polish2).
  await open(MOONLIT, { theme: 'dark' });
  await evaluate(`document.querySelector('button[aria-label="Settings"]').click(); true`);
  if (await waitFor(`document.querySelector('.sf-packs-row[data-pack="tides-us"]')?.dataset.state === 'saved'`, 5000)) {
    await evaluate(`[...document.querySelectorAll('.sf-packs-row[data-pack="tides-us"] button')].find((b) => /Remove/.test(b.textContent))?.click(); true`);
    await waitFor(`document.querySelector('.sf-packs-row[data-pack="tides-us"]')?.dataset.state === 'absent'`, 10000);
  }
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
  // polish2 (list 32): leave the device as it was, so the Charts block's "the pack is
  // offered once" holds in any order; this is also Settings → Data packs' Remove at work.
  await evaluate(`document.querySelector('button[aria-label="Settings"]').click(); true`);
  await waitFor(`Boolean(document.querySelector('.sf-packs-row[data-pack="tides-us"] button'))`, 10000);
  await evaluate(`[...document.querySelectorAll('.sf-packs-row[data-pack="tides-us"] button')].find((b) => /Remove/.test(b.textContent))?.click(); true`);
  const removed = await waitFor(`document.querySelector('.sf-packs-row[data-pack="tides-us"]')?.dataset.state === 'absent'`, 10000);
  check('photo: Settings → Data packs removes the tides pack again', removed, await evaluate(`document.querySelector('.sf-packs-row[data-pack="tides-us"] .sf-packs-row__state')?.textContent ?? ''`));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
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

// ---------------------------------------------------------------------------------
// 13. The Sky view's astronomy layers (sky2 agent, expansion programme Q3)
// ---------------------------------------------------------------------------------

/** 22:00 EDT on 24 September 2026 in Philadelphia: dark, the Milky Way up, a Moon nearly full. */
const SKY_NIGHT = 'v=1&lat=39.9526&lon=-75.1652&place=Philadelphia&tz=America%2FNew_York&t=2026-09-25T02:00:00Z&body=Moon';

async function skyChecks({ send, evaluate, waitFor, messages, open, shot, viewport, summary }) {
  const js = (v) => JSON.stringify(v);
  const data = async () => JSON.parse(await evaluate(`JSON.stringify({ ...(document.querySelector('.sky')?.dataset ?? {}) })`));
  const noise = () => messages.filter((m) => /^(error|warning|warn|exception)/.test(m));
  const typeInto = (sel, value) =>
    evaluate(`(() => { const i = document.querySelector(${js(sel)}); if (!i) return false; i.focus(); i.value = ${js(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const key = (sel, k) => evaluate(`(() => { const i = document.querySelector(${js(sel)}); i?.dispatchEvent(new KeyboardEvent('keydown', { key: ${js(k)}, bubbles: true })); return Boolean(i); })()`);
  const clickSel = (sel) => evaluate(`(() => { const b = document.querySelector(${js(sel)}); b?.click(); return Boolean(b); })()`);
  const clickText = (sel, re) => evaluate(`(() => { const b = [...document.querySelectorAll(${js(sel)})].find((x) => new RegExp(${js(re)}).test(x.textContent)); b?.click(); return Boolean(b); })()`);
  const cardOf = async () => JSON.parse(await evaluate(`JSON.stringify((() => { const c = document.querySelector('.sky-card'); return { shown: Boolean(c && !c.hidden), title: c?.querySelector('.sky-card__title')?.textContent ?? '', lines: [...(c?.querySelectorAll('.sky-card__line') ?? [])].map((l) => l.textContent), actions: [...(c?.querySelectorAll('.sky-card__actions button') ?? [])].map((b) => b.textContent) }; })())`));
  const out = {};

  // --- Desktop, dark: the night sky ----------------------------------------------------------
  await viewport(1440, 900, false);
  messages.length = 0;
  await open(`${SKY_NIGHT}&view=sky`, { theme: 'dark' });
  await waitFor(`Number(document.querySelector('.sky')?.dataset.milkyWay) > 0 && Number(document.querySelector('.sky')?.dataset.highlights) > 0`, 30000);
  const night = await data();
  out.night = night;
  check('sky2: at night the Milky Way glows and deep-sky objects are drawn down to the dark sky’s limit', Number(night.milkyWay) > 500 && Number(night.dso) > 20 && night.limit === '6.5', js(night));
  check('sky2: the panel’s Tonight’s star sights are ringed in the Sky view', Number(night.highlights) >= 3, night.highlights);
  await shot('sky2-desktop-dark-night');

  // The Sky view's search: M31, Enter, its card.
  await clickSel('.sky-ov--tools [aria-label="Find in the sky"]');
  await waitFor(`document.activeElement?.matches('.sky-search input')`, 5000);
  await typeInto('.sky-search input', 'M31');
  await waitFor(`document.querySelectorAll('.sky-search__opt:not(.sky-search__opt--msg)').length > 0`, 10000);
  const first = await evaluate(`document.querySelector('.sky-search__opt .sky-search__name')?.textContent ?? ''`);
  await key('.sky-search input', 'Enter');
  await waitFor(`document.querySelector('.sky-card') && !document.querySelector('.sky-card').hidden`, 10000);
  const m31 = await cardOf();
  out.m31 = m31;
  check(
    'sky2: the search finds M31; its card gives its size, RA and Dec, the best time tonight and what shows it',
    /^(M31|Andromeda Galaxy)$/.test(first) &&
      m31.title === 'Andromeda Galaxy' &&
      m31.lines.some((l) => /^Size3\.3° × 1\.2°$/.test(l)) &&
      m31.lines.some((l) => /^Right ascension · declination0h 4\dm \d\ds, \+41° \d\d′$/.test(l)) &&
      m31.lines.some((l) => /^Best tonight\d{1,2}:\d\d/.test(l)) &&
      m31.lines.some((l) => /^To see it(the naked eye|binoculars)$/.test(l)),
    js({ first, m31 }),
  );
  check('sky2: the card pins M31 on the chart', /^d:\d+$/.test((await data()).pinned), (await data()).pinned);
  // Tonight's ranking from the card.
  await clickText('.sky-card__actions button', 'ranking');
  await waitFor(`document.querySelectorAll('.sky-rank__item').length >= 5`, 20000);
  const ranking = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.sky-rank__item')].map((b) => b.textContent))`));
  out.ranking = ranking;
  check('sky2: tonight’s ranking lists the best-placed deep-sky objects with their best times', ranking.length >= 5 && ranking.every((t) => /\d{1,2}:\d\d/.test(t)), js(ranking.slice(0, 5)));
  await key('.sky-rank', 'Escape');
  await evaluate(`document.querySelector('.sf-popover:not([hidden]) .sky-rank') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);

  // A field of view round the pinned object.
  await clickSel('.sky-ov--tools [aria-label="Field of view"]');
  await clickText('.sky-fov__presets .sf-menu__item', '^Binoculars 7×50');
  await waitFor(`document.querySelector('.sky')?.dataset.fov === 'Binoculars 7×50 · 7.1°'`, 5000);
  check('sky2: a field of view is drawn round the pinned object, labelled', (await data()).fov === 'Binoculars 7×50 · 7.1°', (await data()).fov);
  await shot('sky2-desktop-dark-m31-fov');
  await clickText('.sky-fov__presets .sf-menu__item', '^None');
  // The dome's zoom: + on the chart zooms in about its middle, Whole sky returns.
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('.sky-canvas').focus(); document.querySelector('.sky-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true })); true`);
  await waitFor(`document.querySelector('.sky')?.dataset.zoom === '1.50'`, 5000);
  const zoomed = await data();
  const zoomWords = await evaluate(`document.querySelector('.sky-status__text')?.textContent ?? ''`);
  await clickText('.sky button', '^Whole sky$');
  await waitFor(`document.querySelector('.sky')?.dataset.zoom === '1.00'`, 5000);
  check('sky2: + zooms the dome (the status says how far and where), Whole sky returns', zoomed.zoom === '1.50' && /Zoomed 1\.5×/.test(zoomWords) && (await data()).zoom === '1.00', js({ zoom: zoomed.zoom, zoomWords }));

  // The picture: a real PNG, taller than the chart by its caption, named by the time.
  await evaluate(`window.__saved = null; window.__click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__saved = { name: this.download, href: this.href }; return; } return window.__click.call(this); }; true`);
  await clickSel('.sky-ov--tools [aria-label="Save the sky as a picture"]');
  await waitFor(`window.__saved !== null`, 15000);
  const saved = JSON.parse(
    await evaluate(`(async () => { const s = window.__saved; const u = new Uint8Array(await (await fetch(s.href)).arrayBuffer()); const c = document.querySelector('.sky-canvas'); return JSON.stringify({ name: s.name, bytes: u.length, png: u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47, w: (u[16] << 24) | (u[17] << 16) | (u[18] << 8) | u[19], h: (u[20] << 24) | (u[21] << 16) | (u[22] << 8) | u[23], cw: c.width, ch: c.height }); })()`),
  );
  await evaluate(`HTMLAnchorElement.prototype.click = window.__click; true`);
  out.picture = saved;
  check('sky2: Save as a picture makes a PNG of the chart with its caption strip, named by the time', saved.png && saved.name === 'skyfix-sky-2026-09-25t0200.png' && saved.w === saved.cw && saved.h > saved.ch + 60 && saved.bytes > 50_000, js(saved));

  // How dark is your sky: a city sky hides the Milky Way and most deep-sky objects.
  const before = await data();
  await evaluate(`[...document.querySelectorAll('.sky .sky-ov--tr button')].find((b) => /Layers/.test(b.textContent))?.click(); true`);
  await waitFor(`Boolean(document.querySelector('.sky-quality__seg'))`, 5000);
  await clickSel('.sky-quality__seg [data-value="bortle"]');
  await evaluate(`(() => { const s = document.querySelector('.sky-quality select'); s.value = '8'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor(`document.querySelector('.sky')?.dataset.limit === '4.3'`, 10000);
  const city = await data();
  const words = await evaluate(`document.querySelector('.sky-quality__now')?.textContent ?? ''`);
  out.city = { before, city, words };
  check('sky2: a Bortle 8 sky draws stars to 4.3 overhead, hides the Milky Way and most deep-sky objects, and says so', city.milkyWay === '0' && Number(city.dso) < Number(before.dso) / 2 && /magnitude 4\.3 overhead/.test(words) && /not visible/.test(words), js(out.city));
  await shot('sky2-desktop-dark-bortle8-menu');
  await clickSel('.sky-quality__seg [data-value="auto"]');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('.sky-canvas').focus(); true`);

  // The side panel's search: Jupiter from the "Sky objects" group, then its close-up.
  await typeInto('.sf-search input', 'Jupiter');
  await waitFor(`[...document.querySelectorAll('.sf-search__group')].some((g) => g.textContent === 'Sky objects')`, 10000);
  await evaluate(`(() => { const o = [...document.querySelectorAll('.sf-search__opt')].find((x) => /^Jupiter/.test(x.textContent) && /Planet/.test(x.textContent)); o?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return Boolean(o); })()`);
  await waitFor(`document.querySelector('.sky-card') && !document.querySelector('.sky-card').hidden && document.querySelector('.sky-card__title')?.textContent === 'Jupiter'`, 10000);
  await clickText('.sky-card__actions button', 'up close');
  await waitFor(`document.querySelector('.sky')?.dataset.upclose === 'Jupiter' && document.querySelectorAll('.sky-upclose__facts dt').length >= 4`, 10000);
  const jupiter = JSON.parse(await evaluate(`JSON.stringify({ title: document.querySelector('.sky-upclose__title')?.textContent, moons: [...document.querySelectorAll('.sky-upclose__facts dt')].map((d) => d.textContent) })`));
  out.jupiter = jupiter;
  check('sky2: the panel’s search opens Jupiter in the Sky view, and its close-up names the four moons', jupiter.title === 'Jupiter and its moons' && ['Io', 'Europa', 'Ganymede', 'Callisto'].every((m) => jupiter.moons.includes(m)), js(jupiter));
  await shot('sky2-desktop-dark-jupiter');
  check('sky2: desktop, dark: console clean', noise().length === 0, noise().slice(0, 3).join(' | '));

  // --- photo's hooks: the Moon card's close-up, the Milky Way planner's Show in Sky ------------
  messages.length = 0;
  await open(`${SKY_NIGHT}&view=map`, { theme: 'light' });
  await waitFor(`[...document.querySelectorAll('.sf-photo-moon__terminator button')].some((b) => /up close/.test(b.textContent) && b.offsetParent)`, 30000);
  const listed = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.sf-photo-moon__feat')].map((f) => f.textContent))`));
  await clickText('.sf-photo-moon__terminator button', 'up close');
  await waitFor(`document.querySelector('.sky')?.dataset.upclose === 'Moon' && Boolean(document.querySelector('.sky-upclose__canvas')?.getAttribute('aria-label'))`, 30000);
  const moon = await evaluate(`document.querySelector('.sky-upclose__canvas').getAttribute('aria-label')`);
  out.moon = { listed, moon };
  check('sky2: the Moon card’s “See it up close” opens the Moon’s close-up with the features it lists', /^The Moon, \d+ % lit/.test(moon) && listed.length > 0 && listed.every((n) => moon.includes(n)), js(out.moon));
  await shot('sky2-desktop-light-moon');
  await open(`${SKY_NIGHT}&view=map`, { theme: 'dark' });
  await evaluate(`(() => { const d = document.querySelector('.sf-photo-mw'); if (d) d.open = true; return Boolean(d); })()`);
  await waitFor(`[...document.querySelectorAll('.sf-photo-mw button')].some((b) => /Show in Sky/.test(b.textContent))`, 30000);
  await clickText('.sf-photo-mw button', 'Show in Sky');
  await waitFor(`document.querySelector('.sky')?.dataset.pinned === 'p:0' && document.querySelector('.sky-card__title')?.textContent === 'Galactic centre'`, 30000);
  const core = await cardOf();
  out.core = core;
  check('sky2: the Milky Way planner’s “Show in Sky” marks the galactic centre in Sagittarius', core.title === 'Galactic centre' && core.lines.some((l) => /^Right ascension · declination17h 4\dm/.test(l)), js(core));
  check('sky2: photo’s hooks: console clean', noise().length === 0, noise().slice(0, 3).join(' | '));

  // --- Tonight's "Show in Sky" and "See it up close" (the sky-link channel) --------------------
  messages.length = 0;
  await open(`${SKY_NIGHT}&view=tonight`, { theme: 'dark' });
  await waitFor(`Boolean(document.querySelector('.sft-dso .sft-actions button'))`, 60000);
  const dsoTitle = await evaluate(`(() => { const r = document.querySelector('.sft-dso'); r?.querySelector('.sft-actions button')?.click(); return r?.querySelector('.sft-dso__head strong')?.textContent ?? ''; })()`);
  await waitFor(`/^d:\\d+$/.test(document.querySelector('.sky')?.dataset.pinned ?? '') && Number(document.querySelector('.sky')?.dataset.zoom) >= 3 && Boolean(document.querySelector('.sky')?.dataset.shown)`, 30000);
  await sleep(500);
  const fromTonight = await data();
  const dsoCard = await cardOf();
  const off = (fromTonight.shown ?? '').split(' ').map(Number);
  out.tonight = { dsoTitle, card: dsoCard.title, zoom: fromTonight.zoom, shown: fromTonight.shown };
  check(
    'sky2: Tonight’s “Show in Sky” on a deep-sky object centres the dome on it, zoomed in, its card open',
    Number(fromTonight.zoom) >= 3 && Math.hypot(off[0], off[1]) < 30 && dsoCard.shown && dsoTitle.includes(dsoCard.title.replace(/ \(.*$/, '')),
    js(out.tonight),
  );
  await shot('sky2-desktop-dark-from-tonight');
  await open(`${SKY_NIGHT}&view=tonight`, { theme: 'dark' });
  await waitFor(`[...document.querySelectorAll('.sft button')].some((b) => /See it up close/.test(b.textContent))`, 60000);
  await clickText('.sft button', 'See it up close');
  await waitFor(`document.querySelector('.sky')?.dataset.upclose === 'Moon' && Number(document.querySelector('.sky')?.dataset.zoom) >= 3`, 30000);
  await sleep(500);
  const moonFromTonight = await data();
  const moonOff = (moonFromTonight.shown ?? '').split(' ').map(Number);
  out.tonightMoon = { zoom: moonFromTonight.zoom, shown: moonFromTonight.shown, upclose: moonFromTonight.upclose };
  check('sky2: Tonight’s “See it up close” opens the Moon’s close-up with the dome centred on the Moon', moonFromTonight.upclose === 'Moon' && Math.hypot(moonOff[0], moonOff[1]) < 30, js(out.tonightMoon));
  const LT = JSON.parse(await evaluate(LAYOUT));
  check('sky2: desktop, the close-up open over a zoomed dome: no overlap or cut-off text', !LT.hscroll && !LT.overlaps.length && !LT.clipped.length, [...LT.overlaps, ...LT.clipped].join('; '));
  check('sky2: from Tonight: console clean', noise().length === 0, noise().slice(0, 3).join(' | '));

  // --- The night theme at night, with the card and the close-up open ---------------------------
  messages.length = 0;
  await open(`${SKY_NIGHT}&view=sky`, { theme: 'night' });
  await waitFor(`Number(document.querySelector('.sky')?.dataset.milkyWay) > 0`, 30000);
  await typeInto('.sf-search input', 'Moon');
  await waitFor(`[...document.querySelectorAll('.sf-search__opt')].some((x) => /^Moon/.test(x.textContent) && /The Moon/.test(x.textContent))`, 10000);
  await evaluate(`(() => { const o = [...document.querySelectorAll('.sf-search__opt')].find((x) => /^Moon/.test(x.textContent) && /The Moon/.test(x.textContent)); o?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);
  await waitFor(`document.querySelector('.sky-card__title')?.textContent === 'Moon'`, 10000);
  await clickText('.sky-card__actions button', 'up close');
  await waitFor(`document.querySelector('.sky')?.dataset.upclose === 'Moon'`, 10000);
  await sleep(1200);
  const png = await shot('sky2-desktop-night-moon');
  const red = lightNotRed(decodePng(png));
  check('sky2: the night theme at night, the card and the Moon’s close-up open: no blue, green or white light', red.count < 50, red.count ? `${red.count} px, worst ${js(red.worst)}` : '');
  const L = JSON.parse(await evaluate(LAYOUT));
  check('sky2: desktop, night, the card and close-up open: no sideways scroll, overlap or cut-off text', !L.hscroll && !L.overlaps.length && !L.clipped.length, [...L.overlaps, ...L.clipped].join('; '));
  check('sky2: night theme: console clean', noise().length === 0, noise().slice(0, 3).join(' | '));

  // --- A phone at night: the card open ---------------------------------------------------------
  await viewport(390, 844, true);
  messages.length = 0;
  await open(`${SKY_NIGHT}&view=sky`, { theme: 'dark' });
  await waitFor(`Number(document.querySelector('.sky')?.dataset.dso) > 0`, 30000);
  const phone = await data();
  await clickSel('.sky-ov--tools [aria-label="Find in the sky"]');
  await waitFor(`Boolean(document.querySelector('.sky-search input'))`, 5000);
  await typeInto('.sky-search input', 'Pleiades');
  await waitFor(`document.querySelectorAll('.sky-search__opt:not(.sky-search__opt--msg)').length > 0`, 10000);
  await key('.sky-search input', 'Enter');
  await waitFor(`document.querySelector('.sky-card__title')?.textContent === 'Pleiades'`, 10000);
  await sleep(800);
  await shot('sky2-phone-dark-card');
  const LP = JSON.parse(await evaluate(LAYOUT));
  out.phone = { phone, layout: LP };
  check('sky2: a phone’s whole-sky chart draws only the showpieces (fewer deep-sky objects than a laptop’s)', Number(phone.dso) > 0 && Number(phone.dso) < Number(night.dso), js({ phone: phone.dso, desktop: night.dso }));
  check('sky2: phone, the card open: no sideways scroll, overlap or cut-off text; the view ends where the sheet begins', !LP.hscroll && !LP.overlaps.length && !LP.clipped.length && LP.underSheet <= 0, [...LP.overlaps, ...LP.clipped, LP.underSheet].join('; '));
  check('sky2: phone: console clean', noise().length === 0, noise().slice(0, 3).join(' | '));

  summary.sky2 = out;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
