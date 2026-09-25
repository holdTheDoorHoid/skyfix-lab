/**
 * Long searches in pieces (web/src/next/events/search.ts, shared.ts, listtab.ts
 * `inRange`): a window split into chunks, one engine call per timer tick, results kept
 * once each and sorted, clipped to the coverage, paused while the time bar moves, kept per
 * window, stopped cleanly. Driven by FakeTimers: no real time passes.
 */

import { describe, expect, it } from 'vitest';
import type { EventItem } from '../../src/next/events/items.js';
import { inRange } from '../../src/next/events/listtab.js';
import { BackgroundSearch, chunksOf, progressText, type Timer } from '../../src/next/events/search.js';
import { SharedSearches } from '../../src/next/events/shared.js';

/**
 * One turn of the event loop per `advance`: only the timers queued before the call and due
 * by its end run (a zero-delay timer set by one of them waits for the next turn), unlike
 * the helpers' FakeTimers, which run a chain of zero-delay timers in one call.
 */
class FakeTimers {
  private queue = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now = 0;
  set(fn: () => void, ms: number): number {
    const id = this.next++;
    this.queue.set(id, { at: this.now + Math.max(0, ms), fn });
    return id;
  }
  clear(id: number): void {
    this.queue.delete(id);
  }
  get pending(): number {
    return this.queue.size;
  }
  advance(ms: number): void {
    this.now += ms;
    const due = [...this.queue.entries()].filter(([, t]) => t.at <= this.now).sort((a, b) => a[1].at - b[1].at);
    for (const [id, t] of due) {
      if (!this.queue.has(id)) continue;
      this.queue.delete(id);
      t.fn();
    }
  }
}

interface Found {
  id: string;
  jd: number;
  contacts: number;
}

/** A fake engine: an event every 10 days (at 5, 15, 25, …), each found by every chunk that reaches it. */
function engine() {
  const calls: [number, number][] = [];
  const compute = (span: { start: number; end: number }): Found[] => {
    calls.push([span.start, span.end]);
    const out: Found[] = [];
    for (let jd = Math.ceil((span.start - 5) / 10) * 10 + 5; jd <= span.end; jd += 10) {
      if (jd >= span.start) out.push({ id: `e${jd}`, jd, contacts: jd === span.end ? 1 : 2 });
    }
    return out;
  };
  return { calls, compute };
}

function timerOf(t: FakeTimers): Timer {
  return { set: (fn, ms) => t.set(fn, ms), clear: (h) => t.clear(h as number) };
}

function search(t: FakeTimers, overrides: Partial<ConstructorParameters<typeof BackgroundSearch<Found>>[0]> = {}) {
  const e = engine();
  let updates = 0;
  const s = new BackgroundSearch<Found>({
    compute: e.compute,
    chunkDays: 30,
    key: (f) => f.id,
    time: (f) => f.jd,
    timer: timerOf(t),
    onUpdate: () => {
      updates += 1;
    },
    ...overrides,
  });
  return { s, e, updates: () => updates };
}

describe('chunks', () => {
  it('split a window into pieces of at most the chunk length, in time order', () => {
    expect(chunksOf({ start: 0, end: 100 }, 30)).toEqual([
      { start: 0, end: 30 },
      { start: 30, end: 60 },
      { start: 60, end: 90 },
      { start: 90, end: 100 },
    ]);
    expect(chunksOf({ start: 0, end: 90 }, 30)).toHaveLength(3);
    expect(chunksOf({ start: 5, end: 5 }, 30)).toEqual([{ start: 5, end: 5 }]);
    expect(chunksOf({ start: 5, end: 4 }, 30)).toEqual([]);
  });

  it('say how far a search has got', () => {
    expect(progressText({ done: false, progress: 0.4 })).toBe('Searching… 40%');
    expect(progressText({ done: true, progress: 1 })).toBe('');
  });
});

