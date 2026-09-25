/**
 * A small RFC 5545 (iCalendar) reader for the tests, written independently of the writer
 * (web/src/next/export/ics.ts): it checks the syntax calendar programs rely on and reads
 * every value back. Used by events-ics.test.ts and events-real-engine.test.ts.
 */

import { expect } from 'vitest';

// ---------------------------------------------------------------------------------------
// A small RFC 5545 reader (independent of the writer)
// ---------------------------------------------------------------------------------------

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface Component {
  name: string;
  props: Prop[];
  children: Component[];
}

const DATE_TIME_UTC = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

export function utf8Octets(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Parse a calendar file strictly; throws a sentence naming the first fault. */
export function parseIcs(text: string): Component {
  if (!text.endsWith('\r\n')) throw new Error('the file does not end with CRLF');
  if (/[^\r]\n/.test(text) || /\r[^\n]/.test(text)) throw new Error('a line ends with a bare LF or CR');
  const physical = text.slice(0, -2).split('\r\n');
  for (const [i, line] of physical.entries()) {
    if (utf8Octets(line) > 75) throw new Error(`line ${i + 1} is ${utf8Octets(line)} octets long`);
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(line)) throw new Error(`line ${i + 1} holds a control character`);
  }
  // Unfold: a line starting with a space or a tab continues the one before (3.1).
  const logical: string[] = [];
  for (const line of physical) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (!logical.length) throw new Error('the file starts with a continuation line');
      logical[logical.length - 1] += line.slice(1);
    } else logical.push(line);
  }
  const stack: Component[] = [];
  let root: Component | null = null;
  for (const line of logical) {
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`not a content line: ${line}`);
    const [nameAndParams, value] = [line.slice(0, colon), line.slice(colon + 1)];
    const [name, ...rawParams] = nameAndParams.split(';');
    if (!/^[A-Z][A-Z0-9-]*$/.test(name!)) throw new Error(`bad property name ${name}`);
    const params: Record<string, string> = {};
    for (const p of rawParams) {
      const eq = p.indexOf('=');
      if (eq < 1) throw new Error(`bad parameter ${p}`);
      params[p.slice(0, eq)] = p.slice(eq + 1);
    }
    if (name === 'BEGIN') {
      const c: Component = { name: value, props: [], children: [] };
      if (stack.length) stack[stack.length - 1]!.children.push(c);
      else if (root) throw new Error('two top-level components');
      else root = c;
      stack.push(c);
    } else if (name === 'END') {
      const c = stack.pop();
      if (!c || c.name !== value) throw new Error(`END:${value} does not close ${c?.name ?? 'anything'}`);
    } else {
      if (!stack.length) throw new Error(`property ${name} outside any component`);
      stack[stack.length - 1]!.props.push({ name: name!, params, value });
    }
  }
  if (stack.length) throw new Error(`${stack[stack.length - 1]!.name} is not closed`);
  if (!root) throw new Error('no component');
  return root;
}

function prop(c: Component, name: string): Prop | undefined {
  return c.props.find((p) => p.name === name);
}

function props(c: Component, name: string): Prop[] {
  return c.props.filter((p) => p.name === name);
}

/** TEXT unescaping (3.3.11). */
export function unescapeText(v: string): string {
  let out = '';
  for (let i = 0; i < v.length; i += 1) {
    const ch = v[i]!;
    if (ch !== '\\') {
      if (ch === ',' || ch === ';') throw new Error(`an unescaped "${ch}" in a TEXT value: ${v}`);
      out += ch;
      continue;
    }
    const next = v[i + 1];
    i += 1;
    if (next === 'n' || next === 'N') out += '\n';
    else if (next === '\\' || next === ',' || next === ';') out += next;
    else throw new Error(`a bad escape \\${next ?? ''} in ${v}`);
  }
  return out;
}

export function dateTimeMs(v: string): number {
  const m = DATE_TIME_UTC.exec(v);
  if (!m) throw new Error(`not a UTC DATE-TIME: ${v}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59 || s > 60) throw new Error(`an impossible DATE-TIME: ${v}`);
  return date.getTime();
}

/** Everything a calendar program needs, checked; the events returned with their values read back. */
export function validate(text: string): { name: string | null; events: { uid: string; start: number; end: number | null; summary: string; description: string | null; location: string | null; geo: string | null; categories: string[] }[] } {
  const cal = parseIcs(text);
  expect(cal.name).toBe('VCALENDAR');
  expect(prop(cal, 'VERSION')?.value).toBe('2.0');
  expect(prop(cal, 'PRODID')?.value).toBeTruthy();
  for (const c of cal.children) expect(c.name).toBe('VEVENT');
  const uids = new Set<string>();
  const events = cal.children.map((ev) => {
    for (const required of ['UID', 'DTSTAMP', 'DTSTART']) {
      expect(props(ev, required), `${required} once per event`).toHaveLength(1);
    }
    for (const once of ['DTEND', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'GEO', 'TRANSP']) expect(props(ev, once).length).toBeLessThanOrEqual(1);
    const uid = prop(ev, 'UID')!.value;
    expect(uids.has(uid), `UID ${uid} used twice`).toBe(false);
    uids.add(uid);
    dateTimeMs(prop(ev, 'DTSTAMP')!.value);
    const start = dateTimeMs(prop(ev, 'DTSTART')!.value);
    const endProp = prop(ev, 'DTEND');
    const end = endProp ? dateTimeMs(endProp.value) : null;
    if (end !== null) expect(end, 'DTEND after DTSTART').toBeGreaterThan(start);
    const geo = prop(ev, 'GEO')?.value ?? null;
    if (geo !== null) {
      const m = /^(-?\d+(?:\.\d+)?);(-?\d+(?:\.\d+)?)$/.exec(geo);
      expect(m, `GEO ${geo}`).not.toBeNull();
      expect(Math.abs(Number(m![1]))).toBeLessThanOrEqual(90);
      expect(Math.abs(Number(m![2]))).toBeLessThanOrEqual(180);
    }
    const categories = prop(ev, 'CATEGORIES')?.value ?? '';
    return {
      uid,
      start,
      end,
      summary: unescapeText(prop(ev, 'SUMMARY')?.value ?? ''),
      description: prop(ev, 'DESCRIPTION') ? unescapeText(prop(ev, 'DESCRIPTION')!.value) : null,
      location: prop(ev, 'LOCATION') ? unescapeText(prop(ev, 'LOCATION')!.value) : null,
      geo,
      // Categories are a comma-separated list of TEXT values: split on unescaped commas.
      categories: categories ? categories.split(/(?<!\\),/).map(unescapeText) : [],
    };
  });
  const nameProp = prop(cal, 'X-WR-CALNAME');
  return { name: nameProp ? unescapeText(nameProp.value) : null, events };
}
