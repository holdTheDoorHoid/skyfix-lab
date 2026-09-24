/**
 * The Selected card's SunCalc-style tools (web/src/next/panel/sun-tools.ts): the shadow of
 * an object of a chosen height, and reading the height typed for "When is it at…?".
 */
import { describe, expect, it } from 'vitest';
import { FIND_ALT_MAX, FIND_ALT_MIN, parseAltitude, shadowOf } from '../../src/next/panel/sun-tools.js';

describe('the shadow of an object', () => {
  it('is height / tan(altitude)', () => {
    const s = shadowOf(1, 45);
    expect(s.kind).toBe('length');
    expect(s.kind === 'length' && s.m).toBeCloseTo(1, 12);
    const t = shadowOf(2, 30);
    expect(t.kind === 'length' && t.m).toBeCloseTo(2 * Math.sqrt(3), 12);
    const noon = shadowOf(1.8, 89.9);
    expect(noon.kind === 'length' && noon.m).toBeLessThan(0.01);
  });

  it('says there is none with the Sun down, and too long to give with it on the horizon', () => {
    expect(shadowOf(1, 0).kind).toBe('none');
    expect(shadowOf(1, -12).kind).toBe('none');
    expect(shadowOf(1, Number.NaN).kind).toBe('none');
    expect(shadowOf(1, 0.2).kind).toBe('long');
    expect(shadowOf(1, 0.5).kind).toBe('length');
  });
});

describe('the height typed for "When is it at…?"', () => {
  it('reads degrees, and degrees and minutes', () => {
    expect(parseAltitude('30')).toBe(30);
    expect(parseAltitude(' 30.5° ')).toBe(30.5);
    expect(parseAltitude('30 15')).toBe(30.25);
    expect(parseAltitude('30° 15′')).toBe(30.25);
    expect(parseAltitude('−6')).toBe(-6);
    expect(parseAltitude('-0 50')).toBeCloseTo(-50 / 60, 12);
    expect(parseAltitude('12,5')).toBe(12.5);
    expect(parseAltitude('90')).toBe(FIND_ALT_MAX);
    expect(parseAltitude('-18')).toBe(FIND_ALT_MIN);
  });

  it('refuses what is not a height the tool can look for', () => {
    for (const bad of ['', 'high', '91', '-19', '30 60', '30.5 10', '30 -5', '1 2 3', '--5']) expect(parseAltitude(bad), bad).toBeNull();
  });
});