describe('a background search', () => {
  it('answers at once with nothing, then fills in a chunk per tick, sorted and each event once', () => {
    const t = new FakeTimers();
    const { s, e, updates } = search(t);
    const first = s.get({ start: 0, end: 100 });
    expect(first.items).toEqual([]);
    expect(first.done).toBe(false);
    expect(e.calls).toHaveLength(0); // nothing runs in the caller's frame
    t.advance(0);
    expect(e.calls).toEqual([[0, 30]]);
    expect(updates()).toBe(1);
    let st = s.get({ start: 0, end: 100 });
    expect(st.items.map((f) => f.jd)).toEqual([5, 15, 25]);
    expect(st.progress).toBe(0.25);
    expect(st.searched).toEqual({ start: 0, end: 30 });
    t.advance(0);
    t.advance(0);
    t.advance(0);
    st = s.get({ start: 0, end: 100 });
    expect(st.done).toBe(true);
    expect(st.items.map((f) => f.jd)).toEqual([5, 15, 25, 35, 45, 55, 65, 75, 85, 95]);
    expect(e.calls).toHaveLength(4);
    expect(t.pending).toBe(0);
  });

  it('keeps the better of two finds of the same event (neighbouring chunks)', () => {
    const t = new FakeTimers();
    const e = engine();
    // Chunks end on an event (30, 60): the chunk that ends there sees one contact only.
    const s = new BackgroundSearch<Found>({
      compute: (span) => {
        const out = e.compute(span);
        if (span.start === 30) out.unshift({ id: 'e30', jd: 30, contacts: 2 });
        if (span.end === 30) out.push({ id: 'e30', jd: 30, contacts: 1 });
        return out;
      },
      chunkDays: 30,
      key: (f) => f.id,
      time: (f) => f.jd,
      better: (a, b) => b.contacts > a.contacts,
      timer: timerOf(t),
    });
    s.get({ start: 0, end: 60 });
    t.advance(0);
    t.advance(0);
    const st = s.get({ start: 0, end: 60 });
    expect(st.items.filter((f) => f.id === 'e30')).toEqual([{ id: 'e30', jd: 30, contacts: 2 }]);
  });

  it('searches backward from the end for a past list', () => {
    const t = new FakeTimers();
    const { s, e } = search(t);
    s.get({ start: 0, end: 100 }, 'backward');
    t.advance(0);
    expect(e.calls[0]).toEqual([90, 100]);
  });

  it('clips the window to the coverage and says so', () => {
    const t = new FakeTimers();
    const { s, e } = search(t, { coverage: () => ({ start: 20, end: 70 }) });
    s.get({ start: 0, end: 100 });
    t.advance(0);
    t.advance(0);
    const st = s.get({ start: 0, end: 100 });
    expect(st.truncated).toBe(true);
    expect(st.span).toEqual({ start: 20, end: 70 });
    expect(e.calls).toEqual([
      [20, 50],
      [50, 70],
    ]);
    expect(st.done).toBe(true);
  });

  it('asks nothing of the engine for a window wholly outside the coverage', () => {
    const t = new FakeTimers();
    const { s, e } = search(t, { coverage: () => ({ start: 200, end: 300 }) });
    const st = s.get({ start: 0, end: 100 });
    t.advance(10);
    expect(st.done).toBe(true);
    expect(st.truncated).toBe(true);
    expect(st.span).toBeNull();
    expect(e.calls).toEqual([]);
  });

  it('waits while the time bar moves (pace), then carries on', () => {
    const t = new FakeTimers();
    let wait = 250;
    const { s, e } = search(t, { pace: () => wait });
    s.get({ start: 0, end: 60 });
    t.advance(0);
    expect(e.calls).toHaveLength(0);
    t.advance(200);
    expect(e.calls).toHaveLength(0);
    wait = 0;
    t.advance(60);
    expect(e.calls).toHaveLength(1);
    t.advance(0);
    expect(e.calls).toHaveLength(2);
  });

  it('reuses a window already searched, or being searched, that holds the one asked for', () => {
    const t = new FakeTimers();
    const { s, e } = search(t);
    s.get({ start: 0, end: 100 });
    t.advance(0);
    t.advance(0);
    t.advance(0);
    t.advance(0);
    const n = e.calls.length;
    const st = s.get({ start: 10, end: 90 });
    t.advance(0);
    expect(e.calls.length).toBe(n);
    expect(st.done).toBe(true);
    expect(st.items).toHaveLength(10);
  });

  it('remembers a few windows, newest first, and forgets the oldest', () => {
    const t = new FakeTimers();
    const { s, e } = search(t, { keep: 2 });
    for (const start of [0, 1000, 2000]) {
      s.get({ start, end: start + 30 });
      t.advance(0);
    }
    const n = e.calls.length;
    s.get({ start: 1000, end: 1030 }); // still kept
    t.advance(0);
    expect(e.calls.length).toBe(n);
    s.get({ start: 0, end: 30 }); // forgotten: searched again
    t.advance(0);
    expect(e.calls.length).toBe(n + 1);
  });

  it('stops at the first chunk that fails, with the reason', () => {
    const t = new FakeTimers();
    let n = 0;
    const s = new BackgroundSearch<Found>({
      compute: () => {
        n += 1;
        if (n === 2) throw new Error('outside the coverage window');
        return [];
      },
      chunkDays: 10,
      key: (f) => f.id,
      time: (f) => f.jd,
      timer: timerOf(t),
    });
    s.get({ start: 0, end: 40 });
    t.advance(0);
    t.advance(0);
    t.advance(0);
    const st = s.get({ start: 0, end: 40 });
    expect(st.error).toBe('outside the coverage window');
    expect(st.done).toBe(true);
    expect(n).toBe(2);
  });

  it('tells its subscribers, pauses and resumes, and stops for good when destroyed', () => {
    const t = new FakeTimers();
    const { s, e } = search(t);
    let heard = 0;
    const stop = s.subscribe(() => {
      heard += 1;
    });
    s.get({ start: 0, end: 90 });
    t.advance(0);
    expect(heard).toBe(1);
    s.pause();
    t.advance(100);
    expect(e.calls).toHaveLength(1);
    s.get({ start: 0, end: 90 }); // resumes where it stopped
    t.advance(0);
    expect(e.calls).toHaveLength(2);
    stop();
    t.advance(0);
    expect(heard).toBe(2);
    s.destroy();
    s.get({ start: 500, end: 600 });
    t.advance(0);
    expect(e.calls).toHaveLength(3); // the finished window's last chunk had run; nothing after destroy
  });
});

