/**
 * The shell fixes of the expansion programme (packs agent): the 12-hour clock (format.ts,
 * the setting, and every `watch` drawing again when it changes), the install offer, the
 * links to the manual and the repository, the memoised engine forgetting its results when
 * a pack loads, and the engines' pack methods (the WASM wrapper and the mock).
 */

import { describe, expect, it, vi } from 'vitest';
import { createScheduler, memoEngine, watch } from '../../src/next/component.js';
import { MockPacks } from '../../src/next/engine/mock/packs.js';
import type { ExplorerEngine, PackStatus } from '../../src/next/engine/types.js';
import { isPackEngine } from '../../src/next/engine/types.js';
import { WasmEngine, type ExplorerWasmExports } from '../../src/next/engine/wasm.js';
import {
  axisTime,
  clock,
  clockParts,
  clockSeconds,
  endOfDay,
  eventTime,
  parseClock,
  setHourCycle,
} from '../../src/next/shell/format.js';
import { isIosDevice, IOS_HINT, startInstallOffer } from '../../src/next/shell/install.js';
import { MANUAL_URL, REPOSITORY_URL } from '../../src/next/shell/links.js';
import { createExplorerStore, sanitizeSettings } from '../../src/next/state.js';
import { jdFromIso, UTC_ZONE } from '../../src/next/time.js';
import { FakeFrames, MemoryStorage } from './helpers.js';

const NY = { kind: 'iana', zone: 'America/New_York' } as const;
const ZD5 = { kind: 'fixed', offsetMs: -5 * 3_600_000, name: 'ZD +5' } as const;

describe('the 12-hour clock', () => {
  const evening = jdFromIso('2026-09-24T22:54:29Z')!; // 18:54:29 EDT
  const morning = jdFromIso('2026-09-24T10:05:07Z')!; // 06:05:07 EDT
  const midnight = jdFromIso('2026-09-25T04:00:10Z')!; // 00:00:10 EDT
  const noon = jdFromIso('2026-09-24T16:00:00Z')!; // 12:00:00 EDT

  it('is off by default: every time reads as before', () => {
    setHourCycle('h23');
    expect(eventTime(evening, NY)).toBe('18:54');
    expect(clock(evening, NY)).toBe('18:54');
    expect(clockSeconds(evening, NY)).toBe('18:54:29');
    expect(clockParts(evening, NY)).toEqual({ hm: '18:54', seconds: ':29', suffix: '' });
    expect(endOfDay(NY)).toBe('24:00');
    expect(axisTime(morning, NY)).toBe('06:05');
  });

  it('writes local times with AM and PM, never splitting a time from its AM or PM', () => {
    setHourCycle('h12');
    try {
      expect(eventTime(evening, NY)).toBe('6:54 PM');
      expect(eventTime(evening + 1 / 86_400, NY)).toBe('6:55 PM'); // rounded to the minute, as before
      expect(clock(evening, NY)).toBe('6:54 PM'); // the minute it is in
      expect(clockSeconds(evening, NY)).toBe('6:54:29 PM');
      expect(clockParts(morning, NY)).toEqual({ hm: '6:05', seconds: ':07', suffix: ' AM' });
      expect(eventTime(midnight, NY)).toBe('12:00 AM');
      expect(eventTime(noon, NY)).toBe('12:00 PM');
      expect(eventTime(evening, ZD5)).toBe('5:54 PM');
      expect(endOfDay(NY)).toBe('12:00 AM');
      expect(axisTime(jdFromIso('2026-09-24T10:00:00Z')!, NY)).toBe('6 AM');
      expect(axisTime(jdFromIso('2026-09-24T10:30:00Z')!, NY)).toBe('6:30 AM');
    } finally {
      setHourCycle('h23');
    }
  });

  it('keeps UTC on the 24-hour clock, as navigators and almanacs write it', () => {
    setHourCycle('h12');
    try {
      expect(eventTime(evening, UTC_ZONE)).toBe('22:54');
      expect(clockSeconds(evening, UTC_ZONE)).toBe('22:54:29');
      expect(clock(evening, UTC_ZONE)).toBe('22:54');
      expect(endOfDay(UTC_ZONE)).toBe('24:00');
    } finally {
      setHourCycle('h23');
    }
  });

  it('reads a typed time on either clock', () => {
    expect(parseClock('18:40')).toEqual({ hour: 18, minute: 40, second: 0 });
    expect(parseClock(' 18:40:05 ')).toEqual({ hour: 18, minute: 40, second: 5 });
    expect(parseClock('6:40 pm')).toEqual({ hour: 18, minute: 40, second: 0 });
    expect(parseClock('6:40:05 PM')).toEqual({ hour: 18, minute: 40, second: 5 });
    expect(parseClock('6.40pm')).toEqual({ hour: 18, minute: 40, second: 0 });
    expect(parseClock('12:00 am')).toEqual({ hour: 0, minute: 0, second: 0 });
    expect(parseClock('12:30 p.m.')).toEqual({ hour: 12, minute: 30, second: 0 });
    for (const bad of ['24:00', '13:00 pm', '0:30 am', '6:60', '6:40:61', 'six forty', '']) expect(parseClock(bad), bad).toBeNull();
  });

  it('is a setting, remembered with the others, 24-hour unless chosen', () => {
    expect(sanitizeSettings({}).hourCycle).toBe('h23');
    expect(sanitizeSettings({ hourCycle: 'h12' }).hourCycle).toBe('h12');
    expect(sanitizeSettings({ hourCycle: 'h11' }).hourCycle).toBe('h23');
    const storage = new MemoryStorage();
    const store = createExplorerStore({ storage });
    store.patch({ settings: { hourCycle: 'h12' } });
    expect(JSON.parse(storage.getItem('skyfix.explorer.prefs.v1')!).settings.hourCycle).toBe('h12');
    expect(createExplorerStore({ storage }).get().settings.hourCycle).toBe('h12');
  });

  it('makes every watch draw again once when it changes, so no time keeps the old form', () => {
    const frames = new FakeFrames();
    const scheduler = createScheduler({ requestFrame: frames.request, cancelFrame: frames.cancel });
    const store = createExplorerStore({ storage: null });
    const render = vi.fn();
    const stop = watch({ store, scheduler }, (s) => s.selection.body, render);
    frames.step();
    expect(render).toHaveBeenCalledTimes(1);
    store.patch({ settings: { units: 'imperial' } }); // nothing this watch shows
    frames.step();
    expect(render).toHaveBeenCalledTimes(1);
    store.patch({ settings: { hourCycle: 'h12' } });
    frames.step();
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith('Sun');
    stop();
    store.patch({ settings: { hourCycle: 'h23' } });
    frames.step();
    expect(render).toHaveBeenCalledTimes(2);
  });
});

