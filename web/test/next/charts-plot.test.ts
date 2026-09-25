/**
 * The charts2 agent's SVG helpers that do arithmetic (web/src/next/charts/plot.ts): paths that
 * break where data is missing, round axis steps, a year's date axis.
 */
import { describe, expect, it } from 'vitest';
import { linePath, niceStep, yearAxis } from '../../src/next/charts/plot.js';
import { wantsLandscape } from '../../src/next/charts/print.js';

describe('plot helpers', () => {
  it('draws a line through points and breaks it at a gap', () => {
    expect(linePath([[0, 0], [1.234, 5.678], null, [3, 4], [5, 6]])).toBe('M0 0L1.23 5.68M3 4L5 6');
    expect(linePath([[0, Number.NaN], [1, 1]])).toBe('M1 1');
    expect(linePath([])).toBe('');
  });

  it('picks round steps for an axis', () => {
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(9.2, 5)).toBe(2);
    expect(niceStep(0.9, 4)).toBe(0.25);
    expect(niceStep(1300, 4)).toBe(500);
    expect(niceStep(47, 5)).toBe(10);
  });

  it('lays a year out day by day, the months at their first days', () => {
    const a = yearAxis(2024, 100, 466);
    expect(a.n).toBe(366);
    expect(a.xs(0)).toBe(100);
    expect(a.xs(366)).toBe(466);
    expect(a.xs(183)).toBeCloseTo(283, 9);
    expect(a.months).toEqual([0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]);
  });

  it('prints wide charts across the page and tall ones down it', () => {
    expect(wantsLandscape(1200, 700)).toBe(true);
    expect(wantsLandscape(600, 600)).toBe(false);
  });
});
