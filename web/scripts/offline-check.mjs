#!/usr/bin/env node
/**
 * Check the offline app in a real browser. Serves an assembled site the way GitHub Pages
 * does (under /skyfix-lab/, `Cache-Control: max-age=600`), drives a local headless Chrome
 * over the DevTools protocol, and checks, with the server STOPPED for the offline parts
 * (and Chrome's HTTP cache cleared, so only the service worker can answer):
 *
 *   1. first visit: the service worker installs, the precache fills, the page says so;
 *      the manifest is installable
 *   2. second load offline: every file comes from the service worker; the WebAssembly
 *      engine runs; the basemap draws; the Offline chip shows
 *   3. the lazy views (sky, charts, almanac) open offline
 *   4. the workbench at / works offline; `next` redirects to `next/`
 *   5. a docs page never visited shows the offline page; one visited online is kept
 *   6. a new version: offered, never applied by itself, applied on Reload; only the
 *      changed file is downloaded; the old precache is deleted
 *   7. no cache holds anything from another origin
 *
 * Screenshots go to docs/design/local/pwa-*.png (git-ignored). Development tool only:
 * Node built-ins and a local Chrome, no npm dependency. OWNER: release agent.
 *
 *   web/scripts/pages-site.sh                            # site/ as the Pages workflow builds it
 *   node web/scripts/offline-check.mjs                   # check it under /skyfix-lab/
 *   SITE=web/dist PREFIX=/ node web/scripts/offline-check.mjs   # as `vite preview` serves it
 *
 * Environment: SITE (default <repo>/site), PREFIX (default /skyfix-lab/), CHROME (default
 * google-chrome), OUT (default <repo>/docs/design/local), PORT (default random).
 * Exit status 1 if any check fails.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../..');
const SITE = resolve(REPO, process.env.SITE ?? 'site');
const PREFIX = process.env.PREFIX ?? '/skyfix-lab/';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(REPO, 'docs/design/local'));
const PORT = Number(process.env.PORT ?? 8700 + Math.floor(Math.random() * 200));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}${PREFIX}`;
const TAG = PREFIX === '/' ? 'root' : PREFIX.replace(/\W+/g, '');

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
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------
// A static server like GitHub Pages: a sub-path, directory index, 301 to add a slash
// ---------------------------------------------------------------------------------

function siteServer(initialRoot) {
  let root = initialRoot;
  const sockets = new Set();
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, ORIGIN);
    log.push(url.pathname);
    if (!url.pathname.startsWith(PREFIX)) return void res.writeHead(404).end('not found');
    let file = join(root, decodeURIComponent(url.pathname.slice(PREFIX.length)));
    if (file !== root && !file.startsWith(root + sep)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!url.pathname.endsWith('/')) return void res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
      file = join(file, 'index.html');
    }
    if (!existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>404</h1>');
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'max-age=600',
    });
    res.end(body);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    log,
    start: () => new Promise((ok) => server.listen(PORT, '127.0.0.1', ok)),
    stop: () =>
      new Promise((ok) => {
        server.close(() => ok());
        for (const s of sockets) s.destroy();
      }),
    serve(dir) {
      root = dir;
    },
  };
}

// ---------------------------------------------------------------------------------
// Chrome over the DevTools protocol
// ---------------------------------------------------------------------------------

async function launchChrome(profile) {
  const debugPort = 9400 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let target = null;
  for (let i = 0; i < 100 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      target = list.find((t) => t.type === 'page') ?? null;
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
  return {
    send,
    on,
    close() {
      ws.close();
      chrome.kill();
    },
  };
}

// ---------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** Build data inlined in sw.js: `var BUILD = {...};` */
function workerBuild(siteDir) {
  const text = readFileSync(join(siteDir, 'sw.js'), 'utf8');
  const json = /var BUILD = (\{[\s\S]*?\n\t\});/.exec(text)?.[1];
  if (!json) throw new Error('no BUILD object in sw.js');
  return JSON.parse(json);
}

