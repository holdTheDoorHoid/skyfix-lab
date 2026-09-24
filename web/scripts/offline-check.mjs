#!/usr/bin/env node
/**
 * Check the offline app in a real browser. Serves an assembled site the way GitHub Pages
 * does (under /skyfix-lab/, `Cache-Control: max-age=600`), drives a local headless Chrome
 * over the DevTools protocol, and checks, with the server STOPPED for the offline parts
 * (and Chrome's HTTP cache cleared, so only the service worker can answer):
 *
 *   1. first visit, through an old share link at next/ (no service worker yet, so the
 *      next/ page itself forwards): the explorer opens at the home page with the shared
 *      place; the service worker installs, the precache fills, the page says so; the
 *      manifest is installable, starts at the home page, keeps its id
 *   2. second load offline: every file comes from the service worker; the WebAssembly
 *      engine runs; the basemap draws; the Offline chip comes and goes
 *   3. every view opens offline
 *   4. the original workbench at classic/ works offline with its notice; `classic` gets
 *      its slash; next/ and an old share link at next/ still reach the explorer, offline
 *   5. a docs page never visited shows the offline page; one visited online is kept
 *   6. a new version: offered, never applied by itself, applied on Reload; only the
 *      changed file is downloaded; the old precache is deleted; the same on classic/
 *   7. no cache holds anything from another origin
 *   8. with OLD_SITE (a site built before the switch-over, scripts/site-at.sh): someone
 *      who installed the old layout gets the new one: from the old explorer at next/
 *      (Reload in its prompt), from the old workbench at / (Reload in its prompt), and by
 *      closing the app and opening it again; unchanged files are not downloaded again;
 *      afterwards next/ and old share links work offline
 *
 * Screenshots go to docs/design/local/pwa-*.png (git-ignored). Development tool only:
 * Node built-ins and a local Chrome, no npm dependency. OWNER: release agent.
 *
 *   web/scripts/pages-site.sh                            # site/ as the Pages workflow builds it
 *   node web/scripts/offline-check.mjs                   # check it under /skyfix-lab/
 *   web/scripts/site-at.sh 1688cd8 /tmp/old-site         # the layout before the switch-over
 *   OLD_SITE=/tmp/old-site node web/scripts/offline-check.mjs   # ... and the upgrade from it
 *   SITE=web/dist PREFIX=/ node web/scripts/offline-check.mjs   # as `vite preview` serves it
 *
 * Environment: SITE (default <repo>/site), OLD_SITE (optional), PREFIX (default
 * /skyfix-lab/), CHROME (default google-chrome), OUT (default <repo>/docs/design/local),
 * PORT (default random). Exit status 1 if any check fails.
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
const OLD_SITE = process.env.OLD_SITE ? resolve(REPO, process.env.OLD_SITE) : null;
const PREFIX = process.env.PREFIX ?? '/skyfix-lab/';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(REPO, 'docs/design/local'));
const PORT = Number(process.env.PORT ?? 8700 + Math.floor(Math.random() * 200));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}${PREFIX}`;
const TAG = PREFIX === '/' ? 'root' : PREFIX.replace(/\W+/g, '');

/** Share links (state.ts `encodeShare`): the place travels in the fragment. */
const SHARE_GREENWICH = 'v=1&lat=51.4779&lon=-0.0015&place=Greenwich%20Observatory&tz=Europe%2FLondon';
const SHARE_SYDNEY = 'v=1&lat=-33.8568&lon=151.2153&place=Sydney%20Opera%20House&tz=Australia%2FSydney';

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
  let server = null;
  const sockets = new Set();
  const log = [];
  const handler = (req, res) => {
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
  };
  return {
    log,
    start: () =>
      new Promise((ok) => {
        server = createServer(handler);
        server.on('connection', (socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
        });
        server.listen(PORT, '127.0.0.1', ok);
      }),
    stop: () =>
      new Promise((ok) => {
        if (!server) return ok();
        server.close(() => ok());
        for (const s of sockets) s.destroy();
        server = null;
      }),
    /** Deploy another build: the next request is served from `dir`. */
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
      // Leaving a page must end it, as closing a tab does: a page kept in the back/forward
      // cache would still hold the old service worker in place.
      '--disable-features=BackForwardCache',
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

/** A browser with a fresh profile, and the helpers every check uses. */
async function session(profile) {
  const chrome = await launchChrome(profile);
  const { send, on } = chrome;
  const responses = [];
  const failures = [];
  const requestUrls = new Map();
  const exceptions = [];
  on('Network.responseReceived', (p) =>
    responses.push({ url: p.response.url, status: p.response.status, sw: p.response.fromServiceWorker }),
  );
  on('Network.loadingFailed', (p) => failures.push({ id: p.requestId, error: p.errorText }));
  on('Network.requestWillBeSent', (p) => requestUrls.set(p.requestId, p.request.url));
  on('Runtime.exceptionThrown', (p) => exceptions.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  // A fresh profile is a first visit: keep the first-run tour (shell/tour.ts) out of the shots.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('skyfix.explorer.tour.v1', 'done'); } catch {}` });
  // The "saved for offline use" note fades after a few seconds: record that it appeared.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `new MutationObserver(() => {
      if (document.querySelector('.sf-pwa__card[data-kind="ready"]')) window.__sawReadyNote = true;
    }).observe(document, { childList: true, subtree: true });`,
  });

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
  const s = {
    send,
    evaluate,
    waitFor,
    exceptions,
    close: () => chrome.close(),
    mark: () => ({ r: responses.length, f: failures.length }),
    /** This site's responses since `mark`, and whether each came from the worker. */
    sameOrigin: (mark) => responses.slice(mark.r).filter((r) => r.url.startsWith(BASE)),
    failedSince: (mark) => failures.slice(mark.f).map((f) => requestUrls.get(f.id) ?? '?').filter((u) => u.startsWith(BASE)),
    responses: () => responses,
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(OUT, `pwa-${TAG}-${name}.png`), Buffer.from(r.data, 'base64'));
    },
    viewport: (width, height, mobile = false) =>
      send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }),
    setOffline: (offline) => send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }),
    cacheContents: () =>
      evaluate(`(async () => {
        const out = {};
        for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map((r) => r.url);
        return out;
      })()`),
    async navigate(url) {
      await send('Page.navigate', { url });
      await sleep(300);
    },
  };
  await s.viewport(1440, 900);
  return s;
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

const precacheName = (version) => `skyfix-lab-precache-${version}@${PREFIX}`;
const EXPLORER_READY = "document.documentElement.dataset.ready === '1'";
const AT_HOME = `location.pathname === ${JSON.stringify(PREFIX)} && ${EXPLORER_READY}`;
const MAP_READY = `${EXPLORER_READY} && document.querySelector('.sfm')?.dataset.detail === '1' && document.querySelector('.sfm')?.dataset.places === '1'`;
const WORKBENCH_READY = "!!document.querySelector('.app-header') && document.body.innerText.includes('WASM core')";
const shows = (text) => `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;

async function main() {
  if (!existsSync(join(SITE, 'sw.js'))) throw new Error(`${SITE} has no sw.js: build it first (web/scripts/pages-site.sh)`);
  if (!existsSync(join(SITE, 'classic/index.html'))) throw new Error(`${SITE} is not laid out with the explorer at its root and classic/`);
  mkdirSync(OUT, { recursive: true });
  const build = workerBuild(SITE);
  const precacheBytes = build.entries.reduce((sum, e) => sum + statSync(join(SITE, e.url)).size, 0);
  console.log(`site ${SITE} at ${BASE}: sw.js version ${build.version}, ${build.entries.length} files, ${(precacheBytes / 1e6).toFixed(2)} MB`);

  const server = siteServer(SITE);
  await server.start();
  const scratch = mkdtempSync(join(tmpdir(), 'skyfix-offline-check-'));
  const s = await session(join(scratch, 'profile'));

  // --- 1. First visit, through an old share link at next/ --------------------------------------
  await s.navigate(`${BASE}next/#${SHARE_GREENWICH}`);
  check('first visit: an old share link at next/ opens the explorer at the home page', await s.waitFor(AT_HOME, 60000));
  check('first visit: ... with the shared place (the fragment survives the move)', await s.waitFor(shows('Greenwich Observatory'), 15000));
  check('first visit: ... and the address bar no longer carries it', await s.waitFor(`location.hash === '' || location.hash === '#map'`, 5000));
  const controlled = await s.waitFor('navigator.serviceWorker.controller !== null', 90000);
  check('first visit: the service worker installs and takes charge of the page', controlled);
  const caches1 = await s.cacheContents();
  check(
    'first visit: the precache holds every file of the build',
    caches1[precacheName(build.version)]?.length === build.entries.length,
    `${caches1[precacheName(build.version)]?.length ?? 0} of ${build.entries.length} in ${precacheName(build.version)}`,
  );
  check('first visit: the page says it now works offline', await s.waitFor('window.__sawReadyNote === true', 10000));
  await s.waitFor(MAP_READY, 30000);
  await s.shot('1-first-visit');
  const installErrors = await s.send('Page.getInstallabilityErrors');
  check('installable: no installability errors', installErrors.installabilityErrors.length === 0, JSON.stringify(installErrors.installabilityErrors));
  const manifest = await s.send('Page.getAppManifest');
  check('installable: the manifest parses without errors', (manifest.errors ?? []).length === 0, manifest.url);
  const parsed = JSON.parse(manifest.data);
  const startUrl = new URL(parsed.start_url, manifest.url).href;
  const scope = new URL(parsed.scope, manifest.url).href;
  check('installable: the app starts at the home page, and its scope is the whole site', startUrl === BASE && scope === BASE, `start ${startUrl}, scope ${scope}`);
  const appId = await s.send('Page.getAppId');
  check('installable: the app id is the one installed copies already have', appId.appId === `${ORIGIN}/skyfix-lab/`, `appId ${appId.appId}`);

  // --- 2. Second load, offline -------------------------------------------------------------
  await server.stop();
  await s.send('Network.clearBrowserCache');
  await s.setOffline(true);
  let mark = s.mark();
  await s.navigate(BASE);
  check('offline: the explorer starts again', await s.waitFor(AT_HOME, 60000));
  check('offline: no start-up failure', !(await s.evaluate(`document.body.innerText.includes('cannot start')`)));
  check('offline: the WebAssembly engine runs (■ WASM core badge)', await s.waitFor(`document.querySelector('.sf-badge--wasm') !== null`, 10000));
  const readout = await s.evaluate(`[...document.querySelectorAll('.sf-readout__value')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 4).join(' | ')`);
  check('offline: the panel shows computed values', /\d/.test(readout), readout);
  check('offline: the basemap draws (1:50m detail and place names loaded)', await s.waitFor(MAP_READY, 30000));
  // Chrome's emulated offline state does not survive a reload into `navigator.onLine`;
  // switching it again fires the `offline` event, as a real loss of connection does.
  await s.setOffline(false);
  await sleep(200);
  await s.setOffline(true);
  check('offline: the Offline chip shows when the connection drops', await s.waitFor(`document.querySelector('.sf-pwa__offline') !== null && navigator.onLine === false`, 5000));
  await sleep(1500);
  await s.shot('2-offline-map');
  await s.setOffline(false);
  check('offline: the chip goes when the connection is back', await s.waitFor(`document.querySelector('.sf-pwa__offline') === null`, 5000));
  await s.setOffline(true);
  let own = s.sameOrigin(mark);
  check(
    'offline: every file came from the service worker',
    own.length > 0 && own.every((r) => r.sw && r.status === 200),
    `${own.filter((r) => r.sw).length} of ${own.length} responses; not from the worker: ${own.filter((r) => !r.sw).map((r) => r.url).join(', ') || 'none'}`,
  );
  check('offline: no request of the site failed', s.failedSince(mark).length === 0, s.failedSince(mark).join(', '));

  // --- 3. Every view offline -------------------------------------------------------------------
  for (const view of ['sky', 'charts', 'navigate', 'almanac', 'events', 'learn', 'about']) {
    mark = s.mark();
    await s.evaluate(`location.hash = '#${view}'`);
    await sleep(3500);
    own = s.sameOrigin(mark);
    const bad = s.failedSince(mark);
    const busy = await s.evaluate(`!!document.querySelector('.sf-stage__view[aria-busy]')`);
    check(
      `offline: the ${view} view opens`,
      bad.length === 0 && own.every((r) => r.sw) && !busy,
      `${own.length} files from the worker${bad.length ? `; failed: ${bad.join(', ')}` : ''}`,
    );
    await s.shot(`3-offline-${view}`);
  }
  await s.evaluate(`location.hash = '#map'`);

  // A phone, opened while already offline (navigator.onLine false from the start; forced
  // here, see above): the chip is there from the first frame, above the bottom sheet.
  const forced = await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false });`,
  });
  await s.viewport(390, 844, true);
  await s.navigate(BASE);
  await s.waitFor(MAP_READY, 30000);
  check('offline: opened with no connection, the Offline chip shows at once', await s.waitFor(`document.querySelector('.sf-pwa__offline') !== null`, 5000));
  await sleep(1200);
  await s.shot('3-offline-phone');
  await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: forced.identifier });
  await s.viewport(1440, 900);

  // --- 4. The original workbench, and addresses that moved, offline ---------------------------
  mark = s.mark();
  await s.navigate(`${BASE}classic/`);
  const bench = await s.waitFor(WORKBENCH_READY, 30000);
  check('offline: the original workbench at classic/ starts on the WebAssembly core', bench && s.failedSince(mark).length === 0, s.failedSince(mark).join(', '));
  const notice = await s.evaluate(`(() => {
    const p = document.querySelector('.classic-notice');
    const a = p?.querySelector('a');
    return p ? { text: p.textContent.replace(/\\s+/g, ' ').trim(), href: a?.href ?? null, top: p.getBoundingClientRect().top } : null;
  })()`);
  check(
    'offline: classic/ says it is the original workbench, and links the home page',
    notice?.text.startsWith('This is the original SkyFix Lab workbench, kept for reference.') && notice.href === BASE && notice.top < 5,
    notice ? `"${notice.text}" -> ${notice.href}` : 'no notice',
  );
  await sleep(800);
  await s.shot('4-offline-classic');
  await s.navigate(`${BASE}classic`);
  check('offline: `classic` gets its slash and starts', await s.waitFor(`location.pathname === ${JSON.stringify(`${PREFIX}classic/`)} && ${WORKBENCH_READY}`, 30000));
  await s.navigate(`${BASE}next/`);
  check('offline: next/ (the explorer\'s old address) opens the explorer at the home page', await s.waitFor(AT_HOME, 30000));
  await s.navigate(`${BASE}next/#${SHARE_SYDNEY}`);
  check(
    'offline: an old share link at next/ opens with its place, and the map draws there',
    (await s.waitFor(`${AT_HOME} && ${shows('Sydney Opera House')}`, 30000)) && (await s.waitFor(MAP_READY, 30000)),
  );
  await sleep(1500);
  await s.shot('4-offline-old-share-link');
  await s.navigate(`${BASE}next`);
  check('offline: `next` (no slash) opens the explorer at the home page', await s.waitFor(AT_HOME, 30000));

  // --- 5. The docs ---------------------------------------------------------------------------
  if (existsSync(join(SITE, 'docs/index.html'))) {
    await s.navigate(`${BASE}docs/`);
    const offlinePage = await s.waitFor(`document.body.innerText.includes('You are offline')`, 10000);
    const links = await s.evaluate(`[...document.querySelectorAll('a')].map((a) => a.href)`);
    check(
      'offline: a docs page never visited shows the offline page, linking the explorer and classic/',
      offlinePage && links.includes(BASE) && links.includes(`${BASE}classic/`),
      links.join(', '),
    );
    await s.shot('5-offline-docs-unvisited');
    await server.start();
    await s.setOffline(false);
    await s.navigate(`${BASE}docs/`);
    const online = await s.waitFor(`!!document.querySelector('#mdbook-content, .content, main') && !document.body.innerText.includes('You are offline')`, 15000);
    const title = await s.evaluate('document.title');
    await server.stop();
    await s.setOffline(true);
    await s.send('Network.clearBrowserCache');
    await s.send('Page.reload', { ignoreCache: false });
    await sleep(500);
    const kept = await s.waitFor(`document.title === ${JSON.stringify(title)} && !document.body.innerText.includes('You are offline')`, 10000);
    check('offline: a docs page visited online is kept', online && kept, title);
    await s.shot('5-offline-docs-visited');
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
  const hasComment = (text) => `[...document.documentElement.childNodes].some((n) => n.nodeType === 8 && n.data.includes(${JSON.stringify(text)}))`;
  const versionB = 'b0b0b0b0b0b0b0b0';
  const siteB = newVersion(SITE, 'B', 'index.html', versionB);
  server.serve(siteB);
  server.log.length = 0;
  await server.start();
  await s.setOffline(false);
  // Opening the page checks for a new sw.js by itself (the browser does, on navigation).
  await s.navigate(BASE);
  await s.waitFor(EXPLORER_READY, 30000);
  await s.evaluate('window.__versionA = true');
  check('update: a new version is offered', await s.waitFor(`document.querySelector('.sf-pwa__card[data-kind="update"]') !== null`, 30000));
  const downloaded = [...new Set(server.log.filter((p) => p.startsWith(PREFIX)))];
  check(
    'update: only the changed file is downloaded, the rest is reused',
    downloaded.includes(`${PREFIX}index.html`) && downloaded.every((p) => p === `${PREFIX}sw.js` || p === `${PREFIX}index.html`),
    downloaded.join(', '),
  );
  await sleep(6000);
  check('update: nothing reloads by itself', await s.evaluate('window.__versionA === true'));
  await s.shot('6-update-offered');
  await s.evaluate(`document.querySelector('.sf-pwa__card[data-kind="update"] .sf-btn--primary').click()`);
  const reloaded = await s.waitFor(`window.__versionA === undefined && ${EXPLORER_READY}`, 30000);
  check('update: Reload applies it', reloaded && (await s.evaluate(hasComment('version B'))));
  const caches2 = await s.cacheContents();
  check(
    'update: the old precache is deleted, the new one is complete',
    !Object.keys(caches2).includes(precacheName(build.version)) && caches2[precacheName(versionB)]?.length === build.entries.length,
    Object.keys(caches2).join(', '),
  );

  // The original workbench offers a new version in its own style.
  const siteC = newVersion(siteB, 'C', 'classic/index.html', 'c0c0c0c0c0c0c0c0');
  server.serve(siteC);
  await s.navigate(`${BASE}classic/`);
  await s.waitFor(WORKBENCH_READY, 30000);
  await s.evaluate('window.__versionB = true');
  const benchOffer = await s.waitFor(`document.querySelector('.sw-prompt') !== null`, 30000);
  await sleep(4000);
  check('update: classic/ offers it too, and waits', benchOffer && (await s.evaluate('window.__versionB === true')));
  await s.shot('6-update-offered-classic');
  await s.evaluate(`document.querySelector('.sw-prompt button.primary').click()`);
  check('update: classic/ applies it on Reload', await s.waitFor(`window.__versionB === undefined && ${hasComment('version C')}`, 30000));

  // --- 7. Other origins ----------------------------------------------------------------------
  await s.evaluate(`fetch('https://tile.openstreetmap.org/0/0/0.png', { mode: 'no-cors' }).catch(() => null)`);
  await sleep(1000);
  const everything = Object.values(await s.cacheContents()).flat();
  const foreign = everything.filter((u) => !u.startsWith(BASE));
  check('no cache holds anything from another origin (OpenStreetMap tiles included)', foreign.length === 0, `${everything.length} cached URLs; foreign: ${foreign.join(', ') || 'none'}`);
  const tile = s.responses().filter((r) => r.url.includes('tile.openstreetmap.org'));
  check('the worker never answers for another origin', tile.every((r) => !r.sw), tile.length ? `${tile.length} tile responses, none from the worker` : 'tile request left to the browser (no network here)');

  if (s.exceptions.length) console.log(`page exceptions:\n  ${[...new Set(s.exceptions)].join('\n  ')}`);
  s.close();
  await server.stop();

  // --- 8. Upgrading from the layout before the switch-over -------------------------------------
  if (OLD_SITE) {
    for (const way of ['old explorer at next/, Reload', 'old workbench at /, Reload', 'closed and opened again']) {
      await upgrade(way, server, join(scratch, `profile-${results.length}`), build);
    }
  } else {
    console.log('(no OLD_SITE: the upgrade from the layout before the switch-over was not checked)');
  }

  await sleep(300);
  rmSync(scratch, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed; screenshots in ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
}

/**
 * Someone installed the site before the switch-over (the explorer at next/, the workbench
 * at /), then the new build is deployed. Whichever way they come back, they must end up on
 * the explorer at the home page, with the old copy cleaned up.
 */
async function upgrade(way, server, profile, build) {
  const old = workerBuild(OLD_SITE);
  const tag = way.startsWith('old workbench') ? 'workbench' : way.startsWith('old explorer') ? 'explorer' : 'reopen';
  server.serve(OLD_SITE);
  await server.start();
  const s = await session(profile);
  const start = tag === 'workbench' ? BASE : `${BASE}next/`;
  const oldReady = tag === 'workbench' ? WORKBENCH_READY : `location.pathname === ${JSON.stringify(`${PREFIX}next/`)} && ${EXPLORER_READY}`;

  await s.navigate(start);
  await s.waitFor(oldReady, 60000);
  await s.waitFor('navigator.serviceWorker.controller !== null', 90000);
  const before = await s.cacheContents();
  check(
    `upgrade (${way}): the old layout is installed`,
    before[precacheName(old.version)]?.length === old.entries.length,
    `${before[precacheName(old.version)]?.length ?? 0} of ${old.entries.length} files`,
  );

  // Deploy the new build, and come back the way this visitor does.
  server.serve(SITE);
  server.log.length = 0;
  await s.navigate(start);
  const servedOld = await s.waitFor(oldReady, 30000);
  if (tag === 'reopen') {
    // The new version installs while the old page is open; then every page of the site is
    // closed, and the app opened again at its old start address.
    const waiting = await s.waitFor('navigator.serviceWorker.getRegistration().then((r) => !!r?.waiting)', 60000);
    await s.navigate('about:blank');
    await sleep(1500);
    await s.navigate(start);
    check(
      `upgrade (${way}): the old copy serves the page until then, and the app reopens on the explorer at the home page`,
      servedOld && waiting && (await s.waitFor(AT_HOME, 60000)),
    );
  } else {
    const prompt = tag === 'workbench' ? `document.querySelector('.sw-prompt')` : `document.querySelector('.sf-pwa__card[data-kind="update"]')`;
    const offered = await s.waitFor(`${prompt} !== null`, 60000);
    await s.evaluate('window.__oldPage = true');
    await sleep(4000);
    check(`upgrade (${way}): the old page offers the new version and waits`, servedOld && offered && (await s.evaluate('window.__oldPage === true')));
    await s.shot(`8-upgrade-${tag}-offered`);
    const button = tag === 'workbench' ? `document.querySelector('.sw-prompt button.primary')` : `document.querySelector('.sf-pwa__card[data-kind="update"] .sf-btn--primary')`;
    await s.evaluate(`${button}.click()`);
    check(`upgrade (${way}): Reload lands on the explorer at the home page`, await s.waitFor(`window.__oldPage === undefined && ${AT_HOME}`, 60000));
  }
  await s.waitFor(MAP_READY, 30000);
  await s.shot(`8-upgrade-${tag}-done`);
  const after = await s.cacheContents();
  check(
    `upgrade (${way}): the old copy is deleted, the new one complete`,
    !(precacheName(old.version) in after) && after[precacheName(build.version)]?.length === build.entries.length,
    Object.keys(after).join(', '),
  );
  const refetched = [...new Set(server.log)].filter((p) => /\/data\/|\.woff2$|\.wasm$/.test(p));
  check(`upgrade (${way}): unchanged files (map data, fonts, the engine) are reused, not downloaded again`, refetched.length === 0, refetched.join(', ') || 'none downloaded');

  // Offline afterwards: the old start address and old share links still work.
  await server.stop();
  await s.send('Network.clearBrowserCache');
  await s.setOffline(true);
  await s.navigate(`${BASE}next/#${SHARE_SYDNEY}`);
  check(`upgrade (${way}): offline, an old share link at next/ opens the explorer with its place`, await s.waitFor(`${AT_HOME} && ${shows('Sydney Opera House')}`, 30000));
  await s.navigate(`${BASE}classic/`);
  check(`upgrade (${way}): offline, classic/ works`, await s.waitFor(WORKBENCH_READY, 30000));
  if (s.exceptions.length) console.log(`page exceptions:\n  ${[...new Set(s.exceptions)].join('\n  ')}`);
  s.close();
  await sleep(300);
}

await main();
