/**
 * Share links: the only way a position leaves the page, and only on an explicit Share.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyShare,
  consumeShareFromLocation,
  createExplorerStore,
  decodeShare,
  encodeShare,
  listenForShareLinks,
  shareUrl,
  type ExplorerState,
} from '../../src/next/state.js';
import { isoUtc, jdFromIso } from '../../src/next/time.js';
import { MemoryStorage } from './helpers.js';

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

function sharedState(): ExplorerState {
  const store = createExplorerStore({ storage: null, now: () => NOW });
  store.patch({
    observer: {
      lat_deg: -33.856784,
      lon_deg: 151.215297,
      height_m: 4,
      label: 'Sydney Opera House & harbour',
      zone: { kind: 'iana', zone: 'Australia/Sydney' },
    },
    time: { jd_utc: jdFromIso('2026-12-21T10:15:30.250Z')!, live: false },
    selection: { body: 'Moon' },
    view: 'sky',
  });
  return store.get();
}

describe('share round trip', () => {
  it('restores place, zone, moment, body and view', () => {
    const state = sharedState();
    const hash = encodeShare(state);
    expect(hash.startsWith('#v=1&')).toBe(true);
    const patch = decodeShare(hash)!;
    expect(patch.observer).toEqual({
      lat_deg: -33.85678,
      lon_deg: 151.2153,
      height_m: 4,
      label: 'Sydney Opera House & harbour',
      zone: { kind: 'iana', zone: 'Australia/Sydney' },
    });
    expect(isoUtc(patch.time!.jd_utc)).toBe('2026-12-21T10:15:30.250Z');
    expect(patch.selection).toEqual({ body: 'Moon' });
    expect(patch.view).toBe('sky');

    const other = createExplorerStore({ storage: null, now: () => NOW });
    applyShare(other, patch);
    const s = other.get();
    expect(s.observer.label).toBe('Sydney Opera House & harbour');
    expect(s.time.live).toBe(false);
    expect(s.time.playing).toBe(false);
    expect(s.view).toBe('sky');
  });

  it('keeps nautical and UTC zone choices', () => {
    const state = sharedState();
    for (const zone of [{ kind: 'nautical' }, { kind: 'utc' }] as const) {
      const hash = encodeShare({ ...state, observer: { ...state.observer, zone } });
      expect(decodeShare(hash)!.observer!.zone).toEqual(zone);
    }
  });

  it('builds a full link from the page address, dropping any old fragment', () => {
    const url = shareUrl(sharedState(), 'https://example.org/skyfix-lab/next/?engine=mock#old');
    expect(url.startsWith('https://example.org/skyfix-lab/next/?engine=mock#v=1&')).toBe(true);
    expect(url).not.toContain('#old');
  });
});

describe('share privacy', () => {
  it('leaves the place out when asked', () => {
    const hash = encodeShare(sharedState(), { place: false });
    expect(hash).not.toMatch(/lat=|lon=|place=|tz=|Sydney|33\.85|151\.2/);
    const patch = decodeShare(hash)!;
    expect(patch.observer).toBeUndefined();
    expect(patch.time).toBeDefined();
  });

  it('can leave the time out, so the link opens at now', () => {
    const patch = decodeShare(encodeShare(sharedState(), { time: false }))!;
    expect(patch.time).toBeUndefined();
    expect(patch.observer).toBeDefined();
  });

  it('never touches the address bar while the state changes', () => {
    const writes: string[] = [];
    const fakeLocation = new Proxy(
      { hash: '', pathname: '/next/', search: '' },
      {
        set(target, key, value) {
          writes.push(String(key));
          return Reflect.set(target, key, value);
        },
      },
    );
    const fakeHistory = {
      state: null,
      pushState: () => writes.push('pushState'),
      replaceState: () => writes.push('replaceState'),
    };
    vi.stubGlobal('location', fakeLocation);
    vi.stubGlobal('history', fakeHistory);
    const storage = new MemoryStorage();
    const store = createExplorerStore({ storage, now: () => NOW });
    for (let i = 0; i < 5; i += 1) {
      store.patch({ observer: { lat_deg: 10 + i, lon_deg: 20 + i, label: `Place ${i}` } });
      store.patch({ time: { jd_utc: store.get().time.jd_utc + 0.1, live: false } });
      store.patch({ selection: { body: 'Vega' }, view: 'charts' });
    }
    expect(writes).toEqual([]);
    expect(fakeLocation.hash).toBe('');
    expect(storage.dump()).not.toMatch(/Place|lat_deg/);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

describe('decoding untrusted fragments', () => {
  it('ignores fragments that are not share links', () => {
    expect(decodeShare('')).toBeNull();
    expect(decodeShare('#sky')).toBeNull();
    expect(decodeShare('#v=2&lat=1&lon=2')).toBeNull();
  });

  it('drops invalid fields one by one', () => {
    const patch = decodeShare(
      '#v=1&lat=95&lon=10&t=2026-13-40T00:00:00Z&view=hacker&body=' + 'x'.repeat(200),
    )!;
    expect(patch).toEqual({});
    const partial = decodeShare('#v=1&lat=10&lon=abc&t=2026-09-24T00:00:00Z&view=events')!;
    expect(partial.observer).toBeUndefined();
    expect(partial.view).toBe('events');
    expect(isoUtc(partial.time!.jd_utc)).toBe('2026-09-24T00:00:00.000Z');
  });

  it('normalises longitude and falls back to nautical time for an unknown zone', () => {
    const patch = decodeShare('#v=1&lat=10&lon=190&tz=Nowhere%2FLand&h=99999')!;
    expect(patch.observer).toMatchObject({
      lon_deg: -170,
      height_m: 0,
      zone: { kind: 'nautical' },
    });
  });
});

describe('consuming a share at start-up', () => {
  it('applies the fragment, then removes it from the address bar', () => {
    const store = createExplorerStore({ storage: null, now: () => NOW });
    const hash = encodeShare(sharedState());
    const replace = vi.fn();
    const applied = consumeShareFromLocation(
      store,
      { hash, pathname: '/skyfix-lab/next/', search: '?engine=mock' },
      { state: null, replaceState: replace },
    );
    expect(applied).toBe(true);
    expect(store.get().observer.label).toBe('Sydney Opera House & harbour');
    expect(replace).toHaveBeenCalledWith(null, '', '/skyfix-lab/next/?engine=mock');
  });

  it('leaves a non-share fragment alone', () => {
    const store = createExplorerStore({ storage: null, now: () => NOW });
    const replace = vi.fn();
    const applied = consumeShareFromLocation(
      store,
      { hash: '#about', pathname: '/next/', search: '' },
      { state: null, replaceState: replace },
    );
    expect(applied).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('share links pasted into an open page', () => {
  it('applies a fragment-only navigation, then removes it; stops listening on request', () => {
    const store = createExplorerStore({ storage: null, now: () => NOW });
    const listeners = new Map<string, () => void>();
    const location = { hash: '', pathname: '/next/', search: '' };
    const history = { state: null, replaceState: vi.fn(() => (location.hash = '')) };
    const win = {
      location,
      history,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const stop = listenForShareLinks(store, win as unknown as Window);
    expect(history.replaceState).not.toHaveBeenCalled(); // nothing to consume at start
    location.hash = encodeShare(sharedState());
    listeners.get('hashchange')!();
    expect(store.get().observer.label).toBe('Sydney Opera House & harbour');
    expect(location.hash).toBe('');
    stop();
    expect(listeners.size).toBe(0);
  });
});

describe('time-zone pin in share links', () => {
  it('keeps a pinned zone pinned and a guessed zone guessed', () => {
    const store = createExplorerStore({ storage: null, now: () => NOW });
    // The default place's zone is a guess: it follows the place.
    expect(store.get().observer.zone).toEqual({ kind: 'iana', zone: 'America/New_York', guessed: true });
    const guessedHash = encodeShare(store.get());
    expect(guessedHash).not.toContain('tzpin');
    expect(decodeShare(guessedHash)!.observer!.zone).toEqual({
      kind: 'iana',
      zone: 'America/New_York',
      guessed: true,
    });

    store.patch({ observer: { zone: { kind: 'iana', zone: 'Europe/London' } } });
    const pinnedHash = encodeShare(store.get());
    expect(pinnedHash).toContain('tzpin=1');
    expect(decodeShare(pinnedHash)!.observer!.zone).toEqual({ kind: 'iana', zone: 'Europe/London' });

    store.patch({ observer: { zone: { kind: 'utc' } } });
    expect(decodeShare(encodeShare(store.get()))!.observer!.zone).toEqual({ kind: 'utc' });
  });

  it('treats the zone of a link made before pins existed as a guess', () => {
    expect(decodeShare('#v=1&lat=51.5&lon=0&tz=Europe%2FLondon')!.observer!.zone).toEqual({
      kind: 'iana',
      zone: 'Europe/London',
      guessed: true,
    });
    expect(decodeShare('#v=1&lat=0&lon=-30&tz=nautical')!.observer!.zone).toEqual({ kind: 'nautical', guessed: true });
  });
});
