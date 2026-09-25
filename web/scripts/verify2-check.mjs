#!/usr/bin/env node
/**
 * The verify2 agent's browser checks (development tool; Node built-ins and a local headless
 * Chrome of its own, as `ui-check.mjs` does, whose server and DevTools client this copies).
 * They answer what `ui-check.mjs` does not:
 *
 *   chip      the ±ΔT chip beside the clock at 2000 BC, 500 BC, AD 1000 and AD 2999 shows the
 *             engine's own `time_info` σ, asked from the release CLI (not from the page), rounded
 *             the way `time/chip.ts` says; and a labelled-tier time never goes without it;
 *   playback  a CPU profile of each view while time plays at 10 years a second, against an hour
 *             a second: how much of the page's time goes into the WebAssembly engine, by
 *             export, and the heaviest functions. Judged: at 10 years a second (fastPlayback)
 *             a view asks only for the positions it draws (sky_state) and the clock's chip and
 *             tier; everything else under 0.1 ms a frame. Run it on an unminified build
 *             (`npx vite build --minify false --outDir …`, then SITE=that directory), where
 *             the exports keep their names;
 *   exports   the Events calendar file read by a real iCalendar parser (Python `icalendar`), its
 *             table by Python's `csv`, the Sky picture and a chart's PNG opened by Pillow;
 *   packs     the tides pack's prompt answered Not now (nothing fetched, the prompt gone) and Get
 *             while offline (a plain sentence, the prompt still there, no exception);
 *   tiers     in the labelled tier Navigate refuses sights and says why, with the chip.
 *
 *   npm run build --prefix web && cargo build --release -p skyfix-cli
 *   VERIFY2_PYLIB=<dir with icalendar and Pillow> node web/scripts/verify2-check.mjs
 *   ONLY=chip,playback node web/scripts/verify2-check.mjs
 *
 * Environment: SITE (web/dist), CHROME (google-chrome), OUT (docs/design/local), ONLY,
 * VERIFY2_PY (the shared venv's python), VERIFY2_PYLIB (added to its path). Exit status 1 if
 * any check fails. Screenshots and verify2-check.json go to OUT (git-ignored).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../..');
const SITE = resolve(REPO, process.env.SITE ?? 'web/dist');
const PREFIX = '/skyfix-lab/';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(REPO, 'docs/design/local'));
const PORT = Number(process.env.PORT ?? 9100 + Math.floor(Math.random() * 400));
const BASE = `http://127.0.0.1:${PORT}${PREFIX}`;
/** The core's exports, by name (the glue's declarations), for counting calls in a profile. */
const EXPORTS = (() => {
  try {
    return new Set([...readFileSync(resolve(REPO, 'web/src/wasm-pkg/skyfix_wasm.d.ts'), 'utf8').matchAll(/^export function ([a-z_0-9]+)/gm)].map((m) => m[1]));
  } catch {
    return new Set();
  }
})();
/** Page script: count every call into the core's WebAssembly exports, by name. */
const COUNT_CALLS = `(() => {
  const counts = (globalThis.__wasmCalls = {});
  const wrap = (result) => {
    const inst = result instanceof WebAssembly.Instance ? result : result.instance;
    // A plain copy: the real exports object is frozen, which a Proxy may not misreport.
    const real = inst.exports;
    const wrapped = {};
    for (const k of Object.keys(real)) {
      const v = real[k];
      wrapped[k] = typeof v === 'function' && !k.startsWith('__') ? (...a) => { counts[k] = (counts[k] ?? 0) + 1; return v(...a); } : v;
    }
    const fake = Object.create(inst, { exports: { value: wrapped } });
    return result instanceof WebAssembly.Instance ? fake : { module: result.module, instance: fake };
  };
  const streaming = WebAssembly.instantiateStreaming;
  if (streaming) WebAssembly.instantiateStreaming = (...a) => streaming.apply(WebAssembly, a).then(wrap);
  const plain = WebAssembly.instantiate;
  WebAssembly.instantiate = (...a) => plain.apply(WebAssembly, a).then((r) => (r instanceof WebAssembly.Module ? r : wrap(r)));
})();`;
/** Exports a view may call every frame during fast playback: the positions, the clock's chip and tier. */
const PER_FRAME = new Set(['sky_state', 'time_info', 'tier_at', 'packs', 'tide_pack_info', 'explorer_coverage']);
const ONLY = new Set((process.env.ONLY ?? 'chip,playback,exports,packs,tiers').split(','));
const CLI = resolve(REPO, 'target/release/skyfix');
const PY = process.env.VERIFY2_PY ?? join(REPO, 'tools/reference/.venv/bin/python');
const PYLIB = process.env.VERIFY2_PYLIB ?? '';
const PLACE = 'v=1&lat=39.9526&lon=-75.1652&place=Philadelphia&tz=America%2FNew_York&body=Moon';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------
// The site, as GitHub Pages serves it
// ---------------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.woff2': 'font/woff2',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream',
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
// Chrome over the DevTools protocol (a private instance and profile)
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
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
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
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const mid = ++id;
    pending.set(mid, { ok, fail, method });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  const messages = [];
  on('Runtime.consoleAPICalled', (p) => messages.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`));
  on('Runtime.exceptionThrown', (p) => messages.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`));
  on('Log.entryAdded', (p) => messages.push(`${p.entry.level}: ${p.entry.text}`));
  const requests = [];
  on('Network.requestWillBeSent', (p) => requests.push(p.request.url));
  for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'Performance.enable', 'Profiler.enable']) await send(m);
  await send('Network.setBypassServiceWorker', { bypass: true });
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
  return { send, evaluate, waitFor, messages, requests, close() { ws.close(); chrome.kill(); } };
}

