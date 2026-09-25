/**
 * verify2: nothing on screen credits anything but OpenStreetMap (EXPANSION_PLAN, "Data
 * credit"; brief: "nothing on screen credits anything but OpenStreetMap"). The expansion had
 * put "Source: Minor Planet Center", a deep-sky "Source" section, "Shower table: …", the
 * gazetteer's line under the Moon close-up and the Bright Star Catalogue in the saved
 * picture's caption on screen; "Map data: Natural Earth" and About's credits line were older.
 * Read from the source without comments (as polish-strings.test.ts reads it); the engine
 * adapters, mocks and developer pages are left out. The data's provenance is THIRD_PARTY.md's.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../src/next');
const SKIP = [/^engine\//, /\/dev\//, /^mockup\//, /^harness\//, /\.test\.ts$/];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** The source without its comments, strings kept. */
function code(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out;
}

const CREDITS = [
  /Source: /,
  /Map data/,
  /Yale Bright Star Catalogue/,
  /Shower table/,
  /Gazetteer of Planetary Nomenclature/,
  /HEASARC/,
  // (the MPC's one-line formats may be named, as the paste box's hint does: not a credit)
  /Minor Planet Center\b(?! \(MPCORB| lines|, or JSON)/,
  /\bSIMBAD\b/,
  /Wikidata/,
  /Natural Earth/,
  /Open Font License/,
];

describe('on-screen credits (verify2)', () => {
  it('names no data source on screen but OpenStreetMap', () => {
    const hits: string[] = [];
    for (const file of files(ROOT)) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (SKIP.some((re) => re.test(rel))) continue;
      const lines = code(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const re of CREDITS) if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
