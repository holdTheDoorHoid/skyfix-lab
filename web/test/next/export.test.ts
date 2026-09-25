/**
 * Saving charts (charts2 agent, expansion programme Q5): CSV files made from the Table
 * views (web/src/next/export/csv.ts), the pure parts of pictures (export/png.ts: font
 * subsets, the caption strip, Web Share), the Save menu's file header, printing's page
 * orientation, and the settle helper that keeps heavy chart work off the frames of a drag.
 * Node environment: tables are plain stand-ins shaped like HTMLTableElement.
 */
import { describe, expect, it } from 'vitest';
import {
  cellText,
  cellValue,
  csvField,
  fileName,
  fileSlug,
  rowsToCsv,
  tableRows,
  tablesToCsv,
  type CellLike,
  type TableLike,
} from '../../src/next/export/csv.js';
import {
  base64,
  canShareFiles,
  captionHeight,
  CAPTION_TYPE,
  codePointsOf,
  layoutCaption,
  parseUnicodeRange,
  rangeCovers,
  shareFile,
} from '../../src/next/export/png.js';
import { csvComments } from '../../src/next/charts/export-menu.js';
import { wantsLandscape } from '../../src/next/charts/print.js';
import { settler } from '../../src/next/charts/settle.js';
import { FakeTimers } from './helpers.js';

function cell(text: string, attrs: Record<string, string> = {}, inner?: Record<string, string>, colSpan = 1): CellLike {
  return {
    textContent: text,
    colSpan,
    getAttribute: (name) => attrs[name] ?? null,
    querySelector: (selector) => (inner && selector === '[data-csv]' ? { getAttribute: (n: string) => inner[n] ?? null } : null),
  };
}

function tableOf(caption: string, rows: CellLike[][]): TableLike {
  return { caption: { textContent: caption }, rows: rows.map((cells) => ({ cells })) };
}

describe('CSV', () => {
  it('quotes a field only when it must (RFC 4180)', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField(' edge')).toBe('" edge"');
    expect(csvField(3.25)).toBe('3.25');
    expect(csvField(Number.NaN)).toBe('');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('writes numbers a spreadsheet reads: ASCII minus, ordinary spaces', () => {
    expect(cellText('−0.31 m')).toBe('-0.31 m');
    expect(cellText('2 448 kWh')).toBe('2 448 kWh');
    expect(cellText('  06:52 \n EDT ')).toBe('06:52 EDT');
  });

  it('prefers a cell’s data-csv value, its own or an inner element’s, to its text', () => {
    expect(cellValue(cell('42° 18′', { 'data-csv': '42.300' }))).toBe('42.300');
    expect(cellValue(cell('06:52', {}, { 'data-csv': '−1.5' }))).toBe('-1.5');
    expect(cellValue(cell('Waxing gibbous'))).toBe('Waxing gibbous');
  });

  it('reads a table: header first, month headings left out, spans filled', () => {
    const t = tableOf('The Sun', [
      [cell('Date'), cell('Height'), cell('Bearing')],
      [cell('September 2026', { scope: 'rowgroup' }, undefined, 3)],
      [cell('Thu 24 Sep 2026'), cell('42° 18′', { 'data-csv': '42.300' }), cell('221° SW', { 'data-csv': '221.00' })],
      [cell('Totals', {}, undefined, 2), cell('x')],
    ]);
    expect(tableRows(t)).toEqual([
      ['Date', 'Height', 'Bearing'],
      ['Thu 24 Sep 2026', '42.300', '221.00'],
      ['Totals', '', 'x'],
    ]);
  });

  it('writes several tables in one file, each named, after the header lines', () => {
    const a = tableOf('High and low water', [[cell('Time'), cell('Height (m)')], [cell('04:26'), cell('0.10 m', { 'data-csv': '0.100' })]]);
    const b = tableOf('Hourly', [[cell('Time'), cell('Height (m)')], [cell('00:00'), cell('1.35 m', { 'data-csv': '1.350' })]]);
    const text = tablesToCsv([a, b], ['SkyFix Lab: Tides', 'Predicted, not observed.']);
    expect(text.startsWith('﻿')).toBe(true);
    const lines = text.slice(1).split('\r\n');
    expect(lines).toEqual([
      '# SkyFix Lab: Tides',
      '# Predicted, not observed.',
      '# High and low water',
      'Time,Height (m)',
      '04:26,0.100',
      '',
      '# Hourly',
      'Time,Height (m)',
      '00:00,1.350',
      '',
    ]);
    expect(tablesToCsv([a], [], { bom: false }).startsWith('Time,')).toBe(true);
  });

  it('rows to CSV with CRLF line ends and a byte-order mark', () => {
    expect(rowsToCsv([['a', 1], ['b,c', null]], { comments: ['x'] })).toBe('﻿# x\r\na,1\r\n"b,c",\r\n');
  });

  it('names files safely: lower case, dashes, no accents', () => {
    expect(fileSlug('Tromsø: Sun path, 21 Jun')).toBe('troms-sun-path-21-jun');
    expect(fileSlug('Équation du temps')).toBe('equation-du-temps');
    expect(fileName(['sun-path', '2026-09-24'], 'png')).toBe('skyfix-sun-path-2026-09-24.png');
    expect(fileName(['tides', '9414290', null, '', 'week'], '.csv')).toBe('skyfix-tides-9414290-week.csv');
  });
});