// ---------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** `time/chip.ts`'s `sigmaText`, written again from its specification. */
function sigmaText(s) {
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 89.5) return `±${Math.max(1, Math.round(s))} s`;
  if (s < 59.5 * 60) return `±${Math.round(s / 60)} min`;
  const h = s / 3600;
  return `±${h < 9.95 ? h.toFixed(1).replace(/\.0$/, '') : String(Math.round(h))} h`;
}

function engineTimeInfo(iso) {
  const r = spawnSync(CLI, ['--calendar', 'gregorian', 'time-info', iso, '--json'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`skyfix time-info ${iso}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function python(code, ...args) {
  const env = { ...process.env, PYTHONPATH: [PYLIB, process.env.PYTHONPATH ?? ''].filter(Boolean).join(':') };
  const r = spawnSync(PY, ['-c', code, ...args], { encoding: 'utf8', env });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** A sampled CPU profile's time by kind: WebAssembly, JavaScript, idle, program, GC. */
function profileSummary(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + dt);
  }
  const kinds = { wasm: 0, js: 0, idle: 0, program: 0, gc: 0 };
  const top = new Map();
  for (const [nid, ms] of self) {
    const f = byId.get(nid).callFrame;
    const name = f.functionName || '(anonymous)';
    let kind = 'js';
    if (name === '(idle)') kind = 'idle';
    else if (name === '(program)') kind = 'program';
    else if (name === '(garbage collector)') kind = 'gc';
    else if (f.url.startsWith('wasm://') || /^\$?wasm-function|^\$func/.test(name)) kind = 'wasm';
    kinds[kind] += ms;
    if (kind === 'js' || kind === 'wasm') {
      const key = `${kind === 'wasm' ? '[wasm] ' : ''}${name} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
      top.set(key, (top.get(key) ?? 0) + ms);
    }
  }
  // Who called into the engine: each WebAssembly sample charged to the nearest named
  // JavaScript frame above it (class methods such as `skyState` keep their names through
  // minification; the module's own functions are stripped).
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const callers = new Map();
  const byExport = new Map();
  for (const [nid, ms] of self) {
    const f = byId.get(nid).callFrame;
    if (!(f.url.startsWith('wasm://') || /^\$?wasm-function|^\$func/.test(f.functionName))) continue;
    let p = parent.get(nid);
    const chain = [];
    while (p !== undefined && chain.length < 4) {
      const pf = byId.get(p).callFrame;
      // (the call counter's own wrapper, `wrapped.<computed>`, is not a caller)
      if (!pf.url.startsWith('wasm://') && pf.functionName && !/^\$?wasm-function|^wrapped\./.test(pf.functionName)) chain.push(pf.functionName);
      p = parent.get(p);
    }
    const key = chain.slice(0, 3).join(' < ') || '(unknown)';
    callers.set(key, (callers.get(key) ?? 0) + ms);
    // The export: wasm-bindgen's glue function under the js-to-wasm trampoline (its name
    // survives only in an unminified build: `vite build --minify false`).
    const exp = chain.find((n) => n !== 'js-to-wasm::' && !n.startsWith('js-to-wasm')) ?? '(unknown)';
    byExport.set(exp, (byExport.get(exp) ?? 0) + ms);
  }
  // Calls per export: runs of consecutive samples whose stack holds that export's glue
  // function (a call shorter than the sampling interval can be missed; back-to-back calls
  // of one export merge). Needs the exports' names (an unminified build).
  const exportOf = new Map();
  const exportAt = (nid) => {
    if (exportOf.has(nid)) return exportOf.get(nid);
    let p = nid;
    let found = null;
    while (p !== undefined) {
      const name = byId.get(p).callFrame.functionName;
      if (EXPORTS.has(name)) {
        found = name;
        break;
      }
      p = parent.get(p);
    }
    exportOf.set(nid, found);
    return found;
  };
  const calls = new Map();
  let prev = null;
  for (const nid of profile.samples) {
    const e = exportAt(nid);
    if (e && e !== prev) calls.set(e, (calls.get(e) ?? 0) + 1);
    prev = e;
  }
  const busy = kinds.wasm + kinds.js + kinds.program + kinds.gc;
  return {
    calls: Object.fromEntries([...calls.entries()].sort((a, b) => b[1] - a[1])),
    ms: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, +v.toFixed(1)])),
    wasmByExport: Object.fromEntries([...byExport.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +v.toFixed(1)])),
    wasmShareOfBusy: busy ? +(kinds.wasm / busy).toFixed(3) : 0,
    wasmCallers: [...callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v.toFixed(0)} ms`),
    top: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(0)} ms`),
  };
}

