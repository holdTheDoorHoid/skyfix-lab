/**
 * The time bar's rise, transit and set labels never print over each other (polish2): on a
 * phone at Tromsø the Moon's set, rise and transit fell within three hours and their times
 * were drawn on top of one another.
 */
import { describe, expect, it } from 'vitest';
import { clashingLabels } from '../../src/next/timebar/ribbon.js';

const box = (left: number, width = 47) => ({ left, right: left + width });

describe('clashingLabels', () => {
  it('keeps the first of labels that overlap and hides the rest (Tromsø, 21 June 2999, a phone)', () => {
    // 00:18, 01:25 and 02:39 at 15 px an hour, each label 47 px wide.
    expect(clashingLabels([box(12), box(12), box(31)])).toEqual([false, true, true]);
  });

  it('keeps labels with room between them, and judges by position, not by order', () => {
    expect(clashingLabels([box(300), box(10), box(120)])).toEqual([false, false, false]);
    expect(clashingLabels([box(60), box(10)])).toEqual([true, false]);
  });

  it('asks for a small gap after the last label kept', () => {
    expect(clashingLabels([box(0, 40), box(42, 40)])).toEqual([false, true]);
    expect(clashingLabels([box(0, 40), box(44, 40)])).toEqual([false, false]);
    expect(clashingLabels([box(0, 40), box(42, 40)], 2)).toEqual([false, false]);
  });

  it('measures from the last label kept, so a hidden one does not push the next away', () => {
    expect(clashingLabels([box(0, 40), box(30, 40), box(50, 40)])).toEqual([false, true, false]);
  });

  it('has nothing to hide with fewer than two labels', () => {
    expect(clashingLabels([])).toEqual([]);
    expect(clashingLabels([box(5)])).toEqual([false]);
  });
});
