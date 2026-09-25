#!/usr/bin/env node
/**
 * Screenshots of the Sky view for review, written to docs/design/local/sky-<case>.png
 * (git-ignored working screenshots). Three curated ones are committed in docs/design/:
 * night-philadelphia-dome, twilight-panorama and southern-dome-dark — copy them up when
 * they are worth replacing. Development tool only (Node built-ins and a local Chrome;
 * not part of the site). OWNER: sky agent.
 *
 *   npx vite --port 5192 --strictPort            # in web/, in another terminal
 *   node src/next/sky/dev/screenshots.mjs         # every case
 *   node src/next/sky/dev/screenshots.mjs twilight-panorama day-dome
 *
 * Chrome's virtual time is enough here: the Sky view draws on animation frames with no
 * workers. Environment: BASE (default http://localhost:5192), CHROME (google-chrome),
 * OUT (default docs/design/local at the repository root).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:5192';
const CHROME = process.env.CHROME ?? 'google-chrome';
const OUT = resolve(process.env.OUT ?? join(here, '../../../../../docs/design/local'));

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
  // sky2 agent (expansion Q3): the astronomy layers.
  // 22:00 EDT: the Milky Way across the dome, deep-sky objects labelled, the Southern Taurids' radiant.
  'dso-milkyway-dome-dark': ['t=2026-09-25T02:00:00Z&theme=dark', DESKTOP],
  // M31 found and zoomed four times, a 10×50 binocular field round it, its card open.
  'zoom-m31-binoculars': ['t=2026-09-25T02:00:00Z&theme=dark&zoom=4&show=deep_sky:M31&fov=bino10x50', DESKTOP],
  // The Moon up close, as seen from Philadelphia, features along the shadow line.
  'moon-inset-light': ['t=2026-09-25T02:00:00Z&theme=light&upclose=Moon', DESKTOP],
  // Jupiter's moons before dawn, north up.
  'jupiter-inset-dark': ['t=2026-09-25T09:00:00Z&theme=dark&upclose=Jupiter&orient=north', DESKTOP],
  // Saturn's rings to scale.
  'saturn-inset-dark': ['t=2026-09-25T02:00:00Z&theme=dark&upclose=Saturn&orient=north', DESKTOP],
  // Night vision: the Milky Way, deep sky and the Moon's close-up, all red.
  'night-theme-moon': ['t=2026-09-25T02:00:00Z&theme=night&upclose=Moon', DESKTOP],
  // A Bortle 7 sky: the Milky Way gone, only the brightest deep-sky objects.
  'bortle7-dome': ['t=2026-09-25T02:00:00Z&theme=dark&bortle=7', DESKTOP],
  // The Perseids' radiant at their peak, 04:00 EDT on 13 August 2026.
  'perseids-panorama': ['t=2026-08-13T08:00:00Z&theme=dark&mode=panorama&az=40&fov=120', DESKTOP],
  // A phone at night with a deep-sky card open.
  'phone-card-dark': ['t=2026-09-25T02:00:00Z&theme=dark&show=deep_sky:M45', PHONE],
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
      `--virtual-time-budget=${process.env.VT ?? 8000}`,
      `--screenshot=${file}`,
      url,
    ],
    { encoding: 'utf8', timeout: 300_000 },
  );
  const ok = /bytes written/.test(`${run.stdout}${run.stderr}`);
  console.log(`${ok ? 'ok ' : 'FAILED'} sky-${name}.png`);
}
