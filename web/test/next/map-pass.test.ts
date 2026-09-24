/**
 * The compass dial's pass (web/src/next/map/pass.ts): the same rise, highest point and set
 * as the panel's cards, with the weekday on a time outside the day shown, and a sampling
 * window that starts on a whole hour and runs past the set.
 */
import { describe, expect, it } from 'vitest';
import type { SkyEvent } from '../../src/next/engine/types.js';
import { dialEvents, eventWords, passNote, passWindow, PATH_STEP_MIN } from '../../src/next/map/pass.js';
import { passageAround } from '../../src/next/shell/sky.js';
import { jdFromIso, wallClock, type Zone } from '../../src/next/time.js';

const NEW_YORK: Zone = { kind: 'iana', zone: 'America/New_York' };
// Local midnight, Thursday 24 September 2026, in New York (EDT, UTC-4).
const DAY0 = jdFromIso('2026-09-24T04:00:00Z')!;
const at = (h: number): number => DAY0 + h / 24;
const ev = (kind: SkyEvent['kind'], h: number, az = 0, alt = 0): SkyEvent => ({ kind, jd_utc: at(h), utc: '', alt_deg: alt, az_deg: az });
// From the day before to the day after, as `aroundToday` asks for them: moonrise 17:06 and
// highest 23:12 on Wednesday, moonset 04:31 today, moonrise 17:55, highest 23:40, moonset
// 05:37 tomorrow (Friday).
const MOON = [
  ev('rise', -6.9, 97),
  ev('transit', -0.8, 180, 33),
  ev('set', 4.52, 262),
  ev('rise', 17.92, 99),
  ev('transit', 23.67, 180, 35),
  ev('set', 29.62, 265),
  ev('rise', 42.3, 91),
];
const DAY: [number, number] = [at(0), at(24)];

describe('the dial’s pass', () => {
  it('shows the pass the panel shows, with Friday’s moonset marked', () => {
    const passage = passageAround(MOON, at(12), false);
    const events = dialEvents('Moon', passage, at(12), NEW_YORK);
    expect(events.map((e) => e.label)).toEqual(['Moonrise 17:55', 'Highest 23:40', 'Moonset 05:37 Fri']);
    expect(events.map((e) => e.time)).toEqual(['17:55', '23:40', '05:37 Fri']);
    expect(events.find((e) => e.kind === 'set')!.az).toBe(265);
  });

  it('keeps last night’s pass until the Moon has set this morning', () => {
    const passage = passageAround(MOON, at(2), true);
    const labels = dialEvents('Moon', passage, at(2), NEW_YORK).map((e) => e.label);
    expect(labels).toEqual(['Moonrise 17:06 Wed', 'Highest 23:12 Wed', 'Moonset 04:31']);
  });

  it('samples from a whole hour before the rise to a step past the set', () => {
    const passage = passageAround(MOON, at(12), false);
    const [a, b] = passWindow(passage, DAY, NEW_YORK);
    const w = wallClock(a, NEW_YORK);
    expect([w.hour, w.minute, w.second]).toEqual([17, 0, 0]);
    expect(a).toBeLessThanOrEqual(at(17.92));
    expect(b).toBeCloseTo(at(29.62) + PATH_STEP_MIN / 1440, 9);
  });

  it('draws the local day for a body up or down all through', () => {
    const up = passageAround([ev('transit', 12)], at(3), true);
    expect(passWindow(up, DAY, NEW_YORK)).toEqual(DAY);
    expect(passNote('Sun', up)).toBe('Sun up all day');
    expect(passNote('Sun', passageAround([], at(3), false))).toBe('Sun down all day');
    expect(passNote('Moon', passageAround(MOON, at(12), false))).toBe('');
  });

  it('names the events', () => {
    expect(eventWords('Sun', 'rise')).toBe('Sunrise');
    expect(eventWords('Moon', 'set')).toBe('Moonset');
    expect(eventWords('Venus', 'rise')).toBe('Venus rises');
    expect(eventWords('Venus', 'transit')).toBe('Highest');
  });
});