async function main() {
  if (!existsSync(join(SITE, 'sw.js'))) throw new Error(`${SITE} has no sw.js: build it first (web/scripts/pages-site.sh)`);
  mkdirSync(OUT, { recursive: true });
  const build = workerBuild(SITE);
  const precacheBytes = build.entries.reduce((sum, e) => sum + statSync(join(SITE, e.url)).size, 0);
  console.log(`site ${SITE} at ${BASE}: sw.js version ${build.version}, ${build.entries.length} files, ${(precacheBytes / 1e6).toFixed(2)} MB`);

  const server = siteServer(SITE);
  await server.start();
  const scratch = mkdtempSync(join(tmpdir(), 'skyfix-offline-check-'));
  const chrome = await launchChrome(join(scratch, 'profile'));
  const { send, on } = chrome;

  const responses = [];
  const failures = [];
  on('Network.responseReceived', (p) =>
    responses.push({ url: p.response.url, status: p.response.status, sw: p.response.fromServiceWorker, disk: p.response.fromDiskCache }),
  );
  on('Network.loadingFailed', (p) => failures.push({ id: p.requestId, error: p.errorText }));
  const requestUrls = new Map();
  on('Network.requestWillBeSent', (p) => requestUrls.set(p.requestId, p.request.url));
  const exceptions = [];
  on('Runtime.exceptionThrown', (p) => exceptions.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

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
        // The page is navigating.
      }
      await sleep(150);
    }
    return false;
  };
  const shot = async (name, clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    const file = join(OUT, `pwa-${TAG}-${name}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };
  const viewport = (width, height, mobile = false) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const setOffline = (offline) =>
    send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const cacheContents = () =>
    evaluate(`(async () => {
      const out = {};
      for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map((r) => r.url);
      return out;
    })()`);
  const navigate = async (url) => {
    await send('Page.navigate', { url });
    await sleep(300);
  };
  /** This site's responses since `from`, and whether each came from the worker. */
  const sameOrigin = (from) => responses.slice(from).filter((r) => r.url.startsWith(BASE));
  const failedSince = (from) => failures.slice(from).map((f) => requestUrls.get(f.id) ?? '?').filter((u) => u.startsWith(BASE));
  // A fresh profile is a first visit: keep the first-run tour (shell/tour.ts) out of the shots.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('skyfix.explorer.tour.v1', 'done'); } catch {}` });
  // The "saved for offline use" note fades after a few seconds: record that it appeared.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `new MutationObserver(() => {
      if (document.querySelector('.sf-pwa__card[data-kind="ready"]')) window.__sawReadyNote = true;
    }).observe(document, { childList: true, subtree: true });`,
  });
  const EXPLORER_READY = "document.documentElement.dataset.ready === '1'";
  const MAP_READY = `${EXPLORER_READY} && document.querySelector('.sfm')?.dataset.detail === '1' && document.querySelector('.sfm')?.dataset.places === '1'`;

  await viewport(1440, 900);

  // --- 1. First visit ----------------------------------------------------------------
  await navigate(`${BASE}next/`);
  check('first visit: the explorer starts', await waitFor(EXPLORER_READY, 60000));
  const controlled = await waitFor('navigator.serviceWorker.controller !== null', 90000);
  check('first visit: the service worker installs and takes charge of the page', controlled);
  const caches1 = await cacheContents();
  const precacheName = `skyfix-lab-precache-${build.version}@${PREFIX}`;
  check(
    'first visit: the precache holds every file of the build',
    caches1[precacheName]?.length === build.entries.length,
    `${caches1[precacheName]?.length ?? 0} of ${build.entries.length} in ${precacheName}`,
  );
  const readyNote = await waitFor('window.__sawReadyNote === true', 10000);
  check('first visit: the page says it now works offline', readyNote);
  await waitFor(MAP_READY, 30000);
  await shot('1-first-visit');
  const installErrors = await send('Page.getInstallabilityErrors');
  check('installable: no installability errors', installErrors.installabilityErrors.length === 0, JSON.stringify(installErrors.installabilityErrors));
  const manifest = await send('Page.getAppManifest');
  check('installable: the manifest parses without errors', (manifest.errors ?? []).length === 0, manifest.url);
  const appId = await send('Page.getAppId');
  check('installable: the app id is the site root, fixed', appId.appId === `${ORIGIN}/skyfix-lab/`, `appId ${appId.appId}`);

  // --- 2. Second load, offline ---------------------------------------------------------
  await server.stop();
  await send('Network.clearBrowserCache');
  await setOffline(true);
  let mark = responses.length;
  let failMark = failures.length;
  await send('Page.reload', { ignoreCache: false });
  await sleep(300);
  check('offline: the explorer starts again', await waitFor(EXPLORER_READY, 60000));
  const fatal = await evaluate(`document.body.innerText.includes('cannot start')`);
  check('offline: no start-up failure', !fatal);
  const wasm = await waitFor(`document.querySelector('.sf-badge--wasm') !== null`, 10000);
  check('offline: the WebAssembly engine runs (■ WASM core badge)', wasm);
  const readout = await evaluate(`[...document.querySelectorAll('.sf-readout__value')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 4).join(' | ')`);
  check('offline: the panel shows computed values', /\d/.test(readout), readout);
  check('offline: the basemap draws (1:50m detail and place names loaded)', await waitFor(MAP_READY, 30000));
  // Chrome's emulated offline state does not survive a reload into `navigator.onLine`;
  // switching it again fires the `offline` event, as a real loss of connection does.
  await setOffline(false);
  await sleep(200);
  await setOffline(true);
  check('offline: the Offline chip shows when the connection drops', await waitFor(`document.querySelector('.sf-pwa__offline') !== null && navigator.onLine === false`, 5000));
  await sleep(1500);
  await shot('2-offline-map');
  await setOffline(false);
  check('offline: the chip goes when the connection is back', await waitFor(`document.querySelector('.sf-pwa__offline') === null`, 5000));
  await setOffline(true);
  let own = sameOrigin(mark);
  check(
    'offline: every file came from the service worker',
    own.length > 0 && own.every((r) => r.sw && r.status === 200),
    `${own.filter((r) => r.sw).length} of ${own.length} responses; not from the worker: ${own.filter((r) => !r.sw).map((r) => r.url).join(', ') || 'none'}`,
  );
  check('offline: no request of the site failed', failedSince(failMark).length === 0, failedSince(failMark).join(', '));

  // --- 3. Lazy views offline -------------------------------------------------------------
  for (const view of ['sky', 'charts', 'almanac']) {
    mark = responses.length;
    failMark = failures.length;
    await evaluate(`location.hash = '#${view}'`);
    await sleep(3500);
    own = sameOrigin(mark);
    const bad = failedSince(failMark);
    check(`offline: the ${view} view opens`, bad.length === 0 && own.every((r) => r.sw), `${own.length} files from the worker${bad.length ? `; failed: ${bad.join(', ')}` : ''}`);
    await shot(`3-offline-${view}`);
  }
  await evaluate(`location.hash = '#map'`);

  // A phone, opened while already offline (navigator.onLine false from the start; forced
  // here, see above): the chip is there from the first frame, above the bottom sheet.
  const forced = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false });`,
  });
  await viewport(390, 844, true);
  await navigate(`${BASE}next/`);
  await waitFor(MAP_READY, 30000);
  check('offline: opened with no connection, the Offline chip shows at once', await waitFor(`document.querySelector('.sf-pwa__offline') !== null`, 5000));
  await sleep(1200);
  await shot('3-offline-phone');
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: forced.identifier });
  await viewport(1440, 900);

  // --- 4. The workbench, and a page address without its slash -------------------------------
  mark = responses.length;
  failMark = failures.length;
  await navigate(BASE);
  const bench = await waitFor(`document.body.innerText.includes('WASM core')`, 30000);
  check('offline: the workbench at / starts on the WebAssembly core', bench && failedSince(failMark).length === 0, failedSince(failMark).join(', '));
  await sleep(800);
  await shot('4-offline-workbench');
  await navigate(`${BASE}next`);
  check('offline: `next` redirects to `next/` and starts', await waitFor(`location.pathname.endsWith('/next/') && ${EXPLORER_READY}`, 30000));

  // --- 5. The docs ---------------------------------------------------------------------------
  const hasDocs = existsSync(join(SITE, 'docs/index.html'));
  if (hasDocs) {
    await navigate(`${BASE}docs/`);
    check('offline: a docs page never visited shows the offline page', await waitFor(`document.body.innerText.includes('You are offline')`, 10000));
    await shot('5-offline-docs-unvisited');
    await server.start();
    await setOffline(false);
    await navigate(`${BASE}docs/`);
    const online = await waitFor(`!!document.querySelector('#mdbook-content, .content, main') && !document.body.innerText.includes('You are offline')`, 15000);
    const title = await evaluate('document.title');
    await server.stop();
    await setOffline(true);
    await send('Network.clearBrowserCache');
    await send('Page.reload', { ignoreCache: false });
    await sleep(500);
    const kept = await waitFor(`document.title === ${JSON.stringify(title)} && !document.body.innerText.includes('You are offline')`, 10000);
    check('offline: a docs page visited online is kept', online && kept, title);
    await shot('5-offline-docs-visited');
  }

  // --- 6. A new version ------------------------------------------------------------------------
  /**
   * A copy of `fromDir` with `page` changed and sw.js updated to match (its revision and
   * the version hash): exactly what a rebuild with one changed file produces.
   */
  const newVersion = (fromDir, name, page, version) => {
    const dir = join(scratch, name);
    cpSync(fromDir, dir, { recursive: true });
    const before = readFileSync(join(dir, page), 'utf8');
    const after = before.replace('</html>', `<!-- version ${name} -->\n</html>`);
    writeFileSync(join(dir, page), after);
    const old = workerBuild(fromDir);
    const rev = createHash('sha256').update(after).digest('hex').slice(0, 16);
    const sw = readFileSync(join(dir, 'sw.js'), 'utf8')
      .replace(`"url": "${page}",\n\t\t\t\t"rev": "${old.entries.find((e) => e.url === page).rev}"`, `"url": "${page}",\n\t\t\t\t"rev": "${rev}"`)
      .replace(`"version": "${old.version}"`, `"version": "${version}"`);
    writeFileSync(join(dir, 'sw.js'), sw);
    if (workerBuild(dir).entries.find((e) => e.url === page).rev !== rev) throw new Error('could not rewrite sw.js');
    return dir;
  };
  const versionB = 'b0b0b0b0b0b0b0b0';
  const siteB = newVersion(SITE, 'B', 'next/index.html', versionB);
  server.serve(siteB);
  server.log.length = 0;
  await server.start();
  await setOffline(false);
  // Opening the page checks for a new sw.js by itself (the browser does, on navigation).
  await navigate(`${BASE}next/`);
  await waitFor(EXPLORER_READY, 30000);
  await evaluate('window.__versionA = true');
  const offered = await waitFor(`document.querySelector('.sf-pwa__card[data-kind="update"]') !== null`, 30000);
  check('update: a new version is offered', offered);
  const downloaded = [...new Set(server.log.filter((p) => p.startsWith(PREFIX)))];
  check(
    'update: only the changed file is downloaded, the rest is reused',
    downloaded.includes(`${PREFIX}next/index.html`) && downloaded.every((p) => p.endsWith('/sw.js') || p.endsWith('/next/index.html')),
    downloaded.join(', '),
  );
  await sleep(6000);
  check('update: nothing reloads by itself', await evaluate('window.__versionA === true'));
  await sleep(300);
  await shot('6-update-offered');
  // The card in the other themes, for review (the theme switch in the app strip).
  for (const [label, name] of [['Light theme', 'light'], ['Night vision theme', 'night'], ['Automatic theme', null]]) {
    await evaluate(`document.querySelector('[aria-label="${label}"]')?.click()`);
    await sleep(700);
    if (name) await shot(`6-update-offered-${name}`);
  }
  await evaluate(`document.querySelector('.sf-pwa__card[data-kind="update"] .sf-btn--primary').click()`);
  const reloaded = await waitFor(`window.__versionA === undefined && ${EXPLORER_READY}`, 30000);
  const isB = await evaluate(`[...document.documentElement.childNodes].some((n) => n.nodeType === 8 && n.data.includes('version B'))`);
  check('update: Reload applies it', reloaded && isB);
  const caches2 = await cacheContents();
  const names = Object.keys(caches2);
  check(
    'update: the old precache is deleted, the new one is complete',
    !names.includes(precacheName) && caches2[`skyfix-lab-precache-${versionB}@${PREFIX}`]?.length === build.entries.length,
    names.join(', '),
  );
  await shot('6-update-applied');

  // The workbench at / offers a new version in its own style.
  const siteC = newVersion(siteB, 'C', 'index.html', 'c0c0c0c0c0c0c0c0');
  server.serve(siteC);
  await navigate(BASE);
  await waitFor(`document.body.innerText.includes('WASM core')`, 30000);
  await evaluate('window.__versionB = true');
  const benchOffer = await waitFor(`document.querySelector('.sw-prompt') !== null`, 30000);
  await sleep(4000);
  check('update: the workbench offers it too, and waits', benchOffer && (await evaluate('window.__versionB === true')));
  await shot('6-update-offered-workbench');
  await evaluate(`document.querySelector('.sw-prompt button.primary').click()`);
  const benchReloaded = await waitFor(
    `window.__versionB === undefined && [...document.documentElement.childNodes].some((n) => n.nodeType === 8 && n.data.includes('version C'))`,
    30000,
  );
  check('update: the workbench applies it on Reload', benchReloaded);

  // --- 7. Other origins ----------------------------------------------------------------------
  await evaluate(`fetch('https://tile.openstreetmap.org/0/0/0.png', { mode: 'no-cors' }).catch(() => null)`);
  await sleep(1000);
  const everything = Object.values(await cacheContents()).flat();
  const foreign = everything.filter((u) => !u.startsWith(BASE));
  check('no cache holds anything from another origin (OpenStreetMap tiles included)', foreign.length === 0, `${everything.length} cached URLs; foreign: ${foreign.join(', ') || 'none'}`);
  const tile = responses.filter((r) => r.url.includes('tile.openstreetmap.org'));
  check('the worker never answers for another origin', tile.every((r) => !r.sw), tile.length ? `${tile.length} tile responses, none from the worker` : 'tile request left to the browser (no network here)');

  if (exceptions.length) console.log(`page exceptions:\n  ${[...new Set(exceptions)].join('\n  ')}`);
  chrome.close();
  await server.stop();
  await sleep(300);
  rmSync(scratch, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed; screenshots in ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
