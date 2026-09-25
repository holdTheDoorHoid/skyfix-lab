/**
 * Heavy work that waits for the time to settle (charts2 agent, expansion programme Q5).
 * OWNER: charts2 agent.
 *
 * A year of the Moon, a solar year with its best tilt or a month of perigees takes tens to
 * hundreds of milliseconds in WebAssembly; the time bar scrubs at 60 frames a second. So a
 * chart asks for such work through `settler`: the first request of a view runs at once (the
 * chart appears without a wait), later ones run when the requests have stopped for
 * `settleMs`, and at least every `maxWaitMs` while they keep coming (so a long drag still
 * updates). The work itself runs in a timer, outside the frame being drawn.
 */

export interface Settler {
  /** Ask for `work` to run (replacing any earlier request that has not run yet). */
  request(work: () => void): void;
  /** Forget a request that has not run. */
  cancel(): void;
  /** Whether a request is waiting. */
  pending(): boolean;
}

export interface SettleOptions {
  /** Quiet time before running, ms (default 160). */
  settleMs?: number;
  /** Longest wait while requests keep coming, ms (default 700). */
  maxWaitMs?: number;
  /** Timers (tests pass fakes). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  now?: () => number;
}

export function settler(options: SettleOptions = {}): Settler {
  const settleMs = options.settleMs ?? 160;
  const maxWaitMs = options.maxWaitMs ?? 700;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => Date.now());
  let timer: unknown = null;
  let waiting: (() => void) | null = null;
  let firstPending = 0;
  let ranOnce = false;

  const fire = (): void => {
    timer = null;
    const work = waiting;
    waiting = null;
    ranOnce = true;
    work?.();
  };

  return {
    request(work) {
      const t = now();
      if (timer === null) firstPending = t;
      else clearTimer(timer);
      waiting = work;
      const wait = !ranOnce || t - firstPending >= maxWaitMs ? 0 : settleMs;
      timer = setTimer(fire, wait);
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      waiting = null;
    },
    pending: () => waiting !== null,
  };
}
