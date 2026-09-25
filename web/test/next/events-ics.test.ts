/**
 * Calendar files (web/src/next/export/ics.ts; the Events view's `items.ts`): every file the
 * writer makes is read back by a small RFC 5545 parser written here, independently of the
 * writer, which checks the syntax a calendar program relies on: CRLF line ends, lines of at
 * most 75 octets folded without splitting a UTF-8 character, BEGIN/END nesting, the
 * required properties (VERSION and PRODID; UID, DTSTAMP, DTSTART per event), DATE-TIME
 * values in UTC form, DTEND after DTSTART, unique UIDs, TEXT escaping, GEO. Node
 * environment: no DOM.
 */

import { describe, expect, it } from 'vitest';
import type { TimeEngine, TimeInfo } from '../../src/next/engine/types.js';
import {
  canShareIcs,
  foldLine,
  icsCalendar,
  icsDateTime,
  icsDateTimeMs,
  icsEventCount,
  icsExportable,
  icsFileName,
  icsGeo,
  icsText,
  icsUid,
  shareIcs,
  type IcsEvent,
} from '../../src/next/export/ics.js';
import { clockNote, icsEventOf, icsOfItems, type EventItem } from '../../src/next/events/items.js';
import { unescapeText, utf8Octets, validate } from './ics-reader.js';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const JD_UNIX = 2_440_587.5;
const jdOf = (iso: string): number => Date.parse(iso) / 86_400_000 + JD_UNIX;
const NOW = Date.parse('2026-09-25T12:00:00Z');

const tricky = 'Commas, semicolons; a back\\slash, “quotes”, ±12 min, 0° 31′, and a line\nbreak — plus 🌕.';

function event(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: icsUid(['full-moon', '2026-10-26']),
    start: jdOf('2026-10-26T04:12:00Z'),
    summary: 'Full Moon',
    description: 'The Moon is opposite the Sun.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// The writer's values
// ---------------------------------------------------------------------------------------

describe('iCalendar values', () => {
  it('writes UTC DATE-TIMEs rounded to the second', () => {
    expect(icsDateTime(jdOf('2026-10-26T04:12:00Z'))).toBe('20261026T041200Z');
    expect(icsDateTimeMs(Date.parse('2026-10-26T04:12:56.600Z'))).toBe('20261026T041257Z');
    expect(icsDateTimeMs(Date.parse('2026-12-31T23:59:59.600Z'))).toBe('20270101T000000Z');
  });

  it('holds years 1 to 9999 only (the format has four-digit years)', () => {
    const y1 = new Date(0);
    y1.setUTCFullYear(1, 0, 1);
    y1.setUTCHours(0, 0, 0, 0);
    expect(icsDateTimeMs(y1.getTime())).toBe('00010101T000000Z');
    expect(icsDateTimeMs(y1.getTime() - 1000)).toBeNull(); // 1 BC
    const y9999 = new Date(0);
    y9999.setUTCFullYear(9999, 11, 31);
    y9999.setUTCHours(23, 59, 59, 0);
    expect(icsDateTimeMs(y9999.getTime())).toBe('99991231T235959Z');
    expect(icsExportable(jdOf('2026-01-01T00:00:00Z'))).toBe(true);
    expect(icsExportable(1_000_000)).toBe(false); // 1976 BC
    expect(icsDateTime(Number.NaN)).toBeNull();
  });

  it('escapes TEXT values', () => {
    expect(icsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    expect(unescapeText(icsText(tricky))).toBe(tricky);
  });

  it('folds long lines at 75 octets without splitting a character', () => {
    const line = `DESCRIPTION:${'°±′'.repeat(60)}`;
    const folded = foldLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(utf8Octets(p)).toBeLessThanOrEqual(75);
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line);
    // Every part is whole UTF-8: no replacement characters appear after a round trip.
    for (const p of parts) expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(p))).toBe(p);
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  });

  it('writes GEO as latitude;longitude and names UIDs from their parts', () => {
    expect(icsGeo(39.95264, -75.16522)).toBe('39.9526;-75.1652');
    expect(icsGeo(-0.00001, 0)).toBe('0.0000;0.0000');
    expect(icsGeo(91, 0)).toBeNull();
    expect(icsUid(['Occultation', 'Regulus', '2026-10-07'])).toBe('occultation-regulus-2026-10-07@skyfix-lab.events');
    expect(icsUid(['conjunction', 'Moon', "Zuben'ubi", '-0584-05-28'])).toBe('conjunction-moon-zuben-ubi-0584-05-28@skyfix-lab.events');
    expect(icsFileName(['Moon phases', '2026-09-25'])).toBe('skyfix-moon-phases-2026-09-25.ics');
  });
});

