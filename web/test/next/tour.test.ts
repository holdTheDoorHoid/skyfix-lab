/**
 * The first-run tour's rules that need no page (web/src/next/shell/tour.ts): three to five
 * steps, and the dismissal remembered per viewer without ever throwing. The card itself is
 * checked in Chrome (docs/design/local).
 */
import { describe, expect, it } from 'vitest';
import { rememberTourDismissed, TOUR_KEY, TOUR_STEPS, tourDismissed } from '../../src/next/shell/tour.js';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

const refusing: Storage = {
  length: 0,
  clear: () => undefined,
  getItem: () => {
    throw new Error('SecurityError');
  },
  key: () => null,
  removeItem: () => undefined,
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('the first-run tour', () => {
  it('is short: three to five steps, each pointing at something', () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(3);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(5);
    for (const step of TOUR_STEPS) {
      expect(step.title).not.toBe('');
      expect(step.text.length).toBeLessThan(260);
      expect(step.target).toMatch(/^\./);
    }
    expect(TOUR_STEPS.map((s) => s.target)).toEqual(expect.arrayContaining(['.sf-search', '.sf-timebar', '.sf-views']));
  });

  it('remembers a dismissal for this viewer, and only that', () => {
    const storage = memoryStorage();
    expect(tourDismissed(storage)).toBe(false);
    expect(rememberTourDismissed(storage)).toBe(true);
    expect(tourDismissed(storage)).toBe(true);
    expect([...Array(storage.length).keys()].map((i) => storage.key(i))).toEqual([TOUR_KEY]);
  });

  it('never throws where the browser refuses storage: it just shows again next time', () => {
    expect(tourDismissed(refusing)).toBe(false);
    expect(rememberTourDismissed(refusing)).toBe(false);
    expect(tourDismissed(null)).toBe(false);
    expect(rememberTourDismissed(null)).toBe(false);
  });
});
