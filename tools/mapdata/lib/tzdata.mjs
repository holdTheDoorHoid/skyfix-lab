// Reads the parts of the IANA time zone database (tzdata, public domain) that the map-data
// build needs: `zone.tab` (which zones each country uses, with the coordinates of each
// zone's principal location) and the `Link` lines (old and alternative zone names).
// Development-time only.

import zlib from 'node:zlib';

/** Minimal reader for a gzipped POSIX ustar archive: returns { name -> Buffer }. */
export function readTarGz(buffer) {
  const tar = zlib.gunzipSync(buffer);
  const files = {};
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (a, b) => header.subarray(a, b).toString('latin1').replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 500);
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = field(156, 157);
    const full = prefix ? `${prefix}/${name}` : name;
    const start = off + 512;
    if (type === '0' || type === '') files[full.replace(/^\.\//, '')] = Buffer.from(tar.subarray(start, start + size));
    off = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** ISO 6709 `+DDMM[SS]+DDDMM[SS]` from zone.tab -> [lat, lon] in degrees. */
export function parseIso6709(s) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/.exec(s);
  if (!m) throw new Error(`bad ISO 6709 coordinate ${s}`);
  const lat = (m[1] === '-' ? -1 : 1) * (+m[2] + +m[3] / 60 + (m[4] ? +m[4] / 3600 : 0));
  const lon = (m[5] === '-' ? -1 : 1) * (+m[6] + +m[7] / 60 + (m[8] ? +m[8] / 3600 : 0));
  return [lat, lon];
}

/** zone.tab -> [{ country, zone, lat, lon, comment }]. */
export function parseZoneTab(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [country, coord, zone, comment = ''] = line.split('\t');
    const [lat, lon] = parseIso6709(coord);
    out.push({ country, zone, lat, lon, comment });
  }
  return out;
}

/** All `Link TARGET NAME` lines -> Map(name -> target). */
export function parseLinks(texts) {
  const links = new Map();
  for (const text of texts)
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*/, '').trim();
      if (!line.startsWith('Link')) continue;
      const [, target, name] = line.split(/\s+/);
      links.set(name, target);
    }
  return links;
}

/** Follow links to the primary zone name. */
export function canonicalZone(zone, links) {
  let z = zone;
  for (let i = 0; i < 10 && links.has(z); i++) z = links.get(z);
  return z;
}

const offsetFormatters = new Map();

/** UTC offset in minutes of `zone` at `ms` (Node's ICU data). */
export function offsetMinutes(zone, ms) {
  let f = offsetFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    offsetFormatters.set(zone, f);
  }
  const o = {};
  for (const p of f.formatToParts(ms)) o[p.type] = p.value;
  const wall = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
  return (wall - Math.floor(ms / 1000) * 1000) / 60000;
}

// "Current rules": the offset on the 1st and 15th of every month of 2025 and 2026. Two
// zones with the same signature show the same clock time today, whatever their history.
const RULE_INSTANTS = [];
for (let y = 2025; y <= 2026; y++) for (let m = 0; m < 12; m++) for (const d of [1, 15]) RULE_INSTANTS.push(Date.UTC(y, m, d, 12));

const signatures = new Map();
export function rulesSignature(zone) {
  let s = signatures.get(zone);
  if (!s) {
    s = RULE_INSTANTS.map((t) => offsetMinutes(zone, t)).join(',');
    signatures.set(zone, s);
  }
  return s;
}