describe('pictures', () => {
  it('reads CSS unicode ranges, wildcards included', () => {
    expect(parseUnicodeRange('U+0000-00FF,U+0131, U+2212')).toEqual([
      [0, 255],
      [0x131, 0x131],
      [0x2212, 0x2212],
    ]);
    expect(parseUnicodeRange('U+04??')).toEqual([[0x400, 0x4ff]]);
    expect(parseUnicodeRange('nonsense')).toEqual([]);
  });

  it('embeds only the font subsets the picture’s text needs', () => {
    const latin = parseUnicodeRange('U+0000-00FF,U+2212');
    const cyrillic = parseUnicodeRange('U+0400-045F');
    const used = codePointsOf('Sunrise 06:52 −4°');
    expect(rangeCovers(latin, used)).toBe(true);
    expect(rangeCovers(cyrillic, used)).toBe(false);
    expect(rangeCovers([], used)).toBe(true);
  });

  it('wraps the caption by words and measures its height', () => {
    const measure = (text: string): number => text.length * 7;
    const lines = layoutCaption({ title: 'The Sun’s path across the sky', lines: ['one two three four five six seven eight nine ten'], footer: 'SkyFix Lab' }, 140, measure);
    expect(lines[0]).toEqual({ text: 'The Sun’s path', role: 'title' });
    expect(lines.every((l) => measure(l.text) <= 140 || !l.text.includes(' '))).toBe(true);
    expect(lines.filter((l) => l.role === 'line').map((l) => l.text).join(' ')).toBe('one two three four five six seven eight nine ten');
    expect(lines.at(-1)).toEqual({ text: 'SkyFix Lab', role: 'footer' });
    const lineCount = lines.filter((l) => l.role === 'line').length;
    const titleCount = lines.filter((l) => l.role === 'title').length;
    expect(captionHeight(lines)).toBe(
      titleCount * CAPTION_TYPE.title.lineHeight + lineCount * CAPTION_TYPE.line.lineHeight + CAPTION_TYPE.footer.lineHeight + 6,
    );
  });

  it('base64 of large byte arrays matches Node’s', () => {
    const bytes = new Uint8Array(100_003);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7919) & 255;
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('shares a picture where the device can, and says so where it cannot', async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const shared: ShareData[] = [];
    const nav = { share: async (d: ShareData) => void shared.push(d), canShare: () => true } as unknown as Navigator;
    expect(canShareFiles(nav)).toBe(true);
    expect(await shareFile(blob, 'x.png', 'Sun path', nav)).toBe('shared');
    expect(shared[0]?.title).toBe('Sun path');
    expect((shared[0]?.files ?? [])[0]?.name).toBe('x.png');
    const closed = { share: async () => Promise.reject(Object.assign(new Error('closed'), { name: 'AbortError' })), canShare: () => true } as unknown as Navigator;
    expect(await shareFile(blob, 'x.png', 'Sun path', closed)).toBe('cancelled');
    const refuses = { share: async () => undefined, canShare: () => false } as unknown as Navigator;
    expect(canShareFiles(refuses)).toBe(false);
    expect(await shareFile(blob, 'x.png', 'Sun path', refuses)).toBe('unsupported');
    expect(canShareFiles({} as Navigator)).toBe(false);
    expect(await shareFile(blob, 'x.png', 'Sun path', {} as Navigator)).toBe('unsupported');
  });
});

