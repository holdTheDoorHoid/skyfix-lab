/**
 * Messages for the person using the page: which engine is running, a computation that
 * failed, a layer that could not load. One list per page, shared through `Ctx`.
 *
 * A notice with a `key` replaces the previous notice with the same key, so a view that
 * fails every frame shows one message, not thousands. Persistent notices (the mock
 * engine warning) cannot be dismissed.
 */

export type NoticeLevel = 'info' | 'caution' | 'error';

export interface Notice {
  readonly id: number;
  readonly level: NoticeLevel;
  readonly text: string;
  readonly persistent: boolean;
  readonly key: string | null;
}

export interface NoticeOptions {
  /** Replace an existing notice with the same key instead of adding another. */
  key?: string;
  /** Cannot be dismissed (for example: "this is the mock engine"). */
  persistent?: boolean;
}

export interface Notices {
  list(): readonly Notice[];
  push(level: NoticeLevel, text: string, options?: NoticeOptions): Notice;
  dismiss(id: number): void;
  /** Remove a keyed notice, if present (for example once the fault has cleared). */
  dismissKey(key: string): void;
  /** Remove every notice that is not persistent. */
  clear(): void;
  subscribe(listener: (list: readonly Notice[]) => void): () => void;
}

export function createNotices(options: { max?: number } = {}): Notices {
  const max = options.max ?? 20;
  let items: readonly Notice[] = [];
  let nextId = 1;
  const listeners = new Set<(list: readonly Notice[]) => void>();

  function commit(next: readonly Notice[]): void {
    items = next;
    for (const listener of [...listeners]) {
      try {
        listener(items);
      } catch (error) {
        console.error('notice listener failed', error);
      }
    }
  }

  return {
    list: () => items,
    push(level, text, opts = {}) {
      const notice: Notice = {
        id: nextId++,
        level,
        text,
        persistent: opts.persistent ?? false,
        key: opts.key ?? null,
      };
      const kept = notice.key === null ? [...items] : items.filter((n) => n.key !== notice.key);
      kept.push(notice);
      // Drop the oldest dismissible notices beyond the cap; persistent ones always stay.
      let overflow = kept.length - max;
      const trimmed = kept.filter((n) => {
        if (overflow > 0 && !n.persistent && n !== notice) {
          overflow -= 1;
          return false;
        }
        return true;
      });
      commit(trimmed);
      return notice;
    },
    dismiss(id) {
      const next = items.filter((n) => n.id !== id || n.persistent);
      if (next.length !== items.length) commit(next);
    },
    dismissKey(key) {
      const next = items.filter((n) => n.key !== key);
      if (next.length !== items.length) commit(next);
    },
    clear() {
      const next = items.filter((n) => n.persistent);
      if (next.length !== items.length) commit(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
