#!/usr/bin/env node
/**
 * Screenshots of the Sky view for review, written to docs/design/sky-<case>.png.
 * Development tool only (Node built-ins and a local Chrome; not part of the site).
 * OWNER: sky agent.
 *
 *   npx vite --port 5192 --strictPort            # in web/, in another terminal
 *   node src/next/sky/dev/screenshots.mjs         # every case
 *   node src/next/sky/dev/screenshots.mjs twilight-panorama day-dome
 *
 * Chrome's virtual time is enough here: the Sky view draws on animation frames with no
 * workers. Environment: BASE (default http://localhost:5192), CHROME (google-chrome),
 * OUT (default docs/design at the repository root).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:5192';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(here, '../../../../../docs/design'));

const DESKTOP = [1440, 900, 1];
const PHONE = [390, 844, 2];

/** case -> [query, [width, height, scale]]. Times are UTC; Philadelphia is UTC−4 in September. */
const CASES = {
  // 22:00 EDT, a clear night from Philadelphia: the whole sky, north up.
  'night-philadelphia-dome': ['t=2026-09-25T02:00:00Z&theme=light', DESKTOP],
  // 19:35 EDT, nautical twilight, looking west-south-west: Venus and Mercury low in the glow.
  'twilight-panorama': ['t=2026-09-24T23:35:00Z&mode=panorama&az=250&select=Moon', DESKTOP],
  // 13:00 EDT: a day sky; the Sun's path, the planets, constellations as a ghost overlay.
  'day-dome': ['t=2026-09-24T17:00:00Z', DESKTOP],
  // Daytime panorama toward the south in the dark theme.
  'day-panorama-dark': ['t=2026-09-24T17:00:00Z&theme=dark&mode=panorama&az=180', DESKTOP],
  // Sydney, 21:00 AEST, south up, dark theme: Crux, Centaurus, Canopus.
  'southern-dome-dark': ['place=sydney&t=2026-09-24T11:00:00Z&theme=dark&south=1', DESKTOP],
  // Red night vision, dome and panorama.
  'night-theme-dome': ['t=2026-09-25T02:00:00Z&theme=night', DESKTOP],
  'night-theme-panorama': ['t=2026-09-25T02:00:00Z&theme=night&mode=panorama&az=160', DESKTOP],
  // A four-day crescent near Antares, 19:15 EDT, zoomed in: lit toward the set Sun.
  'crescent-moon-panorama': ['t=2026-10-14T23:15:00Z&mode=panorama&az=225&fov=60&bottom=-4', DESKTOP],
  // Sydney, the same crescent lit from below.
  'crescent-sydney-dark': ['place=sydney&t=2026-10-14T08:30:00Z&theme=dark&mode=panorama&az=258&fov=60&bottom=12', DESKTOP],
  // Selection, highlights (the "tonight's star sights" hook) and a hover card.
  'selection-highlights': ['t=2026-09-25T01:00:00Z&select=Vega&highlight=Arcturus,Altair,Saturn,Deneb&tip=Altair', DESKTOP],
  // Every layer: grid, meridian, equator, ecliptic, boundaries.
  'all-layers-dark': ['t=2026-09-25T02:00:00Z&theme=dark&stress=1', DESKTOP],
  // Phones.
  'phone-dome-night': ['t=2026-09-25T01:00:00Z&theme=night', PHONE],
  'phone-panorama': ['t=2026-09-24T23:35:00Z&mode=panorama&az=250', PHONE],
};

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const [name, [query, [w, h, scale]]] of Object.entries(CASES)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const file = join(OUT, `sky-${name}.png`);
  const url = `${BASE}/next/dev-sky.html?${query}&bare=1`;
  const run = spawnSync(
    CHROME,
    [
      '--headless=new',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      `--window-size=${w},${h}`,
      `--force-device-scale-factor=${scale}`,
      '--virtual-time-budget=8000',
      `--screenshot=${file}`,
      url,
    ],
    { encoding: 'utf8', timeout: 300_000 },
  );
  const ok = /bytes written/.test(`${run.stdout}${run.stderr}`);
  console.log(`${ok ? 'ok ' : 'FAILED'} sky-${name}.png`);
}