// ---------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------

async function main() {
  if (!existsSync(join(SITE, 'index.html'))) throw new Error(`${SITE} is not a built site: npm run build --prefix web`);
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: cargo build --release -p skyfix-cli`);
  mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const scratch = mkdtempSync(join(tmpdir(), 'skyfix-verify2-'));
  const page = await launch(join(scratch, 'profile'));
  const { send, evaluate, waitFor, messages, requests } = page;
  // Every call into the core counted by export: the glue's instance gets exports wrapped in
  // a counting proxy (window.__wasmCalls), before any page script runs.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT_CALLS });
  const summary = { chip: [], playback: {}, exports: {}, packs: {}, tiers: {} };
  const viewport = (w, h, mobile) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const open = async (hash, { theme = 'dark' } = {}) => {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(100);
    await send('Page.navigate', { url: `${BASE}?setup` });
    await waitFor('document.readyState === "complete"');
    await evaluate(`localStorage.clear(); localStorage.setItem('skyfix.explorer.prefs.v1', JSON.stringify({ settings: { theme: '${theme}' } })); localStorage.setItem('skyfix.explorer.tour.v1', 'done'); true`);
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(100);
    await send('Page.navigate', { url: `${BASE}#${hash}` });
    await waitFor(`document.documentElement.dataset.ready === '1'`);
    await waitFor(`(() => { const v = document.querySelector('.sf-stage__view'); return v && !v.hasAttribute('aria-busy') && v.children.length > 0; })()`);
    await sleep(1200);
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `verify2-${name}.png`), Buffer.from(r.data, 'base64'));
  };
  await viewport(1440, 900, false);

  try {
    // The ±ΔT chip beside the clock shows the engine's σ.
    if (ONLY.has('chip')) {
      const chipJs = `JSON.stringify((() => { const c = document.querySelector('.sf-tb-clock__chip'); return { text: c && !c.hidden ? c.textContent.trim() : '', tier: c?.dataset.tier ?? '', date: document.querySelector('.sf-tb-date__label')?.textContent.trim() ?? '' }; })())`;
      for (const iso of ['-2000-06-01T12:00:00Z', '-0500-06-01T12:00:00Z', '1000-06-01T12:00:00Z', '1600-06-01T12:00:00Z', '2026-06-01T12:00:00Z', '2999-06-01T12:00:00Z']) {
        const info = engineTimeInfo(iso);
        const want = info.tier === 'labelled' || info.delta_t_sigma_s > 30 ? sigmaText(info.delta_t_sigma_s) : '';
        await open(`${PLACE}&t=${iso}&view=map`);
        const got = JSON.parse(await evaluate(chipJs));
        summary.chip.push({ iso, sigma_s: info.delta_t_sigma_s, tier: info.tier, want, got });
        check(`the ±ΔT chip at ${iso} (${got.date}) is the engine's σ ${info.delta_t_sigma_s.toFixed(1)} s`, got.text === want, `${JSON.stringify(got.text)} vs ${JSON.stringify(want)}`);
        if (info.tier === 'labelled') check(`a labelled-tier time (${iso}) carries its chip`, got.text !== '' && got.tier === 'labelled', JSON.stringify(got));
      }
    }

    // What each view computes while time plays fast.
    if (ONLY.has('playback')) {
      for (const view of (process.env.PB_VIEWS ?? 'map,sky,tonight,charts,events,almanac,navigate').split(',')) {
        summary.playback[view] = {};
        for (const [label, key] of [['1 hour per second', '1h/s'], ['10 years per second', '10y/s']]) {
          await open(`${PLACE}&t=2026-01-02T16:00:00Z&view=${view}`);
          await evaluate(`document.querySelector('.sf-tb-speed').click(); true`);
          await sleep(300);
          await evaluate(`[...document.querySelectorAll('.sf-menu__item')].find((b) => b.textContent.startsWith(${JSON.stringify(label)}))?.click(); true`);
          await sleep(1500);
          await evaluate(`window.__f = []; (function loop(t) { window.__f.push(t); if (window.__f.length < 100000) requestAnimationFrame(loop); })(performance.now()); true`);
          const f0 = await evaluate('window.__f.length');
          await send('Profiler.setSamplingInterval', { interval: 250 });
          await evaluate(`for (const k of Object.keys(globalThis.__wasmCalls ?? {})) delete globalThis.__wasmCalls[k]; true`);
          await send('Profiler.start');
          await sleep(4000);
          const { profile } = await send('Profiler.stop');
          const exact = JSON.parse(await evaluate(`JSON.stringify(globalThis.__wasmCalls ?? {})`));
          const ts = JSON.parse(await evaluate(`JSON.stringify(window.__f.slice(${f0}))`));
          const playing = await evaluate(`document.querySelector('.sf-timebar')?.classList.contains('sf-timebar--fast') ?? false`);
          await evaluate(`document.querySelector('.sf-tb-play').click(); true`);
          const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
          const q = (p) => +(d[Math.min(d.length - 1, Math.floor(p * d.length))] ?? 0).toFixed(1);
          const s = profileSummary(profile);
          const r = { frames: d.length, medianFrameMs: q(0.5), p95FrameMs: q(0.95), wasmMsPerFrame: +(s.ms.wasm / Math.max(1, d.length)).toFixed(2), ...s, calls: exact, sampledCalls: s.calls, fast: playing };
          summary.playback[view][key] = r;
          console.log(`info  ${view} at ${key}: ${JSON.stringify(r)}`);
        }
        const fast = summary.playback[view]['10y/s'];
        // Allowed each frame: the positions drawn (sky_state) and the clock's chip and tier.
        // Anything else is a day's, a year's or a plan's work that fastPlayback should skip.
        // Needs an unminified build to name the exports (SITE=… from vite build --minify false).
        const other = Object.entries(fast.calls).filter(([k]) => !PER_FRAME.has(k));
        const otherMs = Object.entries(fast.wasmByExport).filter(([k]) => !PER_FRAME.has(k) && EXPORTS.has(k)).reduce((a, [, v]) => a + v, 0);
        check(
          `${view}: at 10 years a second the engine is asked only for the positions it draws`,
          fast.fast && Object.keys(fast.calls).length > 0 && other.length === 0,
          `other calls in 4 s: ${other.map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'} (${otherMs.toFixed(1)} ms sampled); sky_state ×${fast.calls.sky_state ?? 0} over ${fast.frames} frames, ${fast.wasmMsPerFrame} ms of engine a frame, ${(100 * fast.wasmShareOfBusy).toFixed(1)} % of busy time`,
        );
        // At an hour a second the panel's sights plan (100-150 ms) waits for the time to be
        // still, or five seconds (navigate/tonight.ts): at most one in the four profiled.
        const slow = summary.playback[view]['1h/s'];
        const plans = slow.calls.plan_sights ?? 0;
        check(`${view}: at an hour a second tonight's sights are planned at most once in the 4 s profiled`, plans <= 1, `plan_sights ${plans} calls, ${slow.wasmByExport?.plan_sights ?? 0} ms`);
      }
    }

    // Exports opened by real readers.
    if (ONLY.has('exports')) {
      const downloads = join(scratch, 'downloads');
      mkdirSync(downloads, { recursive: true });
      await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      const EV = 'v=1&lat=39.9526&lon=-75.1652&place=Philadelphia&tz=America%2FNew_York&t=2026-09-24T16:00:00Z&body=Moon';
      const saveEvents = async (tab, sub, action) => {
        await open(`${EV}&view=events`);
        await evaluate(`document.querySelector('.sfe-tabs [id$="-${tab}"]')?.click(); true`);
        if (sub) {
          await waitFor(`!!document.querySelector('.sfe-subtabs [data-sub="${sub}"]')`, 5000);
          await evaluate(`document.querySelector('.sfe-subtabs [data-sub="${sub}"]')?.click(); true`);
        }
        await waitFor(`!!document.querySelector('.sfe-save__btn') && !document.querySelector('.sfe-save__btn').disabled`, 60000);
        await sleep(800);
        await evaluate(`document.querySelector('.sfe-save__btn').click(); true`);
        await sleep(300);
        await evaluate(`document.querySelector('.sfe-save__menu [data-action=${action}]').click(); true`);
        await waitFor(`/^Saved /.test(document.querySelector('.sfe-save__status')?.textContent ?? '')`, 20000);
        const status = await evaluate(`document.querySelector('.sfe-save__status')?.textContent ?? ''`);
        await sleep(800);
        const name = (/^Saved (.+)\.$/.exec(status) ?? [])[1] ?? '';
        return name && existsSync(join(downloads, name)) ? join(downloads, name) : '';
      };
      for (const [tab, sub] of [['moon', 'occultations'], ['meteors', ''], ['planets', 'conjunctions'], ['eclipses', '']]) {
        const ics = await saveEvents(tab, sub, 'ics');
        const parsed = ics
          ? python(`import sys, icalendar, datetime
cal = icalendar.Calendar.from_ical(open(sys.argv[1], 'rb').read())
ev = list(cal.walk('VEVENT'))
bad = [e for e in ev if not e.get('UID') or not e.get('DTSTART') or not e.get('SUMMARY') or e.decoded('DTSTART').tzinfo is None or (e.get('DTEND') and e.decoded('DTEND') < e.decoded('DTSTART'))]
uids = [str(e.get('UID')) for e in ev]
print(len(ev), len(bad), len(set(uids)) == len(uids), cal.get('VERSION'), cal.get('PRODID'))`, ics)
          : { ok: false, out: '', err: 'no file' };
        summary.exports[`${tab}${sub ? '/' + sub : ''}.ics`] = parsed.out || parsed.err.split('\n').pop();
        const [n, bad, unique] = parsed.out.split(' ');
        check(`Events ${tab}${sub ? '/' + sub : ''}: the calendar file reads in icalendar, every event whole`, parsed.ok && Number(n) > 0 && bad === '0' && unique === 'True', parsed.out || parsed.err.split('\n').pop());
      }
      const csvFile = await saveEvents('moon', 'occultations', 'csv');
      const csvRead = csvFile
        ? python(`import sys, csv
rows = list(csv.reader(open(sys.argv[1], encoding='utf-8-sig')))
body = [r for r in rows if r and not r[0].startswith('#')]
w = {len(r) for r in body[1:]}
print(len(body) - 1, len(body[0]), sorted(w))`, csvFile)
        : { ok: false, out: '', err: 'no file' };
      summary.exports['occultations.csv'] = csvRead.out || csvRead.err;
      check('Events: the table reads in Python\'s csv module, every row as wide as its header', csvRead.ok && /^\d+ (\d+) \[\1\]$/.test(csvRead.out), csvRead.out || csvRead.err.split('\n').pop());
      // The Sky picture: intercept the download, save its bytes, open them with Pillow.
      await open(`${PLACE}&t=2026-09-25T02:00:00Z&view=sky`, { theme: 'dark' });
      await evaluate(`window.__saved = null; window.__click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__saved = { name: this.download, href: this.href }; return; } return window.__click.call(this); }; true`);
      await evaluate(`document.querySelector('.sky-ov--tools [aria-label="Save the sky as a picture"]')?.click(); true`);
      await waitFor(`window.__saved !== null`, 20000);
      const b64 = await evaluate(`(async () => { const s = window.__saved; if (!s) return ''; const u = new Uint8Array(await (await fetch(s.href)).arrayBuffer()); let b = ''; for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(b); })()`);
      const pngFile = join(scratch, 'sky.png');
      writeFileSync(pngFile, Buffer.from(b64, 'base64'));
      const img = python(`import sys
from PIL import Image
im = Image.open(sys.argv[1]); im.load(); print(im.format, im.size[0], im.size[1], im.mode)`, pngFile);
      summary.exports['sky.png'] = img.out || img.err;
      check('Sky: the saved picture opens in Pillow as a PNG', img.ok && /^PNG \d+ \d+ /.test(img.out), img.out || img.err.split('\n').pop());
    }

    // The tides pack's prompt: Not now, and Get while offline.
    if (ONLY.has('packs')) {
      const prompt = `document.querySelector('.sf-packs-prompt')`;
      await open(`${PLACE}&t=2026-09-24T16:00:00Z&view=charts`);
      await evaluate(`document.querySelector('.sfc-tabs [data-tab=tides]')?.click(); true`);
      const asked = await waitFor(`!!${prompt}`, 15000);
      const n0 = requests.filter((u) => /\/data\/packs\/tides-us-.*\.bin/.test(u)).length;
      await evaluate(`[...${prompt}.querySelectorAll('button')].find((b) => /^Not now$/.test(b.textContent.trim()))?.click(); true`);
      await sleep(1500);
      const gone = await evaluate(`!${prompt}`);
      const n1 = requests.filter((u) => /\/data\/packs\/tides-us-.*\.bin/.test(u)).length;
      const card = await evaluate(`document.querySelector('.sfc-card')?.innerText.slice(0, 300) ?? ''`);
      summary.packs.declined = { asked, gone, fetched: n1 - n0, card };
      check('packs: Not now closes the prompt and fetches nothing', asked && gone && n1 === n0, JSON.stringify({ asked, gone, fetched: n1 - n0 }));
      messages.length = 0;
      await open(`${PLACE}&t=2026-09-24T16:00:00Z&view=charts`);
      await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await evaluate(`document.querySelector('.sfc-tabs [data-tab=tides]')?.click(); true`);
      await waitFor(`!!${prompt}`, 15000);
      await evaluate(`[...${prompt}.querySelectorAll('button')].find((b) => /^Get/.test(b.textContent.trim()))?.click(); true`);
      await sleep(3000);
      const off = JSON.parse(await evaluate(`JSON.stringify({ text: ${prompt}?.innerText ?? '', buttons: [...(${prompt}?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()) })`));
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await shot('packs-offline');
      const noise = messages.filter((m) => /^(exception|error)/.test(m) && !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m));
      summary.packs.offline = { ...off, noise };
      check('packs: Get while offline says so in a sentence, keeps the prompt, throws nothing', off.text.length > 20 && off.buttons.some((b) => /Try again|Get/.test(b)) && !noise.length, JSON.stringify({ text: off.text.slice(0, 160), buttons: off.buttons, noise: noise.slice(0, 2) }));
    }

    // The labelled tier in Navigate: a sight typed in AD 1000 is refused, and the form says why.
    if (ONLY.has('tiers')) {
      await open(`${PLACE}&t=2026-09-24T16:00:00Z&view=navigate`);
      const typed = await evaluate(`(() => { const i = document.querySelector('.sfn-entry input[placeholder="yyyy-mm-dd hh:mm:ss"]'); if (!i) return false; i.value = '1000-06-01 20:00:00'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await sleep(800);
      const T = JSON.parse(await evaluate(`JSON.stringify((() => { const f = document.querySelector('.sfn-entry'); const chip = f?.querySelector('.sf-dt-chip'); return { tier: f?.querySelector('.sfn-entry__tier')?.innerText ?? '', blocked: f?.querySelector('button[type=submit]')?.disabled ?? null, chip: chip && !chip.hidden ? chip.textContent.trim() : '' }; })())`));
      await shot('tiers-navigate-1000');
      summary.tiers.navigate = T;
      check('Navigate: a sight typed in AD 1000 is refused, with the reason, the validated years and the chip', typed && T.blocked === true && /No sights for/.test(T.tier) && /1550/.test(T.tier) && /2650/.test(T.tier) && /^±\d+ s$/.test(T.chip), JSON.stringify(T).slice(0, 300));
    }
  } finally {
    writeFileSync(join(OUT, 'verify2-check.json'), JSON.stringify({ results, summary }, null, 1));
    page.close();
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
