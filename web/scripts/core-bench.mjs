#!/usr/bin/env node
/**
 * The core's speed budgets in WebAssembly under Node (polish2, expansion programme): the
 * calls the explorer makes every frame or on every visit, timed the way ACCURACY.md's
 * "Speed" tables were (the fastest and the median of many runs, after a warm-up), against
 * the budgets of brief2-common: `sky_state` of every body ≤ 2 ms, the star field (every
 * catalogue star's apparent place, `starfield_apparent`) ≤ 5 ms. Also reported, not
 * judged: the Moon's year of rising and setting bearings and a year of meteor showers at a
 * place (polish list items 2, 3, 52), a day of events and a day of the navigational bodies.
 *
 *   npm run wasm --prefix web && node web/scripts/core-bench.mjs
 *   PKG=/path/to/wasm-pkg node web/scripts/core-bench.mjs     # another build (opt-level "z")
 *   RUNS=200 node web/scripts/core-bench.mjs
 *
 * Development tool only: Node built-ins, no npm dependency. Prints one JSON object; exit
 * status 1 when a budget fails on a machine quiet enough to judge (load average under the
 * number of cores); the budgets are judged on the fastest run (other work only ever adds).
 */

import { existsSync, readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(process.env.PKG ?? join(here, '../src/wasm-pkg'));
const RUNS = Number(process.env.RUNS ?? 100);
const glue = join(PKG, 'skyfix_wasm.js');
const wasm = join(PKG, 'skyfix_wasm_bg.wasm');
if (!existsSync(glue) || !existsSync(wasm)) {
  console.error(`No WebAssembly package in ${PKG}: build it with npm run wasm --prefix web`);
  process.exit(2);
}
const core = await import(pathToFileURL(glue).href);
core.initSync({ module: readFileSync(wasm) });

const PHILLY = JSON.stringify({ lat_deg: 39.9526, lon_deg: -75.1652 });
const TODAY = 2_461_308.1667; // 2026-09-24T16:00Z
const BC585 = 1_507_900.0; // 28 May 585 BC (Julian), the labelled tier
const Y2999 = 2_816_422.5;

/** Fastest and median of `runs` calls after `warm` warm-up calls, ms. */
function time(fn, runs = RUNS, warm = 30) {
  for (let i = 0; i < warm; i++) fn(i);
  const t = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn(i);
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return { fastest: +t[0].toFixed(3), median: +t[Math.floor(t.length / 2)].toFixed(3), p95: +t[Math.floor(0.95 * (t.length - 1))].toFixed(3) };
}

const out = {
  package: PKG,
  bytes: readFileSync(wasm).length,
  load: +loadavg()[0].toFixed(1),
  cores: cpus().length,
  node: process.version,
};
// Each call a minute of sky apart (as the Sky view at an hour a second), so no result is reused.
out.sky_state_all = time((i) => core.sky_state(PHILLY, TODAY + i / 1440, '"all"'));
out.sky_state_all_585bc = time((i) => core.sky_state(PHILLY, BC585 + i / 1440, '"all"'));
out.sky_state_solar_system = time((i) => core.sky_state(PHILLY, TODAY + i / 1440, '"solar_system"'));
out.starfield_apparent = time((i) => core.starfield_apparent(TODAY + i / 24));
out.day_events_all = time((i) => core.day_events(PHILLY, TODAY + i, TODAY + i + 1, '"all"', JSON.stringify({ horizon: 'standard', height_of_eye_m: 0 })), 20, 2);
out.sample_bodies_nav_day = time((i) => core.sample_bodies(PHILLY, '"navigational"', TODAY + i, TODAY + i + 1, 5), 20, 2);
out.moon_rise_set_azimuths_year = time(() => core.rise_set_azimuths(PHILLY, JSON.stringify({ body: 'Moon', year: 2026, utc_offset_hours: -5 })), 5, 1);
out.meteor_showers_year_at_place = time(() => core.meteor_showers(2026, PHILLY, JSON.stringify({ bortle: 5 })), 5, 1);
out.sky_state_all_2999 = time((i) => core.sky_state(PHILLY, Y2999 + i / 1440, '"all"'));

const quiet = out.load < out.cores;
// Judged on the fastest run, as ACCURACY.md's tables are ("best of"): other work on a shared
// machine only ever adds; the median is reported beside it.
out.budgets = {
  judged: quiet,
  sky_state_2ms: out.sky_state_all.fastest <= 2,
  starfield_5ms: out.starfield_apparent.fastest <= 5,
};
console.log(JSON.stringify(out, null, 1));
if (quiet && !(out.budgets.sky_state_2ms && out.budgets.starfield_5ms)) process.exitCode = 1;