// ---------------------------------------------------------------------------------------
// Whole files
// ---------------------------------------------------------------------------------------

describe('calendar files', () => {
  it('pass the parser, and every value reads back as written', () => {
    const events: IcsEvent[] = [
      event(),
      event({
        uid: icsUid(['occultation', 'Regulus', '2026-10-07']),
        start: jdOf('2026-10-07T03:08:17.4Z'),
        end: jdOf('2026-10-07T04:01:02Z'),
        summary: 'The Moon hides Regulus (occultation)',
        description: `${tricky} ${'A long sentence. '.repeat(12)}`,
        location: 'Philadelphia City Hall (39° 57.2′ N, 75° 09.9′ W)',
        geo: { lat_deg: 39.9526, lon_deg: -75.1652 },
        categories: ['SkyFix Lab', 'Moon, occultations'],
      }),
    ];
    const text = icsCalendar({ name: 'SkyFix Lab: Moon; 12 months', now: NOW, events });
    const read = validate(text);
    expect(read.name).toBe('SkyFix Lab: Moon; 12 months');
    expect(read.events).toHaveLength(2);
    const [a, b] = read.events as [(typeof read.events)[0], (typeof read.events)[0]];
    expect(a.summary).toBe('Full Moon');
    expect(a.end).toBeNull(); // an instant has no DTEND
    expect(a.start).toBe(Date.parse('2026-10-26T04:12:00Z'));
    expect(b.start).toBe(Date.parse('2026-10-07T03:08:17Z'));
    expect(b.end).toBe(Date.parse('2026-10-07T04:01:02Z'));
    expect(b.description).toBe(`${tricky} ${'A long sentence. '.repeat(12)}`);
    expect(b.location).toBe('Philadelphia City Hall (39° 57.2′ N, 75° 09.9′ W)');
    expect(b.geo).toBe('39.9526;-75.1652');
    expect(b.categories).toEqual(['SkyFix Lab', 'Moon, occultations']);
    expect(text).toContain('DTSTAMP:20260925T120000Z');
    expect(text).toContain('TRANSP:TRANSPARENT');
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:')).toBe(true);
  });

  it('are the same bytes for the same events and time (stable UIDs, no randomness)', () => {
    const a = icsCalendar({ now: NOW, events: [event()] });
    const b = icsCalendar({ now: NOW, events: [event()] });
    expect(a).toBe(b);
  });

  it('leave out what the format cannot hold, and a UID given twice', () => {
    const events = [
      event(),
      event({ summary: 'duplicate' }),
      event({ uid: icsUid(['eclipse', '-0584-05-28']), start: 1_507_900.9, summary: 'Eclipse of Thales' }),
      event({ uid: icsUid(['same-second']), end: jdOf('2026-10-26T04:12:00.2Z'), summary: 'no length' }),
    ];
    const read = validate(icsCalendar({ now: NOW, events }));
    expect(read.events.map((e) => e.summary)).toEqual(['Full Moon', 'no length']);
    expect(read.events[1]!.end).toBeNull();
    expect(icsEventCount(events)).toBe(2);
  });

  it('with no events is still a valid calendar', () => {
    const read = validate(icsCalendar({ now: NOW, events: [] }));
    expect(read.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Events as calendar entries (items.ts)
// ---------------------------------------------------------------------------------------

function timeEngine(info: Partial<TimeInfo>): TimeEngine & { coverage(): never } {
  const base: TimeInfo = {
    jd_utc: 0,
    utc: '',
    scale: 'utc',
    tier: 'validated',
    delta_t_s: 69,
    delta_t_sigma_s: 0.001,
    delta_t_source: 'iers',
    tt_minus_clock_s: 69.184,
    dut1_s: 0,
    dut1_sigma_s: 0.001,
    dut1_source: 'iers',
    calendar: 'gregorian',
    civil: { calendar: 'gregorian', year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, era_year: 2026, era: 'AD' },
    julian_civil: { calendar: 'julian', year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, era_year: 2026, era: 'AD' },
    notes: [],
  };
  return {
    timeInfo: (jd: number) => ({ ...base, ...info, jd_utc: jd }),
    setDut1: () => undefined,
    calendarConvert: () => {
      throw new Error('unused');
    },
    coverage: () => {
      throw new Error('no coverage');
    },
  };
}

const item: EventItem = {
  id: 'occultation-Regulus-2026-10-07',
  group: 'Moon',
  kind: 'Occultation',
  title: 'The Moon hides Regulus',
  term: 'occultation',
  start: jdOf('2026-10-07T03:08:17Z'),
  end: jdOf('2026-10-07T04:01:02Z'),
  jump: jdOf('2026-10-07T03:08:17Z'),
  body: 'Regulus',
  sentence: 'Regulus disappears at the Moon’s dark edge at 23:08 EDT and reappears at its bright edge at 00:01 EDT.',
  local: true,
  columns: [],
};

describe('events as calendar entries', () => {
  it('carry the plain sentence, the place when named, and a stable UID without the place', () => {
    const engine = timeEngine({}) as unknown as Parameters<typeof icsEventOf>[1]['engine'];
    const withPlace = icsEventOf(item, { engine, place: { label: 'Philadelphia', lat_deg: 39.9526, lon_deg: -75.1652 }, format: 'dm' });
    const without = icsEventOf(item, { engine, place: null, format: 'dm' });
    expect(withPlace.uid).toBe('occultation-regulus-2026-10-07@skyfix-lab.events');
    expect(without.uid).toBe(withPlace.uid);
    expect(withPlace.summary).toBe('The Moon hides Regulus (occultation)');
    expect(withPlace.description).toContain(item.sentence);
    expect(withPlace.description).toMatch(/Times for Philadelphia \(39° 57\.2′ N, 075° 09\.9′ W\)/);
    expect(withPlace.location).toMatch(/^Philadelphia/);
    expect(withPlace.geo).toEqual({ lat_deg: 39.9526, lon_deg: -75.1652 });
    expect(without.description).toContain('not named in this file');
    expect(without.location).toBeUndefined();
    expect(without.geo).toBeNull();
    // The whole file passes the parser.
    const read = validate(icsOfItems([item], 'Occultations', { engine, place: null, format: 'dm' }, NOW));
    expect(read.events[0]!.description).toContain(item.sentence);
  });

  it('say when the clock is UT, and give the Earth-rotation uncertainty when it counts', () => {
    const far = jdOf('2500-06-01T00:00:00Z');
    const engine = timeEngine({ scale: 'ut', tier: 'validated', delta_t_sigma_s: 600 }) as unknown as Parameters<typeof clockNote>[0];
    const note = clockNote(engine, far);
    expect(note).toMatch(/Universal Time \(UT\)/);
    expect(note).toMatch(/±10 min/);
    const near = clockNote(timeEngine({}) as unknown as Parameters<typeof clockNote>[0], jdOf('2026-10-07T03:08:17Z'));
    expect(near).toBe('');
    const labelled = clockNote(timeEngine({ scale: 'ut', tier: 'labelled', delta_t_sigma_s: 3000 }) as unknown as Parameters<typeof clockNote>[0], 1_600_000);
    expect(labelled).toMatch(/±50 min/);
    expect(labelled).toMatch(/estimate/);
  });
});

// ---------------------------------------------------------------------------------------
// Web Share
// ---------------------------------------------------------------------------------------

describe('sharing a calendar file', () => {
  const file = icsCalendar({ now: NOW, events: [event()] });

  it('is offered only where the share sheet takes files', async () => {
    expect(canShareIcs(undefined)).toBe(false);
    const noFiles = { share: async () => undefined, canShare: () => false } as unknown as Navigator;
    expect(canShareIcs(noFiles)).toBe(false);
    expect(await shareIcs(file, 'a.ics', 'SkyFix Lab', noFiles)).toBe('unavailable');
  });

  it('shares, and a closed sheet is not a failure', async () => {
    const shared: ShareData[] = [];
    const ok = { share: async (d: ShareData) => void shared.push(d), canShare: () => true } as unknown as Navigator;
    expect(canShareIcs(ok)).toBe(true);
    expect(await shareIcs(file, 'full-moon.ics', 'SkyFix Lab: Full Moon', ok)).toBe('shared');
    expect(shared[0]!.title).toBe('SkyFix Lab: Full Moon');
    const f = (shared[0]!.files as File[])[0]!;
    expect(f.name).toBe('full-moon.ics');
    expect(f.type).toBe('text/calendar');
    expect(await f.text()).toBe(file);
    const closed = {
      share: async () => {
        throw Object.assign(new Error('closed'), { name: 'AbortError' });
      },
      canShare: () => true,
    } as unknown as Navigator;
    expect(await shareIcs(file, 'a.ics', 'x', closed)).toBe('cancelled');
    const broken = {
      share: async () => {
        throw new Error('NotAllowedError');
      },
      canShare: () => true,
    } as unknown as Navigator;
    expect(await shareIcs(file, 'a.ics', 'x', broken)).toBe('failed');
  });
});

