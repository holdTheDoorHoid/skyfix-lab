/**
 * The interface's own words, read from the source (polish2, expansion programme): no fixed
 * "1990–2060" (the coverage comes from the engine, CONVENTIONS 15.6), no "(UTC)" or "in
 * UTC" beside a time that may lie outside 1972-2035 (the clock's word is `scaleLabel`), no
 * `Date.UTC` (it reads the years 0-99 as 1900-1999), and no "Deep time pack" (both tiers
 * are in the core since the deeptime merge). Comments, the mock engines and the developer
 * pages are left out: what is checked is what a visitor can read.
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

/** The source without its comments (line and block), strings kept. */
function code(text: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const sources = files(ROOT)
  .map((p) => ({ path: relative(ROOT, p), text: code(readFileSync(p, 'utf8')) }))
  .filter((f) => !SKIP.some((re) => re.test(f.path)));

function offending(re: RegExp): string[] {
  const hits: string[] = [];
  for (const f of sources) {
    f.text.split('\n').forEach((line, n) => {
      if (re.test(line)) hits.push(`${f.path}:${n + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  return hits;
}

describe('the interface’s own words', () => {
  it('reads every view’s source', () => {
    expect(sources.length).toBeGreaterThan(150);
  });

  it('names no fixed coverage years (1990, 2060)', () => {
    expect(offending(/\b(1990|2060)\b/)).toEqual([]);
  });

  it('writes no "(UTC)", "in UTC" or "for UTC" beside a time: the clock’s word comes from scaleLabel', () => {
    expect(offending(/\(UTC[,)]|\bin UTC\b|\bfor UTC\b|hover for UTC/)).toEqual([]);
  });

  it('never uses Date.UTC', () => {
    expect(offending(/Date\.UTC\(/)).toEqual([]);
  });

  it('promises no Deep time pack', () => {
    expect(offending(/Deep time pack|deep-time pack|'deep-time'/)).toEqual([]);
  });
});
