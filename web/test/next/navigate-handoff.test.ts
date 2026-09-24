/**
 * Handing a session to the Navigate view (web/src/next/navigate/handoff.ts): Learn's
 * "Open in Navigate". The session arrives labelled SIMULATED, as a copy, once; nothing but
 * the session, where it came from and how it was solved is carried — never the truth.
 */
import { describe, expect, it } from 'vitest';
import { handOffToNavigate, takeNavigateHandoff } from '../../src/next/navigate/handoff.js';
import { emptySession } from '../../src/next/navigate/model.js';

describe('handing a session to Navigate', () => {
  it('labels it SIMULATED, copies it and gives it once', () => {
    const store = {};
    const session = emptySession({ name: 'Three stars', position: { lat_deg: 10, lon_deg: 20 } });
    expect(session.meta.kind).toBe('real');
    handOffToNavigate(store, { session, from: 'the Learn simulator’s “Three stars”', mode: 'auto', solve: { robust: true } });
    const got = takeNavigateHandoff(store)!;
    expect(got.session.meta.kind).toBe('simulated');
    expect(got.session.meta.name).toBe('Three stars');
    expect(got.session).not.toBe(session);
    expect(session.meta.kind).toBe('real'); // the sender's copy is untouched
    expect(Object.keys(got).sort()).toEqual(['from', 'mode', 'session', 'solve']);
    expect(takeNavigateHandoff(store)).toBeNull();
  });

  it('keeps one per explorer page, the latest', () => {
    const a = {};
    const b = {};
    handOffToNavigate(a, { session: emptySession({ name: 'first' }), from: 'x', mode: 'auto' });
    handOffToNavigate(a, { session: emptySession({ name: 'second' }), from: 'x', mode: 'supplied' });
    expect(takeNavigateHandoff(b)).toBeNull();
    const got = takeNavigateHandoff(a)!;
    expect([got.session.meta.name, got.mode]).toEqual(['second', 'supplied']);
  });
});
