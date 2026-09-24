/** Shared fakes for the explorer tests (node environment: no DOM, no storage, no frames). */

export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  writes = 0;
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.map.set(key, String(value));
  }
  dump(): string {
    return JSON.stringify(Object.fromEntries(this.map));
  }
}

/** Storage that throws on every call, like a browser with site data blocked. */
export class ThrowingStorage implements Storage {
  get length(): number {
    throw new Error('SecurityError');
  }
  clear(): void {
    throw new Error('SecurityError');
  }
  getItem(): string | null {
    throw new Error('SecurityError');
  }
  key(): string | null {
    throw new Error('SecurityError');
  }
  removeItem(): void {
    throw new Error('SecurityError');
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
}

/** A manual requestAnimationFrame: `step(ms)` runs the queued callbacks at a time. */
export class FakeFrames {
  private queue = new Map<number, (t: number) => void>();
  private nextId = 1;
  now = 0;
  readonly request = (cb: (t: number) => void): number => {
    const id = this.nextId++;
    this.queue.set(id, cb);
    return id;
  };
  readonly cancel = (id: number): void => {
    this.queue.delete(id);
  };
  get pending(): number {
    return this.queue.size;
  }
  /** Advance the clock by `ms` and run one frame. */
  step(ms = 16): void {
    this.now += ms;
    const callbacks = [...this.queue.values()];
    this.queue.clear();
    for (const cb of callbacks) cb(this.now);
  }
}

/** A manual setTimeout/clearTimeout pair driven by `advance(ms)`. */
export class FakeTimers {
  private timers = new Map<number, { at: number; cb: () => void }>();
  private nextId = 1;
  now = 0;
  readonly set = (cb: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, ms), cb });
    return id;
  };
  readonly clear = (id: number): void => {
    this.timers.delete(id);
  };
  get pending(): number {
    return this.timers.size;
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= end && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.now = timer.at;
      timer.cb();
    }
    this.now = end;
  }
}
