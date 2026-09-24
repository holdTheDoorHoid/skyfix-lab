#!/usr/bin/env node
// Downloads the pinned inputs of the offline basemap and gazetteer into
// tools/mapdata/cache/ (git-ignored) and checks each file against the SHA-256 recorded in
// tools/mapdata/sources.json. Development-time only; the site never downloads anything.
//
//   node tools/mapdata/fetch.mjs            download what is missing, verify everything
//   node tools/mapdata/fetch.mjs --record   (maintainers) re-pin: write the hashes and sizes
//                                           of what was downloaded into sources.json
//
// Then run `node tools/mapdata/build.mjs`. Needs Node 20 or later (global fetch).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(here, 'cache');
const sourcesPath = join(here, 'sources.json');
const record = process.argv.includes('--record');

const sources = JSON.parse(readFileSync(sourcesPath, 'utf8'));
mkdirSync(cacheDir, { recursive: true });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'skyfix-lab-mapdata/1 (build tool)' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const jobs = [];
for (const [name, meta] of Object.entries(sources.natural_earth.files)) {
  jobs.push({ name, url: sources.natural_earth.base_url + name, meta });
}
jobs.push({ name: sources.tzdata.file, url: sources.tzdata.url, meta: sources.tzdata });

let failures = 0;
for (const job of jobs) {
  const path = join(cacheDir, job.name);
  let buf = existsSync(path) ? readFileSync(path) : null;
  if (!buf || (!record && job.meta.sha256 && sha256(buf) !== job.meta.sha256)) {
    process.stdout.write(`download ${job.url} ... `);
    buf = await download(job.url);
    writeFileSync(path, buf);
    console.log(`${buf.length} bytes`);
  }
  const digest = sha256(buf);
  if (record) {
    job.meta.sha256 = digest;
    job.meta.bytes = buf.length;
  } else if (digest !== job.meta.sha256) {
    console.error(`MISMATCH ${job.name}: sha256 ${digest}, expected ${job.meta.sha256}`);
    failures++;
  } else {
    console.log(`ok ${job.name} (${buf.length} bytes)`);
  }
}

if (record) {
  sources.recorded = new Date().toISOString().slice(0, 10);
  writeFileSync(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
  console.log(`recorded ${jobs.length} hashes in ${sourcesPath}`);
}
if (failures) {
  console.error(`${failures} file(s) did not match their pinned hash; not building from them.`);
  process.exit(1);
}
