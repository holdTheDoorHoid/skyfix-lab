#!/usr/bin/env node
/**
 * Writes the table of one-degree cells that hold a NOAA tide station (TIDE_CELLS in
 * ../tide-cells.ts) from the committed `tides-us` pack, so the Tonight view can tell, without
 * the pack, whether a place might have a station within 100 NM and so whether to offer it.
 * Development tool only (Node built-ins). OWNER: tonight agent.
 *
 *   node src/next/tonight/dev/tide-cells.mjs          # in web/, after the pack changes
 *
 * test/next/tonight-tides.test.ts fails when the table and the committed pack disagree.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKS = resolve(here, '../../../../public/data/packs');
const TARGET = resolve(here, '../tide-cells.ts');

/** Station positions (degrees) from a `tides-us` pack file (EXPLORER_API "The tides-us pack"). */
export function stationPositions(file) {
  const buf = readFileSync(file);
  let p = 8 + 2;
  const nameLen = buf.readUInt16LE(p);
  p += 2 + nameLen;
  const payloadLen = buf.readUInt32LE(p);
  p += 4;
  const pay = buf.subarray(p, p + payloadLen);
  let q = 4 + 2;
  const str8 = () => {
    const n = pay[q];
    q += 1;
    const s = pay.toString('utf8', q, q + n);
    q += n;
    return s;
  };
  const version = str8();
  const k = pay[q];
  q += 1;
  for (let i = 0; i < k; i += 1) str8();
  const b = pay[q];
  q += 1;
  const count = pay.readUInt32LE(q);
  q += 4;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const id = str8();
    str8();
    str8();
    const lat = pay.readInt32LE(q) / 1e6;
    const lon = pay.readInt32LE(q + 4) / 1e6;
    const kind = pay[q + 8];
    q += 10;
    if (kind === 0) {
      q += 16;
      const bytes = Math.ceil(b / 8);
      let bits = 0;
      for (let j = 0; j < b; j += 1) if (pay[q + (j >> 3)] & (1 << (j & 7))) bits += 1;
      q += bytes + bits * 4;
      const extended = pay[q];
      q += 1 + extended * 5;
    } else {
      q += 2 + 4 + 1 + 4;
    }
    out.push({ id, lat, lon });
  }
  if (q !== pay.length) throw new Error(`${file}: ${pay.length - q} bytes left after the stations`);
  return { version, stations: out };
}

/** The sorted cell numbers `(floor(lat) + 90) * 360 + (floor(lon) + 180)`. */
export function cellsOf(stations) {
  const set = new Set();
  for (const s of stations) set.add((Math.floor(s.lat) + 90) * 360 + (((Math.floor(s.lon) + 180) % 360) + 360) % 360);
  return [...set].sort((a, b) => a - b);
}

/** Deltas in base 36, comma-separated. */
export function encodeCells(cells) {
  let prev = 0;
  return cells.map((c) => { const d = c - prev; prev = c; return d.toString(36); }).join(',');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = readdirSync(PACKS).find((f) => /^tides-us-[0-9a-f]{16}\.bin$/.test(f));
  if (!file) throw new Error(`no tides-us pack in ${PACKS}`);
  const { version, stations } = stationPositions(join(PACKS, file));
  const cells = cellsOf(stations);
  const text = readFileSync(TARGET, 'utf8');
  const block = `// generated: begin (dev/tide-cells.mjs from ${file}, NOAA data of ${version}: ${stations.length} stations, ${cells.length} cells)\nexport const TIDE_CELLS = '${encodeCells(cells)}';\nexport const TIDE_CELLS_FROM = '${file}';\n// generated: end`;
  const next = text.replace(/\/\/ generated: begin[\s\S]*?\/\/ generated: end/, block);
  if (next === text && !text.includes(block)) throw new Error('no generated block in tide-cells.ts');
  writeFileSync(TARGET, next);
  console.log(`${cells.length} cells from ${stations.length} stations (${file})`);
}
