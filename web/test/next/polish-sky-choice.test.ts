/**
 * One "how dark is your sky" for the explorer (polish2, list items 37 and 45): the values the
 * shared select shows and writes, and the sky the views send the engine for them.
 */
import { describe, expect, it } from 'vitest';
import { skyConditions } from '../../src/next/sky/conditions.js';
import { skyChoicePatch, skyChoiceValue, skyChoiceWords } from '../../src/next/sky/sky-choice.js';
import { createExplorerStore } from '../../src/next/state.js';
import { nightQuery } from '../../src/next/tonight/data.js';

describe('the shared sky choice', () => {
  it('shows the stored setting and writes a choice back to it', () => {
    expect(skyChoiceValue({ skyQuality: 'auto', skyBortle: 5, skyNelm: 6 })).toBe('auto');
    expect(skyChoiceValue({ skyQuality: 'bortle', skyBortle: 7.4, skyNelm: 6 })).toBe('7');
    expect(skyChoiceValue({ skyQuality: 'nelm', skyBortle: 5, skyNelm: 6.2 })).toBe('nelm');
    expect(skyChoicePatch('auto')).toEqual({ skyQuality: 'auto' });
    expect(skyChoicePatch('3')).toEqual({ skyQuality: 'bortle', skyBortle: 3 });
    expect(skyChoicePatch('nelm')).toEqual({ skyQuality: 'nelm' });
    expect(skyChoicePatch('12')).toBeNull();
  });

  it('says the sky in words', () => {
    expect(skyChoiceWords({ skyQuality: 'bortle', skyBortle: 5, skyNelm: 6 })).toBe('a Bortle 5 sky (suburban sky)');
    expect(skyChoiceWords({ skyQuality: 'nelm', skyBortle: 5, skyNelm: 6.24 })).toBe('a sky showing stars to magnitude 6.2');
    expect(skyChoiceWords({ skyQuality: 'auto', skyBortle: 5, skyNelm: 6 })).toMatch(/^a dark site/);
  });

  it('is the sky Tonight ranks for, whatever view set it', () => {
    const store = createExplorerStore({ storage: null });
    store.patch({ settings: skyChoicePatch('8')! });
    const q = nightQuery(store.get(), 2_461_310, skyConditions(store.get().settings));
    expect(q.conditions).toEqual({ bortle: 8 });
    store.patch({ settings: { skyQuality: 'nelm', skyNelm: 6.1 } });
    expect(nightQuery(store.get(), 2_461_310, skyConditions(store.get().settings)).conditions).toEqual({ nelm: 6.1 });
  });
});

// polish2 (list item 24): one air for every refraction the page works out.
describe('the air in Settings', () => {
  it('reaches the engine only when it differs from the almanac’s, and survives a reload', async () => {
    const { engineObserver, sanitizeSettings, DEFAULT_SETTINGS } = await import('../../src/next/state.js');
    const { seedFromExplorer } = await import('../../src/next/navigate/working.js');
    const store = createExplorerStore({ storage: null });
    expect(engineObserver(store.get())).not.toHaveProperty('pressure_hpa');
    store.patch({ settings: { pressure_hpa: 980, temperature_c: -5 } });
    expect(engineObserver(store.get())).toMatchObject({ pressure_hpa: 980, temperature_c: -5 });
    const w = seedFromExplorer(store);
    expect(w.session.observer).toMatchObject({ pressure_hpa: 980, temperature_c: -5 });
    expect(sanitizeSettings({ pressure_hpa: 5000, temperature_c: 'hot' })).toMatchObject({ pressure_hpa: DEFAULT_SETTINGS.pressure_hpa, temperature_c: 10 });
  });
});