describe('the Save menu and printing', () => {
  it('a CSV file starts with what the numbers are and where they came from', () => {
    const lines = csvComments('Tides · San Francisco', 'Thursday 24 September 2026', 'High water 11:12.', ['Predicted, not observed.']);
    expect(lines[0]).toBe('SkyFix Lab: Tides · San Francisco');
    expect(lines).toContain('Predicted, not observed.');
    expect(lines.at(-1)).toMatch(/not a navigation instrument/);
    expect(csvComments('T', '', '', [])).toHaveLength(2);
  });

  it('prints wide charts across the page', () => {
    expect(wantsLandscape(1400, 500)).toBe(true);
    expect(wantsLandscape(640, 700)).toBe(false);
    expect(wantsLandscape(100, 0)).toBe(false);
  });
});

describe('heavy work waits for the time to settle', () => {
  function make(options: { settleMs?: number; maxWaitMs?: number } = {}) {
    const timers = new FakeTimers();
    const s = settler({ ...options, setTimer: (fn, ms) => timers.set(fn, ms), clearTimer: (id) => timers.clear(id as number), now: () => timers.now });
    return { timers, s };
  }

  it('runs the first request at once, off the frame', () => {
    const { timers, s } = make();
    const ran: number[] = [];
    s.request(() => ran.push(1));
    expect(ran).toEqual([]);
    expect(s.pending()).toBe(true);
    timers.advance(0);
    expect(ran).toEqual([1]);
    expect(s.pending()).toBe(false);
  });

  it('then runs only the latest of a burst, once the requests stop', () => {
    const { timers, s } = make({ settleMs: 160, maxWaitMs: 700 });
    const ran: number[] = [];
    s.request(() => ran.push(0));
    timers.advance(0);
    for (let k = 1; k <= 5; k += 1) {
      s.request(() => ran.push(k));
      timers.advance(50);
    }
    expect(ran).toEqual([0]);
    timers.advance(200);
    expect(ran).toEqual([0, 5]);
  });

  it('never waits longer than maxWaitMs while requests keep coming', () => {
    const { timers, s } = make({ settleMs: 160, maxWaitMs: 700 });
    const ran: number[] = [];
    s.request(() => ran.push(-1));
    timers.advance(0);
    for (let k = 0; k < 40; k += 1) {
      s.request(() => ran.push(k));
      timers.advance(40);
    }
    // 1.6 s of requests every 40 ms: at least two runs in between, the last one pending.
    expect(ran.length).toBeGreaterThanOrEqual(3);
    timers.advance(1000);
    expect(ran.at(-1)).toBe(39);
  });

  it('forgets a request on cancel', () => {
    const { timers, s } = make();
    const ran: number[] = [];
    s.request(() => ran.push(1));
    s.cancel();
    timers.advance(1000);
    expect(ran).toEqual([]);
    expect(s.pending()).toBe(false);
  });
});