describe('install', () => {
  function fakeWindow(ua: string, touch = 0, standalone = false) {
    const target = new EventTarget();
    return {
      target,
      win: {
        addEventListener: target.addEventListener.bind(target) as Window['addEventListener'],
        matchMedia: ((q: string) => ({ matches: standalone && q.includes('standalone') })) as unknown as Window['matchMedia'],
        navigator: { userAgent: ua, maxTouchPoints: touch },
      },
    };
  }

  it('offers Install only once the browser has, and asks the browser when pressed', async () => {
    vi.resetModules();
    const { startInstallOffer: start } = await import('../../src/next/shell/install.js');
    const { target, win } = fakeWindow('Mozilla/5.0 (X11; Linux x86_64) Chrome/152');
    const offer = start(win);
    expect(offer.state()).toBe('none');
    const seen = vi.fn();
    offer.subscribe(seen);
    const event = Object.assign(new Event('beforeinstallprompt'), {
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); // the browser's own install entry stays
    expect(offer.state()).toBe('available');
    expect(seen).toHaveBeenCalled();
    await expect(offer.install()).resolves.toBe('accepted');
    expect(event.prompt).toHaveBeenCalledTimes(1);
    // An offer is used once.
    expect(offer.state()).toBe('none');
    await expect(offer.install()).resolves.toBe('unavailable');
    target.dispatchEvent(new Event('appinstalled'));
    expect(offer.state()).toBe('installed');
  });

  it('gives iPhones and iPads the one-line hint, and nothing once installed', async () => {
    expect(isIosDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)', maxTouchPoints: 5 })).toBe(true);
    expect(isIosDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(true); // iPadOS
    expect(isIosDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(false);
    vi.resetModules();
    const fresh = await import('../../src/next/shell/install.js');
    expect(fresh.startInstallOffer(fakeWindow('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)', 5).win).state()).toBe('ios');
    vi.resetModules();
    const again = await import('../../src/next/shell/install.js');
    expect(again.startInstallOffer(fakeWindow('Mozilla/5.0 (iPhone)', 5, true).win).state()).toBe('installed');
    expect(IOS_HINT).toMatch(/Share, then Add to Home Screen/);
    expect(typeof startInstallOffer).toBe('function');
  });
});

describe('links', () => {
  it('point at the manual beside the site and at the repository', () => {
    expect(MANUAL_URL).toBe('docs/');
    expect(new URL(MANUAL_URL, 'https://holdthedoorhoid.github.io/skyfix-lab/').href).toBe('https://holdthedoorhoid.github.io/skyfix-lab/docs/');
    expect(REPOSITORY_URL).toBe('https://github.com/holdTheDoorHoid/skyfix-lab');
  });
});

describe('the engines and data packs', () => {
  it('the memoised engine forgets its results when told (a pack was loaded) and passes packs through', () => {
    let coverageCalls = 0;
    const loads: string[] = [];
    const raw = {
      kind: 'wasm',
      description: '',
      coverage: () => (coverageCalls++, { start_utc: '', end_utc: '', groups: [] }),
      packs: (): PackStatus[] => [],
      loadPack: (name: string) => (loads.push(name), { name, version: '', bytes: 0, provides: [] }),
    } as unknown as ExplorerEngine;
    const memo = memoEngine(raw);
    memo.coverage();
    memo.coverage();
    expect(coverageCalls).toBe(1);
    memo.invalidate();
    memo.coverage();
    expect(coverageCalls).toBe(2);
    expect(isPackEngine(memo)).toBe(true);
    (memo as unknown as { loadPack(n: string, b: Uint8Array): unknown }).loadPack('deep-time', new Uint8Array());
    expect(loads).toEqual(['deep-time']);
    expect(isPackEngine(memoEngine({ ...raw, loadPack: undefined } as unknown as ExplorerEngine))).toBe(false);
  });

  it('the WASM wrapper: packs() is empty for an older core, loadPack says to rebuild, and a load refreshes coverage', () => {
    let coverageCalls = 0;
    const exports = {
      explorer_coverage: () => (coverageCalls++, { start_utc: 'a', end_utc: 'b', groups: [] }),
    } as unknown as ExplorerWasmExports;
    const old = new WasmEngine(exports);
    expect(old.packs()).toEqual([]);
    expect(() => old.loadPack('deep-time', new Uint8Array())).toThrow(/load_pack: this build of the numerical core has no data packs/);

    const withPacks = new WasmEngine({
      ...exports,
      packs: () => [{ name: 'deep-time', loaded: false }],
      load_pack: (name: string, bytes: Uint8Array) => {
        if (bytes.length === 0) throw 'not a SkyFix Lab data pack: the file does not start with SKYFIXPK';
        return { name, version: 'v1', bytes: bytes.length, provides: [] };
      },
    } as unknown as ExplorerWasmExports);
    withPacks.coverage();
    withPacks.coverage();
    expect(coverageCalls).toBe(1);
    expect(() => withPacks.loadPack('deep-time', new Uint8Array())).toThrow('load_pack: not a SkyFix Lab data pack');
    expect(withPacks.loadPack('deep-time', new Uint8Array([1, 2]))).toEqual({ name: 'deep-time', version: 'v1', bytes: 2, provides: [] });
    withPacks.coverage();
    expect(coverageCalls).toBe(2);
  });

  it('the mock lists the planned packs and accepts anything', () => {
    const mock = new MockPacks();
    expect(mock.packs().map((p) => p.name)).toEqual(['deep-time', 'tides-us', 'lunar-limb']);
    expect(mock.packs().every((p) => !p.loaded)).toBe(true);
    expect(mock.loadPack('tides-us', new Uint8Array([9, 9, 9]))).toEqual({ name: 'tides-us', version: 'mock', bytes: 3, provides: ['tides:us'] });
    expect(mock.packs().find((p) => p.name === 'tides-us')).toMatchObject({ loaded: true, bytes: 3 });
    mock.loadPack('anything-else', new Uint8Array());
    expect(mock.packs().map((p) => p.name)).toContain('anything-else');
  });
});
