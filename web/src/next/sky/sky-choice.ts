/**
 * One "how dark is your sky" for the whole explorer (polish2, expansion programme list
 * items 37 and 45): Settings, the Sky view's Layers, Tonight's deep-sky card and the Events
 * view's meteor showers all read and write the stored settings (`skyQuality`, `skyBortle`,
 * `skyNelm`, state.ts), so the Sky view's star limit, tonight's ranking and the meteor rates
 * always assume the same sky. Before, Tonight kept its own Bortle class while the page was
 * open and the Events view its own four classes.
 *
 * The select offers Automatic (a dark site, as the Sky view always drew it), Bortle's nine
 * classes, and, while the Sky view's Layers has set one, the faintest star typed there.
 */

import { h } from '../../dom.js';
import type { ExplorerState, ExplorerStore } from '../state.js';
import { BORTLE_NELM, BORTLE_WORDS, DARK_SKY_NELM, type SkyQualitySettings } from './conditions.js';

/** The select's value for the settings: `auto`, `1`…`9`, or `nelm`. */
export function skyChoiceValue(s: SkyQualitySettings): string {
  if (s.skyQuality === 'bortle') return String(Math.min(9, Math.max(1, Math.round(s.skyBortle))));
  return s.skyQuality === 'nelm' ? 'nelm' : 'auto';
}

/** The sky in words, for a sentence: "a dark site", "a Bortle 5 sky (suburban sky)", "a sky showing stars to magnitude 6.2". */
export function skyChoiceWords(s: SkyQualitySettings): string {
  if (s.skyQuality === 'bortle') {
    const b = Math.min(9, Math.max(1, Math.round(s.skyBortle)));
    return `a Bortle ${b} sky (${BORTLE_WORDS[b - 1]!.toLowerCase()})`;
  }
  if (s.skyQuality === 'nelm') return `a sky showing stars to magnitude ${s.skyNelm.toFixed(1)}`;
  return `a dark site (stars to magnitude ${DARK_SKY_NELM.toFixed(1)})`;
}

/** The settings a choice stands for (a patch of `settings`). */
export function skyChoicePatch(value: string): Partial<SkyQualitySettings> | null {
  if (value === 'auto') return { skyQuality: 'auto' };
  if (value === 'nelm') return { skyQuality: 'nelm' };
  const b = Number(value);
  return Number.isInteger(b) && b >= 1 && b <= 9 ? { skyQuality: 'bortle', skyBortle: b } : null;
}

export interface SkyChoiceSelect {
  el: HTMLSelectElement;
  /** Show the settings of `s` (call it when they change). */
  sync(s: ExplorerState): void;
}

/** The shared select; its changes go straight to the stored settings. */
export function skyChoiceSelect(store: ExplorerStore, options: { class?: string; label?: string } = {}): SkyChoiceSelect {
  const el = h('select', {
    class: options.class ?? 'sf-input',
    'aria-label': options.label ?? 'How dark your sky is',
    title: 'How dark your sky is: the same everywhere on the page (Settings, the Sky view’s Layers, Tonight, meteor showers)',
  });
  let nelmShown = '';
  const build = (s: ExplorerState): void => {
    const q = s.settings;
    const nelm = q.skyQuality === 'nelm' ? q.skyNelm.toFixed(1) : '';
    if (el.options.length && nelm === nelmShown) return;
    nelmShown = nelm;
    el.replaceChildren(
      h('option', { value: 'auto' }, `Automatic · a dark site (to ${DARK_SKY_NELM.toFixed(1)})`),
      ...BORTLE_WORDS.map((words, i) => h('option', { value: String(i + 1) }, `Bortle ${i + 1} · ${words} (to ${BORTLE_NELM[i]!.toFixed(1)})`)),
      ...(nelm ? [h('option', { value: 'nelm' }, `Stars to ${nelm} overhead (from the Sky view)`)] : []),
    );
  };
  const sync = (s: ExplorerState): void => {
    build(s);
    const v = skyChoiceValue(s.settings);
    if (el.value !== v) el.value = v;
  };
  el.addEventListener('change', () => {
    const patch = skyChoicePatch(el.value);
    if (patch) store.patch({ settings: patch });
  });
  sync(store.get());
  return { el, sync };
}
