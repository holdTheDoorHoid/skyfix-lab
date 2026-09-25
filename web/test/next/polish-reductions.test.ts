/**
 * Navigate's printables wait for the sights' reductions (polish2): the fix is solved apart
 * from the per-sight reductions, so a preview asked for as soon as the fix appeared could
 * have its plotting sheet and no worksheets (seen in ui-check's navigate2 block under load).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settledReductions, type Reductions } from '../../src/next/navigate/reductions.js';
import { createStore } from '../../src/next/state.js';
import type { Session } from '../../src/types.js';

const session = { observations: [] } as unknown as Session;
const other = { observations: [] } as unknown as Session;
const state = (s: Session | null, pending: boolean, ids: string[] = []): Reductions => ({
  byId: new Map(ids.map((id) => [id, { status: 'ok' } as never])),
  session: s,
  mode: 'full' as never,
  error: null,
  pending,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('settledReductions', () => {
  it('answers at once when the reductions are the session’s and settled', async () => {
    const store = createStore(state(session, false, ['a']));
    expect([...(await settledReductions(store, session)).byId.keys()]).toEqual(['a']);
  });

  it('waits while they are pending, and takes them once they are the session’s', async () => {
    const store = createStore(state(null, true));
    const got = settledReductions(store, session);
    store.set(state(other, false, ['old']));
    store.set(state(session, true));
    store.set(state(session, false, ['a', 'b']));
    expect([...(await got).byId.keys()]).toEqual(['a', 'b']);
  });

  it('gives up after the time allowed, with what there is', async () => {
    vi.useFakeTimers();
    const store = createStore(state(other, false, ['old']));
    const got = settledReductions(store, session, 1000);
    vi.advanceTimersByTime(1000);
    expect((await got).session).toBe(other);
  });
});