describe('the view’s searches', () => {
  it('are shared by name and key, and a new key starts afresh', () => {
    const shared = new SharedSearches();
    const make = () => ({ compute: () => [] as Found[], chunkDays: 10, key: (f: Found) => f.id, time: (f: Found) => f.jd });
    const a = shared.search('occultations', 'here', make);
    expect(shared.search('occultations', 'here', make)).toBe(a);
    const b = shared.search('occultations', 'elsewhere', make);
    expect(b).not.toBe(a);
    expect(shared.search('conjunctions', 'here', make)).not.toBe(b);
  });

  it('pass the view’s pace to every search', () => {
    const shared = new SharedSearches();
    let seen: (() => number) | null = null;
    shared.search('x', 'k', (pace) => {
      seen = pace;
      return { compute: () => [] as Found[], chunkDays: 10, key: (f: Found) => f.id, time: (f: Found) => f.jd };
    });
    shared.pace = () => 42;
    expect(seen!()).toBe(42);
  });
});

describe('which events a list shows', () => {
  const item = (start: number, end: number | null = null): EventItem => ({
    id: `i${start}`,
    group: 'g',
    kind: 'k',
    title: 't',
    start,
    end,
    jump: start,
    body: null,
    sentence: '',
    local: false,
    columns: [],
  });
  const items = [item(-20), item(-1, 1), item(3), item(50), item(400)];

  it('upcoming: from the anchor (or under way at it), soonest first', () => {
    expect(inRange(items, 0, 'upcoming', 365).map((i) => i.start)).toEqual([-1, 3, 50]);
    expect(inRange(items, 0, 'upcoming', 30).map((i) => i.start)).toEqual([-1, 3]);
  });

  it('past: before the anchor, most recent first', () => {
    expect(inRange(items, 10, 'past', 365).map((i) => i.start)).toEqual([3, -1, -20]);
  });
});
